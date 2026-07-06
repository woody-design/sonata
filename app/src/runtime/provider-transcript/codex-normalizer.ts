import type { TaskId } from "../../shared/types/domain";
import type {
  PlanBlock,
  PlanItem,
  ToolCallBlock,
  TranscriptAttachment,
  TranscriptBlock,
  UserMessageBlock,
} from "../../shared/types/transcript";
import type { UsageSnapshot } from "../../shared/types/usage";
import { parseCodexTokenCountPayload } from "../usage";
import {
  boundText,
  INPUT_PREVIEW_LIMIT,
  parseJsonRecord,
  parsePlanItems,
  prettyJson,
  RESULT_PREVIEW_LIMIT,
  toolSummary,
} from "./block-helpers";

/**
 * Normalizes Codex rollout JSONL records into transcript blocks.
 *
 * Codex stores conversational text twice: as `response_item` protocol records
 * and as `event_msg` UI events. Text is read from event_msg only
 * (user_message / agent_message) and tool activity from response_item only
 * (function_call / *_output), so duplication is impossible by construction.
 */
export class CodexRolloutNormalizer {
  private readonly taskId: TaskId;
  private readonly sourceId: string;
  private readonly onUsageSnapshot: ((snapshot: UsageSnapshot) => void) | null;
  private seq = 0;
  private turnSeq = 0;
  private currentTurnKey: string | null = null;
  /** Set by `task_started`, cleared by the `user_message` that adopts its
   *  turn_id. Distinguishes "a real turn was just opened, awaiting its prompt"
   *  from "a prompt with no preceding task_started" (older/edge rollouts). */
  private turnAwaitingUser = false;
  /** True once ANY `task_started` has been seen this session — the signal that
   *  turns are boundary-driven. Legacy rollouts without it keep the older
   *  "each prompt opens a turn" fallback. */
  private sawTaskStarted = false;
  /** The current turn's prompt block WHILE that turn is a synthetic (turn-N)
   *  user-only turn with no reply yet — the reconciliation token for a late
   *  `task_started` (user_message-then-task_started edge ordering). Cleared the
   *  moment any content block lands (ensureTurn) or a new prompt opens. */
  private lastUserBlock: UserMessageBlock | null = null;
  /** Every turn_id already minted into a turnKey — guarantees turnKey stays
   *  unique-per-parse even if a rollback+redo ever reused a task_started id
   *  (never observed in the corpus; the attribution map and run-index exact
   *  match both rest on uniqueness, so this is cheap insurance). */
  private readonly seenTurnIds = new Set<string>();
  private readonly pendingToolCalls = new Map<string, ToolCallBlock>();
  private readonly turnPlans = new Map<string, PlanBlock>();

  constructor(options: {
    taskId: TaskId;
    sourceId: string;
    onUsageSnapshot?: (snapshot: UsageSnapshot) => void;
  }) {
    this.taskId = options.taskId;
    this.sourceId = options.sourceId;
    this.onUsageSnapshot = options.onUsageSnapshot ?? null;
  }

  consumeLine(line: string): TranscriptBlock[] {
    const record = parseJsonRecord(line);
    if (!record) {
      return [];
    }

    const ts = typeof record.timestamp === "string" ? record.timestamp : new Date().toISOString();
    const payload = record.payload as Record<string, unknown> | undefined;
    if (!payload) {
      return [];
    }

    if (record.type === "event_msg") {
      if (payload.type === "token_count") {
        const timestamp = typeof record.timestamp === "string" ? Date.parse(record.timestamp) : NaN;
        const snapshot = parseCodexTokenCountPayload(payload, {
          capturedAt: Number.isNaN(timestamp) ? Date.now() : timestamp,
        });
        if (snapshot) {
          this.onUsageSnapshot?.(snapshot);
        }
        return [];
      }
      return this.consumeEventMsg(payload, ts);
    }
    if (record.type === "response_item") {
      return this.consumeResponseItem(payload, ts);
    }
    if (record.type === "compacted") {
      return [this.systemNote("Context compacted by the provider.", ts)];
    }
    return [];
  }

