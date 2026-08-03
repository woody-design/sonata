import type { NativeStatusRegion, WorkingLiveness } from "./working-status";
import type { CliActivity } from "./cli-signal";
import type {
  ApprovalChoice,
  ApprovalDecision,
  ApprovalDecisionEncoding,
  ApprovalKind,
  ChangeKind,
  ClaudePermissionMode,
  CompletionConfidence,
  CompletionHint,
  CompletionSource,
  DeliveryItemId,
  DeliveryQueueItem,
  DeliveryReceipt,
  DeliveryTaskState,
  LaunchSpeedMode,
  ReasoningEffort,
  RunId,
  RunKind,
  RunStatus,
  TaskId,
  Task,
  RuntimeProvider,
} from "./domain";
import type { TranscriptBlock, TranscriptSourceRef } from "./transcript";
import type { OptionPromptAnswers, OptionPromptQuestion } from "./option-prompt";
import type { UsageSnapshot } from "./usage";

export interface BaseRuntimeEvent<TType extends string, TPayload> {
  type: TType;
  payload: TPayload;
  ts: string;
}

export type TerminalDataEvent = BaseRuntimeEvent<
  "pty:data",
  {
    taskId: TaskId;
    /** Main-process-monotonic identity of the TerminalHost that emitted this
     *  chunk. A task id persists across close/reopen; generation does not.
     *  Terminal consumers must never append or hydrate across boundaries. */
    generation: number;
    data: string;
    /** 0-based index of this chunk in the mirror's ingest order. The terminal
     *  window stitches live chunks onto a mid-stream hydration snapshot with it
     *  (write iff seq >= snapshot.seq) — no loss, no duplication. The other
     *  consumers (transcript, idle heuristic, local-api) ignore it. */
    seq: number;
  }
>;

export type PtyExitEvent = BaseRuntimeEvent<
  "pty:exit",
  {
    taskId: TaskId;
    /** Matches the emitting TerminalHost's pty:data/replay generation. */
    generation: number;
    runId: RunId | null;
    exitCode: number | null;
    signal: number | null;
    elapsedMs: number | null;
    /**
     * Sonata killed this process itself (SL-6) — a task close, an app teardown,
     * or a respawn's pre-spawn dispose, all of which stamp the PTY's teardown
     * token in `TerminalHost.disposeProcess`. False means the death came from
     * OUTSIDE Sonata: a crash, or the user quitting the CLI in the co-visible
     * Terminal. Optional so recorded fixtures (and any pre-SL-6 event on disk)
     * read as "not stamped" rather than as a false teardown claim.
     */
    sonataInitiated?: boolean;
  }
>;

/**
 * A codex session ended without Sonata killing it, and the conversation can be
 * brought back with `codex resume` (SL-6). Raised for the silent-exit class
 * openai/codex #36005 opened at 0.146.0 — the TUI dies with no stderr and no
 * crash report as the final agent message finishes rendering — and for any other
 * outside-Sonata codex death whose rollout survives; Sonata cannot tell them
 * apart, and does not need to (see `classifyCodexSessionExit`).
 *
 * The renderer raises an attention banner offering a resume; Sonata NEVER
 * respawns on its own, because resuming spawns a process and that is the user's
 * call. Display-only shell chrome (a renderer-local banner store, like
 * cli-hooks:liveness and codex-update-prompt:detected), never a reading-core
 * view field.
 */
export type CodexSessionResumableExitEvent = BaseRuntimeEvent<
  "codex-session-exit:resumable",
  {
    taskId: TaskId;
    /** The exit cut a turn short — the answer in flight is lost, while the
     *  conversation before it is not. Drives the banner's copy. */
    midTurn: boolean;
  }
>;

export type TaskStartedEvent = BaseRuntimeEvent<
  "task:started",
  {
    taskId: TaskId;
    provider: RuntimeProvider;
    model: string | null;
    reasoningEffort: ReasoningEffort | null;
    speedMode: LaunchSpeedMode | null;
    command: string;
    args: string[];
    cwd: string;
    rows: number;
    cols: number;
    persistence: "raw-terminal-memory-only";
  }
>;

