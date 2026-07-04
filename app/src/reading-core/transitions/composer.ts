/**
 * Named state transitions for the composer (map §3.1, step C3d): the slash
 * picker's open/refresh/close/selection mutations and the composer-draft
 * parking slot choice.
 *
 * Each transition performs exactly the mutations its shell handler performed
 * before extraction; the shell keeps the DOM reads (textarea value, IME
 * guards), the slash-commands TTL cache (G1), and the render calls. The
 * fallback entries arrive as a lazy provider so the cache read keeps today's
 * conditional evaluation.
 */
import type { RuntimeProvider, SlashCommandEntry } from "../../shared/types";
import { taskViewForId, type RendererState } from "../state";
import { filteredSlashItems } from "../selectors/composer";

/** The mutation core of the shell's syncSlashPicker: open the picker (or
 *  refresh it in place, keeping entries for the same provider and the
 *  selection for the same query), and close the surfaces it displaces. */
export function openOrRefreshSlashPicker(
  state: RendererState,
  provider: RuntimeProvider,
  query: string,
  fallbackEntries: () => SlashCommandEntry[],
): void {
  const previous = state.slashPicker;
  state.slashPicker = {
    provider,
    entries:
      previous && previous.provider === provider ? previous.entries : fallbackEntries(),
    query,
    selectedIndex: previous && previous.query === query ? previous.selectedIndex : 0,
  };
  state.composerMenu = null;
  state.usagePopover = null;
  clampSlashSelection(state);
}

/** Returns whether the picker was open — the shell renders only on change. */
export function closeSlashPicker(state: RendererState): boolean {
  if (!state.slashPicker) {
    return false;
  }
  state.slashPicker = null;
  return true;
}

export function clampSlashSelection(state: RendererState): void {
  const picker = state.slashPicker;
  if (!picker) {
    return;
  }
  const count = filteredSlashItems(picker).length;
  picker.selectedIndex = count === 0 ? 0 : Math.min(Math.max(picker.selectedIndex, 0), count - 1);
}

/** Returns whether the selection moved — the shell renders only on movement. */
export function moveSlashSelection(state: RendererState, delta: number): boolean {
  const picker = state.slashPicker;
  if (!picker) {
    return false;
  }
  const count = filteredSlashItems(picker).length;
  if (count === 0) {
    return false;
  }
  picker.selectedIndex = (picker.selectedIndex + delta + count) % count;
  return true;
}

/** Fresh entries arrived from the provider (IPC) — install and re-clamp.
 *  The shell guards that the picker is still showing the same cache key. */
export function installSlashEntries(state: RendererState, entries: SlashCommandEntry[]): void {
  if (!state.slashPicker) {
    return;
  }
  state.slashPicker.entries = entries;
  clampSlashSelection(state);
}

/** Park the composer text into the slot the current owner dictates: the
 *  active view's composerDraft, or the New Chat slot when no task is active.
 *  The DOM textarea read stays in the shell (saveComposerDraft). */
export function parkComposerDraft(state: RendererState, text: string): void {
  const view = state.activeTaskId ? taskViewForId(state, state.activeTaskId) : null;
  if (view) {
    view.composerDraft = text;
  } else {
    state.newChatComposerDraft = text;
  }
}
