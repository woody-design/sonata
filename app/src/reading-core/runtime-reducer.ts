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
import { isActiveRunStatus, sessionStatusLabel, taskStatusLabel } from "./selectors/runs";
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
    const active = isActiveView(state, view);
    // The raw terminal now renders in the satellite window (fed by the same
    // broadcast). The main window keeps only the Read transcript and unread cue.
    if (!active) {
      view.unread = true;
    }
    // The append MUST happen for every view (active or background) so the
    // transcript state stays current for the moment the user switches to it.
    const appended = appendLiveTranscript(view, event.payload.data);
    if (!appended) {
      return [{ kind: "none" }];
    }
    // A BACKGROUND view's new live text gains the active surface nothing: the
    // shell drops the directive's taskId and always re-renders the ACTIVE view
    // (render.ts performDirective → scheduleTranscriptRender), so a background
    // firehose would drive the active view's O(B) T3 recompute for content it
    // isn't even showing (audit F5). The append already ran and unread is set —
    // return unread-only, so a background stream never schedules a render. The
    // active surface repaints on its own events or on activation.
    if (!active) {
      return [{ kind: "unread-only", taskId: event.payload.taskId }];
    }
    return [{ kind: "transcript-debounced", taskId: event.payload.taskId }];
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
    if (
      !isActiveRunStatus(event.payload.status) &&
      !isActiveView(state, view) &&
      // SL-16: …but a run that ended expecting a wake has not FINISHED, and this
      // dot says "finished while you were away" in the sidebar. It was the last
      // surface still contradicting the card, which reads "Waiting on background
      // work…" for the same run — one honest arc means one answer
      // everywhere. The wake's own run lights it when the work actually returns.
      !event.payload.pendingWake
    ) {
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

  if (event.type === "session:state") {
    view.sessionState = event.payload;
    if (view.task) {
      view.status = sessionStatusLabel(view.task.provider, event.payload);
    }
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
  // session state's bootLatched — the latch opening IS a session-state change,
  // so it arrives on its own `session:state` (the host emits on change, not per
  // runtime event) — and cli-state consumes task:ready in the main process.

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
    // The full-report refetch (view.report = readReport(...)) exists solely to
    // refresh `report.runs` — the ONLY report field any Reading surface reads
    // (turn cards, run outcome/tone, the stopped-run refill draft, the strip's
    // started-at). A `file:changed`-only flush mutates the changedFiles /
    // artifactCandidates / unassignedChanges buckets that nothing renders, so
    // refetching the whole report (megabytes, during a build-output storm) is
    // pure waste. Narrow the refetch to updates that touched runs/approvals/
    // lifecycle (OBS S3, D6 renderer half). `runsChanged` absent (legacy events,
    // incl. the pinned corpus) is treated as true — the pre-S3 always-refetch.
    if (event.payload.runsChanged === false) {
      return [{ kind: "none" }];
    }
    return [{ kind: "report-refresh", taskId }];
  }

  if (event.type === "pty:exit") {
    // The session died, and three things follow from that.
    //
    // (1) THIS VIEW IS NO LONGER LIVE. `view.live` mirrors the session index, and
    // nothing here used to clear it: the mirror caught up ~150ms later, when the
    // debounced index refresh ran off the `sessions:updated` that main's
    // retire → `disposeTaskRuntime` → manifest persist emits. For that gap the
    // renderer believed a dead pty was alive, and everything keyed on `live` was
    // wrong in the same direction — most sharply `submitPrompt`, whose LIVE branch
    // a send in that window took, surfacing a raw `TaskNotLiveError` in the
    // composer notice instead of resuming the conversation (S4 out-of-scope 2).
    //
    // The event IS main's statement that the pty is gone, so the mirror follows it
    // at the moment it is made. The later index refresh then AGREES rather than
    // corrects — `liveChanged` is false, so it costs no second render; this is the
    // same full paint that used to happen 150ms later, not a new one.
    //
    // Sound against a STALE exit, because main fences those before broadcast:
    // `handleRuntimeEvent` drops any event whose source RunIndex is not the
    // taskId's current runtime, so a straggler `onExit` from a pty a reopen has
    // already replaced never reaches this reducer.
    //
    // (2) An approval drawer is moot on a dead session, and costs more while it
    // lingers: `drawerIsBlocking` (view/approvals.ts) hands it the composer slot
    // for ANY `pendingApproval`, expired variant included, so the drawer holds
    // send hostage on a session that can no longer answer anything — and its
    // buttons re-enable the moment a reopen flips `live` back on, writing keys at
    // a screen nobody asked from.
    //
    // Main's own turn-terminal releases already emit `approval:decision` on this
    // very event for MOST shapes (`abortPendingBrokerApprovals` — deny/Esc for
    // still-pending broker asks; `concludeExpiredBrokerApprovals` —
    // answered-natively for expired CODEX asks), and the `approval:decision`
    // branch above clears exactly these two fields when one arrives. Two shapes
    // have no emitter at all (B6):
    //   • a CLAUDE broker ask that EXPIRED — `handleApprovalExpired` deleted it
    //     from `pendingBrokerApprovals` and, claude-side, remembers it nowhere
    //     (the scrape's resurface was its only conclusion path), so pty death
    //     emits nothing for it;
    //   • ANY shape when the exit was Sonata-initiated — every Sonata teardown
    //     removes the runtime from `taskRuntimes` BEFORE node-pty's asynchronous
    //     onExit fires (the controller's own note on that ordering), so the
    //     release block finds no runtime and none of them run, while `pty:exit`
    //     itself is broadcast regardless.
    // So the renderer keeps its own defense, exactly as it does for the keyed
    // expiry (S6 review P2): main-process truth is the SOURCE, not the only guard.
    //
    // (3) An open AskUserQuestion form is the SAME shape and the same fix (S5
    // addendum). `drawerIsBlocking` gives it the slot too, and on a Sonata-
    // initiated exit main's own release — `resolveOptionPrompt(…, null)` on the
    // turn-terminal funnel (S3) — is skipped by the very `eventRuntime` guard
    // above. The form is then unreachable from every side: `dismissOptionPrompt`
    // throws on the dead runtime (`requireTaskRuntime`), a reopen's FRESH runtime
    // has no pending prompt so the same call early-returns, and the reducer's own
    // other clearer is `run:started` — which cannot arrive, because the composer
    // it would come from is the slot this form is holding. So the card sits there
    // with no exit at all. The division that settles it: resolving a form on a
    // LIVE session is main's (it owns the keys and the delivery gate); retiring
    // one with its session is the renderer's, here.
    //
    // Cleared to exactly what an `option-prompt:resolved(answers: null)` clears —
    // the live form and its in-flight latch. The RECEIPT stays: it is a passive
    // trace of an answer that really happened, rendered above the returned
    // composer and never blocking (approvals.ts), and the resolved-null branch
    // keeps it for the same reason. Drafts and step stay too; a fresh prompt
    // resets them on arrival.
    //
    // No status copy, for either of (2) and (3). `view.status` has one reader —
    // the composer's action-feedback line via `composerNotice` — which already
    // suppresses every string these two can leave behind ("Waiting for approval",
    // "Waiting in the CLI", "<Provider> is asking") as lifecycle narration; a
    // fresh sentence here would be a red notice raised over a session that just
    // ended, which is the drawer's own voice, not the composer's.
    //
    // The paint rule follows what each mutation is actually read by. Both
    // retracted drawers keep `viewChangedDirective` (and with it the background
    // view's unread cue), because that is the shape their own resolution events
    // ALREADY painted for every case main does cover: the two paths must not look
    // different on screen for what is the same retraction. Liveness is not: no
    // SURFACE reads a background view's `view.live` (the sidebar's own live dot comes
    // from the session index), and marking a view unread because the user closed it
    // would invent an attention cue out of their own action. So the flip paints the
    // active view and stays silent everywhere else — which also keeps `pty:exit` a
    // no-op on the pinned corpus's dormant replays.
    //
    // One background READER does exist, and it is inert here: `evictDormantTaskView`
    // consults `view.live`, so a just-died background view now clears that guard at
    // once instead of one index refresh later. It is still not evictable once its
    // CLI reached a prompt or ran a turn — each is a `session:state` change the
    // view received, the field is sticky once set, and `evictDormantTaskView`'s
    // non-null guard holds it. Same reasoning
    // `view/banners.ts` already leans on to keep the codex resumable-exit banner
    // alive across a switch-away; noted here so the next reader does not have to
    // re-derive it.
    const hadApproval = view.pendingApproval !== null;
    view.pendingApproval = null;
    view.approvalExpired = false;
    const hadOptionPrompt = view.pendingOptionPrompt !== null;
    view.pendingOptionPrompt = null;
    view.optionPromptBusy = false;
    const wasLive = view.live;
    view.live = false;
    if (hadApproval || hadOptionPrompt) {
      return [viewChangedDirective(state, view, taskId)];
    }
    if (wasLive && isActiveView(state, view)) {
      return [{ kind: "full", taskId }];
    }
    return [{ kind: "none" }];
  }

  return [{ kind: "none" }];
}