/** A quiescence-completed run returned the composer (fired only from
 *  `finishActiveRun`, terminal-idle-heuristic completions). Consumed by the
 *  cli-state busy→turn-ended fallback for turns with no Stop hook (slash,
 *  Esc-interrupt, codex). The between-runs poller that also fed this —
 *  along with the `task:accepts-input` boot announcement — was retired in
 *  S6 (starved by the idle TUI's control-only heartbeat; boot readiness is
 *  the delivery pump's structural poll). */
export type TaskReadyEvent = BaseRuntimeEvent<
  "task:ready",
  {
    taskId: TaskId;
    source: "terminal-idle-composer-heuristic";
    confidence: CompletionConfidence;
  }
>;

/**
 * Codex hooks-liveness (control plane S2; D4 overturned 2026-07-06). Sonata passes
 * `--dangerously-bypass-hook-trust` on every codex spawn (trust can't persist
 * through a profile layer), so hooks should fire on every spawn — the
 * SessionStart handshake IS the effect-check that they are. `missing` = no
 * handshake within the spawn-scaled window, i.e. the hook shim FAILED to fire
 * (e.g. its interpreter isn't on PATH in a non-login launch) — NOT a trust gap;
 * the renderer raises the "hooks aren't running" banner. `live` = a late
 * handshake arrived, clear it.
 *
 * Display-only shell chrome: the renderer handles this OUTSIDE the reading-core
 * reducer (a renderer-local banner store), never as a task-view field — hook
 * liveness is not reading content.
 */
export type CliHooksLivenessEvent = BaseRuntimeEvent<
  "cli-hooks:liveness",
  {
    taskId: TaskId;
    status: "missing" | "live";
  }
>;

/**
 * Codex's boot "Update available!" TUI is up and blocking composer readiness
 * (consolidation S4). When a newer codex release exists the CLI renders a
 * full-screen update gate at boot — `1. Update now …` / `Press enter to
 * continue` — and the composer never appears until the user resolves it in the
 * terminal. Sonata cannot (and must NEVER) auto-answer it — running
 * `brew upgrade` or pressing keys blind is the user's call — so on a boot
 * readiness timeout whose PTY tail matches the gate signature the terminal-host
 * emits this and the renderer raises a passive "resolve it in the CLI" banner.
 * Display-only shell chrome (a renderer-local banner store, like
 * cli-hooks:liveness), never a reading-core view field.
 */
export type CodexUpdatePromptEvent = BaseRuntimeEvent<
  "codex-update-prompt:detected",
  {
    taskId: TaskId;
  }
>;

export type WorkingStatusUpdatedEvent = BaseRuntimeEvent<
  "working-status:updated",
  {
    taskId: TaskId;
    native: NativeStatusRegion | null;
    liveness: WorkingLiveness;
    silentSince: string | null;
    capturedAt: string;
  }
>;

/**
 * The unified CLI activity state changed (Slice 1, Layer 1). Fed primarily by
 * Claude hooks (busy/idle/approval transitions) with terminal-host signals as
 * the safety net. The renderer subscribes to drive the working indicator from a
 * structured signal instead of the 3Hz glyph scrape. UI-agnostic by design.
 */
export type CliStateChangedEvent = BaseRuntimeEvent<
  "cli-state:changed",
  {
    taskId: TaskId;
    activity: CliActivity;
    tool: string | null;
    approvalKind: string | null;
    source: string;
    changedAt: string;
  }
>;

export type TaskUpdatedEvent = BaseRuntimeEvent<
  "task:updated",
  {
    taskId: TaskId;
    task: Task;
    reason: "runtime-status" | "session-renamed";
  }
>;

export type PromptSubmittedEvent = BaseRuntimeEvent<
  "prompt:submitted",
  {
    taskId: TaskId;
    runId: RunId | null;
    kind: RunKind;
    chars: number;
    attachments: number;
  }
>;

export type DeliveryStateEvent = BaseRuntimeEvent<"delivery:state", DeliveryTaskState>;

export type DeliveryReceiptEvent = BaseRuntimeEvent<
  "delivery:receipt",
  {
    taskId: TaskId;
    itemId: DeliveryItemId;
    item: DeliveryQueueItem;
    receipt: DeliveryReceipt;
  }
>;

