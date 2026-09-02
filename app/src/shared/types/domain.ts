export type TaskId = string;
export type RunId = string;
export type DeliveryItemId = string;
export type RuntimeSessionId = string;
export type ProviderSessionRef = string;
export type ApprovalId = string;

export type RuntimeProvider = "codex" | "claude";
export type TaskTitleOrigin = "automatic" | "user";
export type ReasoningEffort = "low" | "medium" | "high" | "xhigh" | "max" | "ultra";
/** The `ReasoningEffort` union as a runtime tuple + membership guard, so the
 *  settings-store normalize layer can validate a persisted effort by union
 *  membership WITHOUT importing reading-core's per-model gating (layer fence):
 *  the shared layer knows only "is this one of the six tiers", the UI clamps
 *  which of them a given model can accept. `satisfies` keeps the tuple coupled
 *  to the union — a stray value here is a compile error. */
export const REASONING_EFFORTS = [
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
  "ultra",
] as const satisfies readonly ReasoningEffort[];
// Compile-time exhaustiveness. `satisfies` above rejects a STRAY tuple member;
// this rejects a MISSING one. A future union tier absent from the tuple would
// make isReasoningEffort silently reject a legitimately-persisted value (data
// loss via the normalize fallback), so the omission must fail to compile: when
// the tuple covers the union this Exclude is `never`; otherwise it is the
// missing member, which violates the `extends never` constraint.
type _AssertExhaustive<T extends never> = T;
type _ReasoningEffortsCoverUnion = _AssertExhaustive<
  Exclude<ReasoningEffort, (typeof REASONING_EFFORTS)[number]>
>;
export function isReasoningEffort(value: unknown): value is ReasoningEffort {
  return (REASONING_EFFORTS as readonly string[]).includes(value as string);
}
export type LaunchSpeedMode = "default" | "fast";
export type CodexSandboxMode = "read-only" | "workspace-write" | "danger-full-access";
export type CodexApprovalMode = "untrusted" | "on-request" | "on-failure" | "never";
/**
 * The user-facing Codex permission vocabulary — Codex 0.144's own
 * `/permissions` picker ("Update Model Permissions"). One value above the
 * spawn seam; terminal-host is the ONLY place it fans back out to the legacy
 * (sandbox × approval × reviewer) axes. `CodexSandboxMode`/`CodexApprovalMode`
 * survive solely for that mapping and for migrating legacy persisted records.
 */
export type CodexPermissionMode = "ask-for-approval" | "approve-for-me" | "full-access";
export type ClaudePermissionMode =
  | "acceptEdits"
  | "auto"
  | "bypassPermissions"
  | "default"
  | "dontAsk"
  | "plan";

export type TaskStatus =
  | "new"
  | "starting"
  | "running"
  | "waiting-for-approval"
  | "stopping"
  | "stopped"
  | "failed"
  | "idle";

