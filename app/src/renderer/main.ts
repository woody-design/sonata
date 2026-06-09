import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import DOMPurify from "dompurify";
import { marked } from "marked";
import "@xterm/xterm/css/xterm.css";
import "./styles.css";
import type {
  ApprovalDecision,
  ArtifactCandidate,
  LaunchSpeedMode,
  ReasoningEffort,
  RuntimeProvider,
  Task,
} from "../shared/types";
import type { ApprovalDetectedEvent, TranscriptBlocksEvent } from "../shared/types/events";
import type { FocusArtifactInMainRequest, PreviewWindowTab } from "../shared/types/ipc";
import type {
  ToolCallBlock,
  TranscriptBlock,
  TranscriptSourceRef,
} from "../shared/types/transcript";
import type { RuntimeReportV1, RuntimeRunReport } from "../shared/schemas";
import { cleanTerminalTranscript } from "../shared/terminal-transcript";

interface RunTranscript {
  runId: string;
  rawText: string;
  text: string;
  truncated: boolean;
  receivedChars: number;
}

interface TaskViewState {
  task: Task | null;
  report: RuntimeReportV1 | null;
  artifacts: ArtifactCandidate[];
  selectedArtifactPath: string | null;
  pendingApproval: ApprovalDetectedEvent["payload"] | null;
  highlightedRunId: string | null;
  liveTranscriptRunId: string | null;
  runTranscripts: RunTranscript[];
  transcriptBlocks: Map<string, TranscriptBlock>;
  transcriptBlockOrder: string[];
  transcriptSources: TranscriptSourceRef[];
  terminalBuffer: string;
  runtimeReady: boolean;
  composerObserved: boolean;
  status: string;
  unread: boolean;
}

interface ReadingTurn {
  key: string;
  runId: string | null;
  run: RuntimeRunReport | null;
  blocks: TranscriptBlock[];
  fallbackText: string | null;
  tsMs: number;
}

interface RendererState {
  taskViews: TaskViewState[];
  activeTaskId: string | null;
  previewTabs: PreviewWindowTab[];
  taskDraft: TaskLaunchDraft;
  terminalOpen: boolean;
  busy: boolean;
  status: string;
}

interface TaskLaunchDraft {
  provider: RuntimeProvider;
  cwd: string | null;
  settingsOpen: boolean;
  settingsAnchor: { left: number; top: number; width: number } | null;
  message: TaskEntryMessage | null;
  model: Record<RuntimeProvider, string | null>;
  reasoningEffort: Record<RuntimeProvider, ReasoningEffort | null>;
  speedMode: Record<RuntimeProvider, LaunchSpeedMode | null>;
}

interface TaskEntryMessage {
  tone: "info" | "error";
  text: string;
}

const state: RendererState = {
  taskViews: [],
  activeTaskId: null,
  previewTabs: [],
  taskDraft: {
    provider: "codex",
    cwd: null,
    settingsOpen: false,
    settingsAnchor: null,
    message: null,
    model: {
      codex: "gpt-5.5",
      claude: "opus",
    },
    reasoningEffort: {
      codex: "xhigh",
      claude: "xhigh",
    },
    speedMode: {
      codex: "default",
      claude: null,
    },
  },
  terminalOpen: false,
  busy: false,
  status: "Idle",
};

const appElement = document.querySelector<HTMLDivElement>("#app");

if (!appElement) {
  throw new Error("Renderer mount point was not found.");
}

appElement.innerHTML = `
  <section class="shell" aria-label="Duet">
    <header class="topbar">
      <div class="title-block">
        <p class="eyebrow">Duet</p>
        <h1 id="task-title">No active Task</h1>
      </div>
      <div class="topbar-actions">
        <span id="runtime-status" class="status">Idle</span>
        <button id="open-preview-window" class="secondary" type="button">Preview</button>
        <button id="open-inspector-window" class="secondary" type="button">Inspector</button>
        <button id="toggle-terminal" class="secondary" type="button">Terminal</button>
        <button id="open-task" class="secondary" type="button">Open Task</button>
        <button id="new-task" class="secondary" type="button">New Codex Task</button>
        <button id="new-claude-task" class="secondary" type="button">New Claude Task</button>
      </div>
    </header>

    <nav id="task-tabs" class="task-tabs" aria-label="Task tabs"></nav>

    <section class="workspace">
      <section class="run-column" aria-label="Run reading surface">
        <div id="approval-banner" class="approval-banner hidden">
          <div class="approval-copy">
            <div class="approval-heading">
              <p class="eyebrow">Native Approval</p>
              <span id="approval-kind-badge" class="approval-kind-badge">Unknown</span>
            </div>
            <strong id="approval-title">Native approval requested</strong>
            <p id="approval-summary" class="approval-summary"></p>
            <div id="approval-context" class="approval-context"></div>
          </div>
          <div class="approval-actions">
            <button id="deny-approval" class="secondary" type="button">Deny</button>
            <button id="approve-session-approval" class="secondary hidden" type="button">Allow Session</button>
            <button id="approve-approval" class="primary" type="button">Approve</button>
          </div>
        </div>

        <section class="workflow-strip" aria-label="Task workflow state">
          <div class="workflow-copy">
            <p class="eyebrow">Task</p>
            <strong id="workflow-headline">Start or open a Task</strong>
          </div>
          <div id="workflow-facts" class="workflow-facts"></div>
        </section>

        <section id="artifact-strip" class="artifact-strip hidden" aria-label="Artifact candidates">
          <div class="artifact-strip-header">
            <div>
              <p class="eyebrow">Artifacts</p>
              <strong>Review in Preview</strong>
            </div>
            <button id="open-selected-preview" class="secondary" type="button">Open Preview</button>
          </div>
          <div id="artifact-list" class="artifact-list"></div>
        </section>

        <div id="run-list" class="run-list"></div>

        <section id="terminal-drawer" class="terminal-drawer hidden" aria-label="Terminal trust layer">
          <div class="terminal-drawer-header">
            <div>
              <p class="eyebrow">Terminal</p>
              <strong>Trust / debug mirror</strong>
            </div>
            <button id="close-terminal" class="secondary" type="button">Close</button>
          </div>
          <div id="terminal"></div>
        </section>

        <form id="composer" class="composer">
          <textarea id="prompt-input" rows="4" placeholder="Send a prompt to the active provider"></textarea>
          <div class="composer-control-row">
            <div class="composer-control-left">
              <span id="permission-chip" class="composer-chip hidden"></span>
            </div>
            <div class="composer-actions">
              <span id="model-chip" class="composer-chip hidden"></span>
              <button id="stop-run" class="secondary" type="button" disabled>Stop</button>
              <button
                id="send-prompt"
                class="primary send-button"
                type="submit"
                disabled
                aria-label="Send prompt"
              >↑</button>
            </div>
          </div>
        </form>
      </section>
    </section>
  </section>
`;

const elements = {
  taskTitle: getElement<HTMLHeadingElement>("task-title"),
  runtimeStatus: getElement<HTMLSpanElement>("runtime-status"),
  openPreviewWindow: getElement<HTMLButtonElement>("open-preview-window"),
  openInspectorWindow: getElement<HTMLButtonElement>("open-inspector-window"),
  toggleTerminal: getElement<HTMLButtonElement>("toggle-terminal"),
  openTask: getElement<HTMLButtonElement>("open-task"),
  newTask: getElement<HTMLButtonElement>("new-task"),
  newClaudeTask: getElement<HTMLButtonElement>("new-claude-task"),
  approvalBanner: getElement<HTMLDivElement>("approval-banner"),
  approvalKindBadge: getElement<HTMLSpanElement>("approval-kind-badge"),
  approvalTitle: getElement<HTMLElement>("approval-title"),
  approvalSummary: getElement<HTMLParagraphElement>("approval-summary"),
  approvalContext: getElement<HTMLDivElement>("approval-context"),
  denyApproval: getElement<HTMLButtonElement>("deny-approval"),
  approveSessionApproval: getElement<HTMLButtonElement>("approve-session-approval"),
  approveApproval: getElement<HTMLButtonElement>("approve-approval"),
  workflowHeadline: getElement<HTMLElement>("workflow-headline"),
  workflowFacts: getElement<HTMLDivElement>("workflow-facts"),
  taskTabs: getElement<HTMLElement>("task-tabs"),
  runList: getElement<HTMLDivElement>("run-list"),
  artifactStrip: getElement<HTMLElement>("artifact-strip"),
  artifactList: getElement<HTMLDivElement>("artifact-list"),
  openSelectedPreview: getElement<HTMLButtonElement>("open-selected-preview"),
  composer: getElement<HTMLFormElement>("composer"),
  promptInput: getElement<HTMLTextAreaElement>("prompt-input"),
  permissionChip: getElement<HTMLSpanElement>("permission-chip"),
  modelChip: getElement<HTMLSpanElement>("model-chip"),
  stopRun: getElement<HTMLButtonElement>("stop-run"),
  sendPrompt: getElement<HTMLButtonElement>("send-prompt"),
  terminalDrawer: getElement<HTMLElement>("terminal-drawer"),
  closeTerminal: getElement<HTMLButtonElement>("close-terminal"),
  terminal: getElement<HTMLDivElement>("terminal"),
};

