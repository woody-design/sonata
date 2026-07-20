import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const {
  BUILTIN_TAGS,
  TAG_COLOR_CANDIDATES,
  assignTagColor,
} = require("../../dist/shared/types/tags");

assert.equal(assignTagColor([], "status"), "steel", "empty-pool tie uses candidate order");
assert.equal(
  assignTagColor(BUILTIN_TAGS, "status"),
  "cyan",
  "the first unused Status candidate wins",
);

const statusPool = TAG_COLOR_CANDIDATES.status;
const oneOfEach = statusPool.map((color, index) => ({
  id: `status-${index}`,
  label: `Status ${index}`,
  group: "status",
  color,
  createdAt: "2030-01-01T00:00:00.000Z",
}));
assert.equal(
  assignTagColor(oneOfEach, "status"),
  statusPool[0],
  "a fully used pool cycles to its first candidate on a count tie",
);
assert.equal(
  assignTagColor([...oneOfEach, oneOfEach[0]], "status"),
  statusPool[1],
  "after cycling, the next least-used candidate wins",
);
assert.equal(
  assignTagColor(
    [...oneOfEach, { ...oneOfEach[0], id: "other-group", group: "type" }],
    "status",
  ),
  statusPool[0],
  "usage is counted within the selected group",
);

console.log("ok   tag color assignment: least-used, tie order, and full-pool cycle");
