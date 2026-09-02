// Z1 (2026-09 sync, SL-12 / decision D1) — SPONTANEOUS RESUMPTION, shape (a):
// a BACKGROUND SHELL completing wakes the CLI into a self-submitted turn.
//
// QUESTION. SL-2b caught this in the field once (register item: "a background
// shell completing woke the CLI and it submitted a follow-up `UserPromptSubmit`
// ~100s after its own Stop, with no user or Sonata write"). Woody's D1 ruling is
// to MODEL revival rather than suppress it, so the modeling slice needs the
// signal shapes measured, not the anecdote:
//
//   1. Is it reproducible on demand?
//   2. What does the CLOSING `Stop` carry — specifically, does it already
//      announce the in-flight background work (`background_tasks`) so a consumer
//      can tell "done" from "paused, will wake"?
//   3. What does the WAKE fire — which hooks, in what order, and does the
//      self-submitted `UserPromptSubmit` carry a payload marker distinguishing it
//      from a human composer submit (`source`)?
//   4. What does Sonata's CURRENT state machine do with it — driven through the
//      real `TerminalHost` with production's own dispatch edges: does a completed
//      run reopen, mis-notify, or double-close?
//
// METHOD. The q11/h1 shape: a real `TerminalHost` from `dist/` with Sonata's own
// spawn args, the production `HookWatcher`, and the production settings writer —
// NO census injection. That is deliberate: the question is what PRODUCTION sees
// today, and production already injects `UserPromptSubmit`, `Stop` and
// `Notification` (h1 measured the set), so a census arm could only add events no
// shipped consumer is reading anyway. The one variable is the turn's shape.
//
//   z1a — the turn backgrounds a shell that outlives it, then ends.
//   z1b — CONTROL: the same turn shape with a FOREGROUND shell, so the turn ends
//         with nothing in flight. Without this arm, a `background_tasks` field
//         seen once proves nothing about what it says when the answer is "done".
//
// Both arms watch well past the shell's own duration, and both record the run
// lifecycle Sonata derives, not just the hook wire.
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
const { TerminalHost, HookWatcher, claudeHooksDirectory } = require(APP_DIR + "dist/runtime");

const EXPECT_VERSION = "2.1.258";
const ROOT = "/private/tmp/sonata-sync-2026-09/background-wake";
const COLS = 120;
const ROWS = 40;

// The background shell sleeps this long. Long enough that the turn is provably
// OVER (Stop has fired, Sonata has closed the run) before the wake can arrive —
// a shorter sleep would let the shell finish inside the turn and measure nothing.
const BG_SLEEP_SEC = 70;
// How long to watch after the turn's Stop. The field sighting was ~100s from
// Stop; this covers it with margin.
const WATCH_AFTER_STOP_MS = 240_000;

const HOME = os.homedir();
const USER_MUNGED = `-${HOME.replace(/\//g, "-").replace(/^-/, "")}-`;
const sanitize = (value) =>
  String(value).split(HOME).join("$HOME").split(USER_MUNGED).join("-$USER_MUNGED-");

function pinVersion(where) {
  const version = execFileSync("claude", ["--version"], { encoding: "utf8" }).trim();
  // SL-4 method note: an END drift must not DISCARD a completed capture. Record
  // the drift, let the caller save, exit non-zero afterwards.
  return { version, drifted: !version.startsWith(EXPECT_VERSION), where };
}
const startPin = pinVersion("probe start");
if (startPin.drifted) {
  console.log(JSON.stringify({ success: false, reason: `binary moved off ${EXPECT_VERSION} at start`, version: startPin.version }));
  process.exit(2);
}
const version = startPin.version;

// ─── user-settings guard (SL-9 F41 / F4h incident) ──────────────────────────
// This probe drives no `/model` and no `/effort`, so it has no KNOWN way to
// mutate `~/.claude/settings.json`. The guard is here anyway, unconditionally,
// because F4h's lesson was not "guard the probes that switch models" — it was
// that a probe discovered its own mutation AFTER the fact, from a capture that
// had recorded the evidence and misread it. A snapshot-and-restore bracket costs
// one file read; being wrong about which probes can write costs the user's
// config. Overridable only so the guard can be self-tested (`--self-test`).
const CLAUDE_SETTINGS =
  process.env.SONATA_PROBE_SETTINGS_PATH || path.join(os.homedir(), ".claude", "settings.json");

