// M1 (2026-09 D2, slice U1) — WHICH LAUNCH CHANNEL SELECTS THE SESSION MODEL,
// and what it costs the user's durable configuration.
//
// THE QUESTION. Sonata spawns claude with `--model <alias>` today. Nothing on
// record measures whether that LAUNCH flag persists into `~/.claude/settings.json`
// (plan §S3) — F41 and F4h were both `/model` SLASH switches, which are a
// different code path and are already documented to persist. Two other channels
// could carry the same intent: the `ANTHROPIC_DEFAULT_MODEL` env var (2.1.236)
// and a `model` key in the `--settings` file Sonata already injects. The slice
// adopts whichever channel wins on FIVE pre-agreed axes (plan §U1 "Decision
// rule"):
//
//   (i)   selects the model at boot
//   (ii)  leaves `~/.claude/settings.json` untouched
//   (iii) accepts every alias in MODEL_OPTIONS
//   (iv)  outranks the user's own `settings.json` model
//   (v)   does not disturb `fastMode`
//
// Axis (iv) is the correctness axis and the reason this is not a cleanup: today a
// user whose `settings.json` says `fable` may or may not get the model Sonata's
// UI says the session is on, and nobody has measured which.
//
// METHOD. Every arm is a REAL spawn through the production `TerminalHost` from
// `dist/` — production argv, production `--settings` file, production statusline
// sink — so the only variable per arm is the channel under test. The model is
// never inferred: it is read from TWO independent channels, the boot banner on
// the reconstructed grid and the statusline payload the CLI itself writes
// (`model.display_name` + `model.id`), and where the SOURCE is the question
// (env vs the user's pin resolving to the same alias) the `/model` picker's
// attribution row (`· Set by ANTHROPIC_DEFAULT_MODEL`) is opened and read.
//
// ISOLATION IS NOT AVAILABLE (SL-3): an isolated `CLAUDE_CONFIG_DIR` is logged
// out, so these arms run against the user's REAL $HOME. That is what the settings
// guard is for — see `settings-guard.mjs` for the F41 incident it exists to
// prevent. The guard closes PER ARM here, not only per run: arm `f` deliberately
// drives a `/model` switch, and an unrestored pin would silently become the next
// arm's user default.
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
import { createSettingsGuard, diffJsonKeys, runSettingsGuardSelfTest } from "./settings-guard.mjs";

const OUT_DIR = new URL(".", import.meta.url).pathname;
const APP_DIR = new URL("../../../app/", import.meta.url).pathname;
const require = createRequire(APP_DIR + "package.json");
const { Terminal } = require("@xterm/headless");
const { TerminalHost } = require(APP_DIR + "dist/runtime");

const EXPECT_VERSION = "2.1.258";
const ROOT = "/private/tmp/sonata-sync-2026-09/default-model";
const COLS = 120;
const ROWS = 40;
const ENV_KEY = "ANTHROPIC_DEFAULT_MODEL";

// ─── sanitize BOTH username forms ───────────────────────────────────────────
// The capture is committed and the pre-push leak fence scans blob CONTENT, so
// the home path has to go in both the shapes it appears in: the literal
// `/Users/<user>` and the munged `-Users-<user>-` slug claude builds project
// directory names from.
const HOME = os.homedir();
const USER_MUNGED = `-${HOME.replace(/\//g, "-").replace(/^-/, "")}-`;
// A live Remote Control link can land on a boot frame; redact ids to a stable
// token so a capture cannot carry a working session URL (the rc-redact-sessions
// rule, applied inline here rather than as a second pass).
const SESSION_LINK_RE = /session_[A-Za-z0-9_-]{8,}/g;
const sanitize = (value) =>
  String(value)
    .split(HOME)
    .join("$HOME")
    .split(USER_MUNGED)
    .join("-$USER_MUNGED-")
    .replace(SESSION_LINK_RE, "session_<REDACTED>");

// ─── the spawn env must be PRODUCTION's, not this agent session's ───────────
// `ptyEnvironment` deletes `CLAUDECODE` and every `CLAUDE_CODE_*` key, but NOT
// the three below — and this probe is itself running inside a Claude Code
// session, which exports `CLAUDE_EFFORT=high` among others. A leaked
// `CLAUDE_EFFORT` would land in the child and move the very banner segment the
// arms read (`… with medium effort ·`). A Dock-launched Sonata has none of them,
// so removing them here makes the spawn MORE production-shaped, not less.
// Recorded, because it is also an out-of-scope observation about the scrub.
const LEAKED_PARENT_KEYS = ["CLAUDE_EFFORT", "CLAUDE_PID", "CLAUDE_PLUGIN_DATA"].filter(
  (key) => process.env[key] !== undefined,
);
for (const key of LEAKED_PARENT_KEYS) delete process.env[key];

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

