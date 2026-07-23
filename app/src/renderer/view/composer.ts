// The composer's control surfaces (map §3.1 renderer/view/composer.ts, D3 —
// moved verbatim from main.ts): the attachment chip strip, the control row
// (send/stop, chips, usage ring), and the composer popover root (slash
// picker portal, Add menu, usage popover) with its live-geometry
// positioners. State reads via the init-bound atom reference; ports and
// flows (attachment removal with its object-URL revoke, the reference
// picker, the T5/T6 usage-popover hover timers, slash rendering — a sibling
// view family) stay shell-side behind the actions seam; main.ts composes
// slash-picker into this popover root (the renderTaskEntryPanel precedent).

import { ChevronDown, File as FileIcon, Folder, Image as ImageIcon, X } from "lucide";
import type {
  AttachmentKind,
  ClaudePermissionMode,
  CodexPermissionMode,
  RuntimeProvider,
  Task,
  UsageSnapshot,
} from "../../shared/types";
import { CODEX_PERMISSION_MODE_OPTIONS } from "../../shared/types";
import {
  MODEL_OPTIONS,
  REASONING_OPTIONS,
  USAGE_CONTEXT_HIGH_USED_PERCENT,
  modelValueLabel,
  reasoningValueLabel,
} from "../../reading-core/config";
import { turnActivity } from "../../reading-core/selectors/runs";
import { renderSettingSection } from "./settings-section";
import {
  compactTokenCount,
  fileExtension,
  codexPermissionModeLabel,
  folderName,
  formatRelativeUsageTime,
  formatUsagePercent,
  permissionModeLabel,
  providerLabel,
  usageLimitDisplayLabel,
} from "../../reading-core/selectors/formatters";
import {
  composerPlaceholder,
  draftModelSummaryLabel,
  lifecycleFreezesComposerText,
  sendPromptTitle,
  sessionModelSummaryLabel,
  sessionPermissionMenuModes,
} from "../../reading-core/selectors/composer";
import { hasActiveRun } from "../../reading-core/selectors/runs";
import {
  activeTaskView,
  isSessionLifecycleActive,
  type RendererState,
  type TaskDraftMenuKind,
  type TaskViewState,
} from "../../reading-core/state";
import { elements } from "../dom";
import { lucideIcon } from "./icons";
import { actions } from "../actions";

/** The shell's state atom, bound once at boot for the composer's read paths. */
let state: RendererState;

export function initComposerView(stateRef: RendererState): void {
  state = stateRef;
}

/** One chip's data, sourced from either a live task's pendingAttachments or the
 *  new-chat draft — the chip UI is identical; only the source and removal differ. */
interface ComposerChipModel {
  name: string;
  previewUrl: string | null;
  kind: AttachmentKind;
  remove: () => void;
}

function composerChipModels(view: TaskViewState | null): ComposerChipModel[] {
  const list = view?.task ? view.pendingAttachments : state.draftAttachments;
  return list.map((item) => ({
    name: item.name,
    previewUrl: item.previewUrl,
    kind: item.kind,
    remove: () => actions.removeComposerAttachment(list, item),
  }));
}

/** A copied bitmap shows its thumbnail; a reference shows a kind icon — honestly
 *  a pointer to the user's file/folder, not content Sonata ingested. */
function attachmentKindIcon(kind: AttachmentKind, size = 18): SVGElement {
  const node = kind === "folder" ? Folder : kind === "image" ? ImageIcon : FileIcon;
  return lucideIcon(node, size);
}

/** The secondary line on a file/folder chip: "Folder", or the file's extension
 *  uppercased ("PDF" / "GZ"), or "File" when there is none. Images show no label. */
function attachmentKindLabel(kind: AttachmentKind, name: string): string {
  if (kind === "folder") {
    return "Folder";
  }
  return fileExtension(name).slice(1).toUpperCase() || "File";
}

export function renderAttachmentStrip(view = activeTaskView(state)): void {
  elements.attachmentStrip.replaceChildren();
  const chips = composerChipModels(view);
  elements.attachmentStrip.classList.toggle("hidden", chips.length === 0);
  if (chips.length === 0) {
    return;
  }

  for (const item of chips) {
    const chip = document.createElement("div");
    chip.title = item.name;

    if (item.kind === "image") {
      // Image: a square thumbnail, no text. (Over the preview cap / unreadable →
      // a centered glyph instead of a blank square.)
      chip.className = "attachment-chip attachment-chip-image";
      if (item.previewUrl) {
        const image = document.createElement("img");
        image.src = item.previewUrl;
        image.alt = item.name;
        chip.append(image);
      } else {
        const glyph = document.createElement("span");
        glyph.className = "attachment-chip-glyph";
        glyph.append(attachmentKindIcon("image", 22));
        chip.append(glyph);
      }
    } else {
      // File / folder: an icon tile + name (truncated) over a kind line.
      chip.className = "attachment-chip attachment-chip-file";
      const tile = document.createElement("span");
      tile.className = "attachment-chip-icon";
      tile.append(attachmentKindIcon(item.kind, 20));
      const meta = document.createElement("div");
      meta.className = "attachment-chip-meta";
      const name = document.createElement("span");
      name.className = "attachment-chip-name";
      name.textContent = item.name;
      const kindLine = document.createElement("span");
      kindLine.className = "attachment-chip-kind";
      kindLine.textContent = attachmentKindLabel(item.kind, item.name);
      meta.append(name, kindLine);
      chip.append(tile, meta);
    }

    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "attachment-remove";
    remove.setAttribute("aria-label", `Remove ${item.name}`);
    remove.disabled = isSessionLifecycleActive(state);
    remove.append(lucideIcon(X, 12));
    remove.addEventListener("click", item.remove);
    chip.append(remove);

    elements.attachmentStrip.append(chip);
  }
}

