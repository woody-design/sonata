import type { RunId, RuntimeProvider, TaskId } from "../../shared/types/domain";
import type { RuntimeEvent } from "../../shared/types/events";
import type { TranscriptBlock, TranscriptSourceRef } from "../../shared/types/transcript";
import type { UsageSnapshot } from "../../shared/types/usage";
import { ClaudeSessionNormalizer } from "./claude-normalizer";
import { CodexRolloutNormalizer } from "./codex-normalizer";
import { JsonlTailer } from "./jsonl-tailer";
import { locateSessionFile } from "./session-locator";

const DISCOVERY_INTERVAL_MS = 1_500;
const DISCOVERY_TIMEOUT_MS = 120_000;
const EMIT_CHUNK_SIZE = 250;
// Text-match window for MACHINE anchors (system-notes): a wakeup's record
// and its hook-begun run are stamped within a couple of seconds of each
// other, while sibling wakeups repeat the identical text minutes apart —
// 30s pairs the true twin and excludes every sibling.
const SYSTEM_ANCHOR_TEXT_WINDOW_MS = 30_000;

export interface ResolveRunIdInput {
  text: string;
  command: string | null;
  tsMs: number;
  assigned: ReadonlySet<RunId>;
  /** The turn's promptId (the CLI's prompt_id) when the turnKey carries one —
   *  matched EXACTLY against `run.promptId` before any text/time heuristics. */
  promptId: string | null;
  /** Cap for the text-match fallback's |run.startedAt − turn.ts| distance.
   *  Machine anchors (system-notes) pass a TIGHT window: recurring /loop
   *  wakeups are byte-identical, so only near-simultaneity can pair them —
   *  a wide window would cross-match siblings (review 2026-07-03). Default:
   *  the legacy 15 minutes for human prompts. */
  textWindowMs?: number;
}

export interface ProviderTranscriptOptions {
  taskId: TaskId;
  provider: RuntimeProvider;
  providerCwd: string;
  eventSink: (event: RuntimeEvent) => void;
  resolveRunId: (input: ResolveRunIdInput) => RunId | null;
  externallyClaimedPaths?: () => ReadonlySet<string>;
  /** The session id this Task owns — discovery matches it by identity. */
  expectedSessionId?: string | null;
  /** Resume passes false so discovery can never rebind to a sibling session. */
  allowMtimeFallback?: boolean;
  locate?: typeof locateSessionFile;
  pollMs?: number;
}

interface AttachedSource {
  ref: TranscriptSourceRef;
  normalizer: ClaudeSessionNormalizer | CodexRolloutNormalizer;
  tailer: JsonlTailer;
  emittedOnce: boolean;
}

/**
 * Owns the semantic transcript channel of one Task: discovers the provider
 * session file behind the live PTY, tails it, normalizes records into
 * transcript blocks, attributes turns to Duet Runs, and emits runtime events.
 */
export class ProviderTranscript {
  private readonly options: ProviderTranscriptOptions;
  private readonly locate: typeof locateSessionFile;
  private readonly sourcesById = new Map<string, AttachedSource>();
  private readonly blockStore = new Map<string, TranscriptBlock>();
  private readonly blockOrder: string[] = [];
  private readonly turnRunIds = new Map<string, RunId | null>();
  /** Each turn's attribution anchor, kept so an unattributed turn can RETRY
   *  on later blocks: hook-begun runs (wakeups, notifications) arrive on a
   *  channel that can lag the transcript tailer by seconds — a one-shot
   *  resolve at anchor time would freeze runId=null forever when the record
   *  wins that race (review 2026-07-03). Any later block that resolves fixes
   *  the whole turn (the reading surface takes the turn's runId from ANY
   *  block that carries one). */
  private readonly turnAnchors = new Map<
    string,
    { text: string; command: string | null; tsMs: number; promptId: string | null; textWindowMs?: number }
  >();
  private readonly assignedRunIds = new Set<RunId>();
  private discoveryTimer: NodeJS.Timeout | null = null;
  private discoveryDeadline = 0;
  private discoveryNotBefore: string | null = null;
  /** The session id discovery matches by. Mutable (unlike the option snapshot)
   *  so a hook that declares an id BEFORE its transcript file lands can point
   *  discovery at it (setExpectedSessionId) — the Codex self-heal. */
  private expectedSessionId: string | null;
  private disposed = false;

  constructor(options: ProviderTranscriptOptions) {
    this.options = options;
    this.locate = options.locate ?? locateSessionFile;
    this.expectedSessionId = options.expectedSessionId ?? null;
  }

