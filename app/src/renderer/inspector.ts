import "./styles.css";
import type { ArtifactCandidate, InspectorLens, Task } from "../shared/types";
import type {
  InspectorWindowState,
  WorkspaceExternalOpenTarget,
  WorkspaceFilePreviewResponse,
  WorkspaceTreeEntry,
} from "../shared/types/ipc";
import type {
  RuntimeFileChangeReport,
  RuntimeReportV1,
  RuntimeRunReport,
} from "../shared/schemas/runtime-report";

interface FloatingInspectorState {
  taskId: string | null;
  lens: InspectorLens;
  tasks: Task[];
  report: RuntimeReportV1 | null;
  artifacts: ArtifactCandidate[];
  tree: WorkspaceTreeEntry[];
  selectedFilePath: string | null;
  filePreview: WorkspaceFilePreviewResponse | null;
  fileError: string | null;
  status: string;
}

const lenses: Array<{ id: InspectorLens; label: string }> = [
  { id: "run", label: "Run" },
  { id: "change", label: "Change" },
  { id: "artifact", label: "Artifact" },
  { id: "folder", label: "Folder" },
];

const state: FloatingInspectorState = {
  taskId: null,
  lens: "run",
  tasks: [],
  report: null,
  artifacts: [],
  tree: [],
  selectedFilePath: null,
  filePreview: null,
  fileError: null,
  status: "No active Task",
};

const appElement = document.querySelector<HTMLDivElement>("#app");

if (!appElement) {
  throw new Error("Inspector mount point was not found.");
}

appElement.innerHTML = `
  <section class="floating-inspector-shell" aria-label="Duet Inspector">
    <header class="floating-window-topbar">
      <div class="title-block">
        <p class="eyebrow">Inspector</p>
        <h1 id="inspector-window-title">No active Task</h1>
      </div>
      <div class="topbar-actions">
        <span id="inspector-window-status" class="status">Idle</span>
        <button id="open-workspace-cursor" class="secondary" type="button">Open in Cursor</button>
        <button id="open-workspace-folder" class="secondary" type="button">Open Folder</button>
      </div>
    </header>
    <nav id="inspector-task-tabs" class="inspector-task-tabs" aria-label="Inspector Task tabs"></nav>
    <nav id="inspector-window-tabs" class="inspector-window-tabs" aria-label="Inspector lenses"></nav>
    <section id="inspector-window-content" class="inspector-window-content"></section>
  </section>
`;

const elements = {
  title: getElement<HTMLHeadingElement>("inspector-window-title"),
  status: getElement<HTMLSpanElement>("inspector-window-status"),
  openCursor: getElement<HTMLButtonElement>("open-workspace-cursor"),
  openFolder: getElement<HTMLButtonElement>("open-workspace-folder"),
  taskTabs: getElement<HTMLElement>("inspector-task-tabs"),
  tabs: getElement<HTMLElement>("inspector-window-tabs"),
  content: getElement<HTMLElement>("inspector-window-content"),
};

elements.openCursor.addEventListener("click", () => {
  void openWorkspaceExternal("cursor");
});

elements.openFolder.addEventListener("click", () => {
  void openWorkspaceExternal("folder");
});

window.duetRuntime.onInspectorState((nextState) => {
  void applyInspectorState(nextState);
});

window.duetRuntime.onRuntimeEvent((event) => {
  if (event.type === "pty:data") {
    return;
  }

  if (event.type === "task:started") {
    void refreshTasks();
  }

  if (!state.taskId || event.payload.taskId !== state.taskId) {
    return;
  }

  if (event.type === "report:updated" || event.type === "file:changed") {
    void refreshData();
  }
});

void window.duetRuntime.readInspectorState().then((nextState) => applyInspectorState(nextState));

async function applyInspectorState(nextState: InspectorWindowState): Promise<void> {
  const taskChanged = state.taskId !== nextState.taskId;
  state.taskId = nextState.taskId;
  state.lens = nextState.lens;
  state.status = nextState.taskId ? "Loading" : "No active Task";
  await refreshTasks();
  if (taskChanged) {
    state.selectedFilePath = null;
    state.filePreview = null;
    state.fileError = null;
  }
  render();
  await refreshData();
}

