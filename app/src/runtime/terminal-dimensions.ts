/**
 * THE clamp for terminal geometry — one function, one place.
 *
 * A task's geometry fans out to four mirrors that must agree exactly: the PTY
 * itself, the rendered-scrollback mirror (`TerminalScrollback`), the approval /
 * control-switch grid (`TaskScreenModel`), and the status-region grid
 * (`StatusRegionTracker`). They agree only if every one of them is handed the
 * SAME numbers.
 *
 * WHY THIS IS A TYPE AND NOT A CONVENTION (SL-9). Before this module each
 * mirror defended itself with its own rule — `Number(cols) || DEFAULT_COLS` at
 * the host, `Math.floor` + fall-back-to-current in the scrollback mirror,
 * `Math.max(2, …)` inside both grids. Three different clamps over one value is
 * a structural path to divergence, and the failure it produces is silent: a
 * grid that is a few columns off wraps text at different points, so
 * `viewportText()` cuts lines differently, so the consent / rewind predicates
 * that key on those lines read false while the dialog is on screen — the SL-2
 * failure mode through another entrance.
 *
 * MEASURED, NOT THEORETICAL — and the divergence was not even the quiet kind.
 * EVERY leg of the fan-out throws on some un-clamped input: node-pty's `resize`
 * rejects `cols <= 0` / NaN / Infinity (unixTerminal.js), and @xterm's
 * `Terminal.resize` rejects NaN, Infinity and any non-integer
 * (`_verifyIntegers`). The host's old `Number(cols) || DEFAULT_COLS` passed
 * negatives and fractions straight through, and the PTY leg runs FIRST — so a
 * single bad resize threw MID-FAN-OUT, after the PTY had moved and before the
 * grids had, leaving them skewed until the next resize. Un-clamped input was
 * therefore never survivable anywhere; the clamp is what makes the never-throw
 * discipline hold, not the mirrors' tolerance.
 *
 * `TerminalDimensions` is branded, so `normalizeTerminalDimensions` is the only
 * way to obtain one and every mirror's `resize` demands one. The invariant is
 * therefore checked by `tsc`, not by review attention — the repo's own pattern
 * (the import fence is a smoke, not a doc; the codex profile is sha-pinned, not
 * "remember to keep it stable").
 */

/** The geometry a task boots at when the caller offers nothing usable. Not
 *  exported: "what should this default to" is this module's question, and a
 *  second reader of the constant would be a second place geometry is decided. */
const DEFAULT_COLS = 120;
const DEFAULT_ROWS = 36;

/**
 * The floor a REAL but degenerate value is raised to (as opposed to garbage,
 * which falls back to the defaults above). Chosen as the strictest of the three
 * consumers' pre-SL-9 floors: measured against @xterm/headless 6.0.0, an
 * INTEGER below the minimum is clamped internally (`resize(0, 0)` and
 * `resize(-5, -5)` both land on 2x1 — MINIMUM_COLS 2, MINIMUM_ROWS 1); node-pty
 * throws below 1; and both grids used to apply `Math.max(2, …)`. Taking 2 for
 * both keeps the grids byte-identical to their old behaviour and lifts the PTY
 * and the scrollback mirror to the same floor instead of letting them sit lower.
 */
const MIN_COLS = 2;
const MIN_ROWS = 2;

declare const normalized: unique symbol;

/**
 * Terminal geometry that has passed the single clamp. The brand exists only in
 * the type system (nothing is emitted at runtime); its whole job is to make
 * "resize a mirror off un-clamped numbers" un-writable.
 */
export interface TerminalDimensions {
  readonly cols: number;
  readonly rows: number;
  readonly [normalized]: true;
}

/**
 * Clamp once, at the fan-out. Garbage (non-numeric, NaN, Infinity, zero,
 * negative) falls back to the documented default — the caller told us nothing
 * usable, so a sane default is the honest answer. A real but degenerate value
 * (a 1-column window) is raised to the floor rather than replaced by the
 * default: reporting 120 columns to a CLI that has one would be a lie, while
 * reporting 2 is merely a rounding of an unusable window.
 *
 * Fractions are floored HERE because no mirror tolerates them: node-pty stores
 * 120.5 as given, while `@xterm`'s `Terminal.resize` THROWS on any non-integer
 * (`_verifyIntegers`: "This API only accepts integers") and its constructor
 * accepts one only to crash deeper in buffer allocation — both measured against
 * 6.0.0. So pre-SL-9 a fractional resize was not a quiet skew: the PTY moved,
 * the scrollback mirror floored itself to 120, and the approval grid THREW
 * mid-fan-out, leaving it and the status grid at the old size.
 *
 * Idempotent by construction: `normalize(normalize(x))` deep-equals
 * `normalize(x)`, which is what lets a re-normalization at a second fan-in
 * (the `task:started` payload, whose numbers crossed an event boundary and lost
 * the brand) be provably identity rather than a second, competing clamp.
 */
export function normalizeTerminalDimensions(cols: unknown, rows: unknown): TerminalDimensions {
  return {
    cols: normalizeDimension(cols, MIN_COLS, DEFAULT_COLS),
    rows: normalizeDimension(rows, MIN_ROWS, DEFAULT_ROWS),
  } as TerminalDimensions;
}

function normalizeDimension(value: unknown, min: number, fallback: number): number {
  const floored = Math.floor(Number(value));
  if (!Number.isFinite(floored) || floored <= 0) {
    return fallback;
  }
  return Math.max(floored, min);
}