  /**
   * Point discovery at a session id the CLI declared via a hook whose transcript
   * file has NOT landed yet. Claude re-adopts on every subsequent hook (its file
   * usually already exists); Codex reaches adoption ONLY on SessionStart (S2
   * gate), so without this a rollout that trails the handshake would never bind.
   * The discovery poll then adopts it by identity the moment the file appears —
   * one binding mechanism, no bespoke timer, and no mtime guess.
   */
  setExpectedSessionId(sessionId: string): void {
    this.expectedSessionId = sessionId;
  }

  /**
   * Re-attach a source persisted by a previous app run. Reads it fully.
   * Pass `tail: true` when the provider keeps appending to this file —
   * native resume continues the SAME session file for both providers.
   */
  attachExistingSource(ref: TranscriptSourceRef, options: { tail?: boolean } = {}): void {
    if (this.disposed || this.sourcesById.has(ref.sourceId)) {
      return;
    }
    const attached = this.attachSource(ref);
    attached.tailer.drain();
    if (options.tail) {
      attached.tailer.start();
    }
  }

  /** Start looking for the session file created by the current PTY launch. */
  startDiscovery(notBefore: string): void {
    if (this.disposed) {
      return;
    }
    this.discoveryNotBefore = notBefore;
    this.discoveryDeadline = Date.now() + DISCOVERY_TIMEOUT_MS;
    if (this.discoveryTimer) {
      return;
    }
    this.tryDiscover();
    if (!this.discoveryTimer && this.discoveryNotBefore) {
      this.discoveryTimer = setInterval(() => this.tryDiscover(), DISCOVERY_INTERVAL_MS);
    }
  }

  /** Re-arm discovery when runtime activity proves a session must exist. */
  ensureDiscovery(): void {
    if (this.disposed || this.discoveryTimer || !this.discoveryNotBefore) {
      return;
    }
    this.startDiscovery(this.discoveryNotBefore);
  }

  /**
   * Adopt a source by identity: the CLI itself named its session id and
   * transcript path (a hook payload, routed here via the per-task hook sink),
   * so no locator inference is involved. Ownership over inference — this is
   * the safety net that replaced the mtime fallback for Claude (2026-07-03):
   * it also tracks the session id CHANGING under a live PTY (/clear, a native
   * /resume), which the spawn-pinned id can never follow. Idempotent per
   * source; a duplicate adopt is a no-op.
   */
  adoptSource(ref: TranscriptSourceRef): void {
    if (this.disposed || this.sourcesById.has(ref.sourceId)) {
      return;
    }
    for (const source of this.sourcesById.values()) {
      if (source.ref.path === ref.path) {
        return;
      }
    }
    this.stopDiscovery();
    const attached = this.attachSource(ref);
    this.emitEvent({
      type: "transcript:located",
      payload: {
        taskId: this.options.taskId,
        source: ref,
      },
      ts: new Date().toISOString(),
    });
    attached.tailer.drain();
    attached.tailer.start();
  }

  hasLiveSource(): boolean {
    return this.sourcesById.size > 0;
  }

  sources(): TranscriptSourceRef[] {
    return [...this.sourcesById.values()].map((source) => source.ref);
  }

  blocks(): TranscriptBlock[] {
    return this.blockOrder
      .map((id) => this.blockStore.get(id))
      .filter((block): block is TranscriptBlock => Boolean(block));
  }

  dispose(): void {
    this.disposed = true;
    this.stopDiscovery();
    for (const source of this.sourcesById.values()) {
      source.tailer.stop();
    }
  }

  private tryDiscover(): void {
    if (this.disposed || !this.discoveryNotBefore) {
      return;
    }
    if (Date.now() > this.discoveryDeadline) {
      this.stopDiscovery();
      return;
    }

    const claimed = new Set<string>(this.options.externallyClaimedPaths?.() ?? []);
    for (const source of this.sourcesById.values()) {
      claimed.add(source.ref.path);
    }

    const ref = this.locate({
      provider: this.options.provider,
      providerCwd: this.options.providerCwd,
      notBefore: this.discoveryNotBefore,
      excludePaths: claimed,
      expectedSessionId: this.expectedSessionId,
      allowMtimeFallback: this.options.allowMtimeFallback ?? true,
    });
    if (!ref) {
      return;
    }

    this.stopDiscovery();
    const attached = this.attachSource(ref);
    this.emitEvent({
      type: "transcript:located",
      payload: {
        taskId: this.options.taskId,
        source: ref,
      },
      ts: new Date().toISOString(),
    });
    attached.tailer.drain();
    attached.tailer.start();
  }

