// The transcript reading surface (map §3.1 renderer/view/transcript.ts, D2
// — R1 territory, moved VERBATIM from main.ts). This module owns the run
// list's streaming render path: the keyed reference-identity reconcile, the
// two persistent nodes (sticky-prompt rail FIRST child, status strip LAST
// child — both skipped by the reconcile and setNonRailChildren paths), the
// scroll contract (nearBottom <=64px captured BEFORE reconcile,
// previousScrollTop restored after, finalize = restorePromptNavAfterRender
// then scheduleStickyPromptSync — in that order), the turn-card e2e beacons
// (data-key/sig/turnKey/runId/runStatus, .turn-outcome-note), and the
// markdown render memo. Shell behavior (mode switch, prompt-nav, T4, the
// entry panel) arrives through the actions seam; state is read through the
// module-bound atom reference (initTranscriptView, bound by main.ts at boot
// before the first render — R4) via the activeTaskView(state) helper
// (D-early ruling 1: one view→state mechanism).

import DOMPurify from "dompurify";
import { marked } from "marked";
import { Check, Copy, Image as ImageIcon } from "lucide";
import { planKeyedReconcile } from "../../shared/keyed-reconcile";
import type { TranscriptBlock } from "../../shared/types/transcript";
import type { RuntimeRunReport } from "../../shared/schemas";
import {
  assistantReplyContent,
  buildReadingTurns,
  createTurnSignatureTracker,
  imageAttachmentLabel,
  userPromptDisplay,
  type ReadingTurn,
} from "../../reading-core/selectors/turns";
import {
  completionErrorExcerpt,
  isActiveRunStatus,
  runOutcome,
  runTone,
} from "../../reading-core/selectors/runs";
import {
  formatTranscriptTimestamp,
  providerLabel,
} from "../../reading-core/selectors/formatters";
import {
  activeTaskView,
  type RendererState,
  type TaskViewState,
} from "../../reading-core/state";
import { isReadingNearBottom } from "../../reading-core/reading-scroll";
import { elements } from "../dom";
import { actions } from "../actions";
import { lucideIcon } from "./icons";

/** The shell's state atom, bound once at boot for the surface's read paths. */
let state: RendererState;
/** Cross-view composition dep (D-early ruling 2 refined at review 2026-07-04):
 *  the no-task empty state composes the New Chat entry panel, but view→view
 *  imports stay outside the fence — main.ts provides the composer at boot.
 *  An init-bound DEP, not an Action: composition is wiring, not behavior. */
let composeEntryPanel: () => HTMLElement;

export function initTranscriptView(
  stateRef: RendererState,
  deps: { composeEntryPanel: () => HTMLElement },
): void {
  state = stateRef;
  composeEntryPanel = deps.composeEntryPanel;
}

// The turn-signature tracker is process-local (block render versions live in
// a WeakMap keyed by block reference) — the renderer holds this singleton;
// fixtures create fresh instances (map §2.4).
const turnSignatureTracker = createTurnSignatureTracker();

// T19 — successful-copy feedback. The deadline lives outside the button DOM:
// a streaming block can replace its whole turn card every ~160 ms, but the
// promised three-second Check must survive that replacement. Ephemeral shell
// truth only — never reducer state, never persistence.
const COPY_FEEDBACK_MS = 3_000;
const copiedUntilByTarget = new Map<string, number>();
const copyResetTimerByTarget = new Map<string, number>();

function refreshTurnCardCheap(card: HTMLElement, view: TaskViewState, turn: ReadingTurn): void {
  if (turn.runId) {
    card.classList.toggle("highlighted", turn.runId === view.highlightedRunId);
  }
}

