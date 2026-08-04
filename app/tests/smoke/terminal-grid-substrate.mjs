import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

// SUBSTRATE HYGIENE for the two headless grids Sonata reads TUI state from —
// `TaskScreenModel` (approval + control-switch) and `StatusRegionTracker`
// (status region). Upstream sync 2026-08-03, SL-9. Two fences, one subject.
//
// FENCE 1 — ONE CLAMP. A task's geometry fans out to four mirrors: the PTY, the
// rendered-scrollback mirror, and the two grids. They agree only if all four
// are handed the same numbers. Before SL-9 each defended itself with its OWN
// rule (`Number(cols) || 120` / floor-and-keep-current / `Math.max(2, …)`),
// which is a structural path to divergence — and the divergence is silent: a
// grid a few columns off wraps text at different points, so `viewportText()`
// cuts lines differently, so the consent / rewind predicates that key on those
// lines read false while the dialog is on screen (the SL-2 failure mode through
// another entrance). `normalizeTerminalDimensions` is now the only clamp, and
// its branded return type makes "resize a mirror off raw numbers" a compile
// error. This file pins the BEHAVIOUR that type buys.
//
// FENCE 2 — THE SCROLLBACK RULE. D-1 refinement 4: "a grid consumer that finds
// itself needing scrollback is a channel-misuse smell — the answer is the
// stream, not a larger SCROLLBACK_ROWS." The clean way to make that PHYSICAL is
// `scrollback: 0`. The A/B probe
// (`dev/spikes/upstream-sync-2026-08/scrollback-ab/`) says that is a behaviour
// change, not a fence: 0 and 80 read byte-identically on every measured codex
// 0.146.0 stream, but diverge across an xterm resize REFLOW. So the ring stays
// and the rule keeps a MACHINE instead: nothing may read a buffer line outside
// the viewport window, and the constant may not drift without re-reading the
// measurement.
//
// Runs under Electron's node for node-pty. The PTY leg is observed END-TO-END —
// a child shell reporting its own kernel winsize via `stty size` on SIGWINCH —
// because the PTY is the one mirror whose geometry a fake cannot honestly
// stand in for. The two grids are read through their instances' `term` (a
// TypeScript-private that is a plain property at runtime): this fence's whole
// job is to observe internal geometry, and there is no public accessor —
// adding one purely for a test would put test scaffolding in the product.

const require = createRequire(import.meta.url);
const { TerminalHost, StatusRegionTracker, normalizeTerminalDimensions } = require("../../dist/runtime");

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../src");
const read = (relative) => fs.readFileSync(path.join(SRC, relative), "utf8");

const failures = [];
async function check(name, fn) {
  try {
    await fn();
    console.log(`ok   ${name}`);
  } catch (error) {
    failures.push(name);
    console.error(`FAIL ${name}`);
    console.error(error?.stack ?? error);
  }
}

// ───────────────────────────────────────────────────────────────────────────
// 1. normalizeTerminalDimensions — the single clamp, over the inputs a resize
//    can actually carry (the renderer's xterm dims cross IPC untyped).
// ───────────────────────────────────────────────────────────────────────────

const plain = (dimensions) => ({ cols: dimensions.cols, rows: dimensions.rows });

await check("clamp: an ordinary pair passes through untouched", () => {
  assert.deepEqual(plain(normalizeTerminalDimensions(132, 41)), { cols: 132, rows: 41 });
});

await check("clamp: garbage falls back to the documented default, never to zero", () => {
  for (const [cols, rows] of [
    [undefined, undefined],
    [null, null],
    [Number.NaN, Number.NaN],
    [0, 0],
    [-5, -1],
    [Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY],
    ["", "wide"],
  ]) {
    assert.deepEqual(
      plain(normalizeTerminalDimensions(cols, rows)),
      { cols: 120, rows: 36 },
      `cols=${String(cols)} rows=${String(rows)}`,
    );
  }
});

