import type { TaskTitleOrigin } from "./types/domain";

export const DEFAULT_TASK_TITLE_BODY = "New task";

const LEGACY_ADOPTABLE_PLACEHOLDERS = new Set([
  "New task",
  "New Task",
  "Walking Skeleton Task",
]);
const LEGACY_NOTIFICATION_PLACEHOLDERS = new Set([
  ...LEGACY_ADOPTABLE_PLACEHOLDERS,
  "New Chat",
]);
const DATED_PREFIX = /^(\d{2})(\d{2})-/;

export type AutomaticTitleCandidateKind = "first-prompt" | "provider";

export interface SessionTitleState {
  title: string;
  titleOrigin?: TaskTitleOrigin;
}

export function formatSessionStartPrefix(
  instant: Date | number | string,
  timeZone?: string,
): string {
  const date = instant instanceof Date ? instant : new Date(instant);
  if (!Number.isFinite(date.getTime())) {
    throw new RangeError("Session creation time must be valid.");
  }
  const options: Intl.DateTimeFormatOptions = {
    month: "2-digit",
    day: "2-digit",
    ...(timeZone === undefined ? {} : { timeZone }),
  };
  const parts = new Intl.DateTimeFormat("en-US", options).formatToParts(date);
  const month = parts.find((part) => part.type === "month")?.value;
  const day = parts.find((part) => part.type === "day")?.value;
  if (!month || !day) {
    throw new Error("Session creation date could not be formatted.");
  }
  return `${month}${day}-`;
}

export function composeAutomaticSessionTitle(
  prefix: string,
  candidate: string | null | undefined,
): string | null {
  const body = candidate?.trim();
  if (!body) {
    return null;
  }
  return body.startsWith(prefix) ? body : `${prefix}${body}`;
}

/** One creation clock in, one canonical title + durable owner out. */
export function initialSessionTitle(
  requestedTitle: string | null | undefined,
  createdAt: Date | number | string,
  timeZone?: string,
): SessionTitleState {
  const explicit = requestedTitle?.trim();
  if (explicit) {
    return { title: explicit, titleOrigin: "user" };
  }
  const prefix = formatSessionStartPrefix(createdAt, timeZone);
  const title = composeAutomaticSessionTitle(prefix, DEFAULT_TASK_TITLE_BODY);
  if (!title) {
    throw new Error("Default session title must not be empty.");
  }
  return { title, titleOrigin: "automatic" };
}

/**
 * Apply a run/provider candidate without losing ownership or retroactively
 * dating legacy tasks. `lastAutomaticTitle` is only the old process-local
 * compatibility seam: it lets a legacy first-prompt title receive a later
 * provider title in the same runtime, exactly as before.
 */
export function adoptAutomaticSessionTitle(
  current: SessionTitleState,
  candidate: string | null | undefined,
  kind: AutomaticTitleCandidateKind,
  lastAutomaticTitle: string | null = null,
): SessionTitleState | null {
  const body = candidate?.trim();
  if (!body || current.titleOrigin === "user") {
    return null;
  }

  const prefix = current.titleOrigin === "automatic"
    ? canonicalDatedPrefix(current.title)
    : null;
  const legacy = current.titleOrigin === undefined;
  const placeholder = legacy && LEGACY_ADOPTABLE_PLACEHOLDERS.has(current.title);
  const eligible = kind === "first-prompt"
    ? (prefix !== null && current.title === `${prefix}${DEFAULT_TASK_TITLE_BODY}`) || placeholder
    : prefix !== null || (legacy && (placeholder || current.title === lastAutomaticTitle));
  if (!eligible) {
    return null;
  }

  const title = prefix ? composeAutomaticSessionTitle(prefix, body) : body;
  if (!title || title === current.title) {
    return null;
  }
  return current.titleOrigin === undefined
    ? { title }
    : { title, titleOrigin: current.titleOrigin };
}

/** Notification noise suppression respects manual ownership. */
export function isAutomaticSessionPlaceholder(
  title: string | null | undefined,
  titleOrigin?: TaskTitleOrigin,
): boolean {
  const trimmed = title?.trim();
  if (!trimmed || titleOrigin === "user") {
    return false;
  }
  if (titleOrigin === "automatic") {
    const prefix = canonicalDatedPrefix(trimmed);
    return Boolean(prefix && trimmed === `${prefix}${DEFAULT_TASK_TITLE_BODY}`);
  }
  if (titleOrigin !== undefined) {
    return false;
  }
  return LEGACY_NOTIFICATION_PLACEHOLDERS.has(trimmed);
}

function canonicalDatedPrefix(title: string): string | null {
  const match = DATED_PREFIX.exec(title);
  if (!match) {
    return null;
  }
  const month = Number(match[1]);
  const day = Number(match[2]);
  const maxDay = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1];
  return month >= 1 && month <= 12 && maxDay !== undefined && day >= 1 && day <= maxDay
    ? match[0]
    : null;
}