  private consumeEventMsg(payload: Record<string, unknown>, ts: string): TranscriptBlock[] {
    // `task_started` opens a turn keyed by the rollout's REAL turn identity.
    // It precedes the turn's `user_message` (verified across 0.142.0–0.142.5),
    // so the following prompt adopts this key rather than minting a synthetic
    // one. Two payoffs: (1) non-user-initiated turns — a /review run, a
    // compaction continuation — get their OWN group instead of folding into
    // the previous turn's blocks (176 task_started vs 163 user_message in the
    // July corpus was ~13 mis-merged turns); (2) the turnKey now equals the
    // hook's `UserPromptSubmit.turn_id`, so provider-transcript anchors the Run
    // by identity (a non-`turn-N` key is treated as a promptId) exactly as
    // Claude's `prompt_id` does. A boundary is not content, so no block emits.
    if (payload.type === "task_started" && typeof payload.turn_id === "string") {
      this.sawTaskStarted = true;
      const turnKey = this.uniqueTurnKey(payload.turn_id);
      // Reconcile the user_message-then-task_started edge ordering: if the
      // current turn is a synthetic user-only turn with no reply yet, this
      // task_started belongs to THAT prompt — re-key the prompt block onto the
      // real turn_id (upsert, same id) instead of forking prompt and reply into
      // two turns. Verified corpus ordering is task_started-first, so this only
      // fires on older/edge rollouts, but the split it prevents is a real bug.
      if (
        this.lastUserBlock &&
        this.currentTurnKey !== null &&
        this.lastUserBlock.turnKey === this.currentTurnKey &&
        /^turn-\d+$/.test(this.currentTurnKey)
      ) {
        const reconciled: UserMessageBlock = { ...this.lastUserBlock, turnKey };
        this.lastUserBlock = null;
        this.currentTurnKey = turnKey;
        this.turnAwaitingUser = false;
        return [reconciled];
      }
      this.currentTurnKey = turnKey;
      this.turnAwaitingUser = true;
      return [];
    }

    if (payload.type === "user_message" && typeof payload.message === "string") {
      const text = payload.message.trim();
      const attachments = codexImageAttachments(payload);
      if (!text && attachments.length === 0) {
        return [];
      }
      // Turn key, three ways: (1) adopt the turn_id `task_started` just opened;
      // (2) legacy/first — no task_started ever, or no turn yet — mint a
      // synthetic key so each prompt still opens a turn (a synthetic key can
      // never anchor a Run by id, the honest fallback); (3) a SECOND prompt
      // inside one task_started turn joins that turn rather than forking to an
      // unanchorable synthetic key (forward-proofing; ≤1 prompt/turn today).
      let synthetic = false;
      if (this.turnAwaitingUser && this.currentTurnKey) {
        // adopt — currentTurnKey is already the real turn_id
      } else if (!this.sawTaskStarted || this.currentTurnKey === null) {
        this.currentTurnKey = `turn-${++this.turnSeq}`;
        synthetic = true;
      } // else: join the current task_started turn (keep currentTurnKey)
      this.turnAwaitingUser = false;
      const block: UserMessageBlock = {
        kind: "user-message",
        id: this.nextBlockId("user"),
        taskId: this.taskId,
        sourceId: this.sourceId,
        provider: "codex",
        turnKey: this.currentTurnKey,
        runId: null,
        ts,
        seq: ++this.seq,
        text,
        command: text.startsWith("/") ? text.split(/\s/, 1)[0] ?? null : null,
        attachments,
      };
      // Only a synthetic user-only turn is reconciliation-eligible for a late
      // task_started; a real-keyed prompt is already correctly anchored.
      this.lastUserBlock = synthetic ? block : null;
      return [block];
    }

    if (payload.type === "agent_message" && typeof payload.message === "string") {
      const text = payload.message.trim();
      if (!text) {
        return [];
      }
      return [
        {
          kind: "assistant-text",
          id: this.nextBlockId("text"),
          taskId: this.taskId,
          sourceId: this.sourceId,
          provider: "codex",
          turnKey: this.ensureTurn(),
          runId: null,
          ts,
          seq: ++this.seq,
          markdown: text,
        },
      ];
    }

    // `turn_aborted` (Esc mid-turn): settle the stuck turn. Anchor to the
    // abort's OWN turn_id — an abort-only rollout (aborted before task_started
    // was written) has no other turn signal, and keying the note to that id is
    // what lets it match the run the hook stamped with the same turn_id.
    if (payload.type === "turn_aborted") {
      const turnId = typeof payload.turn_id === "string" ? payload.turn_id : null;
      const abortedTurn = turnId ?? this.currentTurnKey ?? this.ensureTurn();
      if (turnId) {
        // Register it so a later task_started can't re-mint a colliding key.
        this.seenTurnIds.add(turnId);
      }
      this.currentTurnKey = abortedTurn;
      return this.abortTurn(abortedTurn, ts);
    }

    // `thread_rolled_back`: the user undid the last N turns. The blocks already
    // emitted stay in the append-only store (visually un-rendering them needs
    // renderer support — recorded as a follow-up), but the reader must not read
    // them as live truth: a system-note names the rollback.
    if (payload.type === "thread_rolled_back") {
      const num = typeof payload.num_turns === "number" ? payload.num_turns : 0;
      return [this.systemNote(rolledBackNote(num), ts)];
    }

    // `/review`: `entered` is a boundary note; `exited` carries the structured
    // verdict (findings the Reading window previously dropped at `return []`).
    if (payload.type === "entered_review_mode") {
      return [this.systemNote("Code review started.", ts)];
    }
    if (payload.type === "exited_review_mode") {
      return this.consumeReviewOutput(payload, ts);
    }

    // `context_compacted` is the event-mirror of the top-level `compacted`
    // record — they co-fire a few records apart. The record already emits the
    // single compaction note (consumeLine); handling this event too would
    // double it. Intentionally ignored.

    return [];
  }