function snapshotUserSettings() {
  try {
    return { path: CLAUDE_SETTINGS, bytes: fs.readFileSync(CLAUDE_SETTINGS, "utf8") };
  } catch {
    return null; // no settings file → nothing to protect
  }
}

function diffJsonKeys(beforeText, afterText) {
  try {
    const before = JSON.parse(beforeText);
    const after = JSON.parse(afterText ?? "{}");
    const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
    return [...keys]
      .filter((key) => JSON.stringify(before[key]) !== JSON.stringify(after[key]))
      .map((key) => `${key}: ${JSON.stringify(before[key])} → ${JSON.stringify(after[key])}`);
  } catch {
    return ["<unparseable; bytes differ>"];
  }
}

function restoreUserSettings(snapshot) {
  if (!snapshot) return { checked: false };
  let after = null;
  try { after = fs.readFileSync(snapshot.path, "utf8"); } catch { /* deleted under us */ }
  if (after === snapshot.bytes) return { checked: true, mutatedByProbe: false, restored: true };
  try {
    fs.writeFileSync(snapshot.path, snapshot.bytes, "utf8");
  } catch (error) {
    return { checked: true, mutatedByProbe: true, restored: false, error: String(error?.message ?? error) };
  }
  const verified = (() => {
    try { return fs.readFileSync(snapshot.path, "utf8") === snapshot.bytes; } catch { return false; }
  })();
  // The DIFF, not the whole file: settings can carry tokens, and a capture is
  // committed. Key-level only.
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
  process.on(signal, () => { restoreOnce(); process.exit(130); });
}

// ─── payload rendering ──────────────────────────────────────────────────────
// Ids and transcripts are elided; everything else is kept, because the whole
// point of this probe is which FIELDS a revival-relevant payload carries.
const REDACT_VALUE_KEYS = new Set(["transcript_path", "cwd", "session_id", "prompt_id", "turn_id", "tool_use_id", "agent_id", "uuid"]);
// These two are the answer to question 2 and must survive verbatim, whole —
// `renderPayload`'s object clamp would truncate exactly the evidence.
const KEEP_WHOLE_KEYS = new Set(["background_tasks", "session_crons"]);

