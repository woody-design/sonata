import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import "./styles.css";
import type { ArtifactCandidate, Task } from "../shared/types";
import type { ApprovalDetectedEvent } from "../shared/types/events";
import type { RuntimeReportV1, RuntimeRunReport } from "../shared/schemas";

interface RendererState {
  task: Task | null;
  report: RuntimeReportV1 | null;
  artifacts: ArtifactCandidate[];
  pendingApproval: ApprovalDetectedEvent["payload"] | null;
  busy: boolean;
  status: string;
}

const state: RendererState = {
  task: null,
  report: null,
  artifacts: [],
  pendingApproval: null,
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
        <button id="new-task" class="secondary" type="button">New Task</button>
      </div>
    </header>

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
        <section class="panel">
          <div class="panel-header">
            <p class="eyebrow">Artifacts</p>
          </div>
          <div id="artifact-list" class="artifact-list"></div>
        </section>

        <section class="panel terminal-panel">
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
  newTask: getElement<HTMLButtonElement>("new-task"),
  approvalBanner: getElement<HTMLDivElement>("approval-banner"),
  approvalTitle: getElement<HTMLElement>("approval-title"),
  denyApproval: getElement<HTMLButtonElement>("deny-approval"),
  approveApproval: getElement<HTMLButtonElement>("approve-approval"),
  runList: getElement<HTMLDivElement>("run-list"),
  artifactList: getElement<HTMLDivElement>("artifact-list"),
  composer: getElement<HTMLFormElement>("composer"),
  promptInput: getElement<HTMLTextAreaElement>("prompt-input"),
  stopRun: getElement<HTMLButtonElement>("stop-run"),
  sendPrompt: getElement<HTMLButtonElement>("send-prompt"),
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

elements.newTask.addEventListener("click", () => {
  void createTask();
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

window.addEventListener("resize", () => {
  fitTerminal();
});

window.duetRuntime.onRuntimeEvent((event) => {
  if (event.type === "pty:data") {
    terminal.write(event.payload.data);
    return;
  }

  if (event.type === "approval:detected") {
    state.pendingApproval = event.payload;
    state.status = "Waiting for approval";
    render();
    return;
  }

  if (event.type === "approval:decision") {
    state.pendingApproval = null;
    state.status = event.payload.decision === "approve" ? "Approval sent" : "Approval denied";
    render();
    return;
  }

  if (event.type === "run:stopped") {
    state.status = "Stopped";
    render();
  }

  if (event.type === "report:updated" && state.task && event.payload.taskId === state.task.id) {
    void refreshReport();
  }
});

render();

async function createTask(): Promise<void> {
  state.busy = true;
  state.status = "Starting Codex";
  terminal.clear();
  render();

  try {
    const response = await window.duetRuntime.createTask({
      provider: "codex",
      title: "Walking Skeleton Task",
      approval: "on-request",
      sandbox: "read-only",
      rows: terminal.rows,
      cols: terminal.cols,
    });
    state.task = response.task;
    state.report = null;
    state.artifacts = [];
    state.pendingApproval = null;
    state.status = `Codex PTY ${response.runtime.pid}`;
    await resizeTerminal();
  } catch (error) {
    state.status = errorMessage(error);
  } finally {
    state.busy = false;
    render();
  }
}

async function submitPrompt(): Promise<void> {
  if (!state.task) {
    return;
  }

  const text = elements.promptInput.value.trim();
  if (!text) {
    return;
  }

  state.busy = true;
  state.status = "Submitted";
  render();

  try {
    await window.duetRuntime.submitPrompt({ taskId: state.task.id, text });
    elements.promptInput.value = "";
  } catch (error) {
    state.status = errorMessage(error);
  } finally {
    state.busy = false;
    render();
  }
}

async function decideApproval(decision: "approve" | "deny"): Promise<void> {
  if (!state.task) {
    return;
  }

  state.busy = true;
  render();
  try {
    await window.duetRuntime.decideApproval({ taskId: state.task.id, decision });
  } catch (error) {
    state.status = errorMessage(error);
  } finally {
    state.busy = false;
    render();
  }
}

async function stopRun(): Promise<void> {
  if (!state.task) {
    return;
  }

  state.busy = true;
  state.status = "Stopping";
  render();
  try {
    await window.duetRuntime.stopRun({ taskId: state.task.id });
  } catch (error) {
    state.status = errorMessage(error);
  } finally {
    state.busy = false;
    render();
  }
}

async function refreshReport(): Promise<void> {
  if (!state.task) {
    return;
  }

  state.report = await window.duetRuntime.readReport({ taskId: state.task.id });
  state.artifacts = await window.duetRuntime.listArtifacts({ taskId: state.task.id });
  render();
}

async function resizeTerminal(): Promise<void> {
  if (!state.task) {
    return;
  }
  fitTerminal();
  await window.duetRuntime.resizeTerminal({
    taskId: state.task.id,
    cols: terminal.cols,
    rows: terminal.rows,
  });
}

function render(): void {
  elements.taskTitle.textContent = state.task?.title ?? "No active Task";
  elements.runtimeStatus.textContent = state.status;
  elements.newTask.disabled = state.busy;
  elements.sendPrompt.disabled = !state.task || state.busy;
  elements.stopRun.disabled = !state.task || state.busy;
  elements.promptInput.disabled = !state.task || state.busy;

  renderApproval();
  renderRuns();
  renderArtifacts();
}

function renderApproval(): void {
  const approval = state.pendingApproval;
  elements.approvalBanner.classList.toggle("hidden", !approval);
  if (!approval) {
    return;
  }
  elements.approvalTitle.textContent =
    approval.kind === "command" ? "Command approval requested" : "File edit approval requested";
}

function renderRuns(): void {
  elements.runList.replaceChildren();
  const runs = state.report?.runs ?? [];

  if (runs.length === 0) {
    const empty = document.createElement("article");
    empty.className = "empty-state";
    empty.textContent = state.task ? "No Runs yet" : "Create a Task to start";
    elements.runList.append(empty);
    return;
  }

  for (const run of runs) {
    elements.runList.append(renderRun(run));
  }
}

function renderRun(run: RuntimeRunReport): HTMLElement {
  const card = document.createElement("article");
  card.className = "run-card";

  const header = document.createElement("div");
  header.className = "run-card-header";

  const title = document.createElement("h2");
  title.textContent = run.title || "(empty prompt)";
  header.append(title);

  const status = document.createElement("span");
  status.className = "run-status";
  status.textContent = run.status;
  header.append(status);

  const prompt = document.createElement("p");
  prompt.className = "prompt-text";
  prompt.textContent = run.prompt;

  const metadata = document.createElement("div");
  metadata.className = "run-metadata";
  metadata.append(
    metadataItem("Completion", completionLabel(run)),
    metadataItem("Changes", String(run.changedFiles.length)),
    metadataItem("Artifacts", String(run.artifactCandidates.length)),
  );

  card.append(header, prompt, metadata);

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

function renderArtifacts(): void {
  elements.artifactList.replaceChildren();

  if (state.artifacts.length === 0) {
    const empty = document.createElement("div");
    empty.className = "empty-state compact";
    empty.textContent = "No artifacts";
    elements.artifactList.append(empty);
    return;
  }

  for (const artifact of state.artifacts) {
    const item = document.createElement("div");
    item.className = "artifact-item";
    item.textContent = artifact.path;
    elements.artifactList.append(item);
  }
}

function metadataItem(label: string, value: string): HTMLElement {
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
