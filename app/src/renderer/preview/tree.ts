import { ChevronDown, ChevronRight, Search } from "lucide";
import { lucideIcon } from "../view/icons";
import { iconForPath, type PreviewViewState } from "./state";
import type { WorkspaceDirEntry } from "../../shared/types";

/**
 * Folder panel — the lazy tree (design record §5.4 + §4 "Folder tree", S3).
 *
 * The tree is VIEW TRUTH (§6.0): window-lifetime transients owned by the
 * renderer, never persisted, never crossing IPC except the per-directory
 * `readDir` fetches themselves. It re-roots (and resets everything) when the
 * bound task changes; root = the bound task's cwd.
 *
 * Five behaviors, all off one small model:
 * - **Lazy per-dir children.** ONE `readDir` IPC per FIRST expand; the result is
 *   cached for the window's life, so re-expanding is instant. A directory gets a
 *   twistie BY ASSUMPTION — we never probe inside to decide. Children arrive
 *   sorted/typed/hidden-flagged from main (S1); the renderer never re-sorts.
 * - **The 500-guard.** Any single directory renders its first 500 children plus a
 *   "Show N more" row that reveals the rest in +500 steps — so no one directory
 *   can explode the DOM (this is what makes plain-DOM defensible; §4).
 * - **Honest filter.** Substring, case-insensitive, over LOADED nodes only:
 *   matches show with their ancestors auto-expanded, non-matching loaded rows
 *   hide, and NEVER-EXPANDED directories stay visible as-is — the tree refuses
 *   to claim an absence it hasn't verified. Clearing restores the pre-filter
 *   expansion.
 * - **Auto-reveal.** When the active tab changes (or the panel opens), the active
 *   file's ancestors expand, its row is selected, and it scrolls into view.
 *   Selection is ONE concept: the active tab's file (dirs are never selected).
 * - **Freshness.** A `file:changed` re-fetches the affected directory's children
 *   ONLY if it is currently expanded, coalesced on its own ~200ms timer
 *   (independent of the reader's 300ms coalescer).
 */

/** Indent added per tree level (px) — matches the sketch's row density. */
const INDENT_PX = 14;
/** 500-children guard: render this many entries of any one directory, then a
 *  "Show N more" row that reveals the next page. Bounds the DOM by construction
 *  (§4) — the standing defense in lieu of virtualization. */
const DIR_CHILD_PAGE = 500;
/** Tree refresh coalescer — deliberately its own timer, NOT the reader's 300ms
 *  one (the reader coalescer is reader-only; §6 S2 findings). */
const REFRESH_COALESCE_MS = 200;

/** The bridges the tree reaches back into, bound once by the composition root:
 *  a per-directory listing read and the open-or-focus path a file click takes
 *  (the same `openPreview` bridge chips/links use). The root stays decoupled
 *  from the runtime — the tree never touches `window.duetRuntime` directly. */
export interface TreeDeps {
  readDir(relativePath: string): Promise<WorkspaceDirEntry[]>;
  openFile(relativePath: string): void;
}

/** View truth for the tree — reset wholesale on a re-root. */
interface TreeModel {
  /** Which task the current tree is rooted at; a change resets everything. */
  rootTaskId: string | null;
  /** dir path ("" = root) → its one level of children (the lazy cache). A key
   *  present means "fetched"; absent means "never expanded" (honest filter). */
  children: Map<string, WorkspaceDirEntry[]>;
  /** Directories the user has expanded (root is always shown, never listed). */
  expanded: Set<string>;
  /** Directories with a fetch in flight — dedups concurrent expands. */
  loading: Set<string>;
  /** dir path → how many of its children are currently revealed (500-guard). */
  shown: Map<string, number>;
  /** Current filter text (lowercased at render). Empty = inactive. */
  filter: string;
  /** Snapshot of `expanded` taken when the filter turned on, restored on clear. */
  preFilterExpanded: Set<string> | null;
  /** Last active path we auto-revealed to — guards against re-revealing. */
  lastRevealed: string | null;
  /** Whether the panel was open on the previous render (open-transition detect). */
  panelWasOpen: boolean;
}

