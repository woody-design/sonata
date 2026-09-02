// P1 (2026-09 D2, slice U2) — WHERE DOES CLAUDE PUT A SESSION'S TRANSCRIPT, and
// can Sonata stop re-implementing the rule that decides?
//
// THE QUESTION. `session-locator.ts` re-implements upstream's cwd → directory
// name rule (`claudeProjectSlug`: `cwd.replace(/[^a-zA-Z0-9]/g,"-")`, plus a
// realpath variant). Upstream changed that rule — long paths are now truncated
// and suffixed with a HASH — so a Sonata task in a long cwd looks in a directory
// the CLI no longer uses. The slice replaces rule-replication with three layers
// that never model upstream naming (hook `transcript_path` → a manifest path
// cache → an id-anchored scan). This probe measures the four facts that design
// rests on.
//
// STATIC READ FIRST (2026-09-02, `grep -a` over the 2.1.258 binary). Everything
// below is a HYPOTHESIS this probe confirms or falsifies live:
//
//   var IL = 200;
//   function be(e){ return Math.abs(zq(e)).toString(36) }          // hash
//   function k(e) { return e.replace(/[^a-zA-Z0-9]/g,"-") }        // the old rule
//   function KA(e){ let n=k(e); if(n.length<=IL) return n;
//                   return `${n.slice(0,IL)}-${be(e)}` }           // the NEW rule
//   function _()  { return process.env.CLAUDE_CODE_PROJECT_DIR_NAME }
//   var D = /^[A-Za-z0-9_-]{1,64}$/, C = /^(?:con|prn|aux|nul|com[0-9]|lpt[0-9])$/i;
//   function sLn(e){ if(!e || !D.test(e) || C.test(e)) return; return e }
//   var Apr = Zo(() => s() ? sLn(_()) : void 0, I);                // s() = CLAUDE_CONFIG_DIR
//   function ia(){ return join(Se(), "projects") }                 // Se() = the config dir
//   function Em(e){ return Apr() ?? KA(e) }                        // name = env ?? rule
//   function Bu(e){ return join(ia(), Em(e)) }                     // the project directory
//
// So statically: (S1) `CLAUDE_CODE_PROJECT_DIR_NAME` is consulted ONLY when
// `CLAUDE_CONFIG_DIR` is also set, which Sonata never sets (SL-3: an isolated
// config dir is logged out) — the variable should be INERT for our spawn shape;
// and the truncation threshold should be a slug of MORE THAN 200 characters,
// where the slug is the cwd with every non-alphanumeric byte mapped 1:1 to `-`
// (so slug length == cwd length) and the hash is taken over the ORIGINAL cwd by
// a bundled hash function that is not reproducible from outside the binary.
//
// That last clause is the whole slice in one line: even a perfect re-reading of
// today's rule cannot be re-implemented, because the suffix is an internal hash.
// Sonata must find the FILE, not derive the directory.
//
// ARMS
//   arm1   env `CLAUDE_CODE_PROJECT_DIR_NAME=sonata-p1-armone`, NO
//          `CLAUDE_CONFIG_DIR`, production spawn shape with `--session-id`.
//          Where does `<uuid>.jsonl` land? (S1 falsification.) Plus: does
//          `SessionStart` carry `transcript_path`, and does the FILE exist by the
//          time that hook fires — which decides how long layer 3 is ever needed.
//   arm2a  cwd of EXACTLY 200 characters — the threshold's inclusive side.
//   arm2b  cwd of EXACTLY 201 characters — the first truncated+hashed name.
//   arm2c  cwd of ~300 characters — the clearly-truncated MEASURED fixture the
//          smoke's long-cwd case is built from.
//   arm4   cwd handed to the spawn through the `/tmp` symlink while its realpath
//          is `/private/tmp` — does the CLI key by the REALPATH at 2.1.258?
//          (Confirms or retires the `claudeCwdVariants` premise before deletion.)
//   arm3   ONLY if arm1 surprises: a throwaway `CLAUDE_CONFIG_DIR` + the var. A
//          logged-out config dir may never write a jsonl at all; inconclusive is
//          an acceptable answer and is recorded as one.
//
// METHOD. Every arm is a REAL spawn through the production `TerminalHost` from
// `dist/` — production argv, production `--settings` (whose hook sink already
// injects `SessionStart`), production `HookWatcher` — so the only variable per
// arm is the cwd (or the env key) under test. The directory name is never
// inferred from our own rule: it is read from the hook's own `transcript_path`
// AND, independently, by scanning `~/.claude/projects/*/<session-id>.jsonl` —
// which is exactly the id-anchored scan the slice ships, so the probe also
// exercises layer 3 against a real 800+ directory projects root.
//
// ISOLATION IS NOT AVAILABLE (SL-3): these arms run against the user's REAL
// $HOME. The settings guard is unconditional for that reason (no arm here types
// `/model`, but the harness rule does not have exceptions — see
// `settings-guard.mjs` for the F41 incident behind it).
//
// PRE-EXISTING, NOT FIXED HERE (U1 F70): every arm answers a workspace-trust
// dialog for a fresh `/private/tmp/...` cwd, and the CLI records that answer
// permanently in `~/.claude.json`'s project map. The guard brackets
// `~/.claude/settings.json` only. Widening it is a program decision, not this
// slice's — that file carries live per-project accounting the CLI rewrites
// continuously, so a byte-restore would clobber a user's concurrent sessions.
//
// Scratch dirs are /private/tmp/... (never the agent scratchpad, whose path
// embeds the username): these frames become findings and the pre-push leak fence
// scans blob content.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { createSettingsGuard, runSettingsGuardSelfTest } from "./settings-guard.mjs";