export function renderComposerControls(view = activeTaskView(state)): void {
  const lifecycleBusy = isSessionLifecycleActive(state);
  const activeRun = hasActiveRun(view) || Boolean(view?.deliveryState?.activeRun);
  const pendingApproval = Boolean(view?.pendingApproval);
  const promptHasText = elements.promptInput.value.trim().length > 0;
  const newChat = !view;
  const hasAttachments = newChat
    ? state.draftAttachments.length > 0
    : (view?.pendingAttachments.length ?? 0) > 0;
  if (newChat) {
    // New chat: the chips ARE the launch controls (2026-07-04 redesign) —
    // access + provider + model open their draft menus; the project chip
    // sits on the composer's context row. Sessions never show the provider
    // chip (the provider can't change mid-session).
    // The access chip is present for BOTH providers now (2026-07-15 codex
    // permission mode): Claude reads the triad, Codex the three-preset picker.
    // One chip element, one "access" menu kind — the provider selects the
    // vocabulary (label here, menu body in entry.ts).
    const codexDraft = state.taskDraft.provider === "codex";
    renderDraftChip(elements.permissionChip, {
      kind: "access",
      visible: true,
      label: codexDraft
        ? codexPermissionModeLabel(
            state.taskDraft.codexPermissionMode ?? state.codexDefaultPermissionMode,
          )
        : permissionModeLabel(
            state.taskDraft.permissionMode ?? state.claudeDefaultPermissionMode,
          ),
      hint: codexDraft
        ? "How should Codex actions be approved?"
        : "How should Claude actions be approved?",
    });
    renderDraftChip(elements.providerChip, {
      kind: "provider",
      visible: true,
      label: providerLabel(state.taskDraft.provider),
      hint: "Choose the agent for this session",
    });
    renderDraftChip(elements.modelChip, {
      kind: "launch",
      visible: true,
      label: draftModelSummaryLabel(state.taskDraft),
      hint: "Model and reasoning for this session",
    });
    renderDraftChip(elements.projectChip, {
      kind: "project",
      visible: true,
      label: draftProjectLabel(),
      hint: "Choose where this session works",
      icon: Folder,
    });
    elements.composerContextRow.classList.remove("hidden");
  } else {
    elements.providerChip.classList.add("hidden");
    elements.composerContextRow.classList.add("hidden");
    // The live chip is display-only for both CLIs; only the native switch it
    // names differs (Codex has no Shift+Tab permission cycle, and its /model
    // covers effort too). Provider is read off the task; when there is no task
    // the chip is hidden anyway, so the fallback never surfaces.
    const provider = view.task?.provider ?? "claude";
    renderSessionAccessChip(view, provider);
    renderSessionModelChip(view, provider);
  }
  renderUsageIndicator(view);
  // New-chat state (no view): the composer IS the create action — the
  // session is born from the first message, never from an empty spawn.
  // Attachments are allowed in a new chat (held in the draft until the first
  // send materializes them).
  // Attachments are held lazily (materialized on send), so a live runtime is no
  // longer required — enable for a new chat and for any session, incl. dormant
  // (paste/drop already add there; resume-send materializes them).
  elements.addAttachment.disabled = lifecycleBusy || (newChat ? false : !view.task);
  elements.addAttachment.classList.toggle("active", state.composerMenu?.type === "add");
  // A mid-session switch that hasn't resolved may leave the CLI mid-choreography
  // — a model/effort cache-miss confirm (Yes/No) that is NOT a Sonata approval,
  // or a permission stepping run still pressing Shift+Tab — so submitPrompt could
  // bracket-paste a prompt into an unexpected state. Gate send while the switch
  // pointer is set (pending AND needs-attention), consistent with the busy-disable
  // treatments. Cleared by the switch settling, a new run, or the user dismissing
  // the banner.
  const switchUnresolved = Boolean(view?.controlSwitch);
  elements.sendPrompt.disabled =
    state.busy ||
    lifecycleBusy ||
    switchUnresolved ||
    (!activeRun && !promptHasText && !hasAttachments);
  elements.sendPrompt.title = sendPromptTitle(view, activeRun, pendingApproval, promptHasText || hasAttachments);
  elements.sendPrompt.textContent = activeRun ? "■" : "↑";
  elements.sendPrompt.classList.toggle("stop-mode", activeRun);
  // D1 (two grains of freeze): only the draft-moving phases disable typing.
  // Every other active phase keeps the composer usable — mutual exclusion is
  // enforced by the claim guards, not by blurring a focused textarea.
  elements.promptInput.disabled = lifecycleFreezesComposerText(state) || (state.busy && !newChat);
  elements.promptInput.placeholder = composerPlaceholder(view, activeRun, pendingApproval);
  elements.sendPrompt.setAttribute("aria-label", sendButtonLabel(activeRun));
}