const terminal = new Terminal({
  convertEol: true,
  cursorBlink: false,
  fontFamily: "SFMono-Regular, Menlo, Consolas, monospace",
  fontSize: 12,
  theme: {
    background: "#141414",
    foreground: "#f0eee7",
  },
});
const fitAddon = new FitAddon();
terminal.loadAddon(fitAddon);
terminal.open(elements.terminal);
fitTerminal();

const pendingReadyTaskIds = new Set<string>();
let transcriptRenderTimer: number | null = null;
const MAX_TRANSCRIPT_CHARS = 120_000;
const MAX_TRANSCRIPT_RAW_CHARS = 260_000;
const MAX_TERMINAL_BUFFER_CHARS = 80_000;
const AUTO_TITLE_PLACEHOLDERS = new Set(["New Task", "Walking Skeleton Task"]);
const MODEL_OPTIONS: Record<RuntimeProvider, Array<{ label: string; value: string | null }>> = {
  codex: [
    { label: "GPT-5.5", value: "gpt-5.5" },
    { label: "Native Default", value: null },
  ],
  claude: [
    { label: "Opus", value: "opus" },
    { label: "Sonnet", value: "sonnet" },
    { label: "Native Default", value: null },
  ],
};
const REASONING_OPTIONS: Record<RuntimeProvider, Array<{ label: string; value: ReasoningEffort | null }>> = {
  codex: [
    { label: "Low", value: "low" },
    { label: "Medium", value: "medium" },
    { label: "High", value: "high" },
    { label: "Extra High", value: "xhigh" },
    { label: "Native Default", value: null },
  ],
  claude: [
    { label: "Low", value: "low" },
    { label: "Medium", value: "medium" },
    { label: "High", value: "high" },
    { label: "Extra High", value: "xhigh" },
    { label: "Max", value: "max" },
    { label: "Native Default", value: null },
  ],
};

elements.newTask.addEventListener("click", () => {
  void createTask("codex");
});

elements.newClaudeTask.addEventListener("click", () => {
  void createTask("claude");
});

elements.openTask.addEventListener("click", () => {
  void openTask();
});

elements.openPreviewWindow.addEventListener("click", () => {
  void openFloatingPreview();
});

elements.openInspectorWindow.addEventListener("click", () => {
  void openFloatingInspector();
});

elements.toggleTerminal.addEventListener("click", () => {
  setTerminalOpen(!state.terminalOpen);
});

elements.closeTerminal.addEventListener("click", () => {
  setTerminalOpen(false);
});

elements.openSelectedPreview.addEventListener("click", () => {
  void openFloatingPreview();
});

elements.composer.addEventListener("submit", (event) => {
  event.preventDefault();
  void submitPrompt();
});

elements.promptInput.addEventListener("input", () => {
  renderComposerControls();
});

elements.promptInput.addEventListener("keydown", (event) => {
  if (event.key !== "Enter" || event.shiftKey) {
    return;
  }
  if (elements.sendPrompt.disabled) {
    return;
  }
  event.preventDefault();
  elements.composer.requestSubmit();
});

elements.stopRun.addEventListener("click", () => {
  void stopRun();
});

elements.runList.addEventListener("click", (event) => {
  const target = event.target;
  if (!(target instanceof Element)) {
    return;
  }
  const anchor = target.closest("a[href]");
  if (!anchor) {
    return;
  }
  event.preventDefault();
  const href = anchor.getAttribute("href") ?? "";
  if (/^https?:\/\//i.test(href)) {
    window.open(href);
  }
});

elements.approveApproval.addEventListener("click", () => {
  void decideApproval("approve");
});

elements.approveSessionApproval.addEventListener("click", () => {
  void decideApproval("approve-for-session");
});

elements.denyApproval.addEventListener("click", () => {
  void decideApproval("deny");
});

window.addEventListener("resize", () => {
  fitTerminal();
});

document.addEventListener("click", (event) => {
  const target = event.target;
  if (!(target instanceof Element) || target.closest(".task-settings-wrap")) {
    return;
  }
  if (state.taskDraft.settingsOpen) {
    state.taskDraft.settingsOpen = false;
    state.taskDraft.settingsAnchor = null;
    render();
  }
});

window.duetRuntime.onRuntimeEvent((event) => {
  if (event.type === "pty:data") {
    const view = taskViewForId(event.payload.taskId);
    if (!view) {
      return;
    }
    appendTerminalBuffer(view, event.payload.data);
    if (isActiveView(view)) {
      terminal.write(event.payload.data);
    }
    appendLiveTranscript(view, event.payload.data);
    return;
  }

  const view = taskViewForId(event.payload.taskId);
  if (!view) {
    if (event.type === "task:ready") {
      pendingReadyTaskIds.add(event.payload.taskId);
    }
    return;
  }

  if (event.type === "run:started") {
    updateTaskTitleFromRun(view, event.payload.title);
    view.liveTranscriptRunId = event.payload.id;
    view.runtimeReady = false;
    view.status = "Running";
    ensureRunTranscript(view, event.payload.id);
    markViewChanged(view);
    return;
  }

  if (event.type === "run:updated") {
    if (!isActiveRunStatus(event.payload.status) && view.liveTranscriptRunId === event.payload.id) {
      view.liveTranscriptRunId = null;
    }
    markViewChanged(view);
    return;
  }

  if (event.type === "approval:detected") {
    view.pendingApproval = event.payload;
    view.runtimeReady = false;
    view.status = "Waiting for approval";
    markViewChanged(view);
    return;
  }

  if (event.type === "approval:decision") {
    view.pendingApproval = null;
    view.status = event.payload.decision === "deny" ? "Approval denied" : "Approval sent";
    markViewChanged(view);
    return;
  }

  if (event.type === "task:ready") {
    view.runtimeReady = true;
    view.composerObserved = true;
    view.status = hasActiveRun(view) ? view.status : "Ready";
    markViewChanged(view);
    return;
  }

  if (event.type === "run:stopped") {
    view.runtimeReady = true;
    view.status = "Stopped";
    markViewChanged(view);
  }

  if (event.type === "transcript:located") {
    view.transcriptSources = [
      ...view.transcriptSources.filter(
        (source) => source.sourceId !== event.payload.source.sourceId,
      ),
      event.payload.source,
    ];
    markViewChanged(view);
    return;
  }

  if (event.type === "transcript:blocks") {
    applyTranscriptUpserts(view, event.payload);
    if (isActiveView(view)) {
      scheduleTranscriptRender();
    } else {
      view.unread = true;
      renderTaskTabs();
    }
    return;
  }

  if (event.type === "report:updated") {
    void refreshReport(event.payload.taskId);
  }
});

window.duetRuntime.onPreviewState((previewState) => {
  state.previewTabs = previewState.tabs;
  render();
});

window.duetRuntime.onMainArtifactFocus((request) => {
  focusArtifactFromPreview(request);
});

void window.duetRuntime.readPreviewState().then((previewState) => {
  state.previewTabs = previewState.tabs;
  render();
});

render();

function createTaskView(task: Task, status: string): TaskViewState {
  const view: TaskViewState = {
    task,
    report: null,
    artifacts: [],
    selectedArtifactPath: null,
    pendingApproval: null,
    highlightedRunId: null,
    liveTranscriptRunId: null,
    runTranscripts: [],
    transcriptBlocks: new Map(),
    transcriptBlockOrder: [],
    transcriptSources: [],
    terminalBuffer: "",
    runtimeReady: false,
    composerObserved: false,
    status,
    unread: false,
  };
  applyPendingRuntimeState(view);
  return view;
}