const OUT_DIR = new URL(".", import.meta.url).pathname;
const APP_DIR = new URL("../../../app/", import.meta.url).pathname;
const require = createRequire(APP_DIR + "package.json");
const { Terminal } = require("@xterm/headless");
const { TerminalHost, HookWatcher, claudeHooksDirectory } = require(APP_DIR + "dist/runtime");

const EXPECT_VERSION = "2.1.258";
// 44 characters, and the arms that control cwd LENGTH are built from it, so it
// is a constant of the measurement and not just a scratch location.
const ROOT = "/private/tmp/sonata-sync-2026-09/project-dir";
const ROOT_VIA_SYMLINK = "/tmp/sonata-sync-2026-09/project-dir";
const COLS = 120;
const ROWS = 40;
const ENV_KEY = "CLAUDE_CODE_PROJECT_DIR_NAME";
const ENV_VALUE = "sonata-p1-armone"; // valid per the static regex ^[A-Za-z0-9_-]{1,64}$
const RESULTS_DIR = path.join(OUT_DIR, ".p1-results");

// ─── sanitize BOTH username forms ───────────────────────────────────────────
// The capture is committed and the pre-push leak fence scans blob CONTENT, so
// the home path has to go in both the shapes it appears in: the literal
// `/Users/<user>` and the munged `-Users-<user>-` slug claude builds project
// directory names from. Project-directory names derived from `/private/tmp/...`
// are NOT sanitized — they are the evidence this probe exists to produce.
const HOME = os.homedir();
const USER_MUNGED = `-${HOME.replace(/\//g, "-").replace(/^-/, "")}-`;
const SESSION_LINK_RE = /session_[A-Za-z0-9_-]{8,}/g;
const sanitize = (value) =>
  String(value)
    .split(HOME)
    .join("$HOME")
    .split(USER_MUNGED)
    .join("-$USER_MUNGED-")
    .replace(SESSION_LINK_RE, "session_<REDACTED>");

// ─── the spawn env must be PRODUCTION's, not this agent session's ───────────
// U1 F70: `ptyEnvironment` deletes `CLAUDECODE` and every `CLAUDE_CODE_*` key,
// but not these three, and this probe runs inside a Claude Code session that
// exports all of them. A Dock-launched Sonata has none, so deleting them here
// makes the spawn MORE production-shaped. Note the scrub ordering that arm1
// depends on: `ptyEnvironment` strips `CLAUDE_CODE_*` from the inherited env and
// THEN spreads `extraEnv`, so arm1's key really does reach the child.
const LEAKED_PARENT_KEYS = ["CLAUDE_EFFORT", "CLAUDE_PID", "CLAUDE_PLUGIN_DATA"].filter(
  (key) => process.env[key] !== undefined,
);
for (const key of LEAKED_PARENT_KEYS) delete process.env[key];
// arm1's premise is "no CLAUDE_CONFIG_DIR". `ptyEnvironment` deliberately KEEPS
// that key (it is user configuration, not a nesting marker), so an inherited one
// would silently arm the very branch the arm exists to prove inert.
const INHERITED_CONFIG_DIR = process.env.CLAUDE_CONFIG_DIR ?? null;
if (INHERITED_CONFIG_DIR !== null) delete process.env.CLAUDE_CONFIG_DIR;

