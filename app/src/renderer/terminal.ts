import "./styles.css";
import "@xterm/xterm/css/xterm.css";
import { FitAddon } from "@xterm/addon-fit";
import { SearchAddon } from "@xterm/addon-search";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { Terminal, type ITheme } from "@xterm/xterm";
import {
  DEFAULT_TERMINAL_WINDOW_SETTINGS,
  type ReadingModeSetting,
  type ReadingThemeId,
  type ResolvedReadingMode,
  type TerminalActiveTaskState,
  type TerminalReplaySnapshot,
  type TerminalWindowSettings,
} from "../shared/types";
import {
  hydrationGeneration,
  stitchHydration,
  type HydrationChunk,
} from "../shared/terminal-hydration";

// The terminal satellite window's xterm view. The PTY lives in the main
// process; this renders it. One xterm per LIVE task (kept alive so switching
// tasks is instant), fed the live pty:data broadcast and hydrated from the
// main-process headless mirror on creation. The active task — relayed via
// onActiveTerminalTask — is the one shown; other live tasks stay
// mounted-but-hidden and keep accumulating. A dormant (history-loaded) session
// has no PTY to mirror, so it shows a placeholder rather than a blank grid.
// Terminals whose task has closed are disposed. The whole subsystem was lifted
// out of the main window's renderer.

function requireEl<T extends HTMLElement>(selector: string): T {
  const element = document.querySelector<T>(selector);
  if (!element) {
    throw new Error(`Terminal window element not found: ${selector}`);
  }
  return element;
}

const appElement = requireEl<HTMLDivElement>("#app");
appElement.innerHTML = `
  <section class="terminal-window-shell" aria-label="Duet CLI">
    <header class="terminal-window-topbar">
      <p class="eyebrow terminal-window-label">CLI</p>
      <div class="terminal-window-breadcrumb" aria-label="Active project and task">
        <span id="terminal-project-name" class="terminal-window-breadcrumb-project">Tasks</span>
        <span class="terminal-window-breadcrumb-separator" aria-hidden="true">›</span>
        <span id="terminal-session-title" class="terminal-window-breadcrumb-session">New task</span>
      </div>
      <div class="terminal-window-topbar-actions">
        <button id="terminal-theme-trigger" class="secondary" type="button" aria-haspopup="dialog" aria-expanded="false" title="CLI theme">Aa</button>
      </div>
    </header>
    <section class="terminal-window-content">
      <div id="terminal-window-term" class="terminal-window-term"></div>
      <div id="terminal-window-search" class="terminal-search hidden" role="search">
        <input id="terminal-window-search-input" class="terminal-search-input" type="text" placeholder="Find" aria-label="Find in CLI" spellcheck="false" autocomplete="off" />
        <span id="terminal-window-search-count" class="terminal-search-count" aria-live="polite"></span>
        <button id="terminal-window-search-prev" class="terminal-search-btn" type="button" title="Previous (⇧⏎)" aria-label="Previous match">↑</button>
        <button id="terminal-window-search-next" class="terminal-search-btn" type="button" title="Next (⏎)" aria-label="Next match">↓</button>
        <button id="terminal-window-search-close" class="terminal-search-btn" type="button" title="Close (Esc)" aria-label="Close find">✕</button>
      </div>
      <div id="terminal-window-empty" class="terminal-window-placeholder" aria-live="polite">
        <button id="terminal-empty-action" class="terminal-empty-action" type="button">Start CLI</button>
        <p id="terminal-empty-detail" class="terminal-empty-detail">Start with the current task settings without sending a prompt.</p>
      </div>
    </section>
    <div id="terminal-theme-popover" class="terminal-theme-popover hidden" role="dialog" aria-label="CLI theme"></div>
  </section>
`;

const termMount = requireEl<HTMLDivElement>("#terminal-window-term");
const emptyState = requireEl<HTMLDivElement>("#terminal-window-empty");
const emptyAction = requireEl<HTMLButtonElement>("#terminal-empty-action");
const emptyDetail = requireEl<HTMLParagraphElement>("#terminal-empty-detail");
const projectName = requireEl<HTMLSpanElement>("#terminal-project-name");
const sessionTitle = requireEl<HTMLSpanElement>("#terminal-session-title");
const themeTrigger = requireEl<HTMLButtonElement>("#terminal-theme-trigger");
const themePopover = requireEl<HTMLDivElement>("#terminal-theme-popover");
const searchBox = requireEl<HTMLDivElement>("#terminal-window-search");
const searchInput = requireEl<HTMLInputElement>("#terminal-window-search-input");
const searchCount = requireEl<HTMLSpanElement>("#terminal-window-search-count");
const searchPrev = requireEl<HTMLButtonElement>("#terminal-window-search-prev");
const searchNext = requireEl<HTMLButtonElement>("#terminal-window-search-next");
const searchClose = requireEl<HTMLButtonElement>("#terminal-window-search-close");