async function refreshData(): Promise<void> {
  if (!state.taskId) {
    state.report = null;
    state.artifacts = [];
    state.tree = [];
    state.status = "No active Task";
    render();
    return;
  }

  try {
    const [report, artifacts] = await Promise.all([
      window.duetRuntime.readReport({ taskId: state.taskId }),
      window.duetRuntime.listArtifacts({ taskId: state.taskId }),
    ]);
    state.report = report;
    state.artifacts = artifacts;
    if (state.lens === "folder") {
      state.tree = await window.duetRuntime.readWorkspaceTree({ taskId: state.taskId });
    }
    state.status = "Ready";
  } catch (error) {
    state.status = errorMessage(error);
  }
  render();
}

function render(): void {
  elements.title.textContent = state.taskId ? `Task ${shortId(state.taskId)}` : "No active Task";
  elements.status.textContent = state.status;
  elements.openCursor.disabled = !state.taskId;
  elements.openFolder.disabled = !state.taskId;
  renderTaskTabs();
  renderTabs();
  renderContent();
}

function renderTaskTabs(): void {
  elements.taskTabs.replaceChildren();

  if (state.tasks.length === 0) {
    const empty = document.createElement("span");
    empty.className = "inspector-task-empty";
    empty.textContent = "No open Tasks";
    elements.taskTabs.append(empty);
    return;
  }

  for (const task of state.tasks) {
    const button = document.createElement("button");
    button.className = "inspector-task-tab";
    button.classList.toggle("selected", task.id === state.taskId);
    button.type = "button";
    const title = document.createElement("span");
    title.className = "inspector-task-title";
    title.textContent = task.title;
    const meta = document.createElement("span");
    meta.className = "inspector-task-meta";
    meta.textContent = `${shortId(task.id)} / ${task.status}`;
    button.append(title, meta);
    button.addEventListener("click", () => {
      void switchTask(task.id);
    });
    elements.taskTabs.append(button);
  }
}

function renderTabs(): void {
  elements.tabs.replaceChildren();

  for (const lens of lenses) {
    const button = document.createElement("button");
    button.className = "inspector-window-tab";
    button.classList.toggle("selected", lens.id === state.lens);
    button.type = "button";
    button.textContent = lens.label;
    button.addEventListener("click", () => {
      void switchLens(lens.id);
    });
    elements.tabs.append(button);
  }
}

function renderContent(): void {
  elements.content.replaceChildren();

  if (!state.taskId) {
    elements.content.append(
      emptyState(state.tasks.length > 0 ? "Choose a Task to inspect" : "Open Inspector from an active Task"),
    );
    return;
  }

  if (!state.report) {
    elements.content.append(emptyState(state.status === "Ready" ? "No runtime report" : state.status));
    return;
  }

  if (state.lens === "run") {
    renderRunLens();
    return;
  }
  if (state.lens === "change") {
    renderChangeLens();
    return;
  }
  if (state.lens === "artifact") {
    renderArtifactLens();
    return;
  }
  renderFolderLens();
}

async function switchLens(lens: InspectorLens): Promise<void> {
  state.lens = lens;
  state.status = lens === "folder" ? "Loading folder" : "Ready";
  render();
  if (state.taskId) {
    await window.duetRuntime.openInspector({ taskId: state.taskId, lens });
  }
  await refreshData();
}

async function switchTask(taskId: string): Promise<void> {
  if (taskId === state.taskId) {
    return;
  }
  state.taskId = taskId;
  state.selectedFilePath = null;
  state.filePreview = null;
  state.fileError = null;
  state.status = "Loading";
  render();
  const nextState = await window.duetRuntime.openInspector({ taskId, lens: state.lens });
  await applyInspectorState(nextState);
}

async function refreshTasks(): Promise<void> {
  state.tasks = await window.duetRuntime.listTasks();
  if (state.taskId && !state.tasks.some((task) => task.id === state.taskId)) {
    state.taskId = null;
    state.report = null;
    state.artifacts = [];
    state.tree = [];
    state.selectedFilePath = null;
    state.filePreview = null;
    state.fileError = null;
    state.status = "No active Task";
  }
  renderTaskTabs();
}