// ─── version pin, start AND end ─────────────────────────────────────────────
function pinVersion(where) {
  const version = execFileSync("claude", ["--version"], { encoding: "utf8" }).trim();
  // SL-4 method note: an END drift must not DISCARD a completed capture. Record
  // the drift, let the caller save, exit non-zero afterwards.
  return { version, drifted: !version.startsWith(EXPECT_VERSION), where };
}
const startPin = pinVersion("probe start");
if (startPin.drifted) {
  console.log(
    JSON.stringify({
      success: false,
      reason: `binary moved off ${EXPECT_VERSION} at start — aborting before any spawn`,
      version: startPin.version,
    }),
  );
  process.exit(2);
}
const version = startPin.version;

// ─── the user's real settings file is a probe HAZARD, not a probe input ─────
const guard = createSettingsGuard();

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ─── the projects root, and the id-anchored scan (layer 3, exercised live) ──
// This is deliberately the SAME shape the slice ships: one readdir of the
// projects root, then an exact-path stat per project directory. No recursion, no
// content reads, no naming rule. Timed, because the scan's cost over the real
// ~800-directory root is a number the slice has to report.
function claudeProjectsRoot() {
  const configDir = process.env.CLAUDE_CONFIG_DIR;
  if (configDir) return path.join(configDir, "projects");
  return path.join(HOME, ".claude", "projects");
}

function scanForSessionFile(sessionId) {
  const root = claudeProjectsRoot();
  const started = process.hrtime.bigint();
  let dirs = [];
  try {
    dirs = fs.readdirSync(root);
  } catch {
    dirs = [];
  }
  let found = null;
  let stats = 0;
  for (const dir of dirs) {
    const candidate = path.join(root, dir, `${sessionId}.jsonl`);
    stats += 1;
    try {
      if (fs.statSync(candidate).isFile()) {
        found = candidate;
        break;
      }
    } catch {
      /* not this directory */
    }
  }
  const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
  return { root, found, dirCount: dirs.length, statsPerformed: stats, elapsedMs };
}

/** The same scan with NO early exit — the true worst case (a miss), which is the
 *  number the slice must quote rather than the lucky-hit number. */
function scanCostFullSweep(sessionId) {
  const root = claudeProjectsRoot();
  const started = process.hrtime.bigint();
  let dirs = [];
  try {
    dirs = fs.readdirSync(root);
  } catch {
    dirs = [];
  }
  let hits = 0;
  for (const dir of dirs) {
    try {
      if (fs.statSync(path.join(root, dir, `${sessionId}.jsonl`)).isFile()) hits += 1;
    } catch {
      /* miss */
    }
  }
  return {
    dirCount: dirs.length,
    hits,
    elapsedMs: Number(process.hrtime.bigint() - started) / 1e6,
  };
}

// ─── the STATIC rule, reproduced ONLY to be checked against measurement ─────
// Never used to produce a reading: the arms read the directory name off the
// hook's `transcript_path` and off the id scan. This function exists so the
// capture can say "the old rule would have predicted X, the CLI wrote Y" — which
// is precisely the coupling the slice deletes.
function oldSonataRule(cwd) {
  return cwd.replace(/[^a-zA-Z0-9]/g, "-");
}

/** A path of EXACTLY `total` characters under `armDir`, built from nested
 *  segments so no single component exceeds the 255-byte darwin limit. */
function cwdOfLength(armDir, total) {
  let current = armDir;
  while (total - current.length - 1 > 120) {
    current = path.join(current, "x".repeat(120));
  }
  const remaining = total - current.length - 1;
  if (remaining < 1) {
    throw new Error(`cannot build a ${total}-char path under ${armDir} (${armDir.length} chars)`);
  }
  const built = path.join(current, "y".repeat(remaining));
  if (built.length !== total) {
    throw new Error(`built ${built.length} chars, wanted ${total}`);
  }
  return built;
}

// ─── one arm's spawn ────────────────────────────────────────────────────────

