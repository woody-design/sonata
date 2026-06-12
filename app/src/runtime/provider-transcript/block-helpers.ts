import type { PlanItem } from "../../shared/types/transcript";

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

/**
 * Parses the agent's plan-tool payload (claude TodoWrite `todos`, codex
 * update_plan `plan`) into provider-neutral plan items. Returns null on ANY
 * malformed item so callers fall through to the generic tool-call rendering —
 * never lose evidence to a parser.
 */
export function parsePlanItems(input: unknown): PlanItem[] | null {
  if (!input || typeof input !== "object") {
    return null;
  }
  const record = input as Record<string, unknown>;
  const list = Array.isArray(record.todos)
    ? record.todos
    : Array.isArray(record.plan)
      ? record.plan
      : null;
  if (!list || list.length === 0) {
    return null;
  }
  const items: PlanItem[] = [];
  for (const value of list) {
    if (!value || typeof value !== "object") {
      return null;
    }
    const item = value as Record<string, unknown>;
    const text =
      typeof item.content === "string" && item.content.trim()
        ? item.content
        : typeof item.step === "string" && item.step.trim()
          ? item.step
          : null;
    const status = item.status;
    if (!text || (status !== "pending" && status !== "in_progress" && status !== "completed")) {
      return null;
    }
    items.push({
      text,
      activeLabel:
        typeof item.activeForm === "string" && item.activeForm.trim() ? item.activeForm : null,
      status,
    });
  }
  return items;
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