  /**
   * Settle the aborted turn: a stopped-outcome note plus a terminal state for
   * every tool call OF THAT TURN still awaiting its pairing output (which an
   * abort never delivers). Scoped to `turnKey` so an abort in a later turn can
   * never stamp a spurious error onto a lingering orphan from an earlier one.
   * The pending entries are intentionally NOT deleted: JSONL can carry the real
   * `function_call_output` AFTER the abort record (call → abort → output), and
   * that later result must supersede this synthesized error — out-of-order
   * truth wins.
   */
  private abortTurn(turnKey: string, ts: string): TranscriptBlock[] {
    const blocks: TranscriptBlock[] = [this.systemNote("Turn stopped before it finished.", ts)];
    const endedMs = Date.parse(ts);
    for (const pending of this.pendingToolCalls.values()) {
      if (pending.turnKey !== turnKey) {
        continue;
      }
      const result = boundText("Stopped before the tool returned.", RESULT_PREVIEW_LIMIT);
      const startedMs = Date.parse(pending.ts);
      blocks.push({
        ...pending,
        status: "error",
        resultPreview: result.text,
        resultTruncated: result.truncated,
        durationMs:
          Number.isNaN(startedMs) || Number.isNaN(endedMs) ? null : Math.max(0, endedMs - startedMs),
      });
    }
    return blocks;
  }

  /**
   * Render an `exited_review_mode` verdict as the review turn's reply. The
   * findings are real content the reader must see, so they compose into one
   * assistant-text (markdown) block — never dropped. A verdict with no legible
   * body degrades to a system-note rather than an empty card.
   */
  private consumeReviewOutput(payload: Record<string, unknown>, ts: string): TranscriptBlock[] {
    const output = payload.review_output;
    const markdown =
      output && typeof output === "object"
        ? formatReviewMarkdown(output as Record<string, unknown>)
        : "";
    if (!markdown) {
      return [this.systemNote("Code review finished.", ts)];
    }
    return [
      {
        kind: "assistant-text",
        id: this.nextBlockId("review"),
        taskId: this.taskId,
        sourceId: this.sourceId,
        provider: "codex",
        turnKey: this.ensureTurn(),
        runId: null,
        ts,
        seq: ++this.seq,
        markdown,
      },
    ];
  }

