import "../styles.css";
import type { PreviewBinding, RuntimeEvent } from "../../shared/types";
import { clamp } from "../../reading-core/selectors/formatters";
import {
  basename,
  createInitialPreviewState,
  docBaseUrl,
  type PreviewDeps,
  type PreviewViewState,
} from "./state";
import { initTabs, renderTabs } from "./tabs";
import { initToolbar, renderToolbar, type ToolbarElements } from "./toolbar";
import { morphReader, renderReader, type ReaderContext } from "./reader";
import { initTree, notifyFileChanged, renderTree, type TreeDeps } from "./tree";

/**
 * The Preview window's composition root (design record §6.2). It owns the state
 * atom, wires the view modules to their DOM and to the named transitions, and
 * runs the one event entry — `reconcile(event)` — that projects disk changes.
 * Everything is a projection of (session truth pushed by main × disk truth read
 * on demand); this window never stores what it can re-derive.
 */

const appElement = document.querySelector<HTMLElement>("#app");
if (!appElement) {
  throw new Error("Preview mount point was not found.");
}

appElement.innerHTML = `
  <div class="preview-shell">
    <div class="preview-tabstrip" id="preview-tabstrip" role="tablist" aria-label="Open files"></div>
    <div class="preview-toolbar">
      <nav class="preview-breadcrumb" id="preview-breadcrumb" aria-label="File location"></nav>
      <div class="preview-toolbar-actions">
        <div class="preview-open">
          <button class="preview-open-button" id="preview-open-button" type="button"
            aria-haspopup="menu" aria-expanded="false"></button>
          <div class="preview-open-menu hidden" id="preview-open-menu" role="menu"></div>
        </div>
        <button class="preview-panel-toggle" id="preview-panel-toggle" type="button"
          aria-pressed="false" title="Toggle folder panel" aria-label="Toggle folder panel"></button>
      </div>
    </div>
    <div class="preview-body">
      <section class="preview-canvas" id="preview-content" tabindex="0" aria-label="Document"></section>
      <div class="preview-panel-resizer hidden" id="preview-panel-resizer" role="separator"
        aria-orientation="vertical" aria-label="Resize folder panel"
        title="Drag to resize · double-click to reset"></div>
      <aside class="preview-panel hidden" id="preview-panel" aria-label="Folder"></aside>
    </div>
  </div>
`;

const els = {
  tabstrip: requireEl("#preview-tabstrip"),
  breadcrumb: requireEl("#preview-breadcrumb"),
  openButton: requireEl<HTMLButtonElement>("#preview-open-button"),
  openMenu: requireEl("#preview-open-menu"),
  panelToggle: requireEl<HTMLButtonElement>("#preview-panel-toggle"),
  content: requireEl("#preview-content"),
  panel: requireEl("#preview-panel"),
  panelResizer: requireEl("#preview-panel-resizer"),
};

const toolbarEls: ToolbarElements = {
  breadcrumb: els.breadcrumb,
  openButton: els.openButton,
  openMenu: els.openMenu,
  panelToggle: els.panelToggle,
};

const state: PreviewViewState = createInitialPreviewState();

