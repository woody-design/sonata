import type { TaskId } from "../../shared/types/domain";
import type {
  AgentRosterBlock,
  AgentRunItem,
  PlanBlock,
  PlanItem,
  ToolCallBlock,
  TranscriptAttachment,
  TranscriptBlock,
} from "../../shared/types/transcript";
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
 * Normalizes Claude Code session JSONL records into transcript blocks.
 *
 * Turn rules:
 * - Meta user records are context injection and are skipped.
 * - `promptSource: "system"` records are machinery injected into the user role
 *   (task notifications from background/research workflows, etc.) — never the
 *   user's words, so they never render as a prompt. (`sdk` is deliberately NOT
 *   excluded — see consumeUserRecord.)
 * - A typed prompt or command invocation always starts a new turn.
 * - Legacy user records without promptSource keep the older fallback heuristic:
 *   real text starts a turn once the previous turn has assistant content.
 * - Records that only carry tool_result blocks are plumbing: they resolve
 *   pending tool calls and never affect turn state.
 * - Sidechain (subagent) records are skipped entirely.
 */
export class ClaudeSessionNormalizer {
  private readonly taskId: TaskId;
  private readonly sourceId: string;
  private seq = 0;
  private turnSeq = 0;
  private currentTurnKey: string | null = null;
  private turnHasAssistant = false;
  private readonly pendingToolCalls = new Map<string, ToolCallBlock>();
  private readonly turnPlans = new Map<string, PlanBlock>();
  /** Session-level task state for the 2.1.17x TaskCreate/TaskUpdate tools. */
  private readonly sessionTasks = new Map<string, PlanItem>();
  private readonly pendingPlanCalls = new Map<string, PendingPlanCall>();
  /** Background agents the session spawned, keyed by the `Agent` tool_use id.
   *  Insertion order == spawn order == roster row order. */
  private readonly agents = new Map<string, AgentRunItem>();
  /** Turn each agent belongs to, so completions upsert the right roster. */
  private readonly agentTurnKey = new Map<string, string>();
  /** Internal agentId (== notification task-id) -> spawning tool_use id. Filled
   *  from the spawn's tool_result, which carries `agentId: <id>`. */
  private readonly agentIdByTask = new Map<string, string>();
  /** Spawns awaiting their tool_result, to capture that internal agentId. */
  private readonly pendingAgentSpawns = new Map<string, true>();
  /** One agent-roster block per turn, upserted in place (mirrors turnPlans). */
  private readonly turnAgentRosters = new Map<string, AgentRosterBlock>();

  constructor(options: { taskId: TaskId; sourceId: string }) {
    this.taskId = options.taskId;
    this.sourceId = options.sourceId;
  }

  consumeLine(line: string): TranscriptBlock[] {
    const record = parseJsonRecord(line);
    if (!record || record.isSidechain === true) {
      return [];
    }

    const type = record.type;
    if (type === "user") {
      return this.consumeUserRecord(record);
    }
    if (type === "assistant") {
      return this.consumeAssistantRecord(record);
    }
    // A background agent that finishes while the main loop is BUSY delivers
    // its <task-notification> through the CLI's own message queue — recorded
    // as a queue-operation (enqueue) plus an attachment{queued_command},
    // NEVER as the promptSource:"system" user record the idle path writes.
    // Without consuming these, the roster row stays "running" forever and
    // survives restarts (transcript-derived) — Woody's 630-minute ghosts,
    // 2026-07-03. Settling is idempotent, so seeing the same notification in
    // both shapes is harmless. No continuation turn here: a QUEUED
    // notification is absorbed into the live turn (mid-turn steering, S6
    // probe) — there is no new API turn to open.
    if (type === "queue-operation") {
      const content = typeof record.content === "string" ? record.content : "";
      const settled = this.settleAgentFromNotification(content, recordTimestamp(record));
      return settled ? [settled] : [];
    }
    if (type === "attachment") {
      const attachment = record.attachment as Record<string, unknown> | undefined;
      const prompt = typeof attachment?.prompt === "string" ? attachment.prompt : "";
      const settled = this.settleAgentFromNotification(prompt, recordTimestamp(record));
      return settled ? [settled] : [];
    }
    return [];
  }

