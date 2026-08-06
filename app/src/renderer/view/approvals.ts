// The ACTION DRAWER (drawer S2) — the permission drawer, the question drawer
// (AskUserQuestion, stepped 1/N + Review), and the resume chooser. Both
// drawers live INSIDE the #composer slot and transform it in place: while one
// is visible, #composer carries .drawer-active and the composer card hides —
// the blocking interaction owns the "your turn" slot. All read the active
// view through the init-bound atom reference; the approval/resume BUTTONS
// live in the static template and keep their boot-bound listeners in main.ts.
// Flows and grammar route through the actions seam.

import type { OptionPromptDetectedEvent } from "../../shared/types/events";
import { MODEL_OPTIONS, REASONING_OPTIONS } from "../../reading-core/config";
import {
  approvalKindLabel,
  approvalQuestion,
  formatIdleDuration,
  formatTokenCount,
  providerLabel,
} from "../../reading-core/selectors/formatters";
import {
  activeTaskView,
  isSessionLifecycleActive,
  optionPromptDraftAnswered,
  optionPromptDraftsComplete,
  type OptionPromptDraft,
  type OptionPromptReceipt,
  type RendererState,
  type TaskViewState,
} from "../../reading-core/state";
import { elements } from "../dom";
import { actions } from "../actions";

/** The shell's state atom, bound once at boot for the cards' read paths. */
let state: RendererState;

/** `#resume-remember` is one shared DOM checkbox (view-truth, not core state).
 *  Since the choice is now per-view and de-modalized, the checkbox must never
 *  carry a check set on one task's choice into another's — we track which task's
 *  choice it is currently bound to and reset it whenever that identity changes
 *  (or the panel closes). */
let resumeRememberBoundTaskId: string | null = null;

export function initApprovalsView(stateRef: RendererState): void {
  state = stateRef;
  // Static one-time wiring (same pattern as the approval buttons in main.ts):
  // the expired variant's pointer surfaces the terminal through the choke point.
  elements.approvalOpenCli.addEventListener("click", () => {
    actions.setViewMode("terminal");
  });
}

/** The drawer owns the composer slot ONLY while it is blocking: a pending
 *  approval (incl. its expired variant — the request still blocks the turn)
 *  or an asking question form. The answered receipt is a passive trace — it
 *  stays visible ABOVE the returned composer, never withholding it. */
function drawerIsBlocking(): boolean {
  const view = activeTaskView(state);
  if (!view) {
    return false;
  }
  const parkedControlConfirm = Boolean(
    view.controlSwitch && view.controlSwitch.phase === "parked" && view.controlSwitch.dialog,
  );
  return (
    // Each arm mirrors exactly what its own renderer shows the card for.
    Boolean(view.pendingApproval) ||
    Boolean(view.pendingOptionPrompt) ||
    // A PARKED recognized-confirm relay (S7) owns the slot the same way — the CLI
    // asked, the user must answer here (or the co-visible Terminal) to unblock.
    parkedControlConfirm
  );
}

/** The blocking value of the last completed update — the other half of an edge.
 *  View-truth, like the resume checkbox binding above: it remembers what the
 *  user was last shown, which is not something the core state models. */
let drawerWasBlocking = false;

/** Called by all three drawer renderers. Reading the answer from STATE (not from
 *  the classList of cards that are mid-update) is what makes that safe: the three
 *  calls inside one render pass now compute the same value, so the transition can
 *  no longer be edge-detected against a half-painted screen — which is how the
 *  caret used to be handed back while another drawer was still opening. */
function updateDrawerActive(): void {
  const blocking = drawerIsBlocking();
  elements.composer.classList.toggle("drawer-active", blocking);
  if (drawerWasBlocking && !blocking) {
    // The drawer resolved — it's the user's turn again; hand the caret back
    // (the natural next act after answering/dismissing is to type — S2 N14).
    elements.promptInput.focus();
  }
  drawerWasBlocking = blocking;
}

