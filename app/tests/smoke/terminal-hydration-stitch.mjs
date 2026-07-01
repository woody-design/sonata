// Unit test for the pure hydration-stitch core (the honest unit): given a replay
// snapshot tagged with its seq boundary and the live chunks a renderer buffered
// while the snapshot IPC was in flight, stitchHydration() must emit the snapshot
// body then exactly the buffered chunks the snapshot doesn't already contain —
// contiguous, in order, once each. No live PTY needed; correctness is provable.
//
// Run: npm run build:main && node tests/smoke/terminal-hydration-stitch.mjs
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { stitchHydration } = require("../../dist/shared/terminal-hydration");

const failures = [];
const check = (name, cond, detail) => {
  if (!cond) failures.push(`${name}${detail ? ` — ${detail}` : ""}`);
};
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

const chunk = (seq) => ({ data: `<${seq}>`, seq });

// 1) The canonical case from the brief: snapshot at seq N, buffer holds N-2 … N+3.
//    Expect snapshot.data, then chunks N … N+3, in order, once each. N-2 and N-1
//    are already in the snapshot → dropped (would duplicate).
{
  const N = 5;
  const snapshot = { data: "SNAP@5", seq: N };
  const buffered = [N - 2, N - 1, N, N + 1, N + 2, N + 3].map(chunk);
  const writes = stitchHydration(snapshot, buffered);
  const expected = ["SNAP@5", "<5>", "<6>", "<7>", "<8>"];
  check("boundary: exact writes", eq(writes, expected), JSON.stringify(writes));
  check("boundary: seq===N is written (first post-snapshot chunk)", writes.includes("<5>"));
  check("boundary: seq<N excluded (in snapshot)", !writes.includes("<3>") && !writes.includes("<4>"));
  check("boundary: no duplication", new Set(writes).size === writes.length);
  check("boundary: snapshot body first", writes[0] === "SNAP@5");
}

// 2) Null snapshot (task had no live mirror): no body, seq floor 0 → every
//    buffered chunk is written. Strictly better than starting blank.
{
  const writes = stitchHydration(null, [0, 1, 2].map(chunk));
  check("null-snap: all buffered written, no body", eq(writes, ["<0>", "<1>", "<2>"]), JSON.stringify(writes));
}

// 3) Empty buffer: just the snapshot body.
{
  const writes = stitchHydration({ data: "ONLY", seq: 9 }, []);
  check("empty-buffer: body only", eq(writes, ["ONLY"]), JSON.stringify(writes));
}

// 4) Whole buffer already covered by the snapshot: body only, nothing appended.
{
  const writes = stitchHydration({ data: "COVERS", seq: 10 }, [7, 8, 9].map(chunk));
  check("all-covered: body only", eq(writes, ["COVERS"]), JSON.stringify(writes));
}

// 5) Buffer order is preserved (the renderer buffers in broadcast == seq order;
//    the stitch must not reorder). Interleave to prove it copies order verbatim.
{
  const snapshot = { data: "S", seq: 0 };
  const buffered = [chunk(0), chunk(1), chunk(2), chunk(3)];
  const writes = stitchHydration(snapshot, buffered);
  check("order: preserved verbatim", eq(writes, ["S", "<0>", "<1>", "<2>", "<3>"]), JSON.stringify(writes));
}

// 6) seq 0 snapshot with a chunk exactly at the boundary — regression against an
//    off-by-one at the low end.
{
  const writes = stitchHydration({ data: "Z", seq: 0 }, [chunk(0)]);
  check("floor-0: boundary chunk written", eq(writes, ["Z", "<0>"]), JSON.stringify(writes));
}

const success = failures.length === 0;
console.log(JSON.stringify({ success, failures }, null, 2));
process.exitCode = success ? 0 : 1;
