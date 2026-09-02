// Q19 (2026-09 sync, SL-5) — what the PRODUCTION drive does when the `from` it
// was handed is stale. The A/B fixture for the SL-5 fix.
//
// PREMISE, measured in Q18-G: Sonata's permission mirror is the hook payload's
// `permission_mode`, reconciled LAZILY. An undriven flip — the user's own
// Shift+Tab in the Terminal pane, or any server-side / Remote-Control change —
// fires NO hook (measured: 65s of silence), so `task.permissionMode` stays wrong
// until the next turn. `renderer/main.ts:508` passes exactly that value as the
// switch's `from`, and `writePermissionStep` seeds `pressedFrom` from it. So the
// per-step landing validator (`expectedPermissionLandings`) is anchored on a
// mode the CLI left minutes ago.
//
// PREDICTION (from the code, to be confirmed or falsified here): every real
// landing then reads as a non-successor of the stale anchor → `fail loud` on
// step 1 → return-home, whose anchor is the SAME stale value → every return
// step fails too → the full 12-step return cap → needs-attention, with the
// session left in whatever mode 13 blind presses reached. If that is what
// happens, the drive is worse than useless: it changes the mode ~13 times and
// then says it could not.
//
// Three arms, all on the real TerminalHost + the real engine:
//   H1 — STALE `from` (the bug shape): flip natively, then drive with the
//        pre-flip mode as `from`.
//   H2 — TRUE `from` (the control): the identical drive with the mode actually
//        on screen. Isolates staleness as the variable.
//   H3 — STALE `from`, target ALREADY REACHED: the flip landed on the mode the
//        user then picks. The honest answer is "settled, nothing to do"; the
//        `target === origin` no-op check compares against the stale value, so it
//        cannot see that.
//
// Re-run after the fix; the capture filename carries the arm label so the two
// runs sit side by side (`PHASE=pre` / `PHASE=post`).
//
// Scratch dirs are /private/tmp/... (never the agent scratchpad, whose path
// embeds the username): these frames become findings and the pre-push leak
// fence scans blob content.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";

const OUT_DIR = new URL(".", import.meta.url).pathname;
const APP_DIR = new URL("../../../app/", import.meta.url).pathname;
const require = createRequire(APP_DIR + "package.json");
const { Terminal } = require("@xterm/headless");
const {
  TerminalHost,
  HookWatcher,
  claudeHooksDirectory,
  parseClaudePermissionModeLine,
} = require(APP_DIR + "dist/runtime");

const { Capture, KEYS } = await import("../../upstream-sync-2026-08/claude/driver.mjs");

const EXPECT_VERSION = "2.1.258";
const PHASE = process.env.PHASE === "post" ? "post" : "pre";
const ROOT = `/private/tmp/sonata-sync-2026-09/stale-origin-${PHASE}`;
const COLS = 120;
const ROWS = 40;
const SCAN_LIMIT = 4096;

const HOME = os.homedir();
const USER_MUNGED = `-${HOME.replace(/\//g, "-").replace(/^-/, "")}-`;
const sanitize = (value) =>
  String(value).split(HOME).join("$HOME").split(USER_MUNGED).join("-$USER_MUNGED-");

function readVersion() {
  return execFileSync("claude", ["--version"], { encoding: "utf8" }).trim();
}
function pinVersionOrExit(where) {
  const version = readVersion();
  if (!version.startsWith(EXPECT_VERSION)) {
    console.log(JSON.stringify({ success: false, reason: `binary moved off ${EXPECT_VERSION} (${where})`, version }));
    process.exit(2);
  }
  return version;
}
const version = pinVersionOrExit("probe start");

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

function modeLineRow(screen) {
  for (const line of screen.split("\n")) {
    const t = line.trim();
    if (/[⏸⏵]/.test(t)) return t;
  }
  return null;
}

class HostSession {
  constructor(name) {
    this.name = name;
    this.t0 = Date.now();
    this.hooks = [];
    this.switchEvents = [];
    this.raw = "";
    this.notes = [];
    this.ptyExited = false;
    /** The mode-line row every time it CHANGES, sampled off the grid. This is
     *  the measurement H1 exists for — not "how many keys were written" but how
     *  many times the session's permission mode actually moved, which is the
     *  blast radius of a drive that cannot succeed. Ground truth on the effect,
     *  not an inference from events (and it needs no host internals). */
    this.modeTrail = [];
    this.modeTrailTimer = null;

    const runRoot = path.join(ROOT, name);
    fs.rmSync(runRoot, { recursive: true, force: true });
    this.workspace = path.join(runRoot, "ws");
    this.runtimeDir = path.join(runRoot, "runtime");
    fs.mkdirSync(this.workspace, { recursive: true });
    fs.mkdirSync(this.runtimeDir, { recursive: true });

    this.term = new Terminal({ cols: COLS, rows: ROWS, allowProposedApi: true, scrollback: 4000 });
    this.host = new TerminalHost({
      taskId: `task-q19-${name}`,
      provider: "claude",
      defaultWorkspace: this.workspace,
      eventSink: (event) => this.onHostEvent(event),
    });
    this.watcher = new HookWatcher({
      sinkDir: claudeHooksDirectory,
      pollMs: 100,
      onPayload: (payload) => this.onHookPayload(payload),
      onError: (error, filePath) => this.notes.push(`hook-watcher error ${filePath}: ${error.message}`),
    });
  }