function renderPayload(payload) {
  const out = {};
  for (const [key, raw] of Object.entries(payload)) {
    if (KEEP_WHOLE_KEYS.has(key)) { out[key] = JSON.parse(sanitize(JSON.stringify(raw ?? null))); continue; }
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

class Session {
  constructor(name) {
    this.name = name;
    this.t0 = Date.now();
    this.hooks = [];
    this.events = [];
    this.raw = "";
    this.notes = [];
    this.ptyExited = false;

    const runRoot = path.join(ROOT, name);
    fs.rmSync(runRoot, { recursive: true, force: true });
    this.workspace = path.join(runRoot, "ws");
    this.runtimeDir = path.join(runRoot, "runtime");
    fs.mkdirSync(this.workspace, { recursive: true });
    fs.mkdirSync(this.runtimeDir, { recursive: true });

    this.term = new Terminal({ cols: COLS, rows: ROWS, allowProposedApi: true, scrollback: 4000 });

    this.host = new TerminalHost({
      taskId: `task-z1-${name}`,
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
    // `run:*` events are KEPT (q11/h1 dropped `run:updated`) — this probe's
    // question 4 is precisely what Sonata's run lifecycle does across the wake,
    // and that lifecycle is only visible here.
    this.events.push({ atMs: this.at(), type: event.type, payload: compactPayload(event.payload) });
  }

  onHookPayload(payload) {
    const event = typeof payload.hook_event_name === "string" ? payload.hook_event_name : "<none>";
    this.hooks.push({ atMs: this.at(), event, keys: Object.keys(payload).sort(), payload: renderPayload(payload) });
    // PRODUCTION's dispatch edges, verbatim — this arm must drive the CLI the way
    // the shipped controller drives it, or question 4 measures a probe, not Sonata.
    if (event === "SessionStart") this.host.noteHookSessionStart();
    if (event === "UserPromptSubmit") {
      this.host.beginRunFromHook(typeof payload.prompt === "string" ? payload.prompt : "", {
        promptId: typeof payload.prompt_id === "string" ? payload.prompt_id : null,
      });
    }
    if (event === "Stop") this.host.completeRunFromTurnEnd();
    if (event === "StopFailure") this.host.completeRunFromTurnEnd({ errorExcerpt: String(payload.error ?? "API error") });
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
      } catch { return null; }
    })();

    // Trust dialog. TWO triggers, and which one answers is load-bearing — this
    // cost the probe two runs before it was stated correctly.
    //
    // With the broker OFF the native approval scrape is LIVE, so the dialog
    // raises `approval:detected` and latches `approvalActive`. That latch is the
    // FIRST clause of `acceptsPromptInput()`, so while it is set the host reports
    // not-ready no matter what the grid shows — a session sitting visibly at its
    // composer, with `SessionStart` already fired, reads `ready=false` forever
    // (measured twice here, at 90207ms and 90151ms). Only `sendApprove()` clears
    // it; a grid walk answers the DIALOG but leaves the LATCH.
    //
    // So the event path must WIN, and a naive "check the event, else walk the
    // grid" loop does not give it that: `answerTrustFromGrid` blocks for up to
    // ~5s inside the else-branch, so whether the event is seen first is a pure
    // race on when the first iteration runs relative to `approval:detected`
    // (~315ms). z1a won that race; z1b lost it, from identical code. The fix is
    // to make the preference explicit in the CONTROL FLOW rather than in the
    // iteration order: wait for the event on its own, and fall back to the grid
    // only once it has provably not come. The fallback still matters — a spawn
    // into an already-trusted dir raises no `approval:detected` at all — but it
    // can no longer pre-empt the path that releases the latch.
    let trustAnswered = false;
    const affirmFocused = () => this.screen().split("\n").some((l) => /❯\s*Yes, I trust this folder/i.test(l));
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
      this.events.some((e) => e.type === "approval:detected" && e.payload?.kind === "workspace-trust");

    // Phase 1 — give the EVENT its uncontested window. Exits early on either
    // decisive answer: the event arriving, or the host going ready on its own
    // (an already-trusted dir, where no dialog is raised and none is needed).
    const eventDeadline = Date.now() + 15_000;
    while (Date.now() < eventDeadline && !this.ptyExited) {
      if (this.host.acceptsPromptInput()) break;
      if (trustDetected()) {
        trustAnswered = true;
        this.notes.push(`trust dialog answered via sendApprove at ${this.at()}ms`);
        await this.host.sendApprove().catch((error) => this.notes.push(`trust approve error: ${error?.message ?? error}`));
        break;
      }
      await delay(150);
    }
    // Phase 2 — the fallback, only for a dialog no `approval:detected` described.
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
      hooks: this.hooks,
      notes: this.notes,
      events: this.events,
      ptyExited: this.ptyExited,
      screenTail: sanitize(this.screen().split("\n").slice(-16).join("\n")),
      ...extra,
    };
    try { this.watcher.dispose(); this.host.dispose(); this.term.dispose(); } catch { /* best-effort */ }
    return out;
  }
}

/** Everything the run lifecycle says, so question 4 is answered from Sonata's
 *  own events rather than from the transcript. */
function compactPayload(payload = {}) {
  const keep = {};
  for (const key of ["kind", "decision", "encodedAs", "reason", "exitCode", "signal", "sonataInitiated", "source", "status", "phase", "runId", "confidence", "title"]) {
    if (payload[key] !== undefined) keep[key] = typeof payload[key] === "string" ? sanitize(payload[key]).slice(0, 200) : payload[key];
  }
  return keep;
}

// ─── arms ───────────────────────────────────────────────────────────────────

/** Shared shape so z1a and z1b differ ONLY in whether the shell outlives the
 *  turn. Returns the measured record. */
