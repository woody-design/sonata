// The New Chat entry family (map §3.1 renderer/view/entry.ts): the greeting
// panel and the draft dropdown menus. Redesigned 2026-07-04 (composer-centric
// new chat): the panel is ONLY the folder-aware greeting + the draft message —
// every launch control (provider / model+reasoning / access / project) lives
// on the composer as a chip, and each chip's menu renders here, portalled
// into #task-settings-popover-root (position:fixed inside the #run-list
// scroller gets paint- AND hit-test-clipped — fix/new-chat-churn 2026-07-03).
//
// State access: read-only through the module-bound atom reference below
// (initEntryView, bound by main.ts at boot before the first render — R4).
// Every handler mutation routes through the actions seam (C3 ruling: bare
// assignments in event handlers are grammar, implemented shell-side), and
// the folder-picker flow stays in the shell behind actions.pickTaskFolder.

import type {
  ClaudeDefaultPermissionMode,
  CodexPermissionMode,
  LaunchSpeedMode,
  ReasoningEffort,
  RuntimeProvider,
} from "../../shared/types";
import {
  CLAUDE_DEFAULT_PERMISSION_MODE_OPTIONS,
  CODEX_PERMISSION_MODE_OPTIONS,
} from "../../shared/types";
import {
  MODEL_OPTIONS,
  reasoningOptionsForModel,
  speedOptionsForModel,
} from "../../reading-core/config";
import {
  codexPermissionModeLabel,
  newChatGreeting,
  permissionModeLabel,
  providerLabel,
} from "../../reading-core/selectors/formatters";
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

  const title = document.createElement("h2");
  title.textContent = newChatGreeting(
    state.taskDraft.cwd,
    state.sessionIndex?.projects ?? [],
  );
  panel.append(title);

  const message = renderTaskEntryMessage();
  if (message) {
    panel.append(message);
  }
  return panel;
}

/** The one open draft menu (launch / provider / access / project), keyed on
 *  taskDraft.menu and anchored above its composer chip. */
export function renderTaskSettingsPopover(): void {
  elements.taskSettingsPopoverRoot.replaceChildren();
  const view = activeTaskView(state);
  const menu = state.taskDraft.menu;
  if (view?.task || !menu) {
    return;
  }
  if (menu.kind === "launch") {
    elements.taskSettingsPopoverRoot.append(renderLaunchSettingsPopover(state.taskDraft.provider));
    return;
  }
  if (menu.kind === "provider") {
    elements.taskSettingsPopoverRoot.append(renderProviderMenu());
    return;
  }
  if (menu.kind === "access") {
    elements.taskSettingsPopoverRoot.append(renderAccessMenu());
    return;
  }
  elements.taskSettingsPopoverRoot.append(renderProjectMenu());
}

function draftMenuShell(width: number, menuLabel: string): HTMLElement {
  const popover = document.createElement("div");
  popover.className = "task-settings-popover";
  popover.setAttribute("role", "menu");
  popover.ariaLabel = menuLabel;
  positionDraftMenu(popover, width);
  popover.addEventListener("click", (event) => {
    event.stopPropagation();
  });
  return popover;
}

function renderLaunchSettingsPopover(provider: RuntimeProvider): HTMLElement {
  const popover = draftMenuShell(340, "Model and reasoning");

  popover.append(
    renderSettingSection(
      "Reasoning",
      reasoningOptionsForModel(provider, state.taskDraft.model[provider]),
      state.taskDraft.reasoningEffort[provider],
      (value) => {
        actions.setDraftReasoningEffort(provider, value as ReasoningEffort | null);
      },
    ),
    renderSettingSection("Model", MODEL_OPTIONS[provider], state.taskDraft.model[provider], (value) => {
      actions.setDraftModel(provider, value);
    }),
  );

  // Speed is offered only when the selected model can accept Fast: every Codex
  // model, but Claude only on Opus (native fast mode is Opus-only). When Fast
  // isn't available the section would collapse to a lone "Standard" — no real
  // choice — so it is omitted entirely.
  const speedOptions = speedOptionsForModel(provider, state.taskDraft.model[provider]);
  if (speedOptions.some((option) => option.value === "fast")) {
    popover.append(
      renderSettingSection(
        "Speed",
        speedOptions,
        state.taskDraft.speedMode[provider] ?? "default",
        (value) => {
          actions.setDraftSpeedMode(provider, value as LaunchSpeedMode);
        },
      ),
    );
  }

  return popover;
}

