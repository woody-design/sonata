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

  /** Feed raw PTY output. Fire-and-forget: xterm parses asynchronously, and
   *  snapshot() flushes before it reads. */
  write(data: string): void {
    this.terminal.write(data);
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

  /** Snapshot the current buffer for replay into a fresh window. Awaits a flush
   *  so the most recent writes are parsed before serializing. */
  async snapshot(): Promise<TerminalReplaySnapshot> {
    await this.flush();
    return {
      data: this.serializeAddon.serialize({ scrollback: SCROLLBACK_LINES }),
      cols: this.terminal.cols,
      rows: this.terminal.rows,
    };
  }

  dispose(): void {
    this.terminal.dispose();
  }

  private flush(): Promise<void> {
    return new Promise((resolve) => {
      this.terminal.write("", () => resolve());
    });
  }
}

function normalizeDim(value: number, fallback: number): number {
  const next = Math.floor(Number(value));
  return Number.isFinite(next) && next > 0 ? next : fallback;
}
