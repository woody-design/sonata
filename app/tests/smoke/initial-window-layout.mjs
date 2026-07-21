import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { planInitialWindowPair } = require("../../dist/main/initial-window-layout");

const failures = [];
function check(name, condition, detail) {
  if (!condition) failures.push(`${name}${detail ? `: ${detail}` : ""}`);
}

function assertPair(name, area, expected) {
  const pair = planInitialWindowPair(area);
  check(`${name} returns a pair`, Boolean(pair));
  if (!pair) return;
  check(
    `${name} exact geometry`,
    JSON.stringify(pair) === JSON.stringify(expected),
    JSON.stringify(pair),
  );
  check(`${name} aligned tops`, pair.main.y === pair.terminal.y);
  check(`${name} aligned heights`, pair.main.height === pair.terminal.height);
  check(`${name} 8px seam`, pair.main.x + pair.main.width + 8 === pair.terminal.x);
  check(
    `${name} inside work area`,
    pair.main.x >= area.x &&
      pair.main.y >= area.y &&
      pair.terminal.x + pair.terminal.width <= area.x + area.width &&
      pair.terminal.y + pair.terminal.height <= area.y + area.height,
  );
}

assertPair(
  "1920 baseline",
  { x: 0, y: 25, width: 1920, height: 1055 },
  {
    main: { x: 16, y: 41, width: 1200, height: 820 },
    terminal: { x: 1224, y: 41, width: 680, height: 820 },
  },
);

assertPair(
  "1536 class",
  { x: 0, y: 25, width: 1536, height: 839 },
  {
    main: { x: 16, y: 41, width: 955, height: 807 },
    terminal: { x: 979, y: 41, width: 541, height: 807 },
  },
);

assertPair(
  "1280 class",
  { x: -1280, y: 0, width: 1280, height: 720 },
  {
    main: { x: -1264, y: 16, width: 791, height: 688 },
    terminal: { x: -465, y: 16, width: 449, height: 688 },
  },
);

check(
  "too-small width falls back",
  planInitialWindowPair({ x: 0, y: 0, width: 1100, height: 900 }) === undefined,
);
check(
  "too-small height falls back",
  planInitialWindowPair({ x: 0, y: 0, width: 1920, height: 600 }) === undefined,
);
check(
  "malformed work area falls back",
  planInitialWindowPair({ x: 0, y: 0, width: Number.NaN, height: 900 }) === undefined,
);

if (failures.length) {
  console.error("initial-window-layout smoke FAILED:");
  for (const failure of failures) console.error(`  ✗ ${failure}`);
  process.exitCode = 1;
} else {
  console.log("initial-window-layout smoke passed");
}