// ─── MEASURED alias → display name / id, at this binary (q13/F16) ───────────
// Used only to CHECK a reading, never to produce one: every arm's model comes off
// the grid and the statusline payload. Labelled here so a drift shows up as a
// mismatch in the capture instead of a silent re-interpretation.
const ALIAS_EXPECT = {
  "opus[1m]": { display: "Opus 5 (1M context)", id: "claude-opus-5[1m]" },
  opus: { display: "Opus 5", id: "claude-opus-5" },
  fable: { display: "Fable 5.1", id: "claude-fable-5-1" },
  sonnet: { display: "Sonnet 5", id: "claude-sonnet-5" },
  haiku: { display: "Haiku 4.5", id: "claude-haiku-4-5-20251001" },
};
const MODEL_OPTION_ALIASES = ["fable", "opus[1m]", "opus", "sonnet", "haiku"];
// F18's needle: fast mode prints no receipt, so the boot frame is the channel.
// This account has no usage credits, which makes the line a RELIABLE tell that
// the injection was ACCEPTED for the resolved model (F18 arm F4 shows what
// "silently ignored" looks like: no line at all).
const FAST_LINE_RE = /Fast mode requires usage credits/;

// ─── arm g's third channel: production's `--settings` file + a `model` key ──
// The production writer is NOT modified. The arm wraps it: production writes its
// file, the wrapper adds the one key under test, so the arm measures production's
// file PLUS the channel rather than a hand-built substitute.
function installSettingsModelInjection() {
  const module = require(APP_DIR + "dist/runtime/cli-signal/claude-runtime-settings.js");
  const original = module.ensureClaudeRuntimeSettings;
  let injectModel = null;
  module.ensureClaudeRuntimeSettings = (runtimeDir, options) => {
    const settingsPath = original(runtimeDir, options);
    if (injectModel === null) return settingsPath;
    const settings = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
    settings.model = injectModel;
    fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
    return settingsPath;
  };
  return (value) => {
    injectModel = value;
  };
}
const setSettingsModel = installSettingsModelInjection();

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ─── one arm's spawn ────────────────────────────────────────────────────────

