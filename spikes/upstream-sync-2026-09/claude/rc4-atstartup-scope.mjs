// RC4 (2026-09 sync, SL-11, objective 4 — REPORT-ONLY) — what can Sonata's
// `defaultRemoteControl` setting actually control at claude 2.1.258?
//
// THE COLLISION. Woody's product default is `defaultRemoteControl: false`, and
// Sonata implements it by NOT passing `--remote-control`. F4 measured RC
// connecting at boot at 2.1.252 with no flag at all — i.e. the setting said OFF
// and the session was phone-reachable anyway. RC2 (2.1.258, today) measured the
// opposite in three spawn shapes including F4's exact one. So the auto-start
// switch is somewhere Sonata is not looking, and it MOVED without a Sonata
// change. This probe asks where the switch is and whether Sonata's spawn can
// reach it.
//
// The claim under test comes from the binary's own resolution function
// (2.1.258, `wVt`): `remoteControlAtStartup` resolves as
//     project/local `false`  →  false            (repo scope can only DISABLE)
//     else highest of         →  policySettings | flagSettings | userSettings
//     else legacy global config
//     else                    →  the org/GrowthBook auto-connect default
// with a logged refusal for repo-scoped `true` ("repo-scoped settings cannot
// enable Remote Control; set it at user scope"). `flagSettings` is the
// `--settings` file — the file Sonata already writes on every spawn. If that
// reading is right, the lever IS in Sonata's hands; if it is wrong, the report
// must say so.
//
// Three legs. All carry Sonata's REAL merged settings, plus the RC key:
//   1 absent          + no flag   — control (must reproduce RC2's "no connect")
//   2 atStartup:true  + no flag   — does the `--settings` file ENABLE auto-start?
//                                   A connect here proves `--settings` is an
//                                   accepted enabling source (`flag` precedence).
//   3 atStartup:false + --remote-control — does an explicit `false` BLOCK
//                                   Sonata's own opt-in? This is the risk check
//                                   that has to precede any proposal to write
//                                   `false`: a lever that also breaks "on" is
//                                   not a lever.
// DELIBERATELY NOT A LEG: `atStartup:false` + no flag. Its outcome (no connect)
// is indistinguishable from leg 1 while the org/GB default is OFF, so it would
// measure nothing. The hard-off can only be validated against a session that
// WOULD otherwise auto-start — not available today. Said plainly rather than
// dressed up as a pass.
//
// Nothing here changes Sonata code or the user's config: the merged file is
// written to a scratch path, ~/.claude/settings.json and the RC keys in
// ~/.claude.json are byte-compared at the end. Scratch dirs are /private/tmp/...
// (never the agent scratchpad, whose path embeds the username).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";

const OUT_DIR = new URL(".", import.meta.url).pathname;
const APP_DIR = new URL("../../../app/", import.meta.url).pathname;
const require = createRequire(APP_DIR + "package.json");
const {
  ensureClaudeRuntimeSettings,
  findRemoteControlUrlOnScreen,
  compactRemoteControlScan,
  hasRemoteControlDisconnect,
  REMOTE_CONTROL_SCAN_LIMIT,
} = require(APP_DIR + "dist/runtime");

const { Probe, Capture, KEYS, sleep } = await import("../../upstream-sync-2026-08/claude/driver.mjs");

const EXPECT_VERSION = "2.1.258";
const ROOT = "/private/tmp/sonata-sync-2026-09/rc-atstartup";
const COLS = 120;
const ROWS = 40;
const WATCH_MS = 45_000;

const HOME = os.homedir();
const USER_MUNGED = `-${HOME.replace(/\//g, "-").replace(/^-/, "")}-`;
const sanitize = (v) => String(v).split(HOME).join("$HOME").split(USER_MUNGED).join("-$USER_MUNGED-");
const redactSession = (v) => String(v).replace(/session_[A-Za-z0-9_-]+/g, "session_<REDACTED>");
const scrub = (v) => redactSession(sanitize(v));

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