  private consumeUserRecord(record: Record<string, unknown>): TranscriptBlock[] {
    if (record.isMeta === true) {
      return [];
    }

    const message = record.message as Record<string, unknown> | undefined;
    const content = message?.content;
    const ts = recordTimestamp(record);
    const upserts: TranscriptBlock[] = [];

    const textParts: string[] = [];
    const attachments: TranscriptAttachment[] = [];
    if (typeof content === "string") {
      textParts.push(content);
    } else if (Array.isArray(content)) {
      for (const blockValue of content) {
        const block = blockValue as Record<string, unknown>;
        if (block.type === "tool_result") {
          const updated = this.resolveToolResult(block, ts);
          if (updated) {
            upserts.push(updated);
          }
        } else if (block.type === "text" && typeof block.text === "string") {
          textParts.push(block.text);
        } else if (block.type === "image") {
          const source = block.source as Record<string, unknown> | undefined;
          attachments.push({
            kind: "image" as const,
            source: "provider-content" as const,
            path: null,
            mediaType: typeof source?.media_type === "string" ? source.media_type : null,
          });
        }
      }
    }

    const userText = cleanUserText(textParts.join("\n"));
    if (!userText && attachments.length === 0) {
      return upserts;
    }

    const promptSource = typeof record.promptSource === "string" ? record.promptSource : null;

    // `promptSource` is the medium's own provenance signal. A `system` source is
    // machinery the CLI injects into the user role — task notifications from
    // background/research workflows ("<task-notification> … came to rest"), and
    // the like — never the user's words. It must never render as a prompt bubble;
    // any tool_results it carried are already resolved into `upserts` above.
    //
    // Deliberately NOT extended to `sdk`: in a Claude-Agent-SDK session every
    // user message is tagged `sdk` (including the prompts driving this very Duet
    // workshop), so excluding it would erase the user's own words from the
    // reading surface — a worse failure than showing a stray notification. `sdk`
    // and legacy un-tagged records keep the heuristic below.
    if (promptSource === "system") {
      // It is still the agent-completion signal, though: a `<task-notification>`
      // settles a running roster row even as it produces no user bubble.
      const rawText = textParts.join("\n");
      const settled = this.settleAgentFromNotification(rawText, ts);
      if (settled) {
        upserts.push(settled);
      }
      // A system record injected into the user role IS a turn boundary at the
      // API level — the CLI begins a fresh assistant turn from it. Without
      // opening a turn here, every reply that follows (including a background
      // workflow's FINAL integrated answer) kept attributing to the original
      // request's turn: the reading surface piled successive replies into one
      // card while the notification runs rendered as raw-XML husks (Woody's
      // Loop-Engineering session, 2026-07-02). The continuation turn has NO
      // user-message block — the renderer shows no "You" bubble — only a
      // muted note naming what came back, then the reply.
      const promptId = typeof record.promptId === "string" ? record.promptId : null;
      this.currentTurnKey = promptId ?? `turn-${++this.turnSeq}`;
      this.turnHasAssistant = false;
      if (rawText.includes("<task-notification>")) {
        const summary = rawText.match(/<summary>([^<]+)<\/summary>/)?.[1]?.trim();
        upserts.push({
          kind: "system-note",
          id: this.blockId(record, "continuation"),
          taskId: this.taskId,
          sourceId: this.sourceId,
          provider: "claude",
          turnKey: this.currentTurnKey,
          runId: null,
          ts,
          seq: ++this.seq,
          text: summary ?? "Background task returned",
        });
      }
      return upserts;
    }

    const command = parseCommandInvocation(userText);
    const startsTurn =
      promptSource === "typed" ||
      promptSource === "queued" ||
      command !== null ||
      this.currentTurnKey === null ||
      this.turnHasAssistant;
    if (!startsTurn) {
      // Context injection (skill body, command expansion) inside a fresh turn.
      return upserts;
    }

    const promptId = typeof record.promptId === "string" ? record.promptId : null;
    this.currentTurnKey = promptId ?? `turn-${++this.turnSeq}`;
    this.turnHasAssistant = false;

    upserts.push({
      kind: "user-message",
      id: this.blockId(record, "user"),
      taskId: this.taskId,
      sourceId: this.sourceId,
      provider: "claude",
      turnKey: this.currentTurnKey,
      runId: null,
      ts,
      seq: ++this.seq,
      text: command ? command.display : userText,
      command: command ? command.name : null,
      attachments,
    });
    return upserts;
  }