class Spawn {
  /**
   * @param {string} name        arm/leg id (also the scratch dir name)
   * @param {object} opts
   * @param {string|null} opts.model         production `--model` alias, or null
   * @param {string|null} opts.envModel      value for ANTHROPIC_DEFAULT_MODEL, or null
   * @param {string|null} opts.settingsModel `model` key injected into `--settings`, or null
   * @param {boolean}     opts.fastMode      production speedMode `fast`
   */
  constructor(
    name,
    { model = null, envModel = null, envKey = ENV_KEY, settingsModel = null, fastMode = false } = {},
  ) {
    this.name = name;
    this.t0 = Date.now();
    this.notes = [];
    this.frames = [];
    this.raw = "";
    this.ptyExited = false;
    this.channel = { model, envModel, envKey: envModel === null ? null : envKey, settingsModel, fastMode };

    const runRoot = path.join(ROOT, name);
    fs.rmSync(runRoot, { recursive: true, force: true });
    this.workspace = path.join(runRoot, "ws");
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
      taskId: `task-m1-${name}`,
      provider: "claude",
      defaultWorkspace: this.workspace,
      eventSink: (event) => this.onHostEvent(event),
    });
    // Production pins a fresh session id (runtime-controller randomUUID); it is
    // also how the statusline payload file is named, so the arm can find it.
    this.sessionId = randomUUID();
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
      this.raw += event.payload.data;
      this.term.write(event.payload.data);
      return;
    }
    if (event.type === "pty:exit") this.ptyExited = true;
  }

  frame(label) {
    this.frames.push({ atMs: this.at(), label, screen: this.screen() });
  }

  async boot() {
    setSettingsModel(this.channel.settingsModel);
    try {
      this.startedPty = this.host.startTask({
        cwd: this.workspace,
        runtimeDir: this.runtimeDir,
        permissionMode: "default",
        // Production shape (runtime-controller buildStartOptions, claude branch).
        approvalBroker: true,
        sessionId: this.sessionId,
        model: this.channel.model,
        speedMode: this.channel.fastMode ? "fast" : null,
        rows: ROWS,
        cols: COLS,
        ...(this.channel.envModel !== null
          ? { extraEnv: { [this.channel.envKey]: this.channel.envModel } }
          : {}),
      });
    } finally {
      // The injection is per-spawn: never leave it armed for the next arm.
      setSettingsModel(null);
    }
    this.argv = this.startedPty.args;
    this.settingsFile = (() => {
      try {
        return JSON.parse(
          fs.readFileSync(path.join(this.runtimeDir, "claude-runtime-settings.json"), "utf8"),
        );
      } catch {
        return null;
      }
    })();

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
    // Let the banner settle and the statusline tick at least once.
    await delay(3500);
    this.frame("boot frame");
    return ready;
  }

  /** The banner row the CLI paints under `Claude Code v…`: the model display name
   *  followed by an optional ` with <effort> effort` segment and ` · <plan>`.
   *  MEASURED shape at 2.1.258 (q15 capture, F18): `Opus 5 with medium effort ·
   *  Claude Max`. Haiku drops the effort segment (F19), so the parse takes
   *  whichever separator comes first. */
  bannerModel() {
    const lines = this.screen().split("\n");
    const at = lines.findIndex((line) => /Claude Code v\d/.test(line));
    if (at < 0 || at + 1 >= lines.length) return { row: null, model: null };
    // Strip the logo glyph block that shares the row.
    const row = lines[at + 1].replace(/^[\s▝▜█▀▛▐]*/u, "").trim();
    const match = /^(.+?)(?:\s+with\s+\S+\s+effort)?\s+·\s+/.exec(row);
    return { row, model: match ? match[1].trim() : null };
  }

  /** The statusline payload the CLI itself writes through Sonata's production
   *  sink — the second, independent read of the same fact. */
  async statuslinePayload(timeoutMs = 30_000) {
    const usageDir = path.join(this.runtimeDir, "usage");
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      let files = [];
      try {
        files = fs.readdirSync(usageDir).filter((f) => /^claude-.*\.json$/.test(f));
      } catch {
        /* not created yet */
      }
      for (const file of files) {
        try {
          const payload = JSON.parse(fs.readFileSync(path.join(usageDir, file), "utf8"));
          if (payload?.model?.display_name) {
            return {
              atMs: this.at(),
              file,
              display_name: payload.model.display_name,
              id: payload.model.id ?? null,
            };
          }
        } catch {
          /* mid-rename */
        }
      }
      if (Date.now() > deadline || this.ptyExited) return null;
      await delay(250);
    }
  }

  /** Type text into the composer and submit it SEPARATELY, after grid-verifying
   *  the composer actually carries it. F41's restore failed precisely because a
   *  bare write-then-CR was assumed to have landed and had not; a fixed sleep
   *  cannot tell the difference, a grid read can. Retries the text (never the
   *  CR) while the composer stays empty. */
  async sendSlash(text, { retries = 4 } = {}) {
    for (let attempt = 0; attempt <= retries; attempt++) {
      this.host.writeRaw(text);
      await delay(900);
      if (this.screen().includes(text)) {
        this.notes.push(`slash "${text}" verified on the composer at ${this.at()}ms (attempt ${attempt + 1})`);
        this.host.writeRaw("\r");
        return true;
      }
      // Clear whatever partially landed before retrying, so a retry cannot
      // concatenate into `/model sonnet/model sonnet`.
      this.host.writeRaw("\x1b");
      await delay(400);
    }
    this.notes.push(`slash "${text}" NEVER reached the composer — NOT submitted`);
    return false;
  }

  /**
   * Open the `/model` picker read-only and record what it says about the CURRENT
   * model and WHERE it came from (`· Set by ANTHROPIC_DEFAULT_MODEL` — the S2
   * attribution string, MEASURED here or not claimed). Leaves with Esc and
   * verifies the picker closed. NEVER sends Enter or `s`: both are switches, and
   * a switch against the real $HOME is the F41 vector.
   */
  async readPicker() {
    const landed = await this.sendSlash("/model");
    if (!landed) return { opened: false, reason: "slash never reached the composer" };
    let opened = false;
    for (let i = 0; i < 20 && !opened; i++) {
      await delay(400);
      opened = /Select model/i.test(this.screen());
      // The slash-command popup can eat the first CR by selecting the entry
      // instead of running it; one extra CR after a beat is the measured fix.
      if (!opened && i === 5) this.host.writeRaw("\r");
    }
    if (!opened) {
      this.host.writeRaw("\x1b");
      await delay(600);
      return { opened: false, reason: "picker never painted" };
    }
    this.frame("/model picker (read-only)");
    const lines = this.screen().split("\n");
    const currentRow = lines.find((line) => /✔/.test(line)) ?? null;
    const attributionRow = lines.find((line) => /·\s*Set by/i.test(line)) ?? null;
    // Esc, then VERIFY the picker is gone — an unclosed picker would make the
    // next keystroke a selection.
    let closed = false;
    for (let i = 0; i < 6 && !closed; i++) {
      this.host.writeRaw("\x1b");
      await delay(700);
      closed = !/Select model/i.test(this.screen());
    }
    this.notes.push(`picker closed by Esc: ${closed}`);
    return {
      opened: true,
      closed,
      currentRow: currentRow ? currentRow.trim() : null,
      attributionRow: attributionRow ? attributionRow.trim() : null,
      attributionSeen: Boolean(attributionRow),
      rows: lines.filter((line) => /^\s*[❯ ]\s*\d\./.test(line)).map((line) => line.trim()),
    };
  }

  /** Kill the CLI and settle, so the settings diff that follows is taken against
   *  a process that has finished writing. */
  async shutdown() {
    try {
      this.host.dispose();
    } catch {
      /* best-effort */
    }
    await delay(2500);
    try {
      this.term.dispose();
    } catch {
      /* best-effort */
    }
  }

  async record(extra = {}) {
    const statusline = await this.statuslinePayload();
    const banner = this.bannerModel();
    const screen = this.screen();
    return {
      arm: this.name,
      channel: this.channel,
      argv: this.argv ?? null,
      envKeysSet:
        this.channel.envModel !== null ? { [this.channel.envKey]: this.channel.envModel } : {},
      settingsModelKey: this.settingsFile ? (this.settingsFile.model ?? null) : null,
      settingsFastModeKey: this.settingsFile ? (this.settingsFile.fastMode ?? null) : null,
      readyMs: this.readyMs ?? null,
      bannerRow: banner.row,
      bannerModel: banner.model,
      statusline,
      fastLineOnBoot: FAST_LINE_RE.test(screen),
      ptyExited: this.ptyExited,
      notes: this.notes,
      ...extra,
    };
  }
}

