// Z4 (2026-09 sync, SL-16) — the SHIPPED revival model, verified LIVE.
//
// WHAT Z1 LEFT UNPROVEN. z1 measured the SIGNAL (a closing `Stop` carries
// `background_tasks:[{shell,running}]`, 4/4) against the PRE-SL-16 build, and
// SL-16's smokes pin the MODEL against payloads written by hand. Neither closes
// the loop: the smokes cannot prove that a real payload's nested array survives
// the production hook sink and watcher intact and reaches the new reader in the
// shape it consumes, and z1 could not observe a model that did not yet exist.
// This arm drives the whole chain end to end — real CLI → production hook sink →
// production `HookWatcher` → `readBackgroundWork` → `TerminalHost` →
// `CliStateModel` → `NotificationPolicy` — and asserts on what Sonata now says.
//
// THE FIVE CLAIMS, each PASS/FAIL on its own:
//   C1  the LIVE closing `Stop` reads `pending` (the field survives the channel)
//   C2  the run closes `completed` / `hook-stop` / `high` AND carries pendingWake
//   C3  NO `complete` notification fires at the pause  (the double-fire, removed)
//   C4  the wake's run names the paused run in `revivalOf`
//   C5  exactly ONE `complete` fires across the whole arc, at the REAL ending
//
// The wake arm carries its own control in both directions: the CLOSING Stop must
// read `pending` and the POST-WAKE Stop must read `none`, in the same run, from
// the same field. A separate foreground arm would add a third reading of a
// question this arm already answers twice.
//
// METHOD is z1's, deliberately unchanged except for the dispatch edges, which are
// updated to what `RuntimeController.applyHookToTask` ships TODAY — a probe that
// drove the old edges would measure a probe, not Sonata.
//
// Scratch dirs are /private/tmp/... (never the agent scratchpad, whose path
// embeds the username): these frames become findings and the pre-push leak fence
// scans blob content.
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
  CliStateModel,
  readBackgroundWork,
  BackgroundWorkTracker,
} = require(APP_DIR + "dist/runtime");
const { NotificationPolicy } = require(APP_DIR + "dist/main/notification-policy");

const EXPECT_VERSION = "2.1.258";
const ROOT = "/private/tmp/sonata-sync-2026-09/revival-modeling";
const COLS = 120;
const ROWS = 40;
const BG_SLEEP_SEC = 70;
const WATCH_AFTER_STOP_MS = 240_000;

const HOME = os.homedir();
const USER_MUNGED = `-${HOME.replace(/\//g, "-").replace(/^-/, "")}-`;
const sanitize = (value) =>
  String(value).split(HOME).join("$HOME").split(USER_MUNGED).join("-$USER_MUNGED-");

function pinVersion(where) {
  const version = execFileSync("claude", ["--version"], { encoding: "utf8" }).trim();
  return { version, drifted: !version.startsWith(EXPECT_VERSION), where };
}
const startPin = pinVersion("probe start");
if (startPin.drifted) {
  console.log(
    JSON.stringify({ success: false, reason: `binary moved off ${EXPECT_VERSION} at start`, version: startPin.version }),
  );
  process.exit(2);
}
const version = startPin.version;

// ─── user-settings guard (SL-9 F41 / F4h incident) — MANDATORY, unconditional ──
const CLAUDE_SETTINGS =
  process.env.SONATA_PROBE_SETTINGS_PATH || path.join(os.homedir(), ".claude", "settings.json");

