// RC8 (2026-09 sync, SL-19) — the SHIPPED startup lever, verified LIVE through
// the production spawn.
//
// WHAT rc7 LEFT UNPROVEN. rc7 measured the LEVER (`remoteControlAtStartup:false`
// in a settings file suppresses auto-start, 2/2 against two auto-starting legs)
// on a hand-spawned pty with a hand-merged settings file. SL-19 wires it into
// `ensureClaudeRuntimeSettings`, and three things only a production run can say:
//   - that the key production actually writes lands in the file the production
//     `buildArgs` actually passes, on the OFF-intent path and nowhere else;
//   - that the ON-intent spawn still connects with the key ABSENT (rc4 leg 3
//     measured flag-over-false-key; SL-19 ships flag-over-NOTHING, a shape
//     nobody has run);
//   - THE RED LINE: that a startup key does not disable a CAPABILITY. A
//     mid-session `/remote-control` under an OFF-intent spawn must still connect,
//     driven by the production `injectRemoteControl()` and read by the production
//     `remote-control:state` / `findRemoteControlUrlOnScreen` oracle — not by a
//     look-alike.
//
// THE FLAPPING BACKGROUND, and how this probe survives it. Auto-start resolves
// (F4e) to a server-side GrowthBook default that refreshed twice DURING SL-11
// with no local action, so "the OFF arm did not auto-start" is worthless on its
// own — the account may simply not have been auto-starting. Two brackets:
//   1. `tengu_cobalt_harbor` is read out of `~/.claude.json` at every arm and
//      recorded, rc7-style.
//   2. The suppression arm is SANDWICHED between two PRE-FIX control arms — the
//      identical production spawn with the new key stripped from the settings
//      file. If both controls auto-start and the arm between them does not, the
//      key is the cause; if a control does NOT auto-start, THIS RUN PROVES
//      NOTHING and says so in its own verdict rather than claiming a pass.
//
// The control's argv is asserted equal to the production OFF-intent argv modulo
// the `--settings` path, so "pre-fix shape" is a measured claim, not a comment.
//
// ARMS (in time order — the sandwich is the point):
//   c-control-pre   pre-fix shape (key stripped)      → expect AUTO-START
//   a-off-intent    production, no `remoteControl`    → expect NO auto-start,
//                                                       THEN inject → CONNECT
//   b-on-intent     production, `remoteControl:true`  → expect CONNECT at boot,
//                                                       key ABSENT from the file
//   d-control-post  pre-fix shape again               → expect AUTO-START
//
// ORACLE. An OFF-intent boot never arms Sonata's own RC state, so the ABSENCE of
// `remote-control:state` there is true by construction and is recorded, never
// counted. Auto-start is read from two independent places instead: the raw
// stream's `connecting…` (rc7's tell) and the `/rc` pill row on a second grid fed
// the same bytes. The link is read with the PRODUCTION
// `findRemoteControlUrlOnScreen` off that grid, which is where SL-11 moved it.
//
// Scratch dirs are /private/tmp/... (never the agent scratchpad, whose path
// embeds the username): this capture becomes findings and the pre-push leak
// fence scans blob content.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";

const OUT_DIR = new URL(".", import.meta.url).pathname;
const APP_DIR = new URL("../../../app/", import.meta.url).pathname;
const require = createRequire(APP_DIR + "package.json");
const {
  TerminalHost,
  claudeArgs,
  ensureClaudeRuntimeSettings,
  findRemoteControlUrlOnScreen,
  normalizeTerminalDimensions,
} = require(APP_DIR + "dist/runtime");
const { TaskScreenModel } = require(APP_DIR + "dist/runtime/terminal-host/task-screen-model");

const EXPECT_VERSION = "2.1.258";
// Deliberately NOT under a directory ending in `rc`: rc7's pill needle matched
// its own cwd banner row (`…/rc-lever/B-prodenv-false`) and reported a footer
// that was a path. The needle here is anchored, and the path cannot forge it.
const ROOT = "/private/tmp/sonata-sync-2026-09/startup-lever";
const COLS = 120;
const ROWS = 36;
/** How long a boot is watched for its own RC outcome. Every positive auto-start
 *  measured so far attempted at +0ms (rc7, 4/4), so this is far past generous. */
const BOOT_WATCH_MS = 30_000;
/** The mid-session injection's budget — the same 45s the production smoke gives
 *  it (`remote-control-disconnect.mjs`). */
const INJECT_WATCH_MS = 45_000;