const terminalFontFamily = getComputedStyle(document.documentElement)
  .getPropertyValue("--font-mono")
  .trim();

// Same font-measurement gotcha as the main window: xterm measures cell geometry
// at open(), so the bundled face must be loaded first or the grid misaligns.
const terminalFontsReady: Promise<void> = (async () => {
  try {
    await Promise.all([
      document.fonts.load('13px "Maple Mono NF CN"'),
      document.fonts.load('bold 13px "Maple Mono NF CN"'),
    ]);
  } catch {
    // Falls through to the global readiness check; worst case a fallback face.
  }
  await document.fonts.ready;
})();

const TERMINAL_COPY_ON_SELECT = true;
const TERMINAL_LIGATURES = true;
const LIGATURE_PATTERN =
  /<!--|-->|<==>|<=>|<==|==>|===|!==|=>>|<<=|>>=|->>|<<-|<->|->|<-|=>|<=|>=|==|!=|&&|\|\||\+\+|--|\/\/|\/\*|\*\/|:::|::|:=|\|>|<\||>>|<<|\.\.\.|\.\./g;

function ligatureJoiner(text: string): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];
  LIGATURE_PATTERN.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = LIGATURE_PATTERN.exec(text))) {
    ranges.push([match.index, match.index + match[0].length]);
  }
  return ranges;
}

// Terminal links are untrusted; route every click through the main process,
// which enforces the http/https/mailto allowlist before the OS opener.
function openExternalTerminalLink(url: string): void {
  void window.duetRuntime.openTerminalLink({ url }).catch(() => {});
}

// Resolve the app's --term-* palette tokens (which may be var()/color-mix())
// down to concrete sRGB via a probe + 1x1 canvas — xterm's color parser rejects
// color(srgb ...). The same resolver the main window uses, reading whatever
// theme this window's root is stamped with (its own, set via the Aa picker).
function terminalTheme(): ITheme {
  const probe = document.createElement("span");
  probe.style.position = "absolute";
  probe.style.visibility = "hidden";
  probe.style.pointerEvents = "none";
  document.body.appendChild(probe);
  const ctx = document.createElement("canvas").getContext("2d", { willReadFrequently: true });
  const resolve = (token: string, fallback: string): string => {
    probe.style.color = `var(${token}, ${fallback})`;
    const computed = getComputedStyle(probe).color || fallback;
    if (!ctx) {
      return computed;
    }
    ctx.clearRect(0, 0, 1, 1);
    ctx.fillStyle = computed;
    ctx.fillRect(0, 0, 1, 1);
    const px = ctx.getImageData(0, 0, 1, 1).data;
    const r = px[0] ?? 0;
    const g = px[1] ?? 0;
    const b = px[2] ?? 0;
    const a = px[3] ?? 255;
    return a === 255 ? `rgb(${r}, ${g}, ${b})` : `rgba(${r}, ${g}, ${b}, ${(a / 255).toFixed(3)})`;
  };
  try {
    return {
      background: resolve("--term-bg", "#1e1d1a"),
      foreground: resolve("--term-fg", "#e8e3d9"),
      cursor: resolve("--term-cursor", "#a0d6c6"),
      cursorAccent: resolve("--term-cursor-accent", "#191814"),
      selectionBackground: resolve("--term-selection-bg", "#334039"),
      selectionForeground: resolve("--term-selection-fg", "#e8e3d9"),
      black: resolve("--term-black", "#34312b"),
      red: resolve("--term-red", "#d58b78"),
      green: resolve("--term-green", "#82bfa8"),
      yellow: resolve("--term-yellow", "#cdab6d"),
      blue: resolve("--term-blue", "#7fa8cf"),
      magenta: resolve("--term-magenta", "#bb96c4"),
      cyan: resolve("--term-cyan", "#79b7a5"),
      white: resolve("--term-white", "#cfc8ba"),
      brightBlack: resolve("--term-bright-black", "#6c685f"),
      brightRed: resolve("--term-bright-red", "#e7a18d"),
      brightGreen: resolve("--term-bright-green", "#9bd9bd"),
      brightYellow: resolve("--term-bright-yellow", "#e3c585"),
      brightBlue: resolve("--term-bright-blue", "#9cc2e0"),
      brightMagenta: resolve("--term-bright-magenta", "#d0b0d8"),
      brightCyan: resolve("--term-bright-cyan", "#a0d6c6"),
      brightWhite: resolve("--term-bright-white", "#f0eadf"),
    };
  } finally {
    probe.remove();
  }
}