let deps: TreeDeps | null = null;
let panelEl: HTMLElement | null = null;
let bodyEl: HTMLElement | null = null;
let filterInput: HTMLInputElement | null = null;
/** The active tab's path — the single selection concept, read at render time. */
let activePath: string | null = null;
let model = freshModel();

// Tree-refresh coalescer state (independent of the reader's).
const pendingRefresh = new Set<string>();
let refreshTimer: number | null = null;

// Filter memo, rebuilt each renderBody (keyed by node path).
let filterQuery = "";
const visibleMemo = new Map<string, boolean>();

function freshModel(taskId: string | null = null): TreeModel {
  return {
    rootTaskId: taskId,
    children: new Map(),
    expanded: new Set(),
    loading: new Set(),
    shown: new Map(),
    filter: "",
    preFilterExpanded: null,
    lastRevealed: null,
    panelWasOpen: false,
  };
}

/**
 * Build the panel scaffold ONCE (a fixed filter box above a scrolling body).
 * The filter input lives OUTSIDE the body so re-rendering rows never steals its
 * focus or caret while the user types.
 */
export function initTree(panel: HTMLElement, bound: TreeDeps): void {
  deps = bound;
  panelEl = panel;
  panel.replaceChildren();

  const shell = document.createElement("div");
  shell.className = "preview-tree";

  const filter = document.createElement("div");
  filter.className = "preview-tree-filter";
  filter.append(lucideIcon(Search, 14));
  const input = document.createElement("input");
  input.type = "text";
  input.className = "preview-tree-filter-input";
  input.placeholder = "Filter files…";
  input.setAttribute("aria-label", "Filter files");
  input.spellcheck = false;
  input.addEventListener("input", handleFilterInput);
  filter.append(input);

  const body = document.createElement("div");
  body.className = "preview-tree-body";
  body.setAttribute("role", "tree");

  shell.append(filter, body);
  panel.append(shell);

  bodyEl = body;
  filterInput = input;
}

/**
 * Project the current binding + tree model into the panel (called by the
 * composition root's renderChrome on every push). Cheap and idempotent when
 * nothing changed; the heavy work (fetches, reveal) is scheduled, not inline.
 */
export function renderTree(state: PreviewViewState, panel: HTMLElement): void {
  panelEl = panel;
  const open = state.binding.session?.panelOpen ?? false;
  panel.classList.toggle("hidden", !open);

  const taskId = state.binding.taskId;
  activePath = state.binding.session?.activePath ?? null;

  // Re-root: a new bound task resets expansion, cache, filter — all view truth.
  if (taskId !== model.rootTaskId) {
    model = freshModel(taskId);
    if (filterInput) {
      filterInput.value = "";
    }
    pendingRefresh.clear();
    if (refreshTimer !== null) {
      clearTimeout(refreshTimer);
      refreshTimer = null;
    }
  }

  if (!open) {
    model.panelWasOpen = false;
    return; // hidden — skip DOM work; the cache still refreshes in the background
  }
  const panelJustOpened = !model.panelWasOpen;
  model.panelWasOpen = true;

  if (!taskId) {
    renderEmpty();
    return;
  }

  // Lazily fetch the root listing the first time the panel is shown for a task.
  if (!model.children.has("") && !model.loading.has("")) {
    void fetchDir("");
  }

  renderBody();

  // Auto-reveal: on an active-tab change (or the panel opening onto an already-
  // active tab), expand the active file's ancestors, select it, scroll to it.
  if (activePath && (activePath !== model.lastRevealed || panelJustOpened)) {
    model.lastRevealed = activePath;
    void revealPath(activePath);
  }
}

/**
 * A `file:changed` for the bound task (routed from the composition root's
 * reconcile). Refresh the changed path's PARENT (its listing may have gained or
 * lost this entry) AND — when the changed path is itself a shown directory — the
 * directory ITSELF (a delete/recreate/rename in place leaves its own cached
 * children stale; re-fetching that one level reconciles them). Both gate on
 * "loaded and shown", so a change inside a collapsed/unloaded directory still
 * spawns no fetch. Coalesced on its own timer, independent of the reader's.
 */
