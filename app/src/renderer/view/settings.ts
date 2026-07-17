// The Settings page — a centered overlay (map §3.1 renderer/view/settings.ts,
// D3 — moved verbatim from main.ts). The review door for moment-born policy:
// two doors, one state — the resume chooser writes the same store this page
// revises. Instant-apply, no OK. The keepFocus choreography (R5) moves
// untouched. State reads via the init-bound atom reference; the persist
// flows (permission mode, resume policy, RC default, bridge restore) and the
// open/close transitions stay shell-side behind the actions seam; the popup
// menu open/close bare assignments are grammar → actions (C3 ruling).
//
// IA (2026-07-16 redesign): concept-first groups — Permissions (Claude /
// Codex sessions), Remote control, Sessions, Claude Code. Rows carry an
// inline secondary-color description (the retired footnote walls moved into
// the row and into per-option picker copy). Three literal-clone popups are
// one parameterized picker; the Remote Control toggle is a real switch.

import { Check, ChevronDown, X } from "lucide";
import {
  CLAUDE_DEFAULT_PERMISSION_MODE_OPTIONS,
  CODEX_PERMISSION_MODE_OPTIONS,
  RESUME_POLICY_IDS,
  RESUME_PROMPT_MIN_IDLE_MS,
  RESUME_PROMPT_MIN_TOKENS,
} from "../../shared/types";
import {
  codexPermissionModeDescription,
  codexPermissionModeLabel,
  compactTokenCount,
  permissionModeDescription,
  permissionModeLabel,
  resumePolicyDescription,
  resumePolicyLabel,
  settingsDateLabel,
} from "../../reading-core/selectors/formatters";
import type {
  RendererState,
  SettingsOverlayState,
} from "../../reading-core/state";
import { elements } from "../dom";
import { lucideIcon } from "./icons";
import { actions } from "../actions";

/** The shell's state atom, bound once at boot for the overlay's read paths. */
let state: RendererState;

export function initSettingsView(stateRef: RendererState): void {
  state = stateRef;
}

export function renderSettingsOverlay(): void {
  const overlay = state.settingsOverlay;
  const active = document.activeElement;
  const keepFocus =
    overlay !== null &&
    (active === document.body || elements.settingsOverlayRoot.contains(active));
  elements.settingsOverlayRoot.replaceChildren();
  if (!overlay) {
    return;
  }

  const scrim = document.createElement("div");
  scrim.className = "settings-overlay";
  scrim.addEventListener("mousedown", (event) => {
    if (event.target === scrim) {
      actions.closeSettingsOverlay();
    }
  });

  const dialog = document.createElement("div");
  dialog.className = "settings-window";
  dialog.setAttribute("role", "dialog");
  dialog.setAttribute("aria-modal", "true");
  dialog.setAttribute("aria-label", "Sonata Settings");
  dialog.tabIndex = -1;
  dialog.addEventListener("mousedown", (event) => {
    const outsidePopup =
      event.target instanceof Element && !event.target.closest(".settings-popup-wrap");
    if (
      outsidePopup &&
      (overlay.policyMenuOpen || overlay.approvalMenuOpen || overlay.codexPermissionMenuOpen)
    ) {
      actions.closeSettingsPopupMenus(overlay);
    }
  });

  dialog.append(
    renderSettingsHeader(),
    renderPermissionsSettingsGroup(overlay),
    renderRemoteControlSettingsGroup(overlay),
    renderSessionsSettingsGroup(overlay),
    renderClaudeCodeSettingsGroup(overlay),
  );
  scrim.append(dialog);
  elements.settingsOverlayRoot.append(scrim);
  if (keepFocus) {
    dialog.focus();
  }
}

function renderSettingsHeader(): HTMLElement {
  const header = document.createElement("header");
  header.className = "settings-header";

  const title = document.createElement("h2");
  title.className = "settings-title";
  title.textContent = "Settings";

  const close = document.createElement("button");
  close.className = "settings-close";
  close.type = "button";
  close.setAttribute("aria-label", "Close settings");
  close.append(lucideIcon(X));
  close.addEventListener("click", () => {
    actions.closeSettingsOverlay();
  });

  header.append(title, close);
  return header;
}

// ── Shared anatomy ────────────────────────────────────────────────────────

