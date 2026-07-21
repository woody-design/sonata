import { BrowserWindow, screen, type Rectangle } from "electron";
import type { WindowStateStore } from "./settings-store";
import type {
  WindowBoundsState,
  WindowStateDocument,
  WindowStateKey,
} from "../shared/types/window-state";

/** Per-window default geometry, owned by the call site (main.ts). */
export interface WindowDefaults {
  width: number;
  height: number;
  minWidth: number;
  minHeight: number;
}

/**
 * What `restore()` hands the window factory. `bounds` feeds the
 * `BrowserWindow` constructor (the normal, windowed size); `fullScreen` is
 * passed as the constructor's `fullscreen` option so a window last left
 * fullscreen reopens fullscreen with no flicker and no hide-then-show step.
 */
export interface RestoreDecision {
  bounds: Pick<Rectangle, "width" | "height"> & Partial<Pick<Rectangle, "x" | "y">>;
  fullScreen: boolean;
}

export type DefaultWindowBounds = Pick<Rectangle, "x" | "y" | "width" | "height">;

/** Keep at least this many px of the window inside the work area so the title
 *  bar can never end up fully off-screen and ungrabbable. */
const KEEP_VISIBLE_PX = 80;
/** Coalesce disk writes during a drag/resize; in-memory state stays current. */
const PERSIST_DEBOUNCE_MS = 400;

/**
 * Owns cross-launch window geometry for every Sonata window. One concept,
 * expressed once: read saved state on construction, hand validated restore
 * decisions to each window factory, track move/resize/fullscreen changes, and
 * persist (debounced) to a single JSON document.
 *
 * macOS-first: the meaningful "big" state is fullscreen, so only Normal and
 * Fullscreen are modelled (no maximize — that's a Windows/Linux concept and
 * would be inert here). The hard parts, kept honest by following VS Code's and
 * electron-window-state's production implementations:
 *   - Persist *normal* bounds (`getNormalBounds()`), never the fullscreen
 *     rectangle, so leaving fullscreen restores the right size.
 *   - Validate against `workArea` (menu bar / Dock excluded), clamping the
 *     restored rect into its display so it never reopens mostly off-screen, and
 *     discarding-to-default when a saved window lands on no connected display
 *     (e.g. an unplugged external monitor).
 *   - Guard every `screen.*` and disk call — Electron can throw mid display-
 *     reconfig, and a failed geometry write must never crash the app.
 */
export class WindowStateManager {
  private readonly store: WindowStateStore;
  private readonly states: WindowStateDocument;
  private persistTimer: NodeJS.Timeout | null = null;

  constructor(store: WindowStateStore) {
    this.store = store;
    this.states = store.read();
  }

  /** Compute how a window should open, given its saved state and defaults. */
  restore(
    key: WindowStateKey,
    defaults: WindowDefaults,
    firstLaunchBounds?: DefaultWindowBounds,
  ): RestoreDecision {
    const validated = validateWindowState(this.states[key], defaults);
    if (!validated) {
      // A coordinated first-launch placement may be supplied by the startup
      // seam. Otherwise use the standalone default size and let the OS center.
      return {
        bounds: firstLaunchBounds ?? { width: defaults.width, height: defaults.height },
        fullScreen: false,
      };
    }

    const hasBounds =
      typeof validated.x === "number" &&
      typeof validated.y === "number" &&
      typeof validated.width === "number" &&
      typeof validated.height === "number";

    const bounds = hasBounds
      ? { x: validated.x!, y: validated.y!, width: validated.width!, height: validated.height! }
      : { width: defaults.width, height: defaults.height };

    return { bounds, fullScreen: validated.isFullScreen === true };
  }

  /** Whether this key has geometry/flags worth restoring. Used only to keep a
   *  coordinated first-launch layout from moving an existing user's window. */
  hasRestorableState(key: WindowStateKey, defaults: WindowDefaults): boolean {
    return Boolean(validateWindowState(this.states[key], defaults));
  }

  /** Wire a window so its geometry is captured and (debounced) persisted. */
  track(window: BrowserWindow, key: WindowStateKey): void {
    const capture = (): void => this.capture(window, key);

    window.on("resize", capture);
    window.on("move", capture);
    window.on("enter-full-screen", capture);
    window.on("leave-full-screen", capture);
    // Capture once more while the window is still alive, then flush immediately
    // so a force-quit (no `before-quit`) still preserves the final geometry.
    window.on("close", () => {
      this.capture(window, key);
      this.flush();
    });
  }

  /** Write pending state synchronously. Safe to call from `before-quit`. */
  flush(): void {
    if (this.persistTimer) {
      clearTimeout(this.persistTimer);
      this.persistTimer = null;
    }
    this.write();
  }

  private capture(window: BrowserWindow, key: WindowStateKey): void {
    if (window.isDestroyed()) {
      return;
    }

    const fullScreen = window.isFullScreen();
    const next: WindowBoundsState = { ...this.states[key], isFullScreen: fullScreen };

    // Only overwrite the normal bounds when the window is in its normal state;
    // `getNormalBounds()` returns the windowed rect even while fullscreen, so
    // the size to restore to is never lost.
    if (!fullScreen && !window.isMinimized()) {
      const bounds = window.getNormalBounds();
      next.x = bounds.x;
      next.y = bounds.y;
      next.width = bounds.width;
      next.height = bounds.height;
    }

    this.states[key] = next;
    this.scheduleFlush();
  }