// ── Named transitions (the behavior seam) ───────────────────────────────────
const deps: PreviewDeps = {
  activate(path) {
    const taskId = state.binding.taskId;
    if (!taskId || path === state.binding.session?.activePath) {
      return;
    }
    flushScroll();
    void window.sonataRuntime.activatePreviewTab({ taskId, path }).catch(() => {});
  },
  close(path) {
    const taskId = state.binding.taskId;
    if (!taskId) {
      return;
    }
    // Closing the last tab closes the window — restore makes an accidental
    // close free, so the window is not a thing to preserve empty (§4).
    if ((state.binding.session?.tabs.length ?? 0) <= 1) {
      window.close();
      return;
    }
    void window.sonataRuntime.closePreviewTab({ taskId, path }).catch(() => {});
  },
  closeOthers(path) {
    const taskId = state.binding.taskId;
    const session = state.binding.session;
    if (!taskId || !session) {
      return;
    }
    // Keep `path` active, then close the rest — focus never lands on a doomed tab.
    if (session.activePath !== path) {
      void window.sonataRuntime.activatePreviewTab({ taskId, path }).catch(() => {});
    }
    for (const tab of session.tabs) {
      if (tab.path !== path) {
        void window.sonataRuntime.closePreviewTab({ taskId, path: tab.path }).catch(() => {});
      }
    }
  },
  closeToRight(path) {
    const taskId = state.binding.taskId;
    const session = state.binding.session;
    if (!taskId || !session) {
      return;
    }
    const index = session.tabs.findIndex((tab) => tab.path === path);
    for (const tab of session.tabs.slice(index + 1)) {
      void window.sonataRuntime.closePreviewTab({ taskId, path: tab.path }).catch(() => {});
    }
  },
  openExternal(target) {
    const taskId = state.binding.taskId;
    const path = state.binding.session?.activePath;
    if (!taskId || !path) {
      return;
    }
    void window.sonataRuntime
      .openWorkspaceExternal({ taskId, target: target === "cursor" ? "cursor" : "folder", relativePath: path })
      .catch(() => {});
  },
  togglePanel() {
    const taskId = state.binding.taskId;
    if (!taskId) {
      return;
    }
    const open = !(state.binding.session?.panelOpen ?? false);
    void window.sonataRuntime.setPreviewPanel({ taskId, open }).catch(() => {});
  },
  closeWindow() {
    window.close();
  },
};

// ── Reader context: what the presenters reach back into ──────────────────────
const readerCtx: ReaderContext = {
  get taskId() {
    return state.binding.taskId;
  },
  openTab(relativePath) {
    const taskId = state.binding.taskId;
    if (!taskId) {
      return;
    }
    // A relative doc link opens (or focuses) that file as a Preview tab — the
    // same open-or-focus bridge chips (S4) use; the task is already the bound
    // one, so this never crosses tasks.
    void window.sonataRuntime.openPreview({ taskId, relativePath }).catch(() => {});
  },
  revealInFinder(relativePath) {
    const taskId = state.binding.taskId;
    if (!taskId) {
      return;
    }
    void window.sonataRuntime
      .openWorkspaceExternal({ taskId, target: "folder", relativePath })
      .catch(() => {});
  },
};

// ── Tree bridges: a per-directory listing read + the open-or-focus a file takes
// (the same openPreview path chips/links use). Bound to the current task at call
// time, so the tree module stays decoupled from the runtime. ─────────────────
const treeDeps: TreeDeps = {
  async readDir(relativePath) {
    const taskId = state.binding.taskId;
    if (!taskId) {
      return [];
    }
    try {
      return await window.sonataRuntime.readWorkspaceDir({ taskId, relativePath });
    } catch {
      return [];
    }
  },
  openFile(relativePath) {
    readerCtx.openTab(relativePath);
  },
};

// ── Rendering ────────────────────────────────────────────────────────────────
function renderChrome(): void {
  renderTabs(state, els.tabstrip);
  renderToolbar(state, toolbarEls);
  renderTree(state, els.panel);
  // The resizer straddles the canvas/panel seam, so it lives and dies with the
  // panel (renderTree toggles the panel's own `hidden` from the same source).
  els.panelResizer.classList.toggle("hidden", !(state.binding.session?.panelOpen ?? false));
}

function renderAll(): void {
  renderChrome();
  renderReader(state, els.content, readerCtx);
}

// ── Binding: main's push of the bound task's session ─────────────────────────
function applyBinding(binding: PreviewBinding): void {
  state.binding = binding;
  pruneDirty();
  const active = binding.session?.activePath ?? null;
  if (active) {
    // Focusing a tab clears its dirty dot (view truth).
    state.dirty.delete(active);
  }

  if (active !== state.docPath) {
    // The active tab changed — drop the stale doc, project the new claim.
    state.doc = null;
    state.docPath = null;
    renderAll();
    if (active) {
      void activateDoc(active);
    }
  } else {
    renderAll();
  }
}

