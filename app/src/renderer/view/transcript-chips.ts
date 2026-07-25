// Transcript file chips (Preview Window Redesign, S4 — design record §5.6, R2).
// In an ASSISTANT reply's rendered markdown, inline-code spans that name a real
// workspace file become clickable chips (type icon + filename) that open the
// Preview window. This is an ENHANCEMENT applied AFTER the transcript's
// marked+DOMPurify pipeline (transcript.ts:433) and NEVER through the sanitizer.
//
// Three invariants make it safe against the reading surface's reconcile engine
// (ARCHITECTURE.md "State"; the engine rebuilds a turn's block DOM by reference
// identity on change):
//   1. IDEMPOTENT + RE-APPLICABLE. render.ts calls this after every renderRuns.
//      A chipped node carries `data-chip-state` and is skipped; a rebuilt turn
//      is a fresh node whose chips re-apply from cache — synchronously, in the
//      same render frame, so a re-render never flashes plain→chip.
//   2. MUTATE IN PLACE. We only decorate the existing <code> node; we never
//      replace a block element, so node identity (and text selection) survives.
//   3. SELECTION-SAFE. A node the user is actively selecting is left untouched
//      until the selection moves (transcript-selection.mjs is the fence).
//
// Resolution is async (one batched IPC per new candidate set) and cached per
// (taskId, mention) — positive results only. A turn's candidates resolve ONCE;
// there is no re-validation on file:changed. Chips are ENTRY POINTS, not state:
// a chip whose file was later deleted still opens — into a tombstone — which is
// correct three-truths behavior (the disk is the truth, the chip is a claim).
//
// Seam discipline (ARCHITECTURE.md): this view does DOM only. The IPC round-trip
// arrives as an init-bound dep (main.ts wires it to window.sonataRuntime); the
// click behavior is a delegated listener in the composition root. This module
// never touches window.sonataRuntime or the actions registry.

import { activeTaskView, type RendererState } from "../../reading-core/state";
import { elements } from "../dom";
import { iconForPath, lucideIcon } from "./icons";

/** Per-task chip resolution memory (view truth — renderer-local, never
 *  persisted, keyed by task so switching tasks can't cross-chip). `attempted`
 *  dedupes IPC ("resolve ONCE"); `positive` maps a mention string → the
 *  workspace-relative path of the real file it resolved to (drives synchronous
 *  re-application on every subsequent render). */
interface TaskChipCache {
  attempted: Set<string>;
  positive: Map<string, string>;
}

const chipCaches = new Map<string, TaskChipCache>();

/** Drop a task's chip-resolution memory (OBS S8, F10). Called when its view is
 *  removed (archive/delete) OR evicted on switch-away — the cache is keyed by
 *  taskId and otherwise grows one entry per task ever opened for the whole
 *  uptime. A reopened task re-resolves its chips from scratch (positive-only
 *  cache, one batched IPC per candidate set), so clearing is transparent. */
export function clearTaskChipCache(taskId: string): void {
  chipCaches.delete(taskId);
}

/** The open target of a real chip (taskId + workspace-relative path). */
export interface ChipTarget {
  taskId: string;
  relativePath: string;
}

/** The trust boundary for chip CLICKS. `data-chip-path` is a presentation + test
 *  hook and — since DOMPurify allows `data-*` — raw assistant HTML could forge
 *  one past the sanitizer; the click must NOT trust it. This registry holds only
 *  the nodes THIS module upgraded, keyed by node identity (a WeakMap so a
 *  reconcile-discarded chip is collected automatically). `transcriptChipTarget`
 *  is the only way the composition root turns a click into an open. */
const chipRegistry = new WeakMap<Element, ChipTarget>();

/** Set when an upgrade was skipped because the live selection intersected the
 *  node (see upgradeToChip). Cleared by the selectionchange retry, which re-runs
 *  applyChipsFromCache once the selection collapses — so a chip that resolved
 *  under a selection doesn't stall until the next unrelated render. */
let deferredBySelection = false;

/** The dep the composition root binds at boot: the batched existence resolver
 *  (main serves it through WorkspaceFiles.resolvePaths). */
export interface TranscriptChipsDeps {
  resolvePaths(taskId: string, candidates: string[]): Promise<string[]>;
}

let stateRef: RendererState;
let resolvePaths: TranscriptChipsDeps["resolvePaths"];

/** Bound once by main.ts at boot, before the first render (R4). */
export function initTranscriptChips(state: RendererState, deps: TranscriptChipsDeps): void {
  stateRef = state;
  resolvePaths = deps.resolvePaths;
  document.addEventListener("selectionchange", retryDeferredChips);
}

