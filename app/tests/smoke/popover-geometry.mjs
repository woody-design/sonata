import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const G = require("../../dist/reading-core/side-card-geometry");
const HERE = dirname(fileURLToPath(import.meta.url));

function rect(left, top, width, height) {
  return {
    left,
    top,
    right: left + width,
    bottom: top + height,
    width,
    height,
  };
}

const viewport = { width: 1000, height: 600 };
const card = { width: 320, height: 120 };

assert.deepEqual(
  G.calculateSideCardGeometry(rect(100, 80, 100, 40), card, viewport),
  { left: 208, top: 80, width: 320, maxHeight: 584, placement: "right" },
  "uses the preferred right side with the 8px gap",
);

assert.deepEqual(
  G.calculateSideCardGeometry(rect(800, 80, 100, 40), card, viewport),
  { left: 472, top: 80, width: 320, maxHeight: 584, placement: "left" },
  "flips left when the preferred side cannot fit",
);

assert.deepEqual(
  G.calculateSideCardGeometry(rect(100, 80, 80, 40), card, { width: 300, height: 600 }),
  { left: 8, top: 80, width: 284, maxHeight: 584, placement: "clamped" },
  "shrinks and clamps when neither side can fit",
);

assert.deepEqual(
  G.calculateSideCardGeometry(rect(100, 80, 100, 40), card, { width: 500, height: 600 }),
  { left: 172, top: 80, width: 320, maxHeight: 584, placement: "clamped" },
  "the same anchor is recomputed against a resized viewport",
);

assert.equal(
  G.calculateSideCardGeometry(rect(-400, 80, 100, 40), card, viewport).left,
  8,
  "an off-left anchor cannot pull the card beyond the viewport",
);
assert.equal(
  G.calculateSideCardGeometry(rect(1200, 80, 100, 40), card, viewport).left,
  672,
  "an off-right anchor cannot push the card beyond the viewport",
);

assert.equal(
  G.calculateSideCardGeometry(rect(100, -20, 100, 40), card, viewport).top,
  8,
  "clamps above the viewport",
);
assert.equal(
  G.calculateSideCardGeometry(rect(100, 560, 100, 40), card, viewport).top,
  472,
  "clamps below the viewport after measured card height",
);
assert.deepEqual(
  G.calculateSideCardGeometry(rect(100, 300, 100, 40), { width: 320, height: 1000 }, viewport),
  { left: 208, top: 8, width: 320, maxHeight: 584, placement: "right" },
  "a taller card is bounded to the viewport scrollport",
);

assert.equal(
  G.calculateSideCardGeometry(rect(100, 560, 100, 40), { width: 320, height: 115.3 }, viewport).top,
  476.7,
  "fractional measurement preserves the exact bottom safety margin",
);

const adapterSource = readFileSync(
  resolve(HERE, "../../src/renderer/view/popover-geometry.ts"),
  "utf8",
);
assert.match(
  adapterSource,
  /panel\.style\.top = `\$\{geometry\.top\}px`/,
  "the DOM adapter must not round the pure helper's safe fractional top",
);

assert.throws(
  () => G.calculateSideCardGeometry(rect(0, 0, 10, 10), { width: -1, height: 10 }, viewport),
  RangeError,
  "invalid geometry fails explicitly",
);

console.log("popover-geometry: right, flip, narrow, vertical, and overflow cases pass");
