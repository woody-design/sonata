// ── Pure TUI parsing primitives shared by the claude + codex parser modules ──
// Moved verbatim from terminal-host.ts (consolidation S4). `cleanTerminal` and
// the input-byte constants are the shared substrate every mid-session-switch
// parser and the ControlSwitchEngine keys on; keeping them in one leaf module
// lets both provider parser modules and the engine import them without a cycle.

export const ARROW_UP = "\x1b[A";
export const ARROW_DOWN = "\x1b[B";
export const ESC = "\x1b";
/** Shift+Tab (CSI Z / back-tab) — cycles Claude's permission mode (probe:
 *  manual → accept edits → plan → auto → manual). The ONLY byte the permission
 *  stepping engine ever writes (S2 RED LINE). */
export const SHIFT_TAB = "\x1b[Z";
/** Ctrl+U — kill-line in both CLIs' composers. Idempotent on an empty line
 *  (probe C2/C6/X2, claude 2.1.212 + codex 0.144.5); per-LINE on Claude, so
 *  multi-line clears send a counted flood (see cliInputClearFlood). */
export const KILL_LINE = "\x15";

const ANSI_RE = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07]*(?:\x07|\x1b\\)|\x1b[@-_]/g;
const CONTROL_RE = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g;

export function cleanTerminal(text: string): string {
  return text
    .replace(ANSI_RE, "")
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .replace(CONTROL_RE, "");
}
