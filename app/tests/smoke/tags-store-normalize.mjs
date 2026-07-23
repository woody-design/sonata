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

// Structural fallback ONLY: an unreadable document (not a record, unknown
// version, or a non-array `tags`) seeds the builtin vocabulary. A single bad
// ENTRY inside an otherwise-readable document is data, not a preference, and no
// longer resets the whole document (pre-2026-07-23 it did, and the next write
// persisted that wipe, orphaning every custom-tag UUID a manifest referenced).
for (const structural of [
  { version: 2, tags: [] }, // unknown version
  null, // not a record
  { version: 1, tags: {} }, // tags is not an array
  "not-a-document",
]) {
  assert.deepEqual(
    normalizeTagsDocument(structural),
    { version: 1, tags: BUILTIN_TAGS },
    "a structurally-unreadable document falls back to the built-in vocabulary",
  );
}

const good = {
  id: "good-id",
  label: "Good",
  group: "status",
  color: "sky",
  createdAt: "2030-02-01T00:00:00.000Z",
};

// One malformed entry among valid ones is DROPPED; every valid entry survives.
assert.deepEqual(
  normalizeTagsDocument({
    version: 1,
    tags: [good, { ...custom, color: "chartreuse" }, { ...good, id: "good-2", label: "Good Two" }],
  }),
  {
    version: 1,
    tags: [good, { ...good, id: "good-2", label: "Good Two" }],
  },
  "a bad entry is dropped while the surrounding valid entries are preserved",
);

// A lone malformed entry drops to an empty (but structurally intact) document —
// it never triggers a builtin reset, so nothing that WAS persisted is fabricated.
assert.deepEqual(
  normalizeTagsDocument({ version: 1, tags: [{ ...custom, color: "chartreuse" }] }),
  { version: 1, tags: [] },
  "an all-invalid tags array normalizes to empty, not to the builtins",
);

// Duplicate id: first occurrence wins, the later collision is skipped.
assert.deepEqual(
  normalizeTagsDocument({
    version: 1,
    tags: [good, { ...good, label: "Different Label", color: "teal" }],
  }),
  { version: 1, tags: [good] },
  "a duplicate id keeps the first occurrence and drops the rest",
);

// Duplicate group+label (different id): first occurrence wins.
assert.deepEqual(
  normalizeTagsDocument({
    version: 1,
    tags: [custom, { ...custom, id: "another-id" }],
  }),
  { version: 1, tags: [{ ...custom, id: "custom-id", label: "Release Candidate" }] },
  "a duplicate group+label keeps the first occurrence and drops the rest",
);

console.log("ok   tags store normalize: seed, canonical valid data, entry-level drop/dedup, structural reset");
