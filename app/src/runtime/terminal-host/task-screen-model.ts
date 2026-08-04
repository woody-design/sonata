import { Terminal } from "@xterm/headless";
import type { TerminalDimensions } from "../terminal-dimensions";

/**
 * MEASURED, not assumed (SL-9). The standing rule (D-1 refinement 4) says a
 * grid consumer that needs scrollback is a channel-misuse smell, and the clean
 * way to make that rule PHYSICAL would be `scrollback: 0` — misuse then gets no
 * data instead of quietly working. The A/B probe says no: `scrollback: 0` is a
 * behaviour change, not a fence.
 *
 * `dev/spikes/upstream-sync-2026-08/scrollback-ab/` runs two emulators built to
 * these exact conventions, differing only in `scrollback`, over 81 viewport
 * comparisons. Reading the VIEWPORT, 0 and 80 are byte-identical on every
 * measured codex 0.146.0 stream (boot, consent, model walk, a worked turn) and
 * on an alt-screen wrapper. They diverge in exactly one place: xterm's resize
 * REFLOW re-wraps lines out of, and pulls them back from, the scrollback ring,
 * so a 0-row ring lands a different top row after a narrow and different
 * content after a row-grow. The skew is a WINDOW — the TUI's own repaint after
 * SIGWINCH converges both — but inside that window the 80-row emulator is the
 * one that tracks the user's real terminal (renderer xterm, 10k scrollback),
 * and the window is exactly when a resized dialog is being re-read.
 *
 * So the ring stays. It is not scrollback the consumers READ — no code reads a
 * buffer line above `viewportY` (machine-checked in
 * `tests/smoke/terminal-grid-substrate.mjs`, which also pins this constant to
 * the reasoning above) — it is reflow fidelity. The standing rule stays prose,
 * with a machine behind it.
 */
const SCROLLBACK_ROWS = 80;

/**
 * A per-task headless screen model: an `@xterm/headless` emulator fed the raw
 * PTY stream so the approval detector can read the RECONSTRUCTED SCREEN instead
 * of the raw byte tail. Rhymes with `StatusRegionTracker`'s emulator (same
 * `createTerminal` conventions, same viewport extraction) but is a distinct
 * instance owned by `TerminalHost` — consolidating the two emulators per task is
 * deferred (PTY S4b scope note; acceptable at batch cadence).
 *
 * WHY a screen, not a stream (S4a probe): cursor-addressed TUIs repaint
 * incrementally; the raw tail accumulates every partial repaint (46 distinct
 * fingerprints for ONE panel) and retains an answered panel's bytes long after
 * it left the screen. The grid converges to the CURRENT screen regardless of
 * paint order (46→2), so a panel is detected while it is displayed and vanishes
 * when the TUI repaints past it — the semantically-correct source.
 *
 * ASYNC-WRITE / QUERY CONSISTENCY: `@xterm` parses each `write()` through an
 * internal `WriteBuffer` that can defer a large write across event-loop turns,
 * so a naive read could race an in-flight parse. Two guarantees make the query
 * safe:
 *   1. JS run-to-completion — a reader on the main thread never interleaves with
 *      the parser loop, and the `WriteBuffer` only ever yields at a complete
 *      parse boundary (between sequences, never mid-escape). So ANY read sees a
 *      consistent PREFIX of the byte stream — stale-but-consistent, never torn.
 *   2. `whenSettled()` defers its callback until every issued write has drained
 *      (`pendingWrites` → 0), so the detector reads the COMPLETE settled grid,
 *      not merely a consistent prefix. It runs synchronously when nothing is
 *      pending — the common case, because a waiting panel is quiescent (S4b
 *      step-0 capture measured ZERO output while a panel waits, so nothing is in
 *      flight by the time the trailing scan fires).
 */
export class TaskScreenModel {
  private term: Terminal;
  private pendingWrites = 0;
  private drainWaiters: Array<() => void> = [];
  private disposed = false;

  constructor(dimensions: TerminalDimensions) {
    this.term = createTerminal(dimensions);
  }

  /** Feed one PTY batch (the S3 coalesced batch — one write per batch). */
  write(data: string): void {
    if (this.disposed || data.length === 0) {
      // An empty write would still increment pendingWrites and rely on xterm
      // invoking the callback — skip it so the drain counter cannot leak.
      return;
    }
    this.pendingWrites += 1;
    this.term.write(data, () => this.onWriteDrained());
  }

  private onWriteDrained(): void {
    this.pendingWrites -= 1;
    if (this.pendingWrites > 0 || this.drainWaiters.length === 0) {
      return;
    }
    const waiters = this.drainWaiters;
    this.drainWaiters = [];
    for (const fn of waiters) {
      fn();
    }
  }

  /**
   * Run `fn` once every issued write has drained into the buffer — synchronously
   * when nothing is pending (the quiescent-panel common case), else after the
   * last pending write's parse callback fires. Guarantees `fn` reads a COMPLETE,
   * non-torn grid. A `fn` that arms new writes is fine: those raise
   * `pendingWrites` again, so the next `whenSettled` still waits them out.
   */
  whenSettled(fn: () => void): void {
    if (this.disposed) {
      return;
    }
    if (this.pendingWrites === 0) {
      fn();
      return;
    }
    this.drainWaiters.push(fn);
  }

  /**
   * The visible viewport rows joined with "\n" — the exact shape the approval
   * parser wants (S4a probe: `rows.join("\n")` parses identically to a clean raw
   * parse; the parser's internal `cleanTerminal` is a near-noop on plain grid
   * rows). Verbatim extraction from `StatusRegionTracker.visibleRows()`.
   * `buffer.active` follows the alt-screen switch automatically, so a panel
   * painted in the alternate buffer (S4a Q2: definitively alt-screen) is read
   * with no scrollback stitch.
   */
  viewportText(): string {
    const buffer = this.term.buffer.active;
    const rows: string[] = [];
    for (let y = 0; y < this.term.rows; y++) {
      const line = buffer.getLine(buffer.viewportY + y);
      rows.push(line ? line.translateToString(true) : "");
    }
    return rows.join("\n");
  }

  /**
   * Follow the PTY's geometry. NO clamp of its own (SL-9): the dimensions
   * arrive already through `normalizeTerminalDimensions`, and a second,
   * differently-worded clamp here is precisely how this grid would drift out of
   * step with the PTY that the CLI is wrapping its text to.
   */
  resize(dimensions: TerminalDimensions): void {
    if (this.disposed) {
      return;
    }
    this.term.resize(dimensions.cols, dimensions.rows);
  }

  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.drainWaiters = [];
    this.term.dispose();
  }
}

function createTerminal({ cols, rows }: TerminalDimensions): Terminal {
  return new Terminal({
    cols,
    rows,
    scrollback: SCROLLBACK_ROWS,
    allowProposedApi: true,
  });
}