/** Drop dirty entries for tabs that are no longer open (a fresh projection owes
 *  nothing to closed tabs). */
function pruneDirty(): void {
  const present = new Set(state.binding.session?.tabs.map((tab) => tab.path) ?? []);
  for (const path of [...state.dirty]) {
    if (!present.has(path)) {
      state.dirty.delete(path);
    }
  }
}

/** Within this many px of the bottom counts as "pinned" — the reader stays
 *  glued to the tail as the agent appends (§4). */
const TAIL_FOLLOW_PX = 24;
/** file:changed for the active tab coalesces on this trailing window; the first
 *  change of a burst renders immediately (§4). */
const COALESCE_MS = 300;

/**
 * Read the active tab's classified document into state. Absence is not an error
 * — a missing file returns `kind: "absent"` and draws a tombstone; only a guard
 * violation throws. Returns false if a newer tab switch raced this read (the
 * caller must not project a stale document).
 */
async function readActiveDoc(path: string): Promise<boolean> {
  const taskId = state.binding.taskId;
  if (!taskId) {
    return false;
  }
  let doc;
  try {
    doc = await window.sonataRuntime.readWorkspaceDoc({ taskId, relativePath: path });
  } catch {
    // A guard violation (never for a merely-missing file) — draw the tombstone.
    doc = { path, name: basename(path), extension: "", size: 0, kind: "absent" as const };
  }
  // A slower read must not overwrite a newer tab switch (or a task rebind).
  if (state.binding.taskId !== taskId || state.binding.session?.activePath !== path) {
    return false;
  }
  state.doc = doc;
  state.docPath = path;
  return true;
}

/**
 * Project a newly-activated tab (tab switch / first load): a clean full render,
 * then restore that path's saved scroll offset (session truth).
 */
async function activateDoc(path: string): Promise<void> {
  if (!(await readActiveDoc(path))) {
    return;
  }
  renderReader(state, els.content, readerCtx);
  renderToolbar(state, toolbarEls);
  // Synchronous restore: renderReader builds the DOM synchronously, and a
  // deferred (rAF) restore opens a one-frame window where it stomps a scroll
  // that happened after activation — any later scroll must always win.
  els.content.scrollTop = state.binding.session?.scroll[path] ?? 0;
}

/**
 * Project a live re-read of the active tab (a `file:changed`). The reader's
 * position is held across the update (§4): capture the scroll anchor BEFORE the
 * morph, DOM-morph the fresh render so unchanged nodes keep identity, then —
 * after images settle (they change scrollHeight) — restore. Tail-follow wins: if
 * the reader was pinned at the bottom (the "watch the agent write" moment), stay
 * pinned; otherwise, only if a jump is detected, ratio-restore the prior spot.
 */
async function updateDoc(path: string): Promise<void> {
  const el = els.content;
  const topBefore = el.scrollTop;
  const heightBefore = el.scrollHeight;
  const pinnedToBottom = heightBefore - topBefore - el.clientHeight <= TAIL_FOLLOW_PX;
  const ratio = heightBefore > 0 ? topBefore / heightBefore : 0;

  if (!(await readActiveDoc(path))) {
    return;
  }
  const { morphed } = morphReader(state, els.content, readerCtx);
  renderToolbar(state, toolbarEls);

  const settle = (): void => {
    if (pinnedToBottom) {
      el.scrollTop = el.scrollHeight; // tail-follow
    } else if (morphed && Math.abs(el.scrollTop - topBefore) > 2) {
      // A jump — content changed above the fold. Node identity handled the
      // dominant append case; ratio-restore the relative position otherwise.
      el.scrollTop = ratio * el.scrollHeight;
    }
  };
  settle();
  // Images decode async and change scrollHeight after the synchronous morph —
  // re-apply the hold once they settle so an append below the fold or a growing
  // image can't nudge the reader.
  const pending = Array.from(el.querySelectorAll("img")).filter((img) => !img.complete);
  if (pending.length > 0) {
    await Promise.all(pending.map((img) => img.decode().catch(() => {})));
    settle();
  }
}

