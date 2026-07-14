// Quote & Comment — the view family (plan
// `product-thinking/2026-07-14-quote-comment-plan-v0.md` §Interaction contract).
// Select transcript text → a floating comment trigger appears above the
// selection → mousedown opens an inline input bar → confirm appends a serialized
// paragraph to the composer. After that it is plain composer text (D1): no
// persistence, no anchor, no state-atom footprint.
//
// This module owns a purely LOCAL lifecycle — the trigger, the bar, and the
// pending-quote highlight are shell-satellite truth (like the IME guards or the
// composer text), never in RendererState. It reaches the reducer's world through
// exactly one init-bound dep: `appendToComposer` (implemented in main.ts). It
// takes no state ref, because "does this selection qualify?" is answered from
// the DOM (does the range intersect a `.turn-card` inside `#run-list`?), not from
// the active-task projection — the one honest reason it diverges from
// transcript-chips.ts, the canonical init-bound view.
//
// Reconcile-safety (ARCHITECTURE.md "State"): a captured Range may die when the
// streaming turn card rebuilds (~160 ms). We NEVER depend on it staying alive —
// the quote STRING is captured at trigger-mousedown, so confirm completes even
// if the highlight (which needs a live Range) silently vanishes.
//
// Timing (ARCHITECTURE.md "Scheduling"): T17 — 150 ms selectionchange debounce;
// T18 — reposition rAF (run-list scroll + window resize). View-local, per the
// scheduler's convention for surface-owned timers (cf. T4/T7/T9–T13).

import { formatQuoteComment, normalizeQuote } from "../../reading-core/quote-comment";
import { elements } from "../dom";
import { commentGlyph, lucideIcon } from "./icons";
import { positionCenteredAbove } from "./popover-geometry";
import { Check } from "lucide";

/** The name registered in `CSS.highlights` and matched by
 *  `::highlight(duet-quote-pending)` in styles.css. */
const PENDING_HIGHLIGHT = "duet-quote-pending";
const SELECTION_DEBOUNCE_MS = 150; // T17
// Mirror of the composer's G2 window (main.ts COMPOSITION_END_SHORTCUT_GUARD_MS):
// a candidate-commit Enter can arrive just after compositionend with
// isComposing already false. Swallow Enter/Escape for this long afterward.
const COMPOSITION_END_GUARD_MS = 80;

/** The behaviors this view reaches into the shell for. */
export interface QuoteCommentDeps {
  /** Append the serialized paragraph to the composer draft and run the normal
   *  post-input path (controls re-render + slash-picker sync). Implemented in
   *  main.ts. MUST NOT steal focus from wherever the user is (D6). */
  appendToComposer(paragraph: string): void;
  /** A stable identity for the composer's current owner (active task id, or a
   *  new-chat sentinel). Captured when the bar opens; re-read on confirm to drop
   *  the append if a programmatic task switch reparked the shared textarea onto a
   *  different session while the bar was open. */
  composerOwnerToken(): string;
}

/** Captured at trigger-mousedown, before the browser can collapse the
 *  selection. `quoteText` is the durable truth; `clonedRange` is best-effort
 *  (only powers the highlight, may die on a streaming rebuild). */
interface QuoteCapture {
  quoteText: string;
  clonedRange: Range;
  anchorRect: DOMRect;
}

/** The open input bar's live handles. */
interface BarSession {
  quoteText: string;
  clonedRange: Range;
  ownerToken: string;
  root: HTMLDivElement;
  input: HTMLInputElement;
  confirm: HTMLButtonElement;
}

let boundDeps: QuoteCommentDeps;
let debounceTimer: number | null = null;
let repositionPending = false;
let triggerEl: HTMLButtonElement | null = null;
let triggerAnchorRect: DOMRect | null = null;
let bar: BarSession | null = null;
// IME composition guard for the bar input (mirrors main.ts's composer G2).
let barIsComposing = false;
let lastBarCompositionEndAt = 0;

/** Bound once by main.ts at boot, before the first render (R4). */
export function initQuoteComment(deps: QuoteCommentDeps): void {
  boundDeps = deps;
  document.addEventListener("selectionchange", onSelectionChange);
  // Capture phase so a click-outside is judged BEFORE the target's own handlers
  // run; a click INSIDE the bar (including the confirm button) is exempt.
  document.addEventListener("mousedown", onDocumentMousedown, true);
  elements.runList.addEventListener("scroll", scheduleReposition);
  window.addEventListener("resize", scheduleReposition);
}

// --- Selection watching -----------------------------------------------------

function onSelectionChange(): void {
  if (debounceTimer !== null) {
    window.clearTimeout(debounceTimer);
  }
  debounceTimer = window.setTimeout(() => {
    debounceTimer = null;
    evaluateSelection();
  }, SELECTION_DEBOUNCE_MS);
}