export type RunStartedEvent = BaseRuntimeEvent<
  "run:started",
  {
    taskId: TaskId;
    id: RunId;
    kind: RunKind;
    prompt: string;
    title: string;
    /** The CLI's own prompt id (`UserPromptSubmit.prompt_id` — the same id
     *  the transcript records as `promptId`/turnKey). The EXACT run↔turn
     *  bridge; null for runs begun before the hook fires (idle-path writes)
     *  or recorded pre-bridge — those fall back to text/time matching. */
    promptId?: string | null;
    status: RunStatus;
    lifecyclePhase: RunStatus;
    startedAt: string;
    endedAt: string | null;
    elapsedMs: number | null;
    completionSource: CompletionSource | null;
    completionConfidence: CompletionConfidence | null;
  }
>;

export type RunUpdatedEvent = BaseRuntimeEvent<
  "run:updated",
  RunStartedEvent["payload"] & {
    statusReason?: string;
    completionHint?: CompletionHint;
    lastLifecycleHint?: unknown;
    approvalKind?: ApprovalKind;
    approvalDecision?: ApprovalDecision;
  }
>;

export type RunStopRequestedEvent = BaseRuntimeEvent<
  "run:stop-requested",
  {
    taskId: TaskId;
    runId: RunId | null;
    /** `interrupt` = the stop click's own Esc; `interrupt-retry` = the
     *  one-shot resend after post-stop tool activity proved the first Esc
     *  was swallowed. */
    phase: "interrupt" | "interrupt-retry";
    encodedAs: "Esc";
  }
>;

export type RunStoppedEvent = BaseRuntimeEvent<
  "run:stopped",
  {
    taskId: TaskId;
    runId: RunId | null;
    interruptSent: boolean;
    slashStopSent: boolean;
    slashStopReason: string;
  }
>;

/**
 * Remote Control (phone access) state for a task changed. v1 rides Claude
 * Code's native `/remote-control`: `active` is tracked optimistically (we
 * injected `/rc`, verified to work mid-stream); `url` is the session link
 * scraped from the stream — the one datum with no hook/structured channel,
 * matched by its stable format, never the surrounding prose. The phone surface
 * is Anthropic's claude.ai/code + Claude app, not a Sonata-built UI.
 */
export type RemoteControlStateEvent = BaseRuntimeEvent<
  "remote-control:state",
  {
    taskId: TaskId;
    active: boolean;
    url: string | null;
  }
>;

/**
 * A mid-session Claude control switch changed phase (mid-session switch
 * program). One event family for every axis Reading can drive natively:
 *   - `model` / `effort` (S1) — Sonata injected `/model <id>` / `/effort <level>`
 *     as typed text and watches the pty stream for the CLI's own receipt line
 *     (`Set model to …` / `Set effort level to …`). One-shot.
 *   - `permission` (S2) — Sonata drove the Shift+Tab (`\x1b[Z`) stepping engine,
 *     using the TUI mode line (`plan mode on`, `auto mode on`, …) as the
 *     per-step choreography receipt. `value` is the TARGET mode id; the state
 *     SSOT stays the hook payload's `permission_mode` (lazy reconcile — the mode
 *     line is receipt-only). `observedModes` lists every mode the choreography
 *     confirmed via a receipt this run, so the renderer can learn which
 *     account-gated modes (`auto`) this session can actually reach.
 *   - `codex-model` / `codex-effort` (S4) — Sonata drove codex's `/model`
 *     TWO-level picker (level 1 = curated model rows, level 2 = reasoning rows)
 *     by TEXT, arrows + Enter, landing the non-selected dimension on its
 *     `(current)`-marked row, and read the `• Model changed to <model> <effort>`
 *     receipt. `value` is the selected model slug / reasoning id; the settled
 *     event ALSO carries `codexModel` + `codexEffort` (the receipt's own pair),
 *     which the controller writes to task.model + task.reasoningEffort (codex has
 *     no statusline/hook model mirror — the picker receipt is the channel).
 * Phases:
 *   - `pending` — the switch is driving; waiting for its receipt(s).
 *   - `settled` — the target was confirmed (model/effort receipt line, the target
 *     mode line for claude permission, or the `• Permissions updated to <label>`
 *     receipt for codex-permission). For model/effort/permission the chip follows
 *     its own SSOT (statusline / hook payload), so `settled` only clears the
 *     pending affordance. Codex-permission is the ASYMMETRIC case: codex has no
 *     hook-payload permission mirror, so the picker RECEIPT is the confirmation
 *     channel — the controller writes `task.codexPermissionMode` off this settled
 *     event (see `applyCodexPermissionSwitchReceipt` in runtime-controller).
 *   - `failed` — a clean rejection (`Model '<x>' not found`); `error` carries the
 *     surfaced reason, nothing changed CLI-side. (Not used by permission — a
 *     Shift+Tab step cannot be "rejected"; it either lands or aborts home.)
 *   - `needs-attention` — the drive could not confirm the target and the screen
 *     is in an unrecognized state (model/effort: a cache-miss confirm / consent
 *     interstitial; permission: stepping aborted and returned home, or landed
 *     somewhere the hook SSOT must reconcile). RED LINE: Sonata does NOTHING
 *     further — no auto-answer, no blind-Enter, no non-`\x1b[Z` key — and points
 *     the user at the CLI.
 */