// R3: the sticky-prompt rail is a persistent node — created once, kept as the
// runList's first child — so a streaming batch never tears it down.
function ensureStickyPromptRail(runList: HTMLElement): HTMLElement {
  let rail = runList.querySelector<HTMLElement>(".sticky-prompt-rail");
  if (!rail) {
    rail = renderStickyPromptRail();
    runList.prepend(rail);
  } else if (runList.firstChild !== rail) {
    runList.prepend(rail);
  }
  return rail;
}

// The no-task (entry panel) path is not the streaming path and needs no reconcile:
// drop everything after the persistent rail and set the given nodes. The
// status strip is the run list's second persistent node (its live LAST child)
// — never removed, content always inserted before it.
function setNonRailChildren(runList: HTMLElement, rail: HTMLElement, nodes: HTMLElement[]): void {
  const strip = elements.statusStrip;
  let cursor = rail.nextSibling;
  while (cursor) {
    const next = cursor.nextSibling;
    if (cursor !== strip) {
      runList.removeChild(cursor);
    }
    cursor = next;
  }
  for (const node of nodes) {
    runList.insertBefore(node, strip);
  }
}

interface ReconcileChild {
  key: string;
  sig: string;
  render: () => HTMLElement;
  refresh?: (node: HTMLElement) => void;
}

// Keyed DOM reconcile of the runList's turn cards against the desired turns.
// Reused nodes already in order are never detached → their text selection
// survives across streaming batches. Non-reused nodes (stale, changed, or
// non-keyed leftovers like the entry panel) are removed up front so the
// positioning cursor only ever references nodes that stay.
function reconcileKeyedChildren(
  parent: HTMLElement,
  rail: HTMLElement,
  items: ReconcileChild[],
): void {
  const existing = new Map<string, HTMLElement>();
  for (const child of Array.from(parent.children) as HTMLElement[]) {
    if (child === rail || child === elements.statusStrip) {
      continue;
    }
    const key = child.dataset.key;
    if (key !== undefined) {
      existing.set(key, child);
    }
  }
  const plan = planKeyedReconcile(
    Array.from(existing, ([key, node]) => ({ key, sig: node.dataset.sig ?? "" })),
    items.map((item) => ({ key: item.key, sig: item.sig })),
  );
  const reuseKeys = new Set(
    plan.ordered.filter((step) => step.action === "reuse").map((step) => step.key),
  );
  for (const child of Array.from(parent.children) as HTMLElement[]) {
    if (child === rail || child === elements.statusStrip) {
      continue;
    }
    const key = child.dataset.key;
    if (key === undefined || !reuseKeys.has(key)) {
      child.remove();
    }
  }
  const itemByKey = new Map(items.map((item) => [item.key, item]));
  let cursor: ChildNode | null = rail.nextSibling;
  for (const step of plan.ordered) {
    const item = itemByKey.get(step.key);
    if (!item) {
      continue;
    }
    let node: HTMLElement;
    if (step.action === "reuse") {
      node = existing.get(step.key)!;
      item.refresh?.(node);
    } else {
      node = item.render();
      node.dataset.key = item.key;
      node.dataset.sig = item.sig;
    }
    if (node === cursor) {
      cursor = node.nextSibling;
    } else {
      parent.insertBefore(node, cursor);
    }
  }
}

export function renderRuns(): void {
  const runList = elements.runList;
  const nearBottom = isReadingNearBottom(runList);
  const previousScrollTop = runList.scrollTop;
  const rail = ensureStickyPromptRail(runList);

  const view = activeTaskView(state);
  if (!view?.task) {
    setNonRailChildren(runList, rail, [composeEntryPanel()]);
    finalizeReadingSurfaceRender(nearBottom, previousScrollTop);
    return;
  }

  const turns = buildReadingTurns(view);
  // Zero turns on an active task is normally just the sub-second gap before the
  // first run lands (deferred creation) — but a failed first delivery or a
  // persisted empty session can leave it durably empty too. Either way the keyed
  // reconcile below clears to just the rail + strip on an empty list, so 0 turns
  // renders as nothing. No placeholder: an "empty" banner only ever flashed, and
  // blank is the honest render for a genuinely empty task (removed 2026-07-05).
  reconcileKeyedChildren(
    runList,
    rail,
    turns.map((turn) => ({
      key: turn.key,
      sig: turnSignatureTracker.turnSignature(turn),
      render: () => renderTurn(view, turn),
      refresh: (node) => refreshTurnCardCheap(node, view, turn),
    })),
  );

  finalizeReadingSurfaceRender(nearBottom, previousScrollTop);
}