function renderRunLens(): void {
  const report = state.report;
  if (!report) {
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
    inspectorRow("Workspace", report.runtime?.cwd ?? "unknown"),
    inspectorRow("Report", ".duet/runtime-report.json"),
    inspectorRow("Raw terminal", "not persisted"),
    inspectorRow("Raw policy", report.rawTerminalPolicy),
  );
  elements.content.append(summary);

  if (report.runs.length === 0) {
    elements.content.append(emptyState("No Runs yet"));
    return;
  }

  for (const [index, run] of report.runs.entries()) {
    elements.content.append(renderRunSection(run, index));
  }
}

function renderRunSection(run: RuntimeRunReport, index: number): HTMLElement {
  const section = document.createElement("section");
  section.className = "inspector-section";
  section.append(
    inspectorTitle(`Run ${index + 1}`),
    inspectorSubtitle(run.title || "(empty prompt)"),
    inspectorRow("Run ID", run.runId),
    inspectorRow("Status", run.status),
    inspectorRow("Lifecycle", run.lifecyclePhase),
    inspectorRow("Completion", completionLabel(run)),
    inspectorRow("Started", formatTimestamp(run.startedAt)),
    inspectorRow("Ended", formatTimestamp(run.endedAt)),
    inspectorRow("Elapsed", formatElapsed(run.elapsedMs)),
    inspectorRow("Approvals", approvalSummary(run)),
    inspectorRow("Stops", stopSummary(run)),
    inspectorRow("Changed files", String(run.changedFiles.length)),
    inspectorRow("Artifacts", String(run.artifactCandidates.length)),
  );
  section.append(inspectorActionRow([
    inspectorAction("Show in Main Chat", () => {
      void focusMainRun(run.runId);
    }),
  ]));

  if (run.changedFiles.length > 0) {
    section.append(inspectorGroupTitle("Changed files"));
    section.append(changeReviewList(run.changedFiles));
  }

  if (run.artifactCandidates.length > 0) {
    section.append(inspectorGroupTitle("Artifact candidates"));
    const list = document.createElement("ul");
    list.className = "inspector-file-list";
    for (const artifact of run.artifactCandidates) {
      const item = document.createElement("li");
      item.append(
        inspectorFileValue(artifact.path),
        inspectorFileMeta(`${artifact.type} / ${artifact.changeKind}`),
        inspectorInlineActions([
          inspectorAction("Open Preview", () => {
            void openPreviewArtifact(artifact.path);
          }),
          inspectorAction("Show in Main Chat", () => {
            void focusMainArtifact(artifact.path, run.runId);
          }),
        ]),
      );
      list.append(item);
    }
    section.append(list);
  }

  return section;
}

function renderChangeLens(): void {
  const changes = uniqueChanges();
  const section = document.createElement("section");
  section.className = "inspector-section change-summary";
  section.append(inspectorTitle("Changed files summary"));
  section.append(
    inspectorRow("Scope", "active Task workspace"),
    inspectorRow("Source", ".duet/runtime-report.json"),
    inspectorRow("Git dependency", "not used in MVP"),
    inspectorRow("Changed files", pluralize(changes.length, "changed file")),
  );
  elements.content.append(section);

  if (changes.length === 0) {
    elements.content.append(emptyState("No changed files"));
    return;
  }

  const listSection = document.createElement("section");
  listSection.className = "inspector-section";
  listSection.append(inspectorTitle("Files"));
  listSection.append(changeReviewList(changes));
  elements.content.append(listSection);
}