export function renderUsageIndicator(view: TaskViewState | null): void {
  const snapshot = view?.usageSnapshot ?? null;
  const context = snapshot?.context ?? null;
  const usedPercent = context ? 100 - context.remainingPercent : 0;
  const hasTask = Boolean(view?.task);
  const hasContext = Boolean(context);
  const high = hasContext && usedPercent >= USAGE_CONTEXT_HIGH_USED_PERCENT;

  elements.usageIndicator.disabled = !hasTask;
  elements.usageIndicator.classList.toggle("empty", !hasContext);
  elements.usageIndicator.classList.toggle("high", high);
  elements.usageIndicator.classList.toggle("active", Boolean(state.usagePopover));
  elements.usageIndicator.style.setProperty("--usage-ring-dashoffset", String(100 - usedPercent));
  elements.usageIndicator.ariaExpanded = String(Boolean(state.usagePopover));

  if (!hasTask) {
    elements.usageIndicator.title = "Usage data";
    elements.usageIndicator.setAttribute("aria-label", "Usage data");
    return;
  }
  if (!context) {
    elements.usageIndicator.title = "No usage data yet";
    elements.usageIndicator.setAttribute("aria-label", "No usage data yet");
    return;
  }

  const label = `${formatUsagePercent(context.remainingPercent)} context left`;
  elements.usageIndicator.title = label;
  elements.usageIndicator.setAttribute("aria-label", label);
}

/**
 * The live session's model chip. Interactive on BOTH providers now: at idle it
 * opens the model+effort switch menu; while a turn runs it renders a designed
 * disabled state; while a switch is in flight it dims to a pending look. Claude's
 * label follows the statusline mirror (S1); Codex has no statusline, so its label
 * follows task.model + task.reasoningEffort, which the controller writes off the
 * `/model` picker receipt (S4 — the same receipt-as-SSOT asymmetry as the codex
 * access chip). The only per-provider differences are the switch axes
 * (`model`/`effort` vs `codex-model`/`codex-effort`), the menu it opens, and the
 * vocabulary the "Switching to …" title reads.
 */
function renderSessionModelChip(view: TaskViewState, provider: RuntimeProvider): void {
  const label = composerChipLabel(view, "model");
  const codex = provider === "codex";
  const element = elements.modelChip;
  element.classList.toggle("hidden", !label);
  element.removeAttribute("aria-expanded");
  if (!label) {
    element.classList.remove("interactive", "active", "switching");
    element.disabled = true;
    element.removeAttribute("title");
    element.removeAttribute("aria-haspopup");
    return;
  }
  // `pending` = a model/effort switch of THIS chip is in flight (the switching
  // shimmer + "Switching to …" title). A permission switch in flight is not this
  // chip's — it shows no shimmer, but still disables the chip (single-switch
  // guard). Idle-only (turnActivity SSOT — turn-signal program): no switching
  // while a turn is live or background work runs, or any switch is in flight.
  const kind = view.controlSwitch?.kind;
  const pending = codex
    ? kind === "codex-model" || kind === "codex-effort"
    : kind === "model" || kind === "effort";
  const switchable = turnActivity(view) === "idle" && !view.controlSwitch;
  const open = state.composerMenu?.type === (codex ? "session-codex-model" : "session-model");

  // Reuse the launch-chip DOM (label span + caret) so the live chip reads as the
  // same control as New Chat's model chip. Children update in place — the
  // persistent-control render rule (a blur-driven re-render must not detach the
  // mousedown target mid-click).
  let labelEl = element.querySelector<HTMLSpanElement>(".composer-chip-label");
  if (!labelEl) {
    element.replaceChildren();
    labelEl = document.createElement("span");
    labelEl.className = "composer-chip-label";
    element.append(labelEl, lucideIcon(ChevronDown, 12));
  }
  if (labelEl.textContent !== label) {
    labelEl.textContent = label;
  }
  const providerName = codex ? "Codex" : "Claude";
  element.classList.add("interactive");
  element.classList.toggle("active", open);
  element.classList.toggle("switching", pending);
  element.disabled = !switchable;
  element.title = pending
    ? `Switching to ${sessionModelSwitchingLabel(provider, kind, view.controlSwitch?.value ?? "")}…`
    : switchable
      ? "Switch model and reasoning for this session"
      : `Available when ${providerName} is idle`;
  element.setAttribute("aria-haspopup", "menu");
  element.ariaExpanded = String(open);
}

/** The "Switching to …" title's human label for the in-flight model/effort
 *  switch. Codex-model / codex-effort carry a slug / reasoning id in `value`;
 *  claude carries an alias / effort id — map each to its menu label. */
