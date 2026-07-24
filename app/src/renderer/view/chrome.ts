// The window chrome's popover surfaces (map §3.1 renderer/view/chrome.ts,
// D3 — moved verbatim from main.ts): the Reading ("Aa") settings popover
// (theme/mode/size), the Remote Control button + popover (T7 copy-reset
// timer and the clipboard write verbatim inside), and the terminal-window
// toggle-label patcher. State reads via the init-bound atom reference;
// resolvedReadingMode is an init-bound shell dep (its truth mixes the
// settings atom with the shell's matchMedia mirror — a shell satellite,
// map §1.2, stays in main.ts); persist/RC flows and the popover
// open/close transitions stay shell-side behind the actions seam.

import { Copy } from "lucide";
import {
  READING_MODE_IDS,
  READING_TEXT_STEPS,
  READING_THEME_IDS,
  isReadingTextStep,
  type ReadingThemeId,
  type ResolvedReadingMode,
} from "../../shared/types";
import type { TerminalWindowState } from "../../shared/types/ipc";
import {
  readingModeLabel,
  readingThemeLabel,
} from "../../reading-core/selectors/formatters";
import {
  dormantArmed,
  remoteControlContext,
  remoteControlOn,
} from "../../reading-core/selectors/runs";
import {
  activeTaskView,
  type RendererState,
} from "../../reading-core/state";
import { elements } from "../dom";
import { lucideIcon } from "./icons";
import { positionPopoverElement } from "./popover-geometry";
import { actions } from "../actions";

/** The shell's state atom + the resolved-mode read (shell matchMedia mirror),
 *  bound once at boot. */
let state: RendererState;
let resolvedReadingMode: () => ResolvedReadingMode;

export function initChromeView(
  stateRef: RendererState,
  deps: { resolvedReadingMode: () => ResolvedReadingMode },
): void {
  state = stateRef;
  resolvedReadingMode = deps.resolvedReadingMode;
}

// The CLI satellite window's icon toggle (lucide Terminal, appended at boot in
// main.ts). aria-pressed carries the open/closed state and IS the styling hook
// (.chrome-icon-button[aria-pressed="true"]); the tooltip copy stays
// "Toggle Terminal (CLI)" — "Terminal" for readers who don't know the acronym,
// "(CLI)" to anchor the term the provider ecosystem uses.
export function applyTerminalWindowState(state: TerminalWindowState): void {
  elements.toggleTerminalWindow.setAttribute("aria-pressed", state.open ? "true" : "false");
}

export function renderReadingPopover(): void {
  elements.readingSettings.setAttribute("aria-expanded", String(state.readingPopoverOpen));
  elements.readingPopoverRoot.replaceChildren();
  if (!state.readingPopoverOpen) {
    return;
  }
  elements.readingPopoverRoot.append(renderReadingSettingsPopover());
}

function renderReadingSettingsPopover(): HTMLElement {
  const popover = document.createElement("div");
  popover.className = "reading-settings-popover";
  popover.setAttribute("role", "dialog");
  popover.setAttribute("aria-label", "Reading Controls");
  positionReadingPopover(popover);
  popover.addEventListener("click", (event) => {
    event.stopPropagation();
  });

  popover.append(
    renderReadingThemeSection(),
    renderReadingModeSection(),
    renderReadingSizeSection(),
  );
  return popover;
}

function positionReadingPopover(popover: HTMLElement): void {
  const anchor = state.readingPopoverAnchor;
  const viewportPadding = 14;
  const width = Math.min(360, window.innerWidth - viewportPadding * 2);
  const top = anchor?.top ?? viewportPadding;
  const left = anchor
    ? Math.min(
        window.innerWidth - width - viewportPadding,
        Math.max(viewportPadding, anchor.left + anchor.width - width),
      )
    : viewportPadding;

  popover.style.left = `${left}px`;
  popover.style.top = `${top}px`;
  popover.style.width = `${width}px`;
  popover.style.maxHeight = `${Math.max(260, window.innerHeight - top - viewportPadding)}px`;
}

/** The header button's persistent on/off indication (active fill = "on") and
 *  availability. Mirrors the reading button's split: state here, popover content
 *  in renderRemoteControlPopover. */
export function renderRemoteControl(): void {
  const ctx = remoteControlContext(activeTaskView(state), state.taskDraft.provider);
  const on = remoteControlOn(
    ctx,
    activeTaskView(state),
    state.taskDraft.remoteControl,
    state.remoteControlDefault,
  );
  elements.remoteControlToggle.setAttribute("aria-pressed", String(on));
  elements.remoteControlToggle.disabled = ctx.mode === "unavailable";
  elements.remoteControlToggle.dataset.tooltip =
    ctx.mode === "unavailable" ? "Remote control (Claude only)" : "Remote control";
}

