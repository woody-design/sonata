import assert from "node:assert/strict";
import { createRequire } from "node:module";

// Fixture matrix for the sidebar selectors (map step B2): entry flattening,
// the prefs filter/sort pipeline (status × project × activity × sort), and
// the date-bucket grouping. Clocked functions get explicit `now` — the
// default-param injection keeps app call sites unchanged. Assertions pin
// MEASURED behavior (A1 lesson).
const require = createRequire(import.meta.url);
const S = require("../../dist/reading-core/selectors/sidebar");
// SidebarPrefs + defaults live in the state model since C3b (type-home
// ruling: state-model types live in state.ts, no re-exports).
const { SIDEBAR_PREFS_DEFAULTS } = require("../../dist/reading-core/state");

const NOW = Date.parse("2026-07-03T12:00:00.000Z");
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const agoMs = (ms) => new Date(NOW - ms).toISOString();

let n = 0;
function session(title, { archived = false, lastActivityAt = agoMs(HOUR), createdAt } = {}) {
  n += 1;
  return {
    task: {
      id: `task-${n}`,
      title,
      createdAt: createdAt ?? agoMs(10 * DAY),
      provider: "claude",
      status: "ready",
    },
    storageRoot: `/tmp/store/task-${n}`,
    archived,
    live: false,
    liveStatus: null,
    lastActivityAt,
  };
}

function index({ projects = [], chats = [] } = {}) {
  return { projects, chats };
}

const entryOf = (session, projectPath = null) => ({
  session,
  projectPath,
  projectName: projectPath ? `name:${projectPath}` : null,
  projectArchived: false,
});

// 1) sidebarEntries — flattening order and Chats handling.
{
  const p1a = session("P1 A");
  const p1b = session("P1 B");
  const p2a = session("P2 A");
  const chat = session("Chat 1");
  const entries = S.sidebarEntries(
    index({
      projects: [
        { path: "/p1", name: "P1", archived: false, sessions: [p1a, p1b] },
        { path: "/p2", name: "P2", archived: true, sessions: [p2a] },
      ],
      chats: [chat],
    }),
  );
  assert.deepEqual(
    entries.map((e) => [e.session.task.title, e.projectPath, e.projectName, e.projectArchived]),
    [
      ["P1 A", "/p1", "P1", false],
      ["P1 B", "/p1", "P1", false],
      ["P2 A", "/p2", "P2", true],
      ["Chat 1", null, null, false],
    ],
    "projects in index order, then chats with null project",
  );
}

// 2) Status filter — archived comes from the session OR its project.
{
  const activeS = entryOf(session("active"));
  const archivedS = entryOf(session("archived", { archived: true }));
  const inArchivedProject = { ...entryOf(session("in archived project"), "/p"), projectArchived: true };
  const all = [activeS, archivedS, inArchivedProject];
  const titles = (entries) => entries.map((e) => e.session.task.title);

  const prefs = { ...SIDEBAR_PREFS_DEFAULTS, sortBy: "alphabetical" };
  assert.deepEqual(
    titles(S.applySidebarPrefs(all, prefs, NOW)),
    ["active"],
    "status:active hides session-archived AND project-archived",
  );
  assert.deepEqual(
    titles(S.applySidebarPrefs(all, { ...prefs, status: "archived" }, NOW)),
    ["archived", "in archived project"],
    "status:archived shows only archived (either flag)",
  );
  assert.deepEqual(
    titles(S.applySidebarPrefs(all, { ...prefs, status: "all" }, NOW)),
    ["active", "archived", "in archived project"],
    "status:all shows everything",
  );
}

// 3) Project focus filter — exact path match; chats excluded under focus.
{
  const a = entryOf(session("in p1"), "/p1");
  const b = entryOf(session("in p2"), "/p2");
  const chat = entryOf(session("chat"));
  const prefs = { ...SIDEBAR_PREFS_DEFAULTS, project: "/p1" };
  assert.deepEqual(
    S.applySidebarPrefs([a, b, chat], prefs, NOW).map((e) => e.session.task.title),
    ["in p1"],
    "project focus keeps only that project's sessions (chats have null path)",
  );
}

// 4) Activity window — boundary is inclusive (ageMs <= window).
{
  const fresh = entryOf(session("fresh", { lastActivityAt: agoMs(HOUR) }));
  const edge = entryOf(session("edge", { lastActivityAt: agoMs(24 * HOUR) }));
  const stale = entryOf(session("stale", { lastActivityAt: agoMs(25 * HOUR) }));
  const invalid = entryOf(session("invalid", { lastActivityAt: "not-a-date" }));
  const prefs = { ...SIDEBAR_PREFS_DEFAULTS, activity: "1d", sortBy: "alphabetical" };
  assert.deepEqual(
    S.applySidebarPrefs([fresh, edge, stale, invalid], prefs, NOW).map((e) => e.session.task.title),
    ["edge", "fresh"],
    "1d window: 24h-old passes (inclusive), 25h-old and invalid timestamps drop (NaN comparison)",
  );
  assert.equal(
    S.applySidebarPrefs([stale], { ...prefs, activity: "all" }, NOW).length,
    1,
    "activity:all skips the window check",
  );
  assert.deepEqual(
    Object.entries(S.ACTIVITY_WINDOW_MS).map(([k, v]) => [k, v / DAY]),
    [["1d", 1], ["3d", 3], ["7d", 7], ["30d", 30]],
    "window table",
  );
}

