export const INPUT_PREVIEW_LIMIT = 2_000;
export const RESULT_PREVIEW_LIMIT = 4_000;

export interface BoundedText {
  text: string;
  truncated: boolean;
}

export function boundText(value: string, limit: number): BoundedText {
  if (value.length <= limit) {
    return { text: value, truncated: false };
  }
  return { text: value.slice(0, limit), truncated: true };
}

const SUMMARY_KEYS = [
  "command",
  "cmd",
  "file_path",
  "path",
  "pattern",
  "query",
  "url",
  "description",
  "prompt",
];

export function toolSummary(input: unknown): string {
  if (typeof input === "string") {
    return firstLine(input);
  }
  if (!input || typeof input !== "object") {
    return "";
  }

  const record = input as Record<string, unknown>;
  for (const key of SUMMARY_KEYS) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) {
      return firstLine(value);
    }
    if (Array.isArray(value) && value.every((item) => typeof item === "string")) {
      return firstLine(value.join(" "));
    }
  }

  for (const value of Object.values(record)) {
    if (typeof value === "string" && value.trim()) {
      return firstLine(value);
    }
  }
  return "";
}

export function prettyJson(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2) ?? "";
  } catch {
    return String(value);
  }
}

function firstLine(value: string): string {
  const line = value.trim().split(/\r?\n/, 1)[0] ?? "";
  return line.length > 160 ? `${line.slice(0, 160)}…` : line;
}

export function parseJsonRecord(line: string): Record<string, unknown> | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith("{")) {
    return null;
  }
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}