function snapshotUserSettings() {
  try {
    return { path: CLAUDE_SETTINGS, bytes: fs.readFileSync(CLAUDE_SETTINGS, "utf8") };
  } catch {
    return null;
  }
}
function diffJsonKeys(beforeText, afterText) {
  try {
    const before = JSON.parse(beforeText);
    const after = JSON.parse(afterText ?? "{}");
    return [...new Set([...Object.keys(before), ...Object.keys(after)])]
      .filter((key) => JSON.stringify(before[key]) !== JSON.stringify(after[key]))
      .map((key) => `${key}: ${JSON.stringify(before[key])} → ${JSON.stringify(after[key])}`);
  } catch {
    return ["<unparseable; bytes differ>"];
  }
}
function restoreUserSettings(snapshot) {
  if (!snapshot) return { checked: false };
  let after = null;
  try {
    after = fs.readFileSync(snapshot.path, "utf8");
  } catch {
    /* deleted under us */
  }
  if (after === snapshot.bytes) return { checked: true, mutatedByProbe: false, restored: true };
  try {
    fs.writeFileSync(snapshot.path, snapshot.bytes, "utf8");
  } catch (error) {
    return { checked: true, mutatedByProbe: true, restored: false, error: String(error?.message ?? error) };
  }
  const verified = (() => {
    try {
      return fs.readFileSync(snapshot.path, "utf8") === snapshot.bytes;
    } catch {
      return false;
    }
  })();
  return { checked: true, mutatedByProbe: true, restored: verified, changedKeys: diffJsonKeys(snapshot.bytes, after) };
}
const userSettings = snapshotUserSettings();
let settingsRestore = { checked: false };
const restoreOnce = () => {
  if (settingsRestore.checked) return settingsRestore;
  settingsRestore = restoreUserSettings(userSettings);
  if (settingsRestore.mutatedByProbe) {
    process.stderr.write(
      `\n[settings guard] the probe changed ~/.claude/settings.json (${(settingsRestore.changedKeys ?? []).join("; ")}) — restored: ${settingsRestore.restored}\n`,
    );
  }
  return settingsRestore;
};
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    restoreOnce();
    process.exit(130);
  });
}

// Self-test of the guard itself (F41's lesson: a bracket nobody has seen fire is
// a bracket nobody knows works).
if (process.argv.includes("--self-test")) {
  const probePath = process.env.SONATA_PROBE_SETTINGS_PATH;
  if (!probePath) {
    console.log(JSON.stringify({ selfTest: "SKIP — set SONATA_PROBE_SETTINGS_PATH to a scratch file" }));
    process.exit(0);
  }
  const before = fs.readFileSync(probePath, "utf8");
  fs.writeFileSync(probePath, JSON.stringify({ ...JSON.parse(before), model: "mutated-by-self-test" }, null, 2));
  const result = restoreUserSettings({ path: probePath, bytes: before });
  console.log(
    JSON.stringify({
      selfTest: "ran",
      detected: result.mutatedByProbe === true,
      restored: result.restored === true,
      bytesMatch: fs.readFileSync(probePath, "utf8") === before,
      changedKeys: result.changedKeys,
    }),
  );
  process.exit(0);
}

const REDACT_VALUE_KEYS = new Set([
  "transcript_path", "cwd", "session_id", "prompt_id", "turn_id", "tool_use_id", "agent_id", "uuid",
]);
const KEEP_WHOLE_KEYS = new Set(["background_tasks", "session_crons"]);
function renderPayload(payload) {
  const out = {};
  for (const [key, raw] of Object.entries(payload)) {
    if (KEEP_WHOLE_KEYS.has(key)) {
      out[key] = JSON.parse(sanitize(JSON.stringify(raw ?? null)));
      continue;
    }
    if (REDACT_VALUE_KEYS.has(key)) {
      out[key] = typeof raw === "string" ? `<${key}:${raw.length}ch>` : raw;
      continue;
    }
    if (typeof raw === "string") {
      out[key] = sanitize(raw.length > 400 ? `${raw.slice(0, 400)}…[${raw.length}ch]` : raw);
      continue;
    }
    if (raw && typeof raw === "object") {
      const json = sanitize(JSON.stringify(raw));
      out[key] = json.length > 600 ? `${json.slice(0, 600)}…[${json.length}ch]` : json;
      continue;
    }
    out[key] = raw;
  }
  return out;
}

/** The run-lifecycle fields this slice is about, kept whole. */
function compactRunPayload(payload = {}) {
  const keep = {};
  for (const key of [
    "id", "runId", "kind", "title", "status", "statusReason",
    "completionSource", "completionConfidence", "revivalOf",
  ]) {
    if (payload[key] !== undefined) {
      keep[key] = typeof payload[key] === "string" ? sanitize(payload[key]).slice(0, 200) : payload[key];
    }
  }
  if (payload.pendingWake !== undefined) keep.pendingWake = payload.pendingWake;
  return keep;
}