export function notifyFileChanged(changedPath: string): void {
  queueRefresh(parentOf(changedPath));
  queueRefresh(changedPath);
  if (pendingRefresh.size === 0 || refreshTimer !== null) {
    return;
  }
  refreshTimer = window.setTimeout(() => {
    refreshTimer = null;
    const dirs = [...pendingRefresh];
    pendingRefresh.clear();
    for (const target of dirs) {
      void refreshDir(target);
    }
  }, REFRESH_COALESCE_MS);
}

/** Queue a directory for a coalesced refresh iff it is currently loaded and
 *  shown — root, or an expanded directory. A file path (never a cache key) or a
 *  collapsed/unloaded directory does not qualify: no wasted fetch. */
function queueRefresh(dir: string): void {
  if (model.children.has(dir) && (dir === "" || model.expanded.has(dir))) {
    pendingRefresh.add(dir);
  }
}

// ── Fetch (lazy children) ─────────────────────────────────────────────────────

/** Load one directory's children into the cache (once), guarding a re-root that
 *  races the read. A no-op if already cached or already in flight. */
async function loadChildren(dirPath: string): Promise<void> {
  const m = model;
  if (!deps || m.children.has(dirPath) || m.loading.has(dirPath)) {
    return;
  }
  m.loading.add(dirPath);
  let kids: WorkspaceDirEntry[];
  try {
    kids = await deps.readDir(dirPath);
  } catch {
    kids = [];
  }
  // A re-root during the read swapped `model` for a fresh generation. This fetch
  // belongs to the dead one, so touch ONLY the captured model (now unreferenced,
  // GC'd) — never the live one. Guarding AFTER `loading.delete` was the bug: it
  // cleared the NEW task's in-flight marker for the same path, letting a
  // duplicate fetch slip past "one fetch per first expand".
  if (model !== m) {
    return;
  }
  m.loading.delete(dirPath);
  m.children.set(dirPath, kids);
}

/** Fetch + repaint (the expand path). */
async function fetchDir(dirPath: string): Promise<void> {
  const m = model;
  await loadChildren(dirPath);
  if (model === m) {
    renderBodyIfOpen();
  }
}

/** Forced re-fetch of an already-loaded directory (the freshness path): replace
 *  its listing so created/removed entries reflect, reconcile vanished
 *  subdirectories, then repaint. */
async function refreshDir(dirPath: string): Promise<void> {
  if (!deps) {
    return;
  }
  const m = model;
  let kids: WorkspaceDirEntry[];
  try {
    kids = await deps.readDir(dirPath);
  } catch {
    return;
  }
  if (model !== m) {
    return;
  }
  const previous = m.children.get(dirPath);
  m.children.set(dirPath, kids);
  // Reconcile child directories against disk truth: any previously-listed
  // subdirectory now absent from the fresh listing was deleted or renamed away —
  // drop its whole cached subtree so it can neither resurrect with stale
  // children nor leak (three-truths: view truth answers to disk truth).
  if (previous) {
    const present = new Set(kids.map((entry) => entry.path));
    for (const entry of previous) {
      if (entry.type === "directory" && !present.has(entry.path)) {
        purgeSubtree(entry.path);
      }
    }
  }
  renderBodyIfOpen();
}

/** Drop a directory and all its descendants from every view-truth map — used
 *  when a refresh reveals the directory has vanished from disk. */
function purgeSubtree(dirPath: string): void {
  const prefix = `${dirPath}/`;
  const owns = (key: string): boolean => key === dirPath || key.startsWith(prefix);
  for (const key of [...model.children.keys()]) {
    if (owns(key)) {
      model.children.delete(key);
    }
  }
  for (const key of [...model.expanded]) {
    if (owns(key)) {
      model.expanded.delete(key);
    }
  }
  for (const key of [...model.shown.keys()]) {
    if (owns(key)) {
      model.shown.delete(key);
    }
  }
}

// ── Interaction ────────────────────────────────────────────────────────────────

/** Toggle a directory: collapse keeps the cache (re-expand is instant); expand
 *  fetches the first time only. */
function toggleDir(dirPath: string): void {
  if (model.expanded.has(dirPath)) {
    model.expanded.delete(dirPath);
    renderBody();
    return;
  }
  model.expanded.add(dirPath);
  if (!model.children.has(dirPath) && !model.loading.has(dirPath)) {
    void fetchDir(dirPath);
  }
  renderBody();
}