interface SettingsGroupSpec {
  /** Both the section aria-label and the visible heading. */
  label: string;
  /** Optional group-level description under the heading (e.g. the Claude Code
   *  passthrough territory line). */
  description?: string;
  rows: HTMLElement[];
}

/** A titled section with a bordered box of rows. Groups are the IA's concept
 *  units; rows are the individual settings within a concept. */
function renderSettingsGroup(spec: SettingsGroupSpec): HTMLElement {
  const group = document.createElement("section");
  group.className = "settings-group";
  group.setAttribute("aria-label", spec.label);

  const heading = document.createElement("p");
  heading.className = "settings-group-heading";
  heading.textContent = spec.label;
  group.append(heading);

  if (spec.description) {
    const description = document.createElement("p");
    description.className = "settings-group-desc";
    description.textContent = spec.description;
    group.append(description);
  }

  const box = document.createElement("div");
  box.className = "settings-box";
  box.append(...spec.rows);
  group.append(box);

  return group;
}

interface SettingsRowSpec {
  title: string;
  /** Secondary-color line under the title — the settle explanation for this
   *  row (replaces the retired outside-the-box footnote). */
  description?: string;
  /** Extra conditional lines under the description (provenance / bridge notes),
   *  already built by the caller. */
  notes?: HTMLElement[];
  /** Trailing control (picker, switch, or value+action cluster). */
  control: HTMLElement;
}

/** One row = a copy column (title + description + notes) and a trailing
 *  control. Multi-row boxes get hairline separators via `.settings-row +
 *  .settings-row` in CSS. */
function renderSettingsRow(spec: SettingsRowSpec): HTMLElement {
  const row = document.createElement("div");
  row.className = "settings-row";

  const copy = document.createElement("div");
  copy.className = "settings-row-copy";

  const title = document.createElement("span");
  title.className = "settings-row-title";
  title.textContent = spec.title;
  copy.append(title);

  if (spec.description) {
    const description = document.createElement("span");
    description.className = "settings-row-desc";
    description.textContent = spec.description;
    copy.append(description);
  }

  if (spec.notes) {
    copy.append(...spec.notes);
  }

  row.append(copy, spec.control);
  return row;
}

interface PickerOption<T extends string> {
  id: T;
  label: string;
  description: string;
}

interface PickerSpec<T extends string> {
  options: ReadonlyArray<PickerOption<T>>;
  /** The stored selection, or null while the backing settings are still
   *  loading (the button reads "Loading…" and the menu can't open). */
  selectedId: T | null;
  open: boolean;
  onToggle: () => void;
  onPick: (id: T) => void;
}

/** One parameterized picker replaces the three literal-clone popups
 *  (approval / codex / resume policy). Menu options carry a one-line
 *  description; the check-glyph selected treatment and menu a11y roles are
 *  unchanged. */
function renderPicker<T extends string>(spec: PickerSpec<T>): HTMLElement {
  const wrap = document.createElement("div");
  wrap.className = "settings-popup-wrap";

  const selected = spec.selectedId
    ? spec.options.find((option) => option.id === spec.selectedId) ?? null
    : null;

  const button = document.createElement("button");
  button.className = "settings-popup";
  button.type = "button";
  button.setAttribute("aria-haspopup", "menu");
  button.setAttribute("aria-expanded", String(spec.open));
  button.disabled = spec.selectedId === null;
  const label = document.createElement("span");
  label.textContent = selected ? selected.label : "Loading…";
  button.append(label, lucideIcon(ChevronDown, 14));
  button.addEventListener("click", spec.onToggle);
  wrap.append(button);

  if (spec.open && spec.selectedId !== null) {
    const menu = document.createElement("div");
    menu.className = "settings-popup-menu";
    menu.setAttribute("role", "menu");
    for (const option of spec.options) {
      const isSelected = option.id === spec.selectedId;
      const item = document.createElement("button");
      item.className = "settings-popup-option";
      item.classList.toggle("selected", isSelected);
      item.type = "button";
      item.setAttribute("role", "menuitemradio");
      item.setAttribute("aria-checked", String(isSelected));

      const check = document.createElement("span");
      check.className = "settings-popup-option-check";
      if (isSelected) {
        check.append(lucideIcon(Check, 13));
      }

      const text = document.createElement("span");
      text.className = "settings-popup-option-text";
      const optionLabel = document.createElement("span");
      optionLabel.className = "settings-popup-option-label";
      optionLabel.textContent = option.label;
      const optionDesc = document.createElement("span");
      optionDesc.className = "settings-popup-option-desc";
      optionDesc.textContent = option.description;
      text.append(optionLabel, optionDesc);

      item.append(check, text);
      item.addEventListener("click", () => {
        spec.onPick(option.id);
      });
      menu.append(item);
    }
    wrap.append(menu);
    flipPickerMenuIfClipped(menu);
  }

  return wrap;
}