// file:changed for the active tab: render the leading edge immediately, then
// coalesce a burst onto a trailing timer so a flurry of writes does not thrash
// the reader (§4).
let coalesceTimer: number | null = null;
let coalescePending: string | null = null;
function scheduleActiveUpdate(path: string): void {
  if (coalesceTimer !== null) {
    coalescePending = path; // in the cooldown window — fold into the trailing run
    return;
  }
  void updateDoc(path);
  const arm = (): void => {
    coalesceTimer = window.setTimeout(() => {
      if (coalescePending !== null) {
        const next = coalescePending;
        coalescePending = null;
        void updateDoc(next);
        arm();
      } else {
        coalesceTimer = null;
      }
    }, COALESCE_MS);
  };
  arm();
}

// ── The one event entry: reconcile a claim against disk truth (§6.0) ─────────
function reconcile(event: RuntimeEvent): void {
  if (event.type !== "file:changed") {
    return;
  }
  const { taskId, path } = event.payload;
  if (taskId !== state.binding.taskId) {
    return;
  }
  // The tree observes EVERY change for the bound task (not just tab-backed
  // paths): it decides whether the affected directory is expanded and worth a
  // refresh. Its coalescer is its own, independent of the reader's below.
  notifyFileChanged(path);
  const session = state.binding.session;
  if (!session || !session.tabs.some((tab) => tab.path === path)) {
    return;
  }
  if (session.activePath === path) {
    // Active tab: re-read in place (coalesced), morphing to hold the reader's
    // position. A reappeared (previously absent) file reloads here too — it
    // falls out of the same read, no special case.
    scheduleActiveUpdate(path);
  } else {
    // Background tab: record staleness as a dirty dot (view truth).
    state.dirty.add(path);
    renderTabs(state, els.tabstrip);
  }
}

// ── Scroll: session truth, reported (debounced) and restored per path ────────
let scrollTimer: number | null = null;
els.content.addEventListener("scroll", () => {
  if (scrollTimer !== null) {
    clearTimeout(scrollTimer);
  }
  scrollTimer = window.setTimeout(reportScroll, 150);
});

function reportScroll(): void {
  scrollTimer = null;
  const taskId = state.binding.taskId;
  const path = state.binding.session?.activePath;
  if (taskId && path) {
    void window.sonataRuntime
      .setPreviewScroll({ taskId, path, scroll: els.content.scrollTop })
      .catch(() => {});
  }
}

/** Flush the outgoing tab's scroll before a switch, so main has it before the
 *  next tab's position restores. */
function flushScroll(): void {
  if (scrollTimer !== null) {
    clearTimeout(scrollTimer);
  }
  reportScroll();
}

// ── In-document links: the window NEVER navigates itself (§4) ─────────────────
// Every link click inside a rendered doc is intercepted here (the composition
// root owns the scroll box + the current doc path). Because we inject no global
// <base>, relative refs are resolved explicitly against the doc's sonata-file base
// — identical semantics, scoped to the reader. Three destinations:
//   #fragment                      → scroll within the document
//   workspace-relative file        → open (or focus) it as a Preview tab
//   http(s) / mailto               → shell.openExternal via window.open (the
//                                     window's setWindowOpenHandler routes it)
els.content.addEventListener("click", (event) => {
  const target = event.target;
  if (!(target instanceof Element)) {
    return;
  }
  const anchor = target.closest("a[href]");
  if (!anchor || !els.content.contains(anchor)) {
    return;
  }
  event.preventDefault();
  routeDocLink(anchor.getAttribute("href") ?? "");
});

function routeDocLink(raw: string): void {
  if (!raw) {
    return;
  }
  if (raw.startsWith("#")) {
    scrollToFragment(raw.slice(1));
    return;
  }
  const taskId = state.binding.taskId;
  const docPath = state.docPath;
  if (!taskId || !docPath) {
    return;
  }
  let url: URL;
  try {
    url = new URL(raw, docBaseUrl(taskId, docPath));
  } catch {
    return;
  }
  if (url.protocol === "sonata-file:") {
    // Relative doc link → a workspace-relative path. The URL host clamps `..` at
    // the root, and readDoc's guard rejects any escape (tombstone), so this can
    // never leave the workspace.
    const relative = decodeURIComponent(url.pathname).replace(/^\/+/, "");
    if (relative) {
      readerCtx.openTab(relative);
    }
  } else if (url.protocol === "http:" || url.protocol === "https:" || url.protocol === "mailto:") {
    // window.open is denied+routed to shell.openExternal by the window's open
    // handler — the preview never navigates itself.
    window.open(url.href);
  }
}