export type ControlSwitchStateEvent = BaseRuntimeEvent<
  "control-switch:state",
  {
    taskId: TaskId;
    kind: "model" | "effort" | "permission" | "codex-permission" | "codex-model" | "codex-effort";
    value: string;
    phase: "pending" | "parked" | "settled" | "failed" | "needs-attention";
    error: string | null;
    /** Permission axis only: the modes this Shift+Tab choreography confirmed via
     *  a mode-line receipt (including pass-throughs). The renderer merges these
     *  into the session's reachable-modes set so the menu never offers a mode the
     *  cycle can't reach (D4 — no dead steps). Absent on model/effort. */
    observedModes?: ClaudePermissionMode[];
    /** codex-model / codex-effort SETTLED only: the (model, effort) pair the
     *  `/model` picker's `• Model changed to <model> <effort>` receipt confirmed.
     *  Codex has no statusline/hook mirror for its model or effort, so the picker
     *  RECEIPT is the confirmation channel — the controller writes BOTH task.model
     *  and task.reasoningEffort off these fields (mirrors the codex-permission
     *  asymmetry; see runtime-controller `applyCodexModelSwitchReceipt`). Both are
     *  the receipt's own values (receipt-corroborated, not the requested target).
     *  Absent on every other kind/phase — the display `value` carries the pending/
     *  needs-attention target (the model slug for codex-model, the effort id for
     *  codex-effort). */
    codexModel?: string | null;
    codexEffort?: ReasoningEffort | null;
    /** needs-attention ONLY: WHY the drive couldn't confirm, when the cause is
     *  known — so the banner can name the exact next action instead of the generic
     *  "check the CLI" fallback (S5). Absent ⇒ a generic timeout/opaque-screen
     *  rollback (the fallback copy). Cases:
     *   - `interstitial` — claude model/effort earned no receipt in time: the CLI
     *     is showing a cache-miss confirm / Fable-consent dialog the user must
     *     answer natively (the DEFAULT flow on a session with history — S1). Banner:
     *     "Confirm the switch in the CLI".
     *   - `consent` — codex Full Access opened its `Enable full access?` consent
     *     dialog; Sonata rolled back rather than auto-answer (RED LINE 2 — a human
     *     grant). Banner: "Confirm Full Access in the CLI".
     *   - `drift` — a codex `/model` target row was absent from the live picker
     *     (legacy/curated-list drift, D5) or the effort to preserve had no v1 row;
     *     nothing changed CLI-side. Banner: "Model list changed upstream — switch
     *     in the CLI". */
    reason?: "interstitial" | "consent" | "drift";
    /** `parked` ONLY (S7): a RECOGNIZED confirm dialog is open in the Terminal and
     *  Sonata parked on it — the renderer surfaces its rows in the Action Drawer and
     *  the user's chosen row is relayed back (`answerControlConfirm`). Which dialog:
     *   - `claude-cachemiss` — the `Switch model? / Change effort level?` confirm a
     *     `/model` / `/effort` inject raises on a session with history (rows: Yes/No).
     *   - `codex-consent` — the `Enable full access?` consent the /permissions Full
     *     Access row opens (rows: Yes continue / Cancel — codex 0.146.0).
     *  The renderer composes the VERBATIM rows from (dialog, kind, value) + its own
     *  registered copy; send stays gated while parked. */
    dialog?: "claude-cachemiss" | "codex-consent";
    /** `settled` ONLY (S7): the parked confirm was user-CANCELLED (claude No, or a
     *  codex Cancel/native cancel) — nothing changed CLI-side, so the chip follows
     *  its unchanged SSOT and the controller writes NO mirror. */
    cancelled?: boolean;
  }
