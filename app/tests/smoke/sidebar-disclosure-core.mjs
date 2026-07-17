import assert from "node:assert/strict";
import { createRequire } from "node:module";

// Slice 2 pure-core fence. No DOM, Electron, filesystem corpus, or rendered
// child counts participate: state intent, grouping, prefix selection, reset
// policy, and outer predicates are measured directly from reading-core.
const require = createRequire(import.meta.url);
const selectors = require("../../dist/reading-core/selectors/sidebar");
const transitions = require("../../dist/reading-core/transitions/sidebar");
const renameTransitions = require("../../dist/reading-core/transitions/rename");
const stateModule = require("../../dist/reading-core/state");

const {
  SIDEBAR_DISCLOSURE_INCREMENT,
  SIDEBAR_INITIAL_VISIBLE_COUNT,
  SIDEBAR_PREFS_DEFAULTS,
  createInitialState,
} = stateModule;

const NOW = new Date("2030-01-15T17:00:00.000Z");
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
let sessionSequence = 0;

function freshState() {
  return createInitialState({ theme: "sonata", mode: "light", textStep: 16 });
}

function makeSession(
  title,
  {
    id = `disclosure-${++sessionSequence}`,
    lastActivityAt = new Date(NOW.getTime() - sessionSequence * 60_000).toISOString(),
    createdAt = new Date(NOW.getTime() - (sessionSequence + 100) * 60_000).toISOString(),
    archived = false,
  } = {},
) {
  return {
    task: {
      id,
      title,
      provider: "codex",
      status: "idle",
      createdAt,
      updatedAt: lastActivityAt,
    },
    storageRoot: `/tmp/disclosure/${id}`,
    archived,
    live: false,
    liveStatus: null,
    lastActivityAt,
  };
}

function makeProject(path, name, count, options = {}) {
  const titles = options.titles ?? Array.from({ length: count }, (_, index) =>
    `${name} ${String(count - index).padStart(2, "0")}`,
  );
  return {
    path,
    name,
    archived: Boolean(options.archived),
    sessions: titles.map((title, index) =>
      makeSession(title, {
        id: `${path.replaceAll("/", "-") || "root"}-${index + 1}`,
        lastActivityAt: options.timestamps?.[index],
        archived: Boolean(options.sessionArchived),
      }),
    ),
  };
}

function makeIndex(projects = [], chats = []) {
  return { projects, chats, lastUsedFolder: projects[0]?.path ?? null };
}

// 1) Defaults are sparse, isolated, and exactly 5/+10.
{
  const first = freshState();
  const second = freshState();
  assert.equal(SIDEBAR_INITIAL_VISIBLE_COUNT, 5);
  assert.equal(SIDEBAR_DISCLOSURE_INCREMENT, 10);
  assert.equal(first.sidebar.disclosure.visibleProjectLimit, 5);
  assert.equal(first.sidebar.disclosure.groupVisibleLimits.size, 0);
  assert.ok(first.sidebar.disclosure.groupVisibleLimits instanceof Map);
  first.sidebar.disclosure.groupVisibleLimits.set("flat", 15);
  assert.equal(second.sidebar.disclosure.groupVisibleLimits.size, 0, "new windows do not share state");
}

// 2) Boundary arithmetic: exact effective counts, next batch, and predicates.
{
  const totals = [0, 1, 5, 6, 14, 15, 16, 25, 26];
  for (const total of totals) {
    const initial = selectors.sidebarDisclosureMetrics(total);
    assert.equal(initial.effectiveVisibleCount, Math.min(5, total), `${total}: initial prefix`);
    assert.equal(initial.nextIncrementCount, Math.min(10, Math.max(0, total - 5)), `${total}: next`);
    assert.equal(initial.canShowMore, total > 5, `${total}: can show more`);
    assert.equal(initial.isEffectivelyExpanded, false, `${total}: initial not expanded`);

    const fifteen = selectors.sidebarDisclosureMetrics(total, 15);
    assert.equal(fifteen.effectiveVisibleCount, Math.min(15, total), `${total}: limit 15`);
    assert.equal(
      fifteen.nextIncrementCount,
      Math.min(10, Math.max(0, total - Math.min(15, total))),
      `${total}: next after 15`,
    );
    assert.equal(fifteen.isEffectivelyExpanded, total > 5, `${total}: effective expansion`);
  }
  assert.throws(() => selectors.sidebarDisclosureMetrics(-1), /non-negative integer/);
  assert.throws(() => selectors.sidebarDisclosureMetrics(5, 4), /integer >= 5/);

  const exactProgressions = new Map([
    [0, [0]],
    [5, [5]],
    [6, [5, 6]],
    [15, [5, 15]],
    [16, [5, 15, 16]],
    [25, [5, 15, 25]],
    [26, [5, 15, 25, 26]],
  ]);
  for (const [total, expectedCounts] of exactProgressions) {
    const state = freshState();
    const key = "flat";
    const actualCounts = [];
    while (true) {
      const metrics = selectors.sidebarGroupDisclosureMetrics(
        state.sidebar.disclosure,
        key,
        total,
      );
      actualCounts.push(metrics.effectiveVisibleCount);
      if (!metrics.canShowMore) {
        break;
      }
      transitions.showMoreSidebarGroup(state, key);
    }
    assert.deepEqual(actualCounts, expectedCounts, `${total}: exact 5/+10 progression`);
  }
}