class Session {
  constructor(name, opts = {}) {
    this.name = name;
    this.t0 = Date.now();
    this.hooks = [];
    this.events = [];
    this.raw = "";
    this.notes = [];
    this.ptyExited = false;
    // What SL-16 shipped, observed rather than simulated.
    this.claims = [];
    this.cliStates = [];
    this.notifications = [];

    const runRoot = path.join(ROOT, name);
    fs.rmSync(runRoot, { recursive: true, force: true });
    this.workspace = path.join(runRoot, "ws");
    this.runtimeDir = path.join(runRoot, "runtime");
    fs.mkdirSync(this.workspace, { recursive: true });
    fs.mkdirSync(this.runtimeDir, { recursive: true });

    this.term = new Terminal({ cols: COLS, rows: ROWS, allowProposedApi: true, scrollback: 4000 });
    this.host = new TerminalHost({
      taskId: `task-z4-${name}`,
      provider: "claude",
      defaultWorkspace: this.workspace,
      eventSink: (event) => this.onHostEvent(event),
    });
    // The production notification chain: cli-state feeds `cli-state:changed`,
    // which the policy observes. Same objects, same order as `RuntimeController`.
    this.policy = new NotificationPolicy(opts.policyOptions ?? {});
    // The session's background-work memory, exactly as ActiveTaskRuntime holds one.
    this.backgroundWork = new BackgroundWorkTracker();
    this.cliState = new CliStateModel((snapshot) => {
      this.cliStates.push({
        atMs: this.at(),
        activity: snapshot.activity,
        source: snapshot.source,
        turnEndWake: snapshot.turnEndWake,
      });
      const decision = this.policy.observe({
        type: "cli-state:changed",
        payload: {
          taskId: `task-z4-${this.name}`,
          activity: snapshot.activity,
          tool: snapshot.tool,
          approvalKind: snapshot.approvalKind,
          turnEndWake: snapshot.turnEndWake,
          source: snapshot.source,
          changedAt: snapshot.changedAt,
        },
        ts: new Date().toISOString(),
      });
      if (decision) this.notifications.push({ atMs: this.at(), ...decision });
    });
    this.watcher = new HookWatcher({
      sinkDir: claudeHooksDirectory,
      pollMs: 100,
      onPayload: (payload) => this.onHookPayload(payload),
      onError: (error, filePath) => this.notes.push(`hook-watcher error ${filePath}: ${error.message}`),
    });
  }

