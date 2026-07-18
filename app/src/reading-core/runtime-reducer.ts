/**
 * The Reading window's runtime-event reducer (map §1.3 — the render-path
 * policy). Every mutation the shell's onRuntimeEvent handler performed is
 * lifted here VERBATIM; the render-path CHOICES those handlers made by
 * calling render functions directly are returned instead as an ordered
 * `Directive` list, which the shell performs 1:1 (see directives.ts).
 *
 * reading-core layer rules: plain data in, plain data out — no DOM, no
 * Electron. Mutation-in-place is deliberate (map R1 — the reconcile engine
 * depends on reference-identity semantics). Time is injected (`nowMs`
 * default param, map §2.4) so replay fixtures are deterministic.
 */
import type { RuntimeEvent } from "../shared/types/events";
import { adoptAutomaticSessionTitle } from "../shared/session-title";
import type { Directive } from "./directives";
import type { RendererState, TaskViewState } from "./state";
import {
  appendLiveTranscript,
  applyTranscriptUpserts,
  ensureRunTranscript,
  taskViewForId,
} from "./state";
import { deliveryStatusLabel, isActiveRunStatus, taskStatusLabel } from "./selectors/runs";
import { providerLabel } from "./selectors/formatters";
import {
  optionPromptQuestionMeta,
  reconcileReceiptLines,
  sessionModelSummaryLabel,
} from "./selectors/composer";

function isActiveView(state: RendererState, view: TaskViewState): boolean {
  return Boolean(view.task && view.task.id === state.activeTaskId);
}

/** markViewChanged, reducer-side (map C2: the isActiveView branch becomes
 *  full | unread-only): the active view repaints fully; a background view
 *  records unread — a state mutation, so it happens HERE, not in the shell.
 *  (The shell keeps its own markViewChanged for the non-event mutate→render
 *  sites until later packets migrate them.) */
function viewChangedDirective(
  state: RendererState,
  view: TaskViewState,
  taskId: string,
): Directive {
  if (isActiveView(state, view)) {
    return { kind: "full", taskId };
  }
  view.unread = true;
  return { kind: "unread-only", taskId };
}

/** Ruled into the reducer at the C1 review (called only from the run:started
 *  branch); clock-injected per map §2.4 "title auto-adopt". */
function updateTaskTitleFromRun(view: TaskViewState, title: string, nowMs: number): void {
  if (!view.task) {
    return;
  }
  const adoption = adoptAutomaticSessionTitle(view.task, title, "first-prompt");
  if (!adoption) {
    return;
  }
  view.task = {
    ...view.task,
    ...adoption,
    updatedAt: new Date(nowMs).toISOString(),
  };
}

/**
 * Reduce one runtime event into state mutations + the ordered directive list.
 * An EMPTY result means the event was dropped: task views are created by IPC
 * responses, not events, so an event for an unloaded taskId has nowhere to
 * land (the corpus-seeding gotcha). A `none` directive means the event was
 * handled with deliberately no paint.
 */