function finalizeReadingSurfaceRender(nearBottom: boolean, previousScrollTop: number): void {
  const runList = elements.runList;
  runList.scrollTop = nearBottom ? runList.scrollHeight : previousScrollTop;
  actions.restorePromptNavAfterRender();
  actions.scheduleStickyPromptSync();
}

function renderStickyPromptRail(): HTMLElement {
  const rail = document.createElement("div");
  rail.className = "sticky-prompt-rail";

  const header = document.createElement("button");
  header.id = "sticky-prompt-header";
  header.className = "sticky-prompt-header hidden";
  header.type = "button";
  header.setAttribute("aria-label", "Scroll to the prompt for this reply");
  header.addEventListener("click", () => {
    const turnKey = header.dataset.turnKey;
    if (!turnKey) {
      return;
    }
    actions.scrollToPromptTurn(turnKey);
  });

  rail.append(header);
  return rail;
}

function renderTurn(view: TaskViewState, turn: ReadingTurn): HTMLElement {
  const card = document.createElement("article");
  card.className = "turn-card";
  card.dataset.turnKey = turn.key;
  if (turn.runId) {
    card.dataset.runId = turn.runId;
    card.classList.toggle("highlighted", turn.runId === view.highlightedRunId);
  }

  // A continuation turn (background-workflow reply): transcript blocks with
  // no user-message — the "user" was the CLI's own task-notification, not a
  // person. No user bubble; the muted system-note in the body names what
  // came back.
  const hasUserVoice =
    turn.blocks.length === 0 || turn.blocks.some((block) => block.kind === "user-message");
  if (hasUserVoice) {
    card.append(renderTurnUser(turn));
  }

  const answerBlocks = turn.blocks.filter(isAnswerBlock);
  const noAssistantOutput = turnCompletedWithoutAssistantOutput(turn);
  const liveRun = Boolean(turn.run && isActiveRunStatus(turn.run.status));
  // Machine-readable run state on the card itself: the e2e suite's completion
  // beacon (was `.turn-outcome` in the retired footer) and a debugging hook.
  if (turn.run) {
    card.dataset.runStatus = turn.run.status;
    if (turn.run.completionSource) {
      card.dataset.completionSource = turn.run.completionSource;
    }
  }

  const body = document.createElement("div");
  body.className = "turn-body turn-answer";
  for (const block of answerBlocks) {
    body.append(renderTranscriptBlock(block));
  }
  // A reply-less completed turn speaks ONLY when it has something actionable
  // to say (an API error excerpt). The plain "returned to the prompt without
  // a reply" self-narration retired 2026-07-03: it was Duet reporting an
  // observation gap (idle-heuristic completion, zero blocks), not user
  // information — the co-visible Terminal already shows what happened, and a
  // slash command producing no reply is simply normal.
  const noAssistantErrorExcerpt = completionErrorExcerpt(turn.run);
  if (body.childElementCount === 0 && noAssistantOutput && noAssistantErrorExcerpt) {
    body.append(renderNoAssistantOutput(turn.run));
  }
  // A settled turn with terminal output but no structured transcript: state
  // the degradation instead of impersonating the reply with a scrape dump
  // (retired 2026-07-03 — Reading = reply + state; the real text is in the
  // co-visible Terminal). While the run is still live this stays silent: the
  // status strip owns "working", and blocks usually land moments later.
  if (body.childElementCount === 0 && turn.blocks.length === 0 && turn.fallbackText && !liveRun) {
    body.append(renderTurnFallback());
  }
  if (body.childElementCount > 0) {
    card.append(body);
  }

  // This is ONE whole-reply control, intentionally outside `.turn-answer`:
  // timestamps and controls must not enter answer text selection, quote-copy,
  // or the load-bearing transcript-selection fence. A live response is not a
  // whole response yet; show this row only once the attributed run settles.
  const replyContent = assistantReplyContent(turn.blocks);
  if (replyContent && !liveRun) {
    card.append(renderAssistantMeta(turn.key, replyContent.markdown, replyContent.completedAt));
  }

  // Reading shows the reply and the state, not the process (2026-07-03): the
  // work trace, turn footer, and artifact strip retired — the co-visible
  // Terminal carries process detail live, and forensics live in the provider
  // transcript. What survives per turn: an attention note when a settled run
  // did NOT complete (stopped / failed / denied / pty-exited) — failure IS
  // state, and without it a stopped run would be indistinguishable from a
  // completed one. Live and waiting states belong to the status strip.
  if (turn.run && !liveRun && turn.run.status !== "completed") {
    card.append(renderRunOutcomeNote(turn.run));
  }
  return card;
}

