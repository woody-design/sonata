// Integration probe (the DoD gate): a monotonic counter must survive a mid-stream
// hydration with NO drop and NO duplicate. This wires the REAL production seq
// pipeline end-to-end:
//   real TerminalHost.handlePtyData (assigns the ingest seq, broadcasts pty:data)
//     → real TerminalScrollback.snapshot() (serialize-in-flush-callback + seq)
//     → real stitchHydration() (the renderer's stitch decision)
// and replays the stitched output into an equivalent headless xterm — the ground
// truth of what the terminal window shows. A counter is the ideal probe: any gap
// (drop) or repeat (dup) is unmissably visible as a break in the +1 run.
//
// It does NOT cross Electron IPC or exercise terminal.ts's DOM glue — those are
// covered by the stitch unit test, the scrollback seq smoke, and the terminal
// e2e. This isolates the seq math on the real data path with a real PTY.
//
// A non-TUI stream (plain `echo`, no repaint) is deliberate: a full-screen TUI
// would repaint over a drop and mask exactly the bug under test.
//
// Run: npm run build && ELECTRON_RUN_AS_NODE=1 electron tests/smoke/terminal-hydration-counter.mjs
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { TerminalHost } = require("../../dist/runtime");
const { stitchHydration } = require("../../dist/shared/terminal-hydration");
const { Terminal } = require("@xterm/headless");
const { Unicode11Addon } = require("@xterm/addon-unicode11");

const COUNT = 800; // fits the mirror's 1000-line scrollback with margin (no scroll-out)
const HYDRATE_AT = 30; // create the terminal entry (start hydrating) once this integer streams
const PACE_SECONDS = 0.0018; // per-line pacing so the stream is still live across the hydration
const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "duet-hydration-counter-"));

const failures = [];
const check = (name, cond, detail) => {
  if (!cond) failures.push(`${name}${detail ? ` — ${detail}` : ""}`);
};

// The simulated terminal window: an xterm fed exactly as the renderer feeds it —
// nothing pre-entry (bytes live only in the main-process mirror then), buffered
// during hydration, stitched on snapshot, live-written after.
const view = new Terminal({ cols: 120, rows: 40, scrollback: 2000, allowProposedApi: true });
view.loadAddon(new Unicode11Addon());
view.unicode.activeVersion = "11";

let entryCreated = false; // renderer entry exists (⇒ buffering live chunks)
let hydrating = false;
let hydrated = false;
let seenPre = "";
const buffer = []; // {data, seq} captured while hydrating
const evidence = {};

let host;
let resolveDone;
let streamEnded = false;
const done = new Promise((r) => {
  resolveDone = r;
});

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

/** Let the live stream accumulate in the buffer up to `target` chunks (or until
 *  the stream ends / a deadline). This models one leg of the replay IPC round-
 *  trip: in the real app the renderer awaits renderer→main→renderer while live
 *  pty:data keeps arriving; the in-process serializeScrollback() has none of that
 *  latency, so without modeling it the hydration window is empty and the overlap
 *  dedup / tail stitch never run. Deterministic (waits on buffer growth, not a
 *  fixed sleep) so the race is exercised on every run. */
async function waitForBuffered(target) {
  const deadline = Date.now() + 3000;
  while (buffer.length < target && !streamEnded && Date.now() < deadline) {
    await delay(1);
  }
}

const AT_RE = new RegExp(`(^|[^0-9])${HYDRATE_AT}([^0-9]|$)`);

function onPtyData(data, seq) {
  if (!entryCreated) {
    // Pre-entry: the terminal window isn't open yet, so these bytes are only in
    // the main-process mirror (the snapshot will replay them). Detect the point
    // to "open the window" mid-stream.
    seenPre += data;
    if (AT_RE.test(seenPre)) {
      entryCreated = true;
      hydrating = true;
      void startHydration();
    }
    return;
  }
  if (hydrating) {
    buffer.push({ data, seq }); // buffer (don't drop) the live tail racing the snapshot
    return;
  }
  view.write(data); // hydrated: live path writes straight through
}