interface TaskTerminal {
  taskId: string;
  /** Runtime identity currently rendered. Null only until replay/live data
   *  identifies a just-created entry. */
  generation: number | null;
  terminal: Terminal;
  fit: FitAddon;
  search: SearchAddon;
  element: HTMLDivElement;
  opened: boolean;
  hydrating: boolean;
  /** Live pty:data chunks that arrived while `hydrating` — buffered (not dropped)
   *  so hydrateData can stitch the tail onto the replay snapshot by seq. Drained
   *  and left empty once hydration completes. */
  buffer: HydrationChunk[];
  /** Running char total of `buffer` (UTF-16 length, a cheap memory proxy), kept so
   *  the cap check stays O(1) per chunk under a hard stream — re-summing the
   *  buffer per push would be O(n²) across a slow hydration under a small-chunk
   *  flood. */
  bufferedChars: number;
  disposers: Array<() => void>;
}

const terminals = new Map<string, TaskTerminal>();
// A persistent task id may outlive many TerminalHosts. Keep the newest retired
// generation after its xterm is gone so no-entry data can distinguish a stale
// tail (ignore) from a genuinely newer runtime (recreate if this task is active).
const retiredTerminalGenerations = new Map<string, number>();
let activeTaskId: string | null = null;
let activeLive = false;
let activeBinding: TerminalActiveTaskState | null = null;
// Monotonic renderer-local diagnostic beacon. Generation-race E2E uses this
// to distinguish recovery driven by fresh pty:data from recovery that merely
// happened to coincide with a delayed Reading binding refresh.
let activeBindingRevision = 0;
// The task the open find box is bound to (declared early — a render-time
// reference to a later `let` would hit the temporal dead zone).
let searchBoundTaskId: string | null = null;

function forwardUserInput(taskId: string, data: string): void {
  // Only the active (focused, visible) terminal receives keystrokes, and only
  // forward while its task is live.
  if (taskId !== activeTaskId || !activeLive || !data) {
    return;
  }
  void window.duetRuntime.writeTerminalUserInput({ taskId, data }).catch(() => {});
}

function fitAndResize(entry: TaskTerminal): void {
  if (!entry.opened) {
    return;
  }
  try {
    entry.fit.fit();
  } catch {
    // Measurable only after layout is ready; the next fit reconciles.
  }
  void window.duetRuntime
    .resizeTerminal({ taskId: entry.taskId, cols: entry.terminal.cols, rows: entry.terminal.rows })
    .catch(() => {
      // The host rejects a resize for a task that just ended; harmless.
    });
}

