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

export interface TurnSignatureTracker {
  blockRenderVersion(block: TranscriptBlock): number;
  turnSignature(turn: ReadingTurn): string;
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
      turn.fallbackText ?? "",
    ];
    for (const block of turn.blocks) {
      parts.push(`${block.id}:${blockRenderVersion(block)}`);
    }
    return parts.join("|");
  }

  return { blockRenderVersion, turnSignature };
}