// 3) Transitions store unclamped intent; reset is shared and idempotent;
// project collapse is orthogonal.
{
  const state = freshState();
  const key = "project:/alpha";
  assert.equal(transitions.showMoreSidebarGroup(state, key), 15);
  assert.equal(transitions.showMoreSidebarGroup(state, key), 25);
  assert.equal(selectors.sidebarGroupDisclosureMetrics(state.sidebar.disclosure, key, 4).effectiveVisibleCount, 4);
  assert.equal(selectors.sidebarGroupDisclosureMetrics(state.sidebar.disclosure, key, 26).effectiveVisibleCount, 25);
  assert.equal(selectors.sidebarGroupDisclosureMetrics(state.sidebar.disclosure, key, 26).nextIncrementCount, 1);

  assert.equal(transitions.showMoreSidebarProjects(state), 15);
  assert.equal(transitions.showMoreSidebarProjects(state), 25);
  transitions.toggleProjectCollapsed(state, "/alpha");
  assert.equal(state.sidebar.collapsedProjects.has("/alpha"), true);
  assert.equal(state.sidebar.disclosure.groupVisibleLimits.get(key), 25, "collapse preserves depth");
  assert.equal(state.sidebar.disclosure.visibleProjectLimit, 25);

  assert.equal(transitions.resetSidebarDisclosure(state), true);
  assert.equal(state.sidebar.disclosure.visibleProjectLimit, 5);
  assert.equal(state.sidebar.disclosure.groupVisibleLimits.size, 0);
  assert.equal(state.sidebar.collapsedProjects.has("/alpha"), true, "reset preserves collapse");
  assert.equal(transitions.resetSidebarDisclosure(state), false, "default reset is a no-op");
}

// 4) Every actual preference/view-definition change resets; a no-op preserves
// visible and latent limits plus unrelated selection/rename/collapse state.
{
  const changedCases = [
    ["status", "all"],
    ["project", "/alpha"],
    ["activity", "7d"],
    ["groupBy", "date"],
    ["sortBy", "alphabetical"],
  ];
  for (const [field, value] of changedCases) {
    const state = freshState();
    state.activeTaskId = "selected-hidden-is-allowed";
    renameTransitions.startSessionRename(
      state,
      "rename-survives-core-reset",
      "sidebar",
      "Rename survives",
    );
    state.sidebar.collapsedProjects.add("/alpha");
    transitions.showMoreSidebarProjects(state);
    transitions.showMoreSidebarGroup(state, "project:/latent");
    assert.equal(transitions.patchSidebarPrefs(state, { [field]: value }), true, `${field}: changed`);
    assert.equal(state.sidebar.disclosure.visibleProjectLimit, 5, `${field}: projects reset`);
    assert.equal(state.sidebar.disclosure.groupVisibleLimits.size, 0, `${field}: groups reset`);
    assert.equal(state.activeTaskId, "selected-hidden-is-allowed", `${field}: selection preserved`);
    assert.equal(
      state.sidebar.renameEditor?.kind === "session"
        ? state.sidebar.renameEditor.taskId
        : null,
      "rename-survives-core-reset",
      `${field}: rename preserved`,
    );
    assert.equal(state.sidebar.collapsedProjects.has("/alpha"), true, `${field}: collapse preserved`);
  }

  const state = freshState();
  transitions.showMoreSidebarProjects(state);
  transitions.showMoreSidebarGroup(state, "chats");
  const map = state.sidebar.disclosure.groupVisibleLimits;
  assert.equal(transitions.patchSidebarPrefs(state, {}), false, "empty patch is a no-op");
  assert.equal(
    transitions.patchSidebarPrefs(state, { status: SIDEBAR_PREFS_DEFAULTS.status }),
    false,
    "already-selected preference is a no-op",
  );
  assert.equal(state.sidebar.disclosure.visibleProjectLimit, 15);
  assert.equal(state.sidebar.disclosure.groupVisibleLimits, map, "map identity and latent state preserved");
  assert.equal(map.get("chats"), 15);
}