  private consumeAssistantRecord(record: Record<string, unknown>): TranscriptBlock[] {
    const message = record.message as Record<string, unknown> | undefined;
    const content = message?.content;
    if (!Array.isArray(content)) {
      return [];
    }

    const ts = recordTimestamp(record);
    this.ensureTurn(record);
    const upserts: TranscriptBlock[] = [];

    for (const [index, blockValue] of content.entries()) {
      const block = blockValue as Record<string, unknown>;
      if (block.type === "text" && typeof block.text === "string" && block.text.trim()) {
        this.turnHasAssistant = true;
        upserts.push({
          kind: "assistant-text",
          id: this.blockId(record, `text-${index}`),
          taskId: this.taskId,
          sourceId: this.sourceId,
          provider: "claude",
          turnKey: this.currentTurnKey ?? this.openImplicitTurn(),
          runId: null,
          ts,
          seq: ++this.seq,
          markdown: block.text,
        });
      } else if (block.type === "thinking" && typeof block.thinking === "string" && block.thinking.trim()) {
        this.turnHasAssistant = true;
        upserts.push({
          kind: "thinking",
          id: this.blockId(record, `thinking-${index}`),
          taskId: this.taskId,
          sourceId: this.sourceId,
          provider: "claude",
          turnKey: this.currentTurnKey ?? this.openImplicitTurn(),
          runId: null,
          ts,
          seq: ++this.seq,
          text: block.thinking,
        });
      } else if (block.type === "tool_use" && typeof block.id === "string") {
        this.turnHasAssistant = true;
        if (block.name === "TodoWrite") {
          // Legacy full-state plan tool (pre-2.1.17x sessions). One upserted
          // block per turn; the orphan tool_result drops naturally in
          // resolveToolResult. Malformed input falls through to the generic
          // tool-call path below.
          const items = parsePlanItems(block.input);
          if (items) {
            upserts.push(this.upsertPlanBlock(items, ts));
            continue;
          }
        }
        const toolCall = this.buildToolCall(block, ts);
        if (block.name === "TaskCreate") {
          // Current plan tool: the task id exists only in the RESULT text,
          // so the create is buffered and applied in resolveToolResult. The
          // pre-built generic block is the evidence fallback if the result
          // cannot be parsed.
          const input = block.input as Record<string, unknown> | undefined;
          const subject =
            typeof input?.subject === "string" && input.subject.trim() ? input.subject : null;
          if (subject) {
            this.pendingPlanCalls.set(block.id, {
              kind: "create",
              toolCall,
              text: subject,
              activeLabel:
                typeof input?.activeForm === "string" && input.activeForm.trim()
                  ? input.activeForm
                  : null,
            });
            continue;
          }
        }
        if (block.name === "TaskUpdate") {
          // Self-contained delta: applies on use; the result is swallowed.
          // Unknown task ids stay visible as generic tool calls.
          const planUpdate = this.applyTaskUpdate(block.input, ts);
          if (planUpdate) {
            this.pendingPlanCalls.set(block.id, { kind: "update" });
            upserts.push(planUpdate);
            continue;
          }
        }
        if (block.name === "Agent" || block.name === "Workflow") {
          // Background fan-out: consolidate into one roster row per spawn
          // instead of a generic tool card. `Agent` is a single sub-agent;
          // `Workflow` is a whole background fleet (the deep-research skill's
          // path) shown coarsely as one row. Both bridge through their launch
          // result and settle on the matching task-notification.
          const roster = this.spawnAgent(block, ts);
          if (roster) {
            upserts.push(roster);
            continue;
          }
        }
        this.pendingToolCalls.set(block.id, toolCall);
        upserts.push(toolCall);
      }
    }
    return upserts;
  }

