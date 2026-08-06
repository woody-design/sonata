/**
 * Run/task-state selectors for the Reading window: run-status predicates, the
 * settled-run outcome/tone labels, the task/delivery status labels, and the
 * Remote Control context family.
 *
 * reading-core layer rules: plain data in, plain data out — no DOM, no
 * Electron, no renderer state. Selectors that read the active view or global
 * defaults take them as parameters (the shell passes `activeTaskView()` /
 * `state.*`).
 */
import type { DeliveryTaskState, RuntimeProvider, Task } from "../../shared/types";
import type { RuntimeRunReport } from "../../shared/schemas";
import type { TaskViewState } from "../state";
import { approvalKindLabel, providerLabel } from "./formatters";
import { stripRunningAgents } from "./turns";

export function isActiveRunStatus(status: string): boolean {
  return ["active", "waiting-for-approval", "resumed-after-approval", "stopping"].includes(status);
}

export function hasActiveRun(view: TaskViewState | null): boolean {
  const latestRun = view?.report?.runs.at(-1);
  return isActiveRunStatus(latestRun?.status ?? "");
}

/**
 * The IDENTITY of the run this view is acting on right now — what a stop would
 * target — or null when nothing is running.
 *
 * Two evidences, because the run report and the delivery controller learn about
 * a turn at slightly different moments: the latest report entry while its status
 * is active, and the delivery controller's own `activeRun` bit. Their union is
 * what the composer has always read for "is it working?" (it was written inline
 * in the painter until S2); naming it here as an identity rather than a boolean
 * is what lets the stop path be idempotent PER RUN (S2 D2) — a second stop
 * request for the run already being stopped is a no-op, while one aimed at the
 * next run is not. Bound to the run, so it needs no timer to expire.
 *
 * The `run:` prefix keeps a runId that happens to read like the sentinel from
 * colliding with it. One sentinel is enough: a task has at most one live run.
 */
export function activeRunKey(view: TaskViewState | null): string | null {
  const latestRun = view?.report?.runs.at(-1);
  if (latestRun && isActiveRunStatus(latestRun.status)) {
    return `run:${latestRun.runId}`;
  }
  return view?.deliveryState?.activeRun ? "delivery" : null;
}

/**
 * The draft to refill into the Sonata composer when the user stops the active
 * run (stop S2): stopping is usually "I said it wrong" — hand the words back
 * for editing instead of forcing a retype. The run report's prompt is the
 * source of truth (it carries the REAL turn text even for prompts typed in
 * the Terminal or delivered mid-turn, via the UserPromptSubmit hook), and the
 * refill must never clobber anything the user has typed since — an occupied
 * composer wins unconditionally. Deliberately NOT select-all: the user
 * decides what to keep (Woody, 2026-07-17). Returns null when there is
 * nothing to refill.
 */
export function stoppedRunRefillDraft(
  view: TaskViewState | null,
  composerValue: string,
): string | null {
  if (composerValue.trim()) {
    return null;
  }
  const latestRun = view?.report?.runs.at(-1);
  if (!latestRun || !isActiveRunStatus(latestRun.status)) {
    return null;
  }
  const prompt = latestRun.prompt ?? "";
  if (!prompt.trim() || isSyntheticRunPrompt(prompt)) {
    return null;
  }
  return prompt;
}

/** Run prompts the user never typed and must not be handed back as a draft
 *  (S2 review F3): background task-notification runs keep their raw
 *  envelope XML as the prompt; attachment-only sends carry the
 *  "[Image attachment]" placeholder; a hook-begun run with a swallowed echo
 *  falls back to "(prompt)". */
function isSyntheticRunPrompt(prompt: string): boolean {
  const trimmed = prompt.trim();
  return (
    trimmed.startsWith("<task-notification") ||
    trimmed === "(prompt)" ||
    /^\[(?:\d+ )?image attachments?\]$/i.test(trimmed)
  );
}

export type TurnActivity = "working" | "background" | "idle";