/**
 * One arm's full bracket: (optionally set the user pin) → spawn → read → shut
 * down → diff the user's settings → restore. The per-arm restore is what keeps
 * arm f from poisoning arm g, and it is also what makes `pinOverride` safe.
 *
 * `pinOverride` is the CONTROL lever, and it exists because the first four arms
 * measured something the plan did not anticipate: the env channel reading back as
 * the USER's model. Two different worlds produce that reading — "the variable
 * never reached the child" and "the variable reached it and lost to the pin" —
 * and no arm run under a pin can tell them apart. Removing the pin for the
 * duration of one arm separates them. Pass `undefined` to leave the file alone
 * (the default and the shape of every arm the plan named); pass `null` to REMOVE
 * the `model` key; pass an alias to set it.
 */
async function runLeg(name, channel, drive, { pinOverride } = {}) {
  const pinChange =
    pinOverride === undefined ? null : guard.setKeyForArm("model", pinOverride);
  const legBaselineBytes = guard.currentBytes();
  const spawn = new Spawn(name, channel);
  const userModelBefore = guard.readKey("model");
  if (pinChange) spawn.notes.push(`user pin overridden for this leg: ${JSON.stringify(pinChange)}`);
  const ready = await spawn.boot();
  let driven = {};
  if (ready && drive) driven = (await drive(spawn)) ?? {};
  const record = await spawn.record({
    userSettingsModelAtSpawn: userModelBefore,
    userPinOverriddenByProbe: pinChange,
    bootReached: ready,
    ...driven,
  });
  // Axis (ii) asks what the CLI did, so the baseline is the file as the CLI
  // FOUND it — which is the snapshot for a normal leg and the overridden bytes
  // for a control leg. Diffing a control leg against the snapshot would score the
  // probe's own deliberate pin change as CLI pollution.
  const diffVsBaseline = () => {
    const now = guard.currentBytes();
    if (now === legBaselineBytes) return { checked: true, changed: false, changedKeys: [] };
    return { checked: true, changed: true, changedKeys: diffJsonKeys(legBaselineBytes, now) };
  };
  // The diff BEFORE the kill: what the live session already wrote.
  record.settingsDiffWhileLive = diffVsBaseline();
  await spawn.shutdown();
  // …and AFTER, because a CLI may flush on exit.
  record.settingsDiffAfterExit = diffVsBaseline();
  // The guard's own view stays snapshot-anchored: it is what puts the user's file
  // back, override included.
  record.settingsRestore = guard.restoreNow(name);
  record.frames = spawn.frames;
  return record;
}

// ─── the arms ───────────────────────────────────────────────────────────────

/** a — the production shape TODAY. S3: does the LAUNCH flag persist? */
const armA = () =>
  runLeg("a-flag-haiku", { model: "haiku" }, async (spawn) => ({
    picker: await spawn.readPicker(),
  }));

/** b — the env channel alone. Boot model, persistence, and the attribution row. */
const armB = () =>
  runLeg("b-env-haiku", { envModel: "haiku" }, async (spawn) => ({
    picker: await spawn.readPicker(),
  }));

/** c — precedence: flag and env disagree on purpose. */
const armC = () => runLeg("c-env-haiku-flag-sonnet", { envModel: "haiku", model: "sonnet" });

/**
 * d — axis (iii): does the env channel accept EVERY alias Sonata can send?
 *
 * RUN WITH THE USER PIN REMOVED, and that is a deliberate change from the plan's
 * arm d. Arms b and e measured the env channel reading back as the user's pinned
 * `fable` for two different env values, so under a pin the sweep would record
 * "Fable 5.1" five times and answer nothing about alias acceptance. Removing the
 * pin puts the env channel in the only condition where it is live at all, so a
 * per-alias reading means what the axis asks. The pin is restored after every
 * leg by the same guard bracket.
 *
 * Leg `d0` is the BASELINE: pin removed, nothing set at all. Without it, "the
 * alias took" and "the account default happens to be that model" are the same
 * reading.
 */
async function armD() {
  const legs = [];
  legs.push(await runLeg("d0-nopin-baseline", {}, undefined, { pinOverride: null }));
  for (const alias of MODEL_OPTION_ALIASES) {
    const slug = alias.replace(/[^a-z0-9]/gi, "-");
    legs.push(
      await runLeg(
        `d-nopin-env-${slug}`,
        { envModel: alias },
        // The attribution row is the only channel that says WHERE the model came
        // from; read it on every leg here, because with no pin the sweep is the
        // env channel's whole case.
        async (spawn) => ({ picker: await spawn.readPicker() }),
        { pinOverride: null },
      ),
    );
  }
  return { arm: "d-alias-sweep", legs };
}

/**
 * e — axis (v): `fastMode` must still reach the model the channel picked. The
 * negative control is arm d's `opus[1m]` leg (same alias, no fastMode) — F18's
 * F2/F3 pair, reproduced through a channel other than the flag.
 *
 * Two legs for the same reason arm f has two: the plan's leg (e1) runs under the
 * user's real pin, and the pin BEATS `ANTHROPIC_DEFAULT_MODEL` (arm b/d), so e1
 * measures fastMode against `fable` and cannot answer axis (v) for the channel it
 * names. e2 removes the pin so the channel is actually in effect.
 */