function applyTranscriptUpserts(
  view: TaskViewState,
  payload: TranscriptBlocksEvent["payload"],
): void {
  if (payload.reset) {
    for (const [id, block] of view.transcriptBlocks) {
      if (block.sourceId === payload.sourceId) {
        view.transcriptBlocks.delete(id);
      }
    }
    view.transcriptBlockOrder = view.transcriptBlockOrder.filter((id) =>
      view.transcriptBlocks.has(id),
    );
  }

  for (const block of payload.upserts) {
    if (!view.transcriptBlocks.has(block.id)) {
      view.transcriptBlockOrder.push(block.id);
    }
    view.transcriptBlocks.set(block.id, block);
  }
}

async function hydrateTranscript(taskId: string): Promise<void> {
  const view = taskViewForId(taskId);
  if (!view?.task) {
    return;
  }
  const response = await window.duetRuntime.readTranscript({ taskId });
  view.transcriptSources = response.sources;
  view.transcriptBlocks = new Map();
  view.transcriptBlockOrder = [];
  for (const block of response.blocks) {
    view.transcriptBlockOrder.push(block.id);
    view.transcriptBlocks.set(block.id, block);
  }
  markViewChanged(view);
}

function applyPendingRuntimeState(view: TaskViewState): void {
  if (!view.task || !pendingReadyTaskIds.delete(view.task.id)) {
    return;
  }
  view.runtimeReady = true;
  view.composerObserved = true;
  view.status = hasActiveRun(view) ? view.status : "Ready";
}

function upsertTaskView(view: TaskViewState): void {
  const index = state.taskViews.findIndex((item) => item.task?.id === view.task?.id);
  if (index === -1) {
    state.taskViews = [...state.taskViews, view];
    return;
  }
  state.taskViews = state.taskViews.map((item, itemIndex) => (itemIndex === index ? view : item));
}

function activeTaskView(): TaskViewState | null {
  if (!state.activeTaskId) {
    return null;
  }
  return taskViewForId(state.activeTaskId);
}

function taskViewForId(taskId: string): TaskViewState | null {
  return state.taskViews.find((view) => view.task?.id === taskId) ?? null;
}

function activateTask(taskId: string): void {
  const view = taskViewForId(taskId);
  if (!view) {
    return;
  }
  state.activeTaskId = taskId;
  view.unread = false;
  terminal.clear();
  if (view.terminalBuffer) {
    terminal.write(view.terminalBuffer);
  }
  render();
}

async function closeTaskTab(taskId: string): Promise<void> {
  const view = taskViewForId(taskId);
  if (!view?.task) {
    return;
  }
  state.busy = true;
  view.status = "Closing";
  render();
  try {
    await window.duetRuntime.closeTask({ taskId });
    const index = state.taskViews.findIndex((item) => item.task?.id === taskId);
    state.taskViews = state.taskViews.filter((item) => item.task?.id !== taskId);
    if (state.activeTaskId === taskId) {
      const next = state.taskViews[Math.max(0, index - 1)] ?? state.taskViews[0] ?? null;
      state.activeTaskId = next?.task?.id ?? null;
      terminal.clear();
      if (next?.terminalBuffer) {
        terminal.write(next.terminalBuffer);
      }
    }
  } catch (error) {
    view.status = errorMessage(error);
  } finally {
    state.busy = false;
    render();
  }
}

function renderTaskTabs(): void {
  elements.taskTabs.replaceChildren();

  if (state.taskViews.length === 0) {
    const empty = document.createElement("span");
    empty.className = "task-tab-empty";
    empty.textContent = "No Task tabs";
    elements.taskTabs.append(empty);
    return;
  }

  for (const view of state.taskViews) {
    if (!view.task) {
      continue;
    }
    const task = view.task;

    const item = document.createElement("div");
    item.className = "task-tab-item";
    item.classList.toggle("active", task.id === state.activeTaskId);

    const button = document.createElement("button");
    button.className = "task-tab";
    button.type = "button";
    button.dataset.taskId = task.id;
    button.addEventListener("click", () => {
      activateTask(task.id);
    });

    const label = document.createElement("span");
    label.className = "task-tab-label";
    label.textContent = task.title;
    const meta = document.createElement("span");
    meta.className = "task-tab-meta";
    meta.textContent = `${providerLabel(task.provider)} / ${shortId(task.id)} / ${view.status}`;
    button.append(label, meta);
    if (view.unread) {
      const dot = document.createElement("span");
      dot.className = "task-tab-dot";
      dot.title = "Updated";
      button.append(dot);
    }

    const close = document.createElement("button");
    close.className = "task-tab-close";
    close.type = "button";
    close.textContent = "x";
    close.ariaLabel = `Close ${task.title}`;
    close.addEventListener("click", (event) => {
      event.stopPropagation();
      void closeTaskTab(task.id);
    });

    item.append(button, close);
    elements.taskTabs.append(item);
  }
}

function markViewChanged(view: TaskViewState): void {
  if (isActiveView(view)) {
    render();
    return;
  }
  view.unread = true;
  renderTaskTabs();
}

function isActiveView(view: TaskViewState): boolean {
  return Boolean(view.task && view.task.id === state.activeTaskId);
}

function appendTerminalBuffer(view: TaskViewState, data: string): void {
  view.terminalBuffer = `${view.terminalBuffer}${data}`.slice(-MAX_TERMINAL_BUFFER_CHARS);
  if (!isActiveView(view)) {
    view.unread = true;
  }
}

function updateTaskTitleFromRun(view: TaskViewState, title: string): void {
  const nextTitle = title.trim();
  if (!view.task || !nextTitle || !AUTO_TITLE_PLACEHOLDERS.has(view.task.title)) {
    return;
  }
  view.task = {
    ...view.task,
    title: nextTitle,
    updatedAt: new Date().toISOString(),
  };
}

async function createTask(
  provider: RuntimeProvider,
  options: { cwd?: string | null } = {},
): Promise<void> {
  const providerName = providerLabel(provider);
  state.busy = true;
  state.status = `Starting ${providerName}`;
  state.taskDraft.settingsOpen = false;
  state.taskDraft.settingsAnchor = null;
  state.taskDraft.message = {
    tone: "info",
    text: `Starting ${providerName} Task...`,
  };
  render();

  try {
    const launchSettings = taskLaunchSettings(provider);
    const response = await window.duetRuntime.createTask({
      provider,
      ...(options.cwd ? { cwd: options.cwd } : {}),
      model: launchSettings.model,
      reasoningEffort: launchSettings.reasoningEffort,
      speedMode: launchSettings.speedMode,
      approval: "on-request",
      sandbox: "read-only",
    });
    const view = createTaskView(response.task, `${providerName} PTY ${response.runtime.pid}`);
    upsertTaskView(view);
    activateTask(response.task.id);
    void hydrateTranscript(response.task.id);
  } catch (error) {
    const message = errorMessage(error);
    state.status = message;
    state.taskDraft.message = {
      tone: "error",
      text: message,
    };
  } finally {
    state.busy = false;
    render();
  }
}

async function openTask(cwd?: string | null): Promise<void> {
  state.busy = true;
  state.status = cwd ? "Opening Folder Task" : "Opening Task";
  state.taskDraft.settingsOpen = false;
  state.taskDraft.settingsAnchor = null;
  state.taskDraft.message = {
    tone: "info",
    text: cwd ? "Opening the selected Task folder..." : "Opening the latest Task...",
  };
  render();

  try {
    const response = await window.duetRuntime.openTask(cwd ? { cwd } : {});
    const existing = taskViewForId(response.task.id);
    const providerName = providerLabel(response.task.provider);
    const view = existing ?? createTaskView(response.task, `Opened ${providerName} PTY ${response.runtime.pid}`);
    view.task = response.task;
    view.status = existing ? "Task already open" : `Opened ${providerName} PTY ${response.runtime.pid}`;
    applyPendingRuntimeState(view);
    upsertTaskView(view);
    activateTask(response.task.id);
    await refreshReport(response.task.id);
    await hydrateTranscript(response.task.id);
  } catch (error) {
    const message = errorMessage(error);
    state.status = message;
    state.taskDraft.message = {
      tone: "error",
      text: message,
    };
  } finally {
    state.busy = false;
    render();
  }
}

async function submitPrompt(): Promise<void> {
  const view = activeTaskView();
  if (!view?.task) {
    return;
  }

  const text = elements.promptInput.value.trim();
  if (!text) {
    view.status = "Type a prompt before starting a Run";
    render();
    return;
  }

  state.busy = true;
  view.status = "Submitted";
  render();

  try {
    view.runtimeReady = false;
    await window.duetRuntime.submitPrompt({ taskId: view.task.id, text });
    elements.promptInput.value = "";
  } catch (error) {
    view.status = errorMessage(error);
  } finally {
    state.busy = false;
    render();
  }
}