  private attachSource(ref: TranscriptSourceRef): AttachedSource {
    const normalizer =
      ref.format === "claude-session-jsonl"
        ? new ClaudeSessionNormalizer({ taskId: this.options.taskId, sourceId: ref.sourceId })
        : new CodexRolloutNormalizer({
            taskId: this.options.taskId,
            sourceId: ref.sourceId,
            onUsageSnapshot: (snapshot) => this.emitUsageSnapshot(snapshot),
          });

    const attached: AttachedSource = {
      ref,
      normalizer,
      emittedOnce: false,
      tailer: new JsonlTailer({
        path: ref.path,
        ...(this.options.pollMs !== undefined ? { pollMs: this.options.pollMs } : {}),
        onLines: (lines) => this.consumeLines(attached, lines),
        onTruncated: () => {
          // Source files are append-only; truncation means replacement.
          attached.emittedOnce = false;
        },
      }),
    };
    this.sourcesById.set(ref.sourceId, attached);
    return attached;
  }

  private consumeLines(source: AttachedSource, lines: string[]): void {
    const upserts: TranscriptBlock[] = [];
    for (const line of lines) {
      for (const block of source.normalizer.consumeLine(line)) {
        upserts.push(this.attributeRun(block));
      }
    }
    if (upserts.length === 0) {
      return;
    }

    for (const block of upserts) {
      if (!this.blockStore.has(block.id)) {
        this.blockOrder.push(block.id);
      }
      this.blockStore.set(block.id, block);
    }

    const reset = !source.emittedOnce;
    source.emittedOnce = true;
    for (let index = 0; index < upserts.length; index += EMIT_CHUNK_SIZE) {
      this.emitEvent({
        type: "transcript:blocks",
        payload: {
          taskId: this.options.taskId,
          sourceId: source.ref.sourceId,
          upserts: upserts.slice(index, index + EMIT_CHUNK_SIZE),
          reset: reset && index === 0,
        },
        ts: new Date().toISOString(),
      });
    }
  }

  private attributeRun(block: TranscriptBlock): TranscriptBlock {
    const turnId = `${block.sourceId}:${block.turnKey}`;

    // A turn's attribution anchor: its user-message, or — for a continuation
    // turn opened by a machine-injected prompt (task-notification, /loop
    // wakeup) — the system-note carrying `sourcePrompt`. Without the latter,
    // machine turns could never match their runs and the run card fell back
    // to a terminal-approximation husk (2026-07-03). Machine anchors get a
    // TIGHT text window: recurring wakeups are byte-identical, so only
    // near-simultaneity may pair them (their promptId identity match has no
    // window at all).
    const promptId = /^turn-\d+$/.test(block.turnKey) ? null : block.turnKey;
    const anchor =
      block.kind === "user-message"
        ? { text: block.text, command: block.command, tsMs: Date.parse(block.ts), promptId }
        : block.kind === "system-note" && block.sourcePrompt
          ? {
              text: block.sourcePrompt,
              command: null,
              tsMs: Date.parse(block.ts),
              promptId,
              textWindowMs: SYSTEM_ANCHOR_TEXT_WINDOW_MS,
            }
          : null;
    if (anchor) {
      this.turnAnchors.set(turnId, anchor);
    }

    let runId = this.turnRunIds.get(turnId) ?? null;
    // Resolve on the anchor block, and RE-resolve on any later block while
    // the turn is still unattributed (the run may have been created after
    // the anchor lost the hook-vs-tailer race).
    const retryAnchor = anchor ?? (runId === null ? this.turnAnchors.get(turnId) : undefined);
    if (retryAnchor && runId === null) {
      runId = this.options.resolveRunId({
        ...retryAnchor,
        assigned: this.assignedRunIds,
      });
      if (runId) {
        this.assignedRunIds.add(runId);
      }
      this.turnRunIds.set(turnId, runId);
    }
    return runId ? { ...block, runId } : block;
  }

  private stopDiscovery(): void {
    if (this.discoveryTimer) {
      clearInterval(this.discoveryTimer);
      this.discoveryTimer = null;
    }
  }

  private emitEvent(event: RuntimeEvent): void {
    if (!this.disposed) {
      this.options.eventSink(event);
    }
  }

  private emitUsageSnapshot(snapshot: UsageSnapshot): void {
    this.emitEvent({
      type: "usage:updated",
      payload: {
        taskId: this.options.taskId,
        snapshot,
      },
      ts: new Date().toISOString(),
    });
  }
}