function createTaskTerminal(taskId: string): TaskTerminal {
  const term = new Terminal({
    allowProposedApi: true,
    convertEol: true,
    cursorBlink: false,
    fontFamily: terminalFontFamily || '"Maple Mono NF CN", "PingFang SC", Menlo, monospace',
    fontSize: 13,
    lineHeight: 1.2,
    letterSpacing: 0,
    cursorInactiveStyle: "outline",
    scrollback: 10000,
    linkHandler: { activate: (_event, text) => openExternalTerminalLink(text) },
    theme: terminalTheme(),
  });
  const fit = new FitAddon();
  term.loadAddon(fit);
  term.loadAddon(new Unicode11Addon());
  term.unicode.activeVersion = "11";
  const search = new SearchAddon();
  term.loadAddon(search);
  term.loadAddon(new WebLinksAddon((_event, uri) => openExternalTerminalLink(uri)));
  const resultsListener = search.onDidChangeResults((result) => {
    if (activeTaskId === taskId && searchBoundTaskId === taskId) {
      updateSearchCount(result);
    }
  });

  // Mounted hidden; shown when this task becomes active. xterm buffers writes
  // issued before open(), so a hidden terminal keeps a faithful mirror.
  const element = document.createElement("div");
  element.className = "task-terminal hidden";
  element.dataset.taskId = taskId;
  termMount.append(element);

  const dataListener = term.onData((data) => forwardUserInput(taskId, data));
  const binaryListener = term.onBinary((data) => forwardUserInput(taskId, data));

  // Cmd+C copies the selection (macOS expectation); Ctrl+C still reaches the PTY.
  term.attachCustomKeyEventHandler((event) => {
    if (event.type === "keydown" && event.metaKey && event.key === "c" && term.hasSelection()) {
      void navigator.clipboard.writeText(term.getSelection()).catch(() => {});
      return false;
    }
    return true;
  });

  const onMouseUp = (): void => {
    if (!TERMINAL_COPY_ON_SELECT) {
      return;
    }
    const selection = term.getSelection();
    if (selection) {
      void navigator.clipboard.writeText(selection).catch(() => {});
    }
  };
  element.addEventListener("mouseup", onMouseUp);

  // Right-click pastes (terminal convention) via the main-process clipboard read
  // so bracketed-paste is honoured and it rides the single-writer onData path.
  const onContextMenu = (event: MouseEvent): void => {
    event.preventDefault();
    if (taskId !== activeTaskId || !activeLive) {
      return;
    }
    void window.duetRuntime
      .readClipboardText()
      .then(({ text }) => {
        if (text) {
          term.paste(text);
        }
      })
      .catch(() => {});
  };
  element.addEventListener("contextmenu", onContextMenu);

  const entry: TaskTerminal = {
    taskId,
    generation: null,
    terminal: term,
    fit,
    search,
    element,
    opened: false,
    hydrating: true,
    buffer: [],
    bufferedChars: 0,
    disposers: [
      () => dataListener.dispose(),
      () => binaryListener.dispose(),
      () => resultsListener.dispose(),
      () => element.removeEventListener("mouseup", onMouseUp),
      () => element.removeEventListener("contextmenu", onContextMenu),
    ],
  };
  terminals.set(taskId, entry);
  return entry;
}

function ensureTaskTerminal(taskId: string): TaskTerminal {
  const existing = terminals.get(taskId);
  if (existing) {
    return existing;
  }
  const entry = createTaskTerminal(taskId);
  void hydrateData(entry);
  return entry;
}

/** Restore recent scrollback into the (unopened) buffer from the main-process
 *  mirror, then stitch on the live tail that arrived while the replay IPC was in
 *  flight. Live pty:data is buffered (not dropped) during hydration and applied
 *  here by seq, so the (re)opened window loses no bytes and duplicates none.
 *  Opening happens on first show. */
async function hydrateData(entry: TaskTerminal): Promise<void> {
  let snapshot: TerminalReplaySnapshot | null = null;
  try {
    snapshot = await window.duetRuntime.replayTerminal({ taskId: entry.taskId });
  } catch {
    // No mirror (task not live yet) — start blank and tail forward.
  }
  if (terminals.get(entry.taskId) !== entry) {
    return;
  }
  // No `await` from here through `hydrating = false`: the snapshot body and the
  // buffered tail are applied in one synchronous run, so no live chunk can slip
  // in mid-drain and reorder. xterm's write queue is FIFO, so call-order is
  // apply-order.
  const generation = hydrationGeneration(snapshot, entry.buffer);
  const compatibleSnapshot = snapshot?.generation === generation ? snapshot : null;
  if (compatibleSnapshot) {
    // Restore at the captured geometry BEFORE open() so wrapping matches; the
    // fit on first show reflows to the window size.
    entry.terminal.resize(compatibleSnapshot.cols, compatibleSnapshot.rows);
  }
  for (const chunk of stitchHydration(snapshot, entry.buffer)) {
    entry.terminal.write(chunk);
  }
  entry.generation = generation;
  if (generation !== null) {
    entry.element.dataset.generation = String(generation);
  }
  entry.buffer.length = 0;
  entry.bufferedChars = 0;
  entry.hydrating = false;
  if (entry.taskId === activeTaskId && entry.opened) {
    fitAndResize(entry);
  }
}

/** Hydration lasts one replay round-trip (sub-100ms typically), so the buffer is
 *  normally tiny. Cap its size so a task streaming hard through a slow round-trip
 *  can't grow it without bound. If it ever trips, scrollback across the hydration
 *  boundary may show a gap for that task — memory safety over completeness in a
 *  pathological case, and never silent. */
const HYDRATION_BUFFER_MAX_CHARS = 8_000_000;

/** Append a live chunk to a hydrating terminal's buffer, enforcing the size cap
 *  with drop-oldest + a logged warning (never a silent cap). Keeps at least the
 *  newest chunk so a lone oversized chunk can't empty the buffer. */