function handleFilterInput(): void {
  if (!filterInput) {
    return;
  }
  const next = filterInput.value;
  const wasActive = model.filter.length > 0;
  const nowActive = next.length > 0;
  if (nowActive && !wasActive) {
    // Snapshot the expansion state so clearing the filter can restore it.
    model.preFilterExpanded = new Set(model.expanded);
  } else if (!nowActive && wasActive && model.preFilterExpanded) {
    model.expanded = model.preFilterExpanded;
    model.preFilterExpanded = null;
  }
  model.filter = next;
  renderBody();
}

// ── Auto-reveal ─────────────────────────────────────────────────────────────────

/** Expand every ancestor of the active path (fetching as needed), then select +
 *  scroll to its row. Selection falls out of the render (data-tree-selected on
 *  the active path); this only needs to open the branch and bring it into view. */
async function revealPath(path: string): Promise<void> {
  const m = model;
  // Load the ROOT listing FIRST: renderBody bails to "Loading…" until root is
  // cached, so a deep row cannot exist (nor be scrolled to) before then. Without
  // this, a root read that lands AFTER this render leaves the row selected but
  // never scrolled into view — and nothing retries (lastRevealed is already set).
  if (!m.children.has("")) {
    await loadChildren("");
    if (model !== m) {
      return;
    }
  }
  const parts = path.split("/");
  let prefix = "";
  for (let i = 0; i < parts.length - 1; i += 1) {
    const segment = parts[i] ?? "";
    prefix = prefix ? `${prefix}/${segment}` : segment;
    m.expanded.add(prefix);
    if (!m.children.has(prefix)) {
      await loadChildren(prefix);
      if (model !== m) {
        return;
      }
    }
  }
  renderBodyIfOpen();
  const row = bodyEl?.querySelector(`[data-tree-path="${CSS.escape(path)}"]`);
  row?.scrollIntoView({ block: "nearest" });
}

// ── Render ───────────────────────────────────────────────────────────────────

function renderBodyIfOpen(): void {
  if (panelEl && !panelEl.classList.contains("hidden")) {
    renderBody();
  }
}

/** Rebuild the tree body from the model. Preserves the body's own scroll (a
 *  chrome re-render — e.g. a background tab's dirty dot — must not yank the tree
 *  to the top). */
function renderBody(): void {
  if (!bodyEl) {
    return;
  }
  const scrollTop = bodyEl.scrollTop;
  bodyEl.replaceChildren();

  filterQuery = model.filter.trim().toLowerCase();
  visibleMemo.clear();

  if (!model.rootTaskId) {
    bodyEl.append(emptyHint("No folder open."));
    return;
  }
  if (!model.children.has("")) {
    // Root listing still in flight — a quiet frame, not a flash of nothing.
    bodyEl.append(emptyHint("Loading…"));
    return;
  }

  renderLevel("", bodyEl);

  if (!bodyEl.firstChild) {
    bodyEl.append(emptyHint(filterQuery ? "No matches." : "Empty folder."));
  }
  bodyEl.scrollTop = scrollTop;
}

/** Append the (filtered, paged) children of `dirPath`, recursing into each
 *  rendered-expanded directory so depth reads top-to-bottom. */
function renderLevel(dirPath: string, container: HTMLElement): void {
  const children = model.children.get(dirPath);
  if (!children) {
    return;
  }
  const list = filterQuery ? children.filter(isVisible) : children;
  const shown = model.shown.get(dirPath) ?? DIR_CHILD_PAGE;
  const slice = list.slice(0, shown);

  for (const entry of slice) {
    const expanded = entry.type === "directory" && shouldRenderExpanded(entry);
    container.append(buildRow(entry, expanded));
    if (expanded) {
      renderLevel(entry.path, container);
    }
  }

  if (list.length > shown) {
    container.append(buildMoreRow(dirPath, list.length - shown));
  }
}

/** Under an active filter, a LOADED directory force-expands when it holds a
 *  visible descendant (reveal the match); a never-expanded directory stays
 *  collapsed but visible. Without a filter, expansion is the user's own state. */