async function armE() {
  const legs = [];
  legs.push(await runLeg("e1-env-opus1m-fast", { envModel: "opus[1m]", fastMode: true }));
  legs.push(
    await runLeg("e2-nopin-env-opus1m-fast", { envModel: "opus[1m]", fastMode: true }, undefined, {
      pinOverride: null,
    }),
  );
  return { arm: "e-fastmode-under-env", legs };
}

/**
 * f — the F41 vector: does a mid-session `/model` still persist into the user's
 * durable default, and does the env channel change that?
 *
 * TWO legs, because arm d turned the plan's single leg into half an answer. The
 * plan's leg is `env haiku` + `/model sonnet`, and `ANTHROPIC_DEFAULT_MODEL=haiku`
 * is MEASURED inert (arm d) — so that leg's session is not env-driven at all and
 * can only report what `/model` does under the ordinary user pin. Leg f2 puts the
 * env channel genuinely IN EFFECT (an accepted alias, pin removed) and asks the
 * plan's actual question there.
 */
function driveModelSlash(alias) {
  return async (spawn) => {
    const before = await spawn.statuslinePayload();
    const submitted = await spawn.sendSlash(`/model ${alias}`);
    await delay(9000);
    spawn.frame(`after /model ${alias}`);
    const screen = spawn.screen();
    return {
      switchSubmitted: submitted,
      modelBeforeSwitch: before,
      receiptOnScreen:
        screen
          .split("\n")
          .find((line) => /Set model to|Kept model as|not found/i.test(line))
          ?.trim() ?? null,
    };
  };
}

async function armF() {
  const legs = [];
  // f1 — the plan's leg, verbatim.
  legs.push(await runLeg("f1-env-haiku-then-slash-sonnet", { envModel: "haiku" }, driveModelSlash("sonnet")));
  // f2 — the same question with the env channel actually in effect.
  legs.push(
    await runLeg("f2-nopin-env-sonnet-then-slash-haiku", { envModel: "sonnet" }, driveModelSlash("haiku"), {
      pinOverride: null,
    }),
  );
  return { arm: "f-midsession-slash-persistence", legs };
}

/** g — the third channel: production's `--settings` file plus a `model` key. */
const armG = () =>
  runLeg("g-settings-model-haiku", { settingsModel: "haiku" }, async (spawn) => ({
    picker: await spawn.readPicker(),
  }));

/**
 * h — THE CORRECTNESS AXIS (iv), stated rather than inferred. The three channels
 * run back to back against the SAME user pin, each leg asserting live what that
 * pin was at spawn time, so the head-to-head is one measurement under one
 * condition instead of a comparison across arms taken minutes apart.
 * X = the user's own `settings.json` model (the guard's snapshot value);
 * Y = `haiku`, a different alias, through each channel in turn.
 */
async function armH() {
  const legs = [];
  legs.push(await runLeg("h1-user-vs-env", { envModel: "haiku" }, async (spawn) => ({
    picker: await spawn.readPicker(),
  })));
  legs.push(await runLeg("h2-user-vs-settings", { settingsModel: "haiku" }));
  legs.push(await runLeg("h3-user-vs-flag", { model: "haiku" }));
  return { arm: "h-user-default-vs-channels", userPinX: guard.readKey("model"), legs };
}

/**
 * i — the OTHER env variable, added after arms b/e measured `ANTHROPIC_DEFAULT_MODEL`
 * losing. The 2.1.236 changelog contrasts the two by name — "sets the model new
 * sessions start on, while a `/model` pick still overrides it and persists across
 * restarts (unlike `ANTHROPIC_MODEL`)" — which says `ANTHROPIC_MODEL` is the
 * HARDER of the pair. The slice's own table names the fact as "`ANTHROPIC_DEFAULT_MODEL`
 * (or the measured better channel)", so leaving the harder sibling unmeasured
 * would report "env loses" when only half of env had been tried.
 *
 * Two legs: against the user's real pin (the axis-iv question), and — only if
 * that is ambiguous — the same value with the pin removed.
 */
async function armI() {
  const legs = [];
  legs.push(
    await runLeg("i1-anthropic-model-haiku", { envModel: "haiku", envKey: "ANTHROPIC_MODEL" }, async (spawn) => ({
      picker: await spawn.readPicker(),
    })),
  );
  legs.push(
    await runLeg(
      "i2-nopin-anthropic-model-opus1m",
      { envModel: "opus[1m]", envKey: "ANTHROPIC_MODEL" },
      undefined,
      { pinOverride: null },
    ),
  );
  return { arm: "i-anthropic-model-env", legs };
}

/**
 * j — the FULL profile of `ANTHROPIC_MODEL`, run because arm i measured it doing
 * the two things `ANTHROPIC_DEFAULT_MODEL` could not: selecting `haiku` at all,
 * and outranking the user's pin. A channel that clears axes (i), (ii) and (iv)
 * has to be taken through the remaining axes before it can be adopted OR
 * dismissed — and, above all, through the question the 2.1.236 changelog raises
 * by name ("…persists across restarts (unlike `ANTHROPIC_MODEL`)"): whether it
 * makes the mid-session `/model` pick STOP writing the user's default. That is
 * the plan's own fork condition — "if env makes `/model` non-persisting, that IS
 * the pollution fix and U1 takes it" — so it cannot be left unmeasured.
 *
 * The legs run WITH the user's real pin in place: that is production's condition,
 * and it is the condition under which the answer matters.
 */