>;

export type ControlSwitchAttentionReason = NonNullable<
  ControlSwitchStateEvent["payload"]["reason"]
>;

export type ApprovalDetectedEvent = BaseRuntimeEvent<
  "approval:detected",
  {
    taskId: TaskId;
    runId: RunId | null;
    kind: ApprovalKind;
    source: string;
    resurfacedAfterDecision?: boolean;
    previousDecision?: ApprovalDecision | null;
    decisionAgeMs?: number | null;
    fingerprintHash?: string | null;
    choices?: ApprovalChoice[];
    /** How the card's answer reaches the CLI: "reply" = the hook broker (S2,
     *  Claude) — Sonata writes reply-<approvalId>.json; "keys" = the scraped
     *  native panel (Codex + the broker's timeout fallback). Absent ⇒ "keys". */
    answerVia?: "reply" | "keys";
    /** The broker's id — the reply file to write when answerVia === "reply". */
    approvalId?: string | null;
    /** The one-line "what the agent wants to do", derived from the hook's
     *  tool_name/tool_input (e.g. "Run `touch x`"). The card shows THIS instead
     *  of the low-level panel encodings. Absent for scrape cards. */
    summary?: string | null;
    /** The raw subject of the ask — the full command / file path — for the
     *  drawer's code block (drawer S2). Longer than summary (soft 400 cap),
     *  never parsed. Absent for scrape cards and kind-only asks. */
    detail?: string | null;
  }
>;

export type ApprovalDecisionEvent = BaseRuntimeEvent<
  "approval:decision",
  {
    taskId: TaskId;
    runId: RunId | null;
    decision: ApprovalDecision;
    encodedAs: ApprovalDecisionEncoding;
    previousKind: ApprovalKind | null;
    /** The broker ask this decision resolves (reply-channel answers). Absent
     *  on scrape/native decisions — those resolve the RENDERED panel, keyed
     *  by the delivery gate's scrape sentinel (S6 review P1). */
    approvalId?: string | null;
  }
>;

/** A hook-broker approval timed out (S2) — the CLI is falling back to its native
 *  panel, which the scrape will surface next. NOT a decision: nothing was
 *  answered. The hook card clears, but the "user still owes an answer" truth
 *  (cli-state waiting-approval, delivery blocked) is deliberately preserved
 *  until the native panel is answered (reviewer P1/P2). */
export type ApprovalExpiredEvent = BaseRuntimeEvent<
  "approval:expired",
  { taskId: TaskId; approvalId: string }
>;

/** Receipt for a persisted allow: observed (read-after-write diff of the
 *  provider's own settings file), never promised. Not emitted when no
 *  write is observed — honest absence. */
export type ApprovalPersistedEvent = BaseRuntimeEvent<
  "approval:persisted",
  {
    taskId: TaskId;
    runId: RunId | null;
    file: string;
    rulesAdded: string[];
  }
>;

/**
 * Claude's native `AskUserQuestion` (multiple-choice) tool surfaced as an
 * in-view card (Slice 5). `detected` carries the parsed questions (from the
 * PreToolUse hook's `tool_input`); `resolved` carries the verbatim answers
 * (from the PostToolUse hook's `tool_response.answers`) — or null when the
 * prompt was cancelled / the turn ended unanswered. Detection is structured
 * (the hook), not scraped; the floor stays a valid alternative answer surface.
 */
export type OptionPromptDetectedEvent = BaseRuntimeEvent<
  "option-prompt:detected",
  {
    taskId: TaskId;
    toolUseId: string;
    questions: OptionPromptQuestion[];
  }
>;

export type OptionPromptResolvedEvent = BaseRuntimeEvent<
  "option-prompt:resolved",
  {
    taskId: TaskId;
    toolUseId: string;
    answers: OptionPromptAnswers | null;
  }
>;

export type FileWatchingEvent = BaseRuntimeEvent<
  "file:watching",
  {
    taskId: TaskId;
    cwd: string;
    mode: "fs.watch" | "polling";
    reason?: string;
  }
>;

export type FileWatchErrorEvent = BaseRuntimeEvent<
  "file:watch-error",
  {
    taskId: TaskId;
    cwd: string;
    mode: "fs.watch" | "polling";
    error: string;
  }
>;