  private buildToolCall(block: Record<string, unknown>, ts: string): ToolCallBlock {
    const input = block.input;
    const inputPreview = boundText(prettyJson(input), INPUT_PREVIEW_LIMIT);
    return {
      kind: "tool-call",
      id: `${this.sourceId}:tool:${block.id as string}`,
      taskId: this.taskId,
      sourceId: this.sourceId,
      provider: "claude",
      turnKey: this.currentTurnKey ?? this.openImplicitTurn(),
      runId: null,
      ts,
      seq: ++this.seq,
      callId: block.id as string,
      toolName: typeof block.name === "string" ? block.name : "tool",
      summary: toolSummary(input),
      inputPreview: inputPreview.text,
      inputTruncated: inputPreview.truncated,
      status: "running",
      resultPreview: null,
      resultTruncated: false,
      durationMs: null,
    };
  }

  private applyTaskUpdate(input: unknown, ts: string): PlanBlock | null {
    const record = (input ?? {}) as Record<string, unknown>;
    const taskId =
      typeof record.taskId === "string"
        ? record.taskId
        : typeof record.taskId === "number"
          ? String(record.taskId)
          : null;
    if (!taskId || !this.sessionTasks.has(taskId)) {
      return null;
    }
    const item = this.sessionTasks.get(taskId) as PlanItem;
    const status = record.status;
    if (status === "deleted") {
      this.sessionTasks.delete(taskId);
    } else {
      if (status === "pending" || status === "in_progress" || status === "completed") {
        item.status = status;
      }
      if (typeof record.subject === "string" && record.subject.trim()) {
        item.text = record.subject;
      }
      if (typeof record.activeForm === "string" && record.activeForm.trim()) {
        item.activeLabel = record.activeForm;
      }
    }
    return this.upsertPlanBlock(this.sessionTaskItems(), ts);
  }

  private sessionTaskItems(): PlanItem[] {
    return [...this.sessionTasks.values()].map((item) => ({ ...item }));
  }

  private upsertPlanBlock(items: PlanItem[], ts: string): PlanBlock {
    const turnKey = this.currentTurnKey ?? this.openImplicitTurn();
    const existing = this.turnPlans.get(turnKey);
    const updated: PlanBlock = existing
      ? { ...existing, items, ts }
      : {
          kind: "plan",
          id: `${this.sourceId}:plan:${turnKey}`,
          taskId: this.taskId,
          sourceId: this.sourceId,
          provider: "claude",
          turnKey,
          runId: null,
          ts,
          seq: ++this.seq,
          items,
        };
    this.turnPlans.set(turnKey, updated);
    return updated;
  }

  private spawnAgent(block: Record<string, unknown>, ts: string): AgentRosterBlock | null {
    const toolUseId = block.id;
    if (typeof toolUseId !== "string") {
      return null;
    }
    const input = block.input as Record<string, unknown> | undefined;
    let name: string;
    let agentType: string;
    if (block.name === "Workflow") {
      // A `Workflow` launch — name is the workflow id ("deep-research"). Its
      // own fan-out lives in the workflow transcript dir, not the main stream,
      // so it shows as one coarse "still working" row, not its inner agents.
      name = typeof input?.name === "string" && input.name.trim() ? input.name : "workflow";
      agentType = "workflow";
    } else {
      name =
        typeof input?.description === "string" && input.description.trim()
          ? input.description
          : "Agent";
      agentType =
        typeof input?.subagent_type === "string" && input.subagent_type.trim()
          ? input.subagent_type
          : "agent";
    }
    this.agents.set(toolUseId, {
      toolUseId,
      name,
      detail: null,
      agentType,
      status: "running",
      startedAt: ts,
      durationMs: null,
    });
    const turnKey = this.currentTurnKey ?? this.openImplicitTurn();
    this.agentTurnKey.set(toolUseId, turnKey);
    this.pendingAgentSpawns.set(toolUseId, true);
    return this.upsertAgentRoster(turnKey, ts);
  }