async function armJ() {
  const legs = [];
  // (iii) — every alias Sonata can send, against a live user pin of `fable`.
  for (const alias of MODEL_OPTION_ALIASES) {
    const slug = alias.replace(/[^a-z0-9]/gi, "-");
    legs.push(
      await runLeg(`j-am-${slug}`, { envModel: alias, envKey: "ANTHROPIC_MODEL" }, async (spawn) => ({
        picker: await spawn.readPicker(),
      })),
    );
  }
  // (v) — fastMode still reaches the model this channel selected (F18's needle).
  legs.push(
    await runLeg("j-am-opus1m-fast", { envModel: "opus[1m]", envKey: "ANTHROPIC_MODEL", fastMode: true }),
  );
  // Precedence against the incumbent flag.
  legs.push(
    await runLeg("j-am-haiku-flag-sonnet", { envModel: "haiku", envKey: "ANTHROPIC_MODEL", model: "sonnet" }),
  );
  // THE POLLUTION QUESTION: does a mid-session `/model` still write the user's
  // durable default when this channel is the one in effect?
  legs.push(
    await runLeg(
      "j-am-haiku-then-slash-sonnet",
      { envModel: "haiku", envKey: "ANTHROPIC_MODEL" },
      driveModelSlash("sonnet"),
    ),
  );
  return { arm: "j-anthropic-model-profile", legs };
}

/**
 * k — the last cell of the precedence matrix: the `--settings` `model` key against
 * the `--model` flag. Arms a/c/g pin flag-vs-env and each channel against the user
 * pin; without this leg the matrix would still have to GUESS which of Sonata's two
 * viable channels wins if both were ever emitted, and "both emitted" is exactly
 * the state a half-finished migration produces.
 */
const armK = () => runLeg("k-settings-haiku-flag-sonnet", { settingsModel: "haiku", model: "sonnet" });

/**
 * m — the two cells the matrix would otherwise have to leave ambiguous, closed.
 *
 * A channel's alias is only MEASURED as accepted when the reading cannot also be
 * explained by the model the CLI would have chosen anyway. Two legs elsewhere
 * fail that test: the `--settings model` sweep was run for `haiku` only (arm g),
 * and `ANTHROPIC_MODEL=fable` (arm j) resolved to the same `Fable 5.1` this
 * account's pin already names. The fix is one CONTROL VALUE: the user pin is set
 * to an alias that appears nowhere in the legs, so every reading here is either
 * that control (channel ignored) or the alias under test (channel accepted).
 * `haiku` is the control precisely because arm d proved it is the alias the weak
 * env channel drops — a leg that reads `Haiku 4.5` here is unmistakable.
 */
const M_CONTROL_PIN = "haiku";
async function armM() {
  const legs = [];
  for (const alias of ["fable", "opus[1m]", "opus", "sonnet"]) {
    const slug = alias.replace(/[^a-z0-9]/gi, "-");
    legs.push(
      await runLeg(`m-settings-${slug}`, { settingsModel: alias }, undefined, {
        pinOverride: M_CONTROL_PIN,
      }),
    );
  }
  legs.push(
    await runLeg("m-am-fable-vs-haiku-pin", { envModel: "fable", envKey: "ANTHROPIC_MODEL" }, undefined, {
      pinOverride: M_CONTROL_PIN,
    }),
  );
  // Axis (v) for the `--settings model` channel: the last empty cell. Same
  // control pin, so the fast line can only be attributed to the model this
  // channel selected.
  legs.push(
    await runLeg("m-settings-opus1m-fast", { settingsModel: "opus[1m]", fastMode: true }, undefined, {
      pinOverride: M_CONTROL_PIN,
    }),
  );
  return { arm: "m-ambiguous-cells-closed", controlPin: M_CONTROL_PIN, legs };
}

/**
 * n — the one axis-(iii) cell the INCUMBENT channel could not cite. Review of
 * this slice caught the citation for `--model`'s alias coverage pointing at
 * F16/q13 (which measured the mid-session SLASH channel, not the launch flag)
 * and at s2 (a slash-command-NAME probe, unrelated to model aliases). The real
 * record for the flag is: `haiku`/`sonnet` here, `opus`/`opus[1m]` at q15/F18 —
 * and `fable` nowhere. One leg closes it rather than shipping an INFERRED cell
 * for the channel the slice decided to KEEP.
 *
 * The control pin matters: this account's own pin IS `fable`, so `--model fable`
 * read against it would be unattributable. Same device as arm m — pin set to an
 * alias appearing in no leg here.
 */
const armN = () =>
  runLeg("n-flag-fable-vs-haiku-pin", { model: "fable" }, undefined, { pinOverride: M_CONTROL_PIN });

const ARMS = {
  "a-flag-haiku": armA,
  "b-env-haiku": armB,
  "c-env-haiku-flag-sonnet": armC,
  "d-alias-sweep": armD,
  "e-fastmode-under-env": armE,
  "f-midsession-slash-persistence": armF,
  "g-settings-model-haiku": armG,
  "h-user-default-vs-channels": armH,
  "i-anthropic-model-env": armI,
  "j-anthropic-model-profile": armJ,
  "k-settings-haiku-flag-sonnet": armK,
  "m-ambiguous-cells-closed": armM,
  "n-flag-fable-vs-haiku-pin": armN,
};