export type FileChangedEvent = BaseRuntimeEvent<
  "file:changed",
  {
    taskId: TaskId;
    runId: RunId | null;
    path: string;
    absolutePath: string;
    eventType: string;
    changeKind: ChangeKind;
    type: "file" | "directory" | "other" | "missing" | "error";
    size: number | null;
    mtimeMs: number | null;
    sha256: string | null;
  }
>;

/** One entry of a turn-boundary workspace-stat reconcile delta (OBS S6 / D3). */
export interface RuntimeReconcileChange {
  path: string;
  absolutePath: string;
  changeKind: ChangeKind;
  type: "file" | "directory" | "other" | "missing" | "error";
  size: number | null;
  sha256: string | null;
}

/**
 * A bounded workspace-stat delta computed ONCE at run end (OBS S6 / D3): the
 * terminal-host diffs the current workspace against the snapshot it retained at
 * run start and reports the paths that changed during the run. This is the net
 * for Bash-mediated (and any hook-invisible) edits that the semantic-first
 * PostToolUse channel cannot name. The run-index consumes it and appends only
 * the subset NOT already tool-attributed for the run, tagging them
 * `source: "reconcile"`.
 *
 * CONTROLLER-INTERNAL — like `codex-turn-context:observed`, the controller
 * consumes this into the run-index and never forwards it to a renderer window
 * (D5: main never serializes an event a window provably ignores; no renderer
 * surface reads changedFiles).
 */
export type RunReconciledEvent = BaseRuntimeEvent<
  "run:reconciled",
  {
    taskId: TaskId;
    runId: RunId | null;
    changes: RuntimeReconcileChange[];
  }
>;

export type RuntimeReportUpdatedEvent = BaseRuntimeEvent<
  "report:updated",
  {
    taskId: TaskId;
    reportPath: string;
    runCount: number;
    latestRunId: RunId | null;
    rawTerminalPersisted: false;
    rawTerminalPointer: null;
    /** Whether this update touched anything the renderer's report view reads
     *  (OBS S3, D6 renderer half). The Reading window consumes ONLY
     *  `report.runs`; a `file:changed`-only flush mutates the
     *  `changedFiles`/`artifactCandidates`/`unassignedChanges` buckets that no
     *  renderer surface renders. So `false` means "file-change noise only —
     *  the renderer may skip the full-report refetch"; `true` means a
     *  run/approval/lifecycle mutation the renderer must re-read. Additive and
     *  optional: absent (legacy events, incl. the pinned reducer corpus) is
     *  treated as `true` — the pre-S3 always-refetch behavior. */
    runsChanged?: boolean;
  }
>;

export type TranscriptLocatedEvent = BaseRuntimeEvent<
  "transcript:located",
  {
    taskId: TaskId;
    source: TranscriptSourceRef;
  }
>;

export type TranscriptBlocksEvent = BaseRuntimeEvent<
  "transcript:blocks",
  {
    taskId: TaskId;
    sourceId: string;
    upserts: TranscriptBlock[];
    /** True when existing blocks of this source must be dropped before applying. */
    reset: boolean;
  }
>;

export type UsageUpdatedEvent = BaseRuntimeEvent<
  "usage:updated",
  {
    taskId: TaskId;
    snapshot: UsageSnapshot;
  }
>;

/**
 * A codex rollout `turn_context` record was observed (item E — mid-session
 * switch S5). Codex has NO statusline/hook mirror for its model, reasoning
 * effort, or permission axes (the asymmetry the whole codex switch design works
 * around), so a NATIVE switch — the user typing `/model` or `/permissions`
 * directly in the co-visible Terminal, not driven by Sonata — never updates
 * task.model / task.reasoningEffort / task.codexPermissionMode; the mirrors go
 * stale. The rollout writes a per-turn `turn_context` carrying the turn's actual
 * model + effort + approval/sandbox policy, so it is the lazy SSOT: the
 * controller reconciles the three mirrors off it (see runtime-controller
 * `reconcileCodexTurnContext`), backstopping the picker-receipt FAST path with a
 * rollout-driven correction. This also removes the staleness the S4 codex-model
 * switch's effort-preservation depends on (it reads task.reasoningEffort to
 * preserve effort at picker level 2 — a stale mirror would push a stale effort
 * onto the live CLI; a reconciled mirror can't). turn_context lands at turn
 * START (well before the Stop signal), so by the next turn's completion a native
 * switch made in the prior turn is already reflected. CONTROLLER-INTERNAL — the
 * reconcile emits `task:updated`, which the renderer already consumes, so this
 * event is never forwarded to the renderer.
 */
