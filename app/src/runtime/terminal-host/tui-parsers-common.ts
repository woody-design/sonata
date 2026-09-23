// ── Pure TUI parsing primitives shared by the claude + codex parser modules ──
// Moved verbatim from terminal-host.ts (consolidation S4). `cleanTerminal` and
// the input-byte constants are the shared substrate the provider parser modules
// and TerminalHost key on; keeping them in one leaf module lets both import them
// without a cycle.

export const ARROW_UP = "\x1b[A";
export const ARROW_DOWN = "\x1b[B";
export const ESC = "\x1b";

const ANSI_RE = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07]*(?:\x07|\x1b\\)|\x1b[@-_]/g;
const CONTROL_RE = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g;

export function cleanTerminal(text: string): string {
  return text
    .replace(ANSI_RE, "")
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .replace(CONTROL_RE, "");
}
