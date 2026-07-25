/**
 * Turn selectors for the Reading window: the transcript-block → turn grouping,
 * the turn render signature, and the status strip's transcript-derived pieces.
 *
 * reading-core layer rules: plain data in, plain data out — no DOM, no
 * Electron, no renderer state. Signature tracking is process-local state, so
 * it is a factory (`createTurnSignatureTracker`): the renderer holds a
 * singleton, each fixture a fresh instance (map §2.4).
 */
import type {
  AgentRunItem,
  TranscriptBlock,
} from "../../shared/types/transcript";
import type { RuntimeRunReport } from "../../shared/schemas";
import { stripImageMarkers } from "../../shared/prompt-markers";
import type { RunTranscript, TaskViewState } from "../state";

export interface ReadingTurn {
  key: string;
  runId: string | null;
  run: RuntimeRunReport | null;
  blocks: TranscriptBlock[];
  fallbackText: string | null;
  tsMs: number;
}

export function transcriptForRun(view: TaskViewState, runId: string): RunTranscript | null {
  return view.runTranscripts.find((item) => item.runId === runId) ?? null;
}

export function stripRunningAgents(view: TaskViewState): AgentRunItem[] {
  const items: AgentRunItem[] = [];
  for (const id of view.transcriptBlockOrder) {
    const block = view.transcriptBlocks.get(id);
    if (block?.kind === "agents") {
      for (const item of block.items) {
        if (item.status === "running") {
          items.push(item);
        }
      }
    }
  }
  return items;
}

export function deriveCurrentStepForView(view: TaskViewState): string | null {
  let planStep: string | null = null;
  let runningTool: string | null = null;
  for (const id of view.transcriptBlockOrder) {
    const block = view.transcriptBlocks.get(id);
    if (!block) {
      continue;
    }
    if (block.kind === "plan") {
      const active = block.items.find((item) => item.status === "in_progress");
      planStep = active ? (active.activeLabel ?? active.text) : planStep;
    } else if (block.kind === "tool-call") {
      runningTool =
        block.status === "running"
          ? block.summary
            ? `${block.toolName} — ${block.summary}`
            : block.toolName
          : runningTool;
    }
  }
  return planStep ?? runningTool;
}

export function buildReadingTurns(view: TaskViewState): ReadingTurn[] {
  const runs = view.report?.runs ?? [];
  const runById = new Map(runs.map((run) => [run.runId, run]));

  const groups = new Map<string, TranscriptBlock[]>();
  for (const id of view.transcriptBlockOrder) {
    const block = view.transcriptBlocks.get(id);
    if (!block) {
      continue;
    }
    const key = `${block.sourceId}:${block.turnKey}`;
    const group = groups.get(key);
    if (group) {
      group.push(block);
    } else {
      groups.set(key, [block]);
    }
  }

  const turns: ReadingTurn[] = [];
  const matchedRunIds = new Set<string>();
  for (const [key, blocks] of groups) {
    const runId = blocks.find((block) => block.runId)?.runId ?? null;
    if (runId) {
      matchedRunIds.add(runId);
    }
    turns.push({
      key,
      runId,
      run: runId ? (runById.get(runId) ?? null) : null,
      blocks,
      fallbackText: null,
      tsMs: Date.parse(blocks[0]?.ts ?? "") || 0,
    });
  }

  for (const run of runs) {
    if (matchedRunIds.has(run.runId)) {
      continue;
    }
    // A task-notification run whose turn attribution failed: its REPLY lives
    // in a continuation turn; the run itself would render as a husk card
    // whose "user" text is the raw XML. The prefix is a safe suppression key
    // (each notification embeds a unique task-id). Other machine runs
    // (wakeups) are deliberately NOT suppressed by text: recurring wakeups
    // share identical text, so a text set would silently hide a FAILED
    // wakeup behind an earlier sibling's note (review 2026-07-03) — an
    // unmatched wakeup run renders as a visible husk instead, and the
    // promptId/tight-text bridges make that the rare failure surface, not
    // the norm.
    if (run.prompt.trimStart().startsWith("<task-notification>")) {
      continue;
    }
    turns.push({
      key: `run:${run.runId}`,
      runId: run.runId,
      run,
      blocks: [],
      fallbackText: transcriptForRun(view, run.runId)?.text.trimEnd() || null,
      tsMs: Date.parse(run.startedAt) || 0,
    });
  }

  return turns.sort((a, b) => a.tsMs - b.tsMs);
}