export interface Task {
  id: TaskId;
  title: string;
  /**
   * Ownership of the canonical title. Absent on legacy manifests: legacy
   * auto-title eligibility keeps its pre-dated, process-local behavior and is
   * never upgraded merely by reading/resuming the task.
   */
  titleOrigin?: TaskTitleOrigin;
  provider: RuntimeProvider;
  model: string | null;
  reasoningEffort: ReasoningEffort | null;
  speedMode: LaunchSpeedMode | null;
  /**
   * Codex's launch permission preset (Codex 0.144's `/permissions` picker).
   * Null on Claude tasks. Legacy manifests carried `sandbox` + `approval`
   * instead; those are migrated on read (see `migrateCodexPermissionMode`) and
   * never written back — new writes carry only this field.
   */
  codexPermissionMode: CodexPermissionMode | null;
  permissionMode: ClaudePermissionMode | null;
  runtimeSessionId: RuntimeSessionId;
  providerSessionRef: ProviderSessionRef | null;
  providerCwd: string;
  workingDirectory: string;
  status: TaskStatus;
  /** Session is hidden from the default sidebar list. Absent on old manifests. */
  archived?: boolean;
  /** Applied tag definition ids. Absent on old manifests means no tags. */
  tags?: string[];
  /**
   * True when Sonata generated the working directory itself — a project-less
   * "chat" — rather than the user choosing a folder. Set explicitly at creation
   * and read for sidebar grouping (chat vs project) and deletion policy. Replaces
   * the old "is providerCwd inside the central storage root?" inference, which D7
   * dissolved by moving the auto-workspace cwd to a visible ~/Documents/Sonata/<slug>.
   * Absent on pre-D7 manifests → treat as false (a chosen project).
   */
  autoWorkspace?: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface RuntimeSession {
  id: RuntimeSessionId;
  taskId: TaskId;
  provider: RuntimeProvider;
  providerSessionRef: ProviderSessionRef | null;
  providerCwd: string;
  livePtyProcess: PtyProcessState | null;
  createdAt: string;
  updatedAt: string;
}

export interface PtyProcessState {
  pid: number;
  command: string;
  args: string[];
  cwd: string;
  startedAt: string;
  cols: number;
  rows: number;
}

export type RunKind = "prompt" | "slash";

export type RunStatus =
  | "active"
  | "waiting-for-approval"
  | "resumed-after-approval"
  | "stopping"
  | "stopped"
  | "approval-denied"
  | "pty-exited"
  | "completed"
  | "failed";

export type CompletionSource =
  | "manual-control"
  | "native-control"
  | "pty-exit"
  | "hook-stop"
  /**
   * The turn ended because it was INTERRUPTED — codex's `Interrupt` hook, which
   * replaces `Stop` for that turn (MEASURED at 0.152.1: the hook lands ~130ms
   * after the key and no `Stop` ever follows). Distinct from `hook-stop`, and the
   * distinction is load-bearing rather than descriptive: `hook-stop` carries the
   * invariant "a live holding hook blocks the turn, so a hook-driven completion
   * cannot coexist with a pending broker ask", which is TRUE for `Stop` and FALSE
   * here — an interrupt KILLS the holding PermissionRequest hook, orphaning its
   * ask (SL-9 B1, probe h3 `d4-interrupt-under-hold`). Consumers that release
   * PENDING work at a turn end must therefore treat this as a pending turn end
   * (`RuntimeController.isPendingTurnEnd`), not as a Stop.
   */
  | "hook-interrupt"
  | "terminal-idle-heuristic"
  | "unknown";

export type CompletionConfidence = "high" | "medium" | "low";

export interface CompletionHint {
  source?: CompletionSource;
  confidence?: CompletionConfidence;
  signals?: Record<string, boolean>;
  errorExcerpt?: string;
  [key: string]: unknown;
}

/**
 * "Ended, expecting wake" — in-flight background work a turn-end payload
 * announced, which will wake the session again with no user input (SL-16,
 * upstream sync 2026-09; claude 2.1.258, findings F42/F47).
 *
 * A SECOND AXIS beside `RunStatus`, deliberately not a member of it. The turn
 * genuinely ENDED — the model stopped, the composer came back, the user can
 * type — so `completed` is the honest status and `hook-stop`/`high` the honest
 * evidence. What was NOT honest was leaving that the whole story: the same
 * `Stop` payload says a shell is still running and will re-enter the session.
 * Widening `RunStatus` was considered and rejected: it is consumed by seven
 * if-chains with silent defaults (task-status mapping, the broker-release
 * predicate, the working-status terminal set, two completion-metadata mappers,
 * tone and outcome copy) and none of them would want a different answer than
 * `completed` already gives.
 *
 * Present only on a run whose turn-end payload named background work that was
 * NOT already in flight at the previous turn end. Absent means "nothing new was
 * said" — which covers nothing in flight, only-pre-existing work, an ending that
 * carried no such field at all (a codex turn, a Stop-less close), and reports
 * written before SL-16. Additive and optional; absent is never a claim.
 */
export interface PendingWakeTask {
  /** The CLI's own task id (MEASURED: `b8ylzf16p`). Load-bearing, not
   *  decorative: `background_tasks` is SESSION state, so identity is the only
   *  way to tell work THIS turn left behind from work that was already running
   *  before it — see `BackgroundWorkTracker`. `""` when a payload names none,
   *  which fails toward "not new" (a notification too many, never one too few). */
  id: string;
  /** The vendor's own kind label — `shell`, `subagent`, `workflow`, `monitor`,
   *  `MCP task`, `teammate`, `dream`, `auto-mode scan`, `cloud session` (the
   *  2.1.258 type map, STATIC). Recorded verbatim rather than normalized: this
   *  is the durable diagnostic answer to "waiting on WHAT", and an unrecognised
   *  future kind must survive into the record rather than be flattened away. */
  kind: string;
}

export interface PendingWake {
  /** The in-flight background tasks THIS turn end newly announced. Never empty.
   *
   *  Not "everything in flight": the CLI's array is session-scoped and a
   *  long-lived task (a dev server, a watcher, a `tail -f`) stays in it for the
   *  rest of the session, so a turn end is only "expecting wake" for work it
   *  actually left behind. */
  tasks: PendingWakeTask[];
}

/**
 * What ONE main-turn ending said about background work, after the session's own
 * history is taken into account (SL-16). Produced by `BackgroundWorkTracker`,
 * which owns that history; carried on the live cli-state so the notification
 * policy can read both halves at the moment the turn ends.
 */
export interface TurnEndWake {
  /**
   * Work this turn end left behind that was NOT already in flight at the
   * previous turn end — the pause, and the only thing that may hold a
   * notification or stamp a card. Null when this turn named nothing new.
   */
  opened: PendingWake | null;
  /**
   * True when work named at an EARLIER turn end is no longer in flight: some
   * awaited background job came back. This is what tells "the wake I was holding
   * for has landed" apart from "an ordinary turn ended while a dev server
   * happens to still be running" — two situations that are otherwise identical
   * on the wire, and which need different notification clocks.
   */
  returned: boolean;
}

export type DeliveryItemStatus =
  | "queued"
  | "delivering"
  | "delivered"
  | "delivered-partial"
  | "undelivered";
export type DeliveryReceiptSource =
  | "provider-transcript"
  | "pty-composer-echo"
  // A mid-turn write-through send: the bytes were written and the CLI native-
  // queued it (P2/P6) → sent. Its transcript block arrives only at dequeue, so
  // this is the receipt at hand-off time (no 45s undelivered timer).
  | "native-queue"
  // A verbatim slash command submitted on an idle composer: a LOCAL command
  // never yields a transcript user-block (and the echo path is off once the
  // transcript is live), so the transcript receipt is structurally
  // unreachable — its 45s timeout marked the item undelivered, and an
  // undelivered head blocks the queue forever (the S4 /config wedge,
  // s4-diags). Sent-is-sent: the bytes are in the PTY and the command's
  // panel/output is visible in the co-present terminal.
  | "slash-write";

/** Who owns the bytes. `blob` = Sonata copied them into the per-task attachments
 *  dir (deleted with the chip/session). `referenced` = the user's own path, never
 *  copied and NEVER deleted by Sonata. */
export type AttachmentProvenance = "blob" | "referenced";

/** Decides the delivery channel and the chip's visual. `image` chips natively as
 *  [Image #N]; `file`/`folder` are delivered as a path mention in the prompt text. */
export type AttachmentKind = "image" | "file" | "folder";

export interface DeliveryAttachment {
  id: string;
  path: string;
  originalName: string;
  mediaType: string;
  size: number;
  provenance: AttachmentProvenance;
  kind: AttachmentKind;
}

/** A referenced path plus a chip preview. previewDataUrl is a capped thumbnail
 *  data URL for an image reference; null for files/folders or oversize images
 *  (the chip falls back to a kind icon). Kept off DeliveryAttachment so the wire
 *  type never carries preview bytes. */
export interface ReferenceResult {
  attachment: DeliveryAttachment;
  previewDataUrl: string | null;
}

export interface DeliveryReceipt {
  source: DeliveryReceiptSource;
  receivedAt: string;
  runId: RunId | null;
  sourceId: string | null;
  blockId: string | null;
  backfilled: boolean;
  /** Present for transcript receipts of attachment-bearing prompts. Actual
   *  provider payloads only; literal [Image #N] text is not counted. */
  expectedImages?: number;
  receivedImages?: number;
}

export interface DeliveryQueueItem {
  id: DeliveryItemId;
  taskId: TaskId;
  text: string;
  attachments: DeliveryAttachment[];
  status: DeliveryItemStatus;
  enqueuedAt: string;
  deliveringAt: string | null;
  runId: RunId | null;
  receipt: DeliveryReceipt | null;
  failureReason: string | null;
}

export interface DeliveryTaskState {
  taskId: TaskId;
  provider: RuntimeProvider;
  deliverable: boolean;
  activeRun: boolean;
  /** WHICH run is active — read from the same host in the same breath as the
   *  boolean above, so the two can never disagree. The boolean alone cannot tell
   *  "still the run I asked to stop" from "the next one", and the renderer's
   *  single-flight stop (S2 D2) needs exactly that distinction: delivery state is
   *  emitted on change while the run report rides a 1000ms trailing debounce, so
   *  for up to a second at each end of a turn this is the ONLY evidence naming
   *  the live run. Optional: recorded event fixtures predate the field, and a
   *  missing value must read as "a run, name unknown". */
  activeRunId?: RunId | null;
  approvalActive: boolean;
  /** One-shot boot readiness: false only until the CLI first accepts input.
   *  Display copy keys "Starting <provider>" on this — never on a continuous
   *  composer-ready scrape (retired, S6). */
  bootLatched: boolean;
  /** Claude's Rewind restore picker owns the screen, so delivery is held (its
   *  Enter is a RESTORE). Optional: recorded event fixtures predate the field,
   *  and a missing value must read as "not open". */
  rewindPanelOpen?: boolean;
  /** Sticky until the next enqueue so a partial provider receipt remains visible
   *  after the live queue item is removed. */
  attachmentNotice?: string | null;
  queue: DeliveryQueueItem[];
}

export interface CompletionEvidence {
  source: CompletionSource;
  confidence: CompletionConfidence;
  hint?: unknown;
}

export interface Run {
  id: RunId;
  taskId: TaskId;
  kind: RunKind;
  prompt: string;
  title: string;
  status: RunStatus;
  startedAt: string;
  endedAt: string | null;
  elapsedMs: number | null;
  completion: CompletionEvidence | null;
  approvalIds: ApprovalId[];
  changedFilePaths: string[];
  rawTerminalPointer: null;
}

export type ApprovalKind =
  | "workspace-trust"
  | "file-read"
  | "file-edit"
  | "command"
  // The native "Bypass Permissions mode" warning interstitial — a mode
  // acceptance, not a tool approval. Its safe default is "No, exit"; Sonata
  // mirrors that (deny is the primary action, accept is a deliberate opt-in).
  | "dangerous-bypass"
  | "unknown";
export type ApprovalRisk = "file-read" | "file-write" | "network" | "mixed" | "unknown";
/** "answered-natively": the human resolved the screen with their own keys
 *  (take-over) — observed from screen evidence, not sent by Sonata.
 *  "approve-always": the panel's native persistent option ("don't ask
 *  again…") — Claude writes its own allow rule; Sonata receipts the write. */
export type ApprovalDecision =
  | "approve"
  | "approve-for-session"
  | "approve-always"
  | "deny"
  | "answered-natively";
export type ApprovalDecisionEncoding =
  | "CSI-u Enter"
  | "ArrowDown + CSI-u Enter"
  | "digit 1"
  | "digit 2"
  | "digit 3"
  | "CR"
  /** The workspace-trust screen at claude ≥2.1.252: its affirm row is neither
   *  the default nor digit-addressable, so the only channel is arrow-to-that-row
   *  + CR — and the CR is written ONLY after the grid shows the affirm row holds
   *  the cursor. A blind key on this screen exits the CLI (measured: both `\r`
   *  and CSI-u Enter exit 1 from the default row). */
  | "grid-verified Arrow + CR"
  | "Esc"
  /** The codex stop's interrupt key at 0.152.x, landing on a native approval
   *  panel. MEASURED (q31 s8, a real command-approval panel): the press printed
   *  `✗ You canceled the request to run …` alongside `■ Conversation
   *  interrupted` — a genuine deny, so it belongs in this vocabulary rather than
   *  being recorded as the Esc it is not. */
  | "Ctrl+C"
  | "native-keys"
  /** Hook-broker reply (S2): the decision went back on the hook channel —
   *  no bytes ever touched the PTY. */
  | "reply-file";

/**
 * The key a stop actually wrote to the PTY. NOT cosmetic: it is recorded in the
 * durable run report and rendered in the run outcome, so it has to name the byte
 * that was sent rather than the byte this path used to send. Claude's stop is
 * Esc; codex's is Ctrl+C while a turn is live and Esc otherwise — the interrupt
 * key moved at codex 0.152.x and Ctrl+C is quit-capable at an idle composer, so
 * the key is chosen per stop (`TerminalHost.stopInterruptKey`).
 *
 * A SUBSET of `ApprovalDecisionEncoding` by construction: a stop key that lands
 * on a native approval panel denies it, and the same value then travels on the
 * `approval:decision` event.
 */
export type StopInterruptEncoding = Extract<ApprovalDecisionEncoding, "Esc" | "Ctrl+C">;

export interface ApprovalChoice {
  decision: ApprovalDecision;
  label: string;
  description: string;
  encodedAs: ApprovalDecisionEncoding;
}

export interface ApprovalState {
  id: ApprovalId;
  taskId: TaskId;
  runId: RunId | null;
  kind: ApprovalKind;
  risk: ApprovalRisk;
  source: "native-pty-approval-screen";
  detectedAt: string;
  decidedAt: string | null;
  decision: ApprovalDecision | null;
}

export type ChangeKind = "added" | "modified" | "deleted";

export interface ChangedFile {
  path: string;
  changeKind: ChangeKind;
  eventType: string;
  type: "file" | "directory" | "other" | "missing" | "error";
  size: number | null;
  sha256: string | null;
  updatedAt: string;
}