function scrollToFragment(rawId: string): void {
  let id: string;
  try {
    id = decodeURIComponent(rawId);
  } catch {
    id = rawId;
  }
  if (!id) {
    return;
  }
  const target =
    els.content.querySelector(`#${CSS.escape(id)}`) ??
    els.content.querySelector(`[name="${CSS.escape(id)}"]`);
  target?.scrollIntoView({ block: "start" });
}

// ── Keyboard (AppKit document-window manners, §4) ────────────────────────────
document.addEventListener("keydown", (event) => {
  const meta = event.metaKey;
  const ctrl = event.ctrlKey;
  const key = event.key.toLowerCase();

  if (meta && event.shiftKey && key === "w") {
    event.preventDefault();
    window.close();
    return;
  }
  if (meta && !event.shiftKey && key === "w") {
    event.preventDefault();
    closeActiveTab();
    return;
  }
  if (ctrl && event.key === "Tab") {
    event.preventDefault();
    switchRelative(event.shiftKey ? -1 : 1);
    return;
  }
  if (meta && event.shiftKey && event.code === "BracketRight") {
    event.preventDefault();
    switchRelative(1);
    return;
  }
  if (meta && event.shiftKey && event.code === "BracketLeft") {
    event.preventDefault();
    switchRelative(-1);
    return;
  }
  if (meta && !event.shiftKey && /^[1-9]$/.test(event.key)) {
    event.preventDefault();
    // Cmd+1..8 = tab N; Cmd+9 = LAST tab (browser convention).
    switchToIndex(event.key === "9" ? "last" : Number(event.key) - 1);
  }
});

function closeActiveTab(): void {
  const active = state.binding.session?.activePath;
  if (!active) {
    window.close();
    return;
  }
  deps.close(active);
}

function switchRelative(delta: number): void {
  const session = state.binding.session;
  const taskId = state.binding.taskId;
  if (!session || !taskId || session.tabs.length === 0) {
    return;
  }
  const index = session.tabs.findIndex((tab) => tab.path === session.activePath);
  const count = session.tabs.length;
  const nextIndex = ((index < 0 ? 0 : index) + delta + count) % count;
  const path = session.tabs[nextIndex]?.path;
  if (path) {
    deps.activate(path);
  }
}

function switchToIndex(index: number | "last"): void {
  const session = state.binding.session;
  if (!session) {
    return;
  }
  const tab = index === "last" ? session.tabs.at(-1) : session.tabs[index];
  if (tab) {
    deps.activate(tab.path);
  }
}

// ── Folder panel resize (§5.6) ───────────────────────────────────────────────
// Mirrors the main window's sidebar sash: a zero-layout 8px handle over the
// seam, pointer capture + rAF-throttled apply, localStorage-persisted width,
// double-click to reset. Right-anchored — the panel hugs the window's right
// edge, so its width is the pointer's distance from that edge.
const PANEL_WIDTH_KEY = "sonata.preview.panel.width";
const PANEL_WIDTH_MIN = 220;
const PANEL_WIDTH_MAX = 560;
const PANEL_WIDTH_DEFAULT = 280; // matches the CSS .preview-panel width
// The document canvas must never be squeezed below this. The window's own
// minWidth is 560 (== PANEL_WIDTH_MAX), so without a dynamic cap a persisted or
// dragged 560px panel could erase the canvas entirely on a narrow window.
const MIN_CANVAS_WIDTH = 320;