async function decideApproval(decision: ApprovalDecision): Promise<void> {
  const view = activeTaskView();
  if (!view?.task) {
    return;
  }

  state.busy = true;
  render();
  try {
    await window.duetRuntime.decideApproval({ taskId: view.task.id, decision });
  } catch (error) {
    view.status = errorMessage(error);
  } finally {
    state.busy = false;
    render();
  }
}

async function stopRun(): Promise<void> {
  const view = activeTaskView();
  if (!view?.task) {
    return;
  }

  state.busy = true;
  view.status = "Stopping";
  render();
  try {
    await window.duetRuntime.stopRun({ taskId: view.task.id, inspectDelayMs: 6000 });
  } catch (error) {
    view.status = errorMessage(error);
  } finally {
    state.busy = false;
    render();
  }
}

async function refreshReport(taskId = state.activeTaskId): Promise<void> {
  if (!taskId) {
    return;
  }
  const view = taskViewForId(taskId);
  if (!view?.task) {
    return;
  }

  view.report = await window.duetRuntime.readReport({ taskId: view.task.id });
  view.artifacts = await window.duetRuntime.listArtifacts({ taskId: view.task.id });
  if (view.composerObserved && !view.pendingApproval && !hasActiveRun(view)) {
    view.runtimeReady = true;
  }
  if (
    view.selectedArtifactPath &&
    !view.artifacts.some((artifact) => artifact.path === view.selectedArtifactPath)
  ) {
    view.selectedArtifactPath = null;
  }
  markViewChanged(view);
}

async function resizeTerminal(): Promise<void> {
  const view = activeTaskView();
  if (!view?.task) {
    return;
  }
  fitTerminal();
  await window.duetRuntime.resizeTerminal({
    taskId: view.task.id,
    cols: terminal.cols,
    rows: terminal.rows,
  });
}

function render(): void {
  const view = activeTaskView();
  elements.taskTitle.textContent = view?.task?.title ?? "No active Task";
  elements.runtimeStatus.textContent = view?.status ?? state.status;
  elements.openPreviewWindow.disabled = !view?.task || state.busy;
  elements.openInspectorWindow.disabled = !view?.task || state.busy;
  elements.toggleTerminal.disabled = !view?.task || state.busy;
  elements.openTask.disabled = state.busy;
  elements.newTask.disabled = state.busy;
  elements.newClaudeTask.disabled = state.busy;
  renderComposerControls(view);

  renderTaskTabs();
  renderApproval();
  renderWorkflow();
  renderRuns();
  renderArtifacts();
  renderTerminalDrawer();
}

function renderComposerControls(view = activeTaskView()): void {
  const activeRun = hasActiveRun(view);
  const pendingApproval = Boolean(view?.pendingApproval);
  const promptHasText = elements.promptInput.value.trim().length > 0;
  renderComposerChip(elements.permissionChip, sessionPermissionLabel(view?.task ?? null));
  renderComposerChip(elements.modelChip, sessionModelSummaryLabel(view?.task ?? null));
  elements.sendPrompt.disabled =
    !view?.task || state.busy || !view.runtimeReady || pendingApproval || activeRun || !promptHasText;
  elements.sendPrompt.title = sendPromptTitle(view, activeRun, pendingApproval, promptHasText);
  elements.sendPrompt.textContent = "↑";
  elements.stopRun.disabled = !view?.task || state.busy || !activeRun;
  elements.promptInput.disabled = !view?.task || pendingApproval;
  elements.promptInput.placeholder = composerPlaceholder(activeRun, pendingApproval);
  elements.sendPrompt.setAttribute("aria-label", sendButtonLabel(activeRun));
}

function renderComposerChip(element: HTMLElement, label: string | null): void {
  element.classList.toggle("hidden", !label);
  element.textContent = label ?? "";
  if (label) {
    element.title = label;
  } else {
    element.removeAttribute("title");
  }
}

function sessionPermissionLabel(task: Task | null): string | null {
  if (!task) {
    return null;
  }
  if (task.provider === "claude") {
    return task.permissionMode ?? null;
  }

  const parts: string[] = [];
  if (task.approval) {
    parts.push(task.approval);
  }
  if (task.sandbox) {
    parts.push(task.sandbox);
  }
  return parts.length > 0 ? parts.join(" / ") : null;
}

function sessionModelSummaryLabel(task: Task | null): string | null {
  if (!task) {
    return null;
  }
  const parts = [
    modelValueLabel(task.provider, task.model),
    reasoningValueLabel(task.reasoningEffort),
  ].filter((part): part is string => Boolean(part));
  return parts.length > 0 ? parts.join(" ") : null;
}

function hasActiveRun(view = activeTaskView()): boolean {
  const latestRun = view?.report?.runs.at(-1);
  return isActiveRunStatus(latestRun?.status ?? "");
}

function sendPromptTitle(
  view: TaskViewState | null,
  activeRun: boolean,
  pendingApproval: boolean,
  promptHasText: boolean,
): string {
  if (!view?.task) {
    return "";
  }
  if (pendingApproval) {
    return "Resolve the pending approval before continuing.";
  }
  if (activeRun) {
    return "Wait for the active Run to finish.";
  }
  if (!view.runtimeReady) {
    return "Wait for the provider session to become ready.";
  }
  if (!promptHasText) {
    return "Type a prompt before starting a Run.";
  }
  return "";
}

function isActiveRunStatus(status: string): boolean {
  return ["active", "waiting-for-approval", "resumed-after-approval", "stopping"].includes(status);
}

function renderApproval(): void {
  const approval = activeTaskView()?.pendingApproval ?? null;
  elements.approvalBanner.classList.toggle("hidden", !approval);
  if (!approval) {
    elements.approvalBanner.removeAttribute("data-approval-kind");
    elements.approvalContext.replaceChildren();
    elements.approveSessionApproval.classList.add("hidden");
    return;
  }

  const sessionChoice =
    approval.choices?.find((choice) => choice.decision === "approve-for-session") ?? null;
  elements.approvalBanner.dataset.approvalKind = approval.kind;
  elements.approvalKindBadge.textContent = approvalKindLabel(approval.kind);
  elements.approvalTitle.textContent = approvalTitle(approval.kind);
  elements.approvalSummary.textContent = approvalSummary(approval.kind);
  elements.approveSessionApproval.classList.toggle("hidden", !sessionChoice);
  elements.approveSessionApproval.disabled = !sessionChoice;
  if (sessionChoice) {
    elements.approveSessionApproval.textContent = sessionChoice.label;
  }
  elements.approvalContext.replaceChildren(
    approvalContextItem("Source", approval.source),
    approvalContextItem("Scope", approvalScope(approval.kind)),
    approvalContextItem("Run", approval.runId ? shortId(approval.runId) : "session setup"),
    ...(approval.resurfacedAfterDecision
      ? [
          approvalContextItem(
            "Retry",
            `${approval.previousDecision ?? "decision"} did not advance native screen`,
          ),
        ]
      : []),
    approvalContextItem("Approve", "send native Enter"),
    ...(sessionChoice
      ? [approvalContextItem(sessionChoice.label, `send native ${sessionChoice.encodedAs}`)]
      : []),
    approvalContextItem("Deny", "send native Esc"),
  );
}

interface WorkflowState {
  headline: string;
  facts: string[];
}

function workflowState(): WorkflowState {
  const view = activeTaskView();
  if (!view?.task) {
    return {
      headline: "Start or open a Task",
      facts: ["No provider selected"],
    };
  }

  const providerName = providerLabel(view.task.provider);
  const runs = view.report?.runs ?? [];
  const latestRun = runs.at(-1) ?? null;
  const changedFiles = latestRun?.changedFiles.length ?? 0;
  const artifactCount = view.artifacts.length;
  const baseFacts = [
    pluralize(runs.length, "Run"),
    pluralize(changedFiles, "change"),
    pluralize(artifactCount, "artifact"),
    "Terminal available",
  ];

  if (view.pendingApproval) {
    return {
      headline: `${approvalKindLabel(view.pendingApproval.kind)} approval needed`,
      facts: baseFacts,
    };
  }

  if (latestRun && isActiveRunStatus(latestRun.status)) {
    return {
      headline: `${providerName} is working`,
      facts: baseFacts,
    };
  }

  if (latestRun?.status === "stopped") {
    return {
      headline: "Stopped. Ready to continue",
      facts: baseFacts,
    };
  }

  if (artifactCount > 0) {
    return {
      headline: "Review ready",
      facts: baseFacts,
    };
  }

  if (runs.length > 0) {
    return {
      headline: "Ready to continue",
      facts: baseFacts,
    };
  }

  if (view.runtimeReady) {
    return {
      headline: "Ready for first Run",
      facts: baseFacts,
    };
  }

  return {
    headline: `Starting ${providerName}`,
    facts: baseFacts,
  };
}