/**
 * A turn that is purely a context-compaction boundary — its blocks are all
 * `compaction` markers (one, in practice). The Reading surface renders such a
 * turn as a standalone separator, NOT a turn card: a compaction block carries no
 * user voice and no reply, so a turn card would render as an empty husk (the S6
 * phantom-husk failure mode). Grouping keeps it in its own turn (Claude mints a
 * dedicated `compact-<uuid>` key; Codex's `compacted` lands in its own
 * `task_started` boundary turn), so this predicate is exact, not heuristic. A
 * turn that somehow mixed a compaction block with real content is NOT a
 * compaction turn — it falls to the normal card, where the marker degrades to a
 * no-op (it is not an answer block), never hiding the real content.
 */
export function isCompactionTurn(turn: ReadingTurn): boolean {
  return turn.blocks.length > 0 && turn.blocks.every((block) => block.kind === "compaction");
}

export interface UserPromptDisplay {
  /** The bubble text: the CLI's `[Image #N]` markers lifted out when — and only
   *  when — the block carries real image attachments. A user who literally typed
   *  "[Image #1]" with none keeps their words verbatim (review 2026-07-05). */
  text: string;
  /** Image attachments on the prompt; drives the reading bubble's count chip. */
  imageCount: number;
}

/**
 * Derive what a sent prompt shows in the reading bubble. Pure (no DOM): the view
 * builds the chip and the text element from this. Marker stripping here is DISPLAY
 * only and attachment-gated — run↔turn matching reads through markers separately
 * and unconditionally (runtime layer), so the two never inform each other.
 */
export function userPromptDisplay(
  userBlock: Extract<TranscriptBlock, { kind: "user-message" }> | undefined,
  fallbackText: string,
): UserPromptDisplay {
  const text = userBlock?.text ?? fallbackText;
  const imageCount =
    userBlock?.attachments?.filter((attachment) => attachment.kind === "image").length ?? 0;
  return {
    text: imageCount > 0 ? stripImageMarkers(text).replace(/^[ \t]+/, "") : text,
    imageCount,
  };
}

export interface AssistantReplyContent {
  /** Provider-authored Markdown, preserving structure such as lists and fences. */
  markdown: string;
  /** Timestamp of the final visible assistant block: when this reply was formed. */
  completedAt: string;
}

/**
 * The copy/time boundary for ONE whole AI reply. Process and system blocks are
 * deliberately excluded: Reading may show a continuation note beside the
 * reply, but it is not part of the assistant's authored answer. Multiple text
 * blocks are separated by one blank Markdown line, matching their visual
 * block boundary without inventing any additional content.
 */
export function assistantReplyContent(blocks: TranscriptBlock[]): AssistantReplyContent | null {
  const visibleAssistantBlocks = blocks.filter(
    (block): block is Extract<TranscriptBlock, { kind: "assistant-text" }> =>
      block.kind === "assistant-text" && block.markdown.trim().length > 0,
  );
  const lastBlock = visibleAssistantBlocks.at(-1);
  if (!lastBlock) {
    return null;
  }
  return {
    // Preserve every provider-authored byte inside each visible block. Leading
    // four spaces and trailing two spaces are Markdown syntax, not decoration.
    markdown: visibleAssistantBlocks.map((block) => block.markdown).join("\n\n"),
    completedAt: lastBlock.ts,
  };
}

/** Human label for an image-only prompt. When the prompt has no text, this IS
 *  the prompt's accessible/sticky-header text (review 2026-07-05 P2) — a bubble
 *  showing only a count chip would otherwise be non-navigable and headerless. */