function sessionModelSwitchingLabel(
  provider: RuntimeProvider,
  kind: string | undefined,
  value: string,
): string {
  if (kind === "codex-model" || kind === "model") {
    return modelValueLabel(provider, value) ?? value;
  }
  if (kind === "codex-effort" || kind === "effort") {
    return reasoningValueLabel(provider, value as never) ?? value;
  }
  return value;
}

/**
 * The live session's access (permission-mode) chip. Interactive on BOTH providers
 * now: at idle it opens the permission switch menu; while a turn runs it renders a
 * designed disabled state; while a switch is in flight it dims to a pending look.
 * The label always follows the session's mode SSOT — task.permissionMode
 * (hook-reconciled) for claude, task.codexPermissionMode (picker-receipt-written)
 * for codex. The only per-provider differences are the switch axis
 * (`permission` vs `codex-permission`), the menu it opens, and its vocabulary.
 */
function renderSessionAccessChip(view: TaskViewState, provider: RuntimeProvider): void {
  const label = composerChipLabel(view, "permission");
  const codex = provider === "codex";
  const element = elements.permissionChip;
  element.classList.toggle("hidden", !label);
  element.removeAttribute("aria-expanded");
  if (!label) {
    element.classList.remove("interactive", "active", "switching");
    element.disabled = true;
    element.removeAttribute("title");
    element.removeAttribute("aria-haspopup");
    return;
  }
  const switchKind = codex ? "codex-permission" : "permission";
  const pending = view.controlSwitch?.kind === switchKind;
  const switchable = turnActivity(view) === "idle" && !view.controlSwitch;
  const open = state.composerMenu?.type === (codex ? "session-codex-access" : "session-access");

  let labelEl = element.querySelector<HTMLSpanElement>(".composer-chip-label");
  if (!labelEl) {
    element.replaceChildren();
    labelEl = document.createElement("span");
    labelEl.className = "composer-chip-label";
    element.append(labelEl, lucideIcon(ChevronDown, 12));
  }
  if (labelEl.textContent !== label) {
    labelEl.textContent = label;
  }
  const providerName = codex ? "Codex" : "Claude";
  const switchingLabel = codex
    ? codexPermissionModeLabel(view.controlSwitch?.value as CodexPermissionMode)
    : permissionModeLabel(view.controlSwitch?.value as ClaudePermissionMode);
  element.classList.add("interactive");
  element.classList.toggle("active", open);
  element.classList.toggle("switching", pending);
  element.disabled = !switchable;
  element.title = pending
    ? `Switching to ${switchingLabel}…`
    : switchable
      ? `Switch how ${providerName} actions are approved for this session`
      : `Available when ${providerName} is idle`;
  element.setAttribute("aria-haspopup", "menu");
  element.ariaExpanded = String(open);
}

/** The live session's permission-mode switch menu (S2) — same visual family as
 *  the model menu (renderSettingSection), current mode marked. No CLI-default
 *  caption: a Shift+Tab switch is session-scoped and does NOT persist to
 *  settings.json (unlike `/model` / `/effort`), so there is no side effect to
 *  note. Offered modes = default / acceptEdits / plan / auto always, plus
 *  bypassPermissions only when the session was spawned into it (D4, as revised by
 *  the 2026-07-18 field test — see sessionPermissionMenuModes; an account whose
 *  cycle lacks auto fails gracefully rather than hiding Auto forever). */
function renderSessionAccessMenu(view: TaskViewState): HTMLElement {
  const menu = document.createElement("div");
  menu.className = "task-settings-popover composer-session-menu";
  menu.setAttribute("role", "menu");
  menu.ariaLabel = "Approvals";
  menu.addEventListener("click", (event) => {
    event.stopPropagation();
  });

  const current = view.task?.permissionMode ?? null;
  const options = sessionPermissionMenuModes(view).map((mode) => ({
    label: permissionModeLabel(mode),
    value: mode as string,
  }));
  menu.append(
    renderSettingSection("Approvals", options, (current ?? "") as string, (value) => {
      actions.switchSessionPermission(view, value);
    }),
  );
  return menu;
}

/** The live CODEX session's permission-preset switch menu (S3) — same visual
 *  family as the Claude access menu (renderSettingSection), current preset marked,
 *  the three fixed presets always offered (codex's `/permissions` picker has
 *  exactly these rows). The CLI-default caption was REMOVED (S6, field revision 5,
 *  2026-07-18): the `/permissions` switch does persist globally into
 *  ~/.codex/config.toml, but that disclosure now lives in docs, not menu chrome
 *  (Sonata sessions are immune anyway — spawn flags override). */
