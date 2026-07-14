// The approval banner, the native option-prompt (AskUserQuestion) card, and
// the resume chooser (map §3.1 renderer/view/approvals.ts, D3 — moved
// verbatim from main.ts). All three read the active view through the
// init-bound atom reference; the approval/resume BUTTONS live in the static
// template and keep their boot-bound listeners in main.ts — this module only
// projects state into them. The option-prompt flow (answerOptionPrompt) and
// the option-select grammar route through the actions seam.

import type { OptionPromptDetectedEvent } from "../../shared/types/events";
import {
  approvalKindLabel,
  approvalTitle,
  formatIdleDuration,
  formatTokenCount,
} from "../../reading-core/selectors/formatters";
import {
  activeTaskView,
  type OptionPromptReceipt,
  type RendererState,
  type TaskViewState,
} from "../../reading-core/state";
import { elements } from "../dom";
import { actions } from "../actions";

/** The shell's state atom, bound once at boot for the cards' read paths. */
let state: RendererState;

export function initApprovalsView(stateRef: RendererState): void {
  state = stateRef;
}

export function renderResumeChoice(): void {
  const view = activeTaskView(state);
  const choice = view?.resumeChoice ?? null;
  elements.resumeChoice.classList.toggle("hidden", !choice);
  if (!choice) {
    return;
  }
  const choiceInteractive =
    state.sessionLifecycle.phase === "awaiting-resume-choice" &&
    state.sessionLifecycle.taskId === view?.task?.id;
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
    elements.approvalContext.replaceChildren();
    elements.approveSessionApproval.classList.add("hidden");
    return;
  }

  elements.approveApproval.disabled = false;
  elements.denyApproval.disabled = false;

  // The middle button is a faithful projection of the panel's own option 2:
  // session-scoped ("Allow for this session") or persistent ("Don't ask
  // again" — Claude writes its own allow rule; Duet receipts the write).
  const middleChoice =
    approval.choices?.find(
      (choice) => choice.decision === "approve-always" || choice.decision === "approve-for-session",
    ) ?? null;
  const approveChoice = approval.choices?.find((choice) => choice.decision === "approve") ?? null;
  elements.approvalBanner.dataset.approvalKind = approval.kind;
  elements.approvalKindBadge.textContent = approvalKindLabel(approval.kind);
  // The card leads with the ONE thing that matters: what the agent wants to do
  // (from the hook's tool_name/tool_input). Scrape cards (no summary — Codex /
  // the broker's timeout fallback) fall back to the generic kind title. The
  // low-level context (source, run, native key encodings) is deliberately gone.
  elements.approvalTitle.textContent = approval.summary?.trim() || approvalTitle(approval.kind);
  elements.approvalSummary.textContent = "";
  elements.approvalSummary.classList.add("hidden");
  elements.approvalContext.replaceChildren();
  elements.approveSessionApproval.classList.toggle("hidden", !middleChoice);
  elements.approveSessionApproval.disabled = !middleChoice;
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
}

// ── Native option prompt (AskUserQuestion) card (Slice 5) ────────────────────

export function renderOptionPrompt(): void {
  const view = activeTaskView(state);
  const card = elements.optionPromptCard;
  const pending = view?.pendingOptionPrompt ?? null;
  const receipt = view?.optionPromptReceipt ?? null;
  if (!view || (!pending && !receipt)) {
    card.classList.add("hidden");
    card.removeAttribute("data-state");
    card.replaceChildren();
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
}

function renderOptionPromptForm(
  view: TaskViewState,
  prompt: OptionPromptDetectedEvent["payload"],
): HTMLElement {
  const busy = view.optionPromptBusy;
  // The card injects only the VERIFIED single-select sequence. If ANY question
  // is multiSelect, the whole card is shown as full context and answered in the
  // terminal (the multi-select TUI mechanic is not yet verified — a guessed
  // injection could mis-answer a real clarification). All-single-select
  // prompts stay fully card-answerable.
  const hasMultiSelect = prompt.questions.some((q) => q.multiSelect);
  const cardAnswerable = !hasMultiSelect;
  const interactive = cardAnswerable && !busy;

  const root = document.createElement("div");
  root.className = "option-prompt-body";

  const heading = document.createElement("div");
  heading.className = "option-prompt-heading";
  const eyebrow = document.createElement("p");
  eyebrow.className = "eyebrow";
  eyebrow.textContent = "Claude is asking";
  const sub = document.createElement("span");
  sub.className = "option-prompt-sub";
  sub.textContent =
    prompt.questions.length > 1 ? `${prompt.questions.length} questions` : "Choose an option";
  heading.append(eyebrow, sub);
  root.append(heading);

  // The questions scroll; the heading above and the footer below stay pinned,
  // so a tall multi-question card never hides a question or the action.
  const scroll = document.createElement("div");
  scroll.className = "option-prompt-scroll";

  prompt.questions.forEach((question, qIndex) => {
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
    if (question.multiSelect) {
      const tag = document.createElement("span");
      tag.className = "option-prompt-multi-tag";
      tag.textContent = "choose one or more";
      qHead.append(tag);
    }
    block.append(qHead);

    const options = document.createElement("div");
    options.className = "option-prompt-options";
    question.options.forEach((option, oIndex) => {
      // multiSelect options are read-only checkboxes (answered in the terminal);
      // single-select options are clickable radios when the card is answerable.
      const selectable = interactive && !question.multiSelect;
      const selected = !question.multiSelect && view.optionPromptSelections[qIndex] === oIndex;
      const button = document.createElement("button");
      button.type = "button";
      button.className = "option-prompt-option";
      button.classList.toggle("checkbox", question.multiSelect);
      button.classList.toggle("selected", selected);
      button.setAttribute("aria-pressed", String(selected));
      button.disabled = !selectable;

      const marker = document.createElement("span");
      marker.className = "option-prompt-marker";
      marker.textContent = question.multiSelect ? "☐" : String(oIndex + 1);
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
      if (selectable) {
        button.addEventListener("click", () => {
          actions.selectOptionPromptChoice(view, qIndex, oIndex);
        });
      }
      options.append(button);
    });
    block.append(options);
    scroll.append(block);
  });
  root.append(scroll);

  const footActions = document.createElement("div");
  footActions.className = "option-prompt-actions";
  if (cardAnswerable) {
    const hint = document.createElement("span");
    hint.className = "option-prompt-hint";
    hint.textContent = "Or answer in the CLI";
    const send = document.createElement("button");
    send.type = "button";
    send.className = "primary";
    const allAnswered =
      view.optionPromptSelections.length === prompt.questions.length &&
      view.optionPromptSelections.every((s) => s >= 0);
    send.textContent = busy ? "Sending…" : "Send answers";
    send.disabled = busy || !allAnswered;
    send.addEventListener("click", () => {
      actions.answerOptionPrompt();
    });
    footActions.append(hint, send);
  } else {
    // Context-only (has a multiSelect question): the questions are legible here
    // in the main view; the answer is given in the terminal (one click away).
    // The action shares the attention-banner family's style — same duty
    // ("waiting for you in the Terminal"), same visual voice (S5).
    const note = document.createElement("span");
    note.className = "option-prompt-hint";
    note.textContent = "Multiple-choice — choose in the CLI, then submit";
    const open = document.createElement("button");
    open.type = "button";
    open.className = "attention-open-terminal";
    open.textContent = "Answer in CLI →";
    open.addEventListener("click", () => {
      actions.setViewMode("terminal");
    });
    footActions.append(note, open);
  }
  root.append(footActions);
  return root;
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
