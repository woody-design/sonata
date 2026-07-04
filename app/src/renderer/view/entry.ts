// The New Chat task-entry panel family (map §3.1 renderer/view/entry.ts,
// D2, moved verbatim from main.ts): the entry panel, provider segment,
// folder picker, launch-settings control + popover (incl. its state-reading
// positioner — position:fixed portal into #task-settings-popover-root, see
// fix/new-chat-churn 2026-07-03), and the draft facts/message rows.
//
// State access: read-only through the module-bound atom reference below
// (initEntryView, bound by main.ts at boot before the first render — R4).
// Every handler mutation routes through the actions seam (C3 ruling: bare
// assignments in event handlers are grammar, implemented shell-side), and
// the folder-picker flow stays in the shell behind actions.pickTaskFolder.

import type {
  LaunchSpeedMode,
  ReasoningEffort,
  RuntimeProvider,
} from "../../shared/types";
import {
  MODEL_OPTIONS,
  REASONING_OPTIONS,
  SPEED_OPTIONS,
  modelValueLabel,
  reasoningValueLabel,
} from "../../reading-core/config";
import { folderName, providerLabel } from "../../reading-core/selectors/formatters";
import { activeTaskView, type RendererState } from "../../reading-core/state";
import { elements } from "../dom";
import { actions } from "../actions";

/** The shell's state atom, bound once at boot for the panel's read paths. */
let state: RendererState;

export function initEntryView(stateRef: RendererState): void {
  state = stateRef;
}

export function renderTaskEntryPanel(): HTMLElement {
  const panel = document.createElement("article");
  panel.className = "task-entry-panel";

  const copy = document.createElement("div");
  copy.className = "task-entry-copy";
  const eyebrow = document.createElement("p");
  eyebrow.className = "eyebrow";
  eyebrow.textContent = "New chat";
  const title = document.createElement("h2");
  title.textContent = "What should we work on?";
  const body = document.createElement("p");
  body.className = "task-entry-body";
  body.textContent =
    "Pick the agent and folder, then type below — your first message starts the session.";
  copy.append(eyebrow, title, body);

  const controls = document.createElement("div");
  controls.className = "task-entry-controls";
  controls.append(renderProviderSegment(), renderFolderPicker(), renderLaunchSettingsControl());

  const message = renderTaskEntryMessage();
  const facts = document.createElement("div");
  facts.className = "task-entry-facts";
  facts.append(
    taskEntryFact("Provider", providerLabel(state.taskDraft.provider)),
    taskEntryFact("Model", modelSummaryLabel(state.taskDraft.provider)),
    taskEntryFact("Folder", folderSummaryLabel()),
  );

  panel.append(copy, controls);
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
      actions.chooseDraftProvider(provider);
    });
    segment.append(button);
  }

  return segment;
}

function renderFolderPicker(): HTMLElement {
  const row = document.createElement("div");
  row.className = "task-folder-row";

  // Known projects are one click away; the file dialog is the fallback.
  const projects = (state.sessionIndex?.projects ?? []).filter((project) => !project.archived);
  for (const project of projects.slice(0, 4)) {
    if (state.taskDraft.cwd === project.path) {
      continue;
    }
    const quick = document.createElement("button");
    quick.className = "secondary task-folder-quick";
    quick.type = "button";
    quick.disabled = state.busy;
    quick.title = project.path;
    quick.textContent = project.name;
    quick.addEventListener("click", () => {
      actions.chooseDraftFolder(project.path);
    });
    row.append(quick);
  }

  const choose = document.createElement("button");
  choose.id = "entry-choose-folder";
  choose.className = "secondary";
  choose.type = "button";
  choose.disabled = state.busy;
  choose.textContent = state.taskDraft.cwd ? folderName(state.taskDraft.cwd) : "Choose Folder";
  if (state.taskDraft.cwd) {
    choose.title = state.taskDraft.cwd;
    choose.classList.add("task-folder-selected");
  }
  choose.addEventListener("click", () => {
    actions.pickTaskFolder();
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
      actions.clearDraftFolder();
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
    actions.setLaunchSettingsOpen(
      willOpen,
      willOpen
        ? {
            left: rect.left,
            top: rect.bottom + 8,
            width: rect.width,
          }
        : null,
    );
  });
  wrap.append(button);

  // The popover itself renders into #task-settings-popover-root (see
  // renderTaskSettingsPopover): position:fixed inside the #run-list scroller
  // gets paint- AND hit-test-clipped to the scroller's box, so the sections
  // past the run-list's bottom edge were invisible and unclickable.

  return wrap;
}

export function renderTaskSettingsPopover(): void {
  elements.taskSettingsPopoverRoot.replaceChildren();
  const view = activeTaskView(state);
  if (view?.task || !state.taskDraft.settingsOpen) {
    return;
  }
  elements.taskSettingsPopoverRoot.append(renderLaunchSettingsPopover(state.taskDraft.provider));
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
      actions.setDraftReasoningEffort(provider, value as ReasoningEffort | null);
    }),
    renderSettingSection("Model", MODEL_OPTIONS[provider], state.taskDraft.model[provider], (value) => {
      actions.setDraftModel(provider, value);
    }),
  );

  if (provider === "codex") {
    popover.append(
      renderSettingSection(
        "Speed",
        SPEED_OPTIONS,
        state.taskDraft.speedMode.codex,
        (value) => {
          actions.setCodexSpeedMode(value as LaunchSpeedMode);
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

function renderTaskEntryMessage(): HTMLElement | null {
  if (!state.taskDraft.message) {
    return null;
  }

  const message = document.createElement("div");
  message.className = `task-entry-message ${state.taskDraft.message.tone}`;
  message.textContent = state.taskDraft.message.text;
  return message;
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

function folderSummaryLabel(): string {
  return state.taskDraft.cwd ? folderName(state.taskDraft.cwd) : "Duet workspace";
}