await check("clamp: a real but degenerate window is raised to the floor, NOT to the default", () => {
  // Reporting 120 columns to a CLI that has one would be a lie; reporting 2 is
  // a rounding of an unusable window. The distinction is the reason the clamp
  // has both a fallback and a floor.
  assert.deepEqual(plain(normalizeTerminalDimensions(1, 1)), { cols: 2, rows: 2 });
});

await check("clamp: fractions are floored (no mirror tolerates one)", () => {
  // node-pty stores 120.5 as given; @xterm's resize THROWS on any non-integer
  // ("This API only accepts integers") and its constructor accepts one only to
  // crash deeper. Measured against @xterm/headless 6.0.0.
  assert.deepEqual(plain(normalizeTerminalDimensions(100.7, 30.9)), { cols: 100, rows: 30 });
});

await check("clamp: idempotent — a second application is identity", () => {
  for (const [cols, rows] of [[132, 41], [1, 1], [-5, 0], [100.7, 30.9], [undefined, undefined]]) {
    const once = normalizeTerminalDimensions(cols, rows);
    const twice = normalizeTerminalDimensions(once.cols, once.rows);
    assert.deepEqual(plain(twice), plain(once), `cols=${String(cols)} rows=${String(rows)}`);
  }
});

// ───────────────────────────────────────────────────────────────────────────
// 2. The fan-out: one clamp, four mirrors, identical geometry.
// ───────────────────────────────────────────────────────────────────────────

const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "sonata-grid-substrate-"));

// A shell that reports the geometry the KERNEL gave its pty, once at boot and
// again on every SIGWINCH. This is the PTY's own account of its size — not
// node-pty's bookkeeping, and not something a stub could fake.
const WINSIZE_REPORTER = 'trap "stty size" WINCH; stty size; while :; do sleep 0.15; done';

// Faithful to `RuntimeController.assembleTaskRuntime`, INCLUDING its
// registration order — which is load-bearing (SL-9 review M1). The controller
// routes runtime events through `taskRuntimes.get(taskId)`, and startTask emits
// `task:started` SYNCHRONOUSLY, before the freshly built runtime is in that map.
// So the status grid never sees its own boot event in production. A rig that
// forwarded it anyway would show four agreeing mirrors while production had
// three — the fence would be green about a routing that does not exist. Here
// forwarding starts only after startTask returns, and the grid is built from
// `StartedPty.dimensions`, exactly as the controller does it.
function makeRig(taskId) {
  let ptyText = "";
  let tracker = null;
  let registered = false;
  const startedPayloads = [];
  const host = new TerminalHost({
    taskId,
    provider: "codex",
    defaultWorkspace: workspace,
    eventSink: (event) => {
      if (event.type === "pty:data") {
        ptyText += event.payload.data;
      }
      if (event.type === "task:started") {
        startedPayloads.push(event.payload);
      }
      if (registered) {
        tracker?.handleRuntimeEvent(event);
      }
    },
  });
  return {
    host,
    startedPayloads,
    get tracker() {
      return tracker;
    },
    /** The controller's own choreography: spawn, then build the status grid
     *  from the host's clamped boot value, then start routing events to it. */
    start(options) {
      const runtime = host.startTask({ command: "sh", args: ["-c", WINSIZE_REPORTER], cwd: workspace, ...options });
      tracker = new StatusRegionTracker({
        taskId,
        provider: "codex",
        eventSink: () => {},
        dimensions: runtime.dimensions,
      });
      registered = true;
      return runtime;
    },
    /** The last winsize the child reported, as {cols, rows}, or null. */
    lastReportedWinsize() {
      const matches = [...ptyText.matchAll(/(\d+) (\d+)/g)];
      const last = matches.at(-1);
      return last ? { cols: Number(last[2]), rows: Number(last[1]) } : null;
    },
    dispose() {
      host.dispose();
      tracker?.dispose();
    },
  };
}