const USER_SETTINGS = path.join(HOME, ".claude", "settings.json");
const settingsBefore = fs.readFileSync(USER_SETTINGS, "utf8");
const USER_CONFIG = path.join(HOME, ".claude.json");
function rcUserKeys() {
  const raw = JSON.parse(fs.readFileSync(USER_CONFIG, "utf8"));
  return Object.fromEntries(
    Object.keys(raw)
      .filter((k) => /remote|^rc[A-Z]/i.test(k))
      .map((k) => [k, raw[k]]),
  );
}
const rcKeysBefore = rcUserKeys();

/** The inputs claude's own auto-start resolver reads when no explicit
 *  `remoteControlAtStartup` is in scope (verbatim from the 2.1.258 binary):
 *  remote env → false; persistent remote session → true; org policy
 *  `remote_control_at_startup` → its value; else GrowthBook `tengu_cobalt_harbor`.
 *  Recorded per leg because the GrowthBook bag refreshes asynchronously — a leg
 *  is only interpretable against the default that was in force for it. */
function autoStartInputs() {
  const raw = JSON.parse(fs.readFileSync(USER_CONFIG, "utf8"));
  const user = JSON.parse(fs.readFileSync(USER_SETTINGS, "utf8"));
  return {
    tengu_cobalt_harbor: raw.cachedGrowthBookFeatures?.tengu_cobalt_harbor ?? null,
    growthBookCachedAt: raw.cachedGrowthBookFeaturesAt
      ? new Date(raw.cachedGrowthBookFeaturesAt).toISOString()
      : null,
    userSettingsRemoteControlAtStartup: user.remoteControlAtStartup ?? null,
    legacyGlobalRemoteControlAtStartup: raw.remoteControlAtStartup ?? null,
  };
}

/** Sonata's real merged settings file, plus (optionally) the RC startup key —
 *  written to its own path so `ensureClaudeRuntimeSettings`'s own output is
 *  never mutated. */
function settingsFor(label, atStartup) {
  const runtimeDir = path.join(ROOT, `${label}-runtime`);
  fs.mkdirSync(runtimeDir, { recursive: true });
  const base = JSON.parse(fs.readFileSync(ensureClaudeRuntimeSettings(runtimeDir, {}), "utf8"));
  const merged = atStartup === undefined ? base : { ...base, remoteControlAtStartup: atStartup };
  const p = path.join(runtimeDir, "rc-probe-settings.json");
  fs.writeFileSync(p, JSON.stringify(merged, null, 2));
  return { path: p, keys: Object.keys(merged), remoteControlAtStartup: merged.remoteControlAtStartup ?? null };
}

function armScan(p) {
  const state = { scan: "" };
  p.pty.onData((c) => {
    state.scan = (state.scan + c).slice(-REMOTE_CONTROL_SCAN_LIMIT);
  });
  return state;
}

function sample(p, scan) {
  const screen = p.screen();
  return {
    // Both channels, as the shipped split defines them: OFF off the rolling raw
    // tail, the link off the reconstructed screen.
    rawTailOff: hasRemoteControlDisconnect(compactRemoteControlScan(scan)),
    urlOnGrid: findRemoteControlUrlOnScreen(screen),
    rcRows: screen
      .split("\n")
      .map((l) => l.trim())
      .filter((t) => /remote control|Keep working from anywhere|connecting/i.test(t)),
  };
}

const LEGS = [
  { label: "1-absent-noflag", atStartup: undefined, flag: false },
  { label: "2-true-noflag", atStartup: true, flag: false },
  { label: "3-false-withflag", atStartup: false, flag: true },
];