const HOME = os.homedir();
const USER_MUNGED = `-${HOME.replace(/\//g, "-").replace(/^-/, "")}-`;
const sanitize = (value) =>
  String(value).split(HOME).join("$HOME").split(USER_MUNGED).join("-$USER_MUNGED-");
const redactSession = (value) => String(value).replace(/session_[A-Za-z0-9_-]+/g, "session_<REDACTED>");
const scrub = (value) => redactSession(sanitize(value));

function readVersion() {
  return execFileSync("claude", ["--version"], { encoding: "utf8" }).trim();
}
const startPin = readVersion();
if (!startPin.startsWith(EXPECT_VERSION)) {
  console.log(JSON.stringify({ success: false, reason: `binary moved off ${EXPECT_VERSION} at start`, version: startPin }));
  process.exit(2);
}
const version = startPin;

// ─── user-settings guard (SL-9 F41 / F4h incident) — MANDATORY, unconditional ──
const CLAUDE_SETTINGS =
  process.env.SONATA_PROBE_SETTINGS_PATH || path.join(HOME, ".claude", "settings.json");

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
      `\n[settings guard] the probe changed ${CLAUDE_SETTINGS} (${(settingsRestore.changedKeys ?? []).join("; ")}) — restored: ${settingsRestore.restored}\n`,
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

const USER_CONFIG = path.join(HOME, ".claude.json");
function autoStartInputs() {
  try {
    const raw = JSON.parse(fs.readFileSync(USER_CONFIG, "utf8"));
    return {
      tengu_cobalt_harbor: raw.cachedGrowthBookFeatures?.tengu_cobalt_harbor ?? null,
      growthBookCachedAt: raw.cachedGrowthBookFeaturesAt
        ? new Date(raw.cachedGrowthBookFeaturesAt).toISOString()
        : null,
      userSettingsRemoteControlAtStartup: (() => {
        try {
          return JSON.parse(fs.readFileSync(path.join(HOME, ".claude", "settings.json"), "utf8"))
            .remoteControlAtStartup ?? null;
        } catch {
          return null;
        }
      })(),
    };
  } catch {
    return null;
  }
}

const stripEscapes = (text) => text.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "");
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function waitUntil(predicate, ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (predicate()) return true;
    await delay(150);
  }
  return false;
}

/** The `/rc` pill, anchored so a cwd banner containing `/rc…` cannot forge it.
 *  MEASURED footer shape (q5, all four permission modes):
 *      <statusline output>                                        /rc
 *  i.e. the pill terminates its row. rc7's unanchored `\/rc\b` matched its own
 *  workspace path instead — the reason this needle exists. */
const RC_PILL_ROW_RE = /(?:^|\s)\/rc$/;
const rcPillRows = (screenText) =>
  screenText
    .split("\n")
    .map((line) => line.trimEnd())
    .filter((line) => RC_PILL_ROW_RE.test(line));

/**
 * One arm: a fresh production `TerminalHost` claude session.
 *
 * `shape` decides what the spawn carries:
 *   "off-intent"  — production buildArgs, no `remoteControl` (writes the key)
 *   "on-intent"   — production buildArgs, `remoteControl: true` (omits the key,
 *                   passes `--remote-control`)
 *   "control"     — the PRE-FIX shape: the same production settings file with
 *                   `remoteControlAtStartup` deleted, passed through the
 *                   production `claudeArgs`. The control for the flapping
 *                   server-side default.
 */