  at() { return Date.now() - this.t0; }

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
    if (event.type === "report:updated" || event.type === "file:changed") return;
    if (event.type === "pty:exit") this.ptyExited = true;
    if (event.type.startsWith("run:")) {
      this.events.push({ atMs: this.at(), type: event.type, payload: compactRunPayload(event.payload) });
      return;
    }
    this.events.push({ atMs: this.at(), type: event.type, payload: {} });
  }

  onHookPayload(payload) {
    const event = typeof payload.hook_event_name === "string" ? payload.hook_event_name : "<none>";
    this.hooks.push({ atMs: this.at(), event, keys: Object.keys(payload).sort(), payload: renderPayload(payload) });

    // PRODUCTION's dispatch edges as SHIPPED at SL-16, verbatim, in order —
    // including the ONE advance of the session's background-work memory, gated
    // on main-turn endings and handed to BOTH consumers.
    const turnEndWake =
      event === "Stop" || event === "StopFailure" || event === "Interrupt"
        ? (this.backgroundWork.noteTurnEnd(readBackgroundWork(payload)) ?? undefined)
        : undefined;
    if (event === "Stop" || event === "StopFailure") {
      this.claims.push({
        atMs: this.at(),
        event,
        raw: readBackgroundWork(payload).kind,
        turnEndWake: turnEndWake ?? null,
      });
    }
    this.cliState.applyHook(payload, turnEndWake ? { turnEndWake } : {});
    if (event === "SessionStart") this.host.noteHookSessionStart();
    if (event === "UserPromptSubmit") {
      this.host.beginRunFromHook(typeof payload.prompt === "string" ? payload.prompt : "", {
        promptId: typeof payload.prompt_id === "string" ? payload.prompt_id : null,
      });
    }
    if (event === "Stop") {
      this.host.completeRunFromTurnEnd(turnEndWake ? { turnEndWake } : {});
    }
    if (event === "StopFailure") {
      this.host.completeRunFromTurnEnd({
        errorExcerpt: String(payload.error ?? "API error"),
        ...(turnEndWake ? { turnEndWake } : {}),
      });
    }
  }

  async boot() {
    this.host.startTask({
      cwd: this.workspace,
      runtimeDir: this.runtimeDir,
      permissionMode: "default",
      rows: ROWS,
      cols: COLS,
      approvalBroker: false,
    });
    this.watcher.watchWorkspace(this.runtimeDir);
    this.settingsSnapshot = (() => {
      try {
        return JSON.parse(fs.readFileSync(path.join(this.runtimeDir, "claude-runtime-settings.json"), "utf8"));
      } catch {
        return null;
      }
    })();

    // z1's trust choreography, unchanged (its comment explains why the EVENT
    // path must win the race — the approval latch, not the dialog, gates ready).
    let trustAnswered = false;
    const affirmFocused = () =>
      this.screen().split("\n").some((l) => /❯\s*Yes, I trust this folder/i.test(l));
    const answerTrustFromGrid = async () => {
      if (!/Yes, I trust this folder/i.test(this.screen())) return false;
      for (let i = 0; i < 6; i++) {
        await delay(500);
        if (affirmFocused()) break;
        this.host.writeRaw("\x1b[B");
        await delay(350);
      }
      if (!affirmFocused()) {
        this.notes.push("trust dialog: affirm row never focused — NOT answered");
        return false;
      }
      this.host.writeRaw("\r");
      this.notes.push(`trust dialog answered from the grid at ${this.at()}ms`);
      return true;
    };
    const trustDetected = () =>
      this.events.some((e) => e.type === "approval:detected");

    const eventDeadline = Date.now() + 15_000;
    while (Date.now() < eventDeadline && !this.ptyExited) {
      if (this.host.acceptsPromptInput()) break;
      if (trustDetected()) {
        trustAnswered = true;
        this.notes.push(`trust dialog answered via sendApprove at ${this.at()}ms`);
        await this.host.sendApprove().catch((error) =>
          this.notes.push(`trust approve error: ${error?.message ?? error}`),
        );
        break;
      }
      await delay(150);
    }
    if (!trustAnswered && !this.host.acceptsPromptInput() && !this.ptyExited) {
      if (await answerTrustFromGrid()) trustAnswered = true;
    }

    const deadline = Date.now() + 90_000;
    let ok = false;
    while (Date.now() < deadline && !this.ptyExited) {
      if (this.host.acceptsPromptInput()) { ok = true; break; }
      await delay(200);
    }
    this.notes.push(`ready=${ok} at ${this.at()}ms`);
    await delay(2500);
    return ok;
  }

  async waitUntil(predicate, timeoutMs, stepMs = 200) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      if (predicate()) return true;
      if (Date.now() > deadline || this.ptyExited) return false;
      await delay(stepMs);
    }
  }

  hooksAfter(atMs) { return this.hooks.filter((h) => h.atMs > atMs); }

  finish(extra = {}) {
    const out = {
      scenario: this.name,
      version,
      injectedEvents: this.settingsSnapshot ? Object.keys(this.settingsSnapshot.hooks).sort() : null,
      hookOrder: this.hooks.map((h) => `${h.event}@${h.atMs}`),
      backgroundWorkClaims: this.claims,
      cliStates: this.cliStates,
      notifications: this.notifications,
      runEvents: this.events.filter((e) => e.type.startsWith("run:")),
      notes: this.notes,
      ptyExited: this.ptyExited,
      screenTail: sanitize(this.screen().split("\n").slice(-16).join("\n")),
      ...extra,
    };
    try { this.watcher.dispose(); this.host.dispose(); this.term.dispose(); } catch { /* best-effort */ }
    return out;
  }
}

