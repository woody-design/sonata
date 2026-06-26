import "./styles.css";
import type { ArtifactCandidate } from "../shared/types";
import type {
  ArtifactPreviewResponse,
  PreviewArtifactRef,
  PreviewWindowState,
  PreviewWindowTab,
} from "../shared/types/ipc";

interface FloatingPreviewState {
  tabs: PreviewWindowTab[];
  selected: PreviewArtifactRef | null;
  artifacts: ArtifactCandidate[];
  preview: ArtifactPreviewResponse | null;
  previewError: string | null;
  status: string;
}

const state: FloatingPreviewState = {
  tabs: [],
  selected: null,
  artifacts: [],
  preview: null,
  previewError: null,
  status: "No artifact selected",
};

const appElement = document.querySelector<HTMLDivElement>("#app");

if (!appElement) {
  throw new Error("Preview mount point was not found.");
}

appElement.innerHTML = `
  <section class="floating-preview-shell" aria-label="Duet Preview">
    <header class="floating-window-topbar">
      <div class="title-block">
        <p class="eyebrow">Preview</p>
        <h1 id="preview-window-title">No artifact selected</h1>
      </div>
      <span id="preview-window-status" class="status">Idle</span>
    </header>
    <nav id="preview-window-tabs" class="preview-window-tabs" aria-label="Preview tabs"></nav>
    <section id="preview-window-content" class="preview-window-content"></section>
  </section>
`;

const elements = {
  title: getElement<HTMLHeadingElement>("preview-window-title"),
  status: getElement<HTMLSpanElement>("preview-window-status"),
  tabs: getElement<HTMLElement>("preview-window-tabs"),
  content: getElement<HTMLElement>("preview-window-content"),
};

window.duetRuntime.onPreviewState((nextState) => {
  void applyPreviewState(nextState);
});

window.duetRuntime.onRuntimeEvent((event) => {
  if (event.type !== "file:changed") {
    return;
  }

  const tab = state.tabs.find(
    (item) => item.taskId === event.payload.taskId && item.path === event.payload.path,
  );
  if (!tab) {
    return;
  }

  if (state.selected && sameRef(state.selected, tab)) {
    state.tabs = state.tabs.map((item) =>
      sameRef(item, tab) ? { ...item, dirty: false, reviewed: false } : item,
    );
    void openTab(tab);
    return;
  }

  state.tabs = state.tabs.map((item) =>
    sameRef(item, tab) ? { ...item, dirty: true, reviewed: false } : item,
  );
  render();
});

void window.duetRuntime.readPreviewState().then((nextState) => applyPreviewState(nextState));

async function applyPreviewState(nextState: PreviewWindowState): Promise<void> {
  state.tabs = mergeTabs(state.tabs, nextState.tabs);
  state.selected = nextState.selected;
  state.status = nextState.selected ? "Ready" : "No artifact selected";

  await refreshArtifacts();
  if (state.selected) {
    await openTab(state.selected);
    return;
  }
  state.preview = null;
  state.previewError = null;
  render();
}

async function refreshArtifacts(): Promise<void> {
  if (!state.selected) {
    state.artifacts = [];
    return;
  }
  state.artifacts = await window.duetRuntime.listArtifacts({ taskId: state.selected.taskId });
}

async function openTab(ref: PreviewArtifactRef): Promise<void> {
  state.selected = ref;
  state.tabs = state.tabs.map((tab) => (sameRef(tab, ref) ? { ...tab, dirty: false } : tab));
  state.status = "Loading";
  render();

  try {
    state.artifacts = await window.duetRuntime.listArtifacts({ taskId: ref.taskId });
    state.preview = await window.duetRuntime.readArtifact({
      taskId: ref.taskId,
      relativePath: ref.path,
    });
    state.previewError = null;
    state.status = "Ready";
  } catch (error) {
    state.preview = null;
    state.previewError = errorMessage(error);
    state.status = "Preview error";
  }
  render();
}

function render(): void {
  elements.title.textContent = state.selected ? `${state.selected.path} / ${shortId(state.selected.taskId)}` : "No artifact selected";
  elements.status.textContent = state.status;
  renderTabs();
  renderContent();
}

function renderTabs(): void {
  elements.tabs.replaceChildren();

  if (state.tabs.length === 0) {
    const empty = document.createElement("span");
    empty.className = "preview-window-empty-tab";
    empty.textContent = "Open an artifact from Main Chat";
    elements.tabs.append(empty);
    return;
  }

  for (const tab of state.tabs) {
    const button = document.createElement("button");
    button.className = "preview-window-tab";
    button.classList.toggle("selected", Boolean(state.selected && sameRef(tab, state.selected)));
    button.type = "button";
    const label = document.createElement("span");
    label.textContent = tab.path;
    const meta = document.createElement("span");
    meta.className = "preview-window-tab-meta";
    meta.textContent = shortId(tab.taskId);
    button.append(label, meta);
    if (tab.dirty) {
      const dot = document.createElement("span");
      dot.className = "preview-dirty-dot";
      dot.title = "Updated";
      button.append(dot);
    } else if (tab.reviewed) {
      const reviewed = document.createElement("span");
      reviewed.className = "preview-reviewed-mark";
      reviewed.textContent = "Reviewed";
      button.append(reviewed);
    }
    button.addEventListener("click", () => {
      void openTab(tab);
    });
    elements.tabs.append(button);
  }
}