async function runArm(name, prompt, { watchMs }) {
  const session = new Session(name);
  if (!(await session.boot())) return session.finish({ verdict: "BOOT FAILED" });

  session.host.submitPrompt(prompt);

  const turnOver = await session.waitUntil(() => session.hooks.some((h) => h.event === "Stop"), 180_000);
  const stopHook = session.hooks.find((h) => h.event === "Stop") ?? null;
  const stopAtMs = stopHook?.atMs ?? session.at();
  // Sonata's own verdict at the moment the turn ends — the "card says done" state
  // the dossier has to compare the later transcript growth against.
  const runStateAtStop = session.events.filter((e) => e.type.startsWith("run:")).map((e) => `${e.type}@${e.atMs}`);
  const screenAtStop = sanitize(session.screen().split("\n").slice(-10).join("\n"));
  const rawLenAtStop = session.raw.length;

  // The watch. Nothing is written to the pty from here on: any hook, any byte,
  // any run event in this window is the CLI acting on its own.
  //
  // The predicate is deliberately `UserPromptSubmit` OR `Stop`, not
  // `UserPromptSubmit` alone. The first version of this probe waited on the
  // prompt hook and reported "NO WAKE" for a run that had provably woken: the
  // CLI ran a whole turn about the finished shell and closed it with a second
  // `Stop`, having emitted no `UserPromptSubmit` for it at all. Keying the watch
  // on the announcement Sonata WANTS would have measured the probe's assumption
  // instead of the CLI's behaviour — the turn boundary is the honest predicate,
  // and whether a prompt hook accompanies it is one of the answers.
  const wokeUp = await session.waitUntil(
    () => session.hooksAfter(stopAtMs).some((h) => h.event === "UserPromptSubmit" || h.event === "Stop"),
    watchMs,
  );
  // Let the woken turn play out far enough to see its own Stop.
  if (wokeUp) await session.waitUntil(() => session.hooksAfter(stopAtMs).some((h) => h.event === "Stop"), 180_000);
  else await delay(5000);

  const after = session.hooksAfter(stopAtMs);
  const wakePrompt = after.find((h) => h.event === "UserPromptSubmit") ?? null;
  const wakeStop = after.find((h) => h.event === "Stop") ?? null;

  return session.finish({
    // The pty's own account of the window, with escapes stripped. Load-bearing
    // once the hook wire turned out NOT to describe every wake: when no
    // `UserPromptSubmit` fires, this is the only record of what the CLI painted.
    rawAfterStop: sanitize(
      session.raw
        .slice(rawLenAtStop)
        .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "")
        .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
        .replace(/\r/g, "")
        .replace(/\n{3,}/g, "\n\n"),
    ).slice(0, 3000),
    turnOver,
    stopAtMs,
    stopPayload: stopHook?.payload ?? null,
    backgroundTasksAtStop: stopHook?.payload?.background_tasks ?? "<field absent>",
    sessionCronsAtStop: stopHook?.payload?.session_crons ?? "<field absent>",
    runStateAtStop,
    screenAtStop,
    // Did the CLI paint anything at all after the turn ended, with no input?
    bytesPaintedAfterStop: session.raw.length - rawLenAtStop,
    woke: wokeUp,
    // Announced = the wake turn came with a `UserPromptSubmit`. Silent = it did
    // not, and only the turn's own `Stop` marks it.
    wakeAnnounced: wakePrompt !== null,
    wakeDelayMs: wakePrompt ? wakePrompt.atMs - stopAtMs : null,
    wakeStopDelayMs: wakeStop ? wakeStop.atMs - stopAtMs : null,
    wakePromptSource: wakePrompt ? (wakePrompt.payload.source ?? "<field absent>") : null,
    wakePromptText: wakePrompt ? wakePrompt.payload.prompt : null,
    wakeStopLastAssistantMessage: wakeStop ? (wakeStop.payload.last_assistant_message ?? null) : null,
    wakeStopBackgroundTasks: wakeStop ? (wakeStop.payload.background_tasks ?? "<field absent>") : null,
    hooksAfterStop: after.map((h) => `${h.event}@${h.atMs} (+${h.atMs - stopAtMs}ms)`),
    runEventsAfterStop: session.events.filter((e) => e.atMs > stopAtMs && e.type.startsWith("run:")).map((e) => `${e.type}@+${e.atMs - stopAtMs}ms`),
    verdict: !wokeUp
      ? `NO WAKE within ${Math.round(watchMs / 1000)}s of Stop`
      : wakePrompt
        ? `WOKE, ANNOUNCED — self-submitted UserPromptSubmit +${wakePrompt.atMs - stopAtMs}ms after Stop, source=${wakePrompt.payload.source ?? "<absent>"}`
        : `WOKE, SILENT — a second Stop +${wakeStop.atMs - stopAtMs}ms after the first, with NO UserPromptSubmit for the turn it closed`,
  });
}