async function armRevivalLive() {
  const session = new Session("z4-revival-live");
  if (!(await session.boot())) return session.finish({ verdict: "BOOT FAILED" });

  session.host.submitPrompt(
    `Use the Bash tool with run_in_background set to true to start exactly this command: sleep ${BG_SLEEP_SEC}; echo BGDONE. ` +
      "Do NOT wait for it, do NOT poll it, do NOT read its output, and do not run any other tool. " +
      "As soon as the background shell is started, reply with exactly: STARTED",
  );

  const turnOver = await session.waitUntil(() => session.hooks.some((h) => h.event === "Stop"), 180_000);
  const stopHook = session.hooks.find((h) => h.event === "Stop") ?? null;
  const stopAtMs = stopHook?.atMs ?? session.at();
  // Snapshot the model's verdict AT THE PAUSE, before anything can wake it.
  const pausedRun =
    session.events
      .filter((e) => e.type === "run:updated" && e.payload.status === "completed")
      .at(-1) ?? null;
  const notificationsAtPause = session.notifications.length;

  // Nothing is written to the pty from here on: everything below is the CLI
  // acting on its own. The predicate is the TURN BOUNDARY, not the prompt hook —
  // z1's F43 lesson (1 of 9 wakes fired no `UserPromptSubmit` at all).
  const woke = await session.waitUntil(
    () => session.hooksAfter(stopAtMs).some((h) => h.event === "UserPromptSubmit" || h.event === "Stop"),
    WATCH_AFTER_STOP_MS,
  );
  if (woke) await session.waitUntil(() => session.hooksAfter(stopAtMs).some((h) => h.event === "Stop"), 180_000);
  else await delay(5000);
  await delay(3000); // let the closing run:updated land

  const after = session.hooksAfter(stopAtMs);
  const wakeStop = after.find((h) => h.event === "Stop") ?? null;
  const revivalRun = session.events.find((e) => e.type === "run:started" && e.atMs > stopAtMs) ?? null;
  const claims = session.claims;

  const c1 = claims[0]?.raw === "pending" && Boolean(claims[0]?.turnEndWake?.opened);
  const c2 =
    pausedRun?.payload.status === "completed" &&
    pausedRun?.payload.completionSource === "hook-stop" &&
    pausedRun?.payload.completionConfidence === "high" &&
    Boolean(pausedRun?.payload.pendingWake);
  const c3 = notificationsAtPause === 0;
  const c4 = Boolean(revivalRun) && revivalRun.payload.revivalOf === pausedRun?.payload.id;
  const completes = session.notifications.filter((n) => n.kind === "complete");
  const c5 = completes.length === 1 && completes[0].atMs > stopAtMs;

  return session.finish({
    turnOver,
    woke,
    stopAtMs,
    closingStopBackgroundTasks: stopHook?.payload?.background_tasks ?? "<field absent>",
    closingStopSessionCrons: stopHook?.payload?.session_crons ?? "<field absent>",
    wakeStopBackgroundTasks: wakeStop ? (wakeStop.payload.background_tasks ?? "<field absent>") : null,
    wakeStopDelayMs: wakeStop ? wakeStop.atMs - stopAtMs : null,
    pausedRun: pausedRun?.payload ?? null,
    revivalRun: revivalRun?.payload ?? null,
    notificationsAtPause,
    checks: {
      "C1 live closing Stop reads `pending`": c1,
      "C2 run closes completed/hook-stop/high WITH pendingWake": c2,
      "C3 no complete notification at the pause": c3,
      "C4 the wake's run names the paused run": c4,
      "C5 exactly ONE complete, after the pause": c5,
    },
    verdict:
      c1 && c2 && c3 && c4 && c5
        ? "PASS — all five claims hold live"
        : "FAIL — see checks",
  });
}


/**
 * Z4B — the B1 regression, live. A LONG-LIVED background task (the dev-server
 * shape) stays in `background_tasks` for the rest of the session, so the naive
 * "non-empty means paused" reading would swallow every completion ping from
 * here on. Two turns, one long-lived task: turn 1 legitimately opens a pause,
 * turn 2 must open NOTHING and must ping.
 *
 * No wake is awaited and none is wanted — that is the whole point, and it is
 * why this arm costs ~40s rather than ~90s. The completion floor is lowered to
 * 1s for this arm and SAID SO here: the production floor is a "were you still
 * watching" heuristic, and holding turn 2 under a 30s floor would measure the
 * floor rather than the pause logic this arm exists to test.
 */