function renderArtifactLens(): void {
  const section = document.createElement("section");
  section.className = "inspector-section";
  section.append(inspectorTitle("Artifact candidates"));
  section.append(
    inspectorRow("Source", ".duet/runtime-report.json"),
    inspectorRow("Preview rule", "report-listed candidates only"),
    inspectorRow("Candidates", String(state.artifacts.length)),
  );
  elements.content.append(section);

  if (state.artifacts.length === 0) {
    elements.content.append(emptyState("No artifact candidates"));
    return;
  }

  const list = document.createElement("section");
  list.className = "inspector-section";
  list.append(inspectorTitle("Review actions"));
  const items = document.createElement("div");
  items.className = "artifact-list standalone";
  for (const artifact of state.artifacts) {
    const item = document.createElement("article");
    item.className = "artifact-item inspector-artifact-item";
    const title = document.createElement("span");
    title.className = "artifact-item-title";
    title.textContent = artifact.path;
    const meta = document.createElement("span");
    meta.className = "artifact-item-meta";
    meta.textContent = `${artifact.kind} / ${artifact.changeKind} / ${artifact.runId}`;
    item.append(
      title,
      meta,
      inspectorInlineActions([
        inspectorAction("Open Preview", () => {
          void openPreviewArtifact(artifact.path);
        }),
        inspectorAction("Show in Main Chat", () => {
          void focusMainArtifact(artifact.path, artifact.runId);
        }),
        inspectorAction("Show Run", () => {
          void focusMainRun(artifact.runId);
        }),
      ]),
    );
    items.append(item);
  }
  list.append(items);
  elements.content.append(list);
}

function renderFolderLens(): void {
  const layout = document.createElement("section");
  layout.className = "inspector-folder-layout";

  const treePane = document.createElement("div");
  treePane.className = "inspector-folder-tree";
  const treeHeader = document.createElement("div");
  treeHeader.className = "inspector-pane-header";
  treeHeader.textContent = "Folder";
  treePane.append(treeHeader);

  if (state.tree.length === 0) {
    treePane.append(emptyState("No files in workspace"));
  } else {
    const tree = document.createElement("div");
    tree.className = "workspace-tree";
    appendTreeEntries(tree, state.tree);
    treePane.append(tree);
  }

  const detailPane = document.createElement("div");
  detailPane.className = "inspector-folder-detail";
  const detailHeader = document.createElement("div");
  detailHeader.className = "inspector-pane-header";
  detailHeader.textContent = state.selectedFilePath ?? "Read-only preview";
  detailPane.append(detailHeader, renderFilePreview());

  layout.append(treePane, detailPane);
  elements.content.append(layout);
}

function appendTreeEntries(container: HTMLElement, entries: WorkspaceTreeEntry[]): void {
  for (const entry of entries) {
    const item = document.createElement(entry.type === "file" ? "button" : "div");
    item.className = "workspace-tree-item";
    item.classList.toggle("directory", entry.type === "directory");
    item.classList.toggle("selected", entry.path === state.selectedFilePath);
    item.style.paddingLeft = `${8 + entry.depth * 14}px`;
    item.textContent = entry.type === "directory" ? `${entry.name}/` : entry.name;
    if (entry.type === "file") {
      (item as HTMLButtonElement).type = "button";
      item.addEventListener("click", () => {
        void selectWorkspaceFile(entry.path);
      });
    }
    container.append(item);

    if (entry.children && entry.children.length > 0) {
      appendTreeEntries(container, entry.children);
    }
  }
}

function renderFilePreview(): HTMLElement {
  if (state.fileError) {
    return emptyState(state.fileError);
  }

  if (!state.filePreview) {
    return emptyState("Select a file from the folder tree");
  }

  const wrapper = document.createElement("div");
  wrapper.className = "workspace-file-preview";

  const header = document.createElement("div");
  header.className = "preview-header";
  const titleBlock = document.createElement("div");
  titleBlock.className = "workspace-file-title";
  const title = document.createElement("strong");
  title.textContent = state.filePreview.path;
  const meta = document.createElement("span");
  meta.textContent = `${state.filePreview.previewKind} / ${formatBytes(state.filePreview.size)}${
    state.filePreview.truncated ? " / truncated" : ""
  }`;
  titleBlock.append(title, meta);
  header.append(
    titleBlock,
    inspectorInlineActions([
      inspectorAction("Open File in Cursor", () => {
        void openWorkspaceExternal("cursor", state.filePreview?.path);
      }),
      inspectorAction("Reveal in Folder", () => {
        void openWorkspaceExternal("folder", state.filePreview?.path);
      }),
    ]),
  );
  wrapper.append(header);

  if (state.filePreview.previewKind === "html") {
    const frame = document.createElement("iframe");
    frame.className = "html-preview";
    frame.sandbox.value = "";
    frame.srcdoc = state.filePreview.content ?? "";
    wrapper.append(frame);
    return wrapper;
  }

  if (state.filePreview.previewKind === "image" && state.filePreview.dataUrl) {
    const image = document.createElement("img");
    image.className = "image-preview";
    image.src = state.filePreview.dataUrl;
    image.alt = state.filePreview.path;
    wrapper.append(image);
    return wrapper;
  }

  const pre = document.createElement("pre");
  pre.className = "text-preview";
  pre.textContent = state.filePreview.content ?? "";
  wrapper.append(pre);
  return wrapper;
}

