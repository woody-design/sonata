import { Terminal } from "@xterm/headless";
import { SerializeAddon } from "@xterm/addon-serialize";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import type { TerminalReplaySnapshot } from "../../shared/types/ipc";

/**
 * How much rendered scrollback the main-process mirror retains and replays. The
 * live renderer keeps far more (10k); this is the "recent history" a freshly-
 * opened terminal window restores. Bounded so the headless buffer and its
 * serialize stay cheap (measured in tests/smoke/terminal-scrollback.mjs).
 */
const SCROLLBACK_LINES = 1000;

/**
 * A main-process mirror of a task's terminal, kept in a headless xterm so a
 * freshly-opened (or reopened) terminal window can restore recent scrollback by
 * snapshot-then-tail rather than replaying raw PTY bytes. Byte-replay corrupts
 * on resize / alt-buffer / mid-sequence cuts — the path VS Code shipped then
 * abandoned in v1.60, and the same failure as the local "slice A" escape scar.
 * The live PTY stream feeds this continuously (fire-and-forget); on attach we
 * serialize once.
 *
 * Unicode version 11 matches the renderer's width tables so CJK cell math — and
 * therefore the serialized layout — agrees across the two xterms.
 */
export class TerminalScrollback {
  private readonly terminal: Terminal;
  private readonly serializeAddon: SerializeAddon;
  /** Chunks handed to the mirror so far, in ingest (== broadcast) order. The next
   *  chunk's seq is the current value; snapshot() freezes it at the flush marker
   *  so the serialized data and the returned seq name the same boundary. */
  private ingested = 0;

  constructor(cols: number, rows: number) {
    this.terminal = new Terminal({
      cols: normalizeDim(cols, 80),
      rows: normalizeDim(rows, 24),
      scrollback: SCROLLBACK_LINES,
      allowProposedApi: true,
    });
    const unicode = new Unicode11Addon();
    this.terminal.loadAddon(unicode);
    this.terminal.unicode.activeVersion = "11";
    this.serializeAddon = new SerializeAddon();
    this.terminal.loadAddon(this.serializeAddon);
  }

  /** Feed raw PTY output; return the chunk's 0-based seq in ingest order. The
   *  host tags this seq onto the live `pty:data` broadcast so a mid-stream
   *  hydrating renderer can tell which live chunks the snapshot already contains
   *  (write iff seq >= snapshot.seq). Fire-and-forget parse; snapshot() flushes
   *  before it reads. */
  write(data: string): number {
    const seq = this.ingested;
    this.ingested += 1;
    this.terminal.write(data);
    return seq;
  }

  /** Keep the mirror's geometry in lock-step with the PTY so wrapping — and the
   *  serialized layout — matches what the user sees. */
  resize(cols: number, rows: number): void {
    const nextCols = normalizeDim(cols, this.terminal.cols);
    const nextRows = normalizeDim(rows, this.terminal.rows);
    if (nextCols !== this.terminal.cols || nextRows !== this.terminal.rows) {
      this.terminal.resize(nextCols, nextRows);
    }
  }

  /**
   * Snapshot the current buffer for replay into a (re)opening window, tagged with
   * the seq boundary so the renderer can stitch the live tail with no loss and no
   * duplication.
   *
   * serialize() runs INSIDE the flush marker's callback. xterm fires a write
   * callback after that write's predecessors are parsed and before any later-
   * queued chunk is parsed (verified against @xterm/headless 6 — a three-scenario
   * probe incl. an 800KB multi-batch backlog). So `data` reflects exactly the
   * chunks ingested before the marker, and `seq` (frozen at marker-enqueue) is
   * their count. A live chunk is therefore never both absent from `data` and
   * counted by `seq` (no drop), nor present in `data` yet uncounted (no dup):
   * the boundary is captured atomically by construction, not by write-timing.
   */
  snapshot(): Promise<TerminalReplaySnapshot> {
    return new Promise((resolve) => {
      const seq = this.ingested;
      this.terminal.write("", () => {
        resolve({
          data: this.serializeAddon.serialize({ scrollback: SCROLLBACK_LINES }),
          cols: this.terminal.cols,
          rows: this.terminal.rows,
          seq,
        });
      });
    });
  }

  dispose(): void {
    this.terminal.dispose();
  }
}

function normalizeDim(value: number, fallback: number): number {
  const next = Math.floor(Number(value));
  return Number.isFinite(next) && next > 0 ? next : fallback;
}