  private settleAgentFromNotification(text: string, ts: string): AgentRosterBlock | null {
    if (!text.includes("<task-notification>")) {
      return null;
    }
    const taskId = text.match(/<task-id>([^<]+)<\/task-id>/)?.[1]?.trim();
    if (!taskId) {
      return null;
    }
    const toolUseId = this.agentIdByTask.get(taskId);
    const item = toolUseId ? this.agents.get(toolUseId) : undefined;
    const turnKey = toolUseId ? this.agentTurnKey.get(toolUseId) : undefined;
    if (!item || !turnKey) {
      // Not one of our top-level spawns (e.g. a nested child agent, or a
      // notification that arrived before its launch result was parsed).
      return null;
    }
    // The CLI may notify the same agent more than once. Settle to done, but
    // never let a later notification clobber a good CLI duration with an
    // estimate: trust an explicit <duration_ms>, otherwise compute one only
    // while we still have none. Skip the re-upsert when nothing changed, so a
    // duplicate notification doesn't needlessly restart co-running animations.
    let changed = item.status !== "done";
    item.status = "done";
    const durationMatch = text.match(/<duration_ms>(\d+)<\/duration_ms>/);
    if (durationMatch) {
      const reported = Number(durationMatch[1]);
      if (reported !== item.durationMs) {
        item.durationMs = reported;
        changed = true;
      }
    } else if (item.durationMs === null) {
      const started = Date.parse(item.startedAt);
      const ended = Date.parse(ts);
      const computed =
        Number.isNaN(started) || Number.isNaN(ended) ? null : Math.max(0, ended - started);
      if (computed !== null) {
        item.durationMs = computed;
        changed = true;
      }
    }
    if (!changed) {
      return null;
    }
    return this.upsertAgentRoster(turnKey, ts);
  }

  private agentItemsForTurn(turnKey: string): AgentRunItem[] {
    const items: AgentRunItem[] = [];
    for (const [toolUseId, item] of this.agents) {
      if (this.agentTurnKey.get(toolUseId) === turnKey) {
        items.push({ ...item });
      }
    }
    return items;
  }

  private upsertAgentRoster(turnKey: string, ts: string): AgentRosterBlock {
    const items = this.agentItemsForTurn(turnKey);
    const existing = this.turnAgentRosters.get(turnKey);
    const updated: AgentRosterBlock = existing
      ? { ...existing, items, ts }
      : {
          kind: "agents",
          id: `${this.sourceId}:agents:${turnKey}`,
          taskId: this.taskId,
          sourceId: this.sourceId,
          provider: "claude",
          turnKey,
          runId: null,
          ts,
          seq: ++this.seq,
          items,
        };
    this.turnAgentRosters.set(turnKey, updated);
    return updated;
  }