async function runLeg(cap, leg) {
  const cwd = path.join(ROOT, leg.label);
  fs.mkdirSync(cwd, { recursive: true });
  const settings = settingsFor(leg.label, leg.atStartup);
  const args = [
    "--permission-mode",
    "default",
    "--settings",
    settings.path,
    ...(leg.flag ? ["--remote-control"] : []),
  ];
  const p = new Probe({ cwd, rows: ROWS, cols: COLS, args });
  const scan = armScan(p);
  try {
    const trust = await p.waitFor(/Quick safety check|trust this folder/i, 45_000);
    if (trust) {
      for (let i = 0; i < 6; i++) {
        await sleep(500);
        p.write(KEYS.down);
        await sleep(350);
        if (p.screen().split("\n").some((l) => /❯\s*Yes, I trust this folder/i.test(l))) break;
      }
      p.write(KEYS.enter);
      await sleep(1500);
    }
    const ready = await p.waitFor(/for shortcuts|Welcome back|Try "|⏵|⏸/i, 60_000);
    cap.frame(p, `${leg.label} — composer reached`);

    const series = [];
    const t0 = Date.now();
    let lastKey = "";
    while (Date.now() - t0 < WATCH_MS) {
      const s = sample(p, scan.scan);
      series.push({ atMs: Date.now() - t0, ...s });
      const key = JSON.stringify([s.rcRows, Boolean(s.urlOnGrid)]);
      if (key !== lastKey) {
        cap.frame(p, `${leg.label} — RC surface changed at +${Date.now() - t0}ms`);
        lastKey = key;
      }
      await sleep(2000);
    }

    const connect = series.find((s) => s.urlOnGrid) ?? null;
    // A REFUSAL is as informative as a connect: the binary logs when a scope is
    // not allowed to enable RC, and any complaint line belongs in the record.
    const complaints = p
      .screen()
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => /ignored|cannot enable|not available|disabled|policy|invalid|unknown/i.test(l));
    const v = {
      leg: leg.label,
      settingsKeys: settings.keys,
      remoteControlAtStartup: settings.remoteControlAtStartup,
      flag: leg.flag,
      args: args.map(sanitize),
      ready,
      connected: Boolean(connect),
      connectedAtMs: connect?.atMs ?? null,
      sawDisconnectOnStream: series.some((s) => s.rawTailOff),
      complaints,
      distinctRcRows: [...new Set(series.flatMap((s) => s.rcRows))],
    };
    cap.add(`${leg.label} — verdict`, scrub(JSON.stringify(v, null, 2)));
    cap.add(`${leg.label} — settings file`, scrub(fs.readFileSync(settings.path, "utf8")));
    return v;
  } finally {
    p.kill();
    await sleep(900);
  }
}

async function main() {
  fs.rmSync(ROOT, { recursive: true, force: true });
  fs.mkdirSync(ROOT, { recursive: true });
  const cap = new Capture(
    path.join(OUT_DIR, "rc4-atstartup-scope.capture.txt"),
    `RC4 — remoteControlAtStartup via Sonata's --settings file (claude ${version})`,
  );
  const results = { version, legs: [] };
  for (const leg of LEGS) {
    const inputs = autoStartInputs();
    results.legs.push({ ...(await runLeg(cap, leg)), autoStartInputs: inputs });
  }
  results.rcUserKeysUnchanged = JSON.stringify(rcUserKeys()) === JSON.stringify(rcKeysBefore);
  results.userSettingsUnchanged = fs.readFileSync(USER_SETTINGS, "utf8") === settingsBefore;
  const endVersion = readVersion();
  results.versionAtEnd = endVersion;
  results.versionDrift = !endVersion.startsWith(EXPECT_VERSION);
  cap.add("fence", scrub(JSON.stringify(results, null, 2)));
  cap.save();
  console.log(scrub(JSON.stringify(results, null, 2)));
  if (results.versionDrift) process.exitCode = 2;
}

main().catch((e) => {
  console.error(scrub(String(e?.stack ?? e)));
  process.exit(1);
});
