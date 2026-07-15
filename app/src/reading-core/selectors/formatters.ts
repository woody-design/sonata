/**
 * Pure formatters and lookup-table labels for the Reading window.
 *
 * reading-core layer rules: plain data in, plain data out — no DOM, no
 * Electron, no renderer state. Compiled by tsconfig.main (no DOM lib), so a
 * `document`/`window` reference here is a build error by design. Functions
 * that need "now" take it as a default parameter (clock injection): call
 * sites keep today's behavior, fixtures pass explicit values.
 */
import type {
  ClaudePermissionMode,
  CodexPermissionMode,
  ReadingModeSetting,
  ReadingThemeId,
  ResumePolicyId,
  RuntimeProvider,
} from "../../shared/types";
import type { RuntimeRunReport } from "../../shared/schemas";

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function formatRelativeAge(iso: string, nowMs = Date.now()): string {
  const thenMs = Date.parse(iso);
  if (!Number.isFinite(thenMs)) {
    return "";
  }
  const deltaMs = Math.max(0, nowMs - thenMs);
  const minutes = Math.floor(deltaMs / 60_000);
  if (minutes < 1) {
    return "now";
  }
  if (minutes < 60) {
    return `${minutes}m`;
  }
  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    return `${hours}h`;
  }
  const days = Math.floor(hours / 24);
  if (days < 7) {
    return `${days}d`;
  }
  const weeks = Math.floor(days / 7);
  if (weeks < 5) {
    return `${weeks}w`;
  }
  const months = Math.floor(days / 30);
  if (months < 12) {
    return `${months}mo`;
  }
  return `${Math.floor(days / 365)}y`;
}

export interface TranscriptTimestamp {
  /** Exact local date + time for the quiet transcript metadata row. */
  display: string;
  /** Canonical machine-readable value for the HTML <time> element. */
  dateTime: string;
}

// Intl.DateTimeFormat construction is expensive (locale-data load), and a
// session switch re-renders every turn at once. Formatters are stateless, so
// memoizing them is pure — outputs never depend on the cache. The key space is
// tiny in practice: the renderer always passes (undefined, undefined); other
// pairs come only from fixtures.
const transcriptFormatterCache = new Map<
  string,
  { date: Intl.DateTimeFormat; time: Intl.DateTimeFormat }
>();

function transcriptFormatters(
  locale?: string,
  timeZone?: string,
): { date: Intl.DateTimeFormat; time: Intl.DateTimeFormat } {
  const key = `${locale ?? ""}|${timeZone ?? ""}`;
  let formatters = transcriptFormatterCache.get(key);
  if (!formatters) {
    const zone = timeZone === undefined ? {} : { timeZone };
    formatters = {
      date: new Intl.DateTimeFormat(locale, {
        year: "numeric",
        month: "short",
        day: "numeric",
        ...zone,
      }),
      time: new Intl.DateTimeFormat(locale, {
        hour: "numeric",
        minute: "2-digit",
        ...zone,
      }),
    };
    transcriptFormatterCache.set(key, formatters);
  }
  return formatters;
}

/**
 * Exact timestamp copy for a conversational message. Unlike the Sidebar's
 * relative activity age, a transcript time is a durable fact: it never changes
 * under the reader. Locale and zone are injectable for deterministic fixtures;
 * the renderer omits both so Chromium follows the user's system preferences.
 */
export function formatTranscriptTimestamp(
  iso: string,
  locale?: string,
  timeZone?: string,
): TranscriptTimestamp | null {
  const timestampMs = Date.parse(iso);
  if (!Number.isFinite(timestampMs)) {
    return null;
  }
  const { date, time } = transcriptFormatters(locale, timeZone);
  return {
    display: `${date.format(timestampMs)} · ${time.format(timestampMs)}`,
    dateTime: new Date(timestampMs).toISOString(),
  };
}

export function formatIdleDuration(ms: number): string {
  const minutes = Math.round(ms / 60_000);
  if (minutes < 60) {
    return `${minutes}m`;
  }
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  if (hours < 48) {
    return rest > 0 ? `${hours}h ${rest}m` : `${hours}h`;
  }
  return `${Math.floor(hours / 24)}d`;
}

export function formatTokenCount(tokens: number): string {
  if (tokens >= 1000) {
    return `${(tokens / 1000).toFixed(1)}k`;
  }
  return String(tokens);
}

export function formatUsagePercent(value: number): string {
  const clamped = Math.max(0, Math.min(100, value));
  const rounded = Math.round(clamped * 10) / 10;
  return `${Number.isInteger(rounded) ? rounded.toFixed(0) : rounded.toFixed(1)}%`;
}

export function compactTokenCount(value: number): string {
  if (value >= 1_000_000) {
    const rounded = value / 1_000_000;
    return `${rounded >= 10 ? Math.round(rounded) : trimTrailingZero(rounded.toFixed(1))}m`;
  }
  if (value >= 1_000) {
    return `${Math.round(value / 1_000)}k`;
  }
  return String(Math.round(value));
}

export function formatRelativeUsageTime(targetMs: number, nowMs = Date.now()): string {
  const seconds = Math.max(0, Math.round(Math.abs(nowMs - targetMs) / 1000));
  if (seconds < 45) {
    return "now";
  }
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) {
    return `${minutes}m`;
  }
  const hours = Math.floor(minutes / 60);
  const remainderMinutes = minutes % 60;
  if (hours < 24) {
    return remainderMinutes > 0 ? `${hours}h ${remainderMinutes}m` : `${hours}h`;
  }
  const days = Math.round(hours / 24);
  return `${days}d`;
}