function bufferDuringHydration(
  entry: TaskTerminal,
  generation: number,
  data: string,
  seq: number,
): void {
  entry.buffer.push({ generation, data, seq });
  entry.bufferedChars += data.length;
  if (entry.bufferedChars <= HYDRATION_BUFFER_MAX_CHARS) {
    return;
  }
  let dropped = 0;
  let droppedChars = 0;
  while (entry.bufferedChars > HYDRATION_BUFFER_MAX_CHARS && entry.buffer.length > 1) {
    const oldest = entry.buffer.shift();
    if (!oldest) {
      break;
    }
    entry.bufferedChars -= oldest.data.length;
    dropped += 1;
    droppedChars += oldest.data.length;
  }
  if (dropped > 0) {
    console.warn(
      `[terminal] hydration buffer for ${entry.taskId} exceeded ${HYDRATION_BUFFER_MAX_CHARS} ` +
        `chars; dropped ${dropped} oldest chunk(s) (${droppedChars} chars). Scrollback across ` +
        `the hydration boundary may show a gap for this task.`,
    );
  }
}

/** Open the xterm into its element — gated on the font, and only for the active
 *  (visible) terminal so cell metrics measure a real box. */
function openTaskTerminal(entry: TaskTerminal): void {
  void terminalFontsReady.then(() => {
    if (terminals.get(entry.taskId) !== entry || entry.opened || entry.taskId !== activeTaskId) {
      return;
    }
    entry.terminal.open(entry.element);
    entry.opened = true;
    if (TERMINAL_LIGATURES) {
      entry.terminal.registerCharacterJoiner(ligatureJoiner);
    }
    fitAndResize(entry);
  });
}

function disposeTaskTerminal(taskId: string): void {
  const entry = terminals.get(taskId);
  if (!entry) {
    return;
  }
  const generation = hydrationGeneration(null, entry.buffer) ?? entry.generation;
  if (generation !== null) {
    retireTerminalGeneration(taskId, generation);
  }
  if (searchBoundTaskId === taskId) {
    entry.search.clearDecorations();
    searchBoundTaskId = null;
    searchBox.classList.add("hidden");
  }
  terminals.delete(taskId);
  for (const dispose of entry.disposers) {
    dispose();
  }
  entry.terminal.dispose();
  entry.element.remove();
}

function retireTerminalGeneration(taskId: string, generation: number): void {
  retiredTerminalGenerations.set(
    taskId,
    Math.max(retiredTerminalGenerations.get(taskId) ?? -1, generation),
  );
}

/** Show the active task's terminal; hide the rest (no DOM re-parenting — the v6
 *  re-render-on-reopen regression bites there). Open the active one lazily. When
 *  there is no terminal for the active task — either nothing is selected, or the
 *  selected session is dormant (no PTY to mirror) — show a placeholder that says
 *  which, rather than a blank grid. */
function showActiveTerminal(): void {
  for (const [id, entry] of terminals) {
    entry.element.classList.toggle("hidden", id !== activeTaskId || !activeLive);
  }
  const entry = activeTaskId && activeLive ? terminals.get(activeTaskId) ?? null : null;
  if (!entry) {
    renderEmptySurface();
    emptyState.classList.remove("hidden");
    return;
  }
  emptyState.classList.add("hidden");
  if (!entry.opened) {
    openTaskTerminal(entry);
  } else {
    fitAndResize(entry);
  }
}

function renderEmptySurface(): void {
  const surface = activeBinding?.emptySurface ?? {
    kind: "fresh",
    phase: "ready",
    disabledReason: "Loading task settings",
  };
  emptyAction.classList.remove("hidden");
  emptyAction.disabled = false;
  if (surface.kind === "fresh") {
    const starting = surface.phase === "starting";
    emptyAction.textContent = starting ? "Starting…" : "Start CLI";
    emptyAction.disabled = starting || Boolean(surface.disabledReason);
    emptyDetail.textContent =
      surface.disabledReason ??
      "Start with the current task settings without sending a prompt.";
    return;
  }
  if (surface.kind === "dormant") {
    const progressing = surface.phase !== "ready";
    emptyAction.textContent =
      surface.phase === "preparing"
        ? "Preparing…"
        : surface.phase === "resuming"
          ? "Resuming…"
          : "Resume task";
    emptyAction.disabled = progressing || Boolean(surface.disabledReason);
    emptyDetail.textContent =
      surface.disabledReason ?? "Resume this task without sending the Composer draft.";
    return;
  }
  emptyAction.classList.add("hidden");
  emptyAction.disabled = true;
  emptyDetail.textContent =
    surface.kind === "resume-choice"
      ? "Choose how to resume in Duet. Summary mode compacts first."
      : "CLI is getting ready…";
}

