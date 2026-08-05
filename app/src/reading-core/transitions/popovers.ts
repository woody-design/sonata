/**
 * Named state transitions for the Reading window's popover surfaces (map
 * §3.1, step C3d): the reading ("Aa") popover, the Remote Control popover,
 * the composer "+" menu, the usage popover, and the Settings overlay.
 *
 * Each transition performs exactly the mutations its shell handler performed
 * before extraction; the shell calls it and then invalidates (render calls
 * stay shell-side until the D-phase seams). Anchors arrive as plain data —
 * the DOM rect reads stay in the shell. Where the original handler captured
 * the anchor only on the opening branch, the transition takes a lazy
 * provider so the read keeps today's conditional evaluation.
 */
import type { ComposerMenuState, PopoverAnchor, RendererState } from "../state";

export function toggleReadingPopover(
  state: RendererState,
  anchor: () => PopoverAnchor,
): void {
  const willOpen = !state.readingPopoverOpen;
  state.readingPopoverOpen = willOpen;
  state.readingPopoverAnchor = willOpen ? anchor() : null;
  if (willOpen) {
    state.composerMenu = null;
    state.taskDraft.menu = null;
    state.remoteControlPopoverOpen = false;
    state.remoteControlPopoverAnchor = null;
  }
}

export function closeReadingPopover(state: RendererState): void {
  state.readingPopoverOpen = false;
  state.readingPopoverAnchor = null;
}

export function setReadingPopoverAnchor(state: RendererState, anchor: PopoverAnchor): void {
  state.readingPopoverAnchor = anchor;
}

export function toggleRemoteControlPopover(
  state: RendererState,
  anchor: () => PopoverAnchor,
): void {
  const willOpen = !state.remoteControlPopoverOpen;
  state.remoteControlPopoverOpen = willOpen;
  state.remoteControlPopoverAnchor = willOpen ? anchor() : null;
  if (willOpen) {
    state.remoteControlNote = null;
    state.readingPopoverOpen = false;
    state.readingPopoverAnchor = null;
    state.composerMenu = null;
  }
}

export function closeRemoteControlPopover(state: RendererState): void {
  state.remoteControlPopoverOpen = false;
  state.remoteControlPopoverAnchor = null;
  state.remoteControlNote = null;
}

/** The Add (attachments) menu works in a new chat too — attachments are held
 *  in the draft until send. Opening displaces the whole popover family,
 *  including the New Chat draft menus (external review P2, 2026-07-04). */
export function toggleComposerMenu(
  state: RendererState,
  type: ComposerMenuState["type"],
  anchor: PopoverAnchor,
): void {
  state.slashPicker = null;
  const current = state.composerMenu;
  state.composerMenu = current?.type === type ? null : { type, anchor };
  state.usagePopover = null;
  state.taskDraft.menu = null;
}

/** Stage a model pick in the open session-model menu (S7 Part 1). Returns
 *  whether a staged pair was present to update — the shell renders on true.
 *  Row clicks only STAGE (no CLI); Save applies the changed axes as one switch. */
export function stageSessionModel(state: RendererState, value: string | null): boolean {
  if (!state.composerMenu?.staged) {
    return false;
  }
  state.composerMenu.staged.model = value;
  return true;
}

/** Stage an effort pick in the open session-model menu (S7 Part 1). Returns
 *  whether a staged pair was present to update — the shell renders on true. */
export function stageSessionEffort(state: RendererState, value: string | null): boolean {
  if (!state.composerMenu?.staged) {
    return false;
  }
  state.composerMenu.staged.effort = value;
  return true;
}

export function openUsagePopover(state: RendererState, pinned: boolean): void {
  const previousPinned = state.usagePopover?.pinned ?? false;
  state.composerMenu = null;
  state.usagePopover = {
    pinned: pinned || previousPinned,
  };
}

/** Returns whether the popover was open — the shell renders only on change. */
export function closeUsagePopover(state: RendererState): boolean {
  if (!state.usagePopover) {
    return false;
  }
  state.usagePopover = null;
  return true;
}

/** Returns false when the overlay is already open (the open is a no-op). */
export function openSettingsOverlay(state: RendererState): boolean {
  if (state.settingsOverlay) {
    return false;
  }
  state.settingsOverlay = {
    resume: null,
    claude: null,
    codex: null,
    policyMenuOpen: false,
    approvalMenuOpen: false,
    codexPermissionMenuOpen: false,
    claudeModelMenuOpen: false,
    codexModelMenuOpen: false,
    bridgeReverting: false,
    bridgeError: false,
  };
  return true;
}

export function closeSettingsOverlay(state: RendererState): void {
  state.settingsOverlay = null;
}