function renderProviderMenu(): HTMLElement {
  const popover = draftMenuShell(220, "Agent");
  const section = document.createElement("div");
  section.className = "task-setting-section";

  for (const provider of ["claude", "codex"] as const) {
    const selected = provider === state.taskDraft.provider;
    const button = document.createElement("button");
    button.id = `provider-option-${provider}`;
    button.className = "task-setting-option";
    button.classList.toggle("selected", selected);
    button.type = "button";
    button.setAttribute("role", "menuitemradio");
    button.ariaChecked = String(selected);
    button.textContent = providerLabel(provider);
    if (selected) {
      button.append(selectedBadge());
    }
    button.addEventListener("click", () => {
      actions.chooseDraftProvider(provider);
    });
    section.append(button);
  }

  popover.append(section);
  return popover;
}

/** One-line consequence per Claude mode (the Settings triad verbatim — ruled
 *  2026-07-04: the per-session chip offers exactly the standing options). */
function accessModeDescription(mode: ClaudeDefaultPermissionMode): string {
  if (mode === "acceptEdits") {
    return "Approve file edits automatically; ask for the rest";
  }
  if (mode === "auto") {
    return "Approve through Claude's safety classifier — asks only when risky";
  }
  return "Ask before edits and commands";
}

/** One-line consequence per Codex mode — the per-preset clauses of the Codex
 *  Settings footnote, so the chip menu reads the same as Settings → Codex. */
function codexAccessModeDescription(mode: CodexPermissionMode): string {
  if (mode === "approve-for-me") {
    return "Only ask for actions Codex flags as potentially unsafe";
  }
  if (mode === "full-access") {
    return "Edit files anywhere and reach the internet without asking";
  }
  return "Read and edit in the workspace; ask before anything outside it or the internet";
}

/** The access chip's draft menu — one menu kind, two vocabularies. The draft
 *  provider selects Claude's permission triad or Codex's three-preset picker. */
function renderAccessMenu(): HTMLElement {
  return state.taskDraft.provider === "codex" ? renderCodexAccessMenu() : renderClaudeAccessMenu();
}

function renderClaudeAccessMenu(): HTMLElement {
  const popover = draftMenuShell(340, "Approvals");
  const section = document.createElement("div");
  section.className = "task-setting-section";

  const heading = document.createElement("p");
  heading.className = "task-setting-heading";
  heading.textContent = "How should Claude actions be approved?";
  section.append(heading);

  const effective = state.taskDraft.permissionMode ?? state.claudeDefaultPermissionMode;
  for (const mode of CLAUDE_DEFAULT_PERMISSION_MODE_OPTIONS) {
    const selected = mode === effective;
    const button = document.createElement("button");
    button.id = `access-option-${mode}`;
    button.className = "task-setting-option task-setting-option-tall";
    button.classList.toggle("selected", selected);
    button.type = "button";
    button.setAttribute("role", "menuitemradio");
    button.ariaChecked = String(selected);

    const copy = document.createElement("span");
    copy.className = "task-setting-option-copy";
    const label = document.createElement("span");
    label.textContent = permissionModeLabel(mode);
    const description = document.createElement("span");
    description.className = "task-setting-option-desc";
    description.textContent = accessModeDescription(mode);
    copy.append(label, description);
    button.append(copy);
    if (selected) {
      button.append(selectedBadge());
    }
    button.addEventListener("click", () => {
      actions.setDraftPermissionMode(mode);
    });
    section.append(button);
  }

  popover.append(section);
  return popover;
}

function renderCodexAccessMenu(): HTMLElement {
  const popover = draftMenuShell(340, "Approvals");
  const section = document.createElement("div");
  section.className = "task-setting-section";

  const heading = document.createElement("p");
  heading.className = "task-setting-heading";
  heading.textContent = "How should Codex actions be approved?";
  section.append(heading);

  const effective = state.taskDraft.codexPermissionMode ?? state.codexDefaultPermissionMode;
  for (const mode of CODEX_PERMISSION_MODE_OPTIONS) {
    const selected = mode === effective;
    const button = document.createElement("button");
    button.id = `codex-access-option-${mode}`;
    button.className = "task-setting-option task-setting-option-tall";
    button.classList.toggle("selected", selected);
    button.type = "button";
    button.setAttribute("role", "menuitemradio");
    button.ariaChecked = String(selected);

    const copy = document.createElement("span");
    copy.className = "task-setting-option-copy";
    const label = document.createElement("span");
    label.textContent = codexPermissionModeLabel(mode);
    const description = document.createElement("span");
    description.className = "task-setting-option-desc";
    description.textContent = codexAccessModeDescription(mode);
    copy.append(label, description);
    button.append(copy);
    if (selected) {
      button.append(selectedBadge());
    }
    button.addEventListener("click", () => {
      actions.setDraftCodexPermissionMode(mode);
    });
    section.append(button);
  }

  popover.append(section);
  return popover;
}