emptyAction.addEventListener("click", () => {
  const surface = activeBinding?.emptySurface;
  if (!surface || emptyAction.disabled) {
    return;
  }
  const request =
    surface.kind === "fresh" && surface.phase === "ready"
      ? { action: "start" as const, expectedTaskId: null }
      : surface.kind === "dormant" && surface.phase === "ready"
        ? { action: "resume" as const, expectedTaskId: surface.taskId }
        : null;
  if (!request) {
    return;
  }
  // Close the pre-binding double-click window locally. Reading remains the
  // authoritative state owner and will shortly push the claimed phase back.
  emptyAction.disabled = true;
  emptyDetail.textContent = request.action === "start" ? "Starting CLI…" : "Preparing resume…";
  void window.duetRuntime.requestCliAction(request).catch(() => {
    renderEmptySurface();
  });
});

function applyActiveTask(next: TerminalActiveTaskState): void {
  activeBindingRevision += 1;
  appElement.dataset.activeTaskBindingRevision = String(activeBindingRevision);
  if (searchBoundTaskId && (searchBoundTaskId !== next.taskId || !next.live)) {
    // The find box lives on one terminal's decorations; a task switch or PTY
    // retirement closes it before that xterm is disposed.
    terminals.get(searchBoundTaskId)?.search.clearDecorations();
    searchBoundTaskId = null;
    searchBox.classList.add("hidden");
  }
  activeTaskId = next.taskId;
  activeLive = next.live;
  activeBinding = next;
  projectName.textContent = next.projectName;
  projectName.title = next.projectName;
  sessionTitle.textContent = next.sessionTitle;
  sessionTitle.title = next.sessionTitle;
  // Dispose terminals whose task has closed.
  for (const id of [...terminals.keys()]) {
    if (!next.openTaskIds.includes(id)) {
      disposeTaskTerminal(id);
    }
  }
  // A task can remain open in Reading after its PTY exits or its project is
  // archived. Its old xterm buffer belongs to that dead PTY: dispose it as
  // soon as the authoritative binding says dormant. A later live=true binding
  // creates and hydrates a fresh xterm for the newly resumed process.
  if (next.taskId && !next.live) {
    disposeTaskTerminal(next.taskId);
  }
  // Only a live task has a PTY to mirror; creating an xterm for a dormant
  // (history-loaded) session would just show a blank grid and linger in the map.
  // The dormant→live transition re-pushes with live=true and creates it then.
  if (next.taskId && next.live) {
    ensureTaskTerminal(next.taskId);
  }
  showActiveTerminal();
}

// --- Find (Cmd+F) ------------------------------------------------------------
const TERMINAL_SEARCH_DECORATIONS = {
  matchBackground: "rgba(205, 171, 109, 0.30)",
  matchOverviewRuler: "rgba(205, 171, 109, 0.70)",
  activeMatchBackground: "rgba(121, 183, 165, 0.55)",
  activeMatchBorder: "rgba(160, 214, 198, 0.90)",
  activeMatchColorOverviewRuler: "rgba(121, 183, 165, 0.90)",
};

function activeEntry(): TaskTerminal | null {
  return activeTaskId ? terminals.get(activeTaskId) ?? null : null;
}

function updateSearchCount(result?: { resultIndex: number; resultCount: number }): void {
  const hasQuery = searchInput.value.length > 0;
  if (!result || result.resultCount === 0) {
    searchCount.textContent = hasQuery ? "No results" : "";
    return;
  }
  searchCount.textContent = `${result.resultIndex + 1}/${result.resultCount}`;
}

function runSearch(direction: "next" | "prev", incremental = false): void {
  const entry = activeEntry();
  if (!entry) {
    return;
  }
  const query = searchInput.value;
  if (!query) {
    entry.search.clearDecorations();
    updateSearchCount(undefined);
    return;
  }
  const options = { decorations: TERMINAL_SEARCH_DECORATIONS, incremental };
  if (direction === "next") {
    entry.search.findNext(query, options);
  } else {
    entry.search.findPrevious(query, options);
  }
}

function openSearch(): void {
  const entry = activeEntry();
  if (!entry) {
    return;
  }
  searchBoundTaskId = activeTaskId;
  searchBox.classList.remove("hidden");
  searchInput.focus();
  searchInput.select();
  runSearch("next", true);
}

function closeSearch(): void {
  const bound = searchBoundTaskId ? terminals.get(searchBoundTaskId) : null;
  searchBoundTaskId = null;
  searchBox.classList.add("hidden");
  bound?.search.clearDecorations();
  const entry = activeEntry();
  if (entry?.opened) {
    entry.terminal.focus();
  }
}

