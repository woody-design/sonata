import {
  DEFAULT_READING_SETTINGS,
  isReadingModeSetting,
  isReadingThemeId,
  type ReadingModeSetting,
  type ReadingThemeId,
} from "./reading-settings";

/**
 * The terminal window's own persisted preferences. Kept separate from the
 * global reading settings so the terminal is an independent surface: its own
 * open/closed state and — so the two windows are instantly distinguishable —
 * its own theme and light/dark mode, chosen from the same palette as the main
 * window. Default-on, defaulting to the same theme as the main window until the
 * user sets them apart.
 */
export interface TerminalWindowSettings {
  open: boolean;
  theme: ReadingThemeId;
  mode: ReadingModeSetting;
}

export const DEFAULT_TERMINAL_WINDOW_SETTINGS: TerminalWindowSettings = {
  open: true,
  theme: DEFAULT_READING_SETTINGS.theme,
  mode: DEFAULT_READING_SETTINGS.mode,
};

export function normalizeTerminalWindowSettings(value: unknown): TerminalWindowSettings {
  if (typeof value !== "object" || value === null) {
    return { ...DEFAULT_TERMINAL_WINDOW_SETTINGS };
  }
  const record = value as Record<string, unknown>;
  return {
    open:
      typeof record.open === "boolean" ? record.open : DEFAULT_TERMINAL_WINDOW_SETTINGS.open,
    theme: isReadingThemeId(record.theme) ? record.theme : DEFAULT_TERMINAL_WINDOW_SETTINGS.theme,
    mode: isReadingModeSetting(record.mode) ? record.mode : DEFAULT_TERMINAL_WINDOW_SETTINGS.mode,
  };
}
