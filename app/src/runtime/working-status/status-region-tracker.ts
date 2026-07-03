import { Terminal } from "@xterm/headless";
import type { RuntimeProvider, TaskId } from "../../shared/types/domain";
import type { RuntimeEvent } from "../../shared/types/events";
import type { NativeStatusRegion, WorkingLiveness } from "../../shared/types/working-status";

const SAMPLE_THROTTLE_MS = 300;
const LIVENESS_CHECK_MS = 5_000;
const DEFAULT_QUIET_AFTER_MS = 20_000;
const DEFAULT_SILENT_AFTER_MS = 60_000;
const DEFAULT_COLS = 120;
const DEFAULT_ROWS = 36;
const SCROLLBACK_ROWS = 80;
// Safety cap only — the mirror follows whatever the CLI paints (a todo
// sub-block is routinely 4-6 rows); the old cap of 2 was an artifact of the
// pre-S5 working-detail row's cramped home inside a turn card.
const MAX_SUB_LINES = 8;
const TROUBLE_SCAN_ROWS = 8;

const CLAUDE_STATUS_GLYPHS = ["✢", "✳", "✶", "✻", "✽", "·"];
const CODEX_STATUS_PATTERN = /esc to interrupt/i;
const TROUBLE_PATTERNS = [/retrying in .*attempt\s+\d+\s*\/\s*\d+/i, /unable to connect to api/i, /api error/i];

export interface StatusRegionTrackerOptions {
  taskId: TaskId;
  provider: RuntimeProvider;
  eventSink: (event: RuntimeEvent) => void;
  /** Test injection points; production uses the 20s/60s defaults. */
  quietAfterMs?: number;
  silentAfterMs?: number;
  livenessCheckMs?: number;
}

/**
 * Relays the provider's native status region (spinner line, ⎿ sub-lines,
 * failure-signature lines) from a headless screen model fed by the raw PTY
 * stream. Chunk-level regex is NOT viable — the TUIs repaint incrementally
 * (probe findings 2026-06-11) — so the screen model is the only honest
 * reconstruction. Emission is gated on run liveness: outside an active run
 * the region is null, which keeps end-of-turn summary lines ("✻ Cogitated
 * for 49s") from relaying forever at idle.
 *
 * Contract §3.1 fence #1 — DISPLAY-ONLY scrape (permanent citizen). Its
 * output feeds the status strip, sidebar liveness, and the run-index
 * allowlist entry; nothing derives busy/idle STATE from it (that is
 * cli-state, hooks-primary). If a TUI redesign breaks the glyph constants
 * below, a string goes stale on screen — nothing wedges, nothing acts.
 */
export class StatusRegionTracker {
  private readonly taskId: TaskId;
  private readonly provider: RuntimeProvider;
  private readonly eventSink: (event: RuntimeEvent) => void;
  private term: Terminal;
  private sampleTimer: NodeJS.Timeout | null = null;
  private livenessTimer: NodeJS.Timeout | null = null;
  private readonly quietAfterMs: number;
  private readonly silentAfterMs: number;
  private readonly livenessCheckMs: number;
  private runActive = false;
  private approvalPending = false;
  private lastDataAt = 0;
  private liveness: WorkingLiveness = "fresh";
  // Fingerprint of the last emitted state ("<liveness>|<region json>");
  // initialized to the boot state (fresh, null region) so boot-time samples
  // emit nothing until content appears.
  private lastEmitted = "fresh|";
  private disposed = false;