function shouldRenderExpanded(entry: WorkspaceDirEntry): boolean {
  if (filterQuery) {
    return model.children.has(entry.path) && hasVisibleChild(entry.path);
  }
  return model.expanded.has(entry.path);
}

/** Honest visibility under a filter (memoized): a name match is visible; a file
 *  that doesn't match is not; a never-expanded directory stays visible as-is
 *  (we can't claim an absence we haven't verified); a loaded directory is
 *  visible iff some descendant is. */
function isVisible(entry: WorkspaceDirEntry): boolean {
  if (!filterQuery) {
    return true;
  }
  const cached = visibleMemo.get(entry.path);
  if (cached !== undefined) {
    return cached;
  }
  let result: boolean;
  if (entry.name.toLowerCase().includes(filterQuery)) {
    result = true;
  } else if (entry.type === "file") {
    result = false;
  } else if (!model.children.has(entry.path)) {
    result = true; // never-expanded directory — honest filter keeps it visible
  } else {
    result = hasVisibleChild(entry.path);
  }
  visibleMemo.set(entry.path, result);
  return result;
}

function hasVisibleChild(dirPath: string): boolean {
  const kids = model.children.get(dirPath);
  return Boolean(kids && kids.some(isVisible));
}

function buildRow(entry: WorkspaceDirEntry, expanded: boolean): HTMLElement {
  const depth = entry.path.split("/").length - 1;
  const row = document.createElement("div");
  row.className = "preview-tree-row";
  row.style.setProperty("--depth", String(depth));
  row.dataset.treePath = entry.path;
  row.dataset.treeType = entry.type;
  row.dataset.treeHidden = String(entry.hidden);
  row.setAttribute("role", "treeitem");
  row.title = entry.name;

  const isDir = entry.type === "directory";
  // Selection is one concept: the active tab's FILE. Directories are never
  // selected (they toggle); a selected row undims even when hidden.
  const selected = !isDir && activePath === entry.path;
  row.dataset.treeSelected = String(selected);
  if (isDir) {
    row.dataset.treeExpanded = String(expanded);
    row.setAttribute("aria-expanded", String(expanded));
  }

  const icon = document.createElement("span");
  icon.className = isDir ? "preview-tree-twistie" : "preview-tree-icon";
  // A directory's slot is its twistie (chevron); a file's slot is its Lucide
  // type icon. Single column — names align (the sketch's layout, §5.4/§5.8;
  // monochrome, no colored Material icons, no folder glyph).
  icon.append(lucideIcon(isDir ? (expanded ? ChevronDown : ChevronRight) : iconForPath(entry.path), 15));

  const label = document.createElement("span");
  label.className = "preview-tree-label";
  label.textContent = entry.name;

  row.append(icon, label);

  if (isDir) {
    row.addEventListener("click", () => toggleDir(entry.path));
  } else {
    row.addEventListener("click", () => deps?.openFile(entry.path));
  }
  return row;
}

/** The 500-guard's reveal row — reveals the next +500 children of `dirPath`. */
function buildMoreRow(dirPath: string, remaining: number): HTMLElement {
  const childDepth = dirPath === "" ? 0 : dirPath.split("/").length;
  const row = document.createElement("button");
  row.type = "button";
  row.className = "preview-tree-more";
  row.style.setProperty("--depth", String(childDepth));
  row.dataset.treeMore = dirPath;
  row.textContent = `Show ${remaining} more`;
  row.addEventListener("click", () => {
    model.shown.set(dirPath, (model.shown.get(dirPath) ?? DIR_CHILD_PAGE) + DIR_CHILD_PAGE);
    renderBody();
  });
  return row;
}

function renderEmpty(): void {
  if (!bodyEl) {
    return;
  }
  bodyEl.replaceChildren(emptyHint("No folder open."));
}

function emptyHint(text: string): HTMLElement {
  const hint = document.createElement("p");
  hint.className = "preview-tree-empty";
  hint.textContent = text;
  return hint;
}

function parentOf(relativePath: string): string {
  const slash = relativePath.lastIndexOf("/");
  return slash >= 0 ? relativePath.slice(0, slash) : "";
}
