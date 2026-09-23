import type { NativeStatusRegion, WorkingLiveness } from "./working-status";
import type { CliActivity } from "./cli-signal";
import type { CliSessionStartBlockReason } from "./cli-readiness";
import type {
  ApprovalChoice,
  ApprovalDecision,
  ApprovalDecisionEncoding,
  ApprovalKind,
  ChangeKind,
  CompletionConfidence,
  CompletionHint,
  CompletionSource,
  LaunchSpeedMode,
  PendingWake,
  ReasoningEffort,
  TurnEndWake,
  RunId,
  RunKind,
  RunStatus,
  StopInterruptEncoding,
  TaskId,
  Task,
  TaskSessionState,
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
 *  the terminal host's one-shot boot latch). */
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

/**
 * Codex's boot directory-trust dialog is up and blocking composer readiness
 * (codex-trust S2). The FALLBACK for a case S1 made rare: every codex spawn now
 * pre-trusts its cwd unconditionally, so this dialog paints only when that
 * failed to take — a ledger write that did not land, a damaged profile layer, or
 * a codex release that re-worded the gate. Whatever the cause, the CLI parks on
 * its onboarding screen, the composer never appears, and without this event
 * Reading says nothing at all.
 *
 * Sonata cannot (and must NEVER) auto-answer it — its "Yes, continue" is a
 * consent decision and its other answer QUITS the process, so on a boot
 * watchdog whose SCREEN matches the dialog signature the terminal-host emits
 * this and the renderer raises a passive "answer it in the CLI" banner.
 * Display-only shell chrome (a renderer-local banner store, like
 * cli-hooks:liveness and codex-update-prompt:detected), never a reading-core
 * view field.
 */
export type CodexTrustDialogDetectedEvent = BaseRuntimeEvent<
  "codex-trust-dialog:detected",
  {
    taskId: TaskId;
  }
>;

/**
 * The dialog above left the screen — the human answered it in the CLI, so the
 * banner has nothing left to point at and retires (plan L2).
 *
 * This pair is deliberately one better than its `codex-update-prompt:detected`
 * template, which can only be cleared by `pty:exit`. The difference is the
 * CHANNEL: the trust signature reads the reconstructed screen grid, whose
 * absence is as trustworthy as its presence, so "the dialog is gone" is an
 * observable fact rather than an inference (D-1; see `isCodexTrustDialog`). The
 * emitting test is the exact negation of what raised the banner — the dialog is
 * off the screen, OR the composer is accepting input again — so the two states
 * cannot disagree (see `checkCodexTrustDialogCleared`). Only ever emitted after a
 * `detected` for the same task, and at most once per detection — a banner that
 * was never raised is not "cleared".
 */
export type CodexTrustDialogClearedEvent = BaseRuntimeEvent<
  "codex-trust-dialog:cleared",
  {
    taskId: TaskId;
  }
>;

/**
 * Claude's fullscreen-renderer BOOT offer is on screen and holding composer
 * readiness (SL-18). The claude sibling of `codex-trust-dialog:detected`, and it
 * exists for the same reason: SL-3 taught Sonata to HOLD the boot latch here
 * (`claudeFullscreenOfferOpen` → `isFullscreenOfferOpen()` inside
 * `acceptsPromptInput()`), which is correct and silent — the task reads
 * "starting", a held first message waits, and nothing tells the user the CLI is
 * parked on a question only they can answer.
 *
 * Sonata cannot (and must NEVER) auto-answer it. MEASURED (SL-3 F8, claude
 * 2.1.257): a delivery's paste is DISCARDED at this screen and its submit CR
 * answers the focused `1. Yes, try it`, so the CLI re-execs under a new renderer
 * and the user's prompt is gone with no receipt and no error. The two answers
 * are a choice about the user's own tool; the human answers in the co-visible
 * Terminal and this event is Sonata SAYING so.
 *
 * Display-only shell chrome (a renderer-local banner store, like its three codex
 * siblings), never a reading-core view field.
 */
export type ClaudeFullscreenOfferDetectedEvent = BaseRuntimeEvent<
  "claude-fullscreen-offer:detected",
  {
    taskId: TaskId;
  }
>;

/**
 * The offer above left the screen — the human answered it in the CLI, so the
 * banner has nothing left to point at and retires.
 *
 * ONE leg, where its codex sibling needs two, and the asymmetry is structural
 * rather than an economy. `isCodexTrustDialogOpen()` is ranked BELOW the
 * SessionStart short-circuit inside `acceptsPromptInput()`, so a hook-live codex
 * session can read ready with the answered dialog's cells still on the grid —
 * hence that pair's second, readiness-shaped disjunct. `isFullscreenOfferOpen()`
 * is ranked ABOVE that short-circuit (SL-3, pinned in
 * tests/smoke/claude-boot-interstitial.mjs), so while the offer owns the grid
 * `acceptsPromptInput()` is false BY CONSTRUCTION and a readiness disjunct could
 * never fire before the grid one. The grid's absence is as trustworthy as its
 * presence (D-1), and the test is keyed on that absence rather than on HOW the
 * offer left, so it is indifferent to which row the human took. MEASURED end to
 * end on the decline path (SL-18 F61 / probe q36 at claude 2.1.258): `cleared`
 * landed 146ms after the ANSWERING ENTER reached the pty — the next tick of the
 * 120ms scan the clearing pass rides, not a wait on `pty:exit`.
 *
 * Only ever emitted after a `detected` for the same task, and at most once per
 * detection — a banner that was never raised is not "cleared".
 */
export type ClaudeFullscreenOfferClearedEvent = BaseRuntimeEvent<
  "claude-fullscreen-offer:cleared",
  {
    taskId: TaskId;
  }
>;

/**
 * A session start could not happen, and the readiness probe says WHY (CLI
 * readiness S4; plan D10, L5). Raised for exactly two diagnosable shapes, both
 * observed by the runtime controller and then confirmed by a fresh probe:
 *
 *  - the PTY died before the boot latch ever opened — a missing binary
 *    fails `execvp` inside the pty, so the process is gone in milliseconds;
 *  - the PTY is alive but no prompt appeared within the boot observation window
 *    (L5, 10s against a normal 1–3s boot) — the shape of a CLI parked on its own
 *    first-run/login screen, which nobody in Reading can see.
 *
 * The observation is only the TRIGGER. What makes this event honest is that main
 * re-probes the machine before emitting and reports the probe's reading, so a
 * session that failed for any OTHER reason (a crash, a bad flag, a boot dialog
 * Sonata does not recognize) produces NO event at all and keeps today's
 * behaviour — Sonata does not invent a generic error UI for a failure it cannot
 * name.
 *
 * Display-only shell chrome, like `cli-hooks:liveness` and
 * `codex-update-prompt:detected`: the renderer raises a task-keyed attention
 * banner offering the CLI's own recovery (install / start), and nothing here ever
 * touches credentials or a login flow (D1).
 */
export type CliSessionStartBlockedEvent = BaseRuntimeEvent<
  "cli-session-start:blocked",
  {
    taskId: TaskId;
    /** The task's provider — carried so a consumer reading the event stream can
     *  make sense of it without resolving the task, and so the renderer never has
     *  to infer which CLI the diagnosis is about. */
    provider: RuntimeProvider;
    /** What the re-probe found. Never `unknown`: an unreadable machine emits no
     *  event (see above). */
    reason: CliSessionStartBlockReason;
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
    /** SL-16 — the `turn-ended` qualifier: what this turn ending said about
     *  background work, session history accounted for. Optional on the wire
     *  because recorded event fixtures predate the field, and a missing value
     *  must read as "no claim", never as "nothing in flight". */
    turnEndWake?: TurnEndWake | null;
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

export type SessionStateEvent = BaseRuntimeEvent<"session:state", TaskSessionState>;

/**
 * The user's words that were sent but never written: held by the boot hold when
 * the pty exited (or was replaced) before its CLI reached a prompt, or waiting
 * on a previous write sequence when a Stop dropped them. Handed back to the
 * composer once; nothing is persisted or retried.
 */
export type PromptUnsentEvent = BaseRuntimeEvent<
  "prompt:unsent",
  { taskId: TaskId; text: string; reason: "pty-exit" | "stop" }
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
    /**
     * SL-16 — the run this one CONTINUES: the id of the run whose turn end
     * announced the in-flight background work whose completion woke the session
     * and started this turn. Set only on a revival (a `<task-notification>`
     * prompt arriving while a wake is awaited), so it is the run model agreeing
     * with the "(background task returned)" title the reading surface already
     * shows. Absent on every ordinary run, including one the user types DURING
     * a pause — their prompt is their own turn, not the continuation.
     */
    revivalOf?: RunId | null;
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
    /** SL-16 — "ended, expecting wake": this run's turn-end payload declared
     *  in-flight background work. Only ever set on a settled run, alongside
     *  `status: "completed"` (the turn did end) — see {@link PendingWake} for
     *  why it is a second axis and not a status. */
    pendingWake?: PendingWake;
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
    /** `interrupt` = the stop click's own interrupt key; `interrupt-retry` = the
     *  one-shot Esc resend after post-stop tool activity proved the first Esc
     *  was swallowed (claude-shaped by construction — the resend is armed only
     *  behind an Esc stop). */
    phase: "interrupt" | "interrupt-retry";
    encodedAs: StopInterruptEncoding;
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
     *  on scrape/native decisions — those resolve the RENDERED panel. */
    approvalId?: string | null;
  }
>;

/** A hook-broker approval timed out (S2) — the CLI is falling back to its native
 *  panel, which the scrape will surface next. NOT a decision: nothing was
 *  answered. The hook card clears, but the "user still owes an answer" truth
 *  (cli-state waiting-approval) is deliberately preserved
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
 * effort, or permission axes, so a switch the user makes in the co-visible
 * Terminal (`/model`, `/permissions`) never reaches task.model /
 * task.reasoningEffort / task.codexPermissionMode through any other channel.
 * The rollout writes a per-turn `turn_context` carrying the turn's actual
 * model + effort + approval/sandbox policy, so it is the SSOT for all three:
 * the controller reconciles the mirrors off it (see runtime-controller
 * `reconcileCodexTurnContext`). turn_context lands at turn
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
     *  via `codexPermissionModeFromTurnContext`, which is NOT
     *  `migrateCodexPermissionMode` (that one reverse-maps a legacy MANIFEST and
     *  reads `never` as approve-for-me, which is wrong for a live turn). */
    approvalPolicy: string | null;
    /** The turn's sandbox policy type (`turn_context.payload.sandbox_policy.type`,
     *  e.g. `read-only` / `workspace-write` / `danger-full-access`) — the other
     *  input to `codexPermissionModeFromTurnContext`, and on its own decisive for
     *  `read-only` (no offered mode projects that sandbox). */
    sandboxPolicy: string | null;
    /** The turn's approvals reviewer (`turn_context.payload.approvals_reviewer`,
     *  `user` / `auto_review`) — the third input, and the one that separates
     *  ask-for-approval from approve-for-me on the shared (workspace-write,
     *  on-request) pair (MEASURED 0.152.1 q35 turn 3, 0.156.1 q42). */
    approvalsReviewer: string | null;
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
  | SessionStateEvent
  | PromptUnsentEvent
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
  | CodexTrustDialogDetectedEvent
  | CodexTrustDialogClearedEvent
  | ClaudeFullscreenOfferDetectedEvent
  | ClaudeFullscreenOfferClearedEvent
  | CodexSessionResumableExitEvent
  | CliSessionStartBlockedEvent
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
  | CodexTrustDialogDetectedEvent
  | CodexTrustDialogClearedEvent
  | ClaudeFullscreenOfferDetectedEvent
  | ClaudeFullscreenOfferClearedEvent
  | CodexSessionResumableExitEvent
  | CliSessionStartBlockedEvent
  | SessionStateEvent
  | PromptUnsentEvent
  | TaskUpdatedEvent
  | RemoteControlStateEvent
  | OptionPromptDetectedEvent
  | OptionPromptResolvedEvent
>;