async function startHydration() {
  // Pre-serialize leg: live chunks that reach the mirror before it serializes.
  // They land in the snapshot (seq < floor) and must be DEDUP-SKIPPED from the
  // buffer — writing them would duplicate.
  await waitForBuffered(3);
  const snapshot = await host.serializeScrollback(); // the REAL mid-stream snapshot
  const seqFloor = snapshot ? snapshot.seq : 0;
  // Post-serialize leg: live chunks after the snapshot. These are the tail the
  // snapshot doesn't contain (seq >= floor) and must be WRITTEN — dropping them
  // is the bug this fix closes.
  await waitForBuffered(buffer.length + 3);
  evidence.snapshotSeq = seqFloor;
  evidence.bufferedDuringHydration = buffer.length;
  evidence.bufferedSkipped = buffer.filter((c) => c.seq < seqFloor).length; // already in snapshot
  evidence.bufferedWritten = buffer.filter((c) => c.seq >= seqFloor).length; // the stitched tail
  // Synchronous drain — mirrors hydrateData: no await from here to hydrating=false.
  if (snapshot) {
    view.resize(snapshot.cols, snapshot.rows);
  }
  for (const write of stitchHydration(snapshot, buffer)) {
    view.write(write);
  }
  buffer.length = 0;
  hydrating = false;
  hydrated = true;
}

host = new TerminalHost({
  taskId: "task-hydration-counter",
  defaultWorkspace: workspace,
  eventSink: (event) => {
    if (event.type === "pty:data") {
      onPtyData(event.payload.data, event.payload.seq);
    } else if (event.type === "pty:exit") {
      streamEnded = true;
      setTimeout(resolveDone, 80); // let any final chunk settle
    }
  },
});

host.startTask({
  command: "perl",
  args: ["-e", `$|=1; for(1..${COUNT}){ print "$_\\n"; select(undef,undef,undef,${PACE_SECONDS}); }`],
  cwd: workspace,
  rows: 40,
  cols: 120,
});

await done;
await new Promise((r) => view.write("", () => r())); // flush the view xterm

// Read what the terminal window would show: every buffer line (scrollback + screen).
const lines = [];
const buf = view.buffer.active;
for (let i = 0; i < buf.length; i += 1) {
  lines.push(buf.getLine(i)?.translateToString(true) ?? "");
}
const ints = lines
  .map((s) => s.trim())
  .filter((s) => /^\d+$/.test(s))
  .map(Number);

// Contiguity: each integer must be exactly one more than the last — a drop shows
// as a jump, a dup as a repeat, a reorder as a decrease.
let contiguous = true;
let breakAt = null;
for (let k = 1; k < ints.length; k += 1) {
  if (ints[k] !== ints[k - 1] + 1) {
    contiguous = false;
    breakAt = { index: k, prev: ints[k - 1], next: ints[k] };
    break;
  }
}

evidence.integersSeen = ints.length;
evidence.firstInteger = ints[0] ?? null;
evidence.lastInteger = ints[ints.length - 1] ?? null;
evidence.break = breakAt;

check("hydrated mid-stream", hydrated, "the hydration path did not run");
check("contiguous (no drop, no dup)", contiguous, breakAt ? `${breakAt.prev} -> ${breakAt.next} at #${breakAt.index}` : "");
check("reached the end (nothing lost late)", ints[ints.length - 1] === COUNT, `last=${ints[ints.length - 1]}`);
check("kept the start (nothing lost early)", ints[0] === 1, `first=${ints[0]}`);
check("saw a real stream", ints.length >= HYDRATE_AT, `only ${ints.length} integers`);
// Prove the run actually stressed the mechanism, not a degenerate empty window:
// the overlap (dedup-skipped) AND the tail (written) must both have been present.
check("exercised dedup (buffered chunks already in snapshot)", evidence.bufferedSkipped >= 1, `skipped=${evidence.bufferedSkipped}`);
check("exercised tail-stitch (buffered chunks after snapshot)", evidence.bufferedWritten >= 1, `written=${evidence.bufferedWritten}`);

host.dispose();
view.dispose();
try {
  fs.rmSync(workspace, { recursive: true, force: true });
} catch {}

const success = failures.length === 0;
console.log(JSON.stringify({ success, evidence, failures }, null, 2));
process.exitCode = success ? 0 : 1;