async function runArm(label, shape, { inject = false } = {}) {
  const workspace = path.join(ROOT, label);
  const runtimeDir = path.join(ROOT, `${label}-runtime`);
  fs.mkdirSync(workspace, { recursive: true });
  fs.mkdirSync(runtimeDir, { recursive: true });

  let raw = "";
  let trustSeen = false;
  const rcStates = [];
  const screen = new TaskScreenModel(normalizeTerminalDimensions(COLS, ROWS));
  const T0 = { value: Date.now() };
  const at = () => Date.now() - T0.value;

  const host = new TerminalHost({
    taskId: `task-rc8-${label}`,
    provider: "claude",
    defaultWorkspace: workspace,
    eventSink: (event) => {
      if (event.type === "pty:data") {
        raw = `${raw}${event.payload.data}`.slice(-400 * 1024);
        screen.write(event.payload.data);
        return;
      }
      if (event.type === "approval:detected" && event.payload.kind === "workspace-trust") {
        trustSeen = true;
        void host.sendApprove().catch((error) => console.error("sendApprove failed:", error));
      }
      if (event.type === "remote-control:state") {
        rcStates.push({ active: event.payload.active, url: event.payload.url, atMs: at() });
      }
    },
  });

  const out = { arm: label, shape, autoStartInputs: autoStartInputs() };
  try {
    let started;
    if (shape === "control") {
      // The pre-fix file: production writer, then the SL-19 key removed. Nothing
      // else about the spawn differs — which is what makes it a control.
      const produced = ensureClaudeRuntimeSettings(runtimeDir, {});
      const stripped = JSON.parse(fs.readFileSync(produced, "utf8"));
      out.keyPresentBeforeStrip = "remoteControlAtStartup" in stripped;
      delete stripped.remoteControlAtStartup;
      const controlSettingsPath = path.join(runtimeDir, "pre-fix-settings.json");
      fs.writeFileSync(controlSettingsPath, `${JSON.stringify(stripped, null, 2)}\n`, "utf8");
      out.settingsKeys = Object.keys(stripped);
      out.remoteControlAtStartup = stripped.remoteControlAtStartup ?? null;
      started = host.startTask({
        cwd: workspace,
        permissionMode: "default",
        rows: ROWS,
        cols: COLS,
        args: claudeArgs({ permissionMode: "default", settingsPath: controlSettingsPath }),
      });
    } else {
      started = host.startTask({
        cwd: workspace,
        runtimeDir,
        permissionMode: "default",
        rows: ROWS,
        cols: COLS,
        ...(shape === "on-intent" ? { remoteControl: true } : {}),
      });
      const written = JSON.parse(
        fs.readFileSync(path.join(runtimeDir, "claude-runtime-settings.json"), "utf8"),
      );
      out.settingsKeys = Object.keys(written);
      out.remoteControlAtStartup =
        "remoteControlAtStartup" in written ? written.remoteControlAtStartup : null;
      out.remoteControlAtStartupKeyPresent = "remoteControlAtStartup" in written;
      // Byte-stability of THIS shape: the production writer, run again with the
      // same options, must produce the same bytes and not rewrite the file.
      const before = fs.readFileSync(path.join(runtimeDir, "claude-runtime-settings.json"), "utf8");
      const mtimeBefore = fs.statSync(path.join(runtimeDir, "claude-runtime-settings.json")).mtimeMs;
      ensureClaudeRuntimeSettings(runtimeDir, {
        ...(shape === "on-intent" ? { remoteControl: true } : {}),
      });
      out.byteStableOnRepeat =
        fs.readFileSync(path.join(runtimeDir, "claude-runtime-settings.json"), "utf8") === before &&
        fs.statSync(path.join(runtimeDir, "claude-runtime-settings.json")).mtimeMs === mtimeBefore;
    }
    out.args = started.args;
    out.carriesRemoteControlFlag = started.args.includes("--remote-control");

    out.reachedInput = await waitUntil(() => trustSeen || host.acceptsPromptInput(), 120_000);
    out.acceptsInput = await waitUntil(() => host.acceptsPromptInput(), 120_000);
    out.composerAtMs = at();
    out.trustDialogSeen = trustSeen;

    // ── the boot's own RC outcome, watched to the end of the window ────────────
    let connectingAtMs = null;
    let pillAtMs = null;
    let gridUrlAtMs = null;
    let gridUrl = null;
    const bootT0 = Date.now();
    while (Date.now() - bootT0 < BOOT_WATCH_MS) {
      const text = screen.viewportText();
      if (connectingAtMs === null && /connecting…/.test(stripEscapes(raw))) {
        connectingAtMs = Date.now() - bootT0;
      }
      if (pillAtMs === null && rcPillRows(text).length > 0) {
        pillAtMs = Date.now() - bootT0;
      }
      if (gridUrlAtMs === null) {
        const hit = findRemoteControlUrlOnScreen(text);
        if (hit) {
          gridUrl = hit;
          gridUrlAtMs = Date.now() - bootT0;
        }
      }
      await delay(500);
    }
    out.boot = {
      sawConnectingOnStream: connectingAtMs !== null,
      connectingAtMs,
      sawRcPillOnGrid: pillAtMs !== null,
      rcPillAtMs: pillAtMs,
      rcPillRows: rcPillRows(screen.viewportText()),
      // The production grid reader, on the production grid.
      sessionUrlOnGrid: gridUrl,
      sessionUrlAtMs: gridUrlAtMs,
      // RECORDED, NOT COUNTED on an off-intent/control arm: Sonata only arms its
      // own RC state on `--remote-control` or an injection, so `detectRemoteControlState`
      // returns early and an empty list here is true by construction, not evidence.
      rcStates: rcStates.map((state) => ({ ...state })),
      autoStarted: connectingAtMs !== null || pillAtMs !== null,
    };
    out.autoStarted = out.boot.autoStarted;

    // ── THE RED LINE: a startup key must not disable a capability ─────────────
    if (inject) {
      const injectAtMs = at();
      out.inject = { atMs: injectAtMs, result: host.injectRemoteControl() };
      const connected = await waitUntil(
        () => rcStates.some((state) => state.active && state.url),
        INJECT_WATCH_MS,
      );
      const afterText = screen.viewportText();
      out.inject.connected = connected;
      out.inject.rcStates = rcStates.filter((state) => state.atMs >= injectAtMs);
      out.inject.sessionUrlOnGrid = findRemoteControlUrlOnScreen(afterText);
      out.inject.rcPillRows = rcPillRows(afterText);
      out.inject.acceptsInputAfter = host.acceptsPromptInput();
    }
    out.finalScreen = screen.viewportText();
  } finally {
    host.dispose();
    await delay(1200);
  }
  return out;
}

