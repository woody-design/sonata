// RC7 (2026-09 sync, SL-11, objective 4 — REPORT-ONLY) — the lever, and the
// discrepancy that was in the way of measuring it.
//
// TWO facts that did not fit together:
//   - Every `TerminalHost` boot in rc5 (6/6, no `--remote-control`) auto-started
//     RC: `/rc connecting…` → green pill.
//   - Every `Probe` boot in rc2 and rc4 (7/7, same account, same binary, same
//     minute, `tengu_cobalt_harbor` true throughout) did NOT.
// Until that is explained, rc4's leg-2 negative ("a `remoteControlAtStartup:
// true` in the `--settings` file did not enable auto-start") is uninterpretable:
// it cannot distinguish "the flag source is not accepted" from "auto-start was
// suppressed in this spawn shape whatever the settings said".
//
// The one systematic difference is the ENVIRONMENT. `Probe` deletes everything
// matching /^(CLAUDE|ANTHROPIC_MODEL|AI_AGENT)/i; `ptyEnvironment` (production)
// deletes only `CLAUDECODE` and `CLAUDE_CODE_*`, keeping `AI_AGENT`,
// `CLAUDE_PID`, `CLAUDE_EFFORT`, `CLAUDE_PLUGIN_DATA`. So this probe spawns the
// pty itself and varies exactly two things:
//
//   A  production env,  no RC key            — expect auto-start (the rc5 shape)
//   B  production env,  remoteControlAtStartup: false
//                                            — THE QUESTION: can the `--settings`
//                                              file Sonata already writes turn RC
//                                              off on Sonata's own spawn?
//   C  Probe-scrubbed env, no RC key         — expect NO auto-start (the rc2/rc4
//                                              shape), which is the control that
//                                              makes A's result mean something
//
// A ≠ C isolates the environment. A ≠ B isolates the lever. If A and C agree,
// the environment hypothesis is wrong and the report says so.
//
// Nothing is written to the user's config; ~/.claude/settings.json is
// byte-compared at the end. Scratch dirs are /private/tmp/... (never the agent
// scratchpad, whose path embeds the username).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";

const OUT_DIR = new URL(".", import.meta.url).pathname;
const APP_DIR = new URL("../../../app/", import.meta.url).pathname;
const require = createRequire(APP_DIR + "package.json");
const pty = require("node-pty");
const { Terminal } = require("@xterm/headless");
const { ensureClaudeRuntimeSettings } = require(APP_DIR + "dist/runtime");

const EXPECT_VERSION = "2.1.258";
const ROOT = "/private/tmp/sonata-sync-2026-09/rc-lever";
const COLS = 120;
const ROWS = 36;
const WATCH_MS = 45_000;

const HOME = os.homedir();
const USER_MUNGED = `-${HOME.replace(/\//g, "-").replace(/^-/, "")}-`;
const sanitize = (v) => String(v).split(HOME).join("$HOME").split(USER_MUNGED).join("-$USER_MUNGED-");
const scrub = (v) => sanitize(v).replace(/session_[A-Za-z0-9_-]{8,}/g, "session_<REDACTED>");

function readVersion() {
  return execFileSync("claude", ["--version"], { encoding: "utf8" }).trim();
}
const version = (() => {
  const v = readVersion();
  if (!v.startsWith(EXPECT_VERSION)) {
    console.log(JSON.stringify({ success: false, reason: `binary moved off ${EXPECT_VERSION}`, version: v }));
    process.exit(2);
  }
  return v;
})();

const USER_SETTINGS = path.join(HOME, ".claude", "settings.json");
const settingsBefore = fs.readFileSync(USER_SETTINGS, "utf8");
const USER_CONFIG = path.join(HOME, ".claude.json");
const cobaltHarbor = () =>
  JSON.parse(fs.readFileSync(USER_CONFIG, "utf8")).cachedGrowthBookFeatures?.tengu_cobalt_harbor ?? null;

/** `ptyEnvironment`'s policy, verbatim (terminal-host.ts): drop the nesting
 *  markers `CLAUDECODE` and `CLAUDE_CODE_*`, keep everything else. */
function productionEnv() {
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.CLAUDECODE;
  for (const key of Object.keys(env)) {
    if (key.startsWith("CLAUDE_CODE_")) delete env[key];
  }
  env.TERM = "xterm-256color";
  env.COLORTERM = "truecolor";
  return env;
}

/** The 2026-08 driver's policy, verbatim: drop every CLAUDE, ANTHROPIC_MODEL and
 *  AI_AGENT marker. */
function scrubbedEnv() {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (/^(CLAUDE|ANTHROPIC_MODEL|AI_AGENT)/i.test(key)) delete env[key];
  }
  env.TERM = "xterm-256color";
  return env;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function spawnClaude({ cwd, args, env }) {
  const term = new Terminal({ cols: COLS, rows: ROWS, allowProposedApi: true, scrollback: 80 });
  let raw = "";
  const p = pty.spawn("claude", args, { name: "xterm-256color", cols: COLS, rows: ROWS, cwd, env });
  p.onData((d) => {
    raw += d;
    term.write(d);
  });
  const screen = () => {
    const b = term.buffer.active;
    const rows = [];
    for (let y = 0; y < term.rows; y++) {
      const line = b.getLine(b.viewportY + y);
      rows.push(line ? line.translateToString(true) : "");
    }
    return rows.join("\n");
  };
  return { pty: p, screen, raw: () => raw, kill: () => { try { p.kill(); } catch { /* gone */ } } };
}

