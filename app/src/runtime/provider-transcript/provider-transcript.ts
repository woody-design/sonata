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

export interface ResolveRunIdInput {
  text: string;
  command: string | null;
  tsMs: number;
  assigned: ReadonlySet<RunId>;
}

export interface ProviderTranscriptOptions {
  taskId: TaskId;
  provider: RuntimeProvider;
  providerCwd: string;
  eventSink: (event: RuntimeEvent) => void;
  resolveRunId: (input: ResolveRunIdInput) => RunId | null;
  externallyClaimedPaths?: () => ReadonlySet<string>;
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
  private readonly assignedRunIds = new Set<RunId>();
  private discoveryTimer: NodeJS.Timeout | null = null;
  private discoveryDeadline = 0;
  private discoveryNotBefore: string | null = null;
  private disposed = false;

  constructor(options: ProviderTranscriptOptions) {
    this.options = options;
    this.locate = options.locate ?? locateSessionFile;
  }

  /** Re-attach a source persisted by a previous app run. Reads it fully. */
  attachExistingSource(ref: TranscriptSourceRef): void {
    if (this.disposed || this.sourcesById.has(ref.sourceId)) {
      return;
    }
    const attached = this.attachSource(ref);
    attached.tailer.drain();
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

    if (block.kind === "user-message") {
      const runId = this.options.resolveRunId({
        text: block.text,
        command: block.command,
        tsMs: Date.parse(block.ts),
        assigned: this.assignedRunIds,
      });
      if (runId) {
        this.assignedRunIds.add(runId);
      }
      this.turnRunIds.set(turnId, runId);
      return { ...block, runId };
    }

    const runId = this.turnRunIds.get(turnId) ?? null;
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