searchInput.addEventListener("input", () => runSearch("next", true));
searchInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter") {
    event.preventDefault();
    runSearch(event.shiftKey ? "prev" : "next");
  } else if (event.key === "Escape") {
    event.preventDefault();
    closeSearch();
  }
});
searchPrev.addEventListener("click", () => runSearch("prev"));
searchNext.addEventListener("click", () => runSearch("next"));
searchClose.addEventListener("click", () => closeSearch());
document.addEventListener(
  "keydown",
  (event) => {
    if (
      (event.metaKey || event.ctrlKey) &&
      !event.altKey &&
      event.key.toLowerCase() === "f" &&
      activeEntry()
    ) {
      event.preventDefault();
      openSearch();
    }
  },
  true,
);

// --- Theme (the terminal's own, independent of the main window) --------------
const THEME_OPTIONS: Array<{ id: ReadingThemeId; label: string }> = [
  { id: "duet", label: "Duet" },
  { id: "paper", label: "Paper" },
  { id: "calm", label: "Calm" },
  { id: "focus", label: "Focus" },
];
const MODE_OPTIONS: Array<{ id: ReadingModeSetting; label: string }> = [
  { id: "auto", label: "Auto" },
  { id: "light", label: "Light" },
  { id: "dark", label: "Dark" },
];

let settings: TerminalWindowSettings = { ...DEFAULT_TERMINAL_WINDOW_SETTINGS };

