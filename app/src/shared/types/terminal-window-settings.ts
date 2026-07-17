import {
  DEFAULT_READING_SETTINGS,
  isReadingModeSetting,
  type ReadingModeSetting,
} from "./reading-settings";

/**
 * The terminal's own colour-scheme axis. Unlike the main window's reading
 * themes (paper + serif + leading — a *reading* vocabulary), the terminal
 * speaks the terminal world's native vocabulary: a named ANSI colour scheme.
 * "sonata" is the hand-authored default palette (the design-system neutral
 * roles); the rest are the classic dual-variant schemes, each shipping an
 * authentic light AND dark palette so every scheme travels across the
 * Light/Dark/Auto mode axis (Ghostty's `light:X,dark:Y` model).
 */
export const TERM_SCHEME_IDS = [
  "sonata",
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
 * The terminal's text-size steps (px). 13 is the baseline (Ghostty's macOS
 * default, the pre-M2 hardcoded value); the range brackets it one readable
 * notch further each way than the extremes people actually run terminals at.
 * A preset ladder, not a free number, mirroring the reading textStep model.
 */
export const TERM_FONT_SIZES = [11, 12, 13, 14, 15, 16] as const;
export type TermFontSize = (typeof TERM_FONT_SIZES)[number];

export function isTermFontSize(value: unknown): value is TermFontSize {
  return TERM_FONT_SIZES.includes(value as TermFontSize);
}

/**
 * The terminal window's own persisted preferences. Kept separate from the
 * global reading settings so the terminal is an independent surface: its own
 * open/closed state, its own colour scheme, its own light/dark mode, and its
 * own text size. Scheme + mode are orthogonal: scheme is identity, mode is
 * lighting.
 */
export interface TerminalWindowSettings {
  open: boolean;
  scheme: TermSchemeId;
  mode: ReadingModeSetting;
  fontSize: TermFontSize;
}

export const DEFAULT_TERMINAL_WINDOW_SETTINGS: TerminalWindowSettings = {
  open: true,
  scheme: "sonata",
  mode: DEFAULT_READING_SETTINGS.mode,
  fontSize: 13,
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
    fontSize: isTermFontSize(record.fontSize)
      ? record.fontSize
      : DEFAULT_TERMINAL_WINDOW_SETTINGS.fontSize,
  };
}