  constructor(options: StatusRegionTrackerOptions) {
    this.taskId = options.taskId;
    this.provider = options.provider;
    this.eventSink = options.eventSink;
    this.quietAfterMs = options.quietAfterMs ?? DEFAULT_QUIET_AFTER_MS;
    this.silentAfterMs = options.silentAfterMs ?? DEFAULT_SILENT_AFTER_MS;
    this.livenessCheckMs = options.livenessCheckMs ?? LIVENESS_CHECK_MS;
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
        this.lastDataAt = Date.now();
        if (this.liveness !== "fresh") {
          // Evidence resumed — self-heal without residue.
          this.setLiveness("fresh");
        }
        this.term.write(event.payload.data, () => this.scheduleSample());
        return;
      case "pty:exit":
        this.stopRunTracking();
        return;
      case "run:started":
        this.runActive = true;
        // A run can only start when no approval is pending (delivery is
        // gated on it) — clears any stale flag from reentrant event order.
        this.approvalPending = false;
        this.lastDataAt = Date.now();
        this.scheduleSample();
        this.startLivenessTimer();
        return;
      case "run:updated":
        if (["completed", "failed", "stopped", "approval-denied", "pty-exited"].includes(event.payload.status)) {
          this.stopRunTracking();
        }
        return;
      case "approval:detected":
        // Waiting for the user is not the agent stalling — pause the clock.
        this.approvalPending = true;
        this.setLiveness("fresh");
        return;
      case "approval:decision":
        this.approvalPending = false;
        this.lastDataAt = Date.now();
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
    this.clearLivenessTimer();
    this.term.dispose();
  }

  private reset(cols: number, rows: number): void {
    this.clearSampleTimer();
    this.term.dispose();
    this.term = createTerminal(cols || DEFAULT_COLS, rows || DEFAULT_ROWS);
    this.stopRunTracking();
  }

  private stopRunTracking(): void {
    this.runActive = false;
    this.approvalPending = false;
    this.clearLivenessTimer();
    this.liveness = "fresh";
    this.emitIfChanged(null);
  }

  private startLivenessTimer(): void {
    this.clearLivenessTimer();
    this.livenessTimer = setInterval(() => this.evaluateLiveness(), this.livenessCheckMs);
  }

  private clearLivenessTimer(): void {
    if (this.livenessTimer) {
      clearInterval(this.livenessTimer);
      this.livenessTimer = null;
    }
  }

  private evaluateLiveness(): void {
    if (this.disposed || !this.runActive || this.approvalPending) {
      return;
    }
    const silenceMs = Date.now() - this.lastDataAt;
    const next: WorkingLiveness =
      silenceMs >= this.silentAfterMs ? "silent" : silenceMs >= this.quietAfterMs ? "quiet" : "fresh";
    if (next !== this.liveness) {
      this.setLiveness(next);
    }
  }

  private setLiveness(next: WorkingLiveness): void {
    this.liveness = next;
    // Force an emission with the current region — liveness changed even if
    // the native content did not (it cannot: silence means no repaints).
    this.lastEmitted = "\u0000force";
    this.emitIfChanged(this.runActive ? this.extractSafe() : null);
  }

  private extractSafe(): NativeStatusRegion | null {
    try {
      return this.extract();
    } catch {
      return null;
    }
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
    const fingerprint = `${this.liveness}|${native === null ? "" : JSON.stringify(native)}`;
    if (fingerprint === this.lastEmitted) {
      return;
    }
    this.lastEmitted = fingerprint;
    this.eventSink({
      type: "working-status:updated",
      payload: {
        taskId: this.taskId,
        native,
        liveness: this.liveness,
        silentSince: this.liveness === "fresh" ? null : new Date(this.lastDataAt).toISOString(),
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
      const raw = rows[i] ?? "";
      const text = raw.trim();
      if (!text) {
        break; // a blank row ends the region
      }
      if (text.startsWith("⎿")) {
        subLines.push(text);
        continue;
      }
      // Multi-row sub-blocks (todo lists) carry ⎿ on their FIRST row only;
      // the remaining rows are indented siblings ("  ✔ done", "  ■ current").
      // Requiring ⎿ on every row relayed exactly one sub-task (Woody,
      // 2026-07-03). An indented row after at least one ⎿ row continues the
      // block; a column-0 row (composer border, footer) starts a new one.
      if (subLines.length > 0 && /^\s/.test(raw)) {
        subLines.push(text);
        continue;
      }
      break;
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
