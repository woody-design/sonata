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
import type { AttachmentKind, Task, UsageSnapshot } from "../../shared/types";
import { USAGE_CONTEXT_HIGH_USED_PERCENT } from "../../reading-core/config";
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
  sessionModelSwitchHint,
  sessionPermissionSwitchHint,
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
 *  a pointer to the user's file/folder, not content Duet ingested. */
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
    renderDraftChip(elements.permissionChip, {
      kind: "access",
      visible: state.taskDraft.provider === "claude",
      label: permissionModeLabel(
        state.taskDraft.permissionMode ?? state.claudeDefaultPermissionMode,
      ),
      hint: "How should Claude actions be approved?",
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
    renderComposerChip(
      elements.permissionChip,
      composerChipLabel(view, "permission"),
      sessionPermissionSwitchHint(provider),
    );
    renderComposerChip(
      elements.modelChip,
      composerChipLabel(view, "model"),
      sessionModelSwitchHint(provider),
    );
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
  elements.sendPrompt.disabled =
    state.busy || lifecycleBusy || (!activeRun && !promptHasText && !hasAttachments);
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
 * Display-only session facts (S3): mid-session model/permission switching
 * lives in the terminal (native Shift+Tab, /model); the chip mirrors the
 * session's current value (task record, updated via hooks/statusline) and
 * its tooltip points at the native switch.
 */
function renderComposerChip(element: HTMLButtonElement, label: string | null, hint: string): void {
  element.classList.toggle("hidden", !label);
  element.classList.remove("interactive", "active");
  element.textContent = label ?? "";
  element.disabled = true;
  element.removeAttribute("aria-haspopup");
  element.removeAttribute("aria-expanded");
  if (label) {
    element.title = `${label} — ${hint}`;
  } else {
    element.removeAttribute("title");
  }
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
  const estimatedHeight = 190;
  const top = anchor
    ? Math.max(viewportPadding, anchor.top - estimatedHeight - 8)
    : viewportPadding;
  menu.style.left = `${left}px`;
  menu.style.top = `${top}px`;
  menu.style.width = `${width}px`;
  menu.style.maxHeight = `${Math.max(180, window.innerHeight - viewportPadding * 2)}px`;
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