async function armDevServerLive() {
  const session = new Session("z4b-dev-server", { policyOptions: { completeFloorMs: 1000 } });
  if (!(await session.boot())) return session.finish({ verdict: "BOOT FAILED" });

  session.host.submitPrompt(
    "Use the Bash tool with run_in_background set to true to start exactly this command: sleep 600. " +
      "Do NOT wait for it, do NOT poll it, and do not run any other tool. " +
      "As soon as it is started, reply with exactly: STARTED",
  );
  const turn1Over = await session.waitUntil(() => session.claims.length >= 1, 180_000);
  const turn1 = session.claims[0] ?? null;
  await delay(2500);

  // A SECOND, ordinary turn while the long-lived task keeps running.
  session.host.submitPrompt("Reply with exactly: SECOND");
  const turn2Over = await session.waitUntil(() => session.claims.length >= 2, 180_000);
  await delay(3000);
  const turn2 = session.claims[1] ?? null;

  const b1 = turn1?.raw === "pending" && Boolean(turn1?.turnEndWake?.opened);
  // The array is STILL non-empty on turn 2 — that is what makes the check
  // meaningful. If the CLI had dropped the task, this would prove nothing.
  const b2 = turn2?.raw === "pending";
  const b3 = turn2?.turnEndWake?.opened === null;
  const completes = session.notifications.filter((n) => n.kind === "complete");
  const b4 = completes.length === 1;
  const pausedRuns = session.events.filter(
    (event) => event.type === "run:updated" && event.payload.pendingWake,
  );
  const b5 = pausedRuns.length === 1;

  return session.finish({
    turn1Over,
    turn2Over,
    turn1Claim: turn1,
    turn2Claim: turn2,
    completes,
    stampedRuns: pausedRuns.map((event) => event.payload.id),
    checks: {
      "B1 turn 1 opens a pause (the task is new)": b1,
      "B1 turn 2's payload STILL names the task (the array is session state)": b2,
      "B1 turn 2 opens NOTHING (no growth = no pause)": b3,
      "B1 exactly one complete fired — turn 2's, not swallowed": b4,
      "B1 exactly one card stamped — turn 1's": b5,
    },
    verdict:
      b1 && b2 && b3 && b4 && b5 ? "PASS — the dev-server regression is fixed live" : "FAIL — see checks",
  });
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const result = await armRevivalLive();
const devServer = await armDevServerLive();
const endPin = pinVersion("probe end");
const restore = restoreOnce();

fs.writeFileSync(
  path.join(OUT_DIR, "z4-revival-modeling-live.capture.txt"),
  [
    "# z4 — SL-16 revival modeling, verified LIVE through the production chain",
    "",
    `Binary pinned \`${startPin.version}\` at start and \`${endPin.version}\` at end (drifted: ${endPin.drifted}).`,
    `Settings guard: ${JSON.stringify(restore)}`,
    "",
    "## Verdict",
    "",
    "```json",
    sanitize(
      JSON.stringify(
        {
          z4a: { verdict: result.verdict, checks: result.checks },
          z4b: { verdict: devServer.verdict, checks: devServer.checks },
        },
        null,
        2,
      ),
    ),
    "```",
    "",
    "## z4a — the revival arc, full record",
    "",
    "```json",
    sanitize(JSON.stringify(result, null, 2)),
    "```",
    "",
    "## z4b — the dev-server (B1) arm, full record",
    "",
    "```json",
    sanitize(JSON.stringify(devServer, null, 2)),
    "```",
    "",
  ].join("\n"),
  "utf8",
);

console.log(
  JSON.stringify(
    {
      z4a: { verdict: result.verdict, checks: result.checks },
      z4b: { verdict: devServer.verdict, checks: devServer.checks },
      endDrift: endPin.drifted,
    },
    null,
    2,
  ),
);
process.exit(
  result.verdict.startsWith("PASS") && devServer.verdict.startsWith("PASS") && !endPin.drifted ? 0 : 1,
);
