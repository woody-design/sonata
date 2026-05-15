import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import "./styles.css";
import type { ArtifactCandidate, Task } from "../shared/types";
import type { ArtifactPreviewResponse } from "../shared/types/ipc";
import type { ApprovalDetectedEvent } from "../shared/types/events";
import type { RuntimeReportV1, RuntimeRunReport } from "../shared/schemas";

type SideView = "preview" | "inspector" | "terminal";

interface RunTranscript {
  runId: string;
  text: string;
  truncated: boolean;
}

interface TaskViewState {
  task: Task | null;
  report: RuntimeReportV1 | null;
  artifacts: ArtifactCandidate[];
  preview: ArtifactPreviewResponse | null;
  previewError: string | null;
  selectedArtifactPath: string | null;
  pendingApproval: ApprovalDetectedEvent["payload"] | null;
  highlightedRunId: string | null;
  liveTranscriptRunId: string | null;
  runTranscripts: RunTranscript[];
  terminalBuffer: string;
  runtimeReady: boolean;
  composerObserved: boolean;
  status: string;
  unread: boolean;
}

interface RendererState {
  taskViews: TaskViewState[];
  activeTaskId: string | null;
  sideView: SideView;
  busy: boolean;
  status: string;
}

const state: RendererState = {
  taskViews: [],
  activeTaskId: null,
  sideView: "preview",
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
        <button id="open-task" class="secondary" type="button">Open Task</button>
        <button id="new-task" class="secondary" type="button">New Task</button>
      </div>
    </header>

    <nav id="task-tabs" class="task-tabs" aria-label="Task tabs"></nav>

    <section class="workspace">
      <section class="run-column" aria-label="Run reading surface">
        <div id="approval-banner" class="approval-banner hidden">
          <div>
            <p class="eyebrow">Approval</p>
            <strong id="approval-title">Native approval requested</strong>
          </div>
          <div class="approval-actions">
            <button id="deny-approval" class="secondary" type="button">Deny</button>
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

        <div id="run-list" class="run-list"></div>

        <form id="composer" class="composer">
          <textarea id="prompt-input" rows="4" placeholder="Send a prompt to Codex"></textarea>
          <div class="composer-actions">
            <button id="stop-run" class="secondary" type="button" disabled>Stop</button>
            <button id="send-prompt" class="primary" type="submit" disabled>Send</button>
          </div>
        </form>
      </section>

      <aside class="side-column" aria-label="Runtime surfaces">
        <nav class="surface-tabs" aria-label="Surface tabs">
          <button id="preview-tab" class="surface-tab" type="button">Preview</button>
          <button id="inspector-tab" class="surface-tab" type="button">Inspector</button>
          <button id="terminal-tab" class="surface-tab" type="button">Terminal</button>
        </nav>

        <section id="preview-panel" class="panel preview-panel">
          <div class="panel-header split">
            <p class="eyebrow">Preview</p>
          </div>
          <div class="preview-layout">
            <div id="artifact-list" class="artifact-list"></div>
            <div id="preview-content" class="preview-content"></div>
          </div>
        </section>

        <section id="inspector-panel" class="panel inspector-panel hidden">
          <div class="panel-header">
            <p class="eyebrow">Inspector</p>
          </div>
          <div id="inspector-content" class="inspector-content"></div>
        </section>

        <section id="terminal-panel" class="panel terminal-panel hidden">
          <div class="panel-header">
            <p class="eyebrow">Terminal</p>
          </div>
          <div id="terminal"></div>
        </section>
      </aside>
    </section>
  </section>
`;

const elements = {
  taskTitle: getElement<HTMLHeadingElement>("task-title"),
  runtimeStatus: getElement<HTMLSpanElement>("runtime-status"),
  openPreviewWindow: getElement<HTMLButtonElement>("open-preview-window"),
  openInspectorWindow: getElement<HTMLButtonElement>("open-inspector-window"),
  openTask: getElement<HTMLButtonElement>("open-task"),
  newTask: getElement<HTMLButtonElement>("new-task"),
  approvalBanner: getElement<HTMLDivElement>("approval-banner"),
  approvalTitle: getElement<HTMLElement>("approval-title"),
  denyApproval: getElement<HTMLButtonElement>("deny-approval"),
  approveApproval: getElement<HTMLButtonElement>("approve-approval"),
  workflowHeadline: getElement<HTMLElement>("workflow-headline"),
  workflowFacts: getElement<HTMLDivElement>("workflow-facts"),
  taskTabs: getElement<HTMLElement>("task-tabs"),
  runList: getElement<HTMLDivElement>("run-list"),
  artifactList: getElement<HTMLDivElement>("artifact-list"),
  composer: getElement<HTMLFormElement>("composer"),
  promptInput: getElement<HTMLTextAreaElement>("prompt-input"),
  stopRun: getElement<HTMLButtonElement>("stop-run"),
  sendPrompt: getElement<HTMLButtonElement>("send-prompt"),
  previewTab: getElement<HTMLButtonElement>("preview-tab"),
  inspectorTab: getElement<HTMLButtonElement>("inspector-tab"),
  terminalTab: getElement<HTMLButtonElement>("terminal-tab"),
  previewPanel: getElement<HTMLElement>("preview-panel"),
  inspectorPanel: getElement<HTMLElement>("inspector-panel"),
  terminalPanel: getElement<HTMLElement>("terminal-panel"),
  previewContent: getElement<HTMLDivElement>("preview-content"),
  inspectorContent: getElement<HTMLDivElement>("inspector-content"),
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

let transcriptRenderTimer: number | null = null;
const MAX_TRANSCRIPT_CHARS = 40_000;
const MAX_TERMINAL_BUFFER_CHARS = 80_000;
const ANSI_RE = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07]*(?:\x07|\x1b\\)|\x1b[@-_]/g;
const CONTROL_RE = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g;

elements.newTask.addEventListener("click", () => {
  void createTask();
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

elements.composer.addEventListener("submit", (event) => {
  event.preventDefault();
  void submitPrompt();
});

elements.stopRun.addEventListener("click", () => {
  void stopRun();
});

elements.approveApproval.addEventListener("click", () => {
  void decideApproval("approve");
});

elements.denyApproval.addEventListener("click", () => {
  void decideApproval("deny");
});

elements.previewTab.addEventListener("click", () => {
  setSideView("preview");
});

elements.inspectorTab.addEventListener("click", () => {
  setSideView("inspector");
});

elements.terminalTab.addEventListener("click", () => {
  setSideView("terminal");
});

window.addEventListener("resize", () => {
  fitTerminal();
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
    return;
  }

  if (event.type === "run:started") {
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
    view.status = event.payload.decision === "approve" ? "Approval sent" : "Approval denied";
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

  if (event.type === "report:updated") {
    void refreshReport(event.payload.taskId);
  }
});

render();

function createTaskView(task: Task, status: string): TaskViewState {
  return {
    task,
    report: null,
    artifacts: [],
    preview: null,
    previewError: null,
    selectedArtifactPath: null,
    pendingApproval: null,
    highlightedRunId: null,
    liveTranscriptRunId: null,
    runTranscripts: [],
    terminalBuffer: "",
    runtimeReady: false,
    composerObserved: false,
    status,
    unread: false,
  };
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
    meta.textContent = `${shortId(task.id)} / ${view.status}`;
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

async function createTask(): Promise<void> {
  state.busy = true;
  state.status = "Starting Codex";
  render();

  try {
    const response = await window.duetRuntime.createTask({
      provider: "codex",
      title: "Walking Skeleton Task",
      approval: "on-request",
      sandbox: "read-only",
    });
    const view = createTaskView(response.task, `Codex PTY ${response.runtime.pid}`);
    upsertTaskView(view);
    activateTask(response.task.id);
  } catch (error) {
    state.status = errorMessage(error);
  } finally {
    state.busy = false;
    render();
  }
}

async function openTask(): Promise<void> {
  state.busy = true;
  state.status = "Opening Task";
  render();

  try {
    const response = await window.duetRuntime.openTask({});
    const existing = taskViewForId(response.task.id);
    const view = existing ?? createTaskView(response.task, `Opened Codex PTY ${response.runtime.pid}`);
    view.task = response.task;
    view.status = existing ? "Task already open" : `Opened Codex PTY ${response.runtime.pid}`;
    upsertTaskView(view);
    activateTask(response.task.id);
    await refreshReport(response.task.id);
  } catch (error) {
    state.status = errorMessage(error);
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

async function decideApproval(decision: "approve" | "deny"): Promise<void> {
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
    view.preview = null;
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
  elements.openTask.disabled = state.busy;
  elements.newTask.disabled = state.busy;
  const activeRun = hasActiveRun(view);
  const pendingApproval = Boolean(view?.pendingApproval);
  elements.sendPrompt.disabled = !view?.task || state.busy || !view.runtimeReady || pendingApproval || activeRun;
  elements.stopRun.disabled = !view?.task || state.busy || !activeRun;
  elements.promptInput.disabled = !view?.task || pendingApproval;
  elements.promptInput.placeholder = composerPlaceholder(activeRun, pendingApproval);
  elements.sendPrompt.textContent = sendButtonLabel(activeRun);

  renderTaskTabs();
  renderApproval();
  renderWorkflow();
  renderRuns();
  renderArtifacts();
  renderPreview();
  renderInspector();
  renderSideView();
}

function hasActiveRun(view = activeTaskView()): boolean {
  const latestRun = view?.report?.runs.at(-1);
  return isActiveRunStatus(latestRun?.status ?? "");
}

function isActiveRunStatus(status: string): boolean {
  return ["active", "waiting-for-approval", "resumed-after-approval", "stopping"].includes(status);
}

function renderApproval(): void {
  const approval = activeTaskView()?.pendingApproval ?? null;
  elements.approvalBanner.classList.toggle("hidden", !approval);
  if (!approval) {
    return;
  }
  elements.approvalTitle.textContent =
    approval.kind === "command"
      ? "Command approval requested"
      : approval.kind === "workspace-trust"
        ? "Workspace trust requested"
        : "File edit approval requested";
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
      facts: ["Codex idle"],
    };
  }

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
      headline: "Codex is working",
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
    headline: "Starting Codex",
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
  elements.runList.replaceChildren();
  const view = activeTaskView();
  const runs = view?.report?.runs ?? [];

  if (runs.length === 0) {
    const empty = document.createElement("article");
    empty.className = "empty-state";
    empty.textContent = view?.task ? "No Runs yet" : "Create a Task to start";
    elements.runList.append(empty);
    return;
  }

  for (const [index, run] of runs.entries()) {
    elements.runList.append(renderRun(run, index));
  }
}

function renderRun(run: RuntimeRunReport, index: number): HTMLElement {
  const view = activeTaskView();
  const card = document.createElement("article");
  card.className = "run-card";
  card.dataset.runId = run.runId;
  card.classList.toggle("highlighted", run.runId === view?.highlightedRunId);

  const header = document.createElement("div");
  header.className = "run-card-header";

  const titleBlock = document.createElement("div");
  titleBlock.className = "run-title-block";
  const chapter = document.createElement("span");
  chapter.className = "run-chapter";
  chapter.textContent = `Run ${index + 1}`;
  const title = document.createElement("h2");
  title.textContent = run.title || "(empty prompt)";
  titleBlock.append(chapter, title);
  header.append(titleBlock);

  const status = document.createElement("span");
  status.className = "run-status";
  status.textContent = run.status;
  header.append(status);

  const request = document.createElement("section");
  request.className = "run-rhythm-section run-request";
  request.append(runSectionLabel("Request"));
  const prompt = document.createElement("p");
  prompt.className = "prompt-text";
  prompt.textContent = run.prompt;
  request.append(prompt);

  const reading = document.createElement("section");
  reading.className = "run-reading";
  reading.append(runSectionLabel("Outcome"));

  const outcome = document.createElement("div");
  outcome.className = `run-outcome ${runTone(run)}`;
  outcome.textContent = runOutcome(run);
  reading.append(outcome);

  const evidence = document.createElement("div");
  evidence.className = "run-evidence";
  evidence.append(
    evidencePill("Evidence", completionLabel(run)),
    evidencePill("Lifecycle", run.lifecyclePhase),
    evidencePill("Elapsed", formatElapsed(run.elapsedMs)),
  );
  reading.append(evidence);

  const timeline = runTimeline(run);
  if (timeline.length > 0) {
    const list = document.createElement("ul");
    list.className = "run-timeline";
    for (const entry of timeline) {
      const item = document.createElement("li");
      item.textContent = entry;
      list.append(item);
    }
    reading.append(list);
  }

  const transcript = renderRunTranscript(run);
  if (transcript) {
    reading.append(transcript);
  }

  const review = document.createElement("section");
  review.className = "run-rhythm-section run-review";
  review.append(runSectionLabel("Review"));
  const reviewSummary = document.createElement("div");
  reviewSummary.className = "run-review-summary";
  reviewSummary.textContent = runReviewSummary(run);
  review.append(reviewSummary);
  if (run.artifactCandidates.length > 0) {
    const artifacts = document.createElement("div");
    artifacts.className = "run-artifacts";
    for (const artifact of run.artifactCandidates) {
      const button = document.createElement("button");
      button.className = "artifact-link";
      button.type = "button";
      button.textContent = artifact.path;
      button.addEventListener("click", () => {
        void openArtifact(artifact.path);
      });
      artifacts.append(button);
    }
    review.append(artifacts);
  }

  const next = document.createElement("section");
  next.className = "run-rhythm-section run-next-step";
  next.append(runSectionLabel("Next"));
  const nextText = document.createElement("strong");
  nextText.textContent = runNextStep(run);
  next.append(nextText);

  const metadata = document.createElement("div");
  metadata.className = "run-metadata";
  metadata.append(
    metadataItem("Completion", completionLabel(run)),
    metadataItem("Changes", String(run.changedFiles.length)),
    metadataItem("Artifacts", String(run.artifactCandidates.length)),
  );

  card.append(header, request, reading, review, next, metadata);

  if (run.changedFiles.length > 0) {
    const list = document.createElement("ul");
    list.className = "path-list";
    for (const file of run.changedFiles) {
      const item = document.createElement("li");
      item.textContent = `${file.changeKind} ${file.path}`;
      list.append(item);
    }
    card.append(list);
  }

  return card;
}

function renderRunTranscript(run: RuntimeRunReport): HTMLElement | null {
  const view = activeTaskView();
  const transcript = view ? transcriptForRun(view, run.runId) : null;
  const live = view?.liveTranscriptRunId === run.runId;
  if (!transcript && !live) {
    return null;
  }

  const section = document.createElement("section");
  section.className = "run-rhythm-section run-transcript";

  const header = document.createElement("div");
  header.className = "run-transcript-header";
  header.append(runSectionLabel("Transcript"));

  const stateLabel = document.createElement("span");
  stateLabel.className = "run-transcript-state";
  stateLabel.textContent = live ? "Live" : transcript?.truncated ? "Memory tail" : "Memory";
  header.append(stateLabel);
  section.append(header);

  const pre = document.createElement("pre");
  pre.className = "run-transcript-text";
  pre.textContent = transcript?.text.trimEnd() || "Waiting for Codex output";
  section.append(pre);

  return section;
}

function renderArtifacts(): void {
  elements.artifactList.replaceChildren();
  const view = activeTaskView();
  const artifacts = view?.artifacts ?? [];

  if (artifacts.length === 0) {
    const empty = document.createElement("div");
    empty.className = "empty-state compact";
    empty.textContent = "No artifacts";
    elements.artifactList.append(empty);
    return;
  }

  for (const artifact of artifacts) {
    const item = document.createElement("button");
    item.className = "artifact-item";
    item.type = "button";
    item.classList.toggle("selected", artifact.path === view?.selectedArtifactPath);
    const title = document.createElement("span");
    title.className = "artifact-item-title";
    title.textContent = artifact.path;
    const meta = document.createElement("span");
    meta.className = "artifact-item-meta";
    meta.textContent = `${artifactKindLabel(artifact.kind)} / ${artifact.changeKind}`;
    item.append(title, meta);
    item.addEventListener("click", () => {
      void openArtifact(artifact.path);
    });
    elements.artifactList.append(item);
  }
}

function renderPreview(): void {
  elements.previewContent.replaceChildren();
  const view = activeTaskView();

  if (view?.previewError) {
    const error = document.createElement("div");
    error.className = "empty-state compact";
    error.textContent = view.previewError;
    elements.previewContent.append(error);
    return;
  }

  if (!view?.preview) {
    const empty = document.createElement("div");
    empty.className = "empty-state compact";
    empty.textContent = "No artifact selected";
    elements.previewContent.append(empty);
    return;
  }

  const header = document.createElement("div");
  header.className = "preview-header";
  const title = document.createElement("strong");
  title.textContent = view.preview.path;
  const meta = document.createElement("span");
  meta.textContent = `${view.preview.previewKind} / ${formatBytes(view.preview.size)}${
    view.preview.truncated ? " / truncated" : ""
  }`;
  header.append(title, meta);
  elements.previewContent.append(header);

  elements.previewContent.append(renderArtifactReview());

  if (view.preview.previewKind === "html") {
    const frame = document.createElement("iframe");
    frame.className = "html-preview";
    frame.sandbox.value = "";
    frame.srcdoc = view.preview.content ?? "";
    elements.previewContent.append(frame);
    return;
  }

  if (view.preview.previewKind === "image" && view.preview.dataUrl) {
    const image = document.createElement("img");
    image.className = "image-preview";
    image.src = view.preview.dataUrl;
    image.alt = view.preview.path;
    elements.previewContent.append(image);
    return;
  }

  const pre = document.createElement("pre");
  pre.className = "text-preview";
  pre.textContent = view.preview.content ?? "";
  elements.previewContent.append(pre);
}

function renderArtifactReview(): HTMLElement {
  const section = document.createElement("section");
  section.className = "artifact-review";
  const view = activeTaskView();

  const artifact = selectedArtifact();
  const run = artifact ? runForArtifact(artifact) : null;

  const header = document.createElement("div");
  header.className = "artifact-review-header";
  const title = document.createElement("div");
  title.className = "artifact-review-title";
  title.textContent = "Review candidate";
  const badge = document.createElement("span");
  badge.className = "review-badge";
  badge.textContent = "Report-listed";
  header.append(title, badge);
  section.append(header);

  section.append(
    reviewRow("State", "Candidate"),
    reviewRow("Candidate", artifact?.path ?? view?.preview?.path ?? "unknown"),
    reviewRow("Kind", artifact ? artifactKindLabel(artifact.kind) : view?.preview?.previewKind ?? "unknown"),
    reviewRow("Change", artifact?.changeKind ?? "unknown"),
    reviewRow("Source Run", run?.title ?? artifact?.runId ?? "unknown"),
    reviewRow("Run outcome", run ? runOutcome(run) : "unknown"),
    reviewRow("Preview", view?.preview ? previewEvidenceLabel(view.preview) : "not loaded"),
    reviewRow("Report source", ".duet/runtime-report.json"),
    reviewRow("Raw terminal", "not persisted"),
  );

  const actions = document.createElement("div");
  actions.className = "artifact-review-actions";
  actions.append(
    reviewAction("Source Run", () => {
      if (run) {
        focusRun(run.runId);
      }
    }, !run),
    reviewAction("Continue", () => {
      focusComposer();
    }, !view?.task),
    reviewAction("Inspector", () => {
      setSideView("inspector");
    }, !view?.report),
    reviewAction("Terminal", () => {
      setSideView("terminal");
    }, !view?.task),
  );
  section.append(actions);

  return section;
}

function renderInspector(): void {
  elements.inspectorContent.replaceChildren();

  const view = activeTaskView();
  const report = view?.report;
  if (!report) {
    const empty = document.createElement("div");
    empty.className = "empty-state compact";
    empty.textContent = "No runtime report";
    elements.inspectorContent.append(empty);
    return;
  }

  const summary = document.createElement("section");
  summary.className = "inspector-section";
  summary.append(inspectorTitle("Runtime report summary"));
  summary.append(
    inspectorRow("Schema", `${report.schemaId} / ${report.version}`),
    inspectorRow("Task", report.taskId),
    inspectorRow("Runs", String(report.runs.length)),
    inspectorRow("Generated", formatTimestamp(report.generatedAt)),
    inspectorRow("Workspace", view?.task?.workingDirectory ?? report.runtime?.cwd ?? "unknown"),
    inspectorRow("Report", ".duet/runtime-report.json"),
    inspectorRow("Raw terminal", report.rawTerminalPointer === null ? "not persisted" : "linked"),
    inspectorRow("Raw policy", report.rawTerminalPolicy),
    inspectorRow("Provider session", view?.task?.providerSessionRef ?? "not claimed"),
  );
  elements.inspectorContent.append(summary);

  const runtime = document.createElement("section");
  runtime.className = "inspector-section";
  runtime.append(inspectorTitle("Runtime launch"));
  if (report.runtime) {
    runtime.append(
      inspectorRow("Provider", report.runtime.provider),
      inspectorRow("Command", `${report.runtime.command} ${report.runtime.args.join(" ")}`.trim()),
      inspectorRow("Cwd", report.runtime.cwd),
      inspectorRow("Terminal", `${report.runtime.cols} cols / ${report.runtime.rows} rows`),
      inspectorRow("Started", formatTimestamp(report.runtime.startedAt)),
    );
  } else {
    runtime.append(inspectorEmpty("No runtime launch recorded"));
  }
  elements.inspectorContent.append(runtime);

  for (const run of report.runs) {
    const section = document.createElement("section");
    section.className = "inspector-section";

    const title = inspectorTitle(run.title || "(empty prompt)");
    const subtitle = document.createElement("p");
    subtitle.className = "inspector-subtitle";
    subtitle.textContent = run.runId;
    section.append(
      title,
      subtitle,
      inspectorRow("Run ID", run.runId),
      inspectorRow("Kind", run.kind),
      inspectorRow("Status", run.status),
      inspectorRow("Lifecycle", run.lifecyclePhase),
      inspectorRow("Completion", completionLabel(run)),
      inspectorRow("Started", formatTimestamp(run.startedAt)),
      inspectorRow("Ended", formatTimestamp(run.endedAt)),
      inspectorRow("Elapsed", formatElapsed(run.elapsedMs)),
      inspectorRow("Status reason", run.statusReason ?? "none"),
      inspectorRow("Approvals", approvalSummary(run)),
      inspectorRow("Stops", stopSummary(run)),
      inspectorRow("Changed files", String(run.changedFiles.length)),
      inspectorRow("Artifact candidates", String(run.artifactCandidates.length)),
    );

    if (run.approvalEvents.length > 0 || run.stopEvents.length > 0) {
      section.append(inspectorGroupTitle("Approval / Stop history"));
      const history = document.createElement("ul");
      history.className = "inspector-event-list";
      for (const approval of run.approvalEvents) {
        const item = document.createElement("li");
        item.textContent =
          approval.action === "detected"
            ? `${formatTimestamp(approval.ts)} approval detected / ${approval.kind ?? "unknown"} / ${
                approval.source ?? "native screen"
              }`
            : `${formatTimestamp(approval.ts)} approval decision / ${
                approvalDecisionLabel(approval.decision)
              } / ${approval.encodedAs ?? "native control"}`;
        history.append(item);
      }
      for (const stop of run.stopEvents) {
        const item = document.createElement("li");
        item.textContent =
          stop.action === "interrupt"
            ? `${formatTimestamp(stop.ts)} stop interrupt / ${stop.encodedAs ?? "native control"}`
            : `${formatTimestamp(stop.ts)} stop completed / slashStop ${
                stop.slashStopSent ? "sent" : "not sent"
              } / ${stop.slashStopReason ?? "no reason"}`;
        history.append(item);
      }
      section.append(history);
    }

    if (run.changedFiles.length > 0) {
      section.append(inspectorGroupTitle("Changed files"));
      const files = document.createElement("ul");
      files.className = "inspector-file-list";
      for (const file of run.changedFiles) {
        const item = document.createElement("li");
        item.append(
          inspectorFileValue(file.path),
          inspectorFileMeta(
            `${file.changeKind} / ${file.type} / ${file.eventType} / ${formatMaybeBytes(file.size)}`,
          ),
          inspectorFileMeta(file.sha256 ? `sha256 ${shortHash(file.sha256)}` : "sha256 unavailable"),
        );
        files.append(item);
      }
      section.append(files);
    }

    if (run.artifactCandidates.length > 0) {
      section.append(inspectorGroupTitle("Artifact candidates"));
      const artifacts = document.createElement("ul");
      artifacts.className = "inspector-file-list";
      for (const artifact of run.artifactCandidates) {
        const item = document.createElement("li");
        item.append(
          inspectorFileValue(artifact.path),
          inspectorFileMeta(`${artifact.type} / ${artifact.changeKind}`),
        );
        artifacts.append(item);
      }
      section.append(artifacts);
    }

    elements.inspectorContent.append(section);
  }

  if (report.unassignedChanges.length > 0) {
    const section = document.createElement("section");
    section.className = "inspector-section";
    section.append(inspectorTitle("Unassigned changes"));
    const files = document.createElement("ul");
    files.className = "inspector-file-list";
    for (const file of report.unassignedChanges) {
      const item = document.createElement("li");
      item.append(
        inspectorFileValue(file.path),
        inspectorFileMeta(`${file.changeKind} / ${file.type} / ${file.eventType}`),
      );
      files.append(item);
    }
    section.append(files);
    elements.inspectorContent.append(section);
  }
}

function renderSideView(): void {
  elements.previewPanel.classList.toggle("hidden", state.sideView !== "preview");
  elements.inspectorPanel.classList.toggle("hidden", state.sideView !== "inspector");
  elements.terminalPanel.classList.toggle("hidden", state.sideView !== "terminal");
  elements.previewTab.classList.toggle("active", state.sideView === "preview");
  elements.inspectorTab.classList.toggle("active", state.sideView === "inspector");
  elements.terminalTab.classList.toggle("active", state.sideView === "terminal");
  if (state.sideView === "terminal") {
    queueMicrotask(() => {
      fitTerminal();
      void resizeTerminal();
    });
  }
}

function appendLiveTranscript(view: TaskViewState, data: string): void {
  if (!view.liveTranscriptRunId) {
    return;
  }

  const text = cleanTerminalText(data);
  if (!text.trim()) {
    return;
  }

  const transcript = ensureRunTranscript(view, view.liveTranscriptRunId);
  const nextText = `${transcript.text}${text}`;
  transcript.truncated = transcript.truncated || nextText.length > MAX_TRANSCRIPT_CHARS;
  transcript.text = nextText.slice(-MAX_TRANSCRIPT_CHARS);
  scheduleTranscriptRender();
}

function ensureRunTranscript(view: TaskViewState, runId: string): RunTranscript {
  let transcript = view.runTranscripts.find((item) => item.runId === runId);
  if (!transcript) {
    transcript = {
      runId,
      text: "",
      truncated: false,
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

function cleanTerminalText(data: string): string {
  return data
    .replace(ANSI_RE, "")
    .replace(CONTROL_RE, "")
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .replace(/\n{4,}/g, "\n\n\n");
}

async function openArtifact(relativePath: string): Promise<void> {
  const view = activeTaskView();
  if (!view?.task) {
    return;
  }

  await window.duetRuntime.openPreview({
    taskId: view.task.id,
    relativePath,
  });

  state.sideView = "preview";
  view.selectedArtifactPath = relativePath;
  view.previewError = null;
  render();

  try {
    view.preview = await window.duetRuntime.readArtifact({
      taskId: view.task.id,
      relativePath,
    });
  } catch (error) {
    view.preview = null;
    view.previewError = errorMessage(error);
  }
  render();
}

async function openFloatingPreview(): Promise<void> {
  const view = activeTaskView();
  if (!view?.task) {
    return;
  }

  await window.duetRuntime.openPreview({
    taskId: view.task.id,
    ...(view.selectedArtifactPath ? { relativePath: view.selectedArtifactPath } : {}),
  });
}

async function openFloatingInspector(): Promise<void> {
  const view = activeTaskView();
  if (!view?.task) {
    return;
  }

  await window.duetRuntime.openInspector({
    taskId: view.task.id,
    lens: "run",
  });
}

function setSideView(view: SideView): void {
  state.sideView = view;
  render();
}

function focusRun(runId: string): void {
  const view = activeTaskView();
  if (view) {
    view.highlightedRunId = runId;
  }
  render();
  queueMicrotask(() => {
    const runCard = Array.from(elements.runList.querySelectorAll<HTMLElement>(".run-card")).find(
      (item) => item.dataset.runId === runId,
    );
    runCard?.scrollIntoView({ block: "center" });
  });
}

function focusComposer(): void {
  elements.promptInput.focus();
}

function composerPlaceholder(activeRun: boolean, pendingApproval: boolean): string {
  const view = activeTaskView();
  if (!view?.task) {
    return "Start or open a Task";
  }
  if (pendingApproval) {
    return "Approval is waiting";
  }
  if (activeRun) {
    return "Codex is working";
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

function metadataItem(label: string, value: string): HTMLElement {
  const item = document.createElement("span");
  item.textContent = `${label}: ${value}`;
  return item;
}

function evidencePill(label: string, value: string): HTMLElement {
  const item = document.createElement("span");
  item.textContent = `${label}: ${value}`;
  return item;
}

function reviewRow(label: string, value: string): HTMLElement {
  const row = document.createElement("div");
  row.className = "artifact-review-row";
  const key = document.createElement("span");
  key.textContent = label;
  const val = document.createElement("strong");
  val.textContent = value;
  row.append(key, val);
  return row;
}

function reviewAction(label: string, onClick: () => void, disabled = false): HTMLButtonElement {
  const button = document.createElement("button");
  button.className = "secondary artifact-review-action";
  button.type = "button";
  button.textContent = label;
  button.disabled = disabled;
  button.addEventListener("click", onClick);
  return button;
}

function completionLabel(run: RuntimeRunReport): string {
  if (!run.completionSource) {
    return "pending";
  }
  return `${run.completionSource} / ${run.completionConfidence ?? "low"}`;
}

function runOutcome(run: RuntimeRunReport): string {
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
  return "Codex is working";
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

function runTimeline(run: RuntimeRunReport): string[] {
  const entries: string[] = [];

  for (const approval of run.approvalEvents) {
    if (approval.action === "detected") {
      entries.push(`${approvalKindLabel(approval.kind)} approval requested`);
      continue;
    }
    entries.push(
      `${approvalKindLabel(approval.previousKind)} approval ${approvalDecisionLabel(approval.decision)} via ${
        approval.encodedAs ?? "native control"
      }`,
    );
  }

  for (const stop of run.stopEvents) {
    if (stop.action === "interrupt") {
      entries.push(`Interrupt sent via ${stop.encodedAs ?? "native control"}`);
      continue;
    }
    entries.push(stop.slashStopSent ? "/stop sent for native cleanup" : "Stopped without /stop");
  }

  if (run.changedFiles.length > 0) {
    entries.push(`${pluralize(run.changedFiles.length, "file")} changed`);
  }

  if (run.artifactCandidates.length > 0) {
    entries.push(`${pluralize(run.artifactCandidates.length, "artifact")} ready`);
  }

  return entries;
}

function runReviewSummary(run: RuntimeRunReport): string {
  if (run.artifactCandidates.length > 0) {
    return `${pluralize(run.artifactCandidates.length, "artifact")} ready for review`;
  }
  if (run.changedFiles.length > 0) {
    return `${pluralize(run.changedFiles.length, "file")} changed`;
  }
  if (run.status === "waiting-for-approval") {
    return `${approvalKindLabel(run.approvalKind)} approval pending`;
  }
  return "No review items yet";
}

function runNextStep(run: RuntimeRunReport): string {
  if (run.status === "waiting-for-approval") {
    return `${approvalKindLabel(run.approvalKind)} approval is needed.`;
  }
  if (isActiveRunStatus(run.status)) {
    return "Wait for Codex to finish this Run.";
  }
  if (run.status === "stopped") {
    return "Stopped. Continue from here when ready.";
  }
  if (run.status === "approval-denied") {
    return "Approval was denied. Continue with a revised instruction.";
  }
  if (run.artifactCandidates.length > 0) {
    return "Review artifacts, then continue or redirect.";
  }
  if (run.changedFiles.length > 0) {
    return "Review changed files, then continue or redirect.";
  }
  if (run.status === "pty-exited") {
    return "PTY exited. Open or start a Task to continue.";
  }
  if (run.status === "failed") {
    return "Run failed. Inspect details before continuing.";
  }
  return "Continue when ready.";
}

function approvalKindLabel(kind: RuntimeRunReport["approvalKind"] | null | undefined): string {
  if (kind === "workspace-trust") {
    return "Workspace trust";
  }
  if (kind === "file-edit") {
    return "File edit";
  }
  if (kind === "command") {
    return "Command";
  }
  return "Native";
}

function approvalDecisionLabel(decision: "approve" | "deny" | undefined): string {
  if (decision === "approve") {
    return "approved";
  }
  if (decision === "deny") {
    return "denied";
  }
  return "decided";
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

function selectedArtifact(): ArtifactCandidate | null {
  const view = activeTaskView();
  if (!view?.selectedArtifactPath) {
    return null;
  }
  return view.artifacts.find((artifact) => artifact.path === view.selectedArtifactPath) ?? null;
}

function runForArtifact(artifact: ArtifactCandidate): RuntimeRunReport | null {
  return activeTaskView()?.report?.runs.find((run) => run.runId === artifact.runId) ?? null;
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

function previewEvidenceLabel(preview: ArtifactPreviewResponse): string {
  return `${preview.previewKind} / ${formatBytes(preview.size)}${
    preview.truncated ? " / truncated" : ""
  }`;
}

function inspectorRow(label: string, value: string): HTMLElement {
  const row = document.createElement("div");
  row.className = "inspector-row";
  const key = document.createElement("span");
  key.textContent = label;
  const val = document.createElement("strong");
  val.textContent = value;
  row.append(key, val);
  return row;
}

function inspectorTitle(value: string): HTMLElement {
  const title = document.createElement("h3");
  title.textContent = value;
  return title;
}

function inspectorGroupTitle(value: string): HTMLElement {
  const title = document.createElement("div");
  title.className = "inspector-group-title";
  title.textContent = value;
  return title;
}

function inspectorEmpty(value: string): HTMLElement {
  const empty = document.createElement("div");
  empty.className = "empty-state compact";
  empty.textContent = value;
  return empty;
}

function inspectorFileValue(value: string): HTMLElement {
  const element = document.createElement("strong");
  element.className = "inspector-file-value";
  element.textContent = value;
  return element;
}

function inspectorFileMeta(value: string): HTMLElement {
  const element = document.createElement("span");
  element.className = "inspector-file-meta";
  element.textContent = value;
  return element;
}

function approvalSummary(run: RuntimeRunReport): string {
  if (run.approvalEvents.length === 0) {
    return "none";
  }
  const decisions = run.approvalEvents.filter((event) => event.action === "decision").length;
  return `${run.approvalEvents.length} events / ${decisions} decisions`;
}

function stopSummary(run: RuntimeRunReport): string {
  if (run.stopEvents.length === 0) {
    return "none";
  }
  const completed = run.stopEvents.some((event) => event.action === "stopped");
  return `${run.stopEvents.length} events / ${completed ? "completed" : "pending"}`;
}

function formatTimestamp(value: string | null): string {
  if (!value) {
    return "none";
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }
  return date.toLocaleString();
}

function formatMaybeBytes(value: number | null): string {
  return value === null ? "size unknown" : formatBytes(value);
}

function shortHash(value: string): string {
  return value.length > 12 ? value.slice(0, 12) : value;
}

function shortId(value: string): string {
  return value.length > 18 ? `${value.slice(0, 18)}...` : value;
}

function formatBytes(value: number): string {
  if (value < 1024) {
    return `${value} B`;
  }
  if (value < 1024 * 1024) {
    return `${Math.round(value / 1024)} KB`;
  }
  return `${(value / (1024 * 1024)).toFixed(1)} MB`;
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
  return error instanceof Error ? error.message : String(error);
}