function evaluateSelection(): void {
  // While the bar is open the document selection has moved to the input (or was
  // collapsed on confirm); leave the trigger alone.
  if (bar) {
    return;
  }
  const range = currentQualifyingRange();
  const rect = range ? lastRectOf(range) : null;
  if (!rect) {
    hideTrigger();
    return;
  }
  showTrigger(rect);
}

/** The current selection IFF it is non-collapsed and intersects transcript
 *  content inside `#run-list` (at least one `.turn-card`) — terminal, sidebar,
 *  composer, and Preview are out of scope. */
function currentQualifyingRange(): Range | null {
  const selection = window.getSelection();
  if (!selection || selection.isCollapsed || selection.rangeCount === 0) {
    return null;
  }
  // A whitespace/newline-only selection has no quotable text — don't show a
  // trigger that would no-op on click.
  if (normalizeQuote(selection.toString()).length === 0) {
    return null;
  }
  const range = selection.getRangeAt(0);
  return rangeIntersectsTranscript(range) ? range : null;
}

function rangeIntersectsTranscript(range: Range): boolean {
  const cards = Array.from(elements.runList.querySelectorAll(".turn-card"));
  for (const card of cards) {
    try {
      if (range.intersectsNode(card)) {
        return true;
      }
    } catch {
      // Detached/edge node — skip it; another card may still intersect.
    }
  }
  return false;
}

/** The last client rect of a range (the selection END), or null when the range
 *  yields no usable box (collapsed, line-break-only, or a dead cloned range). */
function lastRectOf(range: Range): DOMRect | null {
  let rects: DOMRectList;
  try {
    rects = range.getClientRects();
  } catch {
    return null;
  }
  const rect = rects.length > 0 ? rects[rects.length - 1] : undefined;
  if (!rect || (rect.width === 0 && rect.height === 0)) {
    return null;
  }
  return rect;
}

// --- The floating trigger ---------------------------------------------------

function showTrigger(rect: DOMRect): void {
  triggerAnchorRect = rect;
  const trigger = ensureTrigger();
  positionCenteredAbove(trigger, rect);
}

function ensureTrigger(): HTMLButtonElement {
  if (triggerEl) {
    return triggerEl;
  }
  const button = document.createElement("button");
  button.type = "button";
  button.className = "quote-comment-trigger";
  button.setAttribute("aria-label", "Comment on the selected text");
  button.append(commentGlyph(28));
  button.addEventListener("mousedown", onTriggerMousedown);
  elements.quoteCommentRoot.append(button);
  triggerEl = button;
  return button;
}

function hideTrigger(): void {
  if (triggerEl) {
    triggerEl.remove();
    triggerEl = null;
  }
  triggerAnchorRect = null;
}

function onTriggerMousedown(event: MouseEvent): void {
  // Must run BEFORE the default action: preventDefault keeps the selection alive
  // (the browser would otherwise collapse it and move focus) so we can capture.
  event.preventDefault();
  const range = currentQualifyingRange();
  if (!range) {
    return;
  }
  const quoteText = window.getSelection()?.toString() ?? "";
  if (normalizeQuote(quoteText).length === 0) {
    return;
  }
  const anchorRect = lastRectOf(range) ?? triggerAnchorRect;
  if (!anchorRect) {
    return;
  }
  openBar({ quoteText, clonedRange: range.cloneRange(), anchorRect });
}

// --- The input bar ----------------------------------------------------------

function openBar(capture: QuoteCapture): void {
  hideTrigger();

  const root = document.createElement("div");
  root.className = "quote-comment-bar";

  const input = document.createElement("input");
  input.type = "text";
  input.className = "quote-comment-input";
  input.placeholder = "Add a comment…";
  input.setAttribute("aria-label", "Add a comment on the selected text");

  const confirm = document.createElement("button");
  confirm.type = "button";
  confirm.className = "quote-comment-confirm";
  confirm.setAttribute("aria-label", "Add comment");
  confirm.hidden = true; // shown only when the input has non-whitespace text (D4)
  confirm.append(lucideIcon(Check, 18));

  root.append(input, confirm);
  elements.quoteCommentRoot.append(root);

  bar = {
    quoteText: capture.quoteText,
    clonedRange: capture.clonedRange,
    ownerToken: boundDeps.composerOwnerToken(),
    root,
    input,
    confirm,
  };

  paintPendingHighlight(capture.clonedRange);
  positionCenteredAbove(root, capture.anchorRect);

  input.addEventListener("input", onInput);
  input.addEventListener("keydown", onInputKeydown);
  input.addEventListener("compositionstart", onBarCompositionStart);
  input.addEventListener("compositionend", onBarCompositionEnd);
  // Keep focus in the input on confirm-press: a plain button mousedown would
  // blur the input first (and never counts as click-outside — it is inside the
  // bar). The click does the work.
  confirm.addEventListener("mousedown", (event) => event.preventDefault());
  confirm.addEventListener("click", confirmBar);

  input.focus();
}