class Spawn {
  /**
   * @param {string} name        arm id (also the scratch dir name)
   * @param {object} opts
   * @param {string}  opts.workspace   the cwd handed to the spawn
   * @param {object}  opts.extraEnv    env overlaid on the production spawn env
   * @param {boolean} opts.prompt      send one trivial prompt so a turn is written
   */
  constructor(name, { workspace, extraEnv = null, prompt = false } = {}) {
    this.name = name;
    this.t0 = Date.now();
    this.notes = [];
    this.frames = [];
    this.hooks = [];
    this.ptyExited = false;
    this.wantsPrompt = prompt;
    this.extraEnv = extraEnv;

    const runRoot = path.join(ROOT, name);
    fs.rmSync(runRoot, { recursive: true, force: true });
    this.workspace = workspace;
    this.runtimeDir = path.join(runRoot, "runtime");
    fs.mkdirSync(this.workspace, { recursive: true });
    fs.mkdirSync(this.runtimeDir, { recursive: true });
    // git-init so the workspace-trust dialog takes its PRODUCTION shape (a git
    // repo), which is the shape `bootTrusted`'s walk was measured against.
    try {
      execFileSync("git", ["init", "-q"], { cwd: this.workspace, stdio: "ignore" });
    } catch (error) {
      this.notes.push(`git init failed: ${String(error?.message ?? error)}`);
    }

    this.term = new Terminal({ cols: COLS, rows: ROWS, allowProposedApi: true, scrollback: 4000 });
    this.host = new TerminalHost({
      taskId: `task-p1-${name}`,
      provider: "claude",
      defaultWorkspace: this.workspace,
      eventSink: (event) => this.onHostEvent(event),
    });
    // Production pins a fresh session id (runtime-controller randomUUID) — which
    // is the whole premise of layer 3: Sonata knows the id BEFORE the file exists.
    this.sessionId = randomUUID();
    this.watcher = new HookWatcher({
      sinkDir: claudeHooksDirectory,
      pollMs: 100,
      onPayload: (payload) => this.onHookPayload(payload),
      onError: (error, filePath) =>
        this.notes.push(`hook-watcher error ${filePath}: ${error.message}`),
    });
  }

  at() {
    return Date.now() - this.t0;
  }

  screen() {
    const buffer = this.term.buffer.active;
    const lines = [];
    for (let y = 0; y < this.term.rows; y++) {
      const line = buffer.getLine(buffer.viewportY + y);
      lines.push(line ? line.translateToString(true) : "");
    }
    while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
    return lines.join("\n");
  }

  onHostEvent(event) {
    if (event.type === "pty:data") {
      this.term.write(event.payload.data);
      return;
    }
    if (event.type === "pty:exit") this.ptyExited = true;
  }

  onHookPayload(payload) {
    const event =
      typeof payload.hook_event_name === "string" ? payload.hook_event_name : "<none>";
    const transcriptPath =
      typeof payload.transcript_path === "string" ? payload.transcript_path : null;
    // The FILE's existence AT HOOK TIME, sampled the instant the payload lands —
    // this is what decides whether layer 3 is ever needed after the first hook.
    const fileExistsNow = transcriptPath ? fs.existsSync(transcriptPath) : null;
    this.hooks.push({
      atMs: this.at(),
      event,
      keys: Object.keys(payload).sort(),
      session_id: payload.session_id ?? null,
      transcript_path: transcriptPath,
      transcriptExistedAtHook: fileExistsNow,
      cwd: typeof payload.cwd === "string" ? payload.cwd : null,
    });
  }

  frame(label) {
    this.frames.push({ atMs: this.at(), label, screen: this.screen() });
  }