export function renderResumeChoice(): void {
  const view = activeTaskView(state);
  const choice = view?.resumeChoice ?? null;
  elements.resumeChoice.classList.toggle("hidden", !choice);
  if (!choice) {
    // Panel closed (resolved, cleared, or no dormant view): drop any lingering
    // check so it can't ride into the next task's choice, and unbind.
    if (resumeRememberBoundTaskId !== null) {
      elements.resumeRemember.checked = false;
      resumeRememberBoundTaskId = null;
    }
    return;
  }
  const choiceTaskId = view?.task?.id ?? null;
  if (choiceTaskId !== resumeRememberBoundTaskId) {
    // The visible choice belongs to a different task than the checkbox was last
    // bound to — reset the shared check and rebind, so a remember set on task A
    // never persists a resume policy the user never chose for task B.
    elements.resumeRemember.checked = false;
    resumeRememberBoundTaskId = choiceTaskId;
  }
  // The choice lives on the view (D3); the buttons are live whenever it is set
  // AND no lifecycle op is in flight — so they disable during the resuming
  // flight (and any other active lifecycle op) and re-enable afterwards.
  const choiceInteractive = !isSessionLifecycleActive(state);
  elements.resumeFull.disabled = !choiceInteractive;
  elements.resumeSummary.disabled = !choiceInteractive;
  elements.resumeRemember.disabled = !choiceInteractive;
  elements.resumeChoiceBody.textContent =
    `This session has been idle for ${choice.idleMs !== null ? formatIdleDuration(choice.idleMs) : "a while"}` +
    `${choice.totalTokens !== null ? ` and holds ~${formatTokenCount(choice.totalTokens)} tokens` : ""}. ` +
    "Resuming in full keeps every detail and uses more of your limits; " +
    "summary compacts the history first to save usage.";
  elements.resumeBridgeNote.classList.toggle("hidden", !choice.bridgeDismissed);
}

export function renderApproval(): void {
  const view = activeTaskView(state);
  const approval = view?.pendingApproval ?? null;
  elements.approvalBanner.classList.toggle("hidden", !approval);
  if (!approval) {
    elements.approvalBanner.removeAttribute("data-approval-kind");
    elements.approvalBanner.removeAttribute("data-state");
    elements.approvalContext.replaceChildren();
    elements.approveSessionApproval.classList.add("hidden");
    updateDrawerActive();
    return;
  }

  // Expired variant (drawer S2): same drawer, honest state change — content
  // stays legible, decision buttons swap for the "waiting in the CLI" pointer.
  const expired = Boolean(view?.approvalExpired);
  elements.approvalBanner.dataset.state = expired ? "expired" : "asking";
  elements.approvalActions.classList.toggle("hidden", expired);
  elements.approvalExpiredRow.classList.toggle("hidden", !expired);

  elements.approveApproval.disabled = expired;
  elements.denyApproval.disabled = expired;

  // The middle button is a faithful projection of the panel's own option 2:
  // session-scoped ("Allow for this session") or persistent ("Don't ask
  // again" — Claude writes its own allow rule; Sonata receipts the write).
  // Separate buttons by design (Woody, 2026-07-17): no split/dropdown.
  const middleChoice =
    approval.choices?.find(
      (choice) => choice.decision === "approve-always" || choice.decision === "approve-for-session",
    ) ?? null;
  const approveChoice = approval.choices?.find((choice) => choice.decision === "approve") ?? null;
  elements.approvalBanner.dataset.approvalKind = approval.kind;
  elements.approvalKindBadge.textContent = approvalKindLabel(approval.kind);
  // The drawer leads with a plain question; the raw subject (full command /
  // path) sits in the code block below it. Scrape/codex cards without a
  // detail fall back to the summary line as the block (still the "what").
  elements.approvalTitle.textContent = approvalQuestion(approval.kind);
  const detail = approval.detail?.trim() || approval.summary?.trim() || "";
  elements.approvalContext.textContent = detail;
  elements.approvalContext.classList.toggle("hidden", !detail);
  // Codex asks carry a human-written description (their tool_input.description
  // becomes the summary) — surface it; Claude summaries are derived from the
  // command and would double the code block (S2 review F5).
  const summary = approval.summary?.trim() ?? "";
  const showSummary = view?.task?.provider === "codex" && Boolean(summary) && summary !== detail;
  elements.approvalSummary.textContent = showSummary ? summary : "";
  elements.approvalSummary.classList.toggle("hidden", !showSummary);
  elements.approveSessionApproval.classList.toggle("hidden", !middleChoice);
  elements.approveSessionApproval.disabled = expired || !middleChoice;
  if (middleChoice) {
    elements.approveSessionApproval.textContent = middleChoice.label;
    elements.approveSessionApproval.title = middleChoice.description;
  } else {
    elements.approveSessionApproval.removeAttribute("title");
  }
  if (approveChoice) {
    elements.approveApproval.textContent = approveChoice.label;
    elements.approveApproval.title = approveChoice.description;
  }
  // data-approval-kind lets CSS flag the dangerous (bypass) card.
  const denyChoice = approval.choices?.find((choice) => choice.decision === "deny") ?? null;
  if (denyChoice) {
    elements.denyApproval.textContent = denyChoice.label;
    elements.denyApproval.title = denyChoice.description;
  }
  updateDrawerActive();
}