  at() {
    return Date.now() - this.t0;
  }

  screen() {
    const b = this.term.buffer.active;
    const lines = [];
    for (let y = 0; y < this.term.rows; y++) {
      const line = b.getLine(b.viewportY + y);
      lines.push(line ? line.translateToString(true) : "");
    }
    while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
    return lines.join("\n");
  }

  onHostEvent(event) {
    if (event.type === "pty:data") {
      this.raw += event.payload.data;
      this.term.write(event.payload.data);
      return;
    }
    if (event.type === "pty:exit") this.ptyExited = true;
    if (event.type === "control-switch:state") {
      this.switchEvents.push({ atMs: this.at(), ...event.payload });
    }
    if (event.type === "approval:detected") {
      this.notes.push(`approval:detected ${event.payload?.kind ?? "?"} at ${this.at()}ms`);
    }
  }

  onHookPayload(payload) {
    const event = typeof payload.hook_event_name === "string" ? payload.hook_event_name : "<none>";
    this.hooks.push({ atMs: this.at(), event, permission_mode: payload.permission_mode ?? null });
    if (event === "SessionStart") this.host.noteHookSessionStart();
  }

  async boot(permissionMode) {
    this.host.startTask({
      cwd: this.workspace,
      runtimeDir: this.runtimeDir,
      permissionMode,
      rows: ROWS,
      cols: COLS,
      approvalBroker: false,
    });
    this.watcher.watchWorkspace(this.runtimeDir);
    let trustAnswered = false;
    const ok = await this.waitUntil(() => {
      if (!trustAnswered && this.notes.some((n) => n.startsWith("approval:detected workspace-trust"))) {
        trustAnswered = true;
        void this.host.sendApprove().catch((e) => this.notes.push(`trust approve error: ${e?.message ?? e}`));
      }
      return this.host.acceptsPromptInput();
    }, 60_000);
    this.notes.push(`ready=${ok} at ${this.at()}ms`);
    await delay(3000);
    return ok;
  }

  async waitUntil(predicate, timeoutMs, stepMs = 100) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      if (predicate()) return true;
      if (Date.now() > deadline || this.ptyExited) return false;
      await delay(stepMs);
    }
  }

  gridMode() {
    return { row: modeLineRow(this.screen()), parsed: parseClaudePermissionModeLine(this.screen()) };
  }

  /** Sample the mode-line row at 15ms and append every CHANGE. Q17 measured a
   *  27ms press→repaint latency and the engine issues its next press on the
   *  receipt, so consecutive steps land ~50ms apart; 15ms resolves them. The
   *  grid trail can still ALIAS (two steps inside one sample), so
   *  `rawModeLinePrints` below is carried beside it as an exact cross-check —
   *  every repaint prints its mode line into the stream, and the stream keeps
   *  all of them. */
  startModeTrail() {
    let last = modeLineRow(this.screen());
    this.modeTrail = [{ atMs: this.at(), row: last }];
    this.rawAtTrailStart = this.raw.length;
    this.modeTrailTimer = setInterval(() => {
      const row = modeLineRow(this.screen());
      if (row !== last) {
        last = row;
        this.modeTrail.push({ atMs: this.at(), row });
      }
    }, 15);
    this.modeTrailTimer.unref?.();
  }

  /** How many mode lines the CLI PRINTED since the trail started — one per
   *  footer repaint, i.e. one per accepted Shift+Tab. Counted on the raw stream
   *  with the parser's own glyph anchor so prose cannot inflate it. */
  rawModeLinePrints() {
    const slice = this.raw.slice(this.rawAtTrailStart ?? 0);
    const compact = slice.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "").replace(/\s+/g, "").toLowerCase();
    const matches = compact.match(/[⏸⏵](?:acceptedits|manualmode|planmode|automode|don'task)on/g);
    return matches ? matches.length : 0;
  }

  stopModeTrail() {
    if (this.modeTrailTimer) clearInterval(this.modeTrailTimer);
    this.modeTrailTimer = null;
  }

  dispose() {
    this.stopModeTrail();
    try { this.watcher.dispose(); } catch { /* already stopped */ }
    try { this.host.dispose(); } catch { /* already gone */ }
  }
}