  async boot() {
    this.watcher.watchWorkspace(this.runtimeDir);
    this.startedPty = this.host.startTask({
      cwd: this.workspace,
      runtimeDir: this.runtimeDir,
      permissionMode: "default",
      // Production shape (runtime-controller buildStartOptions, claude branch).
      approvalBroker: true,
      sessionId: this.sessionId,
      model: null,
      rows: ROWS,
      cols: COLS,
      ...(this.extraEnv ? { extraEnv: this.extraEnv } : {}),
    });
    this.argv = this.startedPty.args;

    // The trust dialog. With the broker ON, production SUPPRESSES the native
    // approval scrape, so the walk happens on the GRID: verify the affirm row is
    // focused before CR, never a blind key (SL-1; the 2.1.252+ default row is
    // "No, exit", so a bare Enter DECLINES and exits).
    const affirmFocused = () =>
      this.screen()
        .split("\n")
        .some((line) => /❯\s*Yes, I trust this folder/i.test(line));
    let trustAnswered = false;
    const answerTrust = async () => {
      if (!/Yes, I trust this folder/i.test(this.screen())) return false;
      this.frame("trust dialog");
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

    const deadline = Date.now() + 90_000;
    let ready = false;
    while (Date.now() < deadline && !this.ptyExited) {
      if (this.host.acceptsPromptInput()) {
        ready = true;
        break;
      }
      if (!trustAnswered) trustAnswered = await answerTrust();
      await delay(200);
    }
    this.readyMs = this.at();
    this.notes.push(`ready=${ready} at ${this.readyMs}ms`);
    await delay(2500);
    this.frame("boot frame");
    return ready;
  }

  /** Type text into the composer and submit it SEPARATELY, after grid-verifying
   *  the composer actually carries it (the F41 lesson: a bare write-then-CR is
   *  assumed to have landed; a grid read knows). */
  async sendPrompt(text, { retries = 4 } = {}) {
    for (let attempt = 0; attempt <= retries; attempt++) {
      this.host.writeRaw(text);
      await delay(900);
      if (this.screen().includes(text)) {
        this.notes.push(`prompt "${text}" verified on the composer (attempt ${attempt + 1})`);
        this.host.writeRaw("\r");
        return true;
      }
      this.host.writeRaw("\x1b");
      await delay(400);
    }
    this.notes.push(`prompt "${text}" NEVER reached the composer — NOT submitted`);
    return false;
  }

  async waitUntil(predicate, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline && !this.ptyExited) {
      if (predicate()) return true;
      await delay(250);
    }
    return predicate();
  }

  async shutdown() {
    try {
      this.host.writeRaw("\x1b");
      await delay(300);
      this.host.dispose();
    } catch {
      /* best-effort */
    }
    try {
      this.watcher.dispose();
    } catch {
      /* best-effort */
    }
    try {
      this.term.dispose();
    } catch {
      /* best-effort */
    }
    await delay(500);
  }

  /** Everything the arm learned, in the shape the capture prints. */
  record(extra = {}) {
    const sessionStart = this.hooks.find((hook) => hook.event === "SessionStart") ?? null;
    const scanAtEnd = scanForSessionFile(this.sessionId);
    const fullSweep = scanCostFullSweep(this.sessionId);
    const dirFromHook = sessionStart?.transcript_path
      ? path.basename(path.dirname(sessionStart.transcript_path))
      : null;
    const dirFromScan = scanAtEnd.found ? path.basename(path.dirname(scanAtEnd.found)) : null;
    return {
      arm: this.name,
      version,
      sessionId: this.sessionId,
      cwdHandedToSpawn: this.workspace,
      cwdHandedLength: this.workspace.length,
      cwdRealpath: (() => {
        try {
          return fs.realpathSync.native(this.workspace);
        } catch {
          return null;
        }
      })(),
      extraEnv: this.extraEnv,
      configDirInSpawnEnv: process.env.CLAUDE_CONFIG_DIR ?? null,
      argvHasSessionId: Array.isArray(this.argv) ? this.argv.includes("--session-id") : null,
      readyMs: this.readyMs ?? null,
      // The two INDEPENDENT reads of the same fact.
      sessionStartHook: sessionStart,
      projectDirFromHook: dirFromHook,
      projectDirFromIdScan: dirFromScan,
      readsAgree: dirFromHook !== null && dirFromScan !== null ? dirFromHook === dirFromScan : null,
      // What Sonata's DELETED rule would have predicted, for the same cwd, in
      // both the handed and realpath forms — the coupling, quantified.
      oldRulePredictedFromHandedCwd: oldSonataRule(this.workspace),
      oldRulePredictedFromRealpath: (() => {
        try {
          return oldSonataRule(fs.realpathSync.native(this.workspace));
        } catch {
          return null;
        }
      })(),
      idScan: scanAtEnd,
      idScanFullSweepCost: fullSweep,
      hookEvents: this.hooks.map((hook) => `${hook.event}@${hook.atMs}ms`),
      notes: this.notes,
      frames: this.frames,
      ...extra,
    };
  }
}

// ─── arms ───────────────────────────────────────────────────────────────────