/** The dialog is a scrollport (`overflow-y:auto`), so a downward-opening menu
 *  near the bottom (the Sessions row) clips: its tail lands outside the visible
 *  rect and the whole dialog has to scroll. After mount, measure the space
 *  below the anchor inside the dialog; if the menu doesn't fit and there's more
 *  room above, flip it upward. Mirrors the sidebar-menu flip pattern. */
function flipPickerMenuIfClipped(menu: HTMLElement): void {
  window.requestAnimationFrame(() => {
    if (!menu.isConnected) {
      return;
    }
    const dialog = menu.closest(".settings-window");
    const wrap = menu.closest(".settings-popup-wrap");
    if (!dialog || !wrap) {
      return;
    }
    const dialogRect = dialog.getBoundingClientRect();
    const anchorRect = wrap.getBoundingClientRect();
    const gap = 8;
    const spaceBelow = dialogRect.bottom - anchorRect.bottom - gap;
    const spaceAbove = anchorRect.top - dialogRect.top - gap;
    const menuHeight = menu.getBoundingClientRect().height;
    menu.classList.toggle(
      "settings-popup-menu--above",
      menuHeight > spaceBelow && spaceAbove > spaceBelow,
    );
  });
}

/** A real on/off switch (role="switch"): state carried by form, never text.
 *  On-fill is neutral dark ink, NOT signal blue — "chroma = deviation from
 *  calm"; a launch default is not an alert. The control is textless, so it
 *  carries its own `aria-label` — the row title is a DOM sibling and never
 *  enters accessible-name computation. */
function renderSwitch(spec: {
  label: string;
  on: boolean;
  disabled: boolean;
  onToggle: () => void;
}): HTMLButtonElement {
  const button = document.createElement("button");
  button.className = "settings-switch";
  button.classList.toggle("on", spec.on);
  button.type = "button";
  button.setAttribute("role", "switch");
  button.setAttribute("aria-label", spec.label);
  button.setAttribute("aria-checked", String(spec.on));
  button.disabled = spec.disabled;
  const thumb = document.createElement("span");
  thumb.className = "settings-switch-thumb";
  button.append(thumb);
  button.addEventListener("click", spec.onToggle);
  return button;
}

// ── Groups ────────────────────────────────────────────────────────────────

function renderPermissionsSettingsGroup(overlay: SettingsOverlayState): HTMLElement {
  const claudeStored = overlay.claude?.settings.defaultPermissionMode ?? null;
  const claudeRow = renderSettingsRow({
    title: "Claude sessions",
    description: "How new Claude sessions handle approvals — same modes as Claude's Shift+Tab.",
    control: renderPicker({
      options: CLAUDE_DEFAULT_PERMISSION_MODE_OPTIONS.map((mode) => ({
        id: mode,
        label: permissionModeLabel(mode),
        description: permissionModeDescription(mode),
      })),
      selectedId: claudeStored,
      open: overlay.approvalMenuOpen,
      onToggle: () => actions.toggleSettingsApprovalMenu(overlay),
      onPick: (mode) => actions.persistDefaultPermissionMode(mode),
    }),
  });

  const codexStored = overlay.codex?.settings.defaultPermissionMode ?? null;
  const codexRow = renderSettingsRow({
    title: "Codex sessions",
    description: "How new Codex sessions handle approvals.",
    control: renderPicker({
      options: CODEX_PERMISSION_MODE_OPTIONS.map((mode) => ({
        id: mode,
        label: codexPermissionModeLabel(mode),
        description: codexPermissionModeDescription(mode),
      })),
      selectedId: codexStored,
      open: overlay.codexPermissionMenuOpen,
      onToggle: () => actions.toggleSettingsCodexPermissionMenu(overlay),
      onPick: (mode) => actions.persistCodexDefaultPermissionMode(mode),
    }),
  });

  return renderSettingsGroup({ label: "Permissions", rows: [claudeRow, codexRow] });
}