// 5) Sort modes — recency (default), created, alphabetical.
{
  const a = entryOf(session("Beta", { lastActivityAt: agoMs(3 * HOUR), createdAt: agoMs(1 * DAY) }));
  const b = entryOf(session("alpha", { lastActivityAt: agoMs(1 * HOUR), createdAt: agoMs(3 * DAY) }));
  const c = entryOf(session("Gamma", { lastActivityAt: agoMs(2 * HOUR), createdAt: agoMs(2 * DAY) }));
  const titles = (prefs) =>
    S.applySidebarPrefs([a, b, c], { ...SIDEBAR_PREFS_DEFAULTS, ...prefs }, NOW).map(
      (e) => e.session.task.title,
    );
  assert.deepEqual(titles({}), ["alpha", "Gamma", "Beta"], "recency: latest activity first");
  assert.deepEqual(titles({ sortBy: "created" }), ["Beta", "Gamma", "alpha"], "created: newest first");
  assert.deepEqual(
    titles({ sortBy: "alphabetical" }),
    ["alpha", "Beta", "Gamma"],
    "alphabetical: localeCompare (case-insensitive here)",
  );
}

// 6) sidebarDateBuckets — local-midnight edges, fixed order, empties kept.
{
  // Anchor "now" to local 18:00 so bucket edges are unambiguous in any TZ.
  const local = new Date(NOW);
  local.setHours(18, 0, 0, 0);
  const nowMs = local.getTime();
  const midnight = new Date(nowMs);
  midnight.setHours(0, 0, 0, 0);
  const midnightMs = midnight.getTime();

  const at = (ms) => new Date(ms).toISOString();
  const today = entryOf(session("today", { lastActivityAt: at(midnightMs + HOUR) }));
  const yesterday = entryOf(session("yesterday", { lastActivityAt: at(midnightMs - HOUR) }));
  const thisWeek = entryOf(session("this week", { lastActivityAt: at(midnightMs - 5 * DAY) }));
  const weekEdge = entryOf(session("week edge", { lastActivityAt: at(midnightMs - 6 * DAY) }));
  const older = entryOf(session("older", { lastActivityAt: at(midnightMs - 6 * DAY - 1) }));
  const future = entryOf(session("future", { lastActivityAt: at(nowMs + HOUR) }));

  const buckets = S.sidebarDateBuckets([today, yesterday, thisWeek, weekEdge, older, future], nowMs);
  assert.deepEqual(
    buckets.map((b) => [b.label, b.entries.map((e) => e.session.task.title)]),
    [
      ["Today", ["today", "future"]],
      ["Yesterday", ["yesterday"]],
      ["This week", ["this week", "week edge"]],
      ["Older", ["older"]],
    ],
    "bucket edges: >= midnight → Today (future included); -1d → Yesterday; -6d inclusive → This week; beyond → Older",
  );

  const empty = S.sidebarDateBuckets([], nowMs);
  assert.deepEqual(
    empty.map((b) => [b.label, b.entries.length]),
    [["Today", 0], ["Yesterday", 0], ["This week", 0], ["Older", 0]],
    "all four buckets always present (render side skips empties)",
  );
}

// 7) Non-default predicates (moved from the shell at C3b) — nonDefault covers
// all five prefs; the filter subset ignores groupBy/sortBy ("Clear filters"
// leaves the view shape alone).
{
  assert.equal(S.sidebarPrefsNonDefault({ ...SIDEBAR_PREFS_DEFAULTS }), false, "defaults → false");
  assert.equal(
    S.sidebarFiltersNonDefault({ ...SIDEBAR_PREFS_DEFAULTS }),
    false,
    "defaults → filters false",
  );

  const cases = [
    ["status", "all", true],
    ["project", "/p1", true],
    ["activity", "7d", true],
    ["groupBy", "date", false],
    ["sortBy", "created", false],
  ];
  for (const [key, value, isFilter] of cases) {
    const prefs = { ...SIDEBAR_PREFS_DEFAULTS, [key]: value };
    assert.equal(S.sidebarPrefsNonDefault(prefs), true, `${key} departs → nonDefault`);
    assert.equal(
      S.sidebarFiltersNonDefault(prefs),
      isFilter,
      `${key} departs → filters ${isFilter} (group/sort are view shape, not filters)`,
    );
  }
}

console.log("reading-sidebar-selectors: 7 fixture groups pass");