/** Shared tail: boot, optionally prompt, and record where the file landed. */
async function runArm(spawn, { prompt = false, promptText = "hi" } = {}) {
  const ready = await spawn.boot();
  const sessionStartSeen = await spawn.waitUntil(
    () => spawn.hooks.some((hook) => hook.event === "SessionStart"),
    20_000,
  );
  spawn.notes.push(`SessionStart hook seen: ${sessionStartSeen}`);
  // Does the transcript exist WITHOUT a turn? The answer decides whether layer 3
  // has anything to find at boot, and it is measured rather than assumed.
  const scanBeforePrompt = scanForSessionFile(spawn.sessionId);
  spawn.notes.push(
    `id scan before any prompt: ${scanBeforePrompt.found ? "FOUND" : "not found"} ` +
      `(${scanBeforePrompt.dirCount} dirs, ${scanBeforePrompt.elapsedMs.toFixed(2)}ms)`,
  );

  let turnEnded = null;
  if (prompt && ready) {
    const sent = await spawn.sendPrompt(promptText);
    if (sent) {
      turnEnded = await spawn.waitUntil(
        () => spawn.hooks.some((hook) => hook.event === "Stop"),
        180_000,
      );
      spawn.notes.push(`turn ended (Stop hook): ${turnEnded}`);
      spawn.frame("after the turn");
    }
  }
  await spawn.shutdown();
  return spawn.record({
    ready,
    scanBeforePrompt,
    promptSent: prompt && ready,
    turnEnded,
  });
}

const ARMS = {
  // S1 falsification. A valid name in the env, no CLAUDE_CONFIG_DIR, production
  // spawn shape. Static says the name is consulted only under CLAUDE_CONFIG_DIR,
  // so the file should land under the cwd slug and the variable should be inert.
  async arm1() {
    const spawn = new Spawn("arm1", {
      workspace: path.join(ROOT, "arm1", "ws"),
      extraEnv: { [ENV_KEY]: ENV_VALUE },
      prompt: true,
    });
    return runArm(spawn, { prompt: true });
  },

  // The threshold, inclusive side: a 200-character cwd should be named by the
  // plain rule, with no hash suffix.
  async arm2a() {
    const spawn = new Spawn("arm2a", {
      workspace: cwdOfLength(path.join(ROOT, "arm2a"), 200),
    });
    return runArm(spawn);
  },

  // The threshold, exclusive side: 201 characters should truncate to 200 and
  // append `-<hash>`.
  async arm2b() {
    const spawn = new Spawn("arm2b", {
      workspace: cwdOfLength(path.join(ROOT, "arm2b"), 201),
    });
    return runArm(spawn);
  },

  // The FIXTURE arm: a clearly-truncated ~300-character cwd, with a real turn so
  // the file genuinely exists on disk under the new name. The smoke's long-cwd
  // case is built from this arm's measured directory name.
  async arm2c() {
    const spawn = new Spawn("arm2c", {
      workspace: cwdOfLength(path.join(ROOT, "arm2c"), 300),
      prompt: true,
    });
    return runArm(spawn, { prompt: true });
  },

  // The realpath premise behind `claudeCwdVariants`: hand the spawn the /tmp
  // form and see which of the two slugs the CLI keys by.
  async arm4() {
    const real = path.join(ROOT, "arm4", "ws");
    fs.mkdirSync(real, { recursive: true });
    const viaSymlink = path.join(ROOT_VIA_SYMLINK, "arm4", "ws");
    const spawn = new Spawn("arm4", { workspace: viaSymlink });
    return runArm(spawn);
  },

  // Only run when arm1 surprises. A throwaway CLAUDE_CONFIG_DIR is LOGGED OUT
  // (SL-3), so this arm may never reach a composer at all — recorded as
  // inconclusive rather than dressed up as a negative.
  async arm3() {
    const configDir = path.join(ROOT, "arm3", "config");
    fs.mkdirSync(configDir, { recursive: true });
    const spawn = new Spawn("arm3", {
      workspace: path.join(ROOT, "arm3", "ws"),
      extraEnv: { [ENV_KEY]: ENV_VALUE, CLAUDE_CONFIG_DIR: configDir },
    });
    const result = await runArm(spawn);
    // The scan above looks in the REAL projects root; this arm's file, if any,
    // lands under the throwaway config dir instead.
    const throwawayRoot = path.join(configDir, "projects");
    let dirs = [];
    try {
      dirs = fs.readdirSync(throwawayRoot);
    } catch {
      /* never created */
    }
    return {
      ...result,
      throwawayProjectsRoot: throwawayRoot,
      throwawayProjectDirs: dirs,
      inconclusive: dirs.length === 0,
    };
  },
};