async function waitForWinsize(rig, expected, timeoutMs = 4000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const seen = rig.lastReportedWinsize();
    if (seen && seen.cols === expected.cols && seen.rows === expected.rows) {
      return seen;
    }
    if (Date.now() > deadline) {
      throw new Error(`pty never reported ${expected.cols}x${expected.rows} (last: ${JSON.stringify(seen)})`);
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

/** Every mirror's ACTUAL geometry, read from the mirror itself. */
async function mirrorGeometry(rig) {
  const snapshot = await rig.host.serializeScrollback();
  return {
    scrollbackMirror: { cols: snapshot.cols, rows: snapshot.rows },
    approvalGrid: { cols: rig.host.screenModel.term.cols, rows: rig.host.screenModel.term.rows },
    statusGrid: { cols: rig.tracker.term.cols, rows: rig.tracker.term.rows },
  };
}

/** The whole invariant in one assertion: all four mirrors, one geometry. */
async function assertAllMirrorsAgree(rig, expected, label) {
  const winsize = await waitForWinsize(rig, expected);
  const geometry = await mirrorGeometry(rig);
  assert.deepEqual(
    { pty: winsize, ...geometry },
    {
      pty: expected,
      scrollbackMirror: expected,
      approvalGrid: expected,
      statusGrid: expected,
    },
    label,
  );
}

/** The production fan-out shape, verbatim (fence 3 pins that it is verbatim). */
function fanOutResize(rig, cols, rows) {
  const dimensions = normalizeTerminalDimensions(cols, rows);
  rig.host.resize(dimensions);
  rig.tracker.resize(dimensions);
  return plain(dimensions);
}

await check("fan-out: boot geometry reaches all four mirrors identically", async () => {
  // The status grid's leg here is the DIRECT hand-off (`StartedPty.dimensions`),
  // not the `task:started` event — which is why the requested size is
  // deliberately NOT the default: with the hand-off removed the grid would fall
  // back to 120x36 and this case goes red, whereas a 120x36 request would have
  // passed either way and proved nothing.
  const rig = makeRig("grid-substrate-boot");
  try {
    rig.start({ cols: 132, rows: 41 });
    await assertAllMirrorsAgree(rig, { cols: 132, rows: 41 }, "boot");
  } finally {
    rig.dispose();
  }
});

await check("fan-out: garbage boot dims land clamped on all four mirrors AND on the event", async () => {
  // Two things at once. (1) The boot clamp covers the request, not just the
  // live-resize path — Create/OpenTaskRequest carry optional cols/rows that no
  // caller sends today, so this is the latent half. (2) The `task:started`
  // payload is the PUBLIC record of what the PTY was built at; asserting it
  // here makes its clamped-ness behaviourally observable, which a source regex
  // over the emit block cannot be trusted to do alone.
  const rig = makeRig("grid-substrate-boot-garbage");
  try {
    rig.start({ cols: -5, rows: Number.NaN });
    await assertAllMirrorsAgree(rig, { cols: 120, rows: 36 }, "boot from garbage");
    assert.equal(rig.startedPayloads.length, 1, "exactly one task:started");
    assert.deepEqual(
      { cols: rig.startedPayloads[0].cols, rows: rig.startedPayloads[0].rows },
      { cols: 120, rows: 36 },
      "task:started must carry the clamped pair, never the raw request",
    );
  } finally {
    rig.dispose();
  }
});

await check("fan-out: a live resize reaches all four mirrors identically", async () => {
  const rig = makeRig("grid-substrate-resize");
  try {
    rig.start({ cols: 120, rows: 36 });
    await assertAllMirrorsAgree(rig, { cols: 120, rows: 36 }, "boot");
    assert.deepEqual(fanOutResize(rig, 100, 30), { cols: 100, rows: 30 });
    await assertAllMirrorsAgree(rig, { cols: 100, rows: 30 }, "after resize");
  } finally {
    rig.dispose();
  }
});

await check("fan-out: a degenerate window lands on the SAME floor everywhere", async () => {
  // The single-side-clamp case in its purest form: pre-SL-9 the grids floored
  // at 2 while the PTY took whatever it was given.
  const rig = makeRig("grid-substrate-floor");
  try {
    rig.start({ cols: 120, rows: 36 });
    await assertAllMirrorsAgree(rig, { cols: 120, rows: 36 }, "boot");
    assert.deepEqual(fanOutResize(rig, 1, 1), { cols: 2, rows: 2 });
    await assertAllMirrorsAgree(rig, { cols: 2, rows: 2 }, "after a 1x1 request");
  } finally {
    rig.dispose();
  }
});

await check("fan-out: a hostile resize neither throws nor skews the mirrors", async () => {
  // MEASURED reason this matters: node-pty's resize THROWS on a non-positive
  // dimension (unixTerminal.js). The PTY leg runs FIRST in the host's fan-out,
  // so before the clamp moved upstream a single negative width threw after the
  // PTY had resized and before either grid had — a permanent skew plus an
  // exception out of the IPC handler.
  const rig = makeRig("grid-substrate-hostile");
  try {
    rig.start({ cols: 110, rows: 40 });
    await assertAllMirrorsAgree(rig, { cols: 110, rows: 40 }, "boot");
    assert.deepEqual(fanOutResize(rig, -5, Number.NaN), { cols: 120, rows: 36 });
    await assertAllMirrorsAgree(rig, { cols: 120, rows: 36 }, "after a hostile request");
  } finally {
    rig.dispose();
  }
});

await check("fan-out: a fractional resize floors identically everywhere", async () => {
  const rig = makeRig("grid-substrate-fraction");
  try {
    rig.start({ cols: 120, rows: 36 });
    await assertAllMirrorsAgree(rig, { cols: 120, rows: 36 }, "boot");
    assert.deepEqual(fanOutResize(rig, 100.7, 30.9), { cols: 100, rows: 30 });
    await assertAllMirrorsAgree(rig, { cols: 100, rows: 30 }, "after a fractional request");
  } finally {
    rig.dispose();
  }
});

fs.rmSync(workspace, { recursive: true, force: true, maxRetries: 5 });

// ───────────────────────────────────────────────────────────────────────────
// 3. Source fence: the clamp exists in ONE place and the mirrors carry none.
//    Behaviour alone cannot catch a re-added clamp that happens to agree with
//    the current one today and stops agreeing when the shared rule changes.
// ───────────────────────────────────────────────────────────────────────────

/** The body of `name(` … up to the matching close brace at method indent. */
function methodBody(source, signature) {
  const start = source.indexOf(signature);
  assert.notEqual(start, -1, `signature not found: ${signature}`);
  // Search AFTER the signature: a destructured parameter or a `= {}` default
  // puts braces inside the signature itself.
  const open = source.indexOf("{", start + signature.length);
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    if (source[i] === "{") depth += 1;
    else if (source[i] === "}") {
      depth -= 1;
      if (depth === 0) return source.slice(open + 1, i);
    }
  }
  throw new Error(`unbalanced braces after ${signature}`);
}

const MIRROR_RESIZES = [
  ["runtime/terminal-host/task-screen-model.ts", "resize(dimensions: TerminalDimensions)"],
  ["runtime/working-status/status-region-tracker.ts", "resize(dimensions: TerminalDimensions)"],
  ["runtime/terminal-host/terminal-scrollback.ts", "resize({ cols, rows }: TerminalDimensions)"],
  ["runtime/terminal-host/terminal-host.ts", "resize(dimensions: TerminalDimensions)"],
];

for (const [file, signature] of MIRROR_RESIZES) {
  await check(`source fence: ${file} resize carries no clamp of its own`, () => {
    const body = methodBody(read(file), signature);
    assert.ok(!/Math\.(max|min|floor|round)/.test(body), `a clamp reappeared in ${file}'s resize:\n${body}`);
    assert.ok(!/normalizeTerminalDimensions/.test(body), `${file} re-normalizes instead of trusting the fan-out`);
    assert.ok(!/\|\|\s*DEFAULT_/.test(body), `${file} re-applies a default instead of trusting the fan-out`);
  });
}

await check("source fence: the live-resize fan-out clamps ONCE and shares the result", () => {
  const body = methodBody(read("main/runtime-controller.ts"), "resizeTerminal(taskId: TaskId, cols: number, rows: number)");
  const clamps = [...body.matchAll(/normalizeTerminalDimensions\(/g)];
  assert.equal(clamps.length, 1, "the fan-out must clamp exactly once");
  assert.match(body, /terminalHost\.resize\(dimensions\)/, "the host must receive the clamped value");
  assert.match(body, /statusTracker\.resize\(dimensions\)/, "the status grid must receive the SAME clamped value");
});

await check("source fence: the boot fan-out clamps ONCE and shares the result", () => {
  const source = read("runtime/terminal-host/terminal-host.ts");
  const body = methodBody(source, "startTask(options: StartTaskOptions = {})");
  assert.equal([...body.matchAll(/normalizeTerminalDimensions\(/g)].length, 1, "boot must clamp exactly once");
  // Each consumer is matched inside ITS OWN block. A bare /cols: dimensions\.cols/
  // over the whole body would be satisfied by the pty.spawn call alone, leaving
  // the task:started payload and the return value unpinned — a revert of either
  // to `options.cols` would pass (SL-9 review M2).
  const block = (anchor) => {
    const at = body.indexOf(anchor);
    assert.notEqual(at, -1, `block not found: ${anchor}`);
    return body.slice(at, body.indexOf("});", at));
  };
  const consumers = [
    ["pty.spawn", block("pty.spawn(command, args, {")],
    ["task:started payload", block('this.emitEvent("task:started", {')],
    ["StartedPty return value", body.slice(body.lastIndexOf("return {"))],
  ];
  for (const [label, region] of consumers) {
    assert.match(region, /dimensions(\.(cols|rows)|,)/, `${label} is not reading the clamped value`);
    assert.ok(!/options\.(cols|rows)/.test(region), `${label} reads the RAW request`);
  }
  assert.match(body, /new TerminalScrollback\(dimensions\)/, "the scrollback mirror is not built from the clamped value");
  assert.match(body, /new TaskScreenModel\(dimensions\)/, "the approval grid is not built from the clamped value");
});

await check("source fence: the status grid is handed the host's OWN boot value", () => {
  // The leg the review found dead (M1). The controller cannot let this grid
  // learn its size from `task:started` — that event fires before the runtime is
  // registered — so the hand-off is the only correct source, and it must be the
  // host's value rather than a second reading of the request.
  const body = methodBody(read("main/runtime-controller.ts"), "private assembleTaskRuntime(params: {");
  const construction = body.slice(body.indexOf("new StatusRegionTracker({"));
  assert.match(construction, /dimensions: runtime\.dimensions/, "the status grid is not sized from StartedPty");
  assert.ok(
    body.indexOf("terminalHost.startTask(") < body.indexOf("new StatusRegionTracker({"),
    "the status grid must be built AFTER the spawn that produces its dimensions",
  );
});

await check("source fence: no fourth clamp site has appeared", () => {
  // Every CALL of the clamp, enumerated (`…(` — prose mentions in doc comments
  // are not call sites). A new one is not automatically wrong, but it IS a new
  // place geometry can be decided, so it must be argued for here rather than
  // appear quietly.
  const expected = new Map([
    ["runtime/terminal-dimensions.ts", 1], // the definition itself
    ["runtime/terminal-host/terminal-host.ts", 1], // fan-out #1 (boot)
    ["main/runtime-controller.ts", 1], // fan-out #2 (live resize)
    // The tracker's `task:started` handler re-normalizes a payload whose
    // numbers crossed an event boundary and lost the brand. Provably identity
    // (the emitter used this same function; the function is idempotent). Its
    // BOOT geometry does not clamp — it is handed the host's clamped value.
    ["runtime/working-status/status-region-tracker.ts", 1],
  ]);
  const found = new Map();
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (/\.tsx?$/.test(entry.name)) {
        const hits = [...fs.readFileSync(full, "utf8").matchAll(/normalizeTerminalDimensions\(/g)].length;
        if (hits > 0) {
          found.set(path.relative(SRC, full), hits);
        }
      }
    }
  };
  walk(SRC);
  assert.deepEqual(
    [...found.keys()].sort(),
    [...expected.keys()].sort(),
    "the set of files that clamp terminal geometry changed",
  );
  for (const [file, count] of expected) {
    assert.equal(found.get(file), count, `${file} clamps ${found.get(file)}x, expected ${count}x`);
  }
});

// ───────────────────────────────────────────────────────────────────────────
// 4. The scrollback rule, with a machine behind it.
// ───────────────────────────────────────────────────────────────────────────

const GRID_FILES = [
  "runtime/terminal-host/task-screen-model.ts",
  "runtime/working-status/status-region-tracker.ts",
];

await check("scrollback rule: no runtime/main code reads a buffer line outside the viewport", () => {
  // The standing rule made checkable. Both grid consumers read exactly
  // `buffer.getLine(buffer.viewportY + y)` for y in [0, term.rows) — the
  // viewport and nothing else. Any other buffer read (an index below the
  // viewport top, `baseY`, a scroll API) is a temporal query on a spatial
  // substrate: the answer is the stream, not a bigger ring.
  const offenders = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      if (!/\.tsx?$/.test(entry.name)) continue;
      const relative = path.relative(SRC, full);
      const source = fs.readFileSync(full, "utf8");
      for (const [index, line] of source.split("\n").entries()) {
        const suspicious =
          /\.getLine\(/.test(line) || /\bbaseY\b/.test(line) || /\.scroll(Lines|ToTop|ToBottom|ToLine)\(/.test(line);
        if (!suspicious) continue;
        const sanctioned = GRID_FILES.includes(relative) && /buffer\.getLine\(buffer\.viewportY \+ y\)/.test(line);
        if (!sanctioned) {
          offenders.push(`${relative}:${index + 1}  ${line.trim()}`);
        }
      }
    }
  };
  // Scoped to the TUI-consumer territory. The renderer's xterm is the USER's
  // terminal (10k scrollback, by design) and is governed by nothing here.
  walk(path.join(SRC, "runtime"));
  walk(path.join(SRC, "main"));
  assert.deepEqual(offenders, [], "a grid consumer started reading outside the viewport");
});

for (const file of GRID_FILES) {
  await check(`scrollback rule: ${file} pins the ring to its measured basis`, () => {
    const source = read(file);
    assert.match(source, /const SCROLLBACK_ROWS = 80;/, "the ring size changed");
    assert.match(source, /scrollback: SCROLLBACK_ROWS/, "the emulator stopped reading the constant");
    // The number is only defensible with its measurement attached. Both files
    // must name the probe (one carries the finding, the other cites it), so a
    // future edit cannot change the ring without meeting the evidence.
    assert.match(source, /scrollback-ab|SL-9 A\/B probe/, "the measured basis is no longer recorded beside the constant");
  });
}

await check("scrollback rule: the two grids are built to the SAME conventions", () => {
  // Compares the constructor's OPTION TEXT (the per-file pin above covers the
  // ring's VALUE). They read the same screens for different purposes; a
  // divergence in how the emulator is constructed — a different option, an
  // addon on one only — would make them disagree about one frame.
  const options = GRID_FILES.map((file) => {
    const source = read(file);
    const start = source.indexOf("new Terminal({");
    assert.notEqual(start, -1, `${file} no longer constructs a Terminal`);
    return source
      .slice(start, source.indexOf("})", start))
      .replace(/\s+/g, " ")
      .trim();
  });
  assert.equal(options[0], options[1], "the two grid emulators are constructed differently");
});

const success = failures.length === 0;
console.log(JSON.stringify({ success, failures }, null, 2));
if (success) {
  console.log("terminal-grid-substrate smoke: ok");
}
process.exitCode = success ? 0 : 1;