// ─── run ────────────────────────────────────────────────────────────────────
const RESULT_DIR = path.join(ROOT, "results");
fs.mkdirSync(RESULT_DIR, { recursive: true });

// A guard that has never been observed working is not a guard: prove the bracket
// against a THROWAWAY file before the first spawn touches the real one.
const selfTestFile = path.join(ROOT, "guard-self-test.json");
fs.writeFileSync(selfTestFile, `${JSON.stringify({ model: "fable", canary: true }, null, 2)}\n`);
const selfTest = runSettingsGuardSelfTest(createSettingsGuard({ settingsPath: selfTestFile }));
process.stderr.write(`[settings guard self-test] pass=${selfTest.pass}\n`);
if (selfTest.pass !== true) {
  console.log(JSON.stringify({ success: false, reason: "settings-guard self-test FAILED", selfTest }, null, 2));
  process.exit(2);
}
if (process.argv.includes("--self-test")) {
  console.log(JSON.stringify({ selfTest, realGuard: { path: guard.path, hasSnapshot: Boolean(guard.snapshot) } }, null, 2));
  process.exit(0);
}

// Fourteen live spawns do not fit in one interactive shell window, so the arms
// run in BATCHES and the capture is assembled from what is on disk
// (`--capture-only`). Each batch persists its own guard history next to its
// results, and the assembly merges them in chronological order — so the
// committed capture reports every bracket the run performed, not just the last
// batch's. Selecting arms is the same argument either way.
const HISTORY_PREFIX = "guard-history-";
const only = process.argv.slice(2).filter((arg) => !arg.startsWith("-"));
const captureOnly = process.argv.includes("--capture-only");
const selected = captureOnly ? [] : only.length > 0 ? only : Object.keys(ARMS);

try {
  for (const name of selected) {
    const arm = ARMS[name];
    if (!arm) {
      console.error(`unknown arm: ${name}`);
      process.exitCode = 2;
      continue;
    }
    process.stderr.write(`\n=== ${name} ===\n`);
    let result;
    try {
      result = await arm();
    } catch (error) {
      result = { arm: name, error: String(error?.stack ?? error) };
    }
    result.ranAt = new Date().toISOString();
    fs.writeFileSync(path.join(RESULT_DIR, `${name}.json`), JSON.stringify(result, null, 2));
    const legs = result.legs ?? [result];
    for (const leg of legs) {
      process.stderr.write(
        `${leg.arm}: banner=${leg.bannerModel ?? "?"} statusline=${leg.statusline?.display_name ?? "?"} settingsChanged=${leg.settingsDiffAfterExit?.changed ?? "?"}\n`,
      );
    }
  }
} finally {
  // UNCONDITIONAL: a thrown arm, a failed boot, or a clean run all leave the
  // user's real `~/.claude/settings.json` exactly as it was found.
  guard.restore();
  if (!captureOnly) {
    fs.writeFileSync(
      path.join(RESULT_DIR, `${HISTORY_PREFIX}${Date.now()}.json`),
      JSON.stringify({ batch: selected, history: guard.history() }, null, 2),
    );
  }
}

const endPin = pinVersion("probe end");

const results = Object.keys(ARMS)
  .map((name) => path.join(RESULT_DIR, `${name}.json`))
  .filter((file) => fs.existsSync(file))
  .map((file) => JSON.parse(fs.readFileSync(file, "utf8")));
const allLegs = results.flatMap((result) => result.legs ?? [result]).filter((leg) => leg.arm);
const guardHistory = fs
  .readdirSync(RESULT_DIR)
  .filter((file) => file.startsWith(HISTORY_PREFIX))
  .sort()
  .flatMap((file) => JSON.parse(fs.readFileSync(path.join(RESULT_DIR, file), "utf8")).history);

