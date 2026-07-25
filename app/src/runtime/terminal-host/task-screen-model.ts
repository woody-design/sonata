import { Terminal } from "@xterm/headless";

const DEFAULT_COLS = 120;
const DEFAULT_ROWS = 36;
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

  constructor(cols: number, rows: number) {
    this.term = createTerminal(cols || DEFAULT_COLS, rows || DEFAULT_ROWS);
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

  resize(cols: number, rows: number): void {
    if (this.disposed) {
      return;
    }
    this.term.resize(Math.max(2, cols), Math.max(2, rows));
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

function createTerminal(cols: number, rows: number): Terminal {
  return new Terminal({
    cols,
    rows,
    scrollback: SCROLLBACK_ROWS,
    allowProposedApi: true,
  });
}