function renderRunOutcomeNote(run: RuntimeRunReport): HTMLElement {
  const note = document.createElement("div");
  note.className = `turn-outcome-note ${runTone(run)}`;
  note.textContent = runOutcome(run, activeProviderLabel());
  return note;
}

// The attachment affordance for the reading bubble. Decorative (icon + count)
// when the turn also has text or a command; the SOLE prompt affordance when the
// prompt was images only — then it carries `.turn-prompt` + a real label so
// prompt-nav can target it and the sticky header shows words, not a bare count
// (review 2026-07-05 P2). Same lucide icon the composer's attachment chip uses.
function imageChip(turnKey: string, count: number, asPrompt = false): HTMLElement {
  const chip = document.createElement("span");
  chip.className = asPrompt ? "turn-image-chip turn-prompt" : "turn-image-chip";
  chip.dataset.turnKey = turnKey;
  chip.append(lucideIcon(ImageIcon, 14));
  const label = imageAttachmentLabel(count);
  if (asPrompt) {
    chip.tabIndex = -1;
    const text = document.createElement("span");
    text.className = "turn-image-chip-label";
    text.textContent = label;
    chip.append(text);
    chip.setAttribute("aria-label", `Prompt: ${label}`);
  } else {
    if (count > 1) {
      const badge = document.createElement("span");
      badge.className = "turn-image-chip-count";
      badge.textContent = String(count);
      chip.append(badge);
    }
    chip.setAttribute("aria-label", label);
  }
  return chip;
}