const capture = [
  "# M1 — which launch channel selects the claude session model (D2 slice U1)",
  "",
  `binary: ${version}${endPin.drifted ? ` — DRIFTED to ${endPin.version} at probe end; capture SAVED, exit non-zero` : " (re-pinned at probe end)"}`,
  "spawn: production TerminalHost from dist/, --permission-mode default, broker on, injected --settings",
  `env keys removed from the PARENT before spawning (agent-session leak, see header): ${LEAKED_PARENT_KEYS.join(", ") || "(none)"}`,
  `settings-guard self-test (throwaway file, before any spawn): pass=${selfTest.pass}`,
  "",
  "## the reading, per leg",
  "",
  "`flag` = production `--model` · `env` = the env key the leg set · `settings` = a `model` key added to the injected `--settings`.",
  "`user pin` is `~/.claude/settings.json`'s own `model`, READ LIVE at spawn. `(probe-set)` marks a CONTROL leg where the guard deliberately changed or removed the pin for that leg only and restored the snapshot straight after — the value shown is what the CLI actually read.",
  "",
  [
    "| leg | flag | env | settings | user pin | banner says | statusline display_name | statusline id | settings.json changed | fast line |",
    "|---|---|---|---|---|---|---|---|---|---|",
    ...allLegs.map((leg) =>
      [
        leg.arm,
        leg.channel?.model ?? "—",
        leg.channel?.envModel ? `${leg.channel.envKey}=${leg.channel.envModel}` : "—",
        leg.channel?.settingsModel ?? "—",
        leg.userPinOverriddenByProbe
          ? `${leg.userSettingsModelAtSpawn ?? "(no model key)"} (probe-set)`
          : (leg.userSettingsModelAtSpawn ?? "—"),
        leg.bannerModel ?? "—",
        leg.statusline?.display_name ?? "—",
        leg.statusline?.id ?? "—",
        leg.settingsDiffAfterExit?.changed ? `**YES** — ${(leg.settingsDiffAfterExit.changedKeys ?? []).join("; ")}` : "no",
        leg.fastLineOnBoot ? "present" : "absent",
      ].join(" | "),
    ).map((row) => `| ${row} |`),
  ].join("\n"),
  "",
  "## alias fidelity — did the channel deliver the alias it was handed?",
  "",
  "Computed against the MEASURED alias→display/id table at this binary (F16/q13),",
  "which is why `ALIAS_EXPECT` exists: a reading is only evidence for axis (iii) if",
  "it can be CHECKED, and a drift in that table has to surface as a mismatch here",
  "rather than be silently re-interpreted. `requested` is the alias the leg's",
  "highest-precedence channel asked for (flag > settings/env, MEASURED arms c/k/j).",
  "",
  "READ THE THREE `/model` LEGS WITH CARE: `f1`, `f2` and `j-am-haiku-then-slash-sonnet`",
  "deliberately switch model MID-SESSION, and the id here is read at the END of the leg,",
  "so their `NOT delivered` is the switch landing, not the launch channel failing. `f1`",
  "IS additionally a genuine channel failure (its `ANTHROPIC_DEFAULT_MODEL=haiku` was",
  "already inert before the switch — see `b`/`d-nopin-env-haiku`, same value, no switch).",
  "",
  [
    "| leg | channel | requested | expected id | observed id | verdict |",
    "|---|---|---|---|---|---|",
    ...allLegs
      .map((leg) => {
        const channel = leg.channel ?? {};
        const requested = channel.model ?? channel.settingsModel ?? channel.envModel ?? null;
        if (!requested) return null;
        const via = channel.model ? "--model" : channel.settingsModel ? "--settings model" : channel.envKey;
        const expect = ALIAS_EXPECT[requested];
        const observed = leg.statusline?.id ?? null;
        const verdict = !expect
          ? "no MEASURED row for this alias"
          : observed === expect.id
            ? "delivered"
            : `**NOT delivered** — channel did not select this alias`;
        return `| ${leg.arm} | ${via} | \`${requested}\` | ${expect?.id ?? "—"} | ${observed ?? "—"} | ${verdict} |`;
      })
      .filter(Boolean),
  ].join("\n"),
  "",
  "## user-settings guard",
  "",
  "Every bracket from every BATCH THAT WROTE A HISTORY FILE, in order —",
  "which is every batch except the first trial run, taken before this probe grew",
  "its batch/assembly split. That run's single leg keeps its own bracket record in",
  "its per-arm JSON below (`settingsRestore`); it is not lost, just not merged here.",
  "`mutatedByProbe` is the honest record of which legs moved the user's real file;",
  "`restored` is whether the bytes came back.",
  "",
  "```json",
  JSON.stringify(guardHistory, null, 2),
  "```",
  "",
  "## per-arm detail",
  "",
  ...results.map((result) =>
    [`### ${result.arm ?? "?"}`, "", "```json", sanitize(JSON.stringify(result, null, 2)), "```", ""].join("\n"),
  ),
  "",
  "## frames",
  "",
  ...allLegs.flatMap((leg) =>
    (leg.frames ?? []).map((frame) =>
      [`===== ${leg.arm} — ${frame.label} (@${frame.atMs}ms) =====`, sanitize(frame.screen), ""].join("\n"),
    ),
  ),
].join("\n");

fs.writeFileSync(path.join(OUT_DIR, "m1-default-model-channel.capture.txt"), sanitize(capture));

console.log(
  JSON.stringify(
    {
      success: results.every((r) => !r.error) && !endPin.drifted,
      version,
      endVersion: endPin.version,
      versionDrift: endPin.drifted,
      legs: allLegs.map((leg) => ({
        arm: leg.arm,
        channel: leg.channel,
        userPin: leg.userSettingsModelAtSpawn,
        banner: leg.bannerModel,
        statusline: leg.statusline?.display_name ?? null,
        statuslineId: leg.statusline?.id ?? null,
        settingsChanged: leg.settingsDiffAfterExit?.changed ?? null,
        changedKeys: leg.settingsDiffAfterExit?.changedKeys ?? [],
        fastLine: leg.fastLineOnBoot,
        attribution: leg.picker?.attributionRow ?? null,
        pickerCurrent: leg.picker?.currentRow ?? null,
      })),
      userSettingsGuard: {
        final: guard.outcome(),
        mutatingArms: guardHistory.filter((h) => h.mutatedByProbe).map((h) => h.label),
      },
    },
    null,
    2,
  ),
);
if (endPin.drifted) process.exit(3);