// 5) Project mode: canonical project order survives alphabetical session sort;
// Chats do not count as projects; outer less/more can coexist.
{
  const canonicalNames = [
    "Mango", "Zulu", "Alpha", "Echo", "Bravo", "Hotel", "Delta", "Kilo",
    "Cedar", "Quartz", "Birch", "Tango", "Fox", "Indigo", "Lima", "Gamma",
  ];
  const projects = canonicalNames.map((name, index) =>
    makeProject(`/project-${String(index + 1).padStart(2, "0")}`, name, 6),
  );
  projects.splice(4, 0, makeProject("/archived", "Archived", 3, { archived: true }));
  const chats = Array.from({ length: 16 }, (_, index) => makeSession(`Chat ${16 - index}`));
  const index = makeIndex(projects, chats);
  const state = freshState();
  state.sidebar.prefs.sortBy = "alphabetical";

  let model = selectors.sidebarDisclosureModel(index, state.sidebar.prefs, state.sidebar.disclosure, NOW.getTime());
  assert.equal(model.mode, "project");
  assert.deepEqual(model.projectGroups.map((group) => group.project.name), canonicalNames);
  assert.equal(
    "sessions" in model.projectGroups[0].project,
    false,
    "project projection exposes metadata only; visibleEntries is the sole render prefix",
  );
  assert.deepEqual(
    model.projectGroups[0].entries.map((entry) => entry.session.task.title),
    ["Mango 01", "Mango 02", "Mango 03", "Mango 04", "Mango 05", "Mango 06"],
    "sort applies inside the group, never to project order",
  );
  assert.equal(model.outer.eligibleProjectCount, 16, "archived project filtered; Chats excluded");
  assert.equal(model.visibleProjectGroups.length, 5);
  assert.deepEqual(model.sessionGroups.map((group) => group.key), ["chats"]);
  assert.equal(model.sessionGroups[0].visibleEntries.length, 5);
  assert.deepEqual([model.outer.showLess, model.outer.showMore], [false, true]);

  transitions.showMoreSidebarGroup(state, model.projectGroups[0].key);
  model = selectors.sidebarDisclosureModel(index, state.sidebar.prefs, state.sidebar.disclosure, NOW.getTime());
  assert.equal(model.projectGroups[0].visibleEntries.length, 6);
  assert.deepEqual([model.outer.showLess, model.outer.showMore], [true, true], "local expansion + hidden projects");

  transitions.showMoreSidebarProjects(state);
  model = selectors.sidebarDisclosureModel(index, state.sidebar.prefs, state.sidebar.disclosure, NOW.getTime());
  assert.equal(model.visibleProjectGroups.length, 15);
  assert.equal(model.outer.projectVisibility.nextIncrementCount, 1);
  assert.deepEqual([model.outer.showLess, model.outer.showMore], [true, true], "outer controls coexist");

  transitions.showMoreSidebarProjects(state);
  model = selectors.sidebarDisclosureModel(index, state.sidebar.prefs, state.sidebar.disclosure, NOW.getTime());
  assert.equal(model.visibleProjectGroups.length, 16);
  assert.deepEqual([model.outer.showLess, model.outer.showMore], [true, false]);

  transitions.resetSidebarDisclosure(state);
  model = selectors.sidebarDisclosureModel(index, state.sidebar.prefs, state.sidebar.disclosure, NOW.getTime());
  assert.equal(model.visibleProjectGroups.length, 5);
  assert.equal(model.projectGroups[0].visibleEntries.length, 5);
  assert.deepEqual([model.outer.showLess, model.outer.showMore], [false, true]);
}