function renderTurnUser(turn: ReadingTurn): HTMLElement {
  const header = document.createElement("header");
  header.className = "turn-user";
  header.dataset.turnKey = turn.key;

  const userBlock = turn.blocks.find(
    (block): block is Extract<TranscriptBlock, { kind: "user-message" }> =>
      block.kind === "user-message",
  );
  // Bubble text + attachment count derive in the pure selector (reading-core);
  // the view only builds DOM from them. Marker stripping there is display-only
  // and attachment-gated — matching reads through markers separately.
  const { text: displayText, imageCount } = userPromptDisplay(userBlock, turn.run?.prompt ?? "");
  // "Images, no words": the chip must BE the prompt affordance (nav target +
  // sticky label), not a decoration beside a text bubble that isn't there.
  const imageOnly = imageCount > 0 && !displayText && !userBlock?.command;
  if (imageCount > 0) {
    header.append(imageChip(turn.key, imageCount, imageOnly));
  }

  if (userBlock?.command) {
    // A slash command. Claude logs the whole invocation as `<name> <args>`, and
    // for a skill like `/architect <brief>` the args ARE the user's prompt. Show
    // the command name as a small provenance chip, but render that body as the
    // normal growing bubble — full text, the user's own words, never crammed
    // into a fixed-size mono pill. Bare commands (no body) stay as just the chip.
    // The split runs on displayText (markers already stripped) so an image
    // attached to a slash command no longer hides the body behind the prefix.
    const name = userBlock.command;
    const body = displayText.startsWith(name) ? displayText.slice(name.length).trim() : "";
    const chip = document.createElement("span");
    chip.className = body ? "turn-command-chip" : "turn-command-chip turn-prompt";
    chip.tabIndex = -1;
    chip.dataset.turnKey = turn.key;
    chip.textContent = name;
    chip.setAttribute("aria-label", body ? `Command: ${name}` : `Prompt: ${name}`);
    header.append(chip);
    if (body) {
      const prompt = document.createElement("div");
      prompt.className = "turn-user-text turn-prompt";
      prompt.tabIndex = -1;
      prompt.dataset.turnKey = turn.key;
      prompt.textContent = body;
      prompt.setAttribute("aria-label", `Prompt: ${body}`);
      header.append(prompt);
    }
  } else if (!imageOnly) {
    // The text bubble. `(empty prompt)` shows only when there was neither text
    // nor image; an image-only turn is served by the chip affordance above.
    const prompt = document.createElement("div");
    prompt.className = "turn-user-text turn-prompt";
    prompt.tabIndex = -1;
    prompt.dataset.turnKey = turn.key;
    prompt.textContent = displayText || "(empty prompt)";
    prompt.setAttribute("aria-label", `Prompt: ${prompt.textContent}`);
    header.append(prompt);
  }

  const promptTimestamp = userBlock?.ts ?? turn.run?.startedAt ?? null;
  const meta = renderUserPromptMeta(turn.key, displayText, promptTimestamp);
  if (meta) {
    header.append(meta);
  }
  return header;
}

function renderUserPromptMeta(
  turnKey: string,
  copyText: string,
  timestampIso: string | null,
): HTMLElement | null {
  const timestamp = timestampIso ? formatTranscriptTimestamp(timestampIso) : null;
  if (!timestamp && !copyText) {
    return null;
  }
  const meta = document.createElement("div");
  meta.className = "transcript-message-meta turn-user-meta";
  if (timestamp) {
    meta.append(renderMessageTime(timestamp.display, timestamp.dateTime, "Prompt sent"));
  }
  // Image-only and genuinely empty prompts disclose time but no misleading
  // text-copy action. A slash invocation stays whole in displayText, including
  // its command name, even though its visual bubble splits chip from body.
  if (copyText) {
    meta.append(
      transcriptCopyButton({
        targetKey: `${turnKey}:prompt`,
        text: copyText,
        label: "Copy prompt",
      }),
    );
  }
  return meta;
}

function renderAssistantMeta(
  turnKey: string,
  markdown: string,
  completedAt: string,
): HTMLElement {
  const meta = document.createElement("div");
  meta.className = "transcript-message-meta turn-assistant-meta";
  meta.append(
    transcriptCopyButton({
      targetKey: `${turnKey}:reply`,
      text: markdown,
      label: "Copy response",
    }),
  );
  const timestamp = formatTranscriptTimestamp(completedAt);
  if (timestamp) {
    meta.append(renderMessageTime(timestamp.display, timestamp.dateTime, "Response completed"));
  }
  return meta;
}

function renderMessageTime(display: string, dateTime: string, label: string): HTMLTimeElement {
  const time = document.createElement("time");
  time.className = "transcript-message-time";
  time.dateTime = dateTime;
  time.textContent = display;
  time.setAttribute("aria-label", `${label} ${display}`);
  return time;
}

function isAnswerBlock(
  block: TranscriptBlock,
): block is Extract<TranscriptBlock, { kind: "assistant-text" | "system-note" }> {
  return block.kind === "assistant-text" || block.kind === "system-note";
}