function renderRemoteControlSettingsGroup(overlay: SettingsOverlayState): HTMLElement {
  const on = overlay.claude?.settings.defaultRemoteControl ?? false;
  const row = renderSettingsRow({
    title: "Remote Control",
    description:
      "New and resumed Claude sessions can be reached from the Claude app on your phone.",
    control: renderSwitch({
      label: "Remote Control",
      on,
      disabled: !overlay.claude,
      onToggle: () => actions.setDefaultRemoteControl(!on),
    }),
  });

  return renderSettingsGroup({ label: "Remote control", rows: [row] });
}

function renderSessionsSettingsGroup(overlay: SettingsOverlayState): HTMLElement {
  // Apple's provenance grammar (Login Items "Added by …"): state on the row,
  // one quiet line of attribution — only while the value is moment-born.
  // Reading settings never carry this; they have no moment.
  const notes: HTMLElement[] = [];
  const provenance = overlay.resume?.settings.provenance;
  if (provenance?.source === "moment") {
    const note = document.createElement("span");
    note.className = "settings-row-note";
    note.textContent = `Set from the resume chooser · ${settingsDateLabel(provenance.at)}`;
    notes.push(note);
  }

  const row = renderSettingsRow({
    title: "Resuming a large session",
    // The 70-minute / 100k-token thresholds define WHEN the policy applies;
    // numbers stay computed from the shared constants, never hardcoded. Uses
    // compactTokenCount (whole-thousand "100k") not formatTokenCount (which
    // would print machine-ish "100.0k") — the copy says "about", so a rounded
    // figure is the honest register.
    description: `When a Claude session sits idle for over ${Math.round(
      RESUME_PROMPT_MIN_IDLE_MS / 60_000,
    )} minutes holding about ${compactTokenCount(RESUME_PROMPT_MIN_TOKENS)} tokens or more.`,
    notes,
    control: renderPicker({
      options: RESUME_POLICY_IDS.map((policy) => ({
        id: policy,
        label: resumePolicyLabel(policy),
        description: resumePolicyDescription(policy),
      })),
      selectedId: overlay.resume?.settings.policy ?? null,
      open: overlay.policyMenuOpen,
      onToggle: () => actions.toggleSettingsPolicyMenu(overlay),
      onPick: (policy) => actions.persistResumePolicy(policy),
    }),
  });

  return renderSettingsGroup({ label: "Sessions", rows: [row] });
}

function renderClaudeCodeSettingsGroup(overlay: SettingsOverlayState): HTMLElement {
  const resume = overlay.resume;

  const notes: HTMLElement[] = [];
  if (overlay.bridgeError) {
    const note = document.createElement("span");
    note.className = "settings-row-note settings-row-note-error";
    note.textContent = "Couldn't update ~/.claude.json — check it manually.";
    notes.push(note);
  } else if (resume?.bridgeDismissed) {
    const note = document.createElement("span");
    note.className = "settings-row-note";
    note.textContent =
      "Turned off by Sonata's earlier bridge. Restoring affects terminals outside Sonata.";
    notes.push(note);
  }

  const trailing = document.createElement("div");
  trailing.className = "settings-row-trailing";
  const value = document.createElement("span");
  value.className = "settings-value";
  value.textContent = !resume ? "—" : resume.bridgeDismissed ? "Off" : "On";
  trailing.append(value);
  if (resume?.bridgeDismissed) {
    const restore = document.createElement("button");
    restore.className = "secondary settings-restore";
    restore.type = "button";
    restore.disabled = overlay.bridgeReverting;
    restore.textContent = overlay.bridgeReverting ? "Restoring…" : "Restore";
    restore.addEventListener("click", () => {
      actions.restoreResumeBridge();
    });
    trailing.append(restore);
  }

  const row = renderSettingsRow({
    title: "Resume warning",
    notes,
    control: trailing,
  });

  // The territory declaration: provider passthrough is an IA axis, worn
  // visibly but quietly — Sonata renders Claude's state, never owns it. It rides
  // as the group's description line.
  return renderSettingsGroup({
    label: "Claude Code",
    description: "Claude Code's own state. Sonata never changes it without you.",
    rows: [row],
  });
}