async function selectWorkspaceFile(relativePath: string): Promise<void> {
  if (!state.taskId) {
    return;
  }
  state.selectedFilePath = relativePath;
  state.fileError = null;
  state.status = "Loading file";
  render();

  try {
    state.filePreview = await window.duetRuntime.readWorkspaceFile({
      taskId: state.taskId,
      relativePath,
    });
    state.status = "Ready";
  } catch (error) {
    state.filePreview = null;
    state.fileError = errorMessage(error);
    state.status = "File preview error";
  }
  render();
}

async function openPreviewArtifact(relativePath: string): Promise<void> {
  if (!state.taskId) {
    return;
  }
  await window.duetRuntime.openPreview({
    taskId: state.taskId,
    relativePath,
  });
}

async function focusMainArtifact(relativePath: string, runId?: string): Promise<void> {
  if (!state.taskId) {
    return;
  }
  await window.duetRuntime.focusArtifactInMain({
    taskId: state.taskId,
    relativePath,
    mode: "artifact",
    ...(runId ? { runId } : {}),
  });
}

async function focusMainRun(runId: string): Promise<void> {
  if (!state.taskId) {
    return;
  }
  await window.duetRuntime.focusArtifactInMain({
    taskId: state.taskId,
    runId,
    mode: "run",
  });
}

async function openWorkspaceExternal(
  target: WorkspaceExternalOpenTarget,
  relativePath?: string,
): Promise<void> {
  if (!state.taskId) {
    return;
  }
  state.status = externalOpenPendingLabel(target, relativePath);
  render();
  try {
    await window.duetRuntime.openWorkspaceExternal({
      taskId: state.taskId,
      target,
      ...(relativePath ? { relativePath } : {}),
    });
    state.status = externalOpenDoneLabel(target, relativePath);
  } catch (error) {
    state.status = errorMessage(error);
  }
  render();
}

function externalOpenPendingLabel(target: WorkspaceExternalOpenTarget, relativePath?: string): string {
  if (target === "cursor") {
    return relativePath ? "Opening file in Cursor" : "Opening workspace in Cursor";
  }
  return relativePath ? "Revealing file" : "Opening folder";
}

function externalOpenDoneLabel(target: WorkspaceExternalOpenTarget, relativePath?: string): string {
  if (target === "cursor") {
    return relativePath ? "Opened file in Cursor" : "Opened workspace in Cursor";
  }
  return relativePath ? "Revealed in folder" : "Opened folder";
}

function changeReviewList(files: RuntimeFileChangeReport[]): HTMLElement {
  const list = document.createElement("ul");
  list.className = "inspector-file-list inspector-review-list";
  for (const file of files) {
    const run = runForChangedPath(file.path);
    const artifact = artifactForPath(file.path);
    const actions = [
      ...(run
        ? [
            inspectorAction("Show Run", () => {
              void focusMainRun(run.runId);
            }),
          ]
        : []),
      ...(artifact
        ? [
            inspectorAction("Open Preview", () => {
              void openPreviewArtifact(artifact.path);
            }),
            inspectorAction("Show in Main Chat", () => {
              void focusMainArtifact(artifact.path, artifact.runId);
            }),
          ]
        : []),
    ];
    const item = document.createElement("li");
    item.append(
      inspectorFileValue(file.path),
      inspectorFileMeta(`${file.changeKind} / ${file.type} / ${file.eventType}`),
      inspectorFileMeta(
        `${formatMaybeBytes(file.size)} / ${file.sha256 ? shortHash(file.sha256) : "sha256 unavailable"}`,
      ),
      ...(actions.length > 0 ? [inspectorInlineActions(actions)] : []),
    );
    list.append(item);
  }
  return list;
}