function remoteControlPopoverHeader(statusText: string, on: boolean): HTMLElement {
  const header = document.createElement("div");
  header.className = "remote-control-popover-header";
  const title = document.createElement("span");
  title.className = "remote-control-popover-title";
  title.textContent = "Remote control";
  const status = document.createElement("span");
  status.className = "remote-control-popover-status";
  status.classList.toggle("on", on);
  status.textContent = statusText;
  header.append(title, status);
  return header;
}

export function renderRemoteControlPopover(): void {
  elements.remoteControlToggle.setAttribute(
    "aria-expanded",
    String(state.remoteControlPopoverOpen),
  );
  elements.remoteControlPopoverRoot.replaceChildren();
  if (!state.remoteControlPopoverOpen) {
    return;
  }
  elements.remoteControlPopoverRoot.append(renderRemoteControlPopoverContent());
}

function renderRemoteControlPopoverContent(): HTMLElement {
  const popover = document.createElement("div");
  popover.className = "remote-control-popover";
  popover.setAttribute("role", "dialog");
  popover.setAttribute("aria-label", "Remote control");
  positionPopoverElement(popover, state.remoteControlPopoverAnchor, 320);
  popover.addEventListener("click", (event) => event.stopPropagation());

  // No live PTY yet (New Chat or a dormant session): the button ARMS the spawn
  // flag; the session connects the moment it starts/resumes.
  const armCtx = remoteControlContext(activeTaskView(state), state.taskDraft.provider);
  if (armCtx.mode === "arm-draft" || armCtx.mode === "arm-dormant") {
    const armed = remoteControlOn(
      armCtx,
      activeTaskView(state),
      state.taskDraft.remoteControl,
      state.remoteControlDefault,
    );
    popover.append(remoteControlPopoverHeader(armed ? "Armed" : "Off", armed));
    const armDesc = document.createElement("p");
    armDesc.className = "remote-control-popover-desc";
    armDesc.textContent = armed
      ? "Remote control will be on when this session starts — open it in the Claude app on your phone."
      : "Start this session with remote control on, so you can see and steer it from the Claude app on your phone.";
    popover.append(armDesc);
    const arm = document.createElement("button");
    arm.type = "button";
    arm.className = armed
      ? "remote-control-popover-action"
      : "remote-control-popover-action primary";
    arm.textContent = armed ? "Turn off" : "Turn on";
    arm.addEventListener("click", () => {
      actions.toggleRemoteControlArm(armCtx.mode);
    });
    popover.append(arm);
    return popover;
  }

  const rc = activeTaskView(state)?.remoteControl ?? { active: false, url: null };
  popover.append(remoteControlPopoverHeader(rc.active ? "On" : "Off", rc.active));

  const desc = document.createElement("p");
  desc.className = "remote-control-popover-desc";

  if (!rc.active) {
    desc.textContent = "See and steer this session from the Claude app on your phone.";
    popover.append(desc);
    const turnOn = document.createElement("button");
    turnOn.type = "button";
    turnOn.className = "remote-control-popover-action primary";
    turnOn.textContent = "Turn on";
    turnOn.addEventListener("click", () => actions.enableRemoteControl());
    popover.append(turnOn);
    if (state.remoteControlNote) {
      const note = document.createElement("p");
      note.className = "remote-control-popover-note";
      note.textContent = state.remoteControlNote;
      popover.append(note);
    }
    return popover;
  }

  desc.textContent = "Open Claude on your phone, or use the link below.";
  popover.append(desc);

  if (rc.url) {
    const urlRow = document.createElement("div");
    urlRow.className = "remote-control-popover-url-row";
    const urlText = document.createElement("span");
    urlText.className = "remote-control-popover-url";
    urlText.textContent = rc.url;
    urlText.title = rc.url;
    const copy = document.createElement("button");
    copy.type = "button";
    copy.className = "remote-control-popover-copy";
    copy.title = "Copy link";
    copy.append(lucideIcon(Copy, 14));
    copy.addEventListener("click", () => {
      const url = rc.url;
      if (!url) {
        return;
      }
      void navigator.clipboard.writeText(url).catch(() => {});
      copy.classList.add("copied");
      window.setTimeout(() => copy.classList.remove("copied"), 1200);
    });
    urlRow.append(urlText, copy);
    popover.append(urlRow);
  } else {
    const connecting = document.createElement("p");
    connecting.className = "remote-control-popover-desc";
    connecting.textContent = "Connecting…";
    popover.append(connecting);
  }

  const manage = document.createElement("button");
  manage.type = "button";
  manage.className = "remote-control-popover-action";
  manage.textContent = "Manage / disconnect in CLI →";
  manage.addEventListener("click", () => actions.manageRemoteControl());
  popover.append(manage);
  return popover;
}

