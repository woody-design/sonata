import "../styles.css";
import type { PreviewBinding, RuntimeEvent } from "../../shared/types";
import {
  basename,
  createInitialPreviewState,
  type PreviewDeps,
  type PreviewViewState,
} from "./state";
import { initTabs, renderTabs } from "./tabs";
import { initToolbar, renderToolbar, type ToolbarElements } from "./toolbar";
import { renderReader } from "./reader";
import { renderTree } from "./tree";

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
    void window.duetRuntime.activatePreviewTab({ taskId, path }).catch(() => {});
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
    void window.duetRuntime.closePreviewTab({ taskId, path }).catch(() => {});
  },
  closeOthers(path) {
    const taskId = state.binding.taskId;
    const session = state.binding.session;
    if (!taskId || !session) {
      return;
    }
    // Keep `path` active, then close the rest — focus never lands on a doomed tab.
    if (session.activePath !== path) {
      void window.duetRuntime.activatePreviewTab({ taskId, path }).catch(() => {});
    }
    for (const tab of session.tabs) {
      if (tab.path !== path) {
        void window.duetRuntime.closePreviewTab({ taskId, path: tab.path }).catch(() => {});
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
      void window.duetRuntime.closePreviewTab({ taskId, path: tab.path }).catch(() => {});
    }
  },
  openExternal(target) {
    const taskId = state.binding.taskId;
    const path = state.binding.session?.activePath;
    if (!taskId || !path) {
      return;
    }
    void window.duetRuntime
      .openWorkspaceExternal({ taskId, target: target === "cursor" ? "cursor" : "folder", relativePath: path })
      .catch(() => {});
  },
  togglePanel() {
    const taskId = state.binding.taskId;
    if (!taskId) {
      return;
    }
    const open = !(state.binding.session?.panelOpen ?? false);
    void window.duetRuntime.setPreviewPanel({ taskId, open }).catch(() => {});
  },
  closeWindow() {
    window.close();
  },
};

// ── Rendering ────────────────────────────────────────────────────────────────
function renderChrome(): void {
  renderTabs(state, els.tabstrip);
  renderToolbar(state, toolbarEls);
  renderTree(state, els.panel);
}

function renderAll(): void {
  renderChrome();
  renderReader(state, els.content);
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
      void loadActiveDoc(active);
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

/**
 * Read the active tab's classified document and project it. Absence is not an
 * error — a missing file returns `kind: "absent"` and draws a tombstone. A
 * `scrollTarget` (a live re-read) holds the current position; otherwise the
 * per-path saved scroll restores.
 */
async function loadActiveDoc(path: string, scrollTarget?: number): Promise<void> {
  const taskId = state.binding.taskId;
  if (!taskId) {
    return;
  }
  try {
    const doc = await window.duetRuntime.readWorkspaceDoc({ taskId, relativePath: path });
    // Guard against a race: a slower read must not overwrite a newer tab switch.
    if (state.binding.taskId !== taskId || state.binding.session?.activePath !== path) {
      return;
    }
    state.doc = doc;
    state.docPath = path;
  } catch {
    if (state.binding.taskId !== taskId || state.binding.session?.activePath !== path) {
      return;
    }
    // A guard violation (never for a merely-missing file) — draw the tombstone.
    state.doc = { path, name: basename(path), extension: "", size: 0, kind: "absent" };
    state.docPath = path;
  }
  renderReader(state, els.content);
  renderToolbar(state, toolbarEls);
  const top = scrollTarget ?? state.binding.session?.scroll[path] ?? 0;
  requestAnimationFrame(() => {
    els.content.scrollTop = top;
  });
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
  const session = state.binding.session;
  if (!session || !session.tabs.some((tab) => tab.path === path)) {
    return;
  }
  if (session.activePath === path) {
    // Active tab: re-read in place, keeping the reader's current scroll. A
    // reappeared (previously absent) file reloads here too — it falls out of
    // the same read, no special case.
    void loadActiveDoc(path, els.content.scrollTop);
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
    void window.duetRuntime
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

// ── Boot ─────────────────────────────────────────────────────────────────────
initTabs(els.tabstrip, deps);
initToolbar(toolbarEls, deps);
window.duetRuntime.onPreviewBinding(applyBinding);
window.duetRuntime.onRuntimeEvent(reconcile);
void window.duetRuntime
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