  private consumeResponseItem(payload: Record<string, unknown>, ts: string): TranscriptBlock[] {
    if (payload.type === "function_call" || payload.type === "custom_tool_call") {
      const callId = typeof payload.call_id === "string" ? payload.call_id : this.nextBlockId("call");
      const input = parseToolArguments(payload);
      if (payload.name === "update_plan") {
        const items = parsePlanItems(input);
        if (items) {
          // The agent's own plan state. One upserted block per turn (full
          // state every call); the orphan function_call_output drops
          // naturally (no pendingToolCalls entry). Malformed input falls
          // through to the generic tool-call path below.
          return [this.upsertPlanBlock(items, ts)];
        }
      }
      const inputPreview = boundText(prettyJson(input), INPUT_PREVIEW_LIMIT);
      const toolCall: ToolCallBlock = {
        kind: "tool-call",
        id: `${this.sourceId}:tool:${callId}`,
        taskId: this.taskId,
        sourceId: this.sourceId,
        provider: "codex",
        turnKey: this.ensureTurn(),
        runId: null,
        ts,
        seq: ++this.seq,
        callId,
        toolName: typeof payload.name === "string" ? payload.name : "tool",
        summary: toolSummary(input),
        inputPreview: inputPreview.text,
        inputTruncated: inputPreview.truncated,
        status: "running",
        resultPreview: null,
        resultTruncated: false,
        durationMs: null,
      };
      this.pendingToolCalls.set(callId, toolCall);
      return [toolCall];
    }

    if (payload.type === "function_call_output" || payload.type === "custom_tool_call_output") {
      const callId = typeof payload.call_id === "string" ? payload.call_id : null;
      const pending = callId ? this.pendingToolCalls.get(callId) : undefined;
      if (!callId || !pending) {
        return [];
      }
      this.pendingToolCalls.delete(callId);

      const output = typeof payload.output === "string" ? payload.output : prettyJson(payload.output);
      const result = boundText(output, RESULT_PREVIEW_LIMIT);
      const startedMs = Date.parse(pending.ts);
      const endedMs = Date.parse(ts);
      return [
        {
          ...pending,
          status: codexOutputStatus(output),
          resultPreview: result.text,
          resultTruncated: result.truncated,
          durationMs:
            Number.isNaN(startedMs) || Number.isNaN(endedMs)
              ? null
              : Math.max(0, endedMs - startedMs),
        },
      ];
    }

    if (payload.type === "web_search_call") {
      const action = payload.action as Record<string, unknown> | undefined;
      return [
        {
          kind: "tool-call",
          id: this.nextBlockId("web-search"),
          taskId: this.taskId,
          sourceId: this.sourceId,
          provider: "codex",
          turnKey: this.ensureTurn(),
          runId: null,
          ts,
          seq: ++this.seq,
          callId: this.nextBlockId("web-search-call"),
          toolName: "web_search",
          summary: toolSummary(action ?? payload),
          inputPreview: boundText(prettyJson(action ?? {}), INPUT_PREVIEW_LIMIT).text,
          inputTruncated: false,
          status: "ok",
          resultPreview: null,
          resultTruncated: false,
          durationMs: null,
        },
      ];
    }

    if (payload.type === "reasoning") {
      const summary = reasoningSummaryText(payload.summary);
      if (!summary) {
        return [];
      }
      return [
        {
          kind: "thinking",
          id: this.nextBlockId("thinking"),
          taskId: this.taskId,
          sourceId: this.sourceId,
          provider: "codex",
          turnKey: this.ensureTurn(),
          runId: null,
          ts,
          seq: ++this.seq,
          text: summary,
        },
      ];
    }

    return [];
  }

  private systemNote(text: string, ts: string): TranscriptBlock {
    return {
      kind: "system-note",
      id: this.nextBlockId("system"),
      taskId: this.taskId,
      sourceId: this.sourceId,
      provider: "codex",
      turnKey: this.ensureTurn(),
      runId: null,
      ts,
      seq: ++this.seq,
      text,
    };
  }

  private upsertPlanBlock(items: PlanItem[], ts: string): PlanBlock {
    const turnKey = this.ensureTurn();
    const existing = this.turnPlans.get(turnKey);
    const updated: PlanBlock = existing
      ? { ...existing, items, ts }
      : {
          kind: "plan",
          id: `${this.sourceId}:plan:${turnKey}`,
          taskId: this.taskId,
          sourceId: this.sourceId,
          provider: "codex",
          turnKey,
          runId: null,
          ts,
          seq: ++this.seq,
          items,
        };
    this.turnPlans.set(turnKey, updated);
    return updated;
  }

  private ensureTurn(): string {
    if (this.currentTurnKey === null) {
      this.currentTurnKey = `turn-${++this.turnSeq}`;
    }
    // Any content block placed in the turn closes the reconciliation window:
    // the prompt now has a reply, so a later task_started must open a NEW turn
    // rather than re-key this one.
    this.lastUserBlock = null;
    return this.currentTurnKey;
  }

  /**
   * A turnKey for a `task_started` turn_id, guaranteed unique-per-parse. Returns
   * the id itself on first sight (so it equals the hook's `turn_id` and anchors
   * the Run by identity); a repeat — never seen in the corpus, but a
   * rollback+redo could in principle reuse an id — is suffixed so it can't
   * clobber the earlier turn's attribution.
   */
  private uniqueTurnKey(turnId: string): string {
    if (!this.seenTurnIds.has(turnId)) {
      this.seenTurnIds.add(turnId);
      return turnId;
    }
    let n = 2;
    while (this.seenTurnIds.has(`${turnId}#${n}`)) {
      n += 1;
    }
    const key = `${turnId}#${n}`;
    this.seenTurnIds.add(key);
    return key;
  }