function renderSessionCodexAccessMenu(view: TaskViewState): HTMLElement {
  const menu = document.createElement("div");
  menu.className = "task-settings-popover composer-session-menu";
  menu.setAttribute("role", "menu");
  menu.ariaLabel = "Approvals";
  menu.addEventListener("click", (event) => {
    event.stopPropagation();
  });

  const current = view.task?.codexPermissionMode ?? null;
  const options = CODEX_PERMISSION_MODE_OPTIONS.map((mode) => ({
    label: codexPermissionModeLabel(mode),
    value: mode as string,
  }));
  menu.append(
    renderSettingSection("Approvals", options, (current ?? "") as string, (value) => {
      actions.switchSessionCodexPermission(view, value);
    }),
  );
  return menu;
}

/** The live session's model + effort switch menu — a STAGED selector (S7 Part 1).
 *  Row clicks STAGE a (model, effort) pair (no CLI); Save applies the changed axes
 *  as ONE logical switch (claude: sequential `/model`+`/effort`, the cache-miss
 *  confirm relayed via the drawer). Same visual family as the New Chat launch menu
 *  (renderSettingSection), with the staged pick accent-marked and the session's
 *  live value a muted "Current". No CLI-default caption (removed S6). */
function renderSessionModelMenu(view: TaskViewState): HTMLElement {
  const menu = stagedMenuRoot();
  const staged = stagedPair(view, "claude");
  const current = currentSessionModelPair(view, "claude");
  menu.append(
    renderSettingSection(
      "Model",
      sessionModelOptions(),
      staged.model ?? "",
      (value) => actions.stageSessionModel(value),
      { current: current.model ?? "" },
    ),
    renderSettingSection(
      "Reasoning",
      sessionEffortOptions(),
      staged.effort ?? "",
      (value) => actions.stageSessionEffort(value),
      { current: current.effort ?? "" },
    ),
    renderStagedFooter(view, staged, current),
  );
  return menu;
}

/** The staged-menu container (shared by both providers' model menus). */
function stagedMenuRoot(): HTMLElement {
  const menu = document.createElement("div");
  menu.className = "task-settings-popover composer-session-menu composer-staged-menu";
  menu.setAttribute("role", "menu");
  menu.ariaLabel = "Model and reasoning";
  // stopPropagation: render() rebuilds the chip mid-click; without this the
  // document click-away would close the menu in the same click that opened it.
  menu.addEventListener("click", (event) => {
    event.stopPropagation();
  });
  return menu;
}

/** The open menu's staged pair, seeded to the current pair at open time; falls back
 *  to current if (defensively) absent. */
function stagedPair(
  view: TaskViewState,
  provider: RuntimeProvider,
): { model: string | null; effort: string | null } {
  return state.composerMenu?.staged ?? currentSessionModelPair(view, provider);
}

/** The session's live (model, effort) pair — the seed for staging and the
 *  Save-disabled-when-clean comparison. */
export function currentSessionModelPair(
  view: TaskViewState,
  provider: RuntimeProvider,
): { model: string | null; effort: string | null } {
  return provider === "codex"
    ? { model: sessionCodexModelValue(view), effort: sessionCodexEffortValue(view) }
    : { model: sessionModelValue(view), effort: sessionEffortValue(view) };
}

/** The Save / Cancel footer: the staged menu touches the CLI only on Save; Save is
 *  disabled while the staged pair equals current. Cancel discards (closes the menu);
 *  Esc / outside-click discard the same way (the composer's document handlers). */
function renderStagedFooter(
  view: TaskViewState,
  staged: { model: string | null; effort: string | null },
  current: { model: string | null; effort: string | null },
): HTMLElement {
  const footer = document.createElement("div");
  footer.className = "composer-staged-footer";
  const dirty = staged.model !== current.model || staged.effort !== current.effort;

  const cancel = document.createElement("button");
  cancel.className = "composer-staged-action";
  cancel.type = "button";
  cancel.textContent = "Cancel";
  cancel.addEventListener("click", () => actions.closeSessionMenu());

  const save = document.createElement("button");
  save.className = "composer-staged-action primary";
  save.type = "button";
  save.textContent = "Save";
  save.disabled = !dirty;
  save.addEventListener("click", () => actions.saveStagedModelSwitch(view));

  footer.append(cancel, save);
  return footer;
}

/** Concrete Claude models only — "Native Default" (null) has no mid-session
 *  meaning (there is no re-spawn to defer to). */
function sessionModelOptions(): Array<{ label: string; value: string }> {
  return MODEL_OPTIONS.claude.flatMap((option) =>
    option.value ? [{ label: option.label, value: option.value }] : [],
  );
}

/** The v1 effort set (low → max); "Native Default" (null) is dropped for the
 *  same reason as the model list. */
function sessionEffortOptions(): Array<{ label: string; value: string }> {
  return REASONING_OPTIONS.claude.flatMap((option) =>
    option.value ? [{ label: option.label, value: option.value }] : [],
  );
}

/** The current model as a `/model` alias, so the menu can mark it. The live
 *  statusline display name wins (it follows a switch); map it back to an alias
 *  by label, falling back to the spawn model. */
function sessionModelValue(view: TaskViewState): string | null {
  const task = view.task;
  if (!task) {
    return null;
  }
  const displayName = view.usageSnapshot?.modelDisplayName ?? null;
  if (displayName) {
    const match = MODEL_OPTIONS.claude.find((option) => option.label === displayName);
    if (match?.value) {
      return match.value;
    }
  }
  return task.model;
}