/**
 * The click trust boundary: return the open target ONLY for a node this module
 * upgraded into a chip. A forged `.transcript-file-chip` / `data-chip-path` node
 * (raw assistant HTML) is not in the registry → null → ignored. The composition
 * root's delegated listener calls this; nothing else may open a chip.
 */
export function transcriptChipTarget(target: EventTarget | null): ChipTarget | null {
  if (!(target instanceof Element)) {
    return null;
  }
  const chip = target.closest(".transcript-file-chip");
  return chip ? (chipRegistry.get(chip) ?? null) : null;
}

/** Re-attempt selection-deferred upgrades once the selection collapses. Guarded
 *  by the flag so the (high-frequency) selectionchange event is a cheap no-op
 *  the rest of the time — including every caret move in the composer. */
function retryDeferredChips(): void {
  if (!deferredBySelection) {
    return;
  }
  const selection = window.getSelection();
  if (selection && !selection.isCollapsed) {
    return; // still selecting — don't mutate under a live selection
  }
  deferredBySelection = false;
  const taskId = activeTaskView(stateRef)?.task?.id;
  if (taskId) {
    applyChipsFromCache(taskId);
  }
}

// Inline-code mentions ONLY (`:not(pre) > code`), in the assistant answer body
// ONLY (`.turn-answer`), never yet visited (`:not([data-chip-state])`). The user
// prompt and system notes render as plain text — no <code> there to catch.
const FRESH_CANDIDATE_SELECTOR =
  ".turn-answer .md-body :not(pre) > code:not([data-chip-state])";
const PENDING_CANDIDATE_SELECTOR =
  '.turn-answer .md-body code[data-chip-state="pending"]';

/**
 * The render-time entry, called by render.ts after renderRuns(). Scans fresh
 * inline-code spans, upgrades cached-positive mentions in place (synchronous,
 * no flash), and fires ONE batched resolution for genuinely new mentions.
 */
export function enhanceTranscriptChips(): void {
  const taskId = activeTaskView(stateRef)?.task?.id;
  if (!taskId) {
    return;
  }
  const fresh = Array.from(
    elements.runList.querySelectorAll<HTMLElement>(FRESH_CANDIDATE_SELECTOR),
  );
  if (fresh.length === 0) {
    return;
  }
  const cache = cacheFor(taskId);
  const selection = currentSelectionRange();
  const toResolve: string[] = [];
  for (const span of fresh) {
    const candidate = normalizeCandidate(span.textContent);
    if (candidate === null) {
      // Not path-like — mark plain so this node is never re-examined (until the
      // reconcile replaces it, when the fresh node is examined once).
      span.dataset.chipState = "plain";
      continue;
    }
    const relativePath = cache.positive.get(candidate);
    if (relativePath !== undefined) {
      upgradeToChip(span, taskId, relativePath, selection);
      continue;
    }
    // Awaiting (or already denied) resolution: stay plain code, but remember the
    // mention so applyChipsFromCache can upgrade this exact node if it resolves.
    span.dataset.chipState = "pending";
    span.dataset.chipMention = candidate;
    if (!cache.attempted.has(candidate)) {
      cache.attempted.add(candidate);
      toResolve.push(candidate);
    }
  }
  if (toResolve.length > 0) {
    void resolveBatch(taskId, toResolve);
  }
}

async function resolveBatch(taskId: string, candidates: string[]): Promise<void> {
  let existing: string[];
  try {
    existing = await resolvePaths(taskId, candidates);
  } catch {
    return; // resolution failed → mentions stay plain (attempted, not positive)
  }
  const cache = cacheFor(taskId);
  for (const relativePath of existing) {
    // Correlate each returned workspace-relative path back to the mention(s)
    // that produced it: exact match for a relative mention, suffix match for an
    // absolute mention the main side relativized (relative mentions must match
    // exactly so `src/a.ts` can't capture a returned bare `a.ts`).
    for (const candidate of candidates) {
      const absolute = candidate.startsWith("/");
      if (candidate === relativePath || (absolute && candidate.endsWith(`/${relativePath}`))) {
        cache.positive.set(candidate, relativePath);
      }
    }
  }
  applyChipsFromCache(taskId);
}

/** Upgrade the pending nodes whose mention just resolved positive. Guarded to
 *  the still-active task: a resolution that lands after a task switch keeps its
 *  positives cached (re-applied when the user switches back) but paints nothing
 *  now — the runList shows a different task's turns. */
