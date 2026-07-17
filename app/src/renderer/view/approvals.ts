// The ACTION DRAWER (drawer S2) — the permission drawer, the question drawer
// (AskUserQuestion, stepped 1/N + Review), and the resume chooser. Both
// drawers live INSIDE the #composer slot and transform it in place: while one
// is visible, #composer carries .drawer-active and the composer card hides —
// the blocking interaction owns the "your turn" slot. All read the active
// view through the init-bound atom reference; the approval/resume BUTTONS
// live in the static template and keep their boot-bound listeners in main.ts.
// Flows and grammar route through the actions seam.

import type { OptionPromptDetectedEvent } from "../../shared/types/events";
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
let drawerWasBlocking = false;

function updateDrawerActive(): void {
  const blocking =
    !elements.approvalBanner.classList.contains("hidden") ||
    (!elements.optionPromptCard.classList.contains("hidden") &&
      elements.optionPromptCard.dataset.state === "asking");
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
  // again" — Claude writes its own allow rule; Duet receipts the write).
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

export function renderOptionPrompt(): void {
  const view = activeTaskView(state);
  const card = elements.optionPromptCard;
  const pending = view?.pendingOptionPrompt ?? null;
  const receipt = view?.optionPromptReceipt ?? null;
  if (!view || (!pending && !receipt)) {
    card.classList.add("hidden");
    card.removeAttribute("data-state");
    card.replaceChildren();
    updateDrawerActive();
    return;
  }
  card.classList.remove("hidden");
  if (pending) {
    card.dataset.state = "asking";
    card.replaceChildren(renderOptionPromptForm(view, pending));
  } else if (receipt) {
    card.dataset.state = "answered";
    card.replaceChildren(renderOptionPromptReceiptCard(receipt));
  }
  updateDrawerActive();
}

/** True iff this question's draft counts as answered (mirrors the wire rule:
 *  text only counts on single-select — P9f). */
function draftAnswered(question: { multiSelect: boolean }, draft: OptionPromptDraft | undefined): boolean {
  if (!draft) {
    return false;
  }
  if (!question.multiSelect && (draft.text ?? "").trim()) {
    return true;
  }
  return draft.optionIndices.length > 0;
}

function renderOptionPromptForm(
  view: TaskViewState,
  prompt: OptionPromptDetectedEvent["payload"],
): HTMLElement {
  const busy = view.optionPromptBusy;
  const interactive = !busy;
  const questionCount = prompt.questions.length;
  // Clamp to [0, N] (N = Review): defensive only — the reducer resets the
  // step with the drafts on every detected prompt; an out-of-range remnant
  // would land on Review, never an empty pane.
  const step = Math.max(0, Math.min(view.optionPromptStep, questionCount));
  const onReview = step === questionCount;

  const root = document.createElement("div");
  root.className = "option-prompt-body";

  // ── Header row: eyebrow · step indicator · chevrons · ✕ ──────────────────
  const heading = document.createElement("div");
  heading.className = "option-prompt-heading";
  const eyebrow = document.createElement("p");
  eyebrow.className = "eyebrow";
  eyebrow.textContent = `${providerLabel(view.task?.provider ?? "claude")} is asking`;
  heading.append(eyebrow);

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
  const currentAnswered =
    !onReview && draftAnswered(prompt.questions[step]!, view.optionPromptDrafts[step]);
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
  heading.append(nav);
  root.append(heading);

  const scroll = document.createElement("div");
  scroll.className = "option-prompt-scroll";
  if (onReview) {
    scroll.append(renderReviewStep(view, prompt, interactive));
  } else {
    scroll.append(renderQuestionStep(view, prompt, step, interactive));
  }
  root.append(scroll);

  // ── Footer: review = Send; multi-select steps = Next; else none ──────────
  const question = onReview ? null : prompt.questions[step]!;
  const footActions = document.createElement("div");
  footActions.className = "option-prompt-actions";
  if (onReview) {
    const hint = document.createElement("span");
    hint.className = "option-prompt-hint";
    hint.textContent = "Or answer in the CLI";
    const send = document.createElement("button");
    send.type = "button";
    send.className = "primary";
    const allAnswered = optionPromptDraftsComplete(view.optionPromptDrafts);
    send.textContent = busy ? "Sending…" : "Send answers";
    send.disabled = busy || !allAnswered;
    send.addEventListener("click", () => {
      actions.answerOptionPrompt();
    });
    footActions.append(hint, send);
    root.append(footActions);
  } else if (question && question.multiSelect) {
    // Toggling can't imply "done" — multi-select steps advance explicitly.
    const tag = document.createElement("span");
    tag.className = "option-prompt-multi-tag";
    tag.textContent = "choose one or more";
    const nextButton = document.createElement("button");
    nextButton.type = "button";
    nextButton.className = "primary";
    nextButton.textContent = "Next";
    nextButton.disabled = !interactive || !currentAnswered;
    nextButton.addEventListener("click", () => actions.setOptionPromptStep(view, step + 1));
    footActions.append(tag, nextButton);
    root.append(footActions);
  }
  return root;
}

function renderQuestionStep(
  view: TaskViewState,
  prompt: OptionPromptDetectedEvent["payload"],
  qIndex: number,
  interactive: boolean,
): HTMLElement {
  const question = prompt.questions[qIndex]!;
  const draft = view.optionPromptDrafts[qIndex];
  const block = document.createElement("div");
  block.className = "option-prompt-question";
  block.classList.toggle("multi", question.multiSelect);

  const qHead = document.createElement("div");
  qHead.className = "option-prompt-question-head";
  const badge = document.createElement("span");
  badge.className = "option-prompt-badge";
  badge.textContent = question.header;
  const qText = document.createElement("strong");
  qText.textContent = question.question;
  qHead.append(badge, qText);
  block.append(qHead);

  const options = document.createElement("div");
  options.className = "option-prompt-options";
  question.options.forEach((option, oIndex) => {
    const selected = (draft?.optionIndices ?? []).includes(oIndex);
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
        actions.selectOptionPromptChoice(view, qIndex, oIndex);
      });
    }
    options.append(button);
  });

  // Free-text row — single-select questions only (P9f: not injectable on
  // multi). The row IS the composer's cameo inside the drawer.
  if (!question.multiSelect) {
    const row = document.createElement("div");
    row.className = "option-prompt-freetext";
    row.classList.toggle("selected", Boolean((draft?.text ?? "").trim()));
    const icon = document.createElement("span");
    icon.className = "option-prompt-marker freetext-marker";
    icon.textContent = "✎";
    const input = document.createElement("input");
    input.type = "text";
    input.className = "option-prompt-freetext-input";
    input.placeholder = "Type your own answer…";
    input.value = draft?.text ?? "";
    input.disabled = !interactive;
    input.addEventListener("input", () => {
      actions.setOptionPromptText(view, qIndex, input.value);
      // Local DOM refresh only — a full rebuild would drop focus/caret. The
      // row highlight, the Next affordance, and any stale option selection
      // update in place; everything else catches up on the next render.
      const hasText = Boolean(input.value.trim());
      go.classList.toggle("hidden", !hasText);
      row.classList.toggle("selected", hasText);
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
        nextChevron.disabled = !draftAnswered(question, view.optionPromptDrafts[qIndex]);
      }
    });
    input.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        // ALWAYS swallow Enter: the drawer lives inside the composer <form>,
        // and an unhandled Enter in its only text input triggers the form's
        // implicit submission — sending the hidden, parked composer draft
        // into the TUI's open question form (S2 review B2).
        event.preventDefault();
        if (!event.isComposing && input.value.trim()) {
          actions.setOptionPromptStep(view, qIndex + 1);
        }
      }
    });
    const go = document.createElement("button");
    go.type = "button";
    go.className = "option-prompt-freetext-next";
    go.textContent = "Next";
    go.classList.toggle("hidden", !(draft?.text ?? "").trim());
    go.disabled = !interactive;
    go.addEventListener("click", () => actions.setOptionPromptStep(view, qIndex + 1));
    row.append(icon, input, go);
    options.append(row);
  }

  block.append(options);
  return block;
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
    const labels =
      !question.multiSelect && text
        ? [text]
        : (draft?.optionIndices ?? []).map((index) => question.options[index]?.label ?? "");
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

  const heading = document.createElement("div");
  heading.className = "option-prompt-heading";
  const eyebrow = document.createElement("p");
  eyebrow.className = "eyebrow";
  eyebrow.textContent = "Claude is asking";
  const status = document.createElement("span");
  status.className = "option-prompt-sub";
  status.textContent = receipt.reconciled ? "Answered" : "Answer sent";
  heading.append(eyebrow, status);
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