  private nextBlockId(suffix: string): string {
    return `${this.sourceId}:${suffix}-${this.seq + 1}`;
  }
}

function balanceFences(text: string): string {
  const fences = (text.match(/```/g) ?? []).length;
  return fences % 2 === 1 ? `${text}\n\`\`\`` : text;
}

function rolledBackNote(numTurns: number): string {
  if (numTurns <= 0) {
    return "Conversation rolled back — earlier turns were undone.";
  }
  const noun = numTurns === 1 ? "turn was" : "turns were";
  return `Conversation rolled back — the last ${numTurns} ${noun} undone.`;
}

/**
 * Compose a codex `/review` verdict into readable markdown. Shape (0.142.5):
 * `{ overall_correctness, overall_explanation, findings: [{ title, body,
 * priority, confidence_score, code_location: { absolute_file_path, line_range }
 * }] }`. Every field is optional-by-defense — a partial verdict still renders
 * whatever it carries rather than dropping the whole block.
 */
function formatReviewMarkdown(output: Record<string, unknown>): string {
  const parts: string[] = [];
  const correctness = typeof output.overall_correctness === "string" ? output.overall_correctness.trim() : "";
  if (correctness) {
    parts.push(`**Review verdict: ${correctness}**`);
  }
  const explanation = typeof output.overall_explanation === "string" ? output.overall_explanation.trim() : "";
  if (explanation) {
    parts.push(balanceFences(explanation));
  }

  const findings = Array.isArray(output.findings) ? output.findings : [];
  for (const value of findings) {
    if (!value || typeof value !== "object") {
      continue;
    }
    const finding = value as Record<string, unknown>;
    const title = typeof finding.title === "string" ? finding.title.trim() : "";
    parts.push(`### ${title || "Finding"}`);
    const location = reviewLocation(finding.code_location);
    if (location) {
      parts.push(`\`${location}\``);
    }
    const body = typeof finding.body === "string" ? finding.body.trim() : "";
    if (body) {
      // Contain an unbalanced ``` fence so a single finding can't swallow every
      // finding after it into one code block.
      parts.push(balanceFences(body));
    }
    const meta: string[] = [];
    if (typeof finding.priority === "number") {
      meta.push(`priority ${finding.priority}`);
    }
    if (typeof finding.confidence_score === "number") {
      meta.push(`confidence ${finding.confidence_score}`);
    }
    if (meta.length > 0) {
      parts.push(`_${meta.join(" · ")}_`);
    }
  }

  return parts.join("\n\n").trim();
}

function reviewLocation(value: unknown): string {
  if (!value || typeof value !== "object") {
    return "";
  }
  const location = value as Record<string, unknown>;
  const file = typeof location.absolute_file_path === "string" ? location.absolute_file_path.trim() : "";
  if (!file) {
    return "";
  }
  const range = location.line_range;
  if (range && typeof range === "object") {
    const r = range as Record<string, unknown>;
    const start = typeof r.start === "number" ? r.start : null;
    const end = typeof r.end === "number" ? r.end : null;
    if (start !== null && end !== null) {
      return `${file}:${start}-${end}`;
    }
    if (start !== null) {
      return `${file}:${start}`;
    }
  }
  return file;
}

function codexImageAttachments(payload: Record<string, unknown>): TranscriptAttachment[] {
  const images = payload.local_images;
  if (!Array.isArray(images)) {
    return [];
  }
  return images
    .filter((image): image is string => typeof image === "string" && image.trim().length > 0)
    .map((image) => ({
      kind: "image" as const,
      source: "local-path" as const,
      path: image,
      mediaType: null,
    }));
}

function parseToolArguments(payload: Record<string, unknown>): unknown {
  const args = payload.arguments ?? payload.input;
  if (typeof args !== "string") {
    return args ?? {};
  }
  try {
    return JSON.parse(args) as unknown;
  } catch {
    return args;
  }
}

function codexOutputStatus(output: string): "ok" | "error" {
  const match = output.match(/exited with code (\d+)/i);
  if (match) {
    return match[1] === "0" ? "ok" : "error";
  }
  return "ok";
}

function reasoningSummaryText(summary: unknown): string {
  if (!Array.isArray(summary)) {
    return "";
  }
  return summary
    .map((item) => {
      if (typeof item === "string") {
        return item;
      }
      const record = item as Record<string, unknown>;
      return typeof record.text === "string" ? record.text : "";
    })
    .filter(Boolean)
    .join("\n\n")
    .trim();
}
