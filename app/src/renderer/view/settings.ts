// The Settings page — a centered overlay (map §3.1 renderer/view/settings.ts,
// D3 — moved verbatim from main.ts). The review door for moment-born policy:
// two doors, one state — the resume chooser writes the same store this page
// revises. Instant-apply, no OK. The keepFocus choreography (R5) moves
// untouched. State reads via the init-bound atom reference; the persist
// flows (permission mode, resume policy, RC default, bridge restore) and the
// open/close transitions stay shell-side behind the actions seam; the popup
// menu open/close bare assignments are grammar → actions (C3 ruling).

import { Check, ChevronDown, X } from "lucide";
import {
  CLAUDE_DEFAULT_PERMISSION_MODE_OPTIONS,
  CODEX_DEFAULT_APPROVAL_MODE_OPTIONS,
  isCodexDefaultApprovalMode,
  RESUME_POLICY_IDS,
  RESUME_PROMPT_MIN_IDLE_MS,
  RESUME_PROMPT_MIN_TOKENS,
  type CodexApprovalMode,
} from "../../shared/types";
import {
  codexApprovalModeLabel,
  formatTokenCount,
  permissionModeLabel,
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
  dialog.setAttribute("aria-label", "Duet Settings");
  dialog.tabIndex = -1;
  dialog.addEventListener("mousedown", (event) => {
    const outsidePopup =
      event.target instanceof Element && !event.target.closest(".settings-popup-wrap");
    if (
      outsidePopup &&
      (overlay.policyMenuOpen || overlay.approvalMenuOpen || overlay.codexApprovalMenuOpen)
    ) {
      actions.closeSettingsPopupMenus(overlay);
    }
  });

  dialog.append(
    renderSettingsHeader(),
    renderApprovalsSettingsGroup(overlay),
    renderCodexSettingsGroup(overlay),
    renderRemoteControlSettingsGroup(overlay),
    renderSessionsSettingsGroup(overlay),
    renderClaudeSettingsGroup(overlay),
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

function renderApprovalsSettingsGroup(overlay: SettingsOverlayState): HTMLElement {
  const group = document.createElement("section");
  group.className = "settings-group";
  group.setAttribute("aria-label", "Approvals");

  const heading = document.createElement("p");
  heading.className = "settings-group-heading";
  heading.textContent = "Approvals";

  const box = document.createElement("div");
  box.className = "settings-box";

  const row = document.createElement("div");
  row.className = "settings-row";
  const copy = document.createElement("div");
  copy.className = "settings-row-copy";
  const title = document.createElement("span");
  title.className = "settings-row-title";
  title.textContent = "New Claude sessions start in";
  copy.append(title);
  row.append(copy, renderDefaultPermissionModePopup(overlay));
  box.append(row);

  const footnote = document.createElement("p");
  footnote.className = "settings-footnote";
  footnote.textContent =
    "Mirrors Claude's Shift+Tab modes. Auto approves every step through Claude's own safety classifier — far fewer prompts, with a guardrail. You can pick a different mode for any single task from the New task access chip.";

  group.append(heading, box, footnote);
  return group;
}

function renderRemoteControlSettingsGroup(overlay: SettingsOverlayState): HTMLElement {
  const group = document.createElement("section");
  group.className = "settings-group";
  group.setAttribute("aria-label", "Remote control");

  const heading = document.createElement("p");
  heading.className = "settings-group-heading";
  heading.textContent = "Remote control";

  const box = document.createElement("div");
  box.className = "settings-box";
  const row = document.createElement("div");
  row.className = "settings-row";

  const copy = document.createElement("div");
  copy.className = "settings-row-copy";
  const title = document.createElement("span");
  title.className = "settings-row-title";
  title.textContent = "Auto-enable Remote Control";
  copy.append(title);
  row.append(copy);

  const on = overlay.claude?.settings.defaultRemoteControl ?? false;
  const toggle = document.createElement("button");
  toggle.type = "button";
  toggle.className = "settings-toggle";
  toggle.classList.toggle("on", on);
  toggle.setAttribute("role", "switch");
  toggle.setAttribute("aria-checked", String(on));
  toggle.disabled = !overlay.claude;
  toggle.textContent = on ? "On" : "Off";
  toggle.addEventListener("click", () => {
    actions.setDefaultRemoteControl(!on);
  });
  const trailing = document.createElement("div");
  trailing.className = "settings-row-trailing";
  trailing.append(toggle);
  row.append(trailing);

  box.append(row);

  const footnote = document.createElement("p");
  footnote.className = "settings-footnote";
  footnote.textContent =
    "New and resumed Claude sessions come up reachable from the Claude app on your phone. You can still turn it off for any single session.";

  group.append(heading, box, footnote);
  return group;
}

function renderDefaultPermissionModePopup(overlay: SettingsOverlayState): HTMLElement {
  const wrap = document.createElement("div");
  wrap.className = "settings-popup-wrap";

  const button = document.createElement("button");
  button.className = "settings-popup";
  button.type = "button";
  button.setAttribute("aria-haspopup", "menu");
  button.setAttribute("aria-expanded", String(overlay.approvalMenuOpen));
  button.disabled = !overlay.claude;
  const label = document.createElement("span");
  label.textContent = overlay.claude
    ? permissionModeLabel(overlay.claude.settings.defaultPermissionMode)
    : "Loading…";
  button.append(label, lucideIcon(ChevronDown, 14));
  button.addEventListener("click", () => {
    actions.toggleSettingsApprovalMenu(overlay);
  });
  wrap.append(button);

  if (overlay.approvalMenuOpen && overlay.claude) {
    const menu = document.createElement("div");
    menu.className = "settings-popup-menu";
    menu.setAttribute("role", "menu");
    for (const mode of CLAUDE_DEFAULT_PERMISSION_MODE_OPTIONS) {
      const selected = overlay.claude.settings.defaultPermissionMode === mode;
      const option = document.createElement("button");
      option.className = "settings-popup-option";
      option.classList.toggle("selected", selected);
      option.type = "button";
      option.setAttribute("role", "menuitemradio");
      option.setAttribute("aria-checked", String(selected));
      const check = document.createElement("span");
      check.className = "settings-popup-option-check";
      if (selected) {
        check.append(lucideIcon(Check, 13));
      }
      const optionLabel = document.createElement("span");
      optionLabel.className = "settings-popup-option-label";
      optionLabel.textContent = permissionModeLabel(mode);
      option.append(check, optionLabel);
      option.addEventListener("click", () => {
        actions.persistDefaultPermissionMode(mode);
      });
      menu.append(option);
    }
    wrap.append(menu);
  }

  return wrap;
}

function renderCodexSettingsGroup(overlay: SettingsOverlayState): HTMLElement {
  const group = document.createElement("section");
  group.className = "settings-group";
  group.setAttribute("aria-label", "Codex");

  const heading = document.createElement("p");
  heading.className = "settings-group-heading";
  heading.textContent = "Codex";

  const box = document.createElement("div");
  box.className = "settings-box";

  const row = document.createElement("div");
  row.className = "settings-row";
  const copy = document.createElement("div");
  copy.className = "settings-row-copy";
  const title = document.createElement("span");
  title.className = "settings-row-title";
  title.textContent = "New Codex sessions start in";
  copy.append(title);
  row.append(copy, renderDefaultApprovalModePopup(overlay));
  box.append(row);

  const footnote = document.createElement("p");
  footnote.className = "settings-footnote";
  footnote.textContent =
    "The default approval policy for new Codex sessions. Ask for everything prompts before almost every command; Approve for me runs everything in the sandbox without asking.";

  group.append(heading, box, footnote);
  return group;
}

/** The Codex approval label, suffixed "(legacy)" when the value has fallen out
 *  of the offered pool (a deprecated `on-failure` default). Shared by the
 *  collapsed button and the menu so the deprecation shows at a glance. */
function codexApprovalMenuLabel(mode: CodexApprovalMode): string {
  return isCodexDefaultApprovalMode(mode)
    ? codexApprovalModeLabel(mode)
    : `${codexApprovalModeLabel(mode)} (legacy)`;
}

function renderDefaultApprovalModePopup(overlay: SettingsOverlayState): HTMLElement {
  const wrap = document.createElement("div");
  wrap.className = "settings-popup-wrap";

  const button = document.createElement("button");
  button.className = "settings-popup";
  button.type = "button";
  button.setAttribute("aria-haspopup", "menu");
  button.setAttribute("aria-expanded", String(overlay.codexApprovalMenuOpen));
  button.disabled = !overlay.codex;
  const label = document.createElement("span");
  label.textContent = overlay.codex
    ? codexApprovalMenuLabel(overlay.codex.settings.defaultApprovalMode)
    : "Loading…";
  button.append(label, lucideIcon(ChevronDown, 14));
  button.addEventListener("click", () => {
    actions.toggleSettingsCodexApprovalMenu(overlay);
  });
  wrap.append(button);

  if (overlay.codexApprovalMenuOpen && overlay.codex) {
    const menu = document.createElement("div");
    menu.className = "settings-popup-menu";
    menu.setAttribute("role", "menu");
    // Offer the standing pool, plus the stored value itself when it has fallen
    // out of the pool (a deprecated `on-failure` default) — marked "(legacy)"
    // so the user sees where they are and can switch off it.
    const stored = overlay.codex.settings.defaultApprovalMode;
    const modes: CodexApprovalMode[] = isCodexDefaultApprovalMode(stored)
      ? [...CODEX_DEFAULT_APPROVAL_MODE_OPTIONS]
      : [stored, ...CODEX_DEFAULT_APPROVAL_MODE_OPTIONS];
    for (const mode of modes) {
      const selected = stored === mode;
      const option = document.createElement("button");
      option.className = "settings-popup-option";
      option.classList.toggle("selected", selected);
      option.type = "button";
      option.setAttribute("role", "menuitemradio");
      option.setAttribute("aria-checked", String(selected));
      const check = document.createElement("span");
      check.className = "settings-popup-option-check";
      if (selected) {
        check.append(lucideIcon(Check, 13));
      }
      const optionLabel = document.createElement("span");
      optionLabel.className = "settings-popup-option-label";
      optionLabel.textContent = codexApprovalMenuLabel(mode);
      option.append(check, optionLabel);
      option.addEventListener("click", () => {
        actions.persistDefaultApprovalMode(mode);
      });
      menu.append(option);
    }
    wrap.append(menu);
  }

  return wrap;
}

function renderSessionsSettingsGroup(overlay: SettingsOverlayState): HTMLElement {
  const group = document.createElement("section");
  group.className = "settings-group";
  group.setAttribute("aria-label", "Sessions");

  const heading = document.createElement("p");
  heading.className = "settings-group-heading";
  heading.textContent = "Sessions";

  const box = document.createElement("div");
  box.className = "settings-box";

  const row = document.createElement("div");
  row.className = "settings-row";

  const copy = document.createElement("div");
  copy.className = "settings-row-copy";
  const title = document.createElement("span");
  title.className = "settings-row-title";
  title.textContent = "Resuming a large dormant session";
  copy.append(title);

  // Apple's provenance grammar (Login Items "Added by …"): state on the
  // row, one quiet line of attribution — only while the value is
  // moment-born. Reading settings never carry this; they have no moment.
  const provenance = overlay.resume?.settings.provenance;
  if (provenance?.source === "moment") {
    const note = document.createElement("span");
    note.className = "settings-row-note";
    note.textContent = `Set from the resume chooser · ${settingsDateLabel(provenance.at)}`;
    copy.append(note);
  }

  row.append(copy, renderResumePolicyPopup(overlay));
  box.append(row);

  const footnote = document.createElement("p");
  footnote.className = "settings-footnote";
  footnote.textContent = `Applies when a Claude session has been idle for over ${Math.round(
    RESUME_PROMPT_MIN_IDLE_MS / 60_000,
  )} minutes and holds about ${formatTokenCount(RESUME_PROMPT_MIN_TOKENS)} tokens or more.`;

  group.append(heading, box, footnote);
  return group;
}

function renderResumePolicyPopup(overlay: SettingsOverlayState): HTMLElement {
  const wrap = document.createElement("div");
  wrap.className = "settings-popup-wrap";

  const button = document.createElement("button");
  button.className = "settings-popup";
  button.type = "button";
  button.setAttribute("aria-haspopup", "menu");
  button.setAttribute("aria-expanded", String(overlay.policyMenuOpen));
  button.disabled = !overlay.resume;
  const label = document.createElement("span");
  label.textContent = overlay.resume
    ? resumePolicyLabel(overlay.resume.settings.policy)
    : "Loading…";
  button.append(label, lucideIcon(ChevronDown, 14));
  button.addEventListener("click", () => {
    actions.toggleSettingsPolicyMenu(overlay);
  });
  wrap.append(button);

  if (overlay.policyMenuOpen && overlay.resume) {
    const menu = document.createElement("div");
    menu.className = "settings-popup-menu";
    menu.setAttribute("role", "menu");
    for (const policy of RESUME_POLICY_IDS) {
      const selected = overlay.resume.settings.policy === policy;
      const option = document.createElement("button");
      option.className = "settings-popup-option";
      option.classList.toggle("selected", selected);
      option.type = "button";
      option.setAttribute("role", "menuitemradio");
      option.setAttribute("aria-checked", String(selected));
      const check = document.createElement("span");
      check.className = "settings-popup-option-check";
      if (selected) {
        check.append(lucideIcon(Check, 13));
      }
      const optionLabel = document.createElement("span");
      optionLabel.className = "settings-popup-option-label";
      optionLabel.textContent = resumePolicyLabel(policy);
      option.append(check, optionLabel);
      option.addEventListener("click", () => {
        actions.persistResumePolicy(policy);
      });
      menu.append(option);
    }
    wrap.append(menu);
  }

  return wrap;
}

function renderClaudeSettingsGroup(overlay: SettingsOverlayState): HTMLElement {
  const group = document.createElement("section");
  group.className = "settings-group";
  group.setAttribute("aria-label", "Claude");

  const heading = document.createElement("p");
  heading.className = "settings-group-heading";
  heading.textContent = "Claude";

  // The territory declaration: provider passthrough is an IA axis, worn
  // visibly but quietly — Duet renders Claude's state, never owns it.
  const territory = document.createElement("p");
  territory.className = "settings-territory-note";
  territory.textContent =
    "Claude Code's own state. Duet shows it here and never changes it without you.";

  const box = document.createElement("div");
  box.className = "settings-box";
  const row = document.createElement("div");
  row.className = "settings-row";

  const copy = document.createElement("div");
  copy.className = "settings-row-copy";
  const title = document.createElement("span");
  title.className = "settings-row-title";
  title.textContent = "Claude's own resume warning";
  copy.append(title);

  const resume = overlay.resume;
  if (overlay.bridgeError) {
    const note = document.createElement("span");
    note.className = "settings-row-note settings-row-note-error";
    note.textContent = "Couldn't update ~/.claude.json — check it manually.";
    copy.append(note);
  } else if (resume?.bridgeDismissed) {
    const note = document.createElement("span");
    note.className = "settings-row-note";
    note.textContent =
      "Turned off by Duet's earlier bridge. Restoring affects terminals outside Duet.";
    copy.append(note);
  }
  row.append(copy);

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
  row.append(trailing);

  box.append(row);
  group.append(heading, territory, box);
  return group;
}