function renderReadingThemeSection(): HTMLElement {
  const grid = document.createElement("div");
  grid.className = "reading-theme-grid";
  for (const theme of READING_THEME_IDS) {
    grid.append(renderReadingThemeCard(theme));
  }
  return readingSettingSection("Theme", grid);
}

function renderReadingThemeCard(theme: ReadingThemeId): HTMLElement {
  const selected = state.readingSettings.theme === theme;
  const button = document.createElement("button");
  button.className = "reading-theme-card";
  button.classList.toggle("selected", selected);
  button.type = "button";
  button.dataset.theme = theme;
  button.dataset.mode = resolvedReadingMode();
  button.setAttribute("aria-label", `${readingThemeLabel(theme)} theme`);
  button.setAttribute("aria-pressed", String(selected));
  button.addEventListener("click", () => {
    actions.persistReadingSettings({
      ...state.readingSettings,
      theme,
    });
  });

  const name = document.createElement("span");
  name.className = "reading-theme-name";
  name.textContent = readingThemeLabel(theme);

  const sample = document.createElement("span");
  sample.className = "reading-theme-sample";
  sample.textContent = "Aa";

  const lines = document.createElement("span");
  lines.className = "reading-theme-lines";
  lines.append(document.createElement("i"), document.createElement("i"));

  const current = document.createElement("span");
  current.className = "reading-theme-current";
  current.textContent = selected ? "current" : "";

  button.append(name, sample, lines, current);
  return button;
}

function renderReadingModeSection(): HTMLElement {
  const group = document.createElement("div");
  group.className = "reading-segmented";
  group.setAttribute("role", "radiogroup");
  group.setAttribute("aria-label", "Mode");

  for (const mode of READING_MODE_IDS) {
    const selected = state.readingSettings.mode === mode;
    const button = document.createElement("button");
    button.className = "reading-segment";
    button.classList.toggle("selected", selected);
    button.type = "button";
    button.setAttribute("role", "radio");
    button.setAttribute("aria-checked", String(selected));
    button.textContent = readingModeLabel(mode);
    button.addEventListener("click", () => {
      actions.persistReadingSettings({
        ...state.readingSettings,
        mode,
      });
    });
    group.append(button);
  }

  return readingSettingSection("Mode", group);
}

function renderReadingSizeSection(): HTMLElement {
  const stepper = document.createElement("div");
  stepper.className = "reading-size-stepper";
  const currentIndex = READING_TEXT_STEPS.indexOf(state.readingSettings.textStep);
  const previous = currentIndex > 0 ? READING_TEXT_STEPS[currentIndex - 1] : undefined;
  const next = currentIndex >= 0 && currentIndex < READING_TEXT_STEPS.length - 1
    ? READING_TEXT_STEPS[currentIndex + 1]
    : undefined;

  const decrease = document.createElement("button");
  decrease.className = "reading-size-button";
  decrease.type = "button";
  decrease.disabled = previous === undefined;
  decrease.setAttribute("aria-label", "Decrease text size");
  decrease.textContent = "A-";
  decrease.addEventListener("click", () => {
    if (isReadingTextStep(previous)) {
      actions.persistReadingSettings({
        ...state.readingSettings,
        textStep: previous,
      });
    }
  });

  const value = document.createElement("strong");
  value.className = "reading-size-value";
  value.textContent = String(state.readingSettings.textStep);

  const increase = document.createElement("button");
  increase.className = "reading-size-button";
  increase.type = "button";
  increase.disabled = next === undefined;
  increase.setAttribute("aria-label", "Increase text size");
  increase.textContent = "A+";
  increase.addEventListener("click", () => {
    if (isReadingTextStep(next)) {
      actions.persistReadingSettings({
        ...state.readingSettings,
        textStep: next,
      });
    }
  });

  stepper.append(decrease, value, increase);
  return readingSettingSection("Size", stepper);
}

function readingSettingSection(label: string, content: HTMLElement): HTMLElement {
  const section = document.createElement("section");
  section.className = "reading-setting-section";
  const heading = document.createElement("p");
  heading.className = "reading-setting-heading";
  heading.textContent = label;
  section.append(heading, content);
  return section;
}
