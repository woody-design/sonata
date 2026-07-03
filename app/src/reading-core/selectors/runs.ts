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
import type { RuntimeReportV1, RuntimeRunReport } from "../../shared/schemas";
import { approvalKindLabel, providerLabel } from "./formatters";

/** The slice of the renderer's TaskViewState these selectors read. The full
 *  state type moves into reading-core at C1; until then selectors type
 *  against the slice (TaskViewState is structurally assignable). */
export interface RunsView {
  task: Task | null;
  /** A PTY runtime backs this view; dormant views are read-only until resumed. */
  live: boolean;
  report: RuntimeReportV1 | null;
  remoteControl: { active: boolean; url: string | null; armedOverride: boolean | null };
}

export function isActiveRunStatus(status: string): boolean {
  return ["active", "waiting-for-approval", "resumed-after-approval", "stopping"].includes(status);
}

export function hasActiveRun(view: RunsView | null): boolean {
  const latestRun = view?.report?.runs.at(-1);
  return isActiveRunStatus(latestRun?.status ?? "");
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
  // (delivering/queued) outranks the stale report; the report shows only
  // when nothing fresher is happening.
  if (deliveryState.queue.some((item) => item.status === "delivering")) {
    return `Delivering to ${providerName}`;
  }
  if (deliveryState.queue.some((item) => item.status === "queued")) {
    return "Queued";
  }
  if (deliveryState.queue.some((item) => item.status === "undelivered")) {
    return "Undelivered";
  }
  if (deliveryState.approvalActive) {
    return `Waiting for ${providerName} approval`;
  }
  if (deliveryState.activeRun) {
    return `${providerName} is working`;
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
  view: RunsView | null,
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
export function dormantArmed(view: RunsView, remoteControlDefault: boolean): boolean {
  return view.remoteControl.armedOverride ?? remoteControlDefault;
}

/** Is RC on/armed in the current context (drives the button's active fill)?
 *  inject → live `active`; arm-dormant → effective armed (override ?? default);
 *  arm-draft → the New Chat draft flag. */
export function remoteControlOn(
  ctx: RemoteControlContext,
  view: RunsView | null,
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
