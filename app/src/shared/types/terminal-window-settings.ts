/**
 * The terminal window's own persisted preferences. Kept separate from the
 * global reading settings because the terminal window is an independent surface
 * with its own lifecycle and (from a later slice) its own theme. For now it
 * holds one thing: whether the window is open. Default-on — a fresh install
 * shows the terminal beside the conversation, and the choice is remembered
 * across launches.
 */
export interface TerminalWindowSettings {
  open: boolean;
}

export const DEFAULT_TERMINAL_WINDOW_SETTINGS: TerminalWindowSettings = {
  open: true,
};

export function normalizeTerminalWindowSettings(value: unknown): TerminalWindowSettings {
  if (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { open?: unknown }).open === "boolean"
  ) {
    return { open: (value as { open: boolean }).open };
  }
  return { ...DEFAULT_TERMINAL_WINDOW_SETTINGS };
}