  private resolveToolResult(block: Record<string, unknown>, ts: string): TranscriptBlock | null {
    const callId = block.tool_use_id;
    if (typeof callId !== "string") {
      return null;
    }
    if (this.pendingAgentSpawns.has(callId)) {
      // The launch result. Bridge the internal id the later task-notification
      // will report (Agent → "agentId: …"; Workflow → "Task ID: …") to this
      // spawn's tool_use id. The roster already shows the row; the launch text
      // itself is plumbing.
      this.pendingAgentSpawns.delete(callId);
      const text = toolResultText(block.content);
      // Match the same charset the notification's <task-id> can hold ([^<]+) —
      // stop only at whitespace or the trailing "(" of "agentId: x (internal…)".
      // A stricter [A-Za-z0-9]+ here would silently fail to bridge any id with
      // a '-'/'_' (some workflow ids have them), leaving the row stuck running.
      const taskId = text.match(/(?:agentId|Task ID):\s*([^\s)]+)/)?.[1];
      if (taskId) {
        this.agentIdByTask.set(taskId, callId);
      }
      // A Workflow launch result carries a one-line `Summary:` describing the
      // fleet — fold it onto the row so it reads like the CLI ("deep-research —
      // Deep research harness …"), then re-upsert so the detail appears.
      const item = this.agents.get(callId);
      const summary = text.match(/Summary:\s*(.+)/)?.[1]?.trim();
      if (item && summary && !item.detail) {
        item.detail = summary;
        const turnKey = this.agentTurnKey.get(callId);
        if (turnKey) {
          return this.upsertAgentRoster(turnKey, ts);
        }
      }
      return null;
    }
    const pendingPlan = this.pendingPlanCalls.get(callId);
    if (pendingPlan) {
      this.pendingPlanCalls.delete(callId);
      if (pendingPlan.kind === "update") {
        return null;
      }
      const created = toolResultText(block.content).match(/Task #(\d+) created/i);
      if (created && block.is_error !== true) {
        this.sessionTasks.set(created[1] as string, {
          text: pendingPlan.text,
          activeLabel: pendingPlan.activeLabel,
          status: "pending",
        });
        return this.upsertPlanBlock(this.sessionTaskItems(), ts);
      }
      // Unparseable create result: surface the buffered generic tool call
      // resolved with this result — never lose evidence to a parser.
      this.pendingToolCalls.set(callId, pendingPlan.toolCall);
    }
    const pending = this.pendingToolCalls.get(callId);
    if (!pending) {
      return null;
    }
    this.pendingToolCalls.delete(callId);

    const result = boundText(toolResultText(block.content), RESULT_PREVIEW_LIMIT);
    const startedMs = Date.parse(pending.ts);
    const endedMs = Date.parse(ts);
    const updated: ToolCallBlock = {
      ...pending,
      status: block.is_error === true ? "error" : "ok",
      resultPreview: result.text,
      resultTruncated: result.truncated,
      durationMs:
        Number.isNaN(startedMs) || Number.isNaN(endedMs) ? null : Math.max(0, endedMs - startedMs),
    };
    return updated;
  }

  private ensureTurn(record: Record<string, unknown>): void {
    if (this.currentTurnKey !== null) {
      return;
    }
    const promptId = typeof record.promptId === "string" ? record.promptId : null;
    this.currentTurnKey = promptId ?? `turn-${++this.turnSeq}`;
  }

  private openImplicitTurn(): string {
    this.currentTurnKey = `turn-${++this.turnSeq}`;
    return this.currentTurnKey;
  }

  private blockId(record: Record<string, unknown>, suffix: string): string {
    const uuid = typeof record.uuid === "string" ? record.uuid : `seq-${this.seq + 1}`;
    return `${this.sourceId}:${uuid}:${suffix}`;
  }
}

type PendingPlanCall =
  | { kind: "create"; toolCall: ToolCallBlock; text: string; activeLabel: string | null }
  | { kind: "update" };

function recordTimestamp(record: Record<string, unknown>): string {
  return typeof record.timestamp === "string" ? record.timestamp : new Date().toISOString();
}

function toolResultText(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }
  if (Array.isArray(content)) {
    return content
      .map((item) => {
        const block = item as Record<string, unknown>;
        return block.type === "text" && typeof block.text === "string" ? block.text : "";
      })
      .filter(Boolean)
      .join("\n");
  }
  return "";
}

function cleanUserText(text: string): string {
  const withoutReminders = text
    .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, "")
    .replace(/<local-command-stdout>[\s\S]*?<\/local-command-stdout>/g, "");
  return withoutReminders.trim();
}

function parseCommandInvocation(text: string): { name: string; display: string } | null {
  const nameMatch = text.match(/<command-name>([\s\S]*?)<\/command-name>/);
  if (!nameMatch) {
    return null;
  }
  const name = nameMatch[1]?.trim() ?? "";
  const argsMatch = text.match(/<command-args>([\s\S]*?)<\/command-args>/);
  const args = argsMatch?.[1]?.trim() ?? "";
  const display = args ? `${name} ${args}` : name;
  return { name, display };
}