function workflowFact(value: string): HTMLElement {
  const fact = document.createElement("span");
  fact.textContent = value;
  return fact;
}

function renderWorkflow(): void {
  const workflow = workflowState();
  elements.workflowHeadline.textContent = workflow.headline;
  elements.workflowFacts.replaceChildren(...workflow.facts.map(workflowFact));
}

function renderRuns(): void {
  const runList = elements.runList;
  const nearBottom = runList.scrollHeight - runList.scrollTop - runList.clientHeight < 64;
  const previousScrollTop = runList.scrollTop;
  runList.replaceChildren();

  const view = activeTaskView();
  if (!view?.task) {
    runList.append(renderTaskEntryPanel());
    return;
  }

  const turns = buildReadingTurns(view);
  if (turns.length === 0) {
    const empty = document.createElement("article");
    empty.className = "empty-state";
    empty.textContent = "No Runs yet";
    runList.append(empty);
    return;
  }

  for (const turn of turns) {
    runList.append(renderTurn(view, turn));
  }

  runList.scrollTop = nearBottom ? runList.scrollHeight : previousScrollTop;
}

function buildReadingTurns(view: TaskViewState): ReadingTurn[] {
  const runs = view.report?.runs ?? [];
  const runById = new Map(runs.map((run) => [run.runId, run]));

  const groups = new Map<string, TranscriptBlock[]>();
  for (const id of view.transcriptBlockOrder) {
    const block = view.transcriptBlocks.get(id);
    if (!block) {
      continue;
    }
    const key = `${block.sourceId}:${block.turnKey}`;
    const group = groups.get(key);
    if (group) {
      group.push(block);
    } else {
      groups.set(key, [block]);
    }
  }

  const turns: ReadingTurn[] = [];
  const matchedRunIds = new Set<string>();
  for (const [key, blocks] of groups) {
    const runId = blocks.find((block) => block.runId)?.runId ?? null;
    if (runId) {
      matchedRunIds.add(runId);
    }
    turns.push({
      key,
      runId,
      run: runId ? (runById.get(runId) ?? null) : null,
      blocks,
      fallbackText: null,
      tsMs: Date.parse(blocks[0]?.ts ?? "") || 0,
    });
  }

  for (const run of runs) {
    if (matchedRunIds.has(run.runId)) {
      continue;
    }
    turns.push({
      key: `run:${run.runId}`,
      runId: run.runId,
      run,
      blocks: [],
      fallbackText: transcriptForRun(view, run.runId)?.text.trimEnd() || null,
      tsMs: Date.parse(run.startedAt) || 0,
    });
  }

  return turns.sort((a, b) => a.tsMs - b.tsMs);
}

function renderTurn(view: TaskViewState, turn: ReadingTurn): HTMLElement {
  const card = document.createElement("article");
  card.className = "turn-card";
  if (turn.runId) {
    card.dataset.runId = turn.runId;
    card.classList.toggle("highlighted", turn.runId === view.highlightedRunId);
  }

  card.append(renderTurnUser(turn));

  const body = document.createElement("div");
  body.className = "turn-body";
  for (const block of turn.blocks) {
    if (block.kind === "user-message") {
      continue;
    }
    body.append(renderTranscriptBlock(block));
  }
  if (turn.blocks.length === 0 && turn.fallbackText) {
    body.append(renderTurnFallback(turn.fallbackText));
  }
  if (turn.run && isActiveRunStatus(turn.run.status)) {
    body.append(renderTurnWorking());
  }
  card.append(body);

  if (turn.run) {
    card.append(renderTurnFooter(turn.run, turn.blocks.length > 0));
  }
  return card;
}

function renderTurnUser(turn: ReadingTurn): HTMLElement {
  const header = document.createElement("header");
  header.className = "turn-user";

  const role = document.createElement("span");
  role.className = "turn-role";
  role.textContent = "You";
  header.append(role);

  const userBlock = turn.blocks.find(
    (block): block is Extract<TranscriptBlock, { kind: "user-message" }> =>
      block.kind === "user-message",
  );
  const text = userBlock?.text ?? turn.run?.prompt ?? "";

  if (userBlock?.command) {
    const chip = document.createElement("span");
    chip.className = "turn-command-chip";
    chip.textContent = text || userBlock.command;
    header.append(chip);
  } else {
    const prompt = document.createElement("div");
    prompt.className = "turn-user-text";
    prompt.textContent = text || "(empty prompt)";
    header.append(prompt);
  }
  return header;
}

function renderTranscriptBlock(block: TranscriptBlock): HTMLElement {
  if (block.kind === "assistant-text") {
    return markdownBody(block.markdown);
  }
  if (block.kind === "tool-call") {
    return renderToolCallBlock(block);
  }
  if (block.kind === "thinking") {
    const details = document.createElement("details");
    details.className = "turn-thinking";
    const summary = document.createElement("summary");
    summary.textContent = "Thinking";
    const pre = document.createElement("pre");
    pre.className = "turn-thinking-text";
    pre.textContent = block.text;
    details.append(summary, pre);
    return details;
  }
  const note = document.createElement("div");
  note.className = "turn-system-note";
  note.textContent = block.kind === "system-note" ? block.text : "";
  return note;
}

function renderToolCallBlock(block: ToolCallBlock): HTMLElement {
  const details = document.createElement("details");
  details.className = `turn-tool ${block.status}`;

  const summary = document.createElement("summary");
  const status = document.createElement("span");
  status.className = "turn-tool-status";
  status.textContent = block.status === "running" ? "…" : block.status === "ok" ? "✓" : "✕";
  const name = document.createElement("strong");
  name.className = "turn-tool-name";
  name.textContent = block.toolName;
  summary.append(status, name);
  if (block.summary) {
    const hint = document.createElement("span");
    hint.className = "turn-tool-hint";
    hint.textContent = block.summary;
    summary.append(hint);
  }
  if (block.durationMs !== null) {
    const duration = document.createElement("span");
    duration.className = "turn-tool-duration";
    duration.textContent = formatElapsed(block.durationMs);
    summary.append(duration);
  }
  details.append(summary);

  const body = document.createElement("div");
  body.className = "turn-tool-body";
  body.append(
    toolDetailSection("Input", block.inputPreview, block.inputTruncated),
  );
  if (block.resultPreview !== null) {
    body.append(toolDetailSection("Result", block.resultPreview, block.resultTruncated));
  }
  details.append(body);
  return details;
}

function toolDetailSection(label: string, text: string, truncated: boolean): HTMLElement {
  const section = document.createElement("div");
  section.className = "turn-tool-section";
  section.append(runSectionLabel(truncated ? `${label} (truncated)` : label));
  const pre = document.createElement("pre");
  pre.className = "turn-tool-text";
  pre.textContent = text;
  section.append(pre);
  return section;
}

function renderTurnFallback(text: string): HTMLElement {
  const wrap = document.createElement("div");
  wrap.className = "turn-fallback";
  wrap.append(runSectionLabel("Terminal approximation"));
  const pre = document.createElement("pre");
  pre.className = "turn-fallback-text";
  pre.textContent = text;
  wrap.append(pre);
  return wrap;
}

function renderTurnWorking(): HTMLElement {
  const working = document.createElement("div");
  working.className = "turn-working";
  working.textContent = `${activeProviderLabel()} is working…`;
  return working;
}