async function main() {
  fs.rmSync(ROOT, { recursive: true, force: true });
  fs.mkdirSync(ROOT, { recursive: true });

  const results = { version, arms: [] };
  results.arms.push(await runArm("c-control-pre", "control"));
  results.arms.push(await runArm("a-off-intent", "off-intent", { inject: true }));
  results.arms.push(await runArm("b-on-intent", "on-intent"));
  results.arms.push(await runArm("d-control-post", "control"));

  const byArm = Object.fromEntries(results.arms.map((arm) => [arm.arm, arm]));
  const controlPre = byArm["c-control-pre"];
  const offIntent = byArm["a-off-intent"];
  const onIntent = byArm["b-on-intent"];
  const controlPost = byArm["d-control-post"];

  // Is the control genuinely the pre-fix shape? Same argv modulo the settings
  // path — asserted, not asserted-by-comment.
  const argvModuloSettings = (args) =>
    args.map((value, index) => (args[index - 1] === "--settings" ? "<settings>" : value));
  const controlIsPreFixShape =
    JSON.stringify(argvModuloSettings(controlPre.args)) ===
      JSON.stringify(argvModuloSettings(offIntent.args)) &&
    controlPre.keyPresentBeforeStrip === true &&
    controlPre.remoteControlAtStartup === null;

  // The bracket: without BOTH controls auto-starting, the suppression arm is
  // uninterpretable and this run must say so rather than claim a pass.
  const bracketValid = controlPre.autoStarted === true && controlPost.autoStarted === true;

  results.verdicts = {
    controlIsPreFixShape,
    bracketValid,
    // O1 — the OFF path writes the key, and only it.
    offIntentWritesKey:
      offIntent.remoteControlAtStartup === false && offIntent.carriesRemoteControlFlag === false,
    onIntentOmitsKey:
      onIntent.remoteControlAtStartupKeyPresent === false && onIntent.carriesRemoteControlFlag === true,
    // O3a — suppression, attributable only inside a valid bracket.
    offIntentSuppressedAutoStart: bracketValid && offIntent.autoStarted === false,
    // O3b — the ON intent still connects with the key ABSENT (the shape rc4 leg 3
    // did not run: flag over nothing, rather than flag over `false`).
    onIntentConnected: onIntent.boot.rcStates.some((state) => state.active && state.url),
    // O3c — THE RED LINE.
    midSessionInjectStillConnects:
      offIntent.inject?.result?.ok === true && offIntent.inject?.connected === true,
    // O2 — byte-stability per shape.
    byteStable: offIntent.byteStableOnRepeat === true && onIntent.byteStableOnRepeat === true,
  };
  results.success = Object.values(results.verdicts).every(Boolean);

  results.settingsGuard = restoreOnce();
  const endVersion = readVersion();
  results.versionAtEnd = endVersion;
  results.versionDrift = !endVersion.startsWith(EXPECT_VERSION);

  const body = scrub(JSON.stringify(results, null, 2));
  // Run-numbered like rc7: the background this probe measures against FLAPS, so
  // a replicate is evidence in its own right and must not overwrite the first.
  const run = process.argv.find((value) => /^run\d+$/.test(value)) ?? "run1";
  fs.writeFileSync(
    path.join(OUT_DIR, `rc8-startup-lever-live.${run}.capture.txt`),
    `# RC8 — the SL-19 startup lever through the production spawn (claude ${version})\n` +
      `# captured ${new Date().toISOString()}\n\n${body}\n`,
  );
  console.log(body);
  if (results.versionDrift) process.exitCode = 2;
  else if (!results.success) process.exitCode = 1;
}

main().catch((error) => {
  restoreOnce();
  console.error(scrub(String(error?.stack ?? error)));
  process.exit(1);
});
