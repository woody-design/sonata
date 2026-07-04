import type { TaskId } from "./domain";
import type { PreviewSession, PreviewTab } from "./ipc";

/**
 * On-disk shape of the Preview window's session truth (design record §6): one
 * durable `PreviewSession` per task. Kept deliberately small — no dirty,
 * reviewed, content or existence fields (those are disk truth, observed, or
 * view truth, renderer-only). After a restart nothing is "dirty"; everything
 * re-projects fresh against current disk.
 */
export interface PreviewSessionsDocument {
  sessions: Record<TaskId, PreviewSession>;
}

export function normalizePreviewSessionsDocument(value: unknown): PreviewSessionsDocument {
  if (!value || typeof value !== "object") {
    return { sessions: {} };
  }
  const rawSessions = (value as { sessions?: unknown }).sessions;
  if (!rawSessions || typeof rawSessions !== "object") {
    return { sessions: {} };
  }
  const sessions: Record<TaskId, PreviewSession> = {};
  for (const [taskId, raw] of Object.entries(rawSessions as Record<string, unknown>)) {
    const session = normalizeSession(taskId, raw);
    if (session) {
      sessions[taskId] = session;
    }
  }
  return { sessions };
}

function normalizeSession(taskId: TaskId, raw: unknown): PreviewSession | null {
  if (!raw || typeof raw !== "object") {
    return null;
  }
  const record = raw as {
    tabs?: unknown;
    activePath?: unknown;
    scroll?: unknown;
    panelOpen?: unknown;
  };
  const tabs = normalizeTabs(record.tabs);
  const tabPaths = new Set(tabs.map((tab) => tab.path));
  const activePath =
    typeof record.activePath === "string" && tabPaths.has(record.activePath)
      ? record.activePath
      : tabs.length > 0
        ? (tabs[tabs.length - 1]?.path ?? null)
        : null;
  return {
    taskId,
    tabs,
    activePath,
    scroll: normalizeScroll(record.scroll, tabPaths),
    panelOpen: record.panelOpen === true,
  };
}

function normalizeTabs(raw: unknown): PreviewTab[] {
  if (!Array.isArray(raw)) {
    return [];
  }
  const seen = new Set<string>();
  const tabs: PreviewTab[] = [];
  for (const entry of raw) {
    const path = typeof entry === "string" ? entry : (entry as { path?: unknown })?.path;
    if (typeof path === "string" && path && !seen.has(path)) {
      seen.add(path);
      tabs.push({ path });
    }
  }
  return tabs;
}

function normalizeScroll(raw: unknown, tabPaths: Set<string>): Record<string, number> {
  if (!raw || typeof raw !== "object") {
    return {};
  }
  const scroll: Record<string, number> = {};
  for (const [path, value] of Object.entries(raw as Record<string, unknown>)) {
    // Drop scroll for paths that are no longer tabs — keeps the document from
    // accreting orphan offsets across sessions.
    if (tabPaths.has(path) && typeof value === "number" && Number.isFinite(value) && value >= 0) {
      scroll[path] = value;
    }
  }
  return scroll;
}
