import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const {
  BUILTIN_TAGS,
  normalizeTagsDocument,
} = require("../../dist/shared/types/tags");

const seeded = normalizeTagsDocument(null);
assert.equal(seeded.version, 1);
assert.equal(seeded.tags.length, 16, "missing store seeds the built-in vocabulary");
assert.ok(seeded.tags.every((tag) => tag.builtin === true));

const custom = {
  id: " custom-id ",
  label: " Release Candidate ",
  group: "status",
  color: "cyan",
  createdAt: "2030-01-01T00:00:00.000Z",
};
assert.deepEqual(
  normalizeTagsDocument({ version: 1, tags: [custom] }),
  {
    version: 1,
    tags: [{ ...custom, id: "custom-id", label: "Release Candidate" }],
  },
  "valid records normalize their persisted strings",
);

for (const invalid of [
  { version: 2, tags: [] },
  { version: 1, tags: [{ ...custom, color: "chartreuse" }] },
  { version: 1, tags: [custom, { ...custom, id: "another-id" }] },
]) {
  assert.deepEqual(
    normalizeTagsDocument(invalid),
    { version: 1, tags: BUILTIN_TAGS },
    "invalid or ambiguous stores reset to the built-in vocabulary",
  );
}

console.log("ok   tags store normalize: seed, canonical valid data, reset invalid data");