/** The current effort level — the live statusline value wins (a model switch may
 *  reset effort, and the statusline carries the live level), spawn value falls
 *  back. */
function sessionEffortValue(view: TaskViewState): string | null {
  return view.usageSnapshot?.reasoningEffort ?? view.task?.reasoningEffort ?? null;
}

/** The live CODEX session's model + effort switch menu (S4) — same visual family
 *  as the New Chat launch menu (renderSettingSection). Data source is Sonata's
 *  curated codex list (D5), current marked from the task record (codex has no
 *  statusline mirror). Selecting a model switches only the model (effort preserved
 *  via the picker's level-2 `(current)` row); selecting a reasoning switches only
 *  the reasoning (model preserved via level-1 `(current)`). The CLI-default caption
 *  was REMOVED (S6, field revision 5, 2026-07-18): codex does persist a `/model`
 *  switch globally into ~/.codex/config.toml, but that disclosure now lives in
 *  docs, not menu chrome (Sonata sessions are immune — spawn flags override). */
function renderSessionCodexModelMenu(view: TaskViewState): HTMLElement {
  const menu = stagedMenuRoot();
  const staged = stagedPair(view, "codex");
  const current = currentSessionModelPair(view, "codex");
  menu.append(
    renderSettingSection(
      "Model",
      sessionCodexModelOptions(),
      staged.model ?? "",
      (value) => actions.stageSessionModel(value),
      { current: current.model ?? "" },
    ),
    renderSettingSection(
      "Reasoning",
      sessionCodexEffortOptions(),
      staged.effort ?? "",
      (value) => actions.stageSessionEffort(value),
      { current: current.effort ?? "" },
    ),
    renderStagedFooter(view, staged, current),
  );
  return menu;
}

/** Concrete curated Codex models only — "Native Default" (null) has no
 *  mid-session meaning (the picker offers no "reset to default" row). A model the
 *  running picker doesn't list (a legacy model, or upstream drift) rolls the
 *  switch back to needs-attention (D5), so the menu offers the full curated list
 *  and lets the choreography surface any mismatch. */
function sessionCodexModelOptions(): Array<{ label: string; value: string }> {
  return MODEL_OPTIONS.codex.flatMap((option) =>
    option.value ? [{ label: option.label, value: option.value }] : [],
  );
}

/** The v1 reasoning set (low → xhigh, D6): "Native Default" (null), Max, and
 *  Ultra are dropped — Max/Ultra live in the picker's "More reasoning…" submenu,
 *  which the choreography never enters. */
function sessionCodexEffortOptions(): Array<{ label: string; value: string }> {
  const v1 = new Set(["low", "medium", "high", "xhigh"]);
  return REASONING_OPTIONS.codex.flatMap((option) =>
    option.value && v1.has(option.value) ? [{ label: option.label, value: option.value }] : [],
  );
}

/** The current codex model (the spawn/last-switch value — codex has no statusline
 *  mirror, so task.model is the SSOT the picker receipt updates). */
function sessionCodexModelValue(view: TaskViewState): string | null {
  return view.task?.model ?? null;
}

/** The current codex reasoning (task.reasoningEffort — same SSOT rationale). */
function sessionCodexEffortValue(view: TaskViewState): string | null {
  return view.task?.reasoningEffort ?? null;
}

/** A New Chat launch chip: interactive, carets down, toggles its draft menu
 *  (the click wiring lives in main.ts — static elements, bound once).
 *
 *  Children update IN PLACE — never replaceChildren on an unchanged label.
 *  A persistent control's nodes must survive renders (the transcript's
 *  keyed-reconcile lesson): the composer re-renders on textarea blur, which
 *  runs DURING a chip click's mousedown→mouseup window — detaching the
 *  mousedown target there means the browser never synthesizes the click,
 *  and the user's first tap after typing is silently swallowed. */
function renderDraftChip(
  element: HTMLButtonElement,
  options: {
    kind: TaskDraftMenuKind;
    visible: boolean;
    label: string;
    hint: string;
    icon?: typeof Folder;
  },
): void {
  element.classList.toggle("hidden", !options.visible);
  if (!options.visible) {
    // Drop the display classes too — .composer-chip.interactive{display:…}
    // outranks a bare .hidden (the .run-column.hidden source-order trap).
    element.classList.remove("interactive", "active");
    return;
  }
  const open = state.taskDraft.menu?.kind === options.kind;
  let label = element.querySelector<HTMLSpanElement>(".composer-chip-label");
  if (!label) {
    element.replaceChildren();
    label = document.createElement("span");
    label.className = "composer-chip-label";
    if (options.icon) {
      element.append(lucideIcon(options.icon, 13));
    }
    element.append(label, lucideIcon(ChevronDown, 12));
  }
  if (label.textContent !== options.label) {
    label.textContent = options.label;
  }
  element.classList.add("interactive");
  element.classList.toggle("active", open);
  element.disabled = state.busy || isSessionLifecycleActive(state);
  element.title = options.hint;
  element.setAttribute("aria-haspopup", "menu");
  element.ariaExpanded = String(open);
}

