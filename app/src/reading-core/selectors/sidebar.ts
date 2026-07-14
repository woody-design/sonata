/**
 * Sidebar selectors for the Reading window: the session-index → entry list,
 * the prefs filter/sort pipeline, and the date-bucket grouping.
 *
 * reading-core layer rules: plain data in, plain data out — no DOM, no
 * Electron, no renderer state. Prefs come in as a parameter (the instance
 * lives in state.sidebar since C3b; localStorage load/save stays in the
 * shell); "now" is a default-param clock (call sites keep today's behavior,
 * fixtures pass explicit values).
 */
import type {
  ProjectGroup,
  SessionIndexResponse,
  SessionSummary,
} from "../../shared/types";
import {
  SIDEBAR_DISCLOSURE_INCREMENT,
  SIDEBAR_INITIAL_VISIBLE_COUNT,
  SIDEBAR_PREFS_DEFAULTS,
  type SidebarDisclosureGroupKey,
  type SidebarDisclosureState,
  type SidebarPrefs,
} from "../state";
import {
  formatSidebarHoverActivity,
  type SidebarHoverActivity,
} from "./formatters";

/** Anything departs from the default setup — drives the filter button's
 *  persistent "your view is shaped" accent. */
export function sidebarPrefsNonDefault(prefs: SidebarPrefs): boolean {
  return (
    prefs.status !== SIDEBAR_PREFS_DEFAULTS.status ||
    prefs.project !== SIDEBAR_PREFS_DEFAULTS.project ||
    prefs.activity !== SIDEBAR_PREFS_DEFAULTS.activity ||
    prefs.groupBy !== SIDEBAR_PREFS_DEFAULTS.groupBy ||
    prefs.sortBy !== SIDEBAR_PREFS_DEFAULTS.sortBy
  );
}

/** The filter subset only (status/project/activity) — group/sort are view
 *  shape, not filters, so "Clear filters" ignores them. */
export function sidebarFiltersNonDefault(prefs: SidebarPrefs): boolean {
  return (
    prefs.status !== SIDEBAR_PREFS_DEFAULTS.status ||
    prefs.project !== SIDEBAR_PREFS_DEFAULTS.project ||
    prefs.activity !== SIDEBAR_PREFS_DEFAULTS.activity
  );
}

interface SidebarEntryBase {
  session: SessionSummary;
  projectArchived: boolean;
}

/** Project identity is a pair: only project-less sessions may use `Tasks`. */
export type SidebarEntry = SidebarEntryBase & (
  | { projectPath: string; projectName: string }
  | { projectPath: null; projectName: null }
);

export interface SidebarHoverCardModel {
  taskId: string;
  title: string;
  projectLabel: string;
  activity: SidebarHoverActivity | null;
}

export function sidebarHoverCardModel(
  entry: SidebarEntry,
  nowMs = Date.now(),
  timeZone?: string,
): SidebarHoverCardModel {
  return {
    taskId: entry.session.task.id,
    title: entry.session.task.title,
    projectLabel: entry.projectPath === null ? "Tasks" : entry.projectName,
    activity: formatSidebarHoverActivity(entry.session.lastActivityAt, nowMs, timeZone),
  };
}

export interface SidebarDisclosureMetrics {
  totalCount: number;
  visibleLimit: number;
  effectiveVisibleCount: number;
  nextIncrementCount: number;
  canShowMore: boolean;
  isEffectivelyExpanded: boolean;
}

export interface SidebarDisclosureSessionGroup {
  key: SidebarDisclosureGroupKey;
  label: string;
  entries: SidebarEntry[];
  visibleEntries: SidebarEntry[];
  disclosure: SidebarDisclosureMetrics;
}

export type SidebarDisclosureProject = Omit<ProjectGroup, "sessions">;

export interface SidebarDisclosureProjectGroup extends SidebarDisclosureSessionGroup {
  /** Metadata only. All renderable sessions must come through visibleEntries. */
  project: SidebarDisclosureProject;
}

export type SidebarDisclosureMode = "project" | "date" | "flat" | "focused";

export interface SidebarOuterDisclosure {
  projectVisibility: SidebarDisclosureMetrics;
  eligibleProjectCount: number;
  showLess: boolean;
  showMore: boolean;
}