function turnCompletedWithoutAssistantOutput(turn: ReadingTurn): boolean {
  return Boolean(
    turn.run?.status === "completed" &&
      turn.run.completionSource === "terminal-idle-heuristic" &&
      !turn.blocks.some((block) => block.kind !== "user-message"),
  );
}

// Only answer blocks reach the card now — the process blocks (thinking,
// tool calls, plan, agents) stay in the data layer for the status strip and
// the provider transcript; Reading no longer renders them (2026-07-03).
function renderTranscriptBlock(block: TranscriptBlock): HTMLElement {
  if (block.kind === "assistant-text") {
    return markdownBody(block.markdown, block.id);
  }
  const note = document.createElement("div");
  note.className = "turn-system-note";
  note.textContent = block.kind === "system-note" ? block.text : "";
  return note;
}

// The scrape buffer (runTranscripts) remains the EVIDENCE that a reply
// happened — it just no longer renders. Same family as renderNoAssistantOutput.
function renderTurnFallback(): HTMLElement {
  const note = document.createElement("div");
  note.className = "turn-system-note degraded";
  const copy = document.createElement("div");
  copy.textContent = `${activeProviderLabel()} replied, but the reply could not be read structurally — the full text is in the CLI.`;
  const action = document.createElement("button");
  action.className = "secondary turn-terminal-action";
  action.type = "button";
  action.textContent = "Open CLI";
  action.addEventListener("click", () => {
    actions.setViewMode("terminal");
  });
  note.append(copy, action);
  return note;
}

// Only the error-carrying variant survives (the caller gates on a present
// excerpt): a reply-less turn WITH an API error is actionable; without one,
// the card stays quiet — see the renderTurn comment.
function renderNoAssistantOutput(run: RuntimeRunReport | null): HTMLElement {
  const errorExcerpt = completionErrorExcerpt(run);
  const note = document.createElement("div");
  note.className = "turn-system-note attention";

  const copy = document.createElement("div");
  copy.textContent = `${providerLabelForRun(run)} returned to the prompt without a reply. A provider/API error likely occurred.`;
  const excerpt = document.createElement("pre");
  excerpt.className = "turn-error-excerpt";
  excerpt.textContent = errorExcerpt;
  const action = document.createElement("button");
  action.className = "secondary turn-terminal-action";
  action.type = "button";
  action.textContent = "Open CLI";
  action.addEventListener("click", () => {
    actions.setViewMode("terminal");
  });
  note.append(copy, excerpt, action);
  return note;
}

const markdownSanitizerConfig = {
  USE_PROFILES: { html: true },
  FORBID_TAGS: ["style", "form", "input", "button"],
  // DOMPurify allows data-* by default. The S4 file-chip enhancement adds
  // data-chip-* AFTER sanitize; forbidding them here means raw assistant HTML
  // can never forge a node that looks like a resolver-validated chip (the click
  // trust boundary also lives in chipRegistry — view/transcript-chips.ts).
  FORBID_ATTR: ["data-chip-path", "data-chip-task", "data-chip-state", "data-chip-mention"],
};

const markdownHtmlCache = new Map<string, string>();

function markdownBody(markdown: string, blockId: string): HTMLElement {
  const body = document.createElement("div");
  body.className = "md-body";
  let html = markdownHtmlCache.get(markdown);
  if (html === undefined) {
    html = DOMPurify.sanitize(marked.parse(markdown, { async: false }), markdownSanitizerConfig);
    markdownHtmlCache.set(markdown, html);
  }
  body.innerHTML = html;
  enhanceCodeBlocks(body, blockId);
  return body;
}

