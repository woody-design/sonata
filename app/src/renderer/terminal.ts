import "./styles.css";
import "@xterm/xterm/css/xterm.css";
import { FitAddon } from "@xterm/addon-fit";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { Terminal, type ITheme } from "@xterm/xterm";
import type { ReadingSettings, ResolvedReadingMode, TerminalActiveTaskState } from "../shared/types";

// The terminal satellite window's xterm view. The PTY lives in the main
// process; this renders it. One live xterm PER TASK (kept alive so switching
// tasks is instant), fed the live pty:data broadcast and hydrated from the
// main-process headless mirror on creation. The active task — relayed via
// onActiveTerminalTask — is the one shown; the rest stay mounted-but-hidden and
// keep accumulating. Terminals whose task has closed are disposed. The whole
// subsystem was lifted out of the main window's renderer; Cmd+F search lands in
// a later slice.

function requireEl<T extends HTMLElement>(selector: string): T {
  const element = document.querySelector<T>(selector);
  if (!element) {
    throw new Error(`Terminal window element not found: ${selector}`);
  }
  return element;
}

const appElement = requireEl<HTMLDivElement>("#app");
appElement.innerHTML = `
  <section class="terminal-window-shell" aria-label="Duet Terminal">
    <header class="terminal-window-topbar">
      <p class="eyebrow">Terminal</p>
      <div class="terminal-window-topbar-actions"></div>
    </header>
    <section class="terminal-window-content">
      <div id="terminal-window-term" class="terminal-window-term"></div>
      <p id="terminal-window-empty" class="terminal-window-placeholder">No active task — start or select one in Duet.</p>
    </section>
  </section>
`;

const termMount = requireEl<HTMLDivElement>("#terminal-window-term");
const emptyState = requireEl<HTMLParagraphElement>("#terminal-window-empty");

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
// color(srgb ...). Identical to the main window's resolver so the two surfaces
// read the same until the terminal gets its own theme control.
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
  terminal: Terminal;
  fit: FitAddon;
  element: HTMLDivElement;
  opened: boolean;
  hydrating: boolean;
  disposers: Array<() => void>;
}

const terminals = new Map<string, TaskTerminal>();
let activeTaskId: string | null = null;
let activeLive = false;

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
  term.loadAddon(new WebLinksAddon((_event, uri) => openExternalTerminalLink(uri)));

  // Mounted hidden; shown when this task becomes active. xterm buffers writes
  // issued before open(), so a hidden terminal keeps a faithful mirror.
  const element = document.createElement("div");
  element.className = "task-terminal hidden";
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
    terminal: term,
    fit,
    element,
    opened: false,
    hydrating: true,
    disposers: [
      () => dataListener.dispose(),
      () => binaryListener.dispose(),
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
 *  mirror. Live pty:data is dropped while hydrating so the snapshot — which
 *  already covers it — isn't double-applied. Opening happens on first show. */
async function hydrateData(entry: TaskTerminal): Promise<void> {
  let snapshot = null;
  try {
    snapshot = await window.duetRuntime.replayTerminal({ taskId: entry.taskId });
  } catch {
    // No mirror (task not live yet) — start blank and tail forward.
  }
  if (terminals.get(entry.taskId) !== entry) {
    return;
  }
  if (snapshot) {
    // Restore at the captured geometry BEFORE open() so wrapping matches; the
    // fit on first show reflows to the window size.
    entry.terminal.resize(snapshot.cols, snapshot.rows);
    entry.terminal.write(snapshot.data);
  }
  entry.hydrating = false;
  if (entry.taskId === activeTaskId && entry.opened) {
    fitAndResize(entry);
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
    wireComposition(entry);
    if (TERMINAL_LIGATURES) {
      entry.terminal.registerCharacterJoiner(ligatureJoiner);
    }
    fitAndResize(entry);
  });
}

/** Forward the IME composition window so the host holds delivery until the human
 *  commits CJK — the authoritative DOM signal, not a screen scrape. */
function wireComposition(entry: TaskTerminal): void {
  const textarea = entry.terminal.textarea;
  if (!textarea) {
    return;
  }
  const onCompose = (composing: boolean) => (): void =>
    void window.duetRuntime.setTerminalComposing({ taskId: entry.taskId, composing }).catch(() => {});
  const onStart = onCompose(true);
  const onEnd = onCompose(false);
  textarea.addEventListener("compositionstart", onStart);
  textarea.addEventListener("compositionend", onEnd);
  textarea.addEventListener("blur", onEnd);
  entry.disposers.push(() => textarea.removeEventListener("compositionstart", onStart));
  entry.disposers.push(() => textarea.removeEventListener("compositionend", onEnd));
  entry.disposers.push(() => textarea.removeEventListener("blur", onEnd));
}

function disposeTaskTerminal(taskId: string): void {
  const entry = terminals.get(taskId);
  if (!entry) {
    return;
  }
  terminals.delete(taskId);
  for (const dispose of entry.disposers) {
    dispose();
  }
  entry.terminal.dispose();
  entry.element.remove();
}

/** Show the active task's terminal; hide the rest (no DOM re-parenting — the v6
 *  re-render-on-reopen regression bites there). Open the active one lazily. */
function showActiveTerminal(): void {
  for (const [id, entry] of terminals) {
    entry.element.classList.toggle("hidden", id !== activeTaskId);
  }
  if (!activeTaskId) {
    emptyState.classList.remove("hidden");
    return;
  }
  emptyState.classList.add("hidden");
  const entry = terminals.get(activeTaskId);
  if (!entry) {
    return;
  }
  if (!entry.opened) {
    openTaskTerminal(entry);
  } else {
    fitAndResize(entry);
  }
}

function applyActiveTask(next: TerminalActiveTaskState): void {
  activeTaskId = next.taskId;
  activeLive = next.live;
  // Dispose terminals whose task has closed.
  for (const id of [...terminals.keys()]) {
    if (!next.openTaskIds.includes(id)) {
      disposeTaskTerminal(id);
    }
  }
  if (next.taskId) {
    ensureTaskTerminal(next.taskId);
  }
  showActiveTerminal();
}

function resolvedMode(settings: ReadingSettings): ResolvedReadingMode {
  if (settings.mode !== "auto") {
    return settings.mode;
  }
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

// Match the main window's theme/mode on boot so the two surfaces read alike.
// (A later slice gives the terminal its own persisted theme.)
async function stampTheme(): Promise<void> {
  try {
    const reading = await window.duetRuntime.readReadingSettings();
    document.documentElement.dataset.theme = reading.theme;
    document.documentElement.dataset.mode = resolvedMode(reading);
  } catch {
    // Fall back to the default :root palette.
  }
  const theme = terminalTheme();
  for (const entry of terminals.values()) {
    entry.terminal.options.theme = theme;
  }
}

window.duetRuntime.onRuntimeEvent((event) => {
  if (event.type !== "pty:data") {
    return;
  }
  const entry = terminals.get(event.payload.taskId);
  if (!entry || entry.hydrating) {
    return;
  }
  entry.terminal.write(event.payload.data);
});

window.duetRuntime.onActiveTerminalTask(applyActiveTask);
window.duetRuntime.onReadingSystemModeChanged(() => {
  void stampTheme();
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
  await stampTheme();
  applyActiveTask(await window.duetRuntime.readActiveTerminalTask());
})();
