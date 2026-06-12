import { Terminal } from "@xterm/headless";
import type { RuntimeProvider, TaskId } from "../../shared/types/domain";
import type { RuntimeEvent } from "../../shared/types/events";
import type { NativeStatusRegion } from "../../shared/types/working-status";

const SAMPLE_THROTTLE_MS = 300;
const DEFAULT_COLS = 120;
const DEFAULT_ROWS = 36;
const SCROLLBACK_ROWS = 80;
const MAX_SUB_LINES = 2;
const TROUBLE_SCAN_ROWS = 8;

const CLAUDE_STATUS_GLYPHS = ["✢", "✳", "✶", "✻", "✽", "·"];
const CODEX_STATUS_PATTERN = /esc to interrupt/i;
const TROUBLE_PATTERNS = [/retrying in .*attempt\s+\d+\s*\/\s*\d+/i, /unable to connect to api/i, /api error/i];

export interface StatusRegionTrackerOptions {
  taskId: TaskId;
  provider: RuntimeProvider;
  eventSink: (event: RuntimeEvent) => void;
}

/**
 * Relays the provider's native status region (spinner line, ⎿ sub-lines,
 * failure-signature lines) from a headless screen model fed by the raw PTY
 * stream. Chunk-level regex is NOT viable — the TUIs repaint incrementally
 * (probe findings 2026-06-11) — so the screen model is the only honest
 * reconstruction. Emission is gated on run liveness: outside an active run
 * the region is null, which keeps end-of-turn summary lines ("✻ Cogitated
 * for 49s") from relaying forever at idle.
 */
export class StatusRegionTracker {
  private readonly taskId: TaskId;
  private readonly provider: RuntimeProvider;
  private readonly eventSink: (event: RuntimeEvent) => void;
  private term: Terminal;
  private sampleTimer: NodeJS.Timeout | null = null;
  private runActive = false;
  // Fingerprint of the last emitted region; "" = null region (the initial
  // state), so a boot-time sample emits nothing until content appears.
  private lastEmitted = "";
  private disposed = false;

  constructor(options: StatusRegionTrackerOptions) {
    this.taskId = options.taskId;
    this.provider = options.provider;
    this.eventSink = options.eventSink;
    this.term = createTerminal(DEFAULT_COLS, DEFAULT_ROWS);
  }

  handleRuntimeEvent(event: RuntimeEvent): void {
    if (this.disposed) {
      return;
    }
    switch (event.type) {
      case "task:started":
        this.reset(event.payload.cols, event.payload.rows);
        return;
      case "pty:data":
        this.term.write(event.payload.data, () => this.scheduleSample());
        return;
      case "pty:exit":
        this.runActive = false;
        this.emitIfChanged(null);
        return;
      case "run:started":
        this.runActive = true;
        this.scheduleSample();
        return;
      case "run:updated":
        if (["completed", "failed", "stopped", "approval-denied", "pty-exited"].includes(event.payload.status)) {
          this.runActive = false;
          this.emitIfChanged(null);
        }
        return;
      default:
        return;
    }
  }

  resize(cols: number, rows: number): void {
    if (this.disposed) {
      return;
    }
    this.term.resize(Math.max(2, cols), Math.max(2, rows));
  }

  dispose(): void {
    this.disposed = true;
    this.clearSampleTimer();
    this.term.dispose();
  }

  private reset(cols: number, rows: number): void {
    this.clearSampleTimer();
    this.term.dispose();
    this.term = createTerminal(cols || DEFAULT_COLS, rows || DEFAULT_ROWS);
    this.runActive = false;
    this.emitIfChanged(null);
  }

  private scheduleSample(): void {
    if (this.disposed || this.sampleTimer) {
      return;
    }
    this.sampleTimer = setTimeout(() => {
      this.sampleTimer = null;
      this.emitIfChanged(this.runActive ? this.extract() : null);
    }, SAMPLE_THROTTLE_MS);
  }

  private clearSampleTimer(): void {
    if (this.sampleTimer) {
      clearTimeout(this.sampleTimer);
      this.sampleTimer = null;
    }
  }

  private emitIfChanged(native: NativeStatusRegion | null): void {
    const fingerprint = native === null ? "" : JSON.stringify(native);
    if (fingerprint === this.lastEmitted) {
      return;
    }
    this.lastEmitted = fingerprint;
    this.eventSink({
      type: "working-status:updated",
      payload: {
        taskId: this.taskId,
        native,
        capturedAt: new Date().toISOString(),
      },
      ts: new Date().toISOString(),
    });
  }

  private extract(): NativeStatusRegion | null {
    const rows = this.visibleRows();
    const statusIndex = this.findStatusLine(rows);
    if (statusIndex === -1) {
      return null;
    }

    const subLines: string[] = [];
    for (let i = statusIndex + 1; i < rows.length && subLines.length < MAX_SUB_LINES; i++) {
      const text = rows[i]?.trim() ?? "";
      if (!text.startsWith("⎿")) {
        break;
      }
      subLines.push(text);
    }

    const troubleLines: string[] = [];
    const scanFrom = Math.max(0, statusIndex - TROUBLE_SCAN_ROWS);
    for (let i = scanFrom; i < statusIndex; i++) {
      const text = rows[i]?.trim() ?? "";
      if (!text) {
        continue;
      }
      if (TROUBLE_PATTERNS.some((pattern) => pattern.test(text))) {
        // Include the ⎿ lead-in line above the match when it is part of the
        // same failure cluster (e.g. "⎿ Unable to connect…" before
        // "Retrying in Ns · attempt x/y").
        const previous = rows[i - 1]?.trim() ?? "";
        if (
          previous.startsWith("⎿") &&
          !troubleLines.includes(previous) &&
          !TROUBLE_PATTERNS.some((pattern) => pattern.test(previous))
        ) {
          troubleLines.push(previous);
        }
        troubleLines.push(text);
      }
    }

    return {
      line: rows[statusIndex]?.trim() ?? "",
      subLines,
      troubleLines,
    };
  }

  private findStatusLine(rows: string[]): number {
    for (let i = rows.length - 1; i >= 0; i--) {
      const text = rows[i]?.trim() ?? "";
      if (!text) {
        continue;
      }
      if (this.provider === "claude") {
        if (CLAUDE_STATUS_GLYPHS.some((glyph) => text.startsWith(`${glyph} `))) {
          return i;
        }
      } else if (CODEX_STATUS_PATTERN.test(text)) {
        return i;
      }
    }
    return -1;
  }

  private visibleRows(): string[] {
    const buffer = this.term.buffer.active;
    const rows: string[] = [];
    for (let y = 0; y < this.term.rows; y++) {
      const line = buffer.getLine(buffer.viewportY + y);
      rows.push(line ? line.translateToString(true) : "");
    }
    return rows;
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