export function reduceRuntimeEvent(
  state: RendererState,
  event: RuntimeEvent,
  nowMs: number = Date.now(),
): Directive[] {
  if (event.type === "pty:data") {
    const view = taskViewForId(state, event.payload.taskId);
    if (!view) {
      return [];
    }
    // The raw terminal now renders in the satellite window (fed by the same
    // broadcast). The main window keeps only the Read transcript and unread cue.
    if (!isActiveView(state, view)) {
      view.unread = true;
    }
    if (appendLiveTranscript(view, event.payload.data)) {
      return [{ kind: "transcript-debounced", taskId: event.payload.taskId }];
    }
    return [{ kind: "none" }];
  }

  if (event.type === "sessions:updated") {
    return [{ kind: "session-index-debounced" }];
  }

  const view = taskViewForId(state, event.payload.taskId);
  if (!view) {
    return [];
  }
  const taskId = event.payload.taskId;

  if (event.type === "run:started") {
    updateTaskTitleFromRun(view, event.payload.title, nowMs);
    view.liveTranscriptRunId = event.payload.id;
    view.status = "Running";
    view.completedUnseen = false;
    // A new run means any prior option-prompt (and its receipt) is moot.
    view.pendingOptionPrompt = null;
    view.optionPromptReceipt = null;
    view.optionPromptBusy = false;
    view.optionPromptStep = 0;
    // …and so is a prior slash-attention pointer (attention moved on).
    view.slashAttention = null;
    // A new turn moots any lingering model-switch pointer (a stuck pending or a
    // needs-attention the user never dismissed): the CLI is doing new work.
    view.modelSwitch = null;
    ensureRunTranscript(view, event.payload.id);
    return [viewChangedDirective(state, view, taskId)];
  }

  if (event.type === "run:updated") {
    if (!isActiveRunStatus(event.payload.status) && view.liveTranscriptRunId === event.payload.id) {
      view.liveTranscriptRunId = null;
    }
    // A settled run cannot be waiting for approval: if the card on screen is
    // attributed to this run, it is a stale scrape artifact (the Stop hook
    // completed the run over a phantom re-detected panel) — retract it.
    if (
      !isActiveRunStatus(event.payload.status) &&
      view.pendingApproval?.runId === event.payload.id
    ) {
      view.pendingApproval = null;
      view.approvalExpired = false; // stale-flag hygiene (S2 review F8)
    }
    if (!isActiveRunStatus(event.payload.status) && !isActiveView(state, view)) {
      // The settled sidebar grammar's fourth state: finished while away.
      view.completedUnseen = true;
    }
    // A dispatched slash command settled by quiescence: the write happened and
    // the CLI painted whatever it had to say. If that was a panel, it is now
    // waiting in the co-visible terminal — Sonata cannot tell (panel detection
    // was retired with S3; a panel's own ❯ defeats the idle-prompt scrape), so
    // the honest surface is a passive pointer, not a state (S4 handoff → S5).
    if (event.payload.kind === "slash" && event.payload.status === "completed") {
      view.slashAttention = {
        runId: event.payload.id,
        command: event.payload.prompt.split(/\r?\n/, 1)[0] ?? event.payload.prompt,
      };
    }
    return [viewChangedDirective(state, view, taskId)];
  }

  if (event.type === "approval:detected") {
    view.pendingApproval = event.payload;
    view.status = "Waiting for approval";
    // A live ask supersedes any expired drawer (e.g. the scrape resurfaced the
    // native panel after a broker expiry).
    view.approvalExpired = false;
    return [viewChangedDirective(state, view, taskId)];
  }

  if (event.type === "remote-control:state") {
    // Set fields (not replace) so a dormant view's armedOverride survives the
    // connect/disconnect events that flow once it goes live.
    view.remoteControl.active = event.payload.active;
    view.remoteControl.url = event.payload.url;
    return [viewChangedDirective(state, view, taskId)];
  }

  if (event.type === "model-switch:state") {
    // Mid-session Claude model/effort switch (S1). The chip's value follows the
    // STATUSLINE mirror (usage:updated), never this event — so `settled` only
    // clears the pending affordance; the label was already re-derived (a model
    // switch may reset effort, and the statusline carries the live effort too).
    if (event.payload.phase === "pending") {
      view.modelSwitch = {
        kind: event.payload.kind,
        value: event.payload.value,
        phase: "pending",
      };
    } else if (event.payload.phase === "needs-attention") {
      // RED LINE surface: no receipt + an unrecognized screen. A passive "check
      // the CLI" pointer (banners.ts) — Sonata does nothing further.
      view.modelSwitch = {
        kind: event.payload.kind,
        value: event.payload.value,
        phase: "needs-attention",
      };
    } else if (event.payload.phase === "failed") {
      // A clean rejection (`Model '<x>' not found`): nothing changed CLI-side, so
      // the chip is already truthful. Report it as a one-line composer notice.
      view.modelSwitch = null;
      view.status = event.payload.error ?? "Couldn't switch — Claude rejected it.";
    } else {
      // settled — drop the pending affordance; the statusline drives the label.
      view.modelSwitch = null;
    }
    return [viewChangedDirective(state, view, taskId)];
  }

  if (event.type === "approval:decision") {
    view.pendingApproval = null;
    view.approvalExpired = false;
    view.status =
      event.payload.decision === "deny"
        ? "Approval denied"
        : event.payload.decision === "answered-natively"
          ? "Answered in CLI"
          : "Approval sent";
    return [viewChangedDirective(state, view, taskId)];
  }

  if (event.type === "approval:expired") {
    // The hook broker timed out → the native panel is taking over. The drawer
    // STAYS, switched to its expired variant (drawer S2): same surface, honest
    // state change — the request content remains legible and the action becomes
    // "Answer in CLI". Cleared by a decision (incl. answered-natively) or a
    // fresh detected ask.
    // Keyed (S6 review P2): only the ask THIS drawer shows may flip it — the
    // controller already filters hidden-ask expiries, this is the renderer's
    // own defense (a queued ask expiring must not blank a live unrelated card).
    if (view.pendingApproval?.approvalId !== event.payload.approvalId) {
      return [{ kind: "none" }];
    }
    view.approvalExpired = true;
    view.status = "Waiting in the CLI";
    return [viewChangedDirective(state, view, taskId)];
  }

  if (event.type === "approval:persisted") {
    // Receipt-by-observation: what the provider actually wrote, and where.
    view.status = `Allow rule saved: ${event.payload.rulesAdded.join(", ")} → ${event.payload.file}`;
    return [viewChangedDirective(state, view, taskId)];
  }

  if (event.type === "option-prompt:detected") {
    // A native AskUserQuestion — surface it as an answerable card. Structured
    // (from the PreToolUse hook), not scraped. The floor stays a valid
    // alternative; a fresh prompt supersedes any prior receipt.
    view.pendingOptionPrompt = event.payload;
    view.optionPromptDrafts = event.payload.questions.map(() => ({
      optionIndices: [],
      text: null,
    }));
    // Step MUST reset with the drafts: a superseding prompt inherits the old
    // step otherwise and opens on Review/out-of-range (S2 review B1).
    view.optionPromptStep = 0;
    view.optionPromptBusy = false;
    view.optionPromptReceipt = null;
    view.status = `${providerLabel(view.task?.provider ?? "claude")} is asking`;
    return [viewChangedDirective(state, view, taskId)];
  }

  if (event.type === "option-prompt:resolved") {
    const answers = event.payload.answers;
    if (!answers) {
      // Cancelled / turn ended unanswered: drop the live form (keep any receipt
      // already shown from a completed answer).
      if (view.pendingOptionPrompt?.toolUseId === event.payload.toolUseId) {
        view.pendingOptionPrompt = null;
        view.optionPromptBusy = false;
        view.status = "Ready";
      }
      return [viewChangedDirective(state, view, taskId)];
    }
    // Reconcile the receipt from the provider's own verbatim answers. The
    // question metadata (header + order) comes from the live prompt if still
    // present, else from a prior receipt, else from the answers keys.
    view.optionPromptReceipt = {
      toolUseId: event.payload.toolUseId,
      reconciled: true,
      lines: reconcileReceiptLines(optionPromptQuestionMeta(view), answers),
    };
    view.pendingOptionPrompt = null;
    view.optionPromptBusy = false;
    view.status = "Answered";
    return [viewChangedDirective(state, view, taskId)];
  }

  if (event.type === "delivery:state") {
    view.deliveryState = event.payload;
    view.status = deliveryStatusLabel(event.payload);
    return [viewChangedDirective(state, view, taskId)];
  }

  if (event.type === "delivery:receipt") {
    view.status = event.payload.receipt.backfilled ? "Receipt backfilled" : "Delivered";
    return [viewChangedDirective(state, view, taskId)];
  }

  if (event.type === "usage:updated") {
    const previousModelSummary = sessionModelSummaryLabel(view);
    view.usageSnapshot = event.payload.snapshot;
    // A usage tick is not content and not unread. Update only the usage
    // indicator (and the popover, if open) in place — never a full render(),
    // which would replaceChildren the transcript and wipe any active text
    // selection. Background views just store the snapshot for later.
    if (isActiveView(state, view)) {
      // The model chip follows the statusline (mid-session /model switch,
      // S6.5). Chips are fixed elements — updating them touches neither the
      // transcript nor the sidebar spinner.
      return [
        {
          kind: "usage-in-place",
          taskId,
          chipChanged: sessionModelSummaryLabel(view) !== previousModelSummary,
          popoverOpen: Boolean(state.usagePopover),
        },
      ];
    }
    return [{ kind: "none" }];
  }

  if (event.type === "cli-state:changed") {
    // The structured CLI activity (Slice 1, hooks-primary). Its unique value:
    // the approval indicator now also fires from the PermissionRequest hook
    // (earlier/more reliable than the footer scrape), and a take-over turn
    // shows as busy without a Sonata-owned run.
    //
    // S0 discipline: only the `activity` drives the sidebar indicator, not the
    // `tool`, so a tool-only change (every Pre/PostToolUse) must NOT rebuild —
    // that would reintroduce the per-tool spinner-restart churn S0 fixed. And
    // CLI activity is never "unread content" (no markViewChanged → no spurious
    // unread on background sessions). A genuine activity transition is a real,
    // low-frequency state change, so a sidebar-only rebuild is acceptable
    // (transcript/selection untouched).
    const previousActivity = view.cliState?.activity ?? null;
    view.cliState = {
      activity: event.payload.activity,
      tool: event.payload.tool,
      approvalKind: event.payload.approvalKind,
    };
    if (event.payload.activity !== previousActivity) {
      return [{ kind: "sidebar", taskId }];
    }
    return [{ kind: "none" }];
  }

  if (event.type === "working-status:updated") {
    const previousLiveness = view.workingStatus?.liveness ?? "fresh";
    view.workingStatus = {
      native: event.payload.native,
      liveness: event.payload.liveness,
      silentSince: event.payload.silentSince,
      capturedAt: event.payload.capturedAt,
    };
    if (event.payload.liveness !== previousLiveness) {
      // A liveness transition (fresh ↔ quiet ↔ silent) is a meaningful change,
      // but it is still not content. Reflect it in place: toggle the sidebar
      // spinner's class (never rebuild the row — that restarts the CSS spin
      // animation) and re-apply the strip's stall voice. No render(), so the
      // transcript and its selection survive. The sidebar shows liveness for
      // BACKGROUND sessions too, so this patches regardless of active view.
      return [{ kind: "strip-full", taskId, statusStrip: isActiveView(state, view) }];
    }
    // Native relay arrives at ~3Hz. Update the strip's status area in place;
    // never fall back to a full render for a status tick. A full render would
    // replaceChildren the transcript (wiping any active text selection) and
    // rebuild the sidebar (restarting the spinner). The strip lives OUTSIDE
    // the transcript, so updating it touches nothing else.
    if (isActiveView(state, view)) {
      return [{ kind: "strip-in-place", taskId }];
    }
    return [{ kind: "none" }];
  }

  // task:ready needs no renderer handler: the "Ready" copy keys on the
  // delivery state's bootLatched (a delivery:state follows every runtime
  // event), and cli-state consumes task:ready in the main process.

  if (event.type === "task:updated") {
    view.task = event.payload.task;
    view.status = taskStatusLabel(event.payload.task);
    return [viewChangedDirective(state, view, taskId)];
  }

  if (event.type === "run:stopped") {
    view.status = "Stopped";
    return [viewChangedDirective(state, view, taskId)];
  }

  if (event.type === "transcript:located") {
    view.transcriptSources = [
      ...view.transcriptSources.filter(
        (source) => source.sourceId !== event.payload.source.sourceId,
      ),
      event.payload.source,
    ];
    return [viewChangedDirective(state, view, taskId)];
  }

  if (event.type === "transcript:blocks") {
    applyTranscriptUpserts(view, event.payload);
    if (isActiveView(state, view)) {
      return [{ kind: "transcript-debounced", taskId }];
    }
    view.unread = true;
    return [{ kind: "unread-only", taskId }];
  }

  if (event.type === "report:updated") {
    return [{ kind: "report-refresh", taskId }];
  }

  return [{ kind: "none" }];
}