// ── The question drawer (AskUserQuestion) — stepped 1/N + Review (S2) ────────
//
// NODE IDENTITY (S1, 2026-08-06). The free-text row is a field the user types
// into, and such a field must keep ONE DOM node for its whole life: focus, caret
// and — the reason a focus snapshot cannot stand in for this — the browser's IME
// composition all live on the node, so a rebuild ends a half-typed Chinese word.
// This card used to `replaceChildren` a freshly built form on EVERY render, which
// is why a click into the field died a fraction of a second later.
//
// So the form is RECONCILED IN PLACE for the lifetime of one pending prompt
// (model: view/rename-editor.ts). Persisted, and never detached while that prompt
// stands: the form root, its heading/scroll/footer boxes, and — per question step
// — the question block, its options container and the free-text row. Everything
// else is rebuilt per render exactly as before (the heading's own children, the
// footer's, the question head, the option buttons, the whole Review step): none
// of it is typed into, and replacing a container's CHILDREN never detaches the
// sibling the caret lives in.

interface ProtectedFreeText {
  row: HTMLElement;
  input: HTMLTextAreaElement;
}

interface ProtectedQuestionStep {
  index: number;
  block: HTMLElement;
  head: HTMLElement;
  options: HTMLElement;
  /** Single-select questions only (P9f: free text is not injectable on multi). */
  freeText: ProtectedFreeText | null;
}

interface ProtectedOptionPromptForm {
  /** The pending prompt this form belongs to — its identity key. */
  toolUseId: string;
  root: HTMLElement;
  heading: HTMLElement;
  scroll: HTMLElement;
  footer: HTMLElement;
  step: ProtectedQuestionStep | null;
}

let protectedOptionPromptForm: ProtectedOptionPromptForm | null = null;

export function renderOptionPrompt(): void {
  const view = activeTaskView(state);
  const card = elements.optionPromptCard;
  const pending = view?.pendingOptionPrompt ?? null;
  const receipt = view?.optionPromptReceipt ?? null;
  if (!view || (!pending && !receipt)) {
    protectedOptionPromptForm = null;
    card.classList.add("hidden");
    card.removeAttribute("data-state");
    card.replaceChildren();
    updateDrawerActive();
    return;
  }
  card.classList.remove("hidden");
  if (pending) {
    card.dataset.state = "asking";
    reconcileOptionPromptForm(card, view, pending);
  } else if (receipt) {
    // The prompt is answered: its form (and the field inside it) is over.
    protectedOptionPromptForm = null;
    card.dataset.state = "answered";
    card.replaceChildren(renderOptionPromptReceiptCard(receipt));
  }
  updateDrawerActive();
}

/** The live view IFF it still owns the prompt a persisted node was built for.
 *  The identity check is what keeps a late event from a superseded field (or a
 *  switched-away task) writing into someone else's drafts. */
function viewOwningOptionPrompt(toolUseId: string): TaskViewState | null {
  const view = activeTaskView(state);
  return view?.pendingOptionPrompt?.toolUseId === toolUseId ? view : null;
}

// ── Recognized-confirm relay drawer (S7 revision 3) ─────────────────────────
//
// The CLI raised a WHITELISTED confirm dialog (claude cache-miss / codex Full
// Access consent) and the choreography PARKED on it. This drawer surfaces the
// dialog's rows VERBATIM (composed from the dialog id + kind + value + registered
// copy — the host navigates by row number, never the row text) and relays the
// user's chosen row into the parked dialog. The drawer's home turf: the CLI asks,
// the user answers here.

interface ControlConfirmRow {
  /** 1-based CLI row — what answerControlConfirm relays. */
  rowNumber: number;
  label: string;
  desc?: string;
}
interface ControlConfirmContent {
  eyebrow: string;
  title: string;
  body: string;
  rows: ControlConfirmRow[];
  /** The row a dismiss (✕) maps to (never leave a dialog parked silently). */
  cancelRow: number;
}

/** The verbatim rows + copy for a parked dialog. Codex consent rows are the
 *  measured fixed strings; the claude Yes row embeds the target's display name,
 *  resolved from the curated lists (falling back to the raw value). */
