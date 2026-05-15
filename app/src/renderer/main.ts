import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import "./styles.css";
import type { ArtifactCandidate, Task } from "../shared/types";
import type { ArtifactPreviewResponse } from "../shared/types/ipc";
import type { ApprovalDetectedEvent } from "../shared/types/events";
import type { RuntimeReportV1, RuntimeRunReport } from "../shared/schemas";

type SideView = "preview" | "inspector" | "terminal";

interface RendererState {
  task: Task | null;
  report: RuntimeReportV1 | null;
  artifacts: ArtifactCandidate[];
  preview: ArtifactPreviewResponse | null;
  previewError: string | null;
  selectedArtifactPath: string | null;
  pendingApproval: ApprovalDetectedEvent["payload"] | null;
  runtimeReady: boolean;
  composerObserved: boolean;
  sideView: SideView;
  busy: boolean;
  status: string;
}

const state: RendererState = {
  task: null,
  report: null,
  artifacts: [],
  preview: null,
  previewError: null,
  selectedArtifactPath: null,
  pendingApproval: null,
  runtimeReady: false,
  composerObserved: false,
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
        <button id="open-task" class="secondary" type="button">Open Task</button>
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
  openTask: getElement<HTMLButtonElement>("open-task"),
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

elements.newTask.addEventListener("click", () => {
  void createTask();
});

elements.openTask.addEventListener("click", () => {
  void openTask();
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
    terminal.write(event.payload.data);
    return;
  }

  if (event.type === "approval:detected") {
    state.pendingApproval = event.payload;
    state.runtimeReady = false;
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

  if (event.type === "task:ready") {
    state.runtimeReady = true;
    state.composerObserved = true;
    state.status = hasActiveRun() ? state.status : "Ready";
    render();
    return;
  }

  if (event.type === "run:stopped") {
    state.runtimeReady = true;
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
    });
    state.task = response.task;
    state.report = null;
    state.artifacts = [];
    state.preview = null;
    state.previewError = null;
    state.selectedArtifactPath = null;
    state.pendingApproval = null;
    state.runtimeReady = false;
    state.composerObserved = false;
    state.status = `Codex PTY ${response.runtime.pid}`;
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
  terminal.clear();
  render();

  try {
    const response = await window.duetRuntime.openTask({});
    state.task = response.task;
    state.report = null;
    state.artifacts = [];
    state.preview = null;
    state.previewError = null;
    state.selectedArtifactPath = null;
    state.pendingApproval = null;
    state.runtimeReady = false;
    state.composerObserved = false;
    state.status = `Opened Codex PTY ${response.runtime.pid}`;
    await refreshReport();
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
    state.runtimeReady = false;
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
    await window.duetRuntime.stopRun({ taskId: state.task.id, inspectDelayMs: 6000 });
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
  if (state.composerObserved && !state.pendingApproval && !hasActiveRun()) {
    state.runtimeReady = true;
  }
  if (
    state.selectedArtifactPath &&
    !state.artifacts.some((artifact) => artifact.path === state.selectedArtifactPath)
  ) {
    state.preview = null;
    state.selectedArtifactPath = null;
  }
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
  elements.openTask.disabled = state.busy;
  elements.newTask.disabled = state.busy;
  const activeRun = hasActiveRun();
  const pendingApproval = Boolean(state.pendingApproval);
  elements.sendPrompt.disabled = !state.task || state.busy || !state.runtimeReady || pendingApproval || activeRun;
  elements.stopRun.disabled = !state.task || state.busy || !activeRun;
  elements.promptInput.disabled = !state.task || pendingApproval;

  renderApproval();
  renderRuns();
  renderArtifacts();
  renderPreview();
  renderInspector();
  renderSideView();
}

function hasActiveRun(): boolean {
  const latestRun = state.report?.runs.at(-1);
  return ["active", "waiting-for-approval", "resumed-after-approval", "stopping"].includes(
    latestRun?.status ?? "",
  );
}

function renderApproval(): void {
  const approval = state.pendingApproval;
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

  const reading = document.createElement("section");
  reading.className = "run-reading";

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

  const metadata = document.createElement("div");
  metadata.className = "run-metadata";
  metadata.append(
    metadataItem("Completion", completionLabel(run)),
    metadataItem("Changes", String(run.changedFiles.length)),
    metadataItem("Artifacts", String(run.artifactCandidates.length)),
  );

  card.append(header, prompt, reading, metadata);

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
    card.append(artifacts);
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
    const item = document.createElement("button");
    item.className = "artifact-item";
    item.type = "button";
    item.classList.toggle("selected", artifact.path === state.selectedArtifactPath);
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

  if (state.previewError) {
    const error = document.createElement("div");
    error.className = "empty-state compact";
    error.textContent = state.previewError;
    elements.previewContent.append(error);
    return;
  }

  if (!state.preview) {
    const empty = document.createElement("div");
    empty.className = "empty-state compact";
    empty.textContent = "No artifact selected";
    elements.previewContent.append(empty);
    return;
  }

  const header = document.createElement("div");
  header.className = "preview-header";
  const title = document.createElement("strong");
  title.textContent = state.preview.path;
  const meta = document.createElement("span");
  meta.textContent = `${state.preview.previewKind} / ${formatBytes(state.preview.size)}${
    state.preview.truncated ? " / truncated" : ""
  }`;
  header.append(title, meta);
  elements.previewContent.append(header);

  elements.previewContent.append(renderArtifactReview());

  if (state.preview.previewKind === "html") {
    const frame = document.createElement("iframe");
    frame.className = "html-preview";
    frame.sandbox.value = "";
    frame.srcdoc = state.preview.content ?? "";
    elements.previewContent.append(frame);
    return;
  }

  if (state.preview.previewKind === "image" && state.preview.dataUrl) {
    const image = document.createElement("img");
    image.className = "image-preview";
    image.src = state.preview.dataUrl;
    image.alt = state.preview.path;
    elements.previewContent.append(image);
    return;
  }

  const pre = document.createElement("pre");
  pre.className = "text-preview";
  pre.textContent = state.preview.content ?? "";
  elements.previewContent.append(pre);
}

function renderArtifactReview(): HTMLElement {
  const section = document.createElement("section");
  section.className = "artifact-review";

  const artifact = selectedArtifact();
  const run = artifact ? runForArtifact(artifact) : null;

  const title = document.createElement("div");
  title.className = "artifact-review-title";
  title.textContent = "Review candidate";
  section.append(title);

  section.append(
    reviewRow("Candidate", artifact?.path ?? state.preview?.path ?? "unknown"),
    reviewRow("Kind", artifact ? artifactKindLabel(artifact.kind) : state.preview?.previewKind ?? "unknown"),
    reviewRow("Change", artifact?.changeKind ?? "unknown"),
    reviewRow("Source Run", run?.title ?? artifact?.runId ?? "unknown"),
    reviewRow("Preview", state.preview ? previewEvidenceLabel(state.preview) : "not loaded"),
    reviewRow("Raw terminal", "not persisted"),
  );

  return section;
}

function renderInspector(): void {
  elements.inspectorContent.replaceChildren();

  const report = state.report;
  if (!report) {
    const empty = document.createElement("div");
    empty.className = "empty-state compact";
    empty.textContent = "No runtime report";
    elements.inspectorContent.append(empty);
    return;
  }

  const summary = document.createElement("section");
  summary.className = "inspector-section";
  summary.append(
    inspectorRow("Schema", `${report.schemaId} / ${report.version}`),
    inspectorRow("Runs", String(report.runs.length)),
    inspectorRow("Raw terminal", report.rawTerminalPointer === null ? "not persisted" : "linked"),
    inspectorRow("Report", report.runtime?.cwd ?? report.taskId),
  );
  elements.inspectorContent.append(summary);

  for (const run of report.runs) {
    const section = document.createElement("section");
    section.className = "inspector-section";

    const title = document.createElement("h3");
    title.textContent = run.title || run.runId;
    section.append(
      title,
      inspectorRow("Status", run.status),
      inspectorRow("Lifecycle", run.lifecyclePhase),
      inspectorRow("Completion", completionLabel(run)),
      inspectorRow("Approvals", String(run.approvalEvents.length)),
      inspectorRow("Stops", String(run.stopEvents.length)),
      inspectorRow("Changed files", String(run.changedFiles.length)),
    );

    if (run.approvalEvents.length > 0 || run.stopEvents.length > 0) {
      const history = document.createElement("ul");
      history.className = "inspector-list";
      for (const approval of run.approvalEvents) {
        const item = document.createElement("li");
        item.textContent = `approval ${approval.action} ${approval.kind ?? approval.decision ?? ""}`;
        history.append(item);
      }
      for (const stop of run.stopEvents) {
        const item = document.createElement("li");
        item.textContent = `stop ${stop.action}`;
        history.append(item);
      }
      section.append(history);
    }

    if (run.changedFiles.length > 0) {
      const files = document.createElement("ul");
      files.className = "inspector-list";
      for (const file of run.changedFiles) {
        const item = document.createElement("li");
        item.textContent = `${file.changeKind} ${file.path}`;
        files.append(item);
      }
      section.append(files);
    }

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

async function openArtifact(relativePath: string): Promise<void> {
  if (!state.task) {
    return;
  }

  state.sideView = "preview";
  state.selectedArtifactPath = relativePath;
  state.previewError = null;
  render();

  try {
    state.preview = await window.duetRuntime.readArtifact({
      taskId: state.task.id,
      relativePath,
    });
  } catch (error) {
    state.preview = null;
    state.previewError = errorMessage(error);
  }
  render();
}

function setSideView(view: SideView): void {
  state.sideView = view;
  render();
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
  if (!state.selectedArtifactPath) {
    return null;
  }
  return state.artifacts.find((artifact) => artifact.path === state.selectedArtifactPath) ?? null;
}

function runForArtifact(artifact: ArtifactCandidate): RuntimeRunReport | null {
  return state.report?.runs.find((run) => run.runId === artifact.runId) ?? null;
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
