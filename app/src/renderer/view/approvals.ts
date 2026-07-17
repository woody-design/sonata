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
  isSessionLifecycleActive,
  optionPromptDraftsComplete,
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
  // Drawer S1: the full answer grammar is verified (single-select, multi-select
  // toggles, free-text — spikes/drawer-option-prompt-probe), so every prompt is
  // card-answerable. Multi-select options toggle; the send is corroborated by
  // the controller (a swallowed injection surfaces as an error, not a receipt).
  const interactive = !busy;

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
      // Single-select options are radios (pick one); multiSelect options are
      // toggling checkboxes (drawer S1). Both clickable while not busy.
      const selectable = interactive;
      const selected = (view.optionPromptDrafts[qIndex]?.optionIndices ?? []).includes(oIndex);
      const button = document.createElement("button");
      button.type = "button";
      button.className = "option-prompt-option";
      button.classList.toggle("checkbox", question.multiSelect);
      button.classList.toggle("selected", selected);
      button.setAttribute("aria-pressed", String(selected));
      button.disabled = !selectable;

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