/** The project chip's label: the chosen project's display name, or the
 *  explicit "not in a project" state — the chip is the state display. */
function draftProjectLabel(): string {
  const cwd = state.taskDraft.cwd;
  if (!cwd) {
    return "No project";
  }
  const project = (state.sessionIndex?.projects ?? []).find(
    (candidate) => candidate.path === cwd,
  );
  return project?.name ?? folderName(cwd);
}

function composerChipLabel(view: TaskViewState | null, type: "permission" | "model"): string | null {
  const task = view?.task ?? null;
  return type === "permission" ? sessionPermissionLabel(task) : sessionModelSummaryLabel(view);
}

export function renderComposerPopover(view = activeTaskView(state)): void {
  elements.composerPopoverRoot.replaceChildren();
  if (state.slashPicker) {
    // The picker also serves the new-chat composer, before any task exists.
    const picker = actions.renderSlashPicker(state.slashPicker);
    elements.composerPopoverRoot.append(picker);
    actions.positionSlashPicker(picker);
    return;
  }
  // The Add (attachments) menu works in a new chat too — render it before the
  // task guard. The usage popover reads a live session.
  if (state.composerMenu?.type === "add") {
    const menu = renderAddMenu();
    positionComposerMenu(menu);
    elements.composerPopoverRoot.append(menu);
    return;
  }
  if (state.composerMenu?.type === "session-model" && view?.task) {
    const menu = renderSessionModelMenu(view);
    positionComposerMenu(menu);
    elements.composerPopoverRoot.append(menu);
    return;
  }
  if (state.composerMenu?.type === "session-codex-model" && view?.task) {
    const menu = renderSessionCodexModelMenu(view);
    positionComposerMenu(menu);
    elements.composerPopoverRoot.append(menu);
    return;
  }
  if (state.composerMenu?.type === "session-access" && view?.task) {
    const menu = renderSessionAccessMenu(view);
    positionComposerMenu(menu);
    elements.composerPopoverRoot.append(menu);
    return;
  }
  if (state.composerMenu?.type === "session-codex-access" && view?.task) {
    const menu = renderSessionCodexAccessMenu(view);
    positionComposerMenu(menu);
    elements.composerPopoverRoot.append(menu);
    return;
  }
  if (!view?.task) {
    return;
  }
  if (state.usagePopover) {
    const popover = renderUsagePopover(view);
    elements.composerPopoverRoot.append(popover);
    positionUsagePopover(popover);
  }
}

function renderUsagePopover(view: TaskViewState): HTMLElement {
  const popover = document.createElement("div");
  popover.className = "usage-popover";
  popover.setAttribute("role", "dialog");
  popover.setAttribute("aria-label", "Usage");
  popover.addEventListener("mouseenter", () => {
    actions.clearUsagePopoverCloseTimer();
  });
  popover.addEventListener("mouseleave", () => {
    actions.scheduleUsagePopoverClose();
  });

  const snapshot = view.usageSnapshot;
  const hasCost = typeof snapshot?.costUsd === "number";
  if (!snapshot || (!snapshot.context && snapshot.limits.length === 0 && !hasCost)) {
    const empty = document.createElement("p");
    empty.className = "usage-popover-empty";
    empty.textContent = "No usage data yet — appears after the first response";
    popover.append(empty);
    return popover;
  }

  if (snapshot.context) {
    popover.append(renderUsageContextRow(snapshot));
  }

  for (const limit of snapshot.limits) {
    popover.append(renderUsageLimitRow(limit));
  }

  if (typeof snapshot.costUsd === "number") {
    const cost = document.createElement("div");
    cost.className = "usage-context-row";
    const label = document.createElement("strong");
    label.textContent = "Session cost";
    const value = document.createElement("span");
    value.textContent = `$${snapshot.costUsd.toFixed(2)}`;
    cost.append(label, value);
    popover.append(cost);
  }

  const footer = document.createElement("p");
  footer.className = "usage-popover-footer";
  footer.textContent = `as of ${formatRelativeUsageTime(snapshot.capturedAt)}`;
  popover.append(footer);
  return popover;
}

function renderUsageContextRow(snapshot: UsageSnapshot): HTMLElement {
  const context = snapshot.context;
  const row = document.createElement("div");
  row.className = "usage-context-row";
  if (!context) {
    return row;
  }

  const label = document.createElement("strong");
  label.textContent = `Context — ${formatUsagePercent(context.remainingPercent)} left`;

  const meta = document.createElement("span");
  meta.textContent = `${compactTokenCount(context.usedTokens)} / ${compactTokenCount(context.windowTokens)}`;

  row.append(label, meta);
  return row;
}