function applyChipsFromCache(taskId: string): void {
  if (activeTaskView(stateRef)?.task?.id !== taskId) {
    return;
  }
  const cache = cacheFor(taskId);
  const selection = currentSelectionRange();
  const pending = Array.from(
    elements.runList.querySelectorAll<HTMLElement>(PENDING_CANDIDATE_SELECTOR),
  );
  for (const span of pending) {
    const mention = span.dataset.chipMention;
    const relativePath = mention ? cache.positive.get(mention) : undefined;
    if (relativePath !== undefined) {
      upgradeToChip(span, taskId, relativePath, selection);
    }
  }
}

/** Decorate the <code> node in place into a chip and REGISTER it as the trusted
 *  open target. `data-chip-path` is the presentation/test hook; the click reads
 *  the CLICK from `chipRegistry` (node identity), never the forgeable attribute. */
function upgradeToChip(
  span: HTMLElement,
  taskId: string,
  relativePath: string,
  selection: Range | null,
): void {
  // Never mutate a node inside the live selection — replacing its children
  // would collapse the selection. Leave it unmarked and arm the selectionchange
  // retry so it upgrades once the selection collapses (not just on the next
  // unrelated render). transcript-selection.mjs guards this.
  if (selection && rangeIntersects(selection, span)) {
    delete span.dataset.chipState;
    delete span.dataset.chipMention;
    deferredBySelection = true;
    return;
  }
  delete span.dataset.chipMention;
  span.dataset.chipState = "chip";
  span.dataset.chipPath = relativePath;
  chipRegistry.set(span, { taskId, relativePath });
  span.classList.add("transcript-file-chip");
  span.setAttribute("role", "button");
  span.setAttribute("tabindex", "0");
  span.title = relativePath;
  span.setAttribute("aria-label", `Open ${relativePath} in the Preview window`);
  const label = document.createElement("span");
  label.className = "transcript-file-chip-name";
  label.textContent = basenameOf(relativePath);
  span.replaceChildren(lucideIcon(iconForPath(relativePath), 13), label);
}

function cacheFor(taskId: string): TaskChipCache {
  let cache = chipCaches.get(taskId);
  if (!cache) {
    cache = { attempted: new Set(), positive: new Map() };
    chipCaches.set(taskId, cache);
  }
  return cache;
}

function currentSelectionRange(): Range | null {
  const selection = window.getSelection();
  if (!selection || selection.isCollapsed || selection.rangeCount === 0) {
    return null;
  }
  return selection.getRangeAt(0);
}

function rangeIntersects(range: Range, node: Node): boolean {
  // intersectsNode is the precise test; guard for environments/edge nodes where
  // it can throw (detached nodes) — a throw means "treat as intersecting", the
  // safe default that preserves any selection.
  try {
    return range.intersectsNode(node);
  } catch {
    return true;
  }
}

function basenameOf(relativePath: string): string {
  const slash = relativePath.lastIndexOf("/");
  return slash >= 0 ? relativePath.slice(slash + 1) : relativePath;
}

// A bare filename (no slash) needs a known extension to read as a path; a
// mention WITH a slash is path-like on its own. Existence is the real filter
// (resolvePaths), so this only has to be liberal-but-cheap and reject obvious
// prose/code noise.
const KNOWN_EXTENSION =
  /\.(md|markdown|txt|text|csv|log|rst|json|ya?ml|toml|xml|ini|cfg|conf|lock|env|ts|tsx|js|jsx|mjs|cjs|html?|css|scss|py|go|rs|java|c|h|cpp|hpp|rb|sh|swift|kt|php|sql|png|jpe?g|gif|webp|avif|svg|pdf)$/i;

/**
 * Normalize an inline-code span's text to a path candidate, or null if it isn't
 * one. Trims backtick residue, surrounding quotes/brackets, and trailing prose
 * punctuation; rejects newlines/tabs and shell/code noise (globs, calls,
 * redirects) and URLs — but ALLOWS interior spaces, since real doc filenames
 * (`Product Brief.md`, `My Notes.md`) carry them and the inline-code backticks
 * already delimit the mention. A candidate is path-like if it contains "/" OR
 * ends in a known file extension; existence (resolvePaths) is the real filter,
 * so being liberal here is safe (design record §5.6, S4 brief B).
 */
export function normalizeCandidate(raw: string | null): string | null {
  if (!raw) {
    return null;
  }
  let s = raw.trim();
  s = s.replace(/^[`'"([<]+/, "").replace(/[`'")\]>.,:;!?]+$/, "");
  if (!s || /[\n\r\t]/.test(s)) {
    return null;
  }
  if (/[()<>|*?"'`]/.test(s)) {
    return null;
  }
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) {
    return null; // a URL, not a workspace path (links have their own handler)
  }
  const looksLikePath = s.includes("/") || KNOWN_EXTENSION.test(s);
  return looksLikePath ? s : null;
}