// ─── run ────────────────────────────────────────────────────────────────────

function resultPath(arm) {
  return path.join(RESULTS_DIR, `${arm}.json`);
}

const GUARD_HISTORY_PATH = path.join(RESULTS_DIR, "guard-history.jsonl");

function persistGuardRecord(record) {
  if (!record) return;
  const { label, mutatedByProbe, restored, changedKeys } = record;
  fs.appendFileSync(
    GUARD_HISTORY_PATH,
    `${JSON.stringify({ at: new Date().toISOString(), label, mutatedByProbe, restored, changedKeys })}\n`,
  );
}

function loadGuardHistory() {
  try {
    return fs
      .readFileSync(GUARD_HISTORY_PATH, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  } catch {
    return [];
  }
}

function loadResults() {
  const results = {};
  let files = [];
  try {
    files = fs
      .readdirSync(RESULTS_DIR)
      .filter((file) => file.endsWith(".json") && file !== "guard-self-test.json");
  } catch {
    return results;
  }
  for (const file of files) {
    try {
      results[path.basename(file, ".json")] = JSON.parse(
        fs.readFileSync(path.join(RESULTS_DIR, file), "utf8"),
      );
    } catch {
      /* skip an unreadable batch record */
    }
  }
  return results;
}

/** The verdict table. Both halves of the DELETED coupling get their own column:
 *  `claudeProjectSlug` applied to the cwd Sonata holds, and the same rule applied
 *  to its realpath (`claudeCwdVariants`). A `NO` in either column names a
 *  directory Sonata would have looked in and the CLI never wrote. */
function summaryTable(results) {
  const rows = [
    "| arm | cwd chars | project directory the CLI USED | hash suffix? | == old rule(cwd)? | == old rule(realpath)? |",
    "|---|---|---|---|---|---|",
  ];
  for (const arm of ["arm1", "arm2a", "arm2b", "arm2c", "arm4", "arm3"]) {
    const result = results[arm];
    if (!result) continue;
    const used = result.projectDirFromHook ?? result.projectDirFromIdScan ?? "<none>";
    const viaHanded = result.oldRulePredictedFromHandedCwd;
    const viaReal = result.oldRulePredictedFromRealpath;
    const hashed = used === "<none>" ? "n/a" : String(used !== viaReal && used !== viaHanded);
    const verdict = (predicted) =>
      used === "<none>" ? "n/a" : used === predicted ? "yes" : "**NO**";
    rows.push(
      `| ${arm} | ${result.cwdHandedLength} | \`${used}\` | ${hashed} | ${verdict(viaHanded)} | ${verdict(viaReal)} |`,
    );
  }
  return rows.join("\n");
}

/** The id scan's cost, per arm, in the three shapes the slice has to quote: the
 *  run's FIRST sweep (page cache cold for these inodes), a warm sweep that finds
 *  nothing (the true worst case — no early exit), and a warm sweep that hits. */
function scanCostTable(results) {
  const rows = [
    "| arm | project dirs | first sweep of the arm | warm full sweep (a MISS — worst case) | warm sweep that HITS |",
    "|---|---|---|---|---|",
  ];
  for (const [arm, result] of Object.entries(results)) {
    const sweep = result.idScanFullSweepCost ?? {};
    const hit = result.idScan?.found
      ? `${result.idScan.elapsedMs.toFixed(2)} ms (${result.idScan.statsPerformed} stats)`
      : "— (no file: this arm drove no turn)";
    rows.push(
      `| ${arm} | ${sweep.dirCount ?? "?"} | ${(result.scanBeforePrompt?.elapsedMs ?? 0).toFixed(2)} ms | ` +
        `${(sweep.elapsedMs ?? 0).toFixed(2)} ms | ${hit} |`,
    );
  }
  return rows.join("\n");
}

function renderCapture(results, endPin, guardHistory) {
  const lines = [];
  const push = (...values) => lines.push(...values);
  push(
    `# p1 — project directory naming at claude ${version} (D2 U2)`,
    ``,
    `Probe: \`p1-project-dir-name.mjs\`. Version pinned at start (\`${startPin.version}\`)`,
    `and at end (\`${endPin.version}\`${endPin.drifted ? " — **DRIFTED**" : ""}).`,
    ``,
    `Spawn env hygiene: parent keys deleted before the first spawn —`,
    `${LEAKED_PARENT_KEYS.length ? LEAKED_PARENT_KEYS.join(", ") : "(none present)"}`,
    `(U1 F70). Inherited \`CLAUDE_CONFIG_DIR\`: ${INHERITED_CONFIG_DIR === null ? "none" : "PRESENT — deleted, see note"}.`,
    ``,
    `Settings guard: ${JSON.stringify(guardHistory)}`,
    ``,
    `## Summary`,
    ``,
    summaryTable(results),
    ``,
    `## The id-anchored scan, timed over the REAL projects root`,
    ``,
    `The same shape the slice ships: one \`readdir\` of the projects root, then an`,
    `exact-path \`stat\` per project directory (no recursion, no content reads, no`,
    `naming rule). Measured here rather than estimated, because the scan replaces a`,
    `single-directory read.`,
    ``,
    scanCostTable(results),
    ``,
    `## Per-arm records`,
    ``,
  );
  for (const [arm, result] of Object.entries(results)) {
    const { frames, ...rest } = result;
    push(`### ${arm}`, ``, "```json", sanitize(JSON.stringify(rest, null, 2)), "```", ``);
    for (const frame of frames ?? []) {
      push(`#### ${arm} — ${frame.label} (@${frame.atMs}ms)`, ``, "```", sanitize(frame.screen), "```", ``);
    }
  }
  return `${lines.join("\n")}\n`;
}

async function main() {
  const argv = process.argv.slice(2);
  const captureOnly = argv.includes("--capture-only");
  const requested = argv.filter((value) => !value.startsWith("--"));

  fs.mkdirSync(RESULTS_DIR, { recursive: true });

  if (!captureOnly) {
    // A guard that has never been observed working is not a guard.
    const selfTestPath = path.join(RESULTS_DIR, "guard-self-test.json");
    fs.writeFileSync(selfTestPath, JSON.stringify({ model: "canary" }, null, 2));
    process.env.SONATA_PROBE_SETTINGS_PATH = selfTestPath;
    const selfTest = runSettingsGuardSelfTest();
    delete process.env.SONATA_PROBE_SETTINGS_PATH;
    if (selfTest.pass === false) {
      console.log(JSON.stringify({ success: false, reason: "settings guard self-test FAILED", selfTest }));
      process.exit(1);
    }

    const arms = requested.length ? requested : ["arm1", "arm2a", "arm2b", "arm2c", "arm4"];
    for (const arm of arms) {
      if (!ARMS[arm]) {
        console.log(`unknown arm: ${arm}`);
        continue;
      }
      process.stderr.write(`\n[p1] ${arm} …\n`);
      const result = await ARMS[arm]();
      fs.writeFileSync(resultPath(arm), JSON.stringify(result, null, 2));
      guard.restoreNow(arm);
      // The bracket's own audit trail, PERSISTED per arm rather than held in
      // memory: the arms are batch-runnable, so a capture assembled from a later
      // batch would otherwise report only that batch's brackets and silently
      // claim completeness it does not have (the m1 lesson).
      persistGuardRecord(guard.history().at(-1));
      process.stderr.write(
        `[p1] ${arm}: dir=${result.projectDirFromHook ?? result.projectDirFromIdScan ?? "<none>"} ` +
          `scan=${result.idScanFullSweepCost?.elapsedMs?.toFixed?.(2)}ms/${result.idScanFullSweepCost?.dirCount} dirs\n`,
      );
    }
  }

  const results = loadResults();
  const endPin = pinVersion("probe end");
  const guardOutcome = guard.restore();
  if (!captureOnly) persistGuardRecord(guardOutcome);
  const capture = renderCapture(results, endPin, {
    path: "~/.claude/settings.json",
    // Merged across every batch this results directory holds, not just this
    // process's — see persistGuardRecord.
    brackets: loadGuardHistory(),
  });
  fs.writeFileSync(path.join(OUT_DIR, "p1-project-dir-name.capture.txt"), capture);
  console.log(
    JSON.stringify(
      {
        success: !endPin.drifted,
        version,
        endVersion: endPin.version,
        versionDrift: endPin.drifted,
        arms: Object.keys(results),
        capture: "p1-project-dir-name.capture.txt",
      },
      null,
      2,
    ),
  );
  if (endPin.drifted) process.exit(2);
}

main().catch((error) => {
  guard.restore();
  console.error(error);
  process.exit(1);
});