  private scheduleFlush(): void {
    if (this.persistTimer) {
      clearTimeout(this.persistTimer);
    }
    this.persistTimer = setTimeout(() => {
      this.persistTimer = null;
      this.write();
    }, PERSIST_DEBOUNCE_MS);
  }

  private write(): void {
    try {
      this.store.write(this.states);
    } catch {
      // A failed geometry write must never crash the app — at worst we lose the
      // last position, which re-validates harmlessly on the next launch.
    }
  }
}

/**
 * Validate saved geometry against the current displays. Returns a usable state
 * (bounds clamped into view, flags preserved) or `undefined` when nothing
 * trustworthy remains. Ported from VS Code's `validateWindowState`:
 *   - reject non-finite / non-positive bounds;
 *   - single display → clamp into the work area (never discard);
 *   - multiple displays → if the rect still overlaps a display's work area,
 *     clamp into that display (so it can't reopen mostly off-screen); else
 *     discard so the caller re-centers on the default;
 *   - a fullscreen-only record with no valid bounds still restores fullscreen.
 */
function validateWindowState(
  state: WindowBoundsState | undefined,
  defaults: WindowDefaults,
  displays = safeGetAllDisplays(),
): WindowBoundsState | undefined {
  if (!state) {
    return undefined;
  }

  const hasValidBounds =
    typeof state.x === "number" &&
    typeof state.y === "number" &&
    typeof state.width === "number" &&
    typeof state.height === "number" &&
    state.width > 0 &&
    state.height > 0;

  if (!hasValidBounds) {
    // No geometry, but a saved fullscreen window can still restore fullscreen
    // onto the default (OS-centered) size.
    return state.isFullScreen ? { isFullScreen: true } : undefined;
  }

  const validated: WindowBoundsState = {
    ...state,
    x: state.x!,
    y: state.y!,
    width: Math.max(state.width!, defaults.minWidth),
    height: Math.max(state.height!, defaults.minHeight),
  };

  if (displays.length === 0) {
    return validated;
  }

  if (displays.length === 1) {
    const area = workingArea(displays[0]!);
    if (area) {
      clampIntoWorkArea(validated, area);
    }
    return validated;
  }

  let display: Electron.Display | undefined;
  try {
    display = screen.getDisplayMatching({
      x: validated.x!,
      y: validated.y!,
      width: validated.width!,
      height: validated.height!,
    });
  } catch {
    display = undefined;
  }

  if (display && overlapsWorkArea(validated, display)) {
    // Overlaps, but a layout / resolution / Dock change may have left only a
    // sliver on-screen. Clamp into the matched display's work area so a
    // restored window is never mostly off-screen — same full-visibility
    // guarantee as the single-display path, restoring the old helper's intent.
    const area = workingArea(display);
    if (area) {
      clampIntoWorkArea(validated, area);
    }
    return validated;
  }

  // Saved window lands on no connected display (e.g. unplugged monitor): drop
  // bounds so the caller falls back to a centered default. Preserve a
  // fullscreen flag so an external-display fullscreen window still reopens
  // fullscreen on the primary.
  return validated.isFullScreen ? { isFullScreen: true } : undefined;
}

/** Shrink an over-large window to the work area, then pull it fully on-screen
 *  if it would otherwise sit (almost) entirely off the right/bottom edge.
 *  Width/height are clamped before x/y so the pull-back can never yield a
 *  negative origin. */
function clampIntoWorkArea(state: WindowBoundsState, area: Rectangle): void {
  if (state.width! > area.width) state.width = area.width;
  if (state.height! > area.height) state.height = area.height;
  if (state.x! < area.x) state.x = area.x;
  if (state.y! < area.y) state.y = area.y;
  if (state.x! > area.x + area.width - KEEP_VISIBLE_PX) {
    state.x = area.x + area.width - state.width!;
  }
  if (state.y! > area.y + area.height - KEEP_VISIBLE_PX) {
    state.y = area.y + area.height - state.height!;
  }
}

function overlapsWorkArea(state: WindowBoundsState, display: Electron.Display): boolean {
  const area = workingArea(display);
  if (!area) {
    return false;
  }
  return (
    state.x! + state.width! > area.x &&
    state.y! + state.height! > area.y &&
    state.x! < area.x + area.width &&
    state.y! < area.y + area.height
  );
}

/** Prefer the work area (menu bar / Dock excluded); fall back to full bounds
 *  when a display transiently reports a zero-sized work area. */
function workingArea(display: Electron.Display): Rectangle | undefined {
  if (display.workArea.width > 0 && display.workArea.height > 0) {
    return display.workArea;
  }
  if (display.bounds.width > 0 && display.bounds.height > 0) {
    return display.bounds;
  }
  return undefined;
}

function safeGetAllDisplays(): Electron.Display[] {
  try {
    return screen.getAllDisplays();
  } catch {
    return [];
  }
}