function renderUsageLimitRow(limit: UsageSnapshot["limits"][number]): HTMLElement {
  const row = document.createElement("div");
  row.className = "usage-limit-row";

  const heading = document.createElement("div");
  heading.className = "usage-limit-heading";
  const label = document.createElement("strong");
  label.textContent = usageLimitDisplayLabel(limit.label);
  const value = document.createElement("span");
  value.textContent = `${formatUsagePercent(limit.remainingPercent)} left · resets ${formatRelativeUsageTime(limit.resetsAt * 1000)}`;
  heading.append(label, value);

  const bar = document.createElement("div");
  bar.className = "usage-limit-bar";
  const fill = document.createElement("div");
  fill.className = "usage-limit-bar-fill";
  fill.style.width = `${Math.max(0, Math.min(100, limit.remainingPercent))}%`;
  bar.append(fill);

  row.append(heading, bar);
  return row;
}

function renderAddMenu(): HTMLElement {
  const menu = composerMenu("Add");
  menu.append(
    composerMenuOption("Add files & folders", false, () => {
      actions.pickReferencesFromAddMenu();
    }),
  );
  return menu;
}

function composerMenu(titleText: string): HTMLElement {
  const menu = document.createElement("div");
  menu.className = "composer-menu";
  menu.setAttribute("role", "menu");
  const title = document.createElement("p");
  title.className = "composer-menu-heading";
  title.textContent = titleText;
  menu.append(title);
  return menu;
}

function composerMenuOption(label: string, selected: boolean, onClick: () => void): HTMLButtonElement {
  const button = document.createElement("button");
  button.className = "composer-menu-option";
  button.classList.toggle("selected", selected);
  button.type = "button";
  button.setAttribute("role", "menuitemradio");
  button.ariaChecked = String(selected);
  button.textContent = label;
  if (selected) {
    const badge = document.createElement("span");
    badge.textContent = "current";
    button.append(badge);
  }
  button.addEventListener("click", onClick);
  return button;
}

function positionComposerMenu(menu: HTMLElement): void {
  const anchor = state.composerMenu?.anchor;
  const viewportPadding = 14;
  const width = Math.min(320, window.innerWidth - viewportPadding * 2);
  const left = anchor
    ? Math.min(
        window.innerWidth - width - viewportPadding,
        Math.max(viewportPadding, anchor.left + anchor.width - width),
      )
    : viewportPadding;
  menu.style.left = `${left}px`;
  menu.style.width = `${width}px`;
  // The menu opens UPWARD from its chip. Anchor its BOTTOM just above the chip and
  // cap its height to the space available above, so a tall menu (the codex model
  // list — 7 models + reasoning — is the tallest) scrolls INTERNALLY (the popover
  // is overflow-y:auto) instead of overflowing off the top/bottom of the viewport.
  // Bottom-anchoring avoids needing the rendered height up front (this runs before
  // the menu is appended, so it can't be measured). Falls back to a top pin when
  // there is no anchor (the new-chat slash surfaces).
  if (anchor) {
    menu.style.top = "auto";
    menu.style.bottom = `${Math.max(viewportPadding, window.innerHeight - anchor.top + 8)}px`;
    menu.style.maxHeight = `${Math.max(180, anchor.top - 8 - viewportPadding)}px`;
  } else {
    menu.style.bottom = "auto";
    menu.style.top = `${viewportPadding}px`;
    menu.style.maxHeight = `${Math.max(180, window.innerHeight - viewportPadding * 2)}px`;
  }
}

function positionUsagePopover(popover: HTMLElement): void {
  // Anchor geometry is read live on every render: the composer collapses and
  // expands around focus changes, so a stored anchor snapshot goes stale and
  // can drop the popover onto the indicator itself.
  const anchor = elements.usageIndicator.getBoundingClientRect();
  const viewportPadding = 14;
  const width = Math.min(320, window.innerWidth - viewportPadding * 2);
  popover.style.width = `${width}px`;
  popover.style.maxHeight = `${Math.max(180, window.innerHeight - viewportPadding * 2)}px`;
  const left = Math.min(
    window.innerWidth - width - viewportPadding,
    Math.max(viewportPadding, anchor.right - width),
  );
  const top = Math.max(viewportPadding, anchor.top - popover.offsetHeight - 8);
  popover.style.left = `${left}px`;
  popover.style.top = `${top}px`;
}

function sessionPermissionLabel(task: Task | null): string | null {
  if (!task) {
    return null;
  }
  if (task.provider === "claude") {
    // One vocabulary with the Settings popup and the New Chat access chip
    // (2026-07-04) — the raw mode id ("auto") never reaches the surface.
    return task.permissionMode ? permissionModeLabel(task.permissionMode) : null;
  }
  // One vocabulary with the Settings "Codex" popup (Codex 0.144's own picker
  // labels). "Full Access" is now reachable as a first-class mode. Null mode
  // mirrors Claude's null permissionMode → no chip label.
  return task.codexPermissionMode ? codexPermissionModeLabel(task.codexPermissionMode) : null;
}

function sendButtonLabel(activeRun: boolean): string {
  if (activeRun) {
    return "Stop";
  }
  // Both the task and no-task arms said "Send" — collapsed at the D5 sweep
  // (the split predated the program; provably identical returns).
  return "Send";
}