export function imageAttachmentLabel(count: number): string {
  return count === 1 ? "1 image attached" : `${count} images attached`;
}

export interface TurnSignatureTracker {
  blockRenderVersion(block: TranscriptBlock): number;
  turnSignature(turn: ReadingTurn): string;
}

/**
 * A cheap content fingerprint for the turn signature: FNV-1a (32-bit) over the
 * string, hex. Pure, dependency-free, NOT cryptographic (no crypto import in
 * reading-core — plain data in, plain data out). Used to fingerprint
 * `fallbackText`, which can be the run transcript's entire cleaned text (up to
 * 120 K chars) — embedding it verbatim made every T3 fire build and compare a
 * 120 KB string AND wrote it into `dataset.sig` on the DOM card (audit F7).
 *
 * The signature pairs this hash WITH the string length, so a change is missed
 * only on a same-length FNV-1a collision (~1 in 2^32 per candidate). A miss
 * costs one skipped repaint of a degraded fallback card, self-healing on the
 * next change — an acceptable trade for a render-refresh trigger (32-bit chosen
 * over 64-bit deliberately: the failure mode is cosmetic and transient).
 */
function fnv1aHex(text: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    // FNV prime 0x01000193, via shift-adds; >>> 0 keeps it an unsigned 32-bit int.
    hash = (hash + ((hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24))) >>> 0;
  }
  return hash.toString(16);
}

export function createTurnSignatureTracker(): TurnSignatureTracker {
  // Block render-version: a transcript block object is REPLACED with a new
  // reference whenever its content is upserted (applyTranscriptUpserts does
  // transcriptBlocks.set(id, newBlock)), while unchanged blocks keep their old
  // reference. So reference identity is an exact, O(1) "did this block change"
  // signal — captured here as a stable version number per object for the turn
  // signature.
  const blockRenderVersions = new WeakMap<TranscriptBlock, number>();
  let blockRenderVersionSeq = 0;
  function blockRenderVersion(block: TranscriptBlock): number {
    let version = blockRenderVersions.get(block);
    if (version === undefined) {
      version = ++blockRenderVersionSeq;
      blockRenderVersions.set(block, version);
    }
    return version;
  }

  // A turn's render signature: equal sig ⇒ renderTurn would produce identical
  // output ⇒ the existing card may be reused untouched (preserving any text
  // selection inside it — the whole point of the slice). Excludes the highlight
  // flag, which is a cheap class toggle applied on reuse, never a reason to
  // rebuild. The streaming turn's sig changes every batch (its blocks' versions
  // grow), so it re-renders; a stable turn's sig is constant, so it is never
  // touched; a turn that just completed flips sig once (status/endedAt), rebuilds
  // once, then is stable.
  function turnSignature(turn: ReadingTurn): string {
    const parts = [
      turn.runId ?? "",
      turn.run?.status ?? "",
      turn.run?.endedAt ?? "",
      // completionSource can trail endedAt (heuristic completion re-grades),
      // and stop events shape the outcome note's wording ("Esc + /stop") — both
      // must flip the signature or the settled card goes stale.
      turn.run?.completionSource ?? "",
      String(turn.run?.stopEvents.length ?? ""),
      // fallbackText fingerprint, NOT the text itself: length + FNV-1a hash. The
      // full text was up to 120 K chars and landed in `dataset.sig` on the DOM
      // (audit F7); the fingerprint changes whenever the text does (modulo a
      // rare same-length hash collision — see fnv1aHex). NOTE: reading
      // `turn.fallbackText` here still forces the lazy clean materialization
      // (bounded by the 120 K cap) — unchanged by this slice, only what the
      // signature EMBEDS changed.
      turn.fallbackText === null ? "" : `${turn.fallbackText.length}:${fnv1aHex(turn.fallbackText)}`,
    ];
    for (const block of turn.blocks) {
      parts.push(`${block.id}:${blockRenderVersion(block)}`);
    }
    return parts.join("|");
  }

  return { blockRenderVersion, turnSignature };
}
