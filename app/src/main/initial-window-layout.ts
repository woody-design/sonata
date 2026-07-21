export interface WorkArea {
  x: number;
  y: number;
  width: number;
  height: number;
}

export type InitialWindowBounds = WorkArea;

export interface InitialWindowPair {
  main: InitialWindowBounds;
  terminal: InitialWindowBounds;
}

/**
 * First-launch baseline at a 1920-DIP work area: 1200px for the primary
 * reading surface, 680px for the supporting CLI, an 8px seam, and 16px outer
 * margins. Electron window geometry is expressed in DIP, so this scales with
 * macOS/Windows display settings rather than physical panel pixels.
 */
const TARGET_MAIN_WIDTH = 1200;
const TARGET_TERMINAL_WIDTH = 680;
const TARGET_HEIGHT = 820;
const WINDOW_GAP = 8;
const OUTER_MARGIN = 16;

// Below these widths the two surfaces stop being meaningfully usable. These
// are first-launch layout floors, not BrowserWindow resize constraints.
const MIN_MAIN_WIDTH = 720;
const MIN_TERMINAL_WIDTH = 420;
const MIN_HEIGHT = 640;

/**
 * Lay out Sonata's two default-on surfaces as one centered workspace.
 *
 * The pair shrinks proportionally on the common 1280/1366/1536-DIP classes,
 * while preserving the reading surface's roughly 64% priority. On a work area
 * too small for two useful windows, return undefined and let the OS place the
 * normal standalone defaults instead of manufacturing two unusable slivers.
 */
export function planInitialWindowPair(workArea: WorkArea): InitialWindowPair | undefined {
  if (!isUsableWorkArea(workArea)) {
    return undefined;
  }

  const availableWindowWidth = workArea.width - OUTER_MARGIN * 2 - WINDOW_GAP;
  const availableWindowHeight = workArea.height - OUTER_MARGIN * 2;
  if (
    availableWindowWidth < MIN_MAIN_WIDTH + MIN_TERMINAL_WIDTH ||
    availableWindowHeight < MIN_HEIGHT
  ) {
    return undefined;
  }

  const targetWindowWidth = TARGET_MAIN_WIDTH + TARGET_TERMINAL_WIDTH;
  const pairWindowWidth = Math.min(targetWindowWidth, availableWindowWidth);
  const mainShare = TARGET_MAIN_WIDTH / targetWindowWidth;
  const proportionalMainWidth = Math.round(pairWindowWidth * mainShare);
  const mainWidth = clamp(
    proportionalMainWidth,
    MIN_MAIN_WIDTH,
    pairWindowWidth - MIN_TERMINAL_WIDTH,
  );
  const terminalWidth = pairWindowWidth - mainWidth;
  const height = Math.min(TARGET_HEIGHT, availableWindowHeight);
  const pairWidth = mainWidth + WINDOW_GAP + terminalWidth;
  const x = workArea.x + Math.floor((workArea.width - pairWidth) / 2);
  const y = workArea.y + OUTER_MARGIN;

  return {
    main: { x, y, width: mainWidth, height },
    terminal: { x: x + mainWidth + WINDOW_GAP, y, width: terminalWidth, height },
  };
}

function isUsableWorkArea(workArea: WorkArea): boolean {
  return [workArea.x, workArea.y, workArea.width, workArea.height].every(Number.isFinite) &&
    workArea.width > 0 &&
    workArea.height > 0;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(Math.max(value, minimum), maximum);
}