/**
 * The single turn-state derivation shared by the status strip and the sidebar
 * spinner (Turn-Signal Authority S1b, contract §3). Three explicit states read
 * through ONE path, so the two surfaces can never again disagree on "is the
 * turn over" (the pre-S1b divergence: two machines, two answers):
 *
 *  - "working" — the main turn is live: the latest run sits in the active
 *    family, OR the hook-driven `cliState` says the CLI is busy / parked on an
 *    approval. The cliState leg is the incident guard (claude 2.1.211 premature
 *    idle): a run-report lie ("completed" while hooks stay busy) can no longer
 *    hide the signal. Failure direction is deliberate — prefer a "still
 *    working" over-report (the liveness machinery exposes a real stall honestly
 *    at 20s/60s) over a "done" lie, which actively misleads.
 *  - "background" — the main turn is over, but subagents launched during it are
 *    still running. Async agents outlive their launch turn and no CLI emits an
 *    "all background work done" edge (Stop == "main turn done" only —
 *    anthropics/claude-code #45781), so the running-roster IS the only signal.
 *  - "idle" — nothing live. A null / task-less view is idle.
 *
 * `waiting-approval` counts as "working" here; a surface that wants to draw
 * approval distinctly (e.g. the sidebar's attention dot) must branch on it
 * BEFORE consulting this selector — this derivation only answers "is the turn
 * still going", not "how should approval look".
 */
export function turnActivity(view: TaskViewState | null): TurnActivity {
  if (!view?.task) {
    return "idle";
  }
  const activity = view.cliState?.activity;
  if (hasActiveRun(view) || activity === "busy" || activity === "waiting-approval") {
    return "working";
  }
  if (stripRunningAgents(view).length > 0) {
    return "background";
  }
  return "idle";
}

export function runOutcome(run: RuntimeRunReport, providerName: string): string {
  if (run.status === "waiting-for-approval") {
    return `Waiting for ${approvalKindLabel(run.approvalKind)} approval`;
  }
  if (run.status === "resumed-after-approval") {
    return `Resumed after ${approvalKindLabel(run.approvalKind)} approval`;
  }
  if (run.status === "stopped") {
    return run.stopEvents.some((event) => event.action === "stopped" && event.slashStopSent)
      ? "Stopped by Esc + /stop"
      : "Stopped by Esc";
  }
  if (run.status === "approval-denied") {
    return `${approvalKindLabel(run.approvalKind)} approval denied`;
  }
  if (run.status === "completed" && run.completionSource === "terminal-idle-heuristic") {
    return "Completed by terminal idle heuristic";
  }
  if (run.status === "completed") {
    return "Completed";
  }
  if (run.status === "pty-exited") {
    return "PTY exited";
  }
  if (run.status === "failed") {
    return "Failed";
  }
  return `${providerName} is working`;
}

export function completionErrorExcerpt(run: RuntimeRunReport | null): string | null {
  const hint = run?.completionHint;
  if (!hint || typeof hint !== "object" || Array.isArray(hint)) {
    return null;
  }
  const excerpt = hint.errorExcerpt;
  return typeof excerpt === "string" && excerpt.trim() ? excerpt.trim() : null;
}

export function runTone(run: RuntimeRunReport): string {
  if (run.status === "stopped" || run.status === "approval-denied" || run.status === "failed") {
    return "attention";
  }
  if (run.status === "completed") {
    return "complete";
  }
  if (run.status === "waiting-for-approval") {
    return "waiting";
  }
  return "active";
}

export function taskStatusLabel(task: Task): string {
  const providerName = providerLabel(task.provider);
  if (task.status === "running") {
    return `${providerName} is working`;
  }
  if (task.status === "waiting-for-approval") {
    return "Waiting for approval";
  }
  if (task.status === "stopping") {
    return "Stopping";
  }
  if (task.status === "stopped") {
    return "Stopped";
  }
  if (task.status === "failed") {
    return "Failed";
  }
  if (task.status === "starting" || task.status === "new") {
    return `${providerName} is starting`;
  }
  return "Ready";
}