function renderProjectMenu(): HTMLElement {
  const popover = draftMenuShell(300, "Project");

  const projects = (state.sessionIndex?.projects ?? []).filter((project) => !project.archived);

  // Local, ephemeral filtering: the query lives in the input and filters the
  // option nodes in place — routing each keystroke through a global render
  // would rebuild the menu and drop focus/IME composition mid-word.
  const search = document.createElement("input");
  search.type = "search";
  search.className = "task-menu-search";
  search.placeholder = "Search projects";
  search.setAttribute("aria-label", "Search projects");

  const section = document.createElement("div");
  section.className = "task-setting-section task-project-options";

  for (const project of projects) {
    const selected = state.taskDraft.cwd === project.path;
    const button = document.createElement("button");
    button.className = "task-setting-option task-project-option";
    button.classList.toggle("selected", selected);
    button.type = "button";
    button.setAttribute("role", "menuitemradio");
    button.ariaChecked = String(selected);
    button.title = project.path;
    button.dataset.projectName = project.name.toLowerCase();
    button.textContent = project.name;
    if (selected) {
      button.append(selectedBadge());
    }
    button.addEventListener("click", () => {
      actions.chooseDraftFolder(project.path);
    });
    section.append(button);
  }

  search.addEventListener("input", () => {
    const query = search.value.trim().toLowerCase();
    section.querySelectorAll<HTMLElement>(".task-project-option").forEach((option) => {
      option.classList.toggle(
        "hidden",
        query.length > 0 && !(option.dataset.projectName ?? "").includes(query),
      );
    });
  });

  const footer = document.createElement("div");
  footer.className = "task-setting-section";

  const choose = document.createElement("button");
  choose.id = "entry-choose-folder";
  choose.className = "task-setting-option";
  choose.type = "button";
  choose.setAttribute("role", "menuitem");
  choose.textContent = "Use an existing folder…";
  choose.addEventListener("click", () => {
    actions.pickTaskFolder();
  });
  footer.append(choose);

  if (state.taskDraft.cwd) {
    const clear = document.createElement("button");
    clear.id = "entry-clear-folder";
    clear.className = "task-setting-option";
    clear.type = "button";
    clear.setAttribute("role", "menuitem");
    clear.textContent = "Don't work in a project";
    clear.addEventListener("click", () => {
      actions.clearDraftFolder();
    });
    footer.append(clear);
  }

  if (projects.length > 0) {
    popover.append(search, section);
  }
  popover.append(footer);
  if (projects.length > 0) {
    queueMicrotask(() => search.focus());
  }
  return popover;
}

/** Above-the-chip placement: the chips sit on the composer near the bottom
 *  edge, so every draft menu opens upward — left edge aligned to the chip,
 *  clamped to the viewport, growing toward the top. */
function positionDraftMenu(popover: HTMLElement, preferredWidth: number): void {
  const anchor = state.taskDraft.menu?.anchor;
  const viewportPadding = 14;
  const width = Math.min(preferredWidth, window.innerWidth - viewportPadding * 2);
  const left = anchor
    ? Math.min(
        window.innerWidth - width - viewportPadding,
        Math.max(viewportPadding, anchor.left),
      )
    : viewportPadding;
  const anchorTop = anchor?.top ?? window.innerHeight - viewportPadding;

  popover.style.left = `${left}px`;
  popover.style.bottom = `${window.innerHeight - anchorTop + 8}px`;
  popover.style.width = `${width}px`;
  popover.style.maxHeight = `${Math.max(200, anchorTop - viewportPadding - 8)}px`;
}

/** One titled radio section of a settings popover (Reasoning / Model / …).
 *  Exported so the live session's model+effort menu (composer.ts, S1) renders
 *  the same component as the New Chat launch menu — one visual family, one
 *  selection grammar. */
export function renderSettingSection<T extends string | null>(
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
      button.append(selectedBadge());
    }
    button.addEventListener("click", () => {
      onSelect(option.value);
    });
    section.append(button);
  }

  return section;
}

function selectedBadge(): HTMLElement {
  const badge = document.createElement("span");
  badge.className = "task-setting-badge";
  badge.textContent = "selected";
  return badge;
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