function renderTurnFooter(run: RuntimeRunReport, hasSemanticBlocks: boolean): HTMLElement {
  const footer = document.createElement("footer");
  footer.className = `turn-footer ${runTone(run)}`;

  const outcome = document.createElement("span");
  outcome.className = "turn-outcome";
  outcome.textContent = runOutcome(run);
  footer.append(outcome);

  const facts = document.createElement("span");
  facts.className = "turn-facts";
  const factItems = [
    formatElapsed(run.elapsedMs),
    run.changedFiles.length > 0 ? pluralize(run.changedFiles.length, "change") : null,
    run.approvalEvents.length > 0 ? pluralize(run.approvalEvents.length, "approval") : null,
    completionLabel(run),
  ].filter((item): item is string => Boolean(item));
  facts.textContent = factItems.join(" · ");
  footer.append(facts);

  if (run.artifactCandidates.length > 0) {
    const artifacts = document.createElement("span");
    artifacts.className = "turn-artifacts";
    for (const artifact of run.artifactCandidates) {
      const button = document.createElement("button");
      button.className = "artifact-link compact";
      button.type = "button";
      button.textContent = artifact.path;
      button.addEventListener("click", () => {
        void openArtifact(artifact.path);
      });
      artifacts.append(button);
    }
    footer.append(artifacts);
  }

  const provenance = document.createElement("span");
  provenance.className = "turn-provenance";
  provenance.textContent = hasSemanticBlocks ? "provider transcript" : "terminal approximation";
  footer.append(provenance);

  return footer;
}

const markdownSanitizerConfig = {
  USE_PROFILES: { html: true },
  FORBID_TAGS: ["style", "form", "input", "button"],
};

const markdownHtmlCache = new Map<string, string>();

function markdownBody(markdown: string): HTMLElement {
  const body = document.createElement("div");
  body.className = "md-body";
  let html = markdownHtmlCache.get(markdown);
  if (html === undefined) {
    html = DOMPurify.sanitize(marked.parse(markdown, { async: false }), markdownSanitizerConfig);
    markdownHtmlCache.set(markdown, html);
  }
  body.innerHTML = html;
  return body;
}

function renderTaskEntryPanel(): HTMLElement {
  const panel = document.createElement("article");
  panel.className = "task-entry-panel";

  const copy = document.createElement("div");
  copy.className = "task-entry-copy";
  const eyebrow = document.createElement("p");
  eyebrow.className = "eyebrow";
  eyebrow.textContent = "Task Entry";
  const title = document.createElement("h2");
  title.textContent = "Start a Task";
  const body = document.createElement("p");
  body.className = "task-entry-body";
  body.textContent = "Provider and launch settings are locked when the Task is created.";
  copy.append(eyebrow, title, body);

  const controls = document.createElement("div");
  controls.className = "task-entry-controls";
  controls.append(renderProviderSegment(), renderFolderPicker(), renderLaunchSettingsControl());

  const actions = document.createElement("div");
  actions.className = "task-entry-actions";
  const startTask = document.createElement("button");
  startTask.id = "entry-new-task";
  startTask.className = "primary";
  startTask.type = "button";
  startTask.disabled = state.busy;
  startTask.textContent = `Start ${providerLabel(state.taskDraft.provider)} Task`;
  startTask.addEventListener("click", () => {
    void createTask(state.taskDraft.provider, { cwd: state.taskDraft.cwd });
  });
  const openTaskButton = document.createElement("button");
  openTaskButton.id = "entry-open-task";
  openTaskButton.className = "secondary";
  openTaskButton.type = "button";
  openTaskButton.disabled = state.busy;
  openTaskButton.textContent = state.taskDraft.cwd ? "Open Folder Task" : "Open Latest Task";
  openTaskButton.addEventListener("click", () => {
    void openTask(state.taskDraft.cwd);
  });
  actions.append(startTask, openTaskButton);

  const message = renderTaskEntryMessage();
  const facts = document.createElement("div");
  facts.className = "task-entry-facts";
  facts.append(
    taskEntryFact("Provider", providerLabel(state.taskDraft.provider)),
    taskEntryFact("Model", modelSummaryLabel(state.taskDraft.provider)),
    taskEntryFact("Folder", folderSummaryLabel()),
  );

  panel.append(copy, controls, actions);
  if (message) {
    panel.append(message);
  }
  panel.append(facts);
  return panel;
}

function renderProviderSegment(): HTMLElement {
  const segment = document.createElement("div");
  segment.className = "task-provider-segment";
  segment.setAttribute("role", "group");
  segment.ariaLabel = "Task provider";

  for (const provider of ["codex", "claude"] as const) {
    const button = document.createElement("button");
    button.id = `entry-provider-${provider}`;
    button.className = "secondary";
    button.classList.toggle("active", provider === state.taskDraft.provider);
    button.type = "button";
    button.disabled = state.busy;
    button.ariaPressed = String(provider === state.taskDraft.provider);
    button.textContent = providerLabel(provider);
    button.addEventListener("click", () => {
      state.taskDraft.provider = provider;
      state.taskDraft.message = null;
      render();
    });
    segment.append(button);
  }

  return segment;
}

function renderFolderPicker(): HTMLElement {
  const row = document.createElement("div");
  row.className = "task-folder-row";

  const choose = document.createElement("button");
  choose.id = "entry-choose-folder";
  choose.className = "secondary";
  choose.type = "button";
  choose.disabled = state.busy;
  choose.textContent = state.taskDraft.cwd ? folderName(state.taskDraft.cwd) : "Choose Folder";
  if (state.taskDraft.cwd) {
    choose.title = state.taskDraft.cwd;
  }
  choose.addEventListener("click", () => {
    void pickTaskFolder();
  });
  row.append(choose);

  if (state.taskDraft.cwd) {
    const clear = document.createElement("button");
    clear.id = "entry-clear-folder";
    clear.className = "secondary";
    clear.type = "button";
    clear.disabled = state.busy;
    clear.textContent = "Default Workspace";
    clear.addEventListener("click", () => {
      state.taskDraft.cwd = null;
      state.taskDraft.message = {
        tone: "info",
        text: "Using the default Duet workspace for new Tasks.",
      };
      render();
    });
    row.append(clear);
  }

  return row;
}

function renderLaunchSettingsControl(): HTMLElement {
  const wrap = document.createElement("div");
  wrap.className = "task-settings-wrap";

  const button = document.createElement("button");
  button.id = "entry-launch-settings";
  button.className = "secondary task-settings-trigger";
  button.type = "button";
  button.disabled = state.busy;
  button.ariaExpanded = String(state.taskDraft.settingsOpen);
  button.textContent = `${launchSettingsSummary(state.taskDraft.provider)} v`;
  button.addEventListener("click", (event) => {
    event.stopPropagation();
    const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
    const willOpen = !state.taskDraft.settingsOpen;
    state.taskDraft.settingsOpen = willOpen;
    state.taskDraft.settingsAnchor = willOpen
      ? {
          left: rect.left,
          top: rect.bottom + 8,
          width: rect.width,
        }
      : null;
    render();
  });
  wrap.append(button);

  if (state.taskDraft.settingsOpen) {
    wrap.append(renderLaunchSettingsPopover(state.taskDraft.provider));
  }

  return wrap;
}

function renderLaunchSettingsPopover(provider: RuntimeProvider): HTMLElement {
  const popover = document.createElement("div");
  popover.className = "task-settings-popover";
  popover.setAttribute("role", "menu");
  positionLaunchSettingsPopover(popover);
  popover.addEventListener("click", (event) => {
    event.stopPropagation();
  });

  popover.append(
    renderSettingSection("Reasoning", REASONING_OPTIONS[provider], state.taskDraft.reasoningEffort[provider], (value) => {
      state.taskDraft.reasoningEffort[provider] = value as ReasoningEffort | null;
      render();
    }),
    renderSettingSection("Model", MODEL_OPTIONS[provider], state.taskDraft.model[provider], (value) => {
      state.taskDraft.model[provider] = value;
      render();
    }),
  );

  if (provider === "codex") {
    popover.append(
      renderSettingSection(
        "Speed",
        [
          { label: "Default", value: "default" },
          { label: "Fast", value: "fast" },
        ],
        state.taskDraft.speedMode.codex,
        (value) => {
          state.taskDraft.speedMode.codex = value as LaunchSpeedMode;
          render();
        },
      ),
    );
  }

  return popover;
}

function positionLaunchSettingsPopover(popover: HTMLElement): void {
  const anchor = state.taskDraft.settingsAnchor;
  const viewportPadding = 14;
  const width = Math.min(360, window.innerWidth - viewportPadding * 2);
  const top = anchor?.top ?? viewportPadding;
  const canOpenLeft = Boolean(anchor && anchor.left - width - 12 >= viewportPadding);
  const left =
    anchor && canOpenLeft
      ? anchor.left - width - 12
      : anchor
        ? Math.min(
            window.innerWidth - width - viewportPadding,
            Math.max(viewportPadding, anchor.left + anchor.width - width),
          )
        : viewportPadding;

  popover.style.left = `${left}px`;
  popover.style.top = `${top}px`;
  popover.style.width = `${width}px`;
  popover.style.maxHeight = `${Math.max(220, window.innerHeight - top - viewportPadding)}px`;
}

