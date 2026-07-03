/**
 * Sidebar selectors for the Reading window: the session-index → entry list,
 * the prefs filter/sort pipeline, and the date-bucket grouping.
 *
 * reading-core layer rules: plain data in, plain data out — no DOM, no
 * Electron, no renderer state. Prefs come in as a parameter (the shell owns
 * the localStorage-backed instance until C3b); "now" is a default-param clock
 * (call sites keep today's behavior, fixtures pass explicit values).
 */
import type { SessionIndexResponse, SessionSummary } from "../../shared/types";

/** Sidebar organization preferences. View state — persisted per machine. */
export interface SidebarPrefs {
  status: "active" | "archived" | "all";
  /** providerCwd of the focused project, or null for all. */
  project: string | null;
  activity: "1d" | "3d" | "7d" | "30d" | "all";
  groupBy: "project" | "date" | "none";
  sortBy: "recency" | "created" | "alphabetical";
}

export const SIDEBAR_PREFS_DEFAULTS: SidebarPrefs = {
  status: "active",
  project: null,
  activity: "all",
  groupBy: "project",
  sortBy: "recency",
};

export interface SidebarEntry {
  session: SessionSummary;
  /** null = auto-workspace session ("Chats"). */
  projectPath: string | null;
  projectName: string | null;
  projectArchived: boolean;
}

export function sidebarEntries(index: SessionIndexResponse): SidebarEntry[] {
  const entries: SidebarEntry[] = [];
  for (const project of index.projects) {
    for (const session of project.sessions) {
      entries.push({
        session,
        projectPath: project.path,
        projectName: project.name,
        projectArchived: project.archived,
      });
    }
  }
  for (const session of index.chats) {
    entries.push({ session, projectPath: null, projectName: null, projectArchived: false });
  }
  return entries;
}

export const ACTIVITY_WINDOW_MS: Record<Exclude<SidebarPrefs["activity"], "all">, number> = {
  "1d": 24 * 3_600_000,
  "3d": 3 * 24 * 3_600_000,
  "7d": 7 * 24 * 3_600_000,
  "30d": 30 * 24 * 3_600_000,
};

export function applySidebarPrefs(
  entries: SidebarEntry[],
  prefs: SidebarPrefs,
  now = Date.now(),
): SidebarEntry[] {
  const filtered = entries.filter((entry) => {
    const archived = entry.session.archived || entry.projectArchived;
    if (prefs.status === "active" && archived) {
      return false;
    }
    if (prefs.status === "archived" && !archived) {
      return false;
    }
    if (prefs.project !== null && entry.projectPath !== prefs.project) {
      return false;
    }
    if (prefs.activity !== "all") {
      const ageMs = now - Date.parse(entry.session.lastActivityAt);
      if (!(ageMs <= ACTIVITY_WINDOW_MS[prefs.activity])) {
        return false;
      }
    }
    return true;
  });

  // Sort applies WITHIN groups; group order is fixed by the grouping
  // (projects by latest activity, date buckets chronologically).
  filtered.sort((a, b) => {
    if (prefs.sortBy === "alphabetical") {
      return a.session.task.title.localeCompare(b.session.task.title);
    }
    if (prefs.sortBy === "created") {
      return b.session.task.createdAt.localeCompare(a.session.task.createdAt);
    }
    return b.session.lastActivityAt.localeCompare(a.session.lastActivityAt);
  });
  return filtered;
}

/** The date-group partition (groupBy: "date"). Buckets are returned in fixed
 *  chronological order; empty buckets are the render side's to skip. Bucket
 *  edges are local-midnight-based, matching the sidebar's human day sense. */
export function sidebarDateBuckets(
  entries: SidebarEntry[],
  nowMs = Date.now(),
): Array<{ label: string; entries: SidebarEntry[] }> {
  const buckets: Array<{ label: string; entries: SidebarEntry[] }> = [
    { label: "Today", entries: [] },
    { label: "Yesterday", entries: [] },
    { label: "This week", entries: [] },
    { label: "Older", entries: [] },
  ];
  const startOfToday = new Date(nowMs);
  startOfToday.setHours(0, 0, 0, 0);
  const todayMs = startOfToday.getTime();
  const dayMs = 24 * 3_600_000;
  for (const entry of entries) {
    const ts = Date.parse(entry.session.lastActivityAt);
    const bucket =
      ts >= todayMs ? 0 : ts >= todayMs - dayMs ? 1 : ts >= todayMs - 6 * dayMs ? 2 : 3;
    buckets[bucket]?.entries.push(entry);
  }
  return buckets;
}