function controlConfirmContent(
  provider: "claude" | "codex",
  kind: string,
  value: string,
  dialog: "claude-cachemiss" | "codex-consent",
): ControlConfirmContent {
  if (dialog === "codex-consent") {
    return {
      eyebrow: `${providerLabel(provider)} is asking`,
      title: "Enable Full Access?",
      body:
        "Codex will be able to edit any file on your computer and run commands " +
        "with network access, without asking for approval. Exercise caution.",
      // VERBATIM from the measured dialog (codex 0.146.0): two rows — the
      // `Yes, and don't ask again` row was deleted upstream (F1), which moved
      // Cancel to row 2. The host navigates by ROW NUMBER, so these must stay in
      // lockstep with the CLI's own numbering.
      rows: [
        { rowNumber: 1, label: "Yes, continue anyway", desc: "Apply full access for this session" },
        { rowNumber: 2, label: "Cancel", desc: "Go back without enabling full access" },
      ],
      cancelRow: 2,
    };
  }
  const isEffort = kind === "effort";
  const targetLabel = claudeTargetLabel(isEffort ? "effort" : "model", value);
  return {
    eyebrow: `${providerLabel(provider)} is asking`,
    title: isEffort ? "Change effort level?" : "Switch model?",
    body:
      `This conversation is cached for the current ${isEffort ? "effort level" : "model"}. ` +
      `Switching means your next response re-reads the full history (slower, more tokens).`,
    rows: [
      { rowNumber: 1, label: `Yes, switch to ${targetLabel}` },
      { rowNumber: 2, label: "No, go back" },
    ],
    cancelRow: 2,
  };
}

/** Resolve a claude `/model` alias / `/effort` id to its display label. */
function claudeTargetLabel(kind: "model" | "effort", value: string): string {
  const options = kind === "effort" ? REASONING_OPTIONS.claude : MODEL_OPTIONS.claude;
  return options.find((option) => option.value === value)?.label ?? value;
}

/** The dialog this card currently has mounted, or null when it shows nothing.
 *  Same species as the question drawer's form key: one parked dialog, one set of
 *  row buttons, for as long as it stands. */
let mountedControlConfirmKey: string | null = null;

export function renderControlConfirm(): void {
  const view = activeTaskView(state);
  const card = elements.controlConfirmCard;
  const cs = view?.controlSwitch ?? null;
  const parked = cs && cs.phase === "parked" && cs.dialog ? cs : null;
  if (!view || !parked || !parked.dialog) {
    mountedControlConfirmKey = null;
    card.classList.add("hidden");
    card.removeAttribute("data-state");
    card.replaceChildren();
    updateDrawerActive();
    return;
  }
  card.classList.remove("hidden");
  card.dataset.state = "asking";
  const provider = view.task?.provider === "codex" ? "codex" : "claude";
  // The whole card is a pure function of these four — nothing in it changes
  // between renders of the same parked dialog. So rebuild it only when the
  // dialog itself changes: repainting identical rows under the user's pointer
  // is the same defect class the question drawer had (a click that lands on a
  // node about to be destroyed, and keyboard focus dropped from a row).
  const key = `${provider}|${parked.dialog}|${parked.kind}|${parked.value}`;
  if (key !== mountedControlConfirmKey || card.childElementCount === 0) {
    const content = controlConfirmContent(provider, parked.kind, parked.value, parked.dialog);
    card.replaceChildren(renderControlConfirmForm(content));
    mountedControlConfirmKey = key;
  }
  updateDrawerActive();
}

function renderControlConfirmForm(content: ControlConfirmContent): HTMLElement {
  const root = document.createElement("div");
  root.className = "option-prompt-body control-confirm-body";

  const heading = document.createElement("div");
  heading.className = "option-prompt-heading";
  const eyebrow = document.createElement("p");
  eyebrow.className = "eyebrow";
  eyebrow.textContent = content.eyebrow;
  heading.append(eyebrow);
  // Dismiss (✕) = the Cancel row (never leave a dialog parked silently — S7).
  const dismiss = document.createElement("button");
  dismiss.type = "button";
  dismiss.className = "drawer-nav-button";
  dismiss.textContent = "✕";
  dismiss.setAttribute("aria-label", "Dismiss (cancel)");
  dismiss.addEventListener("click", () => actions.answerControlConfirm(content.cancelRow));
  heading.append(dismiss);
  root.append(heading);

  const title = document.createElement("strong");
  title.className = "drawer-title";
  title.textContent = content.title;
  root.append(title);

  const body = document.createElement("p");
  body.className = "drawer-summary";
  body.textContent = content.body;
  root.append(body);

  const rows = document.createElement("div");
  rows.className = "control-confirm-rows";
  for (const row of content.rows) {
    const button = document.createElement("button");
    button.type = "button";
    // The primary (row 1) is the affirmative action; the cancel row is muted.
    button.className =
      "task-setting-option control-confirm-row" +
      (row.rowNumber === content.cancelRow ? " is-cancel" : "");
    const copy = document.createElement("span");
    copy.className = "task-setting-option-copy";
    const label = document.createElement("span");
    label.textContent = row.label;
    copy.append(label);
    if (row.desc) {
      const desc = document.createElement("span");
      desc.className = "task-setting-option-desc";
      desc.textContent = row.desc;
      copy.append(desc);
    }
    button.append(copy);
    button.addEventListener("click", () => actions.answerControlConfirm(row.rowNumber));
    rows.append(button);
  }
  root.append(rows);

  return root;
}