function renderSettingSection<T extends string | null>(
  label: string,
  options: Array<{ label: string; value: T }>,
  selected: T,
  onSelect: (value: T) => void,
): HTMLElement {
  const section = document.createElement("div");
  section.className = "task-setting-section";

  const title = document.createElement("p");
  title.className = "task-setting-heading";
  title.textContent = label;
  section.append(title);

  for (const option of options) {
    const button = document.createElement("button");
    button.className = "task-setting-option";
    button.classList.toggle("selected", option.value === selected);
    button.type = "button";
    button.setAttribute("role", "menuitemradio");
    button.ariaChecked = String(option.value === selected);
    button.textContent = option.label;
    if (option.value === selected) {
      const selectedLabel = document.createElement("span");
      selectedLabel.textContent = "selected";
      button.append(selectedLabel);
    }
    button.addEventListener("click", () => {
      onSelect(option.value);
    });
    section.append(button);
  }

  return section;
}

function taskEntryFact(label: string, value: string): HTMLElement {
  const fact = document.createElement("div");
  fact.className = "task-entry-fact";
  const key = document.createElement("span");
  key.textContent = label;
  const val = document.createElement("strong");
  val.textContent = value;
  fact.append(key, val);
  return fact;
}

async function pickTaskFolder(): Promise<void> {
  state.busy = true;
  state.status = "Choosing Task Folder";
  state.taskDraft.settingsOpen = false;
  state.taskDraft.settingsAnchor = null;
  state.taskDraft.message = {
    tone: "info",
    text: "Choose the folder where this Task should run.",
  };
  render();

  try {
    const response = await window.duetRuntime.pickFolder();
    if (response.path) {
      state.taskDraft.cwd = response.path;
      state.status = `Selected ${folderName(response.path)}`;
      state.taskDraft.message = {
        tone: "info",
        text: `Selected ${folderName(response.path)}.`,
      };
    }
  } catch (error) {
    const message = errorMessage(error);
    state.status = message;
    state.taskDraft.message = {
      tone: "error",
      text: message,
    };
  } finally {
    state.busy = false;
    render();
  }
}

function renderTaskEntryMessage(): HTMLElement | null {
  if (!state.taskDraft.message) {
    return null;
  }

  const message = document.createElement("div");
  message.className = `task-entry-message ${state.taskDraft.message.tone}`;
  message.textContent = state.taskDraft.message.text;
  return message;
}

function taskLaunchSettings(provider: RuntimeProvider): {
  model: string | null;
  reasoningEffort: ReasoningEffort | null;
  speedMode: LaunchSpeedMode | null;
} {
  return {
    model: state.taskDraft.model[provider],
    reasoningEffort: state.taskDraft.reasoningEffort[provider],
    speedMode: state.taskDraft.speedMode[provider],
  };
}

function launchSettingsSummary(provider: RuntimeProvider): string {
  const parts = [modelSummaryLabel(provider), reasoningSummaryLabel(provider)];
  if (provider === "codex" && state.taskDraft.speedMode.codex === "fast") {
    parts.push("Fast");
  }
  return parts.filter(Boolean).join(" ");
}

function modelSummaryLabel(provider: RuntimeProvider): string {
  return modelValueLabel(provider, state.taskDraft.model[provider]) ?? "Default";
}

function reasoningSummaryLabel(provider: RuntimeProvider): string {
  return reasoningValueLabel(state.taskDraft.reasoningEffort[provider]) ?? "Default";
}

function modelValueLabel(provider: RuntimeProvider, value: string | null): string | null {
  if (!value) {
    return null;
  }
  if (provider === "codex" && value === "gpt-5.5") {
    return "5.5";
  }
  return MODEL_OPTIONS[provider].find((option) => option.value === value)?.label ?? value;
}

function reasoningValueLabel(value: ReasoningEffort | null): string | null {
  if (!value) {
    return null;
  }
  return (
    [...REASONING_OPTIONS.codex, ...REASONING_OPTIONS.claude].find(
      (option) => option.value === value,
    )?.label ?? value
  );
}

function folderSummaryLabel(): string {
  return state.taskDraft.cwd ? folderName(state.taskDraft.cwd) : "Duet workspace";
}

function folderName(folderPath: string): string {
  return folderPath.split(/[\\/]/).filter(Boolean).at(-1) ?? folderPath;
}

function renderArtifacts(): void {
  elements.artifactList.replaceChildren();
  const view = activeTaskView();
  const artifacts = view?.artifacts ?? [];
  elements.artifactStrip.classList.toggle("hidden", artifacts.length === 0);
  elements.openSelectedPreview.disabled = !view?.task || artifacts.length === 0;

  if (artifacts.length === 0) {
    return;
  }

  for (const artifact of artifacts) {
    const reviewState = artifactPreviewTab(artifact.taskId, artifact.path);
    const item = document.createElement("button");
    item.className = "artifact-item";
    item.type = "button";
    item.classList.toggle("selected", artifact.path === view?.selectedArtifactPath);
    item.classList.toggle("reviewed", Boolean(reviewState?.reviewed && !reviewState.dirty));
    item.classList.toggle("dirty", Boolean(reviewState?.dirty));
    const title = document.createElement("span");
    title.className = "artifact-item-title";
    title.textContent = artifact.path;
    const meta = document.createElement("span");
    meta.className = "artifact-item-meta";
    meta.textContent = `${artifactKindLabel(artifact.kind)} / ${artifact.changeKind} / ${artifactReviewLabel(
      reviewState,
    )}`;
    item.append(title, meta);
    item.addEventListener("click", () => {
      void openArtifact(artifact.path);
    });
    elements.artifactList.append(item);
  }
}

function artifactPreviewTab(taskId: string, relativePath: string): PreviewWindowTab | null {
  return state.previewTabs.find((tab) => tab.taskId === taskId && tab.path === relativePath) ?? null;
}

function artifactReviewLabel(tab: PreviewWindowTab | null): string {
  if (tab?.dirty) {
    return "Updated";
  }
  if (tab?.reviewed) {
    return "Reviewed";
  }
  return "Needs review";
}

function appendLiveTranscript(view: TaskViewState, data: string): void {
  if (!view.liveTranscriptRunId) {
    return;
  }

  const transcript = ensureRunTranscript(view, view.liveTranscriptRunId);
  transcript.receivedChars += data.length;
  const nextRawText = `${transcript.rawText}${data}`;
  transcript.truncated = transcript.truncated || nextRawText.length > MAX_TRANSCRIPT_RAW_CHARS;
  transcript.rawText = nextRawText.slice(-MAX_TRANSCRIPT_RAW_CHARS);

  const text = cleanTerminalTranscript(transcript.rawText, view.task?.provider);
  transcript.truncated = transcript.truncated || text.length > MAX_TRANSCRIPT_CHARS;
  transcript.text = text.slice(-MAX_TRANSCRIPT_CHARS);

  if (!transcript.text.trim()) {
    return;
  }
  scheduleTranscriptRender();
}

function ensureRunTranscript(view: TaskViewState, runId: string): RunTranscript {
  let transcript = view.runTranscripts.find((item) => item.runId === runId);
  if (!transcript) {
    transcript = {
      runId,
      rawText: "",
      text: "",
      truncated: false,
      receivedChars: 0,
    };
    view.runTranscripts = [...view.runTranscripts, transcript];
  }
  return transcript;
}

function transcriptForRun(view: TaskViewState, runId: string): RunTranscript | null {
  return view.runTranscripts.find((item) => item.runId === runId) ?? null;
}

function scheduleTranscriptRender(): void {
  if (transcriptRenderTimer !== null) {
    return;
  }
  transcriptRenderTimer = window.setTimeout(() => {
    transcriptRenderTimer = null;
    render();
  }, 160);
}

async function openArtifact(relativePath: string): Promise<void> {
  const view = activeTaskView();
  if (!view?.task) {
    return;
  }

  view.selectedArtifactPath = relativePath;
  render();
  await window.duetRuntime.openPreview({
    taskId: view.task.id,
    relativePath,
  });
}

async function openFloatingPreview(): Promise<void> {
  const view = activeTaskView();
  if (!view?.task) {
    return;
  }
  const relativePath = view.selectedArtifactPath ?? view.artifacts[0]?.path;

  await window.duetRuntime.openPreview({
    taskId: view.task.id,
    ...(relativePath ? { relativePath } : {}),
  });
}