// 6) Date buckets each own an independent limit; outside project grouping the
// outer surface can only reset, never reveal more.
{
  const midnight = new Date(NOW);
  midnight.setHours(0, 0, 0, 0);
  const at = (offset) => new Date(midnight.getTime() + offset).toISOString();
  const dated = [
    ...Array.from({ length: 6 }, (_, index) => makeSession(`Today ${index}`, { lastActivityAt: at(HOUR + index) })),
    ...Array.from({ length: 16 }, (_, index) => makeSession(`Yesterday ${index}`, { lastActivityAt: at(-HOUR - index) })),
    ...Array.from({ length: 25 }, (_, index) => makeSession(`Week ${index}`, { lastActivityAt: at(-3 * DAY - index) })),
    ...Array.from({ length: 5 }, (_, index) => makeSession(`Older ${index}`, { lastActivityAt: at(-10 * DAY - index) })),
  ];
  const state = freshState();
  state.sidebar.prefs.groupBy = "date";
  const index = makeIndex([], dated);

  let model = selectors.sidebarDisclosureModel(index, state.sidebar.prefs, state.sidebar.disclosure, NOW.getTime());
  assert.deepEqual(
    model.sessionGroups.map((group) => [group.key, group.entries.length, group.visibleEntries.length]),
    [
      ["date:today", 6, 5],
      ["date:yesterday", 16, 5],
      ["date:this-week", 25, 5],
      ["date:older", 5, 5],
    ],
  );
  assert.deepEqual([model.outer.showLess, model.outer.showMore], [false, false]);

  transitions.showMoreSidebarGroup(state, "date:today");
  model = selectors.sidebarDisclosureModel(index, state.sidebar.prefs, state.sidebar.disclosure, NOW.getTime());
  assert.equal(model.sessionGroups[0].visibleEntries.length, 6);
  assert.equal(model.sessionGroups[1].visibleEntries.length, 5, "Yesterday remains independent");
  assert.deepEqual([model.outer.showLess, model.outer.showMore], [true, false]);

  transitions.showMoreSidebarGroup(state, "date:yesterday");
  model = selectors.sidebarDisclosureModel(index, state.sidebar.prefs, state.sidebar.disclosure, NOW.getTime());
  assert.equal(model.sessionGroups[1].visibleEntries.length, 15);
  assert.equal(model.sessionGroups[1].disclosure.nextIncrementCount, 1);
  transitions.showMoreSidebarGroup(state, "date:yesterday");
  model = selectors.sidebarDisclosureModel(index, state.sidebar.prefs, state.sidebar.disclosure, NOW.getTime());
  assert.equal(model.sessionGroups[1].visibleEntries.length, 16);
  assert.equal(model.sessionGroups[1].disclosure.canShowMore, false);
}

// 7) Chats, flat, and focused-project groups use stable semantic keys. Local
// expansion makes only outer Show less available in non-project modes.
{
  const alpha = makeProject("/alpha", "Alpha", 16);
  const beta = makeProject("/beta", "Beta", 6);
  const chats = Array.from({ length: 6 }, (_, index) => makeSession(`Chat key ${index}`));
  const index = makeIndex([alpha, beta], chats);
  const state = freshState();

  let model = selectors.sidebarDisclosureModel(index, state.sidebar.prefs, state.sidebar.disclosure, NOW.getTime());
  const chatsGroup = model.sessionGroups.find((group) => group.key === "chats");
  assert.ok(chatsGroup);
  transitions.showMoreSidebarGroup(state, "chats");
  model = selectors.sidebarDisclosureModel(index, state.sidebar.prefs, state.sidebar.disclosure, NOW.getTime());
  assert.equal(model.sessionGroups[0].visibleEntries.length, 6);
  assert.equal(model.outer.showLess, true);

  transitions.patchSidebarPrefs(state, { groupBy: "none" });
  model = selectors.sidebarDisclosureModel(index, state.sidebar.prefs, state.sidebar.disclosure, NOW.getTime());
  assert.equal(model.mode, "flat");
  assert.deepEqual(model.sessionGroups.map((group) => group.key), ["flat"]);
  assert.equal(model.sessionGroups[0].entries.length, 28);
  assert.deepEqual([model.outer.showLess, model.outer.showMore], [false, false]);
  transitions.showMoreSidebarGroup(state, "flat");
  model = selectors.sidebarDisclosureModel(index, state.sidebar.prefs, state.sidebar.disclosure, NOW.getTime());
  assert.equal(model.sessionGroups[0].visibleEntries.length, 15);
  assert.deepEqual([model.outer.showLess, model.outer.showMore], [true, false]);

  transitions.patchSidebarPrefs(state, { project: "/alpha" });
  model = selectors.sidebarDisclosureModel(index, state.sidebar.prefs, state.sidebar.disclosure, NOW.getTime());
  assert.equal(model.mode, "focused");
  assert.deepEqual(model.sessionGroups.map((group) => group.key), ["focused:/alpha"]);
  assert.equal(model.sessionGroups[0].entries.length, 16, "other projects and Chats excluded");
  assert.equal(model.sessionGroups[0].visibleEntries.length, 5, "entering focus reset disclosure");
  assert.deepEqual([model.outer.showLess, model.outer.showMore], [false, false]);
}