/** One render of the asking form: the persisted skeleton is reused (or built on
 *  the first render of this prompt), and everything inside it is brought up to
 *  date. Structure is identical to the form this replaced — it is the same tree,
 *  written so the parts the user can be inside are never rebuilt. */
function reconcileOptionPromptForm(
  card: HTMLElement,
  view: TaskViewState,
  prompt: OptionPromptDetectedEvent["payload"],
): void {
  const busy = view.optionPromptBusy;
  const interactive = !busy;
  const questionCount = prompt.questions.length;
  // Clamp to [0, N] (N = Review): defensive only — the reducer resets the
  // step with the drafts on every detected prompt; an out-of-range remnant
  // would land on Review, never an empty pane.
  const step = Math.max(0, Math.min(view.optionPromptStep, questionCount));
  const onReview = step === questionCount;
  const currentAnswered =
    !onReview && optionPromptDraftAnswered(prompt.questions[step]!, view.optionPromptDrafts[step]);

  const form = mountOptionPromptForm(card, prompt.toolUseId);
  fillOptionPromptHeading(form, view, prompt, step, { interactive, onReview, currentAnswered });
  if (onReview) {
    form.step = null;
    form.scroll.replaceChildren(renderReviewStep(view, prompt, interactive));
  } else {
    reconcileQuestionStep(form, view, prompt, step, interactive);
  }
  fillOptionPromptFooter(form, view, prompt, step, { busy, interactive, onReview, currentAnswered });
}

/** The persisted skeleton for one pending prompt: root > [heading, scroll,
 *  footer]. Reused as long as the prompt identity holds AND it is still the
 *  card's own child, so an outside `replaceChildren` (a receipt, a task switch)
 *  can never leave us syncing a detached tree. */
function mountOptionPromptForm(card: HTMLElement, toolUseId: string): ProtectedOptionPromptForm {
  const existing = protectedOptionPromptForm;
  if (existing && existing.toolUseId === toolUseId && existing.root.parentElement === card) {
    return existing;
  }
  const root = document.createElement("div");
  root.className = "option-prompt-body";
  const heading = document.createElement("div");
  heading.className = "option-prompt-heading";
  const scroll = document.createElement("div");
  scroll.className = "option-prompt-scroll";
  // Footer: review = Send; question steps = the one Next home (S5). Always
  // present (every step has one of the two), so it is part of the skeleton.
  const footer = document.createElement("div");
  footer.className = "option-prompt-actions";
  root.append(heading, scroll, footer);
  const form: ProtectedOptionPromptForm = { toolUseId, root, heading, scroll, footer, step: null };
  protectedOptionPromptForm = form;
  card.replaceChildren(root);
  return form;
}

/** Header row: eyebrow · step indicator · chevrons · ✕. */
function fillOptionPromptHeading(
  form: ProtectedOptionPromptForm,
  view: TaskViewState,
  prompt: OptionPromptDetectedEvent["payload"],
  step: number,
  flags: { interactive: boolean; onReview: boolean; currentAnswered: boolean },
): void {
  const { interactive, onReview, currentAnswered } = flags;
  const questionCount = prompt.questions.length;
  const eyebrow = document.createElement("p");
  eyebrow.className = "eyebrow";
  eyebrow.textContent = `${providerLabel(view.task?.provider ?? "claude")} is asking`;

  const nav = document.createElement("div");
  nav.className = "drawer-nav";
  const stepLabel = document.createElement("span");
  stepLabel.className = "drawer-step";
  stepLabel.textContent = onReview
    ? "Review"
    : questionCount > 1
      ? `${step + 1} of ${questionCount}`
      : "";
  const prev = document.createElement("button");
  prev.type = "button";
  prev.className = "drawer-nav-button";
  prev.textContent = "‹";
  prev.setAttribute("aria-label", "Previous question");
  prev.disabled = !interactive || step === 0;
  prev.addEventListener("click", () => actions.setOptionPromptStep(view, step - 1));
  const next = document.createElement("button");
  next.type = "button";
  next.className = "drawer-nav-button";
  next.textContent = "›";
  next.setAttribute("aria-label", "Next question");
  next.disabled = !interactive || onReview || !currentAnswered;
  next.addEventListener("click", () => actions.setOptionPromptStep(view, step + 1));
  const dismiss = document.createElement("button");
  dismiss.type = "button";
  dismiss.className = "drawer-nav-button drawer-dismiss";
  dismiss.textContent = "✕";
  dismiss.title = "Skip — chat instead";
  dismiss.setAttribute("aria-label", "Skip these questions and chat instead");
  dismiss.disabled = !interactive;
  dismiss.addEventListener("click", () => actions.dismissOptionPrompt());
  if (questionCount > 1) {
    nav.append(stepLabel, prev, next, dismiss);
  } else {
    nav.append(dismiss);
  }
  form.heading.replaceChildren(eyebrow, nav);
}