/** One arm: boot, optionally flip natively N times, then drive with the given
 *  `from` and record everything the decision needs. */
async function runArm(cap, { name, nativeFlips, target, from, why }) {
  const s = new HostSession(name);
  try {
    const ready = await s.boot("default");
    const gridAtBoot = s.gridMode();

    // The undriven flip(s) — `writeUserInput`, the Terminal pane's own path.
    for (let i = 0; i < nativeFlips; i++) {
      s.host.writeUserInput(KEYS.shiftTab);
      await delay(900);
    }
    const gridAfterFlip = s.gridMode();
    cap.add(
      `${name} — after ${nativeFlips} undriven Shift+Tab`,
      JSON.stringify({ gridAtBoot, gridAfterFlip }, null, 2),
    );

    s.startModeTrail();
    const t0 = Date.now();
    const before = s.switchEvents.length;
    const response = s.host.injectClaudeControlSwitch("permission", target, from);
    // The predicted worst case is 13 presses, several burning the full 1500ms
    // per-step window — well under 60s. A window this generous means a timeout
    // here is a wedge, not a slow path.
    const resolved = await s.waitUntil(
      () => s.switchEvents.slice(before).some((e) => e.phase === "settled" || e.phase === "needs-attention"),
      60_000,
    );
    await delay(1200);
    const emitted = s.switchEvents.slice(before);
    const terminal = emitted.find((e) => e.phase === "settled" || e.phase === "needs-attention") ?? null;
    const entry = {
      name,
      why,
      ready,
      target,
      fromPassed: from,
      trueModeOnScreenAtDriveStart: gridAfterFlip.parsed,
      fromWasStale: gridAfterFlip.parsed !== from,
      response,
      resolved,
      elapsedMs: Date.now() - t0,
      terminalPhase: terminal ? terminal.phase : null,
      observedModes: terminal ? (terminal.observedModes ?? null) : null,
      // The blast radius: how many times the drive actually moved the session's
      // mode (the trail starts at the pre-drive row, so changes = length - 1).
      modeChangesDuringDrive: Math.max(0, s.modeTrail.length - 1),
      rawModeLinePrints: s.rawModeLinePrints(),
      modeTrail: s.modeTrail,
      gridAfterDrive: s.gridMode(),
      landedOnTarget: s.gridMode().parsed === target,
      hooks: s.hooks,
      notes: s.notes,
    };
    cap.frame(
      { screen: () => s.screen(), cursor: () => ({ x: 0, y: 0 }) },
      `${name} — screen after the drive`,
    );
    cap.add(`${name} — verdict`, JSON.stringify(entry, null, 2));
    s.stopModeTrail();
    return entry;
  } finally {
    s.dispose();
    await delay(800);
  }
}

async function main() {
  fs.rmSync(ROOT, { recursive: true, force: true });
  fs.mkdirSync(ROOT, { recursive: true });
  const cap = new Capture(
    path.join(OUT_DIR, `q19-stale-origin-drive.${PHASE}.capture.txt`),
    `Q19 (${PHASE}-fix) — the production permission drive under a STALE \`from\` (claude ${version})`,
  );
  const results = { version, phase: PHASE, arms: [] };

  results.arms.push(
    await runArm(cap, {
      name: "h1-stale",
      nativeFlips: 1, // default → acceptEdits, undriven
      target: "plan",
      from: "default", // the pre-flip mirror value the renderer would pass
      why: "the bug shape: the mirror still says `default`, the CLI is in `acceptEdits`",
    }),
  );
  results.arms.push(
    await runArm(cap, {
      name: "h2-true",
      nativeFlips: 1,
      target: "plan",
      from: "acceptEdits", // the mode actually on screen
      why: "control: the identical drive with a TRUE `from` — isolates staleness",
    }),
  );
  results.arms.push(
    await runArm(cap, {
      name: "h3-stale-already-there",
      nativeFlips: 1,
      target: "acceptEdits",
      from: "default",
      why: "the flip already reached the target; the `target === origin` no-op check compares against the stale value",
    }),
  );

  const endVersion = readVersion();
  results.versionAtEnd = endVersion;
  results.versionDrift = !endVersion.startsWith(EXPECT_VERSION);
  cap.add("fence", JSON.stringify({ endVersion }, null, 2));
  cap.save();
  console.log(sanitize(JSON.stringify(results, null, 2)));
  if (results.versionDrift) process.exitCode = 2;
}

main().catch((error) => {
  console.error(sanitize(String(error?.stack ?? error)));
  process.exit(1);
});