/** z1a — the turn backgrounds a shell that OUTLIVES it. The field shape. */
async function armBackgroundWake() {
  return runArm(
    "z1a-background-wake",
    `Use the Bash tool with run_in_background set to true to start exactly this command: sleep ${BG_SLEEP_SEC}; echo BGDONE. `
      + "Do NOT wait for it, do NOT poll it, do NOT read its output, and do not run any other tool. "
      + "As soon as the background shell is started, reply with exactly: STARTED",
    { watchMs: WATCH_AFTER_STOP_MS },
  );
}

/** z1b — CONTROL. Same turn shape, FOREGROUND shell, nothing left in flight.
 *  Establishes what `background_tasks` says when the answer really is "done",
 *  and that the watch window itself does not produce wakes. */
async function armForegroundControl() {
  return runArm(
    "z1b-foreground-control",
    "Use the Bash tool (run_in_background NOT set) to run exactly this command: sleep 3; echo FGDONE. "
      + "Wait for it to finish, do not run any other tool, then reply with exactly: STARTED",
    { watchMs: Math.min(WATCH_AFTER_STOP_MS, 150_000) },
  );
}

const ARMS = {
  "z1a-background-wake": armBackgroundWake,
  "z1b-foreground-control": armForegroundControl,
};

// ─── run ────────────────────────────────────────────────────────────────────
const RESULT_DIR = path.join(ROOT, "results");
fs.mkdirSync(RESULT_DIR, { recursive: true });

if (process.argv.includes("--self-test")) {
  // The settings guard, exercised end to end without spawning a CLI: mutate the
  // protected file the way a `/model` switch would, then assert the restore took.
  if (!userSettings) {
    console.log(JSON.stringify({ selfTest: "SKIP — no settings file at " + CLAUDE_SETTINGS }));
    process.exit(0);
  }
  const mutated = userSettings.bytes.replace(/"model":\s*"[^"]*"/, '"model": "haiku"');
  fs.writeFileSync(CLAUDE_SETTINGS, mutated, "utf8");
  const seenMutated = fs.readFileSync(CLAUDE_SETTINGS, "utf8");
  const verdict = restoreOnce();
  const finalBytes = fs.readFileSync(CLAUDE_SETTINGS, "utf8");
  console.log(JSON.stringify({
    selfTest: true,
    settingsPath: CLAUDE_SETTINGS,
    mutationLanded: seenMutated !== userSettings.bytes,
    guard: verdict,
    bytesBackToOriginal: finalBytes === userSettings.bytes,
    pass: seenMutated !== userSettings.bytes && verdict.restored === true && finalBytes === userSettings.bytes,
  }, null, 2));
  process.exit(0);
}

const only = process.argv.slice(2).filter((arg) => !arg.startsWith("-"));
const selected = process.argv.includes("--capture-only") ? [] : only.length > 0 ? only : Object.keys(ARMS);
// `--repeat=N`. Not decoration: the wake's ANNOUNCEMENT turned out to vary
// between two runs of identical code (one emitted a `UserPromptSubmit`, one
// emitted only a second `Stop`), so a single run of this arm cannot honestly
// describe the shape. Repeats are stored side by side and the capture reports
// the split rather than the last run.
const repeat = Math.max(1, Number((process.argv.find((a) => a.startsWith("--repeat=")) ?? "").split("=")[1] ?? 1) || 1);

try {
  for (const name of selected) {
    const arm = ARMS[name];
    if (!arm) { console.error(`unknown arm: ${name}`); process.exitCode = 2; continue; }
    for (let run = 1; run <= repeat; run++) {
      const label = repeat > 1 ? `${name} (run ${run}/${repeat})` : name;
      process.stderr.write(`\n=== ${label} ===\n`);
      let result;
      try { result = await arm(); } catch (error) { result = { scenario: name, error: String(error?.stack ?? error) }; }
      result.ranAt = new Date().toISOString();
      result.run = run;
      fs.writeFileSync(path.join(RESULT_DIR, `${name}.r${run}.json`), JSON.stringify(result, null, 2));
      process.stderr.write(`${label}: ${result.verdict ?? result.error ?? "?"}\n`);
    }
  }
} finally {
  restoreOnce();
}

