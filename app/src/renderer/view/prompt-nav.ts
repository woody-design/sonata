// Prompt navigation + the sticky-prompt header (map §3.1
// renderer/view/prompt-nav.ts, D3 — the §1.6 DOM-owned family, moved
// verbatim from main.ts AS A UNIT: nav targets are queried from the DOM
// (.turn-prompt), selection is synced back onto the cards, and the sticky
// header reads live card geometry. The T4 rAF coalesce
// (scheduleStickyPromptSync) moves verbatim inside. The family's direct
// state.promptNav writes are its intrinsic selection choreography (not
// handler grammar) and move with it — logged. The G2 IME guard stays
// shell-owned: the view receives an isComposerComposing read at init
// (initPromptNavView), mirroring chrome's resolvedReadingMode seam.
// The document-level keydown/mousedown bindings stay boot wiring in
// main.ts.

import {
  clamp,
  condensedPromptText,
} from "../../reading-core/selectors/formatters";
import type {
  PromptNavState,
  RendererState,
} from "../../reading-core/state";
import { elements } from "../dom";

/** The shell's state atom + the G2 composition read, bound once at boot. */
let state: RendererState;
let composerIsComposing: () => boolean;

export function initPromptNavView(
  stateRef: RendererState,
  deps: { isComposerComposing: () => boolean },
): void {
  state = stateRef;
  composerIsComposing = deps.isComposerComposing;
}

let stickyPromptSyncFrame: number | null = null;
const PROMPT_NAV_DOM_TASK_ID = "__active-transcript-dom__";

export function handlePromptNavigationKeydown(event: KeyboardEvent): void {
  if (event.isComposing || composerIsComposing() || event.keyCode === 229) {
    return;
  }

  if (state.promptNav) {
    if (hasStackedUiOpen()) {
      return;
    }
    if (isPromptNavArrow(event)) {
      event.preventDefault();
      event.stopPropagation();
      movePromptNav(event.key === "ArrowUp" ? -1 : 1);
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      exitPromptNav({ focusComposer: true });
      return;
    }
    if (isPrintablePromptNavTyping(event)) {
      event.preventDefault();
      event.stopPropagation();
      exitPromptNav({ focusComposer: true, insertText: event.key });
    }
    return;
  }

  if (!isPromptNavEntryShortcut(event) || hasStackedUiOpen() || !isPromptNavEntryContext(event.target)) {
    return;
  }
  if (enterPromptNav()) {
    event.preventDefault();
    event.stopPropagation();
  }
}

function isPromptNavEntryShortcut(event: KeyboardEvent): boolean {
  return (
    event.key === "ArrowUp" &&
    event.metaKey &&
    !event.ctrlKey &&
    !event.altKey &&
    !event.shiftKey
  );
}

function isPromptNavArrow(event: KeyboardEvent): boolean {
  const arrow = event.key === "ArrowUp" || event.key === "ArrowDown";
  if (!arrow || event.ctrlKey || event.altKey || event.shiftKey) {
    return false;
  }
  return true;
}

function isPrintablePromptNavTyping(event: KeyboardEvent): boolean {
  return event.key.length === 1 && !event.metaKey && !event.ctrlKey;
}

function isPromptNavEntryContext(target: EventTarget | null): boolean {
  const node = target instanceof Node ? target : null;
  if (!node) {
    return false;
  }
  return (
    elements.composer.contains(node) ||
    elements.runList.contains(node) ||
    document.activeElement === document.body
  );
}

function hasStackedUiOpen(): boolean {
  return Boolean(
    state.readingPopoverOpen ||
      state.composerMenu ||
      state.taskDraft.menu ||
      state.settingsOverlay,
  );
}

function enterPromptNav(): boolean {
  const targets = promptNavTargets();
  const target = targets.at(-1) ?? null;
  if (!target) {
    return false;
  }
  const selection = composerSelectionSnapshot();
  state.promptNav = {
    taskId: activePromptNavTaskId(),
    turnKey: target.dataset.turnKey ?? "",
    composerSelectionStart: selection.start,
    composerSelectionEnd: selection.end,
  };
  return selectPromptNavTarget(target, { scroll: true });
}

function movePromptNav(delta: -1 | 1): void {
  const targets = promptNavTargets();
  if (targets.length === 0 || !state.promptNav) {
    exitPromptNav({ focusComposer: false });
    return;
  }

  const currentIndex = targets.findIndex((target) => target.dataset.turnKey === state.promptNav?.turnKey);
  const index = currentIndex === -1 ? targets.length - 1 : currentIndex;
  const nextIndex = index + delta;
  if (nextIndex < 0) {
    selectPromptNavTarget(targets[0], { scroll: false });
    return;
  }
  if (nextIndex >= targets.length) {
    exitPromptNav({ focusComposer: true });
    return;
  }
  selectPromptNavTarget(targets[nextIndex], { scroll: true });
}

function selectPromptNavTarget(
  target: HTMLElement | undefined,
  options: { scroll: boolean },
): boolean {
  if (!target) {
    return false;
  }
  const turnKey = target.dataset.turnKey;
  if (!turnKey) {
    return false;
  }
  const previous = state.promptNav;
  const selection = previous ?? {
    composerSelectionStart: elements.promptInput.selectionStart ?? elements.promptInput.value.length,
    composerSelectionEnd: elements.promptInput.selectionEnd ?? elements.promptInput.value.length,
  };
  state.promptNav = {
    taskId: activePromptNavTaskId(),
    turnKey,
    composerSelectionStart: selection.composerSelectionStart,
    composerSelectionEnd: selection.composerSelectionEnd,
  };
  syncPromptNavDomSelection();
  if (options.scroll) {
    target.scrollIntoView({ block: "start", inline: "nearest", behavior: "auto" });
  }
  target.focus({ preventScroll: true });
  return true;
}

export function exitPromptNav(options: { focusComposer: boolean; insertText?: string }): void {
  const previous = state.promptNav;
  if (!previous) {
    return;
  }
  state.promptNav = null;
  syncPromptNavDomSelection();
  if (!options.focusComposer) {
    return;
  }
  focusComposerFromPromptNav(previous);
  if (options.insertText !== undefined) {
    insertTextIntoComposer(options.insertText);
  }
}

function focusComposerFromPromptNav(nav: PromptNavState): void {
  if (elements.promptInput.disabled) {
    return;
  }
  elements.promptInput.focus({ preventScroll: true });
  const start = clamp(nav.composerSelectionStart, 0, elements.promptInput.value.length);
  const end = clamp(nav.composerSelectionEnd, start, elements.promptInput.value.length);
  elements.promptInput.setSelectionRange(start, end);
}

function insertTextIntoComposer(text: string): void {
  if (elements.promptInput.disabled) {
    return;
  }
  const start = elements.promptInput.selectionStart ?? elements.promptInput.value.length;
  const end = elements.promptInput.selectionEnd ?? start;
  elements.promptInput.setRangeText(text, start, end, "end");
  elements.promptInput.dispatchEvent(new Event("input", { bubbles: true }));
}

export function restorePromptNavAfterRender(): void {
  const nav = state.promptNav;
  if (!nav) {
    return;
  }
  if (nav.taskId !== activePromptNavTaskId()) {
    state.promptNav = null;
    return;
  }
  const target = findPromptNavTarget(nav.turnKey);
  if (!target) {
    state.promptNav = null;
    return;
  }
  syncPromptNavDomSelection();
  target.focus({ preventScroll: true });
}

function syncPromptNavDomSelection(): void {
  const nav = state.promptNav;
  for (const target of promptNavTargets()) {
    const selected =
      nav !== null &&
      nav.taskId === activePromptNavTaskId() &&
      target.dataset.turnKey === nav.turnKey;
    target.classList.toggle("prompt-nav-selected", selected);
    if (selected) {
      target.setAttribute("aria-current", "true");
    } else {
      target.removeAttribute("aria-current");
    }
  }
}

function promptNavTargets(): HTMLElement[] {
  return Array.from(elements.runList.querySelectorAll<HTMLElement>(".turn-prompt"));
}

function findPromptNavTarget(turnKey: string): HTMLElement | null {
  return promptNavTargets().find((target) => target.dataset.turnKey === turnKey) ?? null;
}

function activePromptNavTaskId(): string {
  return state.activeTaskId ?? PROMPT_NAV_DOM_TASK_ID;
}

function composerSelectionSnapshot(): { start: number; end: number } {
  const fallback = elements.promptInput.value.length;
  return {
    start: elements.promptInput.selectionStart ?? fallback,
    end: elements.promptInput.selectionEnd ?? fallback,
  };
}

export function scheduleStickyPromptSync(): void {
  if (stickyPromptSyncFrame !== null) {
    return;
  }
  stickyPromptSyncFrame = window.requestAnimationFrame(() => {
    stickyPromptSyncFrame = null;
    syncStickyPromptHeader();
  });
}

function syncStickyPromptHeader(): void {
  const header = elements.runList.querySelector<HTMLButtonElement>(".sticky-prompt-header");
  if (!header) {
    return;
  }
  const candidate = stickyPromptCandidate();
  if (!candidate) {
    hideStickyPromptHeader(header);
    return;
  }

  const listRect = elements.runList.getBoundingClientRect();
  const promptRect = candidate.prompt.getBoundingClientRect();
  if (promptRect.bottom > listRect.top) {
    hideStickyPromptHeader(header);
    return;
  }

  const text = condensedPromptText(candidate.prompt.textContent ?? "");
  header.textContent = text;
  header.title = text;
  header.dataset.turnKey = candidate.card.dataset.turnKey ?? "";
  header.classList.remove("hidden");
}

function hideStickyPromptHeader(header: HTMLButtonElement): void {
  header.classList.add("hidden");
  header.textContent = "";
  header.title = "";
  delete header.dataset.turnKey;
}

function stickyPromptCandidate(): { card: HTMLElement; prompt: HTMLElement } | null {
  const listRect = elements.runList.getBoundingClientRect();
  if (listRect.height <= 0) {
    return null;
  }
  const eyeY = listRect.top + Math.min(96, listRect.height * 0.28);
  const cards = Array.from(elements.runList.querySelectorAll<HTMLElement>(".turn-card"));

  for (const card of cards) {
    const rect = card.getBoundingClientRect();
    if (rect.top <= eyeY && rect.bottom > eyeY) {
      const prompt = card.querySelector<HTMLElement>(".turn-prompt");
      return prompt ? { card, prompt } : null;
    }
  }

  for (const card of cards) {
    const rect = card.getBoundingClientRect();
    if (rect.top < listRect.bottom && rect.bottom > listRect.top) {
      const prompt = card.querySelector<HTMLElement>(".turn-prompt");
      if (prompt && prompt.getBoundingClientRect().bottom <= listRect.top) {
        return { card, prompt };
      }
    }
  }

  return null;
}

export function scrollToPromptTurn(turnKey: string): void {
  const target = findPromptNavTarget(turnKey);
  target?.scrollIntoView({ block: "start", inline: "nearest", behavior: "auto" });
  scheduleStickyPromptSync();
}