// 8) Background insert/delete/reorder never mutates the stored numeric limit;
// the selector clamps each render and keeps the canonical index order.
{
  const state = freshState();
  const key = "project:/stable";
  transitions.showMoreSidebarGroup(state, key);
  let stable = makeProject("/stable", "Stable", 6);
  let sibling = makeProject("/sibling", "Sibling", 1);
  let index = makeIndex([stable, sibling]);
  let model = selectors.sidebarDisclosureModel(index, state.sidebar.prefs, state.sidebar.disclosure, NOW.getTime());
  assert.equal(model.projectGroups[0].visibleEntries.length, 6);

  stable = makeProject("/stable", "Stable", 2);
  index = makeIndex([sibling, stable]);
  model = selectors.sidebarDisclosureModel(index, state.sidebar.prefs, state.sidebar.disclosure, NOW.getTime());
  assert.deepEqual(model.projectGroups.map((group) => group.project.path), ["/sibling", "/stable"]);
  assert.equal(model.projectGroups[1].visibleEntries.length, 2);
  assert.equal(state.sidebar.disclosure.groupVisibleLimits.get(key), 15);

  stable = makeProject("/stable", "Stable", 26);
  index = makeIndex([stable, sibling]);
  model = selectors.sidebarDisclosureModel(index, state.sidebar.prefs, state.sidebar.disclosure, NOW.getTime());
  assert.equal(model.projectGroups[0].visibleEntries.length, 15);
  assert.equal(model.projectGroups[0].disclosure.nextIncrementCount, 10);
  assert.equal(state.sidebar.disclosure.groupVisibleLimits.get(key), 15);
}

// 9) The selector is a deterministic pure projection: it does not mutate the
// index, preferences, or stored disclosure intent.
{
  const state = freshState();
  transitions.showMoreSidebarGroup(state, "project:/pure");
  const index = makeIndex([
    makeProject("/pure", "Pure", 16),
    makeProject("/other", "Other", 2),
  ], [makeSession("Pure chat")]);
  const indexBefore = JSON.stringify(index);
  const prefsBefore = JSON.stringify(state.sidebar.prefs);
  const disclosureBefore = {
    visibleProjectLimit: state.sidebar.disclosure.visibleProjectLimit,
    groupVisibleLimits: [...state.sidebar.disclosure.groupVisibleLimits],
  };

  const first = selectors.sidebarDisclosureModel(
    index,
    state.sidebar.prefs,
    state.sidebar.disclosure,
    NOW.getTime(),
  );
  const second = selectors.sidebarDisclosureModel(
    index,
    state.sidebar.prefs,
    state.sidebar.disclosure,
    NOW.getTime(),
  );
  assert.deepEqual(second, first, "same inputs produce the same projection");
  assert.equal(JSON.stringify(index), indexBefore, "index remains untouched");
  assert.equal(JSON.stringify(state.sidebar.prefs), prefsBefore, "preferences remain untouched");
  assert.deepEqual(
    {
      visibleProjectLimit: state.sidebar.disclosure.visibleProjectLimit,
      groupVisibleLimits: [...state.sidebar.disclosure.groupVisibleLimits],
    },
    disclosureBefore,
    "selector does not clamp or rewrite stored intent",
  );
}

// 10) Selection is independent from disclosure: reset may hide the selected
// session without mutating activeTaskId or force-revealing its row.
{
  const state = freshState();
  const project = makeProject("/selected", "Selected", 16);
  state.activeTaskId = project.sessions[15].task.id;
  const model = selectors.sidebarDisclosureModel(
    makeIndex([project]),
    state.sidebar.prefs,
    state.sidebar.disclosure,
    NOW.getTime(),
  );
  assert.equal(model.projectGroups[0].visibleEntries.length, 5);
  assert.equal(
    model.projectGroups[0].visibleEntries.some(
      (entry) => entry.session.task.id === state.activeTaskId,
    ),
    false,
  );
  assert.equal(state.activeTaskId, project.sessions[15].task.id);
}

console.log("sidebar-disclosure-core: 10 fixture groups pass");