function fillOptionPromptFooter(
  form: ProtectedOptionPromptForm,
  view: TaskViewState,
  prompt: OptionPromptDetectedEvent["payload"],
  step: number,
  flags: { busy: boolean; interactive: boolean; onReview: boolean; currentAnswered: boolean },
): void {
  const { busy, interactive, onReview, currentAnswered } = flags;
  const question = onReview ? null : prompt.questions[step]!;
  if (onReview) {
    const hint = document.createElement("span");
    hint.className = "option-prompt-hint";
    hint.textContent = "Or answer in the CLI";
    const send = document.createElement("button");
    send.type = "button";
    send.className = "primary";
    const allAnswered = optionPromptDraftsComplete(prompt.questions, view.optionPromptDrafts);
    send.textContent = busy ? "Sending…" : "Send answers";
    send.disabled = busy || !allAnswered;
    send.addEventListener("click", () => {
      actions.answerOptionPrompt();
    });
    form.footer.replaceChildren(hint, send);
    return;
  }
  if (!question) {
    form.footer.replaceChildren();
    return;
  }
  // ONE home for the explicit Next on every question step (S5): the footer,
  // right-aligned — never inside the free-text field it used to crowd.
  // Multi-select: always present, disabled until a toggle (toggling can't
  // imply "done"). Single-select: hidden until the free-text draft has
  // content (picks auto-advance). Advance = next unanswered, else Review.
  const tag = document.createElement("span");
  tag.className = "option-prompt-multi-tag";
  tag.textContent = question.multiSelect ? "choose one or more" : "Or answer in the CLI";
  const nextButton = document.createElement("button");
  nextButton.type = "button";
  nextButton.className = "primary option-prompt-step-next";
  nextButton.textContent = "Next";
  nextButton.disabled = !interactive || !currentAnswered;
  nextButton.classList.toggle(
    "hidden",
    !question.multiSelect && !(view.optionPromptDrafts[step]?.text ?? "").trim(),
  );
  nextButton.addEventListener("click", () => actions.advanceOptionPromptStep(view, step));
  form.footer.replaceChildren(tag, nextButton);
}

/** The question step, reconciled: its block/options/free-text row persist for as
 *  long as the drawer stands on this step; the head copy and the option buttons
 *  are rebuilt, the buttons landing BEFORE the free-text row so that row (and the
 *  caret in it) is never detached. */
function reconcileQuestionStep(
  form: ProtectedOptionPromptForm,
  view: TaskViewState,
  prompt: OptionPromptDetectedEvent["payload"],
  qIndex: number,
  interactive: boolean,
): void {
  const question = prompt.questions[qIndex]!;
  const draft = view.optionPromptDrafts[qIndex];
  let step = form.step;
  if (!step || step.index !== qIndex) {
    // A different question is a different field — the old one's life is over.
    step = createQuestionStep(form.toolUseId, question, qIndex);
    form.step = step;
    form.scroll.replaceChildren(step.block);
  }

  const badge = document.createElement("span");
  badge.className = "option-prompt-badge";
  badge.textContent = question.header;
  const qText = document.createElement("strong");
  qText.textContent = question.question;
  step.head.replaceChildren(badge, qText);

  const buttons = question.options.map((option, oIndex) =>
    renderQuestionOption(form.toolUseId, question, qIndex, option, oIndex, {
      selected: (draft?.optionIndices ?? []).includes(oIndex),
      interactive,
    }),
  );
  const rowNode = step.freeText?.row ?? null;
  for (const child of Array.from(step.options.children)) {
    if (child !== rowNode) {
      child.remove();
    }
  }
  for (const button of buttons) {
    step.options.insertBefore(button, rowNode);
  }

  if (step.freeText) {
    syncFreeText(step.freeText, draft, interactive);
  }
}

