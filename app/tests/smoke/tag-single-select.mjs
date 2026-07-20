import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { replaceTagSelection, withTaskTags } = require("../../dist/shared/session-tags");
const { BUILTIN_TAGS } = require("../../dist/shared/types/tags");

assert.deepEqual(
  replaceTagSelection(
    ["status.todo", "type.research", "priority.p2", "legacy.unknown"],
    "status.done",
    BUILTIN_TAGS,
  ),
  ["type.research", "priority.p2", "legacy.unknown", "status.done"],
  "Status selection replaces only the old Status value",
);
assert.deepEqual(
  replaceTagSelection(
    ["status.todo", "type.research", "priority.p2"],
    "priority.p0",
    BUILTIN_TAGS,
  ),
  ["status.todo", "type.research", "priority.p0"],
  "Priority selection replaces only the old Priority value",
);
assert.deepEqual(
  replaceTagSelection(["type.research"], "type.design", BUILTIN_TAGS),
  ["type.research", "type.design"],
  "Type remains multi-select",
);
assert.deepEqual(
  replaceTagSelection(["status.todo", "type.research"], "status.todo", BUILTIN_TAGS),
  ["type.research"],
  "selecting an applied option toggles it off",
);
assert.deepEqual(
  replaceTagSelection(["status.todo"], "missing", BUILTIN_TAGS),
  ["status.todo"],
  "an unknown selection is a no-op",
);
const timestamp = "2030-01-01T00:00:00.000Z";
assert.equal(
  withTaskTags({ updatedAt: timestamp }, ["status.todo"]).updatedAt,
  timestamp,
  "tag writes preserve updatedAt",
);

console.log("ok   tag selection: Status/Priority replace, Type accumulates, applied toggles off");