function uniqueChanges(): RuntimeFileChangeReport[] {
  const byPath = new Map<string, RuntimeFileChangeReport>();
  for (const run of state.report?.runs ?? []) {
    for (const change of run.changedFiles) {
      byPath.set(change.path, change);
    }
  }
  for (const change of state.report?.unassignedChanges ?? []) {
    byPath.set(change.path, change);
  }
  return [...byPath.values()].sort((a, b) => a.path.localeCompare(b.path));
}

function runForChangedPath(relativePath: string): RuntimeRunReport | null {
  const runs = state.report?.runs ?? [];
  for (const run of [...runs].reverse()) {
    if (run.changedFiles.some((file) => file.path === relativePath)) {
      return run;
    }
  }
  return null;
}

function artifactForPath(relativePath: string): ArtifactCandidate | null {
  return state.artifacts.find((artifact) => artifact.path === relativePath) ?? null;
}

function inspectorTitle(value: string): HTMLHeadingElement {
  const title = document.createElement("h3");
  title.textContent = value;
  return title;
}

function inspectorSubtitle(value: string): HTMLElement {
  const subtitle = document.createElement("p");
  subtitle.className = "inspector-subtitle";
  subtitle.textContent = value;
  return subtitle;
}

function inspectorGroupTitle(value: string): HTMLElement {
  const title = document.createElement("div");
  title.className = "inspector-group-title";
  title.textContent = value;
  return title;
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

function inspectorActionRow(actions: HTMLButtonElement[]): HTMLElement {
  const row = document.createElement("div");
  row.className = "inspector-action-row";
  row.append(...actions);
  return row;
}

function inspectorInlineActions(actions: HTMLButtonElement[]): HTMLElement {
  const row = document.createElement("div");
  row.className = "inspector-inline-actions";
  row.append(...actions);
  return row;
}

function inspectorAction(label: string, action: () => void): HTMLButtonElement {
  const button = document.createElement("button");
  button.className = "inspector-action secondary";
  button.type = "button";
  button.textContent = label;
  button.addEventListener("click", action);
  return button;
}

function inspectorFileValue(value: string): HTMLElement {
  const element = document.createElement("span");
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

function emptyState(message: string): HTMLElement {
  const empty = document.createElement("div");
  empty.className = "empty-state";
  empty.textContent = message;
  return empty;
}

function completionLabel(run: RuntimeRunReport): string {
  if (!run.completionSource) {
    return "pending";
  }
  return `${run.completionSource} / ${run.completionConfidence ?? "low"}`;
}

function approvalSummary(run: RuntimeRunReport): string {
  if (run.approvalEvents.length === 0) {
    return "none";
  }
  return run.approvalEvents
    .map((event) =>
      event.action === "detected"
        ? `${event.kind ?? "unknown"} requested`
        : `${event.previousKind ?? "unknown"} ${event.decision ?? "decided"}`,
    )
    .join("; ");
}

function stopSummary(run: RuntimeRunReport): string {
  if (run.stopEvents.length === 0) {
    return "none";
  }
  return run.stopEvents
    .map((event) =>
      event.action === "interrupt"
        ? `interrupt ${event.encodedAs ?? "Esc"}`
        : event.slashStopSent
          ? "/stop sent"
          : "stopped",
    )
    .join("; ");
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
  return value === null ? "unknown size" : formatBytes(value);
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

function shortHash(value: string): string {
  return value.slice(0, 10);
}

function shortId(value: string): string {
  return value.length > 18 ? `${value.slice(0, 18)}...` : value;
}

function getElement<T extends HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (!element) {
    throw new Error(`Missing inspector element: ${id}`);
  }
  return element as T;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
