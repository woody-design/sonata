// Unit test for the pure hydration-stitch core (the honest unit): given a replay
// snapshot tagged with its seq boundary and the live chunks a renderer buffered
// while the snapshot IPC was in flight, stitchHydration() must emit the snapshot
// body then exactly the buffered chunks the snapshot doesn't already contain —
// contiguous, in order, once each. No live PTY needed; correctness is provable.
//
// Run: npm run build:main && node tests/smoke/terminal-hydration-stitch.mjs
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { hydrationGeneration, stitchHydration } = require("../../dist/shared/terminal-hydration");

const failures = [];
const check = (name, cond, detail) => {
  if (!cond) failures.push(`${name}${detail ? ` — ${detail}` : ""}`);
};
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

const chunk = (seq, generation = 1) => ({ data: `<${generation}:${seq}>`, generation, seq });
const snapshot = (data, seq, generation = 1) => ({ data, generation, seq });

// 1) The canonical case from the brief: snapshot at seq N, buffer holds N-2 … N+3.
//    Expect snapshot.data, then chunks N … N+3, in order, once each. N-2 and N-1
//    are already in the snapshot → dropped (would duplicate).
{
  const N = 5;
  const replay = snapshot("SNAP@5", N);
  const buffered = [N - 2, N - 1, N, N + 1, N + 2, N + 3].map((seq) => chunk(seq));
  const writes = stitchHydration(replay, buffered);
  const expected = ["SNAP@5", "<1:5>", "<1:6>", "<1:7>", "<1:8>"];
  check("boundary: exact writes", eq(writes, expected), JSON.stringify(writes));
  check("boundary: seq===N is written (first post-snapshot chunk)", writes.includes("<1:5>"));
  check("boundary: seq<N excluded (in snapshot)", !writes.includes("<1:3>") && !writes.includes("<1:4>"));
  check("boundary: no duplication", new Set(writes).size === writes.length);
  check("boundary: snapshot body first", writes[0] === "SNAP@5");
}

// 2) Null snapshot (task had no live mirror): no body, seq floor 0 → every
//    buffered chunk is written. Strictly better than starting blank.
{
  const writes = stitchHydration(null, [0, 1, 2].map((seq) => chunk(seq)));
  check(
    "null-snap: all buffered written, no body",
    eq(writes, ["<1:0>", "<1:1>", "<1:2>"]),
    JSON.stringify(writes),
  );
}

// 3) Empty buffer: just the snapshot body.
{
  const writes = stitchHydration(snapshot("ONLY", 9), []);
  check("empty-buffer: body only", eq(writes, ["ONLY"]), JSON.stringify(writes));
}

// 4) Whole buffer already covered by the snapshot: body only, nothing appended.
{
  const writes = stitchHydration(snapshot("COVERS", 10), [7, 8, 9].map((seq) => chunk(seq)));
  check("all-covered: body only", eq(writes, ["COVERS"]), JSON.stringify(writes));
}

// 5) Buffer order is preserved (the renderer buffers in broadcast == seq order;
//    the stitch must not reorder). Interleave to prove it copies order verbatim.
{
  const replay = snapshot("S", 0);
  const buffered = [chunk(0), chunk(1), chunk(2), chunk(3)];
  const writes = stitchHydration(replay, buffered);
  check(
    "order: preserved verbatim",
    eq(writes, ["S", "<1:0>", "<1:1>", "<1:2>", "<1:3>"]),
    JSON.stringify(writes),
  );
}

// 6) seq 0 snapshot with a chunk exactly at the boundary — regression against an
//    off-by-one at the low end.
{
  const writes = stitchHydration(snapshot("Z", 0), [chunk(0)]);
  check("floor-0: boundary chunk written", eq(writes, ["Z", "<1:0>"]), JSON.stringify(writes));
}

// 7) Reopen during hydration: a newer live generation invalidates the old
//    replay body and every old-generation buffered chunk.
{
  const replay = snapshot("OLD SNAPSHOT", 8, 4);
  const buffered = [chunk(6, 4), chunk(0, 5), chunk(1, 5)];
  const writes = stitchHydration(replay, buffered);
  check(
    "generation: newer live tail replaces stale snapshot",
    eq(writes, ["<5:0>", "<5:1>"]),
    JSON.stringify(writes),
  );
  check("generation: newest identity selected", hydrationGeneration(replay, buffered) === 5);
}

// 8) Conversely, a newer replay returned by main wins over buffered events
//    from the retired host that arrived before the replay boundary settled.
{
  const replay = snapshot("NEW SNAPSHOT", 2, 8);
  const buffered = [chunk(10, 7), chunk(11, 7)];
  const writes = stitchHydration(replay, buffered);
  check(
    "generation: newer snapshot drops retired tail",
    eq(writes, ["NEW SNAPSHOT"]),
    JSON.stringify(writes),
  );
}

const success = failures.length === 0;
console.log(JSON.stringify({ success, failures }, null, 2));
process.exitCode = success ? 0 : 1;
