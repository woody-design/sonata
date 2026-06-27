export const WINDOW_STATE_KEYS = ["main", "preview", "inspector"] as const;
export type WindowStateKey = (typeof WINDOW_STATE_KEYS)[number];

/**
 * One window's persisted geometry. `x/y/width/height` are the *normal*
 * (windowed) bounds — never the on-screen rectangle of a fullscreen window — so
 * leaving fullscreen restores the right size. `isFullScreen` rides alongside as
 * an independent flag. Every field is optional: a partial/legacy document
 * degrades to defaults rather than crashing.
 */
export interface WindowBoundsState {
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  isFullScreen?: boolean;
}

/** The whole on-disk document: one entry per tracked window. */
export type WindowStateDocument = Partial<Record<WindowStateKey, WindowBoundsState>>;

export function normalizeWindowStateDocument(value: unknown): WindowStateDocument {
  if (!isRecord(value)) {
    return {};
  }

  const result: WindowStateDocument = {};
  for (const key of WINDOW_STATE_KEYS) {
    const entry = normalizeWindowBoundsState(value[key]);
    if (entry) {
      result[key] = entry;
    }
  }
  return result;
}

function normalizeWindowBoundsState(value: unknown): WindowBoundsState | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  const state: WindowBoundsState = {};
  if (isFiniteNumber(value.x)) state.x = value.x;
  if (isFiniteNumber(value.y)) state.y = value.y;
  if (isFiniteNumber(value.width) && value.width > 0) state.width = value.width;
  if (isFiniteNumber(value.height) && value.height > 0) state.height = value.height;
  if (typeof value.isFullScreen === "boolean") state.isFullScreen = value.isFullScreen;

  return Object.keys(state).length > 0 ? state : undefined;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
