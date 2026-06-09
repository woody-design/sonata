import type { RuntimeProvider } from "./types/domain";

const ANSI_RE = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07]*(?:\x07|\x1b\\)|\x1b[@-_]/g;
const CONTROL_RE = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g;

const COMPACT_CHROME_HINTS = [
  "pasteagaintoexpand",
  "esctointerrupt",
  "presstescto",
  "shifttab",
  "ctrlc",
  "try",
];

const CHROME_LINE_PATTERNS = [
  /^esc\b/i,
  /^press\b/i,
  /^paste again\b/i,
  /^again$/i,
  /^expand$/i,
  /^shift\s*\+\s*tab\b/i,
  /^ctrl\s*\+\s*c\b/i,
  /^thinking\b/i,
  /^cerebrating\b/i,
  /^accomplishing\b/i,
  /^tokens?\b/i,
  /^context\b/i,
  /^try\b/i,
  /^tip\b/i,
  /^use\s+\/stop\b/i,
  /^background terminals?\b/i,
];

export function cleanTerminalTranscript(data: string, provider?: RuntimeProvider): string {
  const lines = data
    .replace(ANSI_RE, "\n")
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .replace(CONTROL_RE, "")
    .split("\n")
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter((line) => !isTranscriptNoiseLine(line, provider));

  return collapseBlankLines(lines).join("\n");
}

function isTranscriptNoiseLine(line: string, provider?: RuntimeProvider): boolean {
  if (!line) {
    return true;
  }

  const compact = line.toLowerCase().replace(/[^a-z0-9]+/g, "");
  if (provider === "claude" && compact.length <= 2) {
    return true;
  }
  if (COMPACT_CHROME_HINTS.some((hint) => compact.includes(hint))) {
    return true;
  }
  if (CHROME_LINE_PATTERNS.some((pattern) => pattern.test(line))) {
    return true;
  }
  if (/^[>*+~._-]{1,8}$/.test(line)) {
    return true;
  }
  if (provider === "claude" && /^[*+~._-]?[a-z]{3,5}$/i.test(line)) {
    return true;
  }

  return false;
}

function collapseBlankLines(lines: string[]): string[] {
  const result: string[] = [];
  for (const line of lines) {
    const previous = result.at(-1);
    if (!line && !previous) {
      continue;
    }
    result.push(line);
  }
  return result;
}
