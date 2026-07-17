import {
  DEFAULT_READING_SETTINGS,
  isReadingModeSetting,
  type ReadingModeSetting,
} from "./reading-settings";

/**
 * The terminal's own colour-scheme axis. Unlike the main window's reading
 * themes (paper + serif + leading — a *reading* vocabulary), the terminal
 * speaks the terminal world's native vocabulary: a named ANSI colour scheme.
 * "duet" is the hand-authored default palette (the design-system neutral
 * roles); the rest are the classic dual-variant schemes, each shipping an
 * authentic light AND dark palette so every scheme travels across the
 * Light/Dark/Auto mode axis (Ghostty's `light:X,dark:Y` model).
 */
export const TERM_SCHEME_IDS = [
  "duet",
  "catppuccin",
  "gruvbox",
  "solarized",
  "tokyo-night",
  "rose-pine",
] as const;
export type TermSchemeId = (typeof TERM_SCHEME_IDS)[number];

export function isTermSchemeId(value: unknown): value is TermSchemeId {
  return TERM_SCHEME_IDS.includes(value as TermSchemeId);
}

/**
 * The terminal window's own persisted preferences. Kept separate from the
 * global reading settings so the terminal is an independent surface: its own
 * open/closed state, its own colour scheme, and its own light/dark mode.
 * Scheme + mode are orthogonal: scheme is identity, mode is lighting.
 */
export interface TerminalWindowSettings {
  open: boolean;
  scheme: TermSchemeId;
  mode: ReadingModeSetting;
}

export const DEFAULT_TERMINAL_WINDOW_SETTINGS: TerminalWindowSettings = {
  open: true,
  scheme: "duet",
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
    // Pre-scheme records carried a `theme` (reading-theme id) instead — by then
    // a no-op axis; they fall through to the default scheme, which IS the
    // migration.
    scheme: isTermSchemeId(record.scheme)
      ? record.scheme
      : DEFAULT_TERMINAL_WINDOW_SETTINGS.scheme,
    mode: isReadingModeSetting(record.mode) ? record.mode : DEFAULT_TERMINAL_WINDOW_SETTINGS.mode,
  };
}