// The persistent delivery-queue PANEL was removed (S1c-followup): with
// send-is-send write-through, a queued message goes straight into the CLI's
// native queue (shown in the co-visible terminal). The orphaned item-list
// renderer + its Edit/Cancel/Retry actions (and their IPC backend) were swept
// in S6 — an unreceipted item no longer blocks the queue, so the retry
// affordance had nothing left to unblock (git log -S renderDeliveryItem).
// The composer status line below is the sole delivery surface.
export function deliveryStatusLabel(deliveryState: DeliveryTaskState): string {
  const providerName = providerLabel(deliveryState.provider);
  // Whole-queue derivation (S6): an undelivered item no longer blocks the
  // queue, so it may sit at the head while later items flow — live activity
  // (delivering/queued) outranks it.
  //
  // The "Undelivered" report itself was retired from this line (2026-07-04,
  // overturning the S6 report-not-gate residue): "undelivered" means "no
  // receipt observed in the transcript scrape" — an epistemic artifact, not
  // a failure. With send-is-send the bytes are in the CLI (the co-visible
  // terminal is the truth surface), there is no user action to offer, and an
  // undelivered item is never evicted from the queue, so one missed receipt
  // wore a permanent "Undelivered" badge on an otherwise healthy idle
  // session. Genuine breakage still surfaces: a dead PTY flips the task to
  // "Failed", and a write failure keeps its failureReason in delivery state.
  if (deliveryState.queue.some((item) => item.status === "delivering")) {
    return `Delivering to ${providerName}`;
  }
  // Ranked above "Queued" (and above the idle "Ready") because it is the REASON
  // the queue is not moving: a recognized Rewind panel holds delivery, so
  // "Queued" alone would be an unexplained stall — the invisible-hold failure S3
  // decision A warns about, and the price of exempting this panel from it. Below
  // "Delivering" only because that state means bytes are already in flight.
  // Sonata never dismisses the panel; the copy names the key the user presses, and
  // "CLI" is the product vocabulary for that surface (see the drawer's "Answer
  // in CLI →") — the ui-vocabulary-corpus fence rejects "terminal" here.
  if (deliveryState.rewindPanelOpen) {
    return "Rewind panel open — press Esc in the CLI";
  }
  if (deliveryState.queue.some((item) => item.status === "queued")) {
    return "Queued";
  }
  if (deliveryState.approvalActive) {
    return `Waiting for ${providerName} approval`;
  }
  if (deliveryState.activeRun) {
    return `${providerName} is working`;
  }
  // The sticky partial-attachment notice ("3 of 6 images attached", S5) ranks
  // BELOW live run status but ABOVE the idle "Ready" (S6 item 5). It is a
  // now-sticky ACTIONABLE reminder — some images never arrived — so it must not
  // be dropped at idle; but it must also not mask a real run: after a partial
  // delivery, a text-only follow-up used to leave the notice masking
  // "working"/"Ready" indefinitely (it outranked activeRun pre-S6). Placed here,
  // an active run shows "working", and once idle the reminder resurfaces until
  // the next full attachment delivery clears it (delivery-controller). Failure
  // direction: prefer over-reminding to silently losing the fact that images
  // 4-6 were dropped.
  if (deliveryState.attachmentNotice) {
    return deliveryState.attachmentNotice;
  }
  // bootLatched is the honest "still starting?" bit: one-shot, opened by the
  // delivery pump's structural poll. The old key (idleComposer — a continuous
  // composer-ready scrape gated on the starved task-ready flag) read
  // permanently false in the full app, so an idle session could wedge on
  // "Starting <provider>" (the S5 residual label class; probe s6-diags).
  if (deliveryState.bootLatched) {
    return "Ready";
  }
  return `Starting ${providerName}`;
}

export type RemoteControlContext =
  | { mode: "inject" } // a live Claude session — inject `/rc` (works mid-turn)
  | { mode: "arm-draft" } // New Chat with a Claude draft — arm the spawn flag
  | { mode: "arm-dormant" } // a dormant Claude session — arm the resume spawn flag
  | { mode: "unavailable" }; // Codex, or nothing to control

/** What the RC button acts on right now. Claude-only (Codex is out of scope);
 *  when there's no live PTY (New Chat OR a dormant session) it ARMS the
 *  `--remote-control` spawn flag instead of injecting. */
export function remoteControlContext(
  view: TaskViewState | null,
  draftProvider: RuntimeProvider,
): RemoteControlContext {
  if (view?.task) {
    if (view.task.provider !== "claude") {
      return { mode: "unavailable" };
    }
    return view.live ? { mode: "inject" } : { mode: "arm-dormant" };
  }
  return draftProvider === "claude" ? { mode: "arm-draft" } : { mode: "unavailable" };
}

/** A dormant Claude view's effective armed state: the user's explicit override if
 *  set, else the live global default — so toggling the default applies to
 *  ALREADY-OPEN dormant sessions, not only to ones opened afterward. */
export function dormantArmed(view: TaskViewState, remoteControlDefault: boolean): boolean {
  return view.remoteControl.armedOverride ?? remoteControlDefault;
}

/** Is RC on/armed in the current context (drives the button's active fill)?
 *  inject → live `active`; arm-dormant → effective armed (override ?? default);
 *  arm-draft → the New Chat draft flag. */
export function remoteControlOn(
  ctx: RemoteControlContext,
  view: TaskViewState | null,
  draftRemoteControl: boolean,
  remoteControlDefault: boolean,
): boolean {
  if (ctx.mode === "arm-draft") {
    return draftRemoteControl;
  }
  if (ctx.mode === "inject") {
    return Boolean(view?.remoteControl.active);
  }
  if (ctx.mode === "arm-dormant") {
    return view ? dormantArmed(view, remoteControlDefault) : false;
  }
  return false;
}