/** Complete pure projection consumed by the renderer in Slice 3. `entries`
 *  has already passed filter + within-group sorting. Project groups remain in
 *  the index's canonical order; only their session prefixes are disclosed. */
export interface SidebarDisclosureModel {
  mode: SidebarDisclosureMode;
  entries: SidebarEntry[];
  projectGroups: SidebarDisclosureProjectGroup[];
  visibleProjectGroups: SidebarDisclosureProjectGroup[];
  /** Chats for project mode; Date buckets or the single flat/focused group for
   *  the other modes. Empty groups are omitted. */
  sessionGroups: SidebarDisclosureSessionGroup[];
  outer: SidebarOuterDisclosure;
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

export interface SidebarDateBucket {
  key: Extract<SidebarDisclosureGroupKey, `date:${string}`>;
  label: string;
  entries: SidebarEntry[];
}

const SIDEBAR_DATE_BUCKETS: ReadonlyArray<
  Pick<SidebarDateBucket, "key" | "label">
> = [
  { key: "date:today", label: "Today" },
  { key: "date:yesterday", label: "Yesterday" },
  { key: "date:this-week", label: "This week" },
  { key: "date:older", label: "Older" },
];

/** The date-group partition (groupBy: "date"). Buckets are returned in fixed
 *  chronological order with stable semantic keys; empty buckets are the
 *  render side's to skip. Bucket edges are local-midnight-based, matching the
 *  sidebar's human day sense. */
export function sidebarDateBuckets(
  entries: SidebarEntry[],
  nowMs = Date.now(),
): SidebarDateBucket[] {
  const buckets: SidebarDateBucket[] = SIDEBAR_DATE_BUCKETS.map((bucket) => ({
    ...bucket,
    entries: [],
  }));
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

export function projectDisclosureGroupKey(path: string): SidebarDisclosureGroupKey {
  return `project:${path}`;
}

export function focusedDisclosureGroupKey(path: string): SidebarDisclosureGroupKey {
  return `focused:${path}`;
}

/** Exact 5/+10 arithmetic shared by group and outer-project disclosure. */
export function sidebarDisclosureMetrics(
  totalCount: number,
  visibleLimit = SIDEBAR_INITIAL_VISIBLE_COUNT,
): SidebarDisclosureMetrics {
  if (!Number.isInteger(totalCount) || totalCount < 0) {
    throw new RangeError("Sidebar disclosure totalCount must be a non-negative integer");
  }
  if (!Number.isInteger(visibleLimit) || visibleLimit < SIDEBAR_INITIAL_VISIBLE_COUNT) {
    throw new RangeError(
      `Sidebar disclosure visibleLimit must be an integer >= ${SIDEBAR_INITIAL_VISIBLE_COUNT}`,
    );
  }
  const effectiveVisibleCount = Math.min(visibleLimit, totalCount);
  const remaining = totalCount - effectiveVisibleCount;
  return {
    totalCount,
    visibleLimit,
    effectiveVisibleCount,
    nextIncrementCount: Math.min(SIDEBAR_DISCLOSURE_INCREMENT, remaining),
    canShowMore: remaining > 0,
    isEffectivelyExpanded: effectiveVisibleCount > SIDEBAR_INITIAL_VISIBLE_COUNT,
  };
}

export function sidebarGroupDisclosureMetrics(
  disclosure: SidebarDisclosureState,
  key: SidebarDisclosureGroupKey,
  totalCount: number,
): SidebarDisclosureMetrics {
  return sidebarDisclosureMetrics(
    totalCount,
    disclosure.groupVisibleLimits.get(key) ?? SIDEBAR_INITIAL_VISIBLE_COUNT,
  );
}

/** One source of truth for filter → within-group sort → canonical grouping →
 *  disclosure. The renderer receives already-keyed prefixes and cannot grow a
 *  second limit state machine from rendered child counts. */
export function sidebarDisclosureModel(
  index: SessionIndexResponse,
  prefs: SidebarPrefs,
  disclosure: SidebarDisclosureState,
  now = Date.now(),
): SidebarDisclosureModel {
  const entries = applySidebarPrefs(sidebarEntries(index), prefs, now);

  if (prefs.project !== null) {
    const project = index.projects.find((candidate) => candidate.path === prefs.project);
    const group = disclosureSessionGroup(
      focusedDisclosureGroupKey(prefs.project),
      project?.name ?? "Sessions",
      entries,
      disclosure,
    );
    return disclosureModelWithoutProjects("focused", entries, group, disclosure);
  }

  if (prefs.groupBy === "none") {
    const group = disclosureSessionGroup("flat", "Sessions", entries, disclosure);
    return disclosureModelWithoutProjects("flat", entries, group, disclosure);
  }

  if (prefs.groupBy === "date") {
    const groups = sidebarDateBuckets(entries, now)
      .filter((bucket) => bucket.entries.length > 0)
      .map((bucket) =>
        disclosureSessionGroup(bucket.key, bucket.label, bucket.entries, disclosure),
      );
    return disclosureModelWithoutProjects("date", entries, groups, disclosure);
  }

  const entriesByProject = new Map<string, SidebarEntry[]>();
  const chats: SidebarEntry[] = [];
  for (const entry of entries) {
    if (entry.projectPath === null) {
      chats.push(entry);
      continue;
    }
    const group = entriesByProject.get(entry.projectPath);
    if (group) {
      group.push(entry);
    } else {
      entriesByProject.set(entry.projectPath, [entry]);
    }
  }

  const projectGroups: SidebarDisclosureProjectGroup[] = [];
  for (const project of index.projects) {
    const projectEntries = entriesByProject.get(project.path) ?? [];
    if (projectEntries.length === 0) {
      continue;
    }
    projectGroups.push({
      ...disclosureSessionGroup(
        projectDisclosureGroupKey(project.path),
        project.name,
        projectEntries,
        disclosure,
      ),
      project: {
        path: project.path,
        name: project.name,
        archived: project.archived,
        lastActivityAt: project.lastActivityAt,
      },
    });
  }

  const sessionGroups =
    chats.length > 0
      ? [disclosureSessionGroup("chats", "Tasks", chats, disclosure)]
      : [];
  const projectVisibility = sidebarDisclosureMetrics(
    projectGroups.length,
    disclosure.visibleProjectLimit,
  );
  const anyGroupExpanded = [...projectGroups, ...sessionGroups].some(
    (group) => group.disclosure.isEffectivelyExpanded,
  );
  return {
    mode: "project",
    entries,
    projectGroups,
    visibleProjectGroups: projectGroups.slice(0, projectVisibility.effectiveVisibleCount),
    sessionGroups,
    outer: {
      projectVisibility,
      eligibleProjectCount: projectGroups.length,
      showLess: projectVisibility.isEffectivelyExpanded || anyGroupExpanded,
      showMore: projectVisibility.canShowMore,
    },
  };
}

function disclosureSessionGroup(
  key: SidebarDisclosureGroupKey,
  label: string,
  entries: SidebarEntry[],
  disclosure: SidebarDisclosureState,
): SidebarDisclosureSessionGroup {
  const metrics = sidebarGroupDisclosureMetrics(disclosure, key, entries.length);
  return {
    key,
    label,
    entries,
    visibleEntries: entries.slice(0, metrics.effectiveVisibleCount),
    disclosure: metrics,
  };
}

function disclosureModelWithoutProjects(
  mode: Exclude<SidebarDisclosureMode, "project">,
  entries: SidebarEntry[],
  groups: SidebarDisclosureSessionGroup | SidebarDisclosureSessionGroup[],
  disclosure: SidebarDisclosureState,
): SidebarDisclosureModel {
  const sessionGroups = (Array.isArray(groups) ? groups : [groups]).filter(
    (group) => group.entries.length > 0,
  );
  const projectVisibility = sidebarDisclosureMetrics(
    0,
    disclosure.visibleProjectLimit,
  );
  return {
    mode,
    entries,
    projectGroups: [],
    visibleProjectGroups: [],
    sessionGroups,
    outer: {
      projectVisibility,
      eligibleProjectCount: 0,
      showLess: sessionGroups.some((group) => group.disclosure.isEffectivelyExpanded),
      showMore: false,
    },
  };
}