// The panel's max is dynamic: never wide enough to drop the canvas below
// MIN_CANVAS_WIDTH. Floored at PANEL_WIDTH_MIN so the [min, max] range stays
// valid on the narrowest window (there the panel simply pins to its min).
function panelWidthMax(): number {
  return Math.max(PANEL_WIDTH_MIN, Math.min(PANEL_WIDTH_MAX, window.innerWidth - MIN_CANVAS_WIDTH));
}

// The width the user chose (persisted intent), kept independent of what the
// current window can show — so widening the window restores the intended width
// instead of stranding it at a value some earlier narrow window clamped it to.
let desiredPanelWidth: number | null = null;

function applyPanelWidth(): void {
  const target = desiredPanelWidth ?? PANEL_WIDTH_DEFAULT;
  const clamped = Math.round(clamp(target, PANEL_WIDTH_MIN, panelWidthMax()));
  els.panel.style.width = `${clamped}px`;
  els.panel.style.flexBasis = `${clamped}px`;
}

function persistPanelWidth(width: number | null): void {
  try {
    if (width === null) {
      localStorage.removeItem(PANEL_WIDTH_KEY);
    } else {
      localStorage.setItem(PANEL_WIDTH_KEY, String(Math.round(width)));
    }
  } catch {
    // View preference only.
  }
}

try {
  const stored = Number(localStorage.getItem(PANEL_WIDTH_KEY));
  if (Number.isFinite(stored) && stored > 0) {
    desiredPanelWidth = stored;
  }
} catch {
  // Default width stays.
}
applyPanelWidth();

// A narrowing window squeezes the panel (down to its min) rather than the
// canvas; a widening one restores the intended width.
window.addEventListener("resize", applyPanelWidth);

els.panelResizer.addEventListener("pointerdown", (event) => {
  if (event.button !== 0) {
    return;
  }
  event.preventDefault();
  const resizer = event.currentTarget as HTMLElement;
  resizer.setPointerCapture(event.pointerId);
  document.body.classList.add("preview-panel-resizing");
  let frame = 0;

  const onMove = (moveEvent: PointerEvent): void => {
    // Right-anchored: width is the pointer's distance from the window's edge.
    desiredPanelWidth = window.innerWidth - moveEvent.clientX;
    if (frame) {
      return;
    }
    frame = window.requestAnimationFrame(() => {
      frame = 0;
      applyPanelWidth();
    });
  };
  const onUp = (): void => {
    resizer.removeEventListener("pointermove", onMove);
    resizer.removeEventListener("pointerup", onUp);
    resizer.removeEventListener("pointercancel", onUp);
    document.body.classList.remove("preview-panel-resizing");
    if (frame) {
      window.cancelAnimationFrame(frame);
      frame = 0;
    }
    // Store intent within the absolute bounds (not the window-dependent max) so
    // a wide choice survives a narrow spell.
    desiredPanelWidth = clamp(desiredPanelWidth ?? PANEL_WIDTH_DEFAULT, PANEL_WIDTH_MIN, PANEL_WIDTH_MAX);
    applyPanelWidth();
    persistPanelWidth(desiredPanelWidth);
  };
  resizer.addEventListener("pointermove", onMove);
  resizer.addEventListener("pointerup", onUp);
  resizer.addEventListener("pointercancel", onUp);
});

els.panelResizer.addEventListener("dblclick", () => {
  desiredPanelWidth = null;
  applyPanelWidth();
  persistPanelWidth(null);
});

// ── Boot ─────────────────────────────────────────────────────────────────────
initTabs(els.tabstrip, deps);
initToolbar(toolbarEls, deps);
initTree(els.panel, treeDeps);
window.sonataRuntime.onPreviewBinding(applyBinding);
window.sonataRuntime.onRuntimeEvent(reconcile);
void window.sonataRuntime
  .readPreviewBinding()
  .then(applyBinding)
  .catch(() => {
    // The did-finish-load push will populate it if the pull raced boot.
  });

function requireEl<T extends HTMLElement>(selector: string): T {
  const element = document.querySelector<T>(selector);
  if (!element) {
    throw new Error(`Preview element not found: ${selector}`);
  }
  return element;
}