function resolvedMode(mode: ReadingModeSetting): ResolvedReadingMode {
  if (mode !== "auto") {
    return mode;
  }
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

/** Stamp the terminal window's own theme/mode on the root and repaint every
 *  xterm's palette from the resulting --term-* tokens. */
function applyAppearance(): void {
  document.documentElement.dataset.theme = settings.theme;
  document.documentElement.dataset.mode = resolvedMode(settings.mode);
  const theme = terminalTheme();
  for (const entry of terminals.values()) {
    entry.terminal.options.theme = theme;
  }
}

function renderThemePopover(): void {
  const resolved = resolvedMode(settings.mode);
  const cards = THEME_OPTIONS.map(
    (option) => `
      <button class="terminal-theme-card${option.id === settings.theme ? " selected" : ""}"
        type="button" data-theme-choice="${option.id}" data-theme="${option.id}"
        data-mode="${resolved}" aria-pressed="${option.id === settings.theme}">
        <span class="terminal-theme-swatch">Aa</span>
        <span class="terminal-theme-name">${option.label}</span>
      </button>`,
  ).join("");
  const modes = MODE_OPTIONS.map(
    (option) => `<button class="terminal-mode-btn${option.id === settings.mode ? " selected" : ""}"
      type="button" data-mode-choice="${option.id}" aria-pressed="${option.id === settings.mode}">${option.label}</button>`,
  ).join("");
  themePopover.innerHTML = `
    <div class="terminal-theme-section">
      <p class="terminal-theme-heading">Theme</p>
      <div class="terminal-theme-grid">${cards}</div>
    </div>
    <div class="terminal-theme-section">
      <p class="terminal-theme-heading">Mode</p>
      <div class="terminal-mode-row">${modes}</div>
    </div>
  `;
}

function persistAppearance(): void {
  void window.duetRuntime.writeTerminalWindowSettings({ ...settings }).catch(() => {});
}

function setPopoverOpen(open: boolean): void {
  themePopover.classList.toggle("hidden", !open);
  themeTrigger.setAttribute("aria-expanded", String(open));
  if (open) {
    renderThemePopover();
  }
}

themeTrigger.addEventListener("click", (event) => {
  event.stopPropagation();
  setPopoverOpen(themePopover.classList.contains("hidden"));
});

themePopover.addEventListener("click", (event) => {
  // Keep the click inside the popover: selecting a card re-renders (detaching
  // the target), which would otherwise read as an outside click and close it.
  event.stopPropagation();
  const target = (event.target as HTMLElement).closest<HTMLElement>(
    "[data-theme-choice],[data-mode-choice]",
  );
  if (!target) {
    return;
  }
  const themeChoice = target.dataset.themeChoice as ReadingThemeId | undefined;
  const modeChoice = target.dataset.modeChoice as ReadingModeSetting | undefined;
  if (themeChoice) {
    settings = { ...settings, theme: themeChoice };
  } else if (modeChoice) {
    settings = { ...settings, mode: modeChoice };
  } else {
    return;
  }
  applyAppearance();
  renderThemePopover();
  persistAppearance();
});

document.addEventListener("click", (event) => {
  if (
    !themePopover.classList.contains("hidden") &&
    !themePopover.contains(event.target as Node) &&
    event.target !== themeTrigger
  ) {
    setPopoverOpen(false);
  }
});

window.duetRuntime.onRuntimeEvent((event) => {
  if (event.type === "pty:exit") {
    const entry = terminals.get(event.payload.taskId);
    const knownGeneration = entry
      ? (hydrationGeneration(null, entry.buffer) ?? entry.generation)
      : null;
    const newestKnownGeneration = Math.max(
      knownGeneration ?? -1,
      retiredTerminalGenerations.get(event.payload.taskId) ?? -1,
    );
    // Main's RunIndex fence already drops stale exits. The comparison is a
    // second renderer-side guard for IPC reordering: an older exit can never
    // retire an entry that has already observed a newer generation.
    if (event.payload.generation >= newestKnownGeneration) {
      retireTerminalGeneration(event.payload.taskId, event.payload.generation);
      if (entry) {
        disposeTaskTerminal(event.payload.taskId);
      }
      if (event.payload.taskId === activeTaskId) {
        activeLive = false;
        showActiveTerminal();
      }
    }
    return;
  }
  if (event.type !== "pty:data") {
    return;
  }
  const retiredGeneration = retiredTerminalGenerations.get(event.payload.taskId) ?? -1;
  if (event.payload.generation <= retiredGeneration) {
    return;
  }
  let entry = terminals.get(event.payload.taskId);
  if (!entry) {
    // close→immediate reopen can coalesce Reading's idle/running refresh into
    // live→live, so no binding edge arrives after the accepted old exit. Newer
    // PTY data is itself sufficient proof that the still-selected task owns a
    // live replacement runtime; rebuild and restore forwarding immediately.
    if (
      event.payload.taskId !== activeTaskId ||
      activeBinding?.taskId !== event.payload.taskId ||
      !activeBinding.live
    ) {
      return;
    }
    activeLive = true;
    entry = ensureTaskTerminal(event.payload.taskId);
    bufferDuringHydration(
      entry,
      event.payload.generation,
      event.payload.data,
      event.payload.seq,
    );
    showActiveTerminal();
    return;
  }
  const knownGeneration = hydrationGeneration(null, entry.buffer) ?? entry.generation;
  if (knownGeneration !== null && event.payload.generation < knownGeneration) {
    return;
  }
  if (knownGeneration !== null && event.payload.generation > knownGeneration) {
    // A persistent task id has acquired a new TerminalHost before the old
    // renderer entry saw an exit (close→immediate reopen). Rebuild now; mixing
    // even one chunk or one replay body across generations is forbidden.
    disposeTaskTerminal(event.payload.taskId);
    const replacement = ensureTaskTerminal(event.payload.taskId);
    bufferDuringHydration(
      replacement,
      event.payload.generation,
      event.payload.data,
      event.payload.seq,
    );
    if (event.payload.taskId === activeTaskId && activeLive) {
      showActiveTerminal();
    }
    return;
  }
  if (entry.hydrating) {
    // Buffer (don't drop) live chunks racing the in-flight replay IPC; hydrateData
    // stitches them onto the snapshot by seq once it lands.
    bufferDuringHydration(
      entry,
      event.payload.generation,
      event.payload.data,
      event.payload.seq,
    );
    return;
  }
  if (entry.generation === null) {
    entry.generation = event.payload.generation;
    entry.element.dataset.generation = String(event.payload.generation);
  }
  entry.terminal.write(event.payload.data);
});

window.duetRuntime.onActiveTerminalTask(applyActiveTask);
window.duetRuntime.onReadingSystemModeChanged(() => {
  // Only "auto" follows the system; an explicit light/dark choice is pinned.
  if (settings.mode === "auto") {
    applyAppearance();
  }
});
window.addEventListener("resize", () => {
  if (!activeTaskId) {
    return;
  }
  const entry = terminals.get(activeTaskId);
  if (entry) {
    fitAndResize(entry);
  }
});

void (async () => {
  try {
    settings = await window.duetRuntime.readTerminalWindowSettings();
  } catch {
    settings = { ...DEFAULT_TERMINAL_WINDOW_SETTINGS };
  }
  applyAppearance();
  try {
    applyActiveTask(await window.duetRuntime.readActiveTerminalTask());
  } catch {
    // No active task read yet; the onActiveTerminalTask broadcast populates it.
  }
})();