function onInput(): void {
  if (!bar) {
    return;
  }
  bar.confirm.hidden = bar.input.value.trim().length === 0;
}

function onBarCompositionStart(): void {
  barIsComposing = true;
}

function onBarCompositionEnd(): void {
  barIsComposing = false;
  lastBarCompositionEndAt = performance.now();
}

/** True when an Enter/Escape is really an IME candidate commit/cancel, not a bar
 *  action. Full mirror of the composer's G2 guard (main.ts
 *  isComposerCompositionShortcut): isComposing OR module composing-state OR the
 *  legacy keyCode 229 OR inside the post-compositionend window — because a
 *  candidate-commit Enter can arrive after compositionend with isComposing
 *  already false, which Woody (who types Chinese daily) would hit constantly. */
function isBarCompositionShortcut(event: KeyboardEvent): boolean {
  if (event.isComposing || barIsComposing || event.keyCode === 229) {
    return true;
  }
  return performance.now() - lastBarCompositionEndAt < COMPOSITION_END_GUARD_MS;
}

function onInputKeydown(event: KeyboardEvent): void {
  if (event.key === "Escape") {
    // During composition, Escape cancels the IME candidate, not the bar.
    if (isBarCompositionShortcut(event)) {
      return;
    }
    event.preventDefault();
    cancelBar();
    return;
  }
  if (event.key === "Enter") {
    if (isBarCompositionShortcut(event)) {
      return;
    }
    event.preventDefault();
    confirmBar();
  }
}

function confirmBar(): void {
  if (!bar) {
    return;
  }
  const comment = bar.input.value;
  if (comment.trim().length === 0) {
    return; // no-op on empty (D4)
  }
  // The shared composer textarea may have been reparked onto a different owner by
  // a programmatic task switch while the bar was open (e.g. a notification-click
  // activation). Appending now would inject this quote into another session's
  // draft — drop it silently; the quote belongs to a transcript the user has left.
  if (boundDeps.composerOwnerToken() !== bar.ownerToken) {
    cancelBar();
    return;
  }
  const paragraph = formatQuoteComment(bar.quoteText, comment);
  closeBar();
  // Collapse the document selection so evaluateSelection doesn't immediately
  // re-show the trigger over a consumed quote.
  window.getSelection()?.removeAllRanges();
  boundDeps.appendToComposer(paragraph);
}

function cancelBar(): void {
  // No trace: nothing appended, highlight gone. The user's selection is left as
  // it was; the trigger stays hidden until the next selectionchange.
  closeBar();
}

function closeBar(): void {
  removePendingHighlight();
  barIsComposing = false;
  if (bar) {
    bar.root.remove();
    bar = null;
  }
  elements.quoteCommentRoot.replaceChildren();
}

// --- The pending-quote highlight (CSS Custom Highlight API) ------------------

// The CSS Custom Highlight API is maplike, but its Map methods are only typed
// under the DOM.Iterable lib (this project's renderer tsconfig omits it). Narrow
// to just what we call rather than widening the global lib.
type HighlightRegistryLike = {
  set(name: string, highlight: Highlight): void;
  delete(name: string): void;
};

function highlightRegistry(): HighlightRegistryLike | null {
  if (typeof Highlight === "undefined") {
    return null;
  }
  const registry = (CSS as unknown as { highlights?: HighlightRegistryLike }).highlights;
  return registry ?? null;
}

function paintPendingHighlight(range: Range): void {
  const registry = highlightRegistry();
  if (!registry) {
    return; // API absent — the flow still works; the quote just isn't marked.
  }
  try {
    registry.set(PENDING_HIGHLIGHT, new Highlight(range));
  } catch {
    // A dead/invalid range can't be highlighted — capture already holds the text.
  }
}

function removePendingHighlight(): void {
  highlightRegistry()?.delete(PENDING_HIGHLIGHT);
}

// --- Click-outside + repositioning ------------------------------------------

function onDocumentMousedown(event: MouseEvent): void {
  if (!bar) {
    return;
  }
  const target = event.target;
  if (target instanceof Node && bar.root.contains(target)) {
    return; // inside the bar — never a cancel
  }
  cancelBar();
}

function scheduleReposition(): void {
  if (repositionPending) {
    return;
  }
  repositionPending = true;
  requestAnimationFrame(() => {
    repositionPending = false;
    reposition();
  });
}

function reposition(): void {
  if (bar) {
    // Follow the quoted text if its range is still alive; if it died on a
    // streaming rebuild, keep the last position (the highlight is already gone).
    const rect = lastRectOf(bar.clonedRange);
    if (rect) {
      positionCenteredAbove(bar.root, rect);
    }
    return;
  }
  if (triggerEl) {
    const range = currentQualifyingRange();
    const rect = range ? lastRectOf(range) : null;
    if (!rect) {
      hideTrigger();
      return;
    }
    triggerAnchorRect = rect;
    positionCenteredAbove(triggerEl, rect);
  }
}
