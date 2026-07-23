import assert from "node:assert/strict";
import { createRequire } from "node:module";

// setSessionTags id validation (consolidation S2): the renderer can be stale and
// send a tag id that was JUST deleted — its delete-time manifest scrub
// (planTagRemovalFromManifests) has already run, so persisting that id would
// strand a permanent orphan no later scrub reaches. runtime-controller filters
// through retainKnownTagIds before withTaskTags: unknown ids are silently
// dropped (tolerate-orphans, matching replaceTagSelection), never rejected.
const require = createRequire(import.meta.url);
const { retainKnownTagIds } = require("../../dist/shared/session-tags");
const { BUILTIN_TAGS } = require("../../dist/shared/types/tags");

const customTag = {
  id: "11111111-2222-3333-4444-555555555555",
  label: "Release Candidate",
  group: "status",
  color: "cyan",
  createdAt: "2030-01-01T00:00:00.000Z",
};
const definitions = [...BUILTIN_TAGS, customTag];

// A stale renderer's just-deleted id is dropped; the valid ones stay in order.
assert.deepEqual(
  retainKnownTagIds(["status.todo", "custom.deleted-a-moment-ago", "type.research"], definitions),
  ["status.todo", "type.research"],
  "an unknown (deleted) id is dropped while known ids are preserved",
);

// A known custom UUID is retained.
assert.deepEqual(
  retainKnownTagIds([customTag.id, "priority.p0"], definitions),
  [customTag.id, "priority.p0"],
  "a known custom UUID survives validation",
);

// Every id unknown → empty (withTaskTags then restores the optional-field shape).
assert.deepEqual(
  retainKnownTagIds(["gone-1", "gone-2"], definitions),
  [],
  "an all-unknown selection validates to empty",
);

// Canonicalization still applies: trim + de-duplicate before the membership test.
assert.deepEqual(
  retainKnownTagIds([" status.todo ", "status.todo", "status.done"], definitions),
  ["status.todo", "status.done"],
  "ids are trimmed and de-duplicated, then filtered to the live vocabulary",
);

console.log("ok   setSessionTags validation: drops unknown ids, keeps known, canonicalizes");