export type CodexTurnContextObservedEvent = BaseRuntimeEvent<
  "codex-turn-context:observed",
  {
    taskId: TaskId;
    /** The turn's model slug (`turn_context.payload.model`, e.g. `gpt-5.6-sol`),
     *  or null when absent. Matches the codex slug task.model already stores. */
    model: string | null;
    /** The turn's reasoning effort (`turn_context.payload.effort`, e.g. `high`) —
     *  a raw string, validated against ReasoningEffort by the controller. */
    effort: string | null;
    /** The turn's approval policy (`turn_context.payload.approval_policy`, e.g.
     *  `on-request` / `never`) — mapped to CodexPermissionMode by the controller
     *  via `migrateCodexPermissionMode` (the same reverse-map manifests use). */
    approvalPolicy: string | null;
    /** The turn's sandbox policy type (`turn_context.payload.sandbox_policy.type`,
     *  e.g. `read-only` / `workspace-write` / `danger-full-access`) — the other
     *  input to `migrateCodexPermissionMode`. */
    sandboxPolicy: string | null;
  }
>;

/**
 * The persisted session index changed (session created, renamed, archived,
 * deleted, or a project overlay edit). Carries no data — listeners re-read
 * the index via session:index:read.
 */
export type SessionsUpdatedEvent = BaseRuntimeEvent<
  "sessions:updated",
  {
    reason:
      | "session-created"
      | "session-updated"
      | "session-renamed"
      | "session-archived"
      | "session-deleted"
      | "project-updated";
  }
>;

export type ProductRuntimeEvent =
  | PtyExitEvent
  | TaskStartedEvent
  | TaskReadyEvent
  | WorkingStatusUpdatedEvent
  | CliHooksLivenessEvent
  | CliStateChangedEvent
  | TaskUpdatedEvent
  | PromptSubmittedEvent
  | DeliveryStateEvent
  | DeliveryReceiptEvent
  | RunStartedEvent
  | RunUpdatedEvent
  | RunStopRequestedEvent
  | RunStoppedEvent
  | ApprovalDetectedEvent
  | ApprovalDecisionEvent
  | ApprovalExpiredEvent
  | ApprovalPersistedEvent
  | OptionPromptDetectedEvent
  | OptionPromptResolvedEvent
  | RemoteControlStateEvent
  | ControlSwitchStateEvent
  | FileWatchingEvent
  | FileWatchErrorEvent
  | FileChangedEvent
  | RunReconciledEvent
  | RuntimeReportUpdatedEvent
  | TranscriptLocatedEvent
  | TranscriptBlocksEvent
  | UsageUpdatedEvent
  | CodexTurnContextObservedEvent
  | CodexUpdatePromptEvent
  | CodexSessionResumableExitEvent
  | SessionsUpdatedEvent;

export type RuntimeEvent = TerminalDataEvent | ProductRuntimeEvent;

export type RunIndexEvent = Exclude<
  ProductRuntimeEvent,
  // `file:changed` LEFT the run-index (OBS S6 / D3): change attribution moved
  // from the filesystem watcher (physical channel) to PostToolUse hooks +
  // turn-boundary reconcile (semantic channel). The watcher still emits
  // `file:changed` for Preview live-refresh (S5 interest routing), but it no
  // longer crosses the consume boundary. `run:reconciled` is the reconcile
  // half — it is NOT excluded (the run-index consumes it).
  | FileChangedEvent
  | RuntimeReportUpdatedEvent
  | TranscriptLocatedEvent
  | TranscriptBlocksEvent
  | UsageUpdatedEvent
  | CodexTurnContextObservedEvent
  | SessionsUpdatedEvent
  | CliStateChangedEvent
  | CliHooksLivenessEvent
  | CodexUpdatePromptEvent
  | CodexSessionResumableExitEvent
  | DeliveryStateEvent
  | DeliveryReceiptEvent
  | TaskUpdatedEvent
  | RemoteControlStateEvent
  | ControlSwitchStateEvent
  | OptionPromptDetectedEvent
  | OptionPromptResolvedEvent
>;