const endPin = pinVersion("probe end");

const results = fs.readdirSync(RESULT_DIR)
  .filter((file) => /\.r\d+\.json$/.test(file))
  .sort()
  .map((file) => JSON.parse(fs.readFileSync(path.join(RESULT_DIR, file), "utf8")));

const runsOf = (scenario) => results.filter((r) => r.scenario === scenario);
const wakes = runsOf("z1a-background-wake");
const controls = runsOf("z1b-foreground-control");

/** One row per RUN, not one row per arm — the arm's behaviour is not constant
 *  and averaging it away is the one thing this table must not do. */
const runRow = (r) => [
  `| ${r.scenario} r${r.run ?? "?"}`,
  r.turnOver,
  JSON.stringify(r.backgroundTasksAtStop === "<field absent>" ? "<field absent>" : (r.backgroundTasksAtStop ?? []).map((t) => `${t.type}:${t.status}`)),
  JSON.stringify(r.sessionCronsAtStop),
  r.woke,
  r.wakeAnnounced,
  r.wakeDelayMs ?? "—",
  r.wakeStopDelayMs ?? "—",
  r.wakePromptSource ?? "—",
  r.bytesPaintedAfterStop,
  `${JSON.stringify(r.runEventsAfterStop)} |`,
].join(" | ");

const capture = [
  "# Z1 — spontaneous resumption shape (a): a background shell wakes the CLI (SL-12 / D1)",
  "",
  `binary: ${version}${endPin.drifted ? ` — DRIFTED to ${endPin.version} at probe end; capture SAVED, exit non-zero` : " (re-pinned at probe end)"}`,
  "spawn: production TerminalHost from dist/, --permission-mode default, PRODUCTION hook injection (no census)",
  `background shell: sleep ${BG_SLEEP_SEC}s; watch after Stop: ${Math.round(WATCH_AFTER_STOP_MS / 1000)}s`,
  "",
  "BUILD PROVENANCE: `dist/` was built from a tree carrying the SL-9 sibling's",
  "uncommitted work. This probe's measurement path is `TerminalHost` +",
  "`HookWatcher` + `claude-runtime-settings` + `hook-sink`; of those only",
  "`hook-sink.ts` is modified there, and its diff is COMMENT-ONLY (a doc block, 12",
  "insertions, 0 behavioural lines). The sibling's behavioural edits are to the",
  "approval BROKER (this probe runs `approvalBroker:false`), codex `Interrupt`",
  "handling, `cli-state` and `runtime-controller` — none of which this probe",
  "constructs. Recorded rather than assumed away.",
  "",
  "## every run, side by side",
  "",
  "The wake is REPRODUCIBLE but its ANNOUNCEMENT is not constant — see the",
  "`announced` column, which is the finding this table exists to keep honest.",
  "",
  "| run | turn reached Stop | `Stop.background_tasks` | `Stop.session_crons` | woke | announced (UPS fired) | UPS +ms | wake Stop +ms | `UserPromptSubmit.source` | bytes painted after Stop | Sonata run events after Stop |",
  "|---|---|---|---|---|---|---|---|---|---|---|",
  ...[...wakes, ...controls].map(runRow),
  "",
  "## user-settings guard",
  "",
  "```json",
  JSON.stringify(settingsRestore, null, 2),
  "```",
  "",
  "## per-run detail",
  "",
  ...results.map((result) => [`### ${result.scenario} — run ${result.run ?? "?"}`, "", "```json", sanitize(JSON.stringify(result, null, 2)), "```", ""].join("\n")),
].join("\n");

fs.writeFileSync(path.join(OUT_DIR, "z1-background-wake.capture.txt"), capture);
console.log(JSON.stringify({
  success: results.every((r) => !r.error) && !endPin.drifted,
  version,
  endVersion: endPin.version,
  arms: results.map((r) => ({ scenario: r.scenario, run: r.run, verdict: r.verdict ?? r.error ?? "?" })),
  userSettingsGuard: settingsRestore,
}, null, 2));
if (endPin.drifted) process.exit(3);

function delay(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }
