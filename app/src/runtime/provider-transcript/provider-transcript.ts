import type { RunId, RuntimeProvider, TaskId } from "../../shared/types/domain";
import type { RuntimeEvent } from "../../shared/types/events";
import type { HookPayload } from "../../shared/types/cli-signal";
import type {
  AgentRosterBlock,
  AgentRunItem,
  TranscriptBlock,
  TranscriptSourceRef,
} from "../../shared/types/transcript";
import type { UsageSnapshot } from "../../shared/types/usage";
import { ClaudeSessionNormalizer } from "./claude-normalizer";
import { CodexRolloutNormalizer } from "./codex-normalizer";
import type { CodexTurnContextObservation } from "./codex-normalizer";
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
 * transcript blocks, attributes turns to Sonata Runs, and emits runtime events.
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
  /** Turns already flagged as "carried a real promptId that never matched a
   *  run" — so the diagnostic below logs once per turn, not once per block. */
  private readonly diagnosedUnattributed = new Set<string>();
  private discoveryTimer: NodeJS.Timeout | null = null;
  private discoveryDeadline = 0;
  private discoveryNotBefore: string | null = null;
  /** The session id discovery matches by. Mutable (unlike the option snapshot)
   *  so a hook that declares an id BEFORE its transcript file lands can point
   *  discovery at it (setExpectedSessionId) — the Codex self-heal. */
  private expectedSessionId: string | null;
  /** Codex subagent roster (S6), fed by SubagentStart/Stop hooks — NOT the
   *  normalizer. Codex subagents run in their own rollout files, so the parent
   *  rollout this class tails never carries their lifecycle; the hooks are the
   *  only source. These maps synthesize the same provider-neutral `agents` blocks
   *  the Claude normalizer derives from its session file, so the status strip's
   *  single roster read serves both providers. The block shares the CONVERSATION
   *  source id + `turn_id`, so it groups into the spawning turn AND draws its seq
   *  from that source's normalizer (per-source seq uniqueness, contract §A1.3). */
  private readonly codexAgents = new Map<string, AgentRunItem>();
  private readonly codexAgentTurnKey = new Map<string, string>();
  private readonly codexAgentRosters = new Map<string, AgentRosterBlock>();
  /** The conversation source id each launch turn's roster belongs to — the join
   *  key for deferral (emit once the source attaches) and for source-scoped
   *  eviction on truncation. */
  private readonly codexRosterSourceId = new Map<string, string>();
  /** True only while a tailer is REPLAYING a source's pre-existing content (the
   *  initial `drain()`), false during live forward-tailing. Gates the codex
   *  `turn_context` reconcile (item E) to LIVE observations — see
   *  emitCodexTurnContext. A `turn_context` records the state of the turn that
   *  WROTE it (the last turn before any post-turn switch), so replaying it on a
   *  reopen/resume — where attachExistingSource re-reads the whole appended-to
   *  rollout — would reconcile the session's mirrors back to that stale turn and
   *  clobber a more recent Sonata-driven switch the manifest already holds. That
   *  is the S6 field bug: a mid-session model/effort/permission switch reverts on
   *  the chip after the session is reopened. Usage snapshots deliberately do NOT
   *  gate on this: they are latest-wins and the last token_count IS the current
   *  usage, so a drain re-emit is correct for them. */
  private replayingDrain = false;
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
    this.drainReplaying(attached);
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
    this.drainReplaying(attached);
    attached.tailer.start();
    // The source is now attached (and drained past its first reset) — flush any
    // subagent roster deferred while it was still discovering (reviewer F2). The
    // discovery-poll path (tryDiscover) is the real flush point in the
    // adoption-trails race; a no-op when there are no pending rosters or for
    // Claude sources.
    this.syncCodexRostersForSource(ref.sourceId);
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

  /**
   * Feed a Codex subagent lifecycle hook (SubagentStart / SubagentStop, S6).
   * The controller routes these here OFF the main-turn spine — a subagent event
   * describes a CHILD agent, not the parent turn (SubagentStart's
   * `transcript_path` even points at the child's own rollout), so it must never
   * adopt a source or drive cli-state. It synthesizes/updates an `agents` roster
   * block keyed by the launch turn and emits it on the same `transcript:blocks`
   * channel the normalizer uses, so the status strip renders Codex subagents
   * exactly like Claude's. Codex-only: Claude derives its roster from the
   * session file, so its own SubagentStop never reaches here.
   */
  applySubagentEvent(payload: HookPayload, receivedAt: string = new Date().toISOString()): void {
    if (this.disposed) {
      return;
    }
    const agentId =
      typeof payload.agent_id === "string" && payload.agent_id ? payload.agent_id : null;
    if (!agentId) {
      return;
    }
    if (payload.hook_event_name === "SubagentStart") {
      const turnKey =
        typeof payload.turn_id === "string" && payload.turn_id ? payload.turn_id : null;
      if (!turnKey) {
        return;
      }
      // A duplicate Start for a KNOWN agent id is noise, not a restart: agent_id
      // is a per-subagent UUID, so a second Start names the same agent. Ignoring
      // it keeps the first spawn authoritative — never resurrect a settled agent
      // to running, nor reset a live one's startedAt clock (reviewer F5).
      if (this.codexAgents.has(agentId)) {
        return;
      }
      const rawType =
        typeof payload.agent_type === "string" && payload.agent_type.trim()
          ? payload.agent_type.trim()
          : "default";
      this.codexAgents.set(agentId, {
        toolUseId: agentId,
        name: "Subagent",
        detail: null,
        // "default" is Codex's generic kind — suppress the redundant type chip
        // by mapping it to the roster's own generic sentinel ("agent", which the
        // strip hides); a NAMED kind rides through as the secondary label.
        agentType: rawType === "default" ? "agent" : rawType,
        status: "running",
        startedAt: receivedAt,
        durationMs: null,
      });
      this.codexAgentTurnKey.set(agentId, turnKey);
      this.codexRosterSourceId.set(turnKey, this.conversationSourceId(payload));
      this.emitCodexRosterForTurn(turnKey);
      return;
    }
    if (payload.hook_event_name === "SubagentStop") {
      const item = this.codexAgents.get(agentId);
      const turnKey = this.codexAgentTurnKey.get(agentId);
      // A Stop with no matching Start (a dropped SubagentStart): nothing was ever
      // shown running, so there is nothing to settle — ignore it.
      if (!item || !turnKey) {
        return;
      }
      if (this.settleCodexAgent(item, receivedAt)) {
        this.emitCodexRosterForTurn(turnKey);
      }
    }
  }

  /**
   * The parent turn ended (its `Stop` hook) — settle any Codex subagent still
   * marked running for it. Codex subagents are AWAITED within their launch turn
   * (the parent blocks on `collaborationwait_agent`), so a running row outliving
   * the turn's Stop is a dropped SubagentStop, not async work: clear it, or the
   * status strip would show a phantom subagent forever.
   */
  settleSubagentTurn(turnKey: string, receivedAt: string = new Date().toISOString()): void {
    if (this.disposed) {
      return;
    }
    let changed = false;
    for (const [agentId, item] of this.codexAgents) {
      if (this.codexAgentTurnKey.get(agentId) === turnKey && item.status === "running") {
        if (this.settleCodexAgent(item, receivedAt)) {
          changed = true;
        }
      }
    }
    if (changed) {
      this.emitCodexRosterForTurn(turnKey);
    }
  }

  /** Settle one running subagent to done, computing a wall-clock duration from
   *  its spawn (Codex's SubagentStop carries none). Returns whether it changed,
   *  so a duplicate Stop emits no redundant roster upsert. */
  private settleCodexAgent(item: AgentRunItem, ts: string): boolean {
    if (item.status === "done") {
      return false;
    }
    item.status = "done";
    const started = Date.parse(item.startedAt);
    const ended = Date.parse(ts);
    item.durationMs =
      Number.isNaN(started) || Number.isNaN(ended) ? null : Math.max(0, ended - started);
    return true;
  }

  /**
   * Emit one launch turn's roster block — IF its conversation source is attached
   * (its normalizer is the only place the block's `seq` can come from, contract
   * §A1.3). If the source is still discovering (adoption trails SessionStart —
   * the setExpectedSessionId/ensureDiscovery window), skip: emitting now would
   * put the block under a sourceId whose first `reset:true` drain has not fired,
   * and that drain would delete it on the consumer while blockStore keeps it (the
   * snapshot≢replay class INV-5 forbids). The deferred roster is flushed by
   * `syncCodexRostersForSource` the moment the source attaches (reviewer F2).
   */
  private emitCodexRosterForTurn(turnKey: string): void {
    const sourceId = this.codexRosterSourceId.get(turnKey);
    if (!sourceId) {
      return;
    }
    const source = this.sourcesById.get(sourceId);
    if (!source || !(source.normalizer instanceof CodexRolloutNormalizer)) {
      return;
    }
    this.storeAndEmitRoster(this.buildCodexRoster(turnKey, source.normalizer));
  }

  /**
   * (Re)emit every roster block belonging to one source. Two callers, both
   * enforcing F2 instead of asserting it: (a) `adoptSource` after the first drain
   * — flushes any roster deferred while the source was discovering; (b)
   * `consumeLines` after a `reset:true` batch — restores rosters the reset just
   * deleted on the consumer. Idempotent: each block reuses its stable id + seq.
   */
  private syncCodexRostersForSource(sourceId: string): void {
    const source = this.sourcesById.get(sourceId);
    if (!source || !(source.normalizer instanceof CodexRolloutNormalizer)) {
      return;
    }
    for (const [turnKey, sid] of this.codexRosterSourceId) {
      if (sid === sourceId) {
        this.storeAndEmitRoster(this.buildCodexRoster(turnKey, source.normalizer));
      }
    }
  }

  /**
   * Evict one source's subagent roster state after a truncation-replacement.
   * `dropSource` already removed the roster BLOCKS from blockStore; without this
   * the agent maps would survive, and a later `settleSubagentTurn` for a
   * pre-truncation turnKey would rebuild the dropped block as an empty husk turn
   * in the body (reviewer F4). Keyed by the conversation source the rosters share.
   */
  private dropCodexSubagents(sourceId: string): void {
    const turnKeys = new Set<string>();
    for (const [turnKey, sid] of this.codexRosterSourceId) {
      if (sid === sourceId) {
        turnKeys.add(turnKey);
      }
    }
    if (turnKeys.size === 0) {
      return;
    }
    for (const [agentId, turnKey] of this.codexAgentTurnKey) {
      if (turnKeys.has(turnKey)) {
        this.codexAgents.delete(agentId);
        this.codexAgentTurnKey.delete(agentId);
      }
    }
    for (const turnKey of turnKeys) {
      this.codexAgentRosters.delete(turnKey);
      this.codexRosterSourceId.delete(turnKey);
    }
  }

  /** Rebuild the roster block for one launch turn from the live agent map,
   *  keeping a STABLE id + seq across upserts (the transcript-contract property
   *  the status strip's signature guard relies on — mirrors the Claude roster's
   *  upsert-in-place). Items are spread copies, so an already-emitted block is
   *  never mutated by a later settle. A NEW block draws its `seq` from the
   *  conversation source's normalizer (per-source ordering, contract §A1.3); an
   *  existing block keeps its id + seq. The block shares the conversation source
   *  id + the launch `turn_id`, so `buildReadingTurns` groups it INTO the spawning
   *  turn, not a phantom turn of its own. */
  private buildCodexRoster(turnKey: string, normalizer: CodexRolloutNormalizer): AgentRosterBlock {
    const sourceId = this.codexRosterSourceId.get(turnKey) ?? `codex-subagents:${this.options.taskId}`;
    const items: AgentRunItem[] = [];
    let latestTs: string | null = null;
    for (const [agentId, item] of this.codexAgents) {
      if (this.codexAgentTurnKey.get(agentId) === turnKey) {
        items.push({ ...item });
        if (!latestTs || item.startedAt > latestTs) {
          latestTs = item.startedAt;
        }
      }
    }
    const existing = this.codexAgentRosters.get(turnKey);
    const ts = latestTs ?? existing?.ts ?? new Date().toISOString();
    const updated: AgentRosterBlock = existing
      ? { ...existing, items, ts }
      : {
          kind: "agents",
          // `:agents:` namespaces the id away from any normalizer block on the
          // same source (mirrors the Claude roster + codex `:plan:` blocks).
          id: `${sourceId}:agents:${turnKey}`,
          taskId: this.options.taskId,
          sourceId,
          provider: "codex",
          turnKey,
          runId: null,
          ts,
          seq: normalizer.allocateSeq(),
          items,
        };
    this.codexAgentRosters.set(turnKey, updated);
    return updated;
  }

  /** Store the synthesized roster block and emit it on the same
   *  `transcript:blocks` channel the normalizer uses — so it lands in the same
   *  `view.transcriptBlocks` the status strip reads. Never emitted with `reset`:
   *  the source's own reset is scoped to its sourceId, and a roster deleted by
   *  one is restored by `syncCodexRostersForSource`. */
  private storeAndEmitRoster(block: AgentRosterBlock): void {
    if (!this.blockStore.has(block.id)) {
      this.blockOrder.push(block.id);
    }
    this.blockStore.set(block.id, block);
    this.emitEvent({
      type: "transcript:blocks",
      payload: {
        taskId: this.options.taskId,
        sourceId: block.sourceId,
        upserts: [block],
        reset: false,
      },
      ts: new Date().toISOString(),
    });
  }

  /** The conversation source id a fresh roster block joins — built from the
   *  hook's `session_id` exactly as `adoptTranscriptFromHook` builds the rollout
   *  source id (`codex:<sessionId>`), so the two group together and share the
   *  source's seq counter. Falls back to a task-scoped synthetic id only if a
   *  payload ever omits `session_id` (the strip still works; only body grouping
   *  and the seq-sharing degrade). */
  private conversationSourceId(payload: HookPayload): string {
    const sessionId =
      typeof payload.session_id === "string" && payload.session_id ? payload.session_id : null;
    return sessionId ? `codex:${sessionId}` : `codex-subagents:${this.options.taskId}`;
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
    this.drainReplaying(attached);
    attached.tailer.start();
    // The source is now attached (and drained past its first reset) — flush any
    // subagent roster deferred while it was still discovering (reviewer F2). The
    // discovery-poll path (tryDiscover) is the real flush point in the
    // adoption-trails race; a no-op when there are no pending rosters or for
    // Claude sources.
    this.syncCodexRostersForSource(ref.sourceId);
  }

  /** Read a source's existing content through its tailer, marking the pass as a
   *  REPLAY so the codex `turn_context` reconcile stays live-only (replayingDrain
   *  — the S6 resume-clobber fix). Synchronous: `drain()` reads and dispatches
   *  every line before returning, so the flag is correctly scoped to exactly the
   *  replayed lines and cleared before live tailing (start()) begins. */
  private drainReplaying(attached: AttachedSource): void {
    const previous = this.replayingDrain;
    this.replayingDrain = true;
    try {
      attached.tailer.drain();
    } finally {
      this.replayingDrain = previous;
    }
  }

  private createNormalizer(
    ref: TranscriptSourceRef,
  ): ClaudeSessionNormalizer | CodexRolloutNormalizer {
    return ref.format === "claude-session-jsonl"
      ? new ClaudeSessionNormalizer({ taskId: this.options.taskId, sourceId: ref.sourceId })
      : new CodexRolloutNormalizer({
          taskId: this.options.taskId,
          sourceId: ref.sourceId,
          onUsageSnapshot: (snapshot) => this.emitUsageSnapshot(snapshot),
          onTurnContext: (context) => this.emitCodexTurnContext(context),
        });
  }

  private attachSource(ref: TranscriptSourceRef): AttachedSource {
    const attached: AttachedSource = {
      ref,
      normalizer: this.createNormalizer(ref),
      emittedOnce: false,
      tailer: new JsonlTailer({
        path: ref.path,
        ...(this.options.pollMs !== undefined ? { pollMs: this.options.pollMs } : {}),
        onLines: (lines) => this.consumeLines(attached, lines),
        onTruncated: () => {
          // Truncation means the file was REPLACED (sources are otherwise
          // append-only). The reset:true batch that follows tells consumers to
          // drop this source's blocks — so blocks() (the sessionSnapshot
          // source, runtime-controller.ts:706-715) must drop them too, or
          // snapshot ≢ replay across this trigger (S1 INV-5; contract A1.5
          // trigger b). Rebuild the normalizer fresh so its accumulated state
          // (seq counter, turn map) cannot leak across the replacement and
          // shift codex re-read ids, then evict the source's stale blocks and
          // turn attribution before the full re-read repopulates them.
          attached.emittedOnce = false;
          attached.normalizer = this.createNormalizer(attached.ref);
          this.dropSource(attached.ref.sourceId);
        },
      }),
    };
    this.sourcesById.set(ref.sourceId, attached);
    return attached;
  }

  /**
   * Evict every trace of one source after a truncation-replacement: its blocks
   * (so blocks() matches the reset:true the event stream emits) and its turn
   * attribution. Turn ids are `${sourceId}:${turnKey}`, so a replacement file
   * that reuses a turnKey with different content must not inherit the old
   * turn's run (turnRunIds short-circuits re-resolution when a runId is already
   * set), stale anchor, or once-logged diagnostic. Any run the dropped turns
   * had claimed is released back to the assignment pool so the re-read can
   * re-claim it. The source ATTACHMENT stays — the same file keeps being tailed.
   */
  private dropSource(sourceId: string): void {
    for (const [id, block] of this.blockStore) {
      if (block.sourceId === sourceId) {
        this.blockStore.delete(id);
      }
    }
    const surviving = this.blockOrder.filter((id) => this.blockStore.has(id));
    this.blockOrder.length = 0;
    this.blockOrder.push(...surviving);

    const prefix = `${sourceId}:`;
    for (const [turnId, runId] of [...this.turnRunIds]) {
      if (turnId.startsWith(prefix)) {
        if (runId) {
          this.assignedRunIds.delete(runId);
        }
        this.turnRunIds.delete(turnId);
      }
    }
    for (const turnId of [...this.turnAnchors.keys()]) {
      if (turnId.startsWith(prefix)) {
        this.turnAnchors.delete(turnId);
      }
    }
    for (const turnId of [...this.diagnosedUnattributed]) {
      if (turnId.startsWith(prefix)) {
        this.diagnosedUnattributed.delete(turnId);
      }
    }
    // A truncation-replacement also invalidates any subagent roster synthesized
    // for this source — drop the agent maps so a later settle can't resurrect a
    // now-deleted block as an empty husk turn (reviewer F4).
    this.dropCodexSubagents(sourceId);
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
    // A reset:true batch deleted this source's blocks on the consumer, including
    // any subagent roster already synthesized for it — restore them (reviewer
    // F2). No-op unless a roster exists for this source and the reset just fired.
    if (reset) {
      this.syncCodexRostersForSource(source.ref.sourceId);
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
      // Observability for the codex turn_id bridge: a turn that carries a REAL
      // promptId (the rollout turn_id) yet resolves to no run is the exact
      // failure the null-promptId era silently avoided — an identity mismatch
      // (hook turn_id ≠ rollout turn_id: version skew, an abort before
      // task_started, a future protocol change) now ends in an unattributed
      // husk instead of a text/time fallback (the identity-outranks-text guard
      // skips id-mismatched runs by design — unchanged here). Surface it once
      // per turn so a future violation is visible in logs, not a mystery card.
      if (
        runId === null &&
        block.provider === "codex" &&
        retryAnchor.promptId !== null &&
        !this.diagnosedUnattributed.has(turnId)
      ) {
        this.diagnosedUnattributed.add(turnId);
        console.debug(
          `[signal] codex turn ${turnId} anchor promptId ${retryAnchor.promptId} matched no run — check the turn_id bridge`,
        );
      }
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

  /** Relay a codex `turn_context` observation to the controller for mirror
   *  reconcile (item E). Same side-channel shape as emitUsageSnapshot; the event
   *  is controller-internal (never forwarded to the renderer — the reconcile it
   *  drives emits task:updated, which the renderer already consumes).
   *
   *  LIVE-only (replayingDrain — the S6 resume-clobber fix): a turn_context read
   *  by the initial drain replays a PAST turn's state, which must not reconcile
   *  the mirrors backward over a more recent switch the manifest already holds.
   *  Only a turn_context observed while live forward-tailing — a real native
   *  switch as it happens — reaches the reconcile. A native switch made while
   *  Sonata was closed self-heals on that session's next live turn. */
  private emitCodexTurnContext(context: CodexTurnContextObservation): void {
    if (this.replayingDrain) {
      return;
    }
    this.emitEvent({
      type: "codex-turn-context:observed",
      payload: {
        taskId: this.options.taskId,
        model: context.model,
        effort: context.effort,
        approvalPolicy: context.approvalPolicy,
        sandboxPolicy: context.sandboxPolicy,
      },
      ts: new Date().toISOString(),
    });
  }
}