export function usageLimitDisplayLabel(label: string): string {
  if (label === "5h") {
    return "5-hour limit";
  }
  if (label === "daily") {
    return "Daily";
  }
  if (label === "weekly") {
    return "Weekly";
  }
  if (label === "monthly") {
    return "Monthly";
  }
  return `${label} limit`;
}

export function trimTrailingZero(value: string): string {
  return value.endsWith(".0") ? value.slice(0, -2) : value;
}

// A settled duration, in the same "Xm Ys" shape the live clock ticks in (not
// a raw "284.7 s" — the roster's running and done rows must read the same way).
export function formatLiveElapsed(startedAt: string | null, nowMs = Date.now()): string {
  const startedMs = startedAt ? Date.parse(startedAt) : Number.NaN;
  if (Number.isNaN(startedMs)) {
    return "";
  }
  const totalSeconds = Math.max(0, Math.floor((nowMs - startedMs) / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return minutes > 0 ? `${minutes}m ${seconds}s` : `${seconds}s`;
}

export function condensedPromptText(text: string): string {
  const trimmed = text.replace(/\s+/g, " ").trim();
  return trimmed || "(empty prompt)";
}

export function fileExtension(name: string): string {
  const index = name.lastIndexOf(".");
  return index >= 0 ? name.slice(index).toLowerCase() : "";
}

export function folderName(folderPath: string): string {
  return folderPath.split(/[\\/]/).filter(Boolean).at(-1) ?? folderPath;
}

export function errorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/^Error invoking remote method '[^']+':\s*(?:Error:\s*)?/, "");
}

export function providerLabel(provider: RuntimeProvider): string {
  if (provider === "claude") {
    return "Claude";
  }
  return "Codex";
}

export function readingThemeLabel(theme: ReadingThemeId): string {
  if (theme === "paper") {
    return "Paper";
  }
  if (theme === "calm") {
    return "Calm";
  }
  if (theme === "focus") {
    return "Focus";
  }
  return "Duet";
}

export function readingModeLabel(mode: ReadingModeSetting): string {
  if (mode === "light") {
    return "Light";
  }
  if (mode === "dark") {
    return "Dark";
  }
  return "Auto";
}

/** One vocabulary for every permission surface (Settings popup, New Chat
 *  access chip, live-session chip). The standing triad reads as answers to
 *  "how should Claude actions be approved?"; the tail modes only ever appear
 *  on a live session's chip after a terminal-side switch (Shift+Tab / CI). */
export function permissionModeLabel(mode: ClaudePermissionMode): string {
  if (mode === "acceptEdits") {
    return "Accept edits";
  }
  if (mode === "auto") {
    return "Auto";
  }
  if (mode === "plan") {
    return "Plan mode";
  }
  if (mode === "bypassPermissions") {
    return "Bypass permissions";
  }
  if (mode === "dontAsk") {
    return "Don't ask";
  }
  // The `default` mode's display label. Claude 2.1.200 relabeled this mode
  // "Manual" across its own surfaces (identifier unchanged — Duet still
  // reads/writes `default`); the display follows suit.
  return "Manual";
}

/** One vocabulary for every Codex permission surface (the Settings default
 *  popup; the live-session chip in composer.ts). Codex 0.144's own
 *  `/permissions` picker labels, so Duet's chip reads exactly as the TUI's
 *  "(current)" marker does. */
export function codexPermissionModeLabel(mode: CodexPermissionMode): string {
  if (mode === "approve-for-me") {
    return "Approve for me";
  }
  if (mode === "full-access") {
    return "Full Access";
  }
  return "Ask for approval";
}

/** The New Chat greeting IS the folder state display: it names the project
 *  when one is chosen (exact strings ruled 2026-07-04), so no FOLDER label
 *  row exists anywhere else on the surface. */
export function newChatGreeting(
  cwd: string | null,
  projects: ReadonlyArray<{ path: string; name: string }>,
): string {
  if (!cwd) {
    return "What should we work on?";
  }
  const project = projects.find((candidate) => candidate.path === cwd);
  return `What should we work on in ${project?.name ?? folderName(cwd)}?`;
}

export function resumePolicyLabel(policy: ResumePolicyId): string {
  if (policy === "summary") {
    return "Resume from summary";
  }
  if (policy === "full") {
    return "Resume full session";
  }
  return "Ask each time";
}

export function settingsDateLabel(at: string): string {
  const parsed = new Date(at);
  if (Number.isNaN(parsed.getTime())) {
    return at;
  }
  return parsed.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

export function approvalTitle(kind: RuntimeRunReport["approvalKind"] | null | undefined): string {
  if (kind === "workspace-trust") {
    return "Workspace trust requested";
  }
  if (kind === "file-edit") {
    return "File edit approval requested";
  }
  if (kind === "file-read") {
    return "File read approval requested";
  }
  if (kind === "command") {
    return "Command approval requested";
  }
  if (kind === "dangerous-bypass") {
    return "Bypass Permissions mode — confirm";
  }
  return "Native approval requested";
}

export function approvalKindLabel(kind: RuntimeRunReport["approvalKind"] | null | undefined): string {
  if (kind === "workspace-trust") {
    return "Workspace trust";
  }
  if (kind === "file-edit") {
    return "File edit";
  }
  if (kind === "file-read") {
    return "File read";
  }
  if (kind === "command") {
    return "Command";
  }
  if (kind === "dangerous-bypass") {
    return "Bypass mode";
  }
  return "Native";
}