function renderContent(): void {
  elements.content.replaceChildren();

  if (state.previewError) {
    const error = document.createElement("div");
    error.className = "empty-state";
    error.textContent = state.previewError;
    elements.content.append(error);
    return;
  }

  if (!state.preview) {
    const empty = document.createElement("div");
    empty.className = "empty-state";
    empty.textContent = "Open an artifact from Main Chat";
    elements.content.append(empty);
    return;
  }

  elements.content.append(renderFloatingReview());

  if (state.preview.previewKind === "html") {
    const frame = document.createElement("iframe");
    frame.className = "html-preview";
    frame.sandbox.value = "";
    frame.srcdoc = state.preview.content ?? "";
    elements.content.append(frame);
    return;
  }

  if (state.preview.previewKind === "image" && state.preview.dataUrl) {
    const image = document.createElement("img");
    image.className = "image-preview";
    image.src = state.preview.dataUrl;
    image.alt = state.preview.path;
    elements.content.append(image);
    return;
  }

  const pre = document.createElement("pre");
  pre.className = "text-preview";
  pre.textContent = state.preview.content ?? "";
  elements.content.append(pre);
}

function renderFloatingReview(): HTMLElement {
  const section = document.createElement("section");
  section.className = "artifact-review";
  const artifact = selectedArtifact();

  const header = document.createElement("div");
  header.className = "artifact-review-header";
  const title = document.createElement("div");
  title.className = "artifact-review-title";
  title.textContent = "Review candidate";
  const badge = document.createElement("span");
  badge.className = "review-badge";
  badge.textContent = reviewStatusLabel(selectedTab());
  header.append(title, badge);
  section.append(header);

  section.append(
    reviewRow("Task", state.selected ? shortId(state.selected.taskId) : "unknown"),
    reviewRow("Candidate", state.preview?.path ?? "unknown"),
    reviewRow("Surface", "Floating Preview"),
    reviewRow("Kind", artifact ? artifact.kind : state.preview?.previewKind ?? "unknown"),
    reviewRow("Change", artifact?.changeKind ?? "unknown"),
    reviewRow("Preview", state.preview ? previewEvidenceLabel(state.preview) : "not loaded"),
    reviewRow("Report source", "runtime-report.json"),
    reviewRow("Raw terminal", "not persisted"),
  );

  const actions = document.createElement("div");
  actions.className = "artifact-review-actions";
  actions.append(
    reviewAction("Back to Main Chat", () => {
      void focusCurrentArtifact("artifact");
    }),
    reviewAction("Show Run", () => {
      void focusCurrentArtifact("run");
    }),
    reviewAction(selectedTab()?.reviewed ? "Reviewed" : "Mark Reviewed", () => {
      void markCurrentReviewed();
    }, selectedTab()?.reviewed ?? false),
  );
  section.append(actions);

  return section;
}

function reviewAction(label: string, action: () => void, disabled = false): HTMLButtonElement {
  const button = document.createElement("button");
  button.className = "artifact-review-action secondary";
  button.type = "button";
  button.textContent = label;
  button.disabled = disabled;
  button.addEventListener("click", action);
  return button;
}

async function focusCurrentArtifact(mode: "artifact" | "run"): Promise<void> {
  if (!state.selected) {
    return;
  }
  const artifact = selectedArtifact();
  await window.duetRuntime.focusArtifactInMain({
    taskId: state.selected.taskId,
    relativePath: state.selected.path,
    mode,
    ...(artifact?.runId ? { runId: artifact.runId } : {}),
  });
}

async function markCurrentReviewed(): Promise<void> {
  if (!state.selected) {
    return;
  }
  const nextState = await window.duetRuntime.markPreviewReviewed({
    taskId: state.selected.taskId,
    relativePath: state.selected.path,
  });
  await applyPreviewState(nextState);
}

function selectedTab(): PreviewWindowTab | null {
  if (!state.selected) {
    return null;
  }
  return state.tabs.find((tab) => sameRef(tab, state.selected as PreviewArtifactRef)) ?? null;
}

function reviewStatusLabel(tab: PreviewWindowTab | null): string {
  if (tab?.dirty) {
    return "Updated";
  }
  if (tab?.reviewed) {
    return "Reviewed";
  }
  return "Needs review";
}

function selectedArtifact(): ArtifactCandidate | null {
  if (!state.selected) {
    return null;
  }
  return (
    state.artifacts.find(
      (artifact) => artifact.taskId === state.selected?.taskId && artifact.path === state.selected.path,
    ) ?? null
  );
}

function mergeTabs(existing: PreviewWindowTab[], incoming: PreviewWindowTab[]): PreviewWindowTab[] {
  const byKey = new Map<string, PreviewWindowTab>();
  for (const tab of existing) {
    byKey.set(tabKey(tab), tab);
  }
  return incoming.map((tab) => {
    const current = byKey.get(tabKey(tab));
    return current ? { ...tab, dirty: current.dirty || tab.dirty } : tab;
  });
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

function previewEvidenceLabel(preview: ArtifactPreviewResponse): string {
  return `${preview.previewKind} / ${formatBytes(preview.size)}${
    preview.truncated ? " / truncated" : ""
  }`;
}

function sameRef(left: PreviewArtifactRef, right: PreviewArtifactRef): boolean {
  return left.taskId === right.taskId && left.path === right.path;
}

function tabKey(ref: PreviewArtifactRef): string {
  return `${ref.taskId}:${ref.path}`;
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

function getElement<T extends HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (!element) {
    throw new Error(`Missing preview element: ${id}`);
  }
  return element as T;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