function createQuestionStep(
  toolUseId: string,
  question: OptionPromptDetectedEvent["payload"]["questions"][number],
  qIndex: number,
): ProtectedQuestionStep {
  const block = document.createElement("div");
  block.className = "option-prompt-question";
  block.classList.toggle("multi", question.multiSelect);

  const head = document.createElement("div");
  head.className = "option-prompt-question-head";
  const options = document.createElement("div");
  options.className = "option-prompt-options";
  block.append(head, options);

  // Free-text row — single-select questions only (P9f: not injectable on
  // multi). The row IS the composer's cameo inside the drawer, so it is the
  // node this whole reconciler exists to keep alive.
  const freeText = question.multiSelect ? null : createFreeTextRow(toolUseId, qIndex, options);
  if (freeText) {
    options.append(freeText.row);
  }
  return { index: qIndex, block, head, options, freeText };
}

function renderQuestionOption(
  toolUseId: string,
  question: OptionPromptDetectedEvent["payload"]["questions"][number],
  qIndex: number,
  option: OptionPromptDetectedEvent["payload"]["questions"][number]["options"][number],
  oIndex: number,
  flags: { selected: boolean; interactive: boolean },
): HTMLButtonElement {
  const { selected, interactive } = flags;
  const button = document.createElement("button");
  button.type = "button";
  button.className = "option-prompt-option";
  button.classList.toggle("checkbox", question.multiSelect);
  button.classList.toggle("selected", selected);
  button.setAttribute("aria-pressed", String(selected));
  button.disabled = !interactive;

  const marker = document.createElement("span");
  marker.className = "option-prompt-marker";
  marker.textContent = question.multiSelect ? (selected ? "☑" : "☐") : String(oIndex + 1);
  const text = document.createElement("span");
  text.className = "option-prompt-option-text";
  const label = document.createElement("span");
  label.className = "option-prompt-option-label";
  label.textContent = option.label;
  text.append(label);
  if (option.description) {
    const desc = document.createElement("span");
    desc.className = "option-prompt-option-desc";
    desc.textContent = option.description;
    text.append(desc);
  }
  button.append(marker, text);
  if (interactive) {
    button.addEventListener("click", () => {
      const owner = viewOwningOptionPrompt(toolUseId);
      if (owner) {
        actions.selectOptionPromptChoice(owner, qIndex, oIndex);
      }
    });
  }
  return button;
}

/** The persisted free-text field. Its listeners are bound ONCE, so they read the
 *  live view through the identity check rather than closing over the render that
 *  happened to create them. */
function createFreeTextRow(
  toolUseId: string,
  qIndex: number,
  options: HTMLElement,
): ProtectedFreeText {
  const row = document.createElement("div");
  row.className = "option-prompt-freetext";
  const icon = document.createElement("span");
  icon.className = "option-prompt-marker freetext-marker";
  icon.textContent = "✎";
  // A one-row textarea that grows with the text (CSS `field-sizing: content`
  // — the standard auto-grow; no JS measuring, no caret jumps; capped by
  // max-height then scrolls). The ANSWER stays one logical line: the TUI's
  // editor is single-line (the S1 grammar rejects CR/LF), so Enter never
  // inserts a newline here — long answers soft-wrap, pasted newlines are
  // flattened to spaces.
  const input = document.createElement("textarea");
  input.rows = 1;
  input.className = "option-prompt-freetext-input";
  input.placeholder = "Type your own answer…";
  input.addEventListener("input", () => {
    const owner = viewOwningOptionPrompt(toolUseId);
    const question = owner?.pendingOptionPrompt?.questions[qIndex];
    if (!owner || !question) {
      return;
    }
    if (/[\r\n]/.test(input.value)) {
      // Delta-aware caret restore: newline RUNS collapse to one space, so
      // sanitize the head separately to know how much shrank before the caret.
      const caret = input.selectionStart ?? input.value.length;
      const head = input.value.slice(0, caret).replace(/[\r\n]+/g, " ");
      input.value = input.value.replace(/[\r\n]+/g, " ");
      const position = Math.min(head.length, input.value.length);
      input.setSelectionRange(position, position);
    }
    actions.setOptionPromptText(owner, qIndex, input.value);
    // Local DOM refresh only — a full rebuild would drop focus/caret. The
    // row highlight, the Next affordance, and any stale option selection
    // update in place; everything else catches up on the next render.
    const hasText = Boolean(input.value.trim());
    row.classList.toggle("selected", hasText);
    const footerNext = elements.optionPromptCard.querySelector<HTMLButtonElement>(
      ".option-prompt-step-next",
    );
    if (footerNext) {
      footerNext.classList.toggle("hidden", !hasText);
      footerNext.disabled = !hasText;
    }
    if (hasText) {
      options.querySelectorAll(".option-prompt-option.selected").forEach((optionButton) => {
        optionButton.classList.remove("selected");
        optionButton.setAttribute("aria-pressed", "false");
      });
    }
    // The header next-chevron gates on draftAnswered; keep it honest across
    // keystrokes too (typing clears a pick; deleting text can un-answer the
    // question entirely — S2 review F7).
    const nextChevron = elements.optionPromptCard.querySelector<HTMLButtonElement>(
      '.drawer-nav-button[aria-label="Next question"]',
    );
    if (nextChevron) {
      nextChevron.disabled = !optionPromptDraftAnswered(question, owner.optionPromptDrafts[qIndex]);
    }
  });
  input.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      // ALWAYS swallow Enter: newline insertion is meaningless here (the
      // TUI editor is single-line) and an unhandled Enter once triggered
      // the composer form's implicit submission (S2 review B2).
      event.preventDefault();
      const owner = viewOwningOptionPrompt(toolUseId);
      if (owner && !event.isComposing && !event.shiftKey && input.value.trim()) {
        actions.advanceOptionPromptStep(owner, qIndex);
      }
    }
  });
  row.append(icon, input);
  return { row, input };
}