/** Sonata's real merged settings file, plus (optionally) the RC startup key. */
function settingsFor(label, atStartup) {
  const runtimeDir = path.join(ROOT, `${label}-runtime`);
  fs.mkdirSync(runtimeDir, { recursive: true });
  const base = JSON.parse(fs.readFileSync(ensureClaudeRuntimeSettings(runtimeDir, {}), "utf8"));
  const merged = atStartup === undefined ? base : { ...base, remoteControlAtStartup: atStartup };
  const file = path.join(runtimeDir, "rc-lever-settings.json");
  fs.writeFileSync(file, JSON.stringify(merged, null, 2));
  return file;
}

const LEGS = [
  { label: "A-prodenv-nokey", env: "production", atStartup: undefined },
  { label: "B-prodenv-false", env: "production", atStartup: false },
  { label: "C-scrubenv-nokey", env: "scrubbed", atStartup: undefined },
];

async function runLeg(leg) {
  const cwd = path.join(ROOT, leg.label);
  fs.mkdirSync(cwd, { recursive: true });
  const settingsPath = settingsFor(leg.label, leg.atStartup);
  const args = ["--permission-mode", "default", "--settings", settingsPath];
  const s = spawnClaude({
    cwd,
    args,
    env: leg.env === "production" ? productionEnv() : scrubbedEnv(),
  });
  const out = { leg: leg.label, env: leg.env, remoteControlAtStartup: leg.atStartup ?? null, cobaltHarbor: cobaltHarbor() };
  try {
    // Answer the trust dialog the 2.1.252+ way (default row is "No, exit").
    const trustSeen = await until(() => /Quick safety check|trust this folder/i.test(s.screen()), 45_000);
    out.trustDialog = trustSeen;
    if (trustSeen) {
      for (let i = 0; i < 6; i++) {
        await sleep(500);
        s.pty.write("\x1b[B");
        await sleep(350);
        if (s.screen().split("\n").some((l) => /❯\s*Yes, I trust this folder/i.test(l))) break;
      }
      s.pty.write("\r");
      await sleep(1500);
    }
    out.reachedComposer = await until(() => /for shortcuts|Try "|⏵|⏸/i.test(s.screen()), 60_000);

    // The auto-start tell: the pill goes amber `connecting…` then green, and a
    // successful connect can also print a link. Watch the whole window — the
    // connect is asynchronous.
    let connectingAtMs = null;
    let linkAtMs = null;
    const t0 = Date.now();
    while (Date.now() - t0 < WATCH_MS) {
      const raw = s.raw();
      if (connectingAtMs === null && /connecting…/.test(raw.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, ""))) {
        connectingAtMs = Date.now() - t0;
      }
      if (linkAtMs === null && /claude\.(?:ai|com)\/code\/session_/.test(s.screen())) {
        linkAtMs = Date.now() - t0;
      }
      if (connectingAtMs !== null && linkAtMs !== null) break;
      await sleep(500);
    }
    out.autoStartAttemptedAtMs = connectingAtMs;
    out.autoStarted = connectingAtMs !== null;
    out.linkOnGridAtMs = linkAtMs;
    out.footerRow =
      s
        .screen()
        .split("\n")
        .map((l) => l.trim())
        .filter((l) => /\/rc\b/.test(l))
        .slice(-1)[0] ?? null;
    out.complaints = s
      .screen()
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => /ignored|cannot enable|not available|disabled|policy/i.test(l));
  } finally {
    s.kill();
    await sleep(900);
  }
  return out;
}

async function until(pred, ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (pred()) return true;
    await sleep(150);
  }
  return false;
}

async function main() {
  fs.rmSync(ROOT, { recursive: true, force: true });
  fs.mkdirSync(ROOT, { recursive: true });
  const results = { version, legs: [] };
  for (const leg of LEGS) {
    results.legs.push(await runLeg(leg));
  }
  const [a, b, c] = results.legs;
  results.verdicts = {
    // Does the environment explain the rc5-vs-rc2 discrepancy?
    environmentExplainsDiscrepancy: a.autoStarted === true && c.autoStarted === false,
    // Can Sonata's own --settings file turn RC OFF on Sonata's own spawn?
    settingsFileCanDisableAutoStart: a.autoStarted === true && b.autoStarted === false,
  };
  results.userSettingsUnchanged = fs.readFileSync(USER_SETTINGS, "utf8") === settingsBefore;
  results.versionAtEnd = readVersion();
  results.versionDrift = !results.versionAtEnd.startsWith(EXPECT_VERSION);
  const body = scrub(JSON.stringify(results, null, 2));
  // Run-numbered: the background this probe measures against FLAPS (the
  // GrowthBook default that decides auto-start refreshes asynchronously), so the
  // replicate is evidence in its own right and must not overwrite the first.
  const run = process.argv[2] ?? "run1";
  fs.writeFileSync(
    path.join(OUT_DIR, `rc7-autostart-lever.${run}.capture.txt`),
    `# RC7 — RC auto-start: environment vs the --settings lever (claude ${version})\n` +
      `# captured ${new Date().toISOString()}\n\n${body}\n`,
  );
  console.log(body);
  if (results.versionDrift) process.exitCode = 2;
}

main().catch((e) => {
  console.error(scrub(String(e?.stack ?? e)));
  process.exit(1);
});