function enhanceCodeBlocks(body: HTMLElement, blockId: string): void {
  const codeBlocks = Array.from(body.querySelectorAll<HTMLPreElement>("pre"));
  for (const [index, pre] of codeBlocks.entries()) {
    const wrapper = document.createElement("div");
    wrapper.className = "transcript-code-block";
    pre.before(wrapper);
    wrapper.append(pre);
    const codeText = pre.querySelector("code")?.textContent ?? pre.textContent ?? "";
    const copy = transcriptCopyButton({
      targetKey: `${blockId}:code:${index}`,
      text: codeText,
      label: "Copy code",
      className: "code-block-copy",
    });
    wrapper.append(copy);
  }
}

interface TranscriptCopyButtonOptions {
  targetKey: string;
  text: string;
  label: string;
  className?: string;
}

function transcriptCopyButton(options: TranscriptCopyButtonOptions): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.className = options.className
    ? `transcript-copy-button ${options.className}`
    : "transcript-copy-button";
  button.dataset.copyTarget = options.targetKey;
  button.dataset.copyLabel = options.label;
  syncCopyButton(button);
  button.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(options.text);
      markCopySucceeded(options.targetKey);
    } catch {
      markCopyFailed(options.targetKey);
    }
  });
  return button;
}

function markCopySucceeded(targetKey: string): void {
  const copiedUntil = Date.now() + COPY_FEEDBACK_MS;
  copiedUntilByTarget.set(targetKey, copiedUntil);
  syncCopyTarget(targetKey);

  const previousTimer = copyResetTimerByTarget.get(targetKey);
  if (previousTimer !== undefined) {
    window.clearTimeout(previousTimer);
  }
  const timer = window.setTimeout(() => {
    copyResetTimerByTarget.delete(targetKey);
    if ((copiedUntilByTarget.get(targetKey) ?? 0) <= Date.now()) {
      copiedUntilByTarget.delete(targetKey);
      syncCopyTarget(targetKey);
    }
  }, COPY_FEEDBACK_MS);
  copyResetTimerByTarget.set(targetKey, timer);
}

function markCopyFailed(targetKey: string): void {
  copiedUntilByTarget.delete(targetKey);
  const previousTimer = copyResetTimerByTarget.get(targetKey);
  if (previousTimer !== undefined) {
    window.clearTimeout(previousTimer);
    copyResetTimerByTarget.delete(targetKey);
  }
  // Address the stable target, not the click-time node: the Promise may reject
  // after streaming reconcile has detached that button and mounted a new one.
  const buttons = copyButtonsForTarget(targetKey);
  for (const button of buttons) {
    syncCopyButton(button); // restores the Copy glyph immediately
    button.dataset.copyState = "error";
    button.setAttribute("aria-label", "Copy failed. Try again");
    button.title = "Copy failed. Try again";
  }
}

function syncCopyTarget(targetKey: string): void {
  for (const button of copyButtonsForTarget(targetKey)) {
    syncCopyButton(button);
  }
}

function copyButtonsForTarget(targetKey: string): HTMLButtonElement[] {
  return Array.from(
    document.querySelectorAll<HTMLButtonElement>(".transcript-copy-button"),
  ).filter((button) => button.dataset.copyTarget === targetKey);
}

function syncCopyButton(button: HTMLButtonElement): void {
  const targetKey = button.dataset.copyTarget ?? "";
  const label = button.dataset.copyLabel ?? "Copy";
  const copied = (copiedUntilByTarget.get(targetKey) ?? 0) > Date.now();
  button.dataset.copyState = copied ? "copied" : "idle";
  button.setAttribute("aria-label", copied ? "Copied" : label);
  button.title = copied ? "Copied" : label;
  button.replaceChildren(lucideIcon(copied ? Check : Copy, 16));
}

function providerLabelForRun(_run: RuntimeRunReport | null): string {
  return activeProviderLabel();
}

function activeProviderLabel(): string {
  const provider = activeTaskView(state)?.task?.provider;
  return provider ? providerLabel(provider) : "Codex";
}
