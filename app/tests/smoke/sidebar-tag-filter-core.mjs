import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const selectors = require("../../dist/reading-core/selectors/sidebar");
const { SIDEBAR_PREFS_DEFAULTS } = require("../../dist/reading-core/state");
const { BUILTIN_TAGS } = require("../../dist/shared/types/tags");

const NOW = Date.parse("2026-07-20T12:00:00.000Z");

function entry(title, tags = []) {
  return {
    session: {
      task: {
        id: `task-${title.toLowerCase().replaceAll(" ", "-")}`,
        title,
        provider: "codex",
        status: "idle",
        createdAt: "2026-07-20T10:00:00.000Z",
        updatedAt: "2026-07-20T11:00:00.000Z",
        tags,
      },
      storageRoot: `/tmp/${title}`,
      archived: false,
      live: false,
      liveStatus: null,
      lastActivityAt: "2026-07-20T11:00:00.000Z",
    },
    projectPath: null,
    projectName: null,
    projectArchived: false,
  };
}

const corpus = [
  entry("Todo research", ["status.todo", "type.research"]),
  entry("Done research", ["status.done", "type.research"]),
  entry("Todo coding", ["status.todo", "type.coding"]),
  entry("Priority only", ["priority.p0"]),
  entry("Untagged"),
];

function titles(tags) {
  return selectors
    .applySidebarPrefs(
      corpus,
      { ...SIDEBAR_PREFS_DEFAULTS, tags, sortBy: "alphabetical" },
      NOW,
      BUILTIN_TAGS,
    )
    .map((candidate) => candidate.session.task.title);
}

// D5: selected ids in one group are alternatives.
assert.deepEqual(
  titles(["status.todo", "status.done"]),
  ["Done research", "Todo coding", "Todo research"],
  "status selections OR within the group",
);

// D5: every involved group must contribute a matching tag.
assert.deepEqual(
  titles(["status.todo", "status.done", "type.research"]),
  ["Done research", "Todo research"],
  "status OR is ANDed with the selected type group",
);
assert.deepEqual(
  titles(["status.todo", "type.research", "priority.p0"]),
  [],
  "a session lacking any tag in an involved group is excluded",
);

// Empty is a true no-op, including untagged sessions.
assert.deepEqual(
  titles([]),
  ["Done research", "Priority only", "Todo coding", "Todo research", "Untagged"],
  "empty tag selection does not filter",
);

// The loader's two-stage normalization keeps valid strings before hydration,
// then drops deleted ids against the authoritative definitions cache.
assert.deepEqual(
  selectors.normalizeSidebarTagIds(["status.todo", 42, "deleted.custom", "status.todo"]),
  ["status.todo", "deleted.custom"],
  "pre-hydration normalization keeps unique string ids",
);
assert.deepEqual(
  selectors.normalizeSidebarTagIds(
    ["status.todo", "deleted.custom", "type.research"],
    BUILTIN_TAGS,
  ),
  ["status.todo", "type.research"],
  "definitions-cache normalization drops deleted tag ids",
);
assert.deepEqual(
  titles(["deleted.custom"]),
  ["Done research", "Priority only", "Todo coding", "Todo research", "Untagged"],
  "an unknown selected id is ignored until loader normalization persists cleanup",
);

assert.equal(
  selectors.sidebarFiltersNonDefault({ ...SIDEBAR_PREFS_DEFAULTS, tags: ["status.todo"] }),
  true,
  "tag selection marks filters non-default",
);
assert.equal(
  selectors.sidebarPrefsNonDefault({ ...SIDEBAR_PREFS_DEFAULTS, tags: ["status.todo"] }),
  true,
  "tag selection marks the filter button non-default",
);

console.log("sidebar-tag-filter-core: D5 grouping + normalization + empty no-op pass");