async function openFloatingInspector(): Promise<void> {
  const view = activeTaskView();
  if (!view?.task) {
    return;
  }

  await window.duetRuntime.openInspector({
    taskId: view.task.id,
  });
}

function setTerminalOpen(open: boolean): void {
  state.terminalOpen = open;
  render();
  if (open) {
    queueMicrotask(() => {
      fitTerminal();
      void resizeTerminal();
    });
  }
}

function renderTerminalDrawer(): void {
  elements.terminalDrawer.classList.toggle("hidden", !state.terminalOpen);
  elements.toggleTerminal.classList.toggle("active", state.terminalOpen);
}

function focusArtifactFromPreview(request: FocusArtifactInMainRequest): void {
  const view = taskViewForId(request.taskId);
  if (!view?.task) {
    return;
  }

  state.activeTaskId = request.taskId;
  view.unread = false;
  if (request.relativePath) {
    view.selectedArtifactPath = request.relativePath;
  }
  if (request.runId) {
    view.highlightedRunId = request.runId;
  }
  terminal.clear();
  if (view.terminalBuffer) {
    terminal.write(view.terminalBuffer);
  }
  render();

  queueMicrotask(() => {
    if (request.mode === "run" && request.runId) {
      scrollRunIntoView(request.runId);
      return;
    }
    if (!request.relativePath) {
      return;
    }
    const relativePath = request.relativePath;
    const artifact = Array.from(elements.artifactList.querySelectorAll<HTMLElement>(".artifact-item")).find(
      (item) => item.textContent?.includes(relativePath),
    );
    artifact?.scrollIntoView({ block: "nearest", inline: "center" });
  });
}

function focusRun(runId: string): void {
  const view = activeTaskView();
  if (view) {
    view.highlightedRunId = runId;
  }
  render();
  queueMicrotask(() => {
    scrollRunIntoView(runId);
  });
}

function scrollRunIntoView(runId: string): void {
  const runCard = Array.from(elements.runList.querySelectorAll<HTMLElement>(".turn-card")).find(
    (item) => item.dataset.runId === runId,
  );
  runCard?.scrollIntoView({ block: "center" });
}

function focusComposer(): void {
  elements.promptInput.focus();
}

function composerPlaceholder(activeRun: boolean, pendingApproval: boolean): string {
  const view = activeTaskView();
  if (!view?.task) {
    return "Start or open a Task";
  }
  const providerName = providerLabel(view.task.provider);
  if (pendingApproval) {
    return "Approval is waiting";
  }
  if (activeRun) {
    return `${providerName} is working`;
  }
  if ((view.report?.runs.length ?? 0) === 0) {
    return "Describe the first Run";
  }
  return "Continue, correct, or redirect this Task";
}

function sendButtonLabel(activeRun: boolean): string {
  if (activeRun) {
    return "Working";
  }
  const view = activeTaskView();
  if (!view?.task) {
    return "Send";
  }
  if ((view.report?.runs.length ?? 0) === 0) {
    return "Start Run";
  }
  return "Continue";
}

function runSectionLabel(value: string): HTMLElement {
  const label = document.createElement("div");
  label.className = "run-rhythm-label";
  label.textContent = value;
  return label;
}

function approvalContextItem(label: string, value: string): HTMLElement {
  const item = document.createElement("span");
  item.textContent = `${label}: ${value}`;
  return item;
}

function completionLabel(run: RuntimeRunReport): string {
  if (!run.completionSource) {
    return "pending";
  }
  return `${run.completionSource} / ${run.completionConfidence ?? "low"}`;
}

function runOutcome(run: RuntimeRunReport): string {
  const providerName = activeProviderLabel();
  if (run.status === "waiting-for-approval") {
    return `Waiting for ${approvalKindLabel(run.approvalKind)} approval`;
  }
  if (run.status === "resumed-after-approval") {
    return `Resumed after ${approvalKindLabel(run.approvalKind)} approval`;
  }
  if (run.status === "stopped") {
    return run.stopEvents.some((event) => event.action === "stopped" && event.slashStopSent)
      ? "Stopped by Esc + /stop"
      : "Stopped by Esc";
  }
  if (run.status === "approval-denied") {
    return `${approvalKindLabel(run.approvalKind)} approval denied`;
  }
  if (run.status === "completed" && run.completionSource === "terminal-idle-heuristic") {
    return "Completed by terminal idle heuristic";
  }
  if (run.status === "completed") {
    return "Completed";
  }
  if (run.status === "pty-exited") {
    return "PTY exited";
  }
  if (run.status === "failed") {
    return "Failed";
  }
  return `${providerName} is working`;
}

function runTone(run: RuntimeRunReport): string {
  if (run.status === "stopped" || run.status === "approval-denied" || run.status === "failed") {
    return "attention";
  }
  if (run.status === "completed") {
    return "complete";
  }
  if (run.status === "waiting-for-approval") {
    return "waiting";
  }
  return "active";
}

function approvalTitle(kind: RuntimeRunReport["approvalKind"] | null | undefined): string {
  if (kind === "workspace-trust") {
    return "Workspace trust requested";
  }
  if (kind === "file-edit") {
    return "File edit approval requested";
  }
  if (kind === "file-read") {
    return "File read approval requested";
  }
  if (kind === "command") {
    return "Command approval requested";
  }
  return "Native approval requested";
}

function approvalSummary(kind: RuntimeRunReport["approvalKind"] | null | undefined): string {
  const providerName = activeProviderLabel();
  if (kind === "workspace-trust") {
    return `${providerName} is asking whether this Task workspace should be trusted before it continues.`;
  }
  if (kind === "file-edit") {
    return `${providerName} wants to write files in this Task workspace. Review the Run context before approving.`;
  }
  if (kind === "file-read") {
    return `${providerName} wants to read a file path through the native CLI session. Approve only when that access matches the Task.`;
  }
  if (kind === "command") {
    return `${providerName} wants to run a command through the native CLI session. Approve only when the command matches the Task.`;
  }
  return `${providerName} is waiting on a native approval screen in the PTY session.`;
}

function approvalScope(kind: RuntimeRunReport["approvalKind"] | null | undefined): string {
  if (kind === "workspace-trust") {
    return "Task workspace trust";
  }
  if (kind === "file-edit") {
    return "workspace file write";
  }
  if (kind === "file-read") {
    return "native file read";
  }
  if (kind === "command") {
    return "terminal command execution";
  }
  const providerName = activeProviderLabel();
  return `native ${providerName} session`;
}

function approvalKindLabel(kind: RuntimeRunReport["approvalKind"] | null | undefined): string {
  if (kind === "workspace-trust") {
    return "Workspace trust";
  }
  if (kind === "file-edit") {
    return "File edit";
  }
  if (kind === "file-read") {
    return "File read";
  }
  if (kind === "command") {
    return "Command";
  }
  return "Native";
}

function pluralize(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

function formatElapsed(value: number | null): string {
  if (value === null) {
    return "running";
  }
  if (value < 1000) {
    return `${value} ms`;
  }
  return `${(value / 1000).toFixed(1)} s`;
}

function artifactKindLabel(kind: ArtifactCandidate["kind"]): string {
  if (kind === "html") {
    return "HTML";
  }
  if (kind === "markdown") {
    return "Markdown";
  }
  if (kind === "pdf") {
    return "PDF";
  }
  if (kind === "image") {
    return "Image";
  }
  if (kind === "spreadsheet") {
    return "Spreadsheet";
  }
  if (kind === "document") {
    return "Document";
  }
  if (kind === "presentation") {
    return "Presentation";
  }
  if (kind === "text") {
    return "Text";
  }
  return "Unknown";
}

function providerLabel(provider: RuntimeProvider): string {
  if (provider === "claude") {
    return "Claude";
  }
  return "Codex";
}

function activeProviderLabel(): string {
  const provider = activeTaskView()?.task?.provider;
  return provider ? providerLabel(provider) : "Provider";
}

function shortId(value: string): string {
  return value.length > 18 ? `${value.slice(0, 18)}...` : value;
}

function fitTerminal(): void {
  try {
    fitAddon.fit();
  } catch {
    // The terminal can be measured only after layout is ready.
  }
}

function getElement<T extends HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (!element) {
    throw new Error(`Missing renderer element: ${id}`);
  }
  return element as T;
}

function errorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/^Error invoking remote method '[^']+':\s*(?:Error:\s*)?/, "");
}