function syncFreeText(
  nodes: ProtectedFreeText,
  draft: OptionPromptDraft | undefined,
  interactive: boolean,
): void {
  const text = draft?.text ?? "";
  // State is authoritative, but never write through an actively owned input:
  // assigning value there collapses the browser selection and can terminate an
  // in-progress composition (the promise rename-editor makes for its own input).
  if (document.activeElement !== nodes.input && nodes.input.value !== text) {
    nodes.input.value = text;
  }
  nodes.input.disabled = !interactive;
  nodes.row.classList.toggle("selected", Boolean(text.trim()));
}

function renderReviewStep(
  view: TaskViewState,
  prompt: OptionPromptDetectedEvent["payload"],
  interactive: boolean,
): HTMLElement {
  const block = document.createElement("div");
  block.className = "option-prompt-review";
  const title = document.createElement("strong");
  title.className = "option-prompt-review-title";
  title.textContent = "Review your answers";
  block.append(title);
  prompt.questions.forEach((question, qIndex) => {
    const draft = view.optionPromptDrafts[qIndex];
    const row = document.createElement("button");
    row.type = "button";
    row.className = "option-prompt-review-row";
    row.disabled = !interactive;
    row.title = "Edit this answer";
    const badge = document.createElement("span");
    badge.className = "option-prompt-badge";
    badge.textContent = question.header;
    const answer = document.createElement("span");
    answer.className = "option-prompt-review-answer";
    const text = (draft?.text ?? "").trim();
    // Display in OPTION order (sorted), matching the wire selections and the
    // CLI's own answer order — toggle order is an input accident, not meaning.
    const labels =
      !question.multiSelect && text
        ? [text]
        : [...(draft?.optionIndices ?? [])]
            .sort((a, b) => a - b)
            .map((index) => question.options[index]?.label ?? "");
    answer.textContent = labels.filter(Boolean).join(", ") || "—";
    row.append(badge, answer);
    row.addEventListener("click", () => actions.setOptionPromptStep(view, qIndex));
    block.append(row);
  });
  return block;
}

function renderOptionPromptReceiptCard(receipt: OptionPromptReceipt): HTMLElement {
  const root = document.createElement("div");
  root.className = "option-prompt-body option-prompt-receipt";

  // The eyebrow IS the state ("Your answer:" — Woody, 2026-07-17); no separate
  // status word on the right. (The un-reconciled "Answer sent" wording died
  // with the S1 corroboration change: receipts are only ever built reconciled.)
  const heading = document.createElement("div");
  heading.className = "option-prompt-heading";
  const eyebrow = document.createElement("p");
  eyebrow.className = "eyebrow";
  eyebrow.textContent = "Your answer:";
  heading.append(eyebrow);
  root.append(heading);

  // A long receipt scrolls under the pinned heading rather than clipping.
  const scroll = document.createElement("div");
  scroll.className = "option-prompt-scroll";
  receipt.lines.forEach((line) => {
    const row = document.createElement("div");
    row.className = "option-prompt-receipt-line";
    const badge = document.createElement("span");
    badge.className = "option-prompt-badge";
    badge.textContent = line.header;
    const chose = document.createElement("span");
    chose.className = "option-prompt-receipt-choice";
    chose.textContent = line.labels.length ? `You chose: ${line.labels.join(", ")}` : "You chose: —";
    row.append(badge, chose);
    scroll.append(row);
  });
  root.append(scroll);
  return root;
}
