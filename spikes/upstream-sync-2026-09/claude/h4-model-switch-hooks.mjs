// H4 (2026-09 sync, D2 U3) — can the `PostModelSwitch` HOOK replace the receipt
// SCRAPE as the model-axis confirm, and what does the picker's `s` key do?
//
// QUESTION 1 (the slice). Sonata confirms a mid-session `/model` switch by
// scraping `⎿ Set model to …` out of a 4096-char rolling pty window. F19 measured
// that a banner-reshaping switch REPLAYS the whole transcript through that window,
// so the window can carry someone ELSE's receipt; the failure needle was anchored
// on the pending alias, the SUCCESS needle could not be (the receipt names the
// model's DISPLAY label, not the alias) and was pinned as a KNOWN RESIDUAL, and
// `claudeCacheMissCancelled` (F22) has the same shape on the cancel axis. F35
// measured a structured `PreModelSwitch`/`PostModelSwitch` pair whose
// `requested_model` IS the alias Sonata typed — i.e. a channel that can be matched
// byte-for-byte against `pending.value`. This probe asks whether that pair is
// reliable, idempotent-able, and FAST ENOUGH to be the primary settle.
//
// QUESTION 2 (the F68 ruling). U1 measured that every mid-session `/model <alias>`
// writes the user's durable `~/.claude/settings.json` default. The CLI's own
// session-scoped affordance is the `/model` picker's `s` key ("for this session
// only", F16). Arm `g` measures that path end to end — receipt wording, both hook
// payloads, whether settings.json moves, whether a cache-miss dialog still appears
// — so candidate slice U4 can be planned off this capture alone.
//
// METHOD, and what is production-shaped in it:
//   - a real `TerminalHost` from `dist/` with Sonata's own argv, the PRODUCTION
//     `ensureClaudeRuntimeSettings` writer and the PRODUCTION `hook-sink.js`
//     command. The ONLY variable is that a probe-local wrapper LAYERS
//     `PreModelSwitch`/`PostModelSwitch` onto the settings file the production
//     writer just wrote (h1's pattern). The production `INJECTED_HOOK_EVENTS`
//     list is NOT edited — measuring must not require shipping.
//   - the verdicts are taken with the SHIPPED parser: every arm replays its own
//     post-arm pty chunks through `parseClaudeControlReceipt` /
//     `claudeCacheMissDialogOpen` / `claudeCacheMissCancelled` over the shipped
//     `CONTROL_SWITCH_SCAN_LIMIT` window, one chunk at a time, first verdict wins
//     — the production arming shape. So "the receipt arrived at +N ms" means "the
//     engine would have settled at +N ms", not "a string appeared somewhere".
//   - hook ARRIVAL is measured at the SINK, not at the watcher: the sink's file
//     name embeds `Date.now().toString(36)` at the moment it wrote (hook-sink.ts),
//     which is the instant the CLI's hook fired. The probe polls the sink dir at
//     25 ms (its own reader, the same read-then-delete protocol `HookWatcher`
//     uses) so the poll interval does not dominate the measurement. Production's
//     `HookWatcher` polls at 250 ms (`DEFAULT_POLL_MS`), so production delivery is
//     the sink time plus [0, 250] ms — stated in the capture rather than folded
//     into the numbers, because those are two different facts.
//
// USER-STATE FENCE. Every arm here drives `/model`, and F68 measured 3/3 that a
// mid-session `/model` REWRITES `~/.claude/settings.json`'s `model` key (and
// CREATES it when absent). The shared `settings-guard.mjs` bracket is therefore
// mandatory and closes PER ARM, not per run: an unrestored pin would silently
// become the next arm's control variable. The guard is self-tested against a
// throwaway file before the first spawn.
//
// Scratch dirs are /private/tmp/... (never the agent scratchpad, whose path embeds
// the username): these frames become findings and the pre-push leak fence scans
// blob content.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { createHash } from "node:crypto";
import { createSettingsGuard, diffJsonKeys, runSettingsGuardSelfTest } from "./settings-guard.mjs";

const OUT_DIR = new URL(".", import.meta.url).pathname;
const APP_DIR = new URL("../../../app/", import.meta.url).pathname;
const require = createRequire(APP_DIR + "package.json");
const { Terminal } = require("@xterm/headless");
const {
  TerminalHost,
  claudeHooksDirectory,
  parseClaudeControlReceipt,
  claudeCacheMissDialogOpen,
  claudeCacheMissCancelled,
  parseClaudeCacheMissCursor,
  CONTROL_SWITCH_SCAN_LIMIT,
} = require(APP_DIR + "dist/runtime");

/**
 * The version this probe's RECORD is about. The pin is a constant, not an
 * argument, for the reason the program has re-learned twice: a probe that can be
 * pointed at any binary silently measures whichever one happened to be installed.
 *
 * SPOT-CHECK MODE is the one deliberate exception, and it is one switch rather
 * than three so it cannot be assembled accidentally. Setting
 * `SONATA_PROBE_SPOTCHECK_VERSION=<v>` re-points the pin AND redirects both
 * artifacts — results to `results-<v>/`, the capture to
 * `h4-model-switch-hooks.spotcheck-<v>.capture.txt` — so the 2.1.258 record can
 * never be overwritten by a run that is not about 2.1.258. It exists because the
 * binary moved to 2.1.259 minutes after this slice's last arm, and shipping a
 * confirm channel that rests on ONE payload field without checking that field
 * still exists on the version the user's machine actually runs would be an
 * unverified assumption in the load-bearing place.
 */
const PINNED_VERSION = "2.1.258";
const SPOTCHECK_VERSION = process.env.SONATA_PROBE_SPOTCHECK_VERSION || null;
const EXPECT_VERSION = SPOTCHECK_VERSION ?? PINNED_VERSION;
const ROOT = "/private/tmp/sonata-sync-2026-09/model-switch-hooks";
const RESULT_DIR = path.join(ROOT, SPOTCHECK_VERSION ? `results-${SPOTCHECK_VERSION}` : "results");
const CAPTURE_NAME = SPOTCHECK_VERSION
  ? `h4-model-switch-hooks.spotcheck-${SPOTCHECK_VERSION}.capture.txt`
  : "h4-model-switch-hooks.capture.txt";
const COLS = 120;
const ROWS = 40;
/** Production's `HookWatcher` poll interval — quoted, not used (see the header). */
const PRODUCTION_HOOK_POLL_MS = 250;
/** This probe's own sink poll. Fast enough that the sampling error is small
 *  against the millisecond deltas the slice's decision turns on. */
const PROBE_HOOK_POLL_MS = 25;
/** How long the trust dialog gets to be recognized by the host's own approval
 *  SCRAPE before the arm falls back to walking it off the grid. See `boot()` —
 *  the scrape is what clears `approvalActive`, so losing this race costs the
 *  whole arm. */
const TRUST_SCRAPE_GRACE_MS = 12_000;

const HOME = os.homedir();
const USER_MUNGED = `-${HOME.replace(/\//g, "-").replace(/^-/, "")}-`;
const sanitize = (value) =>
  String(value)
    .split(HOME)
    .join("$HOME")
    .split(USER_MUNGED)
    .join("-$USER_MUNGED-")
    .replace(/https:\/\/claude\.ai\/\S+/g, "https://claude.ai/<redacted>");

function pinVersion(where) {
  const version = execFileSync("claude", ["--version"], { encoding: "utf8" }).trim();
  // SL-4 method note: an END drift must not DISCARD a completed capture. Record
  // the drift, let the caller save, exit non-zero afterwards.
  return { where, version, drifted: !version.startsWith(EXPECT_VERSION) };
}
const startPin = pinVersion("probe start");
if (startPin.drifted) {
  console.log(
    JSON.stringify({
      success: false,
      reason: `binary moved off ${EXPECT_VERSION} at start`,
      version: startPin.version,
    }),
  );
  process.exit(2);
}
const version = startPin.version;

// ─── the settings bracket ───────────────────────────────────────────────────
const guard = createSettingsGuard();
const GUARD_HISTORY_FILE = path.join(RESULT_DIR, `guard-history-${Date.now()}.json`);

// ─── probe-local hook injection (production list untouched) ─────────────────
// The two events this slice is about are NOT in production's
// `INJECTED_HOOK_EVENTS` — taking them there is the PATCH, and a probe that
// required the patch to exist could not measure whether the patch is a good idea.
// So the wrapper adds them to the file the production writer just produced,
// reusing production's own sink command, and never overrides a production entry.
const PROBE_EXTRA_EVENTS = ["PreModelSwitch", "PostModelSwitch"];
/** Which of `PROBE_EXTRA_EVENTS` the wrapper actually had to ADD, as opposed to
 *  finding already written by production. It matters, and it changed under this
 *  probe's feet: once D2 U3 took `PostModelSwitch` into `INJECTED_HOOK_EVENTS`, a
 *  run against the patched `dist/` gets that entry from PRODUCTION and the wrapper
 *  layers only `PreModelSwitch` — which is what turns the spot-check from "the
 *  payload still exists" into "production's own entry delivered it". Recorded per
 *  run rather than assumed, because the honest claim depends on it. */
const layeredEvents = new Set();
const productionEvents = new Set();

function installHookInjection() {
  const module = require(APP_DIR + "dist/runtime/cli-signal/claude-runtime-settings.js");
  const original = module.ensureClaudeRuntimeSettings;
  module.ensureClaudeRuntimeSettings = (runtimeDir, options) => {
    const settingsPath = original(runtimeDir, options);
    const settings = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
    const sinkCommand = settings.hooks.Stop[0].hooks[0].command;
    for (const event of PROBE_EXTRA_EVENTS) {
      if (settings.hooks[event]) {
        productionEvents.add(event);
        continue;
      }
      layeredEvents.add(event);
      // Neither event is tool-scoped, so both take a bare entry — production's own
      // convention (`MATCHER_EVENTS` in claude-runtime-settings).
      settings.hooks[event] = [{ hooks: [{ type: "command", command: sinkCommand }] }];
    }
    fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
    return settingsPath;
  };
}
installHookInjection();

// ─── payload rendering ──────────────────────────────────────────────────────
/** Ids are redacted but must stay COMPARABLE: the first question the double-`Pre`
 *  raises is whether two payloads belong to the same session and the same prompt.
 *  A truncated digest answers that without putting the id in a committed file. */
const HASHED_ID_KEYS = new Set(["session_id", "prompt_id", "turn_id", "tool_use_id", "agent_id", "uuid"]);
/** Paths carry the username; only their length is recorded. */
const LENGTH_ONLY_KEYS = new Set(["transcript_path", "cwd", "scratchpad_dir"]);
const shortHash = (value) =>
  createHash("sha256").update(String(value)).digest("hex").slice(0, 8);

/** A payload rendered for the record: every key, values kept where they ARE the
 *  evidence (the whole point here is `requested_model` / `to_model` / `source`)
 *  and elided where they are an id or a path. */
function renderPayload(payload) {
  const out = {};
  for (const [key, raw] of Object.entries(payload)) {
    if (HASHED_ID_KEYS.has(key)) {
      out[key] = typeof raw === "string" ? `<${key}:sha8 ${shortHash(raw)}>` : raw;
      continue;
    }
    if (LENGTH_ONLY_KEYS.has(key)) {
      out[key] = typeof raw === "string" ? `<${key}:${raw.length}ch>` : raw;
      continue;
    }
    if (typeof raw === "string") {
      out[key] = sanitize(raw.length > 220 ? `${raw.slice(0, 220)}…[${raw.length}ch]` : raw);
      continue;
    }
    if (raw && typeof raw === "object") {
      const json = sanitize(JSON.stringify(raw));
      out[key] = json.length > 400 ? `${json.slice(0, 400)}…[${json.length}ch]` : json;
      continue;
    }
    out[key] = raw;
  }
  return out;
}

/** The identity of a ModelSwitch payload for byte-stability comparison. Paths are
 *  dropped (they are constant per session and carry the username); the session and
 *  prompt ids are KEPT as digests, because "are these two fires the same session
 *  and the same prompt?" is the first question a duplicate raises. */
function switchIdentity(payload) {
  const copy = { ...payload };
  for (const key of LENGTH_ONLY_KEYS) delete copy[key];
  for (const key of HASHED_ID_KEYS) {
    if (typeof copy[key] === "string") copy[key] = shortHash(copy[key]);
  }
  return JSON.stringify(Object.fromEntries(Object.entries(copy).sort(([a], [b]) => (a < b ? -1 : 1))));
}

const stripAnsi = (value) =>
  String(value)
    // eslint-disable-next-line no-control-regex
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "")
    // eslint-disable-next-line no-control-regex
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "")
    // eslint-disable-next-line no-control-regex
    .replace(/\x1b[()][A-Za-z0-9]/g, "")
    // eslint-disable-next-line no-control-regex
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, "");

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ─── harness ────────────────────────────────────────────────────────────────

class Session {
  constructor(name, { model = null, reasoningEffort = null } = {}) {
    this.name = name;
    this.t0 = Date.now();
    /** Every hook the SINK wrote, timestamped at the sink (see the header). */
    this.hooks = [];
    /** Every pty chunk with the ms it arrived — the substrate every receipt
     *  replay below runs over. */
    this.chunks = [];
    this.events = [];
    this.notes = [];
    this.frames = [];
    this.ptyExited = false;
    this.seenHookFiles = new Set();

    const runRoot = path.join(ROOT, name);
    fs.rmSync(runRoot, { recursive: true, force: true });
    this.workspace = path.join(runRoot, "ws");
    this.runtimeDir = path.join(runRoot, "runtime");
    fs.mkdirSync(this.workspace, { recursive: true });
    fs.mkdirSync(this.runtimeDir, { recursive: true });
    // A git repo is the production shape (Sonata tasks run in one), and the trust
    // dialog's wording differs between a repo and a bare dir (q3).
    try {
      execFileSync("git", ["init", "-q"], { cwd: this.workspace, stdio: "ignore" });
    } catch {
      this.notes.push("git init failed — workspace is a plain directory");
    }

    this.term = new Terminal({ cols: COLS, rows: ROWS, allowProposedApi: true, scrollback: 4000 });
    this.host = new TerminalHost({
      taskId: `task-h4-${name}`,
      provider: "claude",
      defaultWorkspace: this.workspace,
      eventSink: (event) => this.onHostEvent(event),
    });
    this.launchModel = model;
    this.launchEffort = reasoningEffort;
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

  frame(label) {
    this.frames.push({ atMs: this.at(), label, screen: sanitize(this.screen()) });
  }

  onHostEvent(event) {
    if (event.type === "pty:data") {
      this.chunks.push({ atMs: this.at(), data: event.payload.data });
      this.term.write(event.payload.data);
      return;
    }
    if (event.type === "report:updated" || event.type === "file:changed" || event.type === "run:updated") {
      return;
    }
    if (event.type === "pty:exit") this.ptyExited = true;
    this.events.push({
      atMs: this.at(),
      type: event.type,
      // The approval KIND is kept because the boot ceremony branches on it: a
      // native-approval spawn scrapes the workspace-trust dialog and sets
      // `approvalActive`, and a dialog answered off the grid leaves that flag up —
      // which is what `acceptsPromptInput` refuses on. `sendApprove` is the path
      // that clears it, so the trust answer must prefer it when it is offered.
      kind: event.payload?.kind ?? null,
    });
  }

  /**
   * The probe's own sink reader. Deliberately NOT the production `HookWatcher`:
   * the watcher hands over a payload with no filename, and the FILENAME is the
   * measurement (`hook-<Date.now() base36>-…`), i.e. the instant the CLI fired the
   * hook rather than the instant a 250 ms poll noticed. Same read-then-delete
   * protocol, so the sink dir stays a queue.
   */
  pollHooks() {
    const dir = claudeHooksDirectory(this.runtimeDir);
    let entries;
    try {
      entries = fs.readdirSync(dir);
    } catch {
      return;
    }
    for (const entry of entries.filter((e) => /^hook-.+\.json$/.test(e)).sort()) {
      if (this.seenHookFiles.has(entry)) continue;
      const filePath = path.join(dir, entry);
      let payload;
      try {
        payload = JSON.parse(fs.readFileSync(filePath, "utf8"));
      } catch {
        continue; // mid-rename; the next poll gets it
      }
      this.seenHookFiles.add(entry);
      const stamp = /^hook-([0-9a-z]+)-/.exec(entry);
      const sinkWallMs = stamp ? Number.parseInt(stamp[1], 36) : null;
      this.hooks.push({
        event: typeof payload.hook_event_name === "string" ? payload.hook_event_name : "<none>",
        // Sink-side time (the hook FIRED); falls back to observation time if the
        // filename ever stops carrying it.
        atMs: sinkWallMs !== null ? sinkWallMs - this.t0 : this.at(),
        observedAtMs: this.at(),
        sinkStamped: sinkWallMs !== null,
        keys: Object.keys(payload).sort(),
        identity: switchIdentity(payload),
        payload: renderPayload(payload),
      });
      try {
        fs.unlinkSync(filePath);
      } catch {
        /* best effort */
      }
      if (this.hooks[this.hooks.length - 1].event === "SessionStart") {
        this.host.noteHookSessionStart();
      }
      if (this.hooks[this.hooks.length - 1].event === "UserPromptSubmit") {
        this.host.beginRunFromHook(typeof payload.prompt === "string" ? payload.prompt : "", {
          promptId: typeof payload.prompt_id === "string" ? payload.prompt_id : null,
        });
      }
      if (this.hooks[this.hooks.length - 1].event === "Stop") {
        this.host.completeRunFromTurnEnd();
      }
    }
  }

  startHookPolling() {
    this.hookTimer = setInterval(() => this.pollHooks(), PROBE_HOOK_POLL_MS);
    this.hookTimer.unref?.();
  }

  async boot() {
    this.startHookPolling();
    this.host.startTask({
      cwd: this.workspace,
      runtimeDir: this.runtimeDir,
      permissionMode: "default",
      rows: ROWS,
      cols: COLS,
      model: this.launchModel,
      reasoningEffort: this.launchEffort,
      // Native-approval mode: the arm answers the trust dialog off the GRID, the
      // way every probe in this program does (SL-1: grid-verified Down then CR,
      // never a blind key).
      approvalBroker: false,
    });
    this.settingsSnapshot = (() => {
      try {
        return JSON.parse(
          fs.readFileSync(path.join(this.runtimeDir, "claude-runtime-settings.json"), "utf8"),
        );
      } catch {
        return null;
      }
    })();

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
    const trustScraped = () =>
      this.events.some((e) => e.type === "approval:detected" && e.kind === "workspace-trust");
    const deadline = Date.now() + 90_000;
    let ok = false;
    let trustSeenOnGridAt = null;
    while (Date.now() < deadline && !this.ptyExited) {
      if (this.host.acceptsPromptInput()) {
        ok = true;
        break;
      }
      if (!trustAnswered) {
        // THE SCRAPE MUST WIN THIS RACE, and the first run of this probe measured
        // why. Native-approval mode scrapes the trust dialog into `approvalActive`
        // + `activeApprovalWalk`, and `acceptsPromptInput` refuses on
        // `approvalActive` ABOVE the SessionStart short-circuit. Answering the
        // dialog off the grid ourselves satisfies the CLI but leaves that flag
        // standing, so the host never reports ready and the arm dies at its 90s
        // boot deadline (measured: `ready=false at 90234ms` with SessionStart
        // already in hand). `sendApprove()` performs the SAME cursor walk AND
        // clears the flag, so it is the channel — but it is only legal once the
        // scrape has armed `activeApprovalWalk`, which is throttled and lands a
        // beat after the dialog paints. So: once the dialog is on the grid, give
        // the scrape a bounded head start, and keep the raw grid walk only as the
        // fallback for a dialog the scrape never recognizes at all.
        const onGrid = /Yes, I trust this folder/i.test(this.screen());
        if (onGrid && trustSeenOnGridAt === null) trustSeenOnGridAt = Date.now();
        if (trustScraped()) {
          trustAnswered = true;
          this.notes.push(`trust dialog answered via sendApprove at ${this.at()}ms`);
          void this.host
            .sendApprove()
            .catch((error) => this.notes.push(`trust approve error: ${error?.message ?? error}`));
        } else if (
          onGrid &&
          trustSeenOnGridAt !== null &&
          Date.now() - trustSeenOnGridAt > TRUST_SCRAPE_GRACE_MS &&
          (await answerTrustFromGrid())
        ) {
          trustAnswered = true;
          this.notes.push("trust dialog: the scrape never armed — answered off the grid (approvalActive may stand)");
        }
      }
      await delay(200);
    }
    this.notes.push(`ready=${ok} at ${this.at()}ms`);
    await delay(2500);
    this.frame("boot — composer ready");
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

  /** One cheap real turn, so the session has history — which is what raises the
   *  cache-miss confirm dialog on the next switch (F16: a session whose whole
   *  history is one token is not worth warning about, so the prompt asks for a
   *  little more than `ok`). */
  async oneRealTurn(prompt) {
    const before = this.hooks.filter((h) => h.event === "Stop").length;
    this.host.submitPrompt(prompt);
    const over = await this.waitUntil(
      () => this.hooks.filter((h) => h.event === "Stop").length > before,
      180_000,
    );
    this.notes.push(`warm-up turn completed=${over} at ${this.at()}ms`);
    await delay(2500);
    return over;
  }

  /**
   * Type a slash command and submit it separately, VERIFY-AND-RETRY: the composer
   * must be grid-verified to hold the text before CR. F41's incident was a slash
   * that silently never landed, and every arm below is worthless if its command
   * did not reach the CLI. Returns the arming/CR timestamps every latency figure
   * in this probe is measured against.
   */
  async sendSlash(text, { attempts = 3 } = {}) {
    for (let attempt = 1; attempt <= attempts; attempt++) {
      // The production `clearComposerBeforeTypedCommand` flood, so a retry cannot
      // concatenate onto the previous attempt's text.
      this.host.writeRaw("\x15".repeat(3));
      await delay(250);
      const armAtMs = this.at();
      const armIndex = this.chunks.length;
      this.host.writeRaw(text);
      await delay(1200);
      const onScreen = this.screen().includes(text);
      this.notes.push(`slash "${text}" on the composer before CR (attempt ${attempt}): ${onScreen}`);
      if (!onScreen) {
        if (attempt === attempts) {
          return { text, onScreen: false, armAtMs, armIndex, crAtMs: null, attempts: attempt };
        }
        continue;
      }
      const crAtMs = this.at();
      this.host.writeRaw("\r");
      return { text, onScreen: true, armAtMs, armIndex, crAtMs, attempts: attempt };
    }
    return { text, onScreen: false, armAtMs: null, armIndex: this.chunks.length, crAtMs: null, attempts };
  }

  /**
   * Replay the chunks recorded from `armIndex` onward through the SHIPPED parsers
   * over the SHIPPED window, one chunk at a time, first verdict wins — the exact
   * production arming shape (`writeClaudeValueCommand` resets the scan, then
   * `detectControlSwitchReceipt` feeds it). So each timestamp below is "when the
   * engine WOULD have decided", not "when a string appeared".
   */
  replayEngine(armIndex, kind, value) {
    let scan = "";
    let receipt = null;
    let dialog = null;
    let cancelled = null;
    for (let i = armIndex; i < this.chunks.length; i++) {
      const chunk = this.chunks[i];
      scan = (scan + chunk.data).slice(-CONTROL_SWITCH_SCAN_LIMIT);
      if (!receipt) {
        const verdict = parseClaudeControlReceipt(scan, kind, value);
        // The WINDOW at the moment of the verdict is kept verbatim: it is the only
        // artifact from which "the engine settled on WHOSE receipt" can be decided
        // later, and it is the shape a MEASURED smoke fixture has to be.
        if (verdict) receipt = { verdict, atMs: chunk.atMs, chunk: i - armIndex, window: scan };
      }
      if (!dialog && claudeCacheMissDialogOpen(scan)) {
        dialog = { atMs: chunk.atMs, chunk: i - armIndex, cursor: parseClaudeCacheMissCursor(scan) };
      }
      if (!cancelled && claudeCacheMissCancelled(scan, kind)) {
        cancelled = { atMs: chunk.atMs, chunk: i - armIndex };
      }
    }
    return { receipt, dialog, cancelled };
  }

  /**
   * The VERBATIM receipt line(s) this arm printed, read off the GRID — the frames
   * captured at/after the arm plus the live screen.
   *
   * Not off the stream, and that is a measured choice rather than a preference:
   * claude renders in the alternate screen and repaints as a CELL DIFF, so the
   * receipt's characters reach the pty interleaved with cursor moves and split
   * across chunks. That is exactly why the shipped parsers compact ALL whitespace
   * out before matching — and why a line-oriented read of the stream returns
   * nothing (it did, on the first run of this probe). The grid converges to what
   * was displayed, which is what "the receipt wording" means.
   */
  receiptLines(sinceAtMs) {
    const screens = [
      ...this.frames.filter((f) => f.atMs >= sinceAtMs).map((f) => f.screen),
      this.screen(),
    ];
    const hits = [];
    for (const screen of screens) {
      for (const line of screen.split("\n")) {
        const trimmed = line.trim().replace(/\s+/g, " ");
        if (
          /(Set model to|Kept model as|Set effort level to|Kept effort level as|Effort level set to|not found|Invalid argument)/.test(
            trimmed,
          )
        ) {
          const clean = sanitize(trimmed);
          if (!hits.includes(clean)) hits.push(clean);
        }
      }
    }
    return hits;
  }

  /** The hooks that landed at or after `sinceMs`, with their offset from the CR. */
  hooksSince(sinceMs, filter = () => true) {
    return this.hooks
      .filter((h) => h.atMs >= sinceMs - 50 && filter(h))
      .map((h) => ({ ...h, afterCrMs: h.atMs - sinceMs }));
  }

  /**
   * Did the CLI PAINT that it was running these hooks? Injecting an event is not
   * free on a co-visible terminal: 2.1.258 renders `Running <Event> hooks… (Esc to
   * cancel)` while they execute, so adding `PreModelSwitch`/`PostModelSwitch` to
   * production's list puts a new line on the user's screen during every switch.
   * Recorded because it is a UI consequence of the patch, not only a data one.
   */
  hookRunnerLines(sinceAtMs) {
    const text = stripAnsi(
      this.chunks.filter((c) => c.atMs >= sinceAtMs).map((c) => c.data).join(""),
    );
    return [...new Set(text.match(/Running\s+\w+\s+hooks…[^\n]{0,40}/g) ?? [])].map((s) =>
      s.trim().replace(/\s+/g, " "),
    );
  }

  /** Is the cache-miss dialog on the GRID right now (the spatial read)? */
  dialogOnGrid() {
    return claudeCacheMissDialogOpen(this.screen());
  }

  finish(extra = {}) {
    const out = {
      arm: this.name,
      version,
      injectedEvents: this.settingsSnapshot ? Object.keys(this.settingsSnapshot.hooks).sort() : null,
      hookOrder: this.hooks.map((h) => `${h.event}@${h.atMs}`),
      notes: this.notes.map(sanitize),
      hostEvents: this.events.map((e) => `${e.type}${e.kind ? `(${e.kind})` : ""}@${e.atMs}`),
      ptyExited: this.ptyExited,
      frames: this.frames,
      screenTail: sanitize(this.screen().split("\n").slice(-18).join("\n")),
      ...extra,
    };
    try {
      if (this.hookTimer) clearInterval(this.hookTimer);
      this.pollHooks();
      this.host.dispose();
      this.term.dispose();
    } catch {
      /* best-effort */
    }
    return out;
  }
}

// ─── picker helpers (arms f and g) ──────────────────────────────────────────

/** Is the `/model` picker on screen? Its title is the cheapest unambiguous mark. */
const pickerOpen = (screen) => /^\s*Select model\s*$/m.test(screen);

/** The label on the row carrying `❯`, scanned BOTTOM-UP — q12's measured lesson:
 *  a closed picker leaves an echoed `❯ /model` line in the transcript above, and a
 *  top-down scan reads that stale echo as the focused row. */
function focusedRow(screen) {
  const lines = screen.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const t = lines[i].trim();
    if (!t.startsWith("❯")) continue;
    const label = t.slice("❯".length).trim().replace(/\s+/g, " ");
    if (label) return label;
  }
  return null;
}

async function openModelPicker(session, label) {
  const armIndex = session.chunks.length;
  const sent = await session.sendSlash("/model");
  await delay(1800);
  const opened = pickerOpen(session.screen());
  session.frame(`${label} — picker OPEN? ${opened}`);
  return { sent, armIndex, opened, focused: focusedRow(session.screen()) };
}

/** Walk the picker to the row whose label matches `wanted`, verifying the cursor
 *  after every single arrow (never a blind press). */
async function walkPickerTo(session, wanted, label, maxSteps = 8) {
  const seen = [];
  for (let i = 0; i <= maxSteps; i++) {
    const focused = focusedRow(session.screen());
    seen.push({ step: i, focused });
    if (focused && wanted.test(focused)) {
      session.frame(`${label} — cursor on target row after ${i} Down(s)`);
      return { landed: true, steps: i, walk: seen, focused };
    }
    if (i === maxSteps) break;
    session.host.writeRaw("\x1b[B");
    await delay(450);
  }
  session.frame(`${label} — target row NEVER focused`);
  return { landed: false, steps: maxSteps, walk: seen, focused: focusedRow(session.screen()) };
}

// ─── arms ───────────────────────────────────────────────────────────────────

const WARMUP_PROMPT =
  "In one short sentence, say what a terminal emulator does. Do not use any tools.";

/** Answer the cache-miss dialog by ROW, the way Sonata's parked relay does: read
 *  the cursor, arrow toward the row, verify, then Enter. Never a blind key. */
async function answerCacheMiss(session, row, label) {
  const rows = [/❯\s*\d?\.?\s*Yes, switch to/i, /❯\s*\d?\.?\s*No, go back/i];
  for (let i = 0; i < 6; i++) {
    const screen = session.screen();
    const at = rows.findIndex((re) => re.test(screen)) + 1;
    if (at === row) {
      session.frame(`${label} — cursor on row ${row}, pressing Enter`);
      const crAtMs = session.at();
      const armIndex = session.chunks.length;
      session.host.writeRaw("\r");
      return { answered: true, row, crAtMs, armIndex };
    }
    if (at === 0) {
      await delay(400);
      continue;
    }
    session.host.writeRaw(at < row ? "\x1b[B" : "\x1b[A");
    await delay(450);
  }
  session.frame(`${label} — could NOT position the cursor on row ${row}`);
  return { answered: false, row, crAtMs: null, armIndex: session.chunks.length };
}

/**
 * The shared body of every "drive a value-axis command and watch both channels"
 * arm. `answer` decides what to do with the cache-miss dialog if it appears:
 * `"yes"` / `"no"` / `"esc"` / `"none"`.
 */
async function driveValueSwitch(session, { kind, value, answer, label, settleMs = 20_000 }) {
  const slash = await session.sendSlash(`/${kind} ${value}`);
  if (!slash.onScreen) {
    return { slash, aborted: "the command never reached the composer" };
  }
  // Wait for either the dialog or a verdict, whichever the CLI produces.
  await session.waitUntil(
    () =>
      session.dialogOnGrid() ||
      session.replayEngine(slash.armIndex, kind, value).receipt !== null,
    12_000,
  );
  const dialogSeen = session.dialogOnGrid();
  session.frame(`${label} — after CR (dialog on grid? ${dialogSeen})`);

  let answered = null;
  if (dialogSeen && answer !== "none") {
    if (answer === "esc") {
      session.frame(`${label} — dialog up, sending Esc`);
      answered = { answered: true, row: null, via: "esc", crAtMs: session.at(), armIndex: session.chunks.length };
      session.host.writeRaw("\x1b");
    } else {
      answered = await answerCacheMiss(session, answer === "yes" ? 1 : 2, label);
      answered.via = `row-${answered.row}`;
    }
  }

  await delay(settleMs);
  session.frame(`${label} — settled`);

  // Both channels, measured from the SAME zero: the CR that submitted the command.
  const zero = slash.crAtMs;
  const engine = session.replayEngine(slash.armIndex, kind, value);
  // A dialog-answering arm also gets the post-answer replay, because production's
  // parked relay resets its scan at the park and reads only post-park frames.
  const postAnswer = answered?.answered
    ? session.replayEngine(answered.armIndex, kind, value)
    : null;
  // THE RESIDUAL, measured rather than argued. The SUCCESS needle carries no value
  // anchor (the receipt names the model's DISPLAY label, not the alias — F19), so
  // the same window should settle a switch that was never asked for. Replaying it
  // against a value this leg never used turns "the needle is unanchored" from a
  // property of the regex into an observation about THIS session's bytes.
  const foreign = session.replayEngine(slash.armIndex, kind, "a-value-never-asked-for");
  return {
    slash: { text: slash.text, onScreen: slash.onScreen, attempts: slash.attempts, crAtMs: zero },
    dialogSeen,
    answered,
    unanchoredResidual: {
      foreignValue: "a-value-never-asked-for",
      verdict: foreign.receipt?.verdict ?? null,
      afterCrMs: foreign.receipt ? foreign.receipt.atMs - zero : null,
      note:
        foreign.receipt?.verdict === "settled"
          ? "the shipped success needle settles this window for a value the session never asked for"
          : "no settle for a foreign value in this window",
    },
    engine: {
      receipt: engine.receipt && { ...engine.receipt, afterCrMs: engine.receipt.atMs - zero },
      dialog: engine.dialog && { ...engine.dialog, afterCrMs: engine.dialog.atMs - zero },
      cancelled: engine.cancelled && { ...engine.cancelled, afterCrMs: engine.cancelled.atMs - zero },
    },
    postAnswerEngine: postAnswer && {
      receipt: postAnswer.receipt && {
        ...postAnswer.receipt,
        afterAnswerMs: postAnswer.receipt.atMs - answered.crAtMs,
      },
      cancelled: postAnswer.cancelled && {
        ...postAnswer.cancelled,
        afterAnswerMs: postAnswer.cancelled.atMs - answered.crAtMs,
      },
    },
    receiptLines: session.receiptLines(slash.armAtMs),
    hookRunnerLines: session.hookRunnerLines(slash.armAtMs),
    modelSwitchHooks: session.hooksSince(zero, (h) => /ModelSwitch/.test(h.event)),
    allHooksAfterCr: session.hooksSince(zero).map((h) => `${h.event}@+${h.afterCrMs}ms`),
    // The decision-relative view: on a session WITH history the switch does not
    // happen at the CR, it happens when the DIALOG is answered — so this is the
    // number the confirm design actually turns on.
    modelSwitchHooksAfterAnswer: answered?.answered
      ? session
          .hooksSince(answered.crAtMs, (h) => /ModelSwitch/.test(h.event))
          .map((h) => `${h.event}@+${h.afterCrMs}ms`)
      : null,
  };
}

/** a1/a2/a3 — the headline arm: `/model haiku` on a session WITH history, answer
 *  Yes. Repeated three times (three fresh sessions) because F35's double-`Pre` was
 *  seen ONCE and a consumer's idempotence rule must be safe against what actually
 *  repeats. */
async function armYes(name) {
  const session = new Session(name);
  const pinAtSpawn = guard.readKey("model");
  if (!(await session.boot())) return session.finish({ verdict: "BOOT FAILED", pinAtSpawn });
  const warm = await session.oneRealTurn(WARMUP_PROMPT);
  const drive = await driveValueSwitch(session, {
    kind: "model",
    value: "haiku",
    answer: "yes",
    label: name,
  });
  const settingsWhileLive = guard.diffSinceSnapshot();
  return session.finish({
    question: "Pre/Post timing; is the double-Pre reproducible; payload byte-stable; hook vs receipt",
    pinAtSpawn,
    warmupTurn: warm,
    ...drive,
    settingsWhileLive,
  });
}

/** b1 — `/model sonnet` → dialog → Esc. b2 — the same, answered on the `No` row.
 *  The question is what fires on a CANCEL: `Pre` only? nothing? — and whether
 *  Pre-without-Post is a clean enough structural signal to retire F22's needle. */
async function armCancel(name, how) {
  const session = new Session(name);
  const pinAtSpawn = guard.readKey("model");
  if (!(await session.boot())) return session.finish({ verdict: "BOOT FAILED", pinAtSpawn });
  const warm = await session.oneRealTurn(WARMUP_PROMPT);
  const drive = await driveValueSwitch(session, {
    kind: "model",
    value: "sonnet",
    answer: how,
    label: name,
  });
  const settingsWhileLive = guard.diffSinceSnapshot();
  // Give a late Post every chance before declaring "nothing fired on cancel".
  await delay(15_000);
  const lateHooks = drive.slash.crAtMs != null ? session.hooksSince(drive.slash.crAtMs, (h) => /ModelSwitch/.test(h.event)) : [];
  return session.finish({
    question: `cancel via ${how}: what fires alongside "Kept model as …"; does settings.json move`,
    pinAtSpawn,
    warmupTurn: warm,
    ...drive,
    modelSwitchHooksAfterLongWait: lateHooks,
    settingsWhileLive,
    dialogStillOnGrid: session.dialogOnGrid(),
  });
}

/** c — a model the CLI does not have. Failure receipt text; any hook at all? */
async function armBogus() {
  const session = new Session("c-bogus-model");
  const pinAtSpawn = guard.readKey("model");
  if (!(await session.boot())) return session.finish({ verdict: "BOOT FAILED", pinAtSpawn });
  const warm = await session.oneRealTurn(WARMUP_PROMPT);
  const drive = await driveValueSwitch(session, {
    kind: "model",
    value: "bogus-model-name",
    answer: "none",
    label: "c-bogus-model",
    settleMs: 12_000,
  });
  return session.finish({
    question: "failure receipt text; any hook?",
    pinAtSpawn,
    warmupTurn: warm,
    ...drive,
    settingsWhileLive: guard.diffSinceSnapshot(),
  });
}

/** d — `/effort low`. The effort axis is the half of this code path that has NO
 *  hook to move to; the slice must MEASURE that rather than assume it. */
async function armEffort() {
  const session = new Session("d-effort-low");
  const pinAtSpawn = guard.readKey("model");
  if (!(await session.boot())) return session.finish({ verdict: "BOOT FAILED", pinAtSpawn });
  const warm = await session.oneRealTurn(WARMUP_PROMPT);
  const hooksBefore = session.hooks.length;
  const drive = await driveValueSwitch(session, {
    kind: "effort",
    value: "low",
    answer: "yes",
    label: "d-effort-low",
  });
  return session.finish({
    question: "any hook at all for an EFFORT switch? (expected none)",
    pinAtSpawn,
    warmupTurn: warm,
    ...drive,
    everyHookAfterTheCommand: session.hooks.slice(hooksBefore).map((h) => `${h.event}@${h.atMs}`),
    settingsWhileLive: guard.diffSinceSnapshot(),
  });
}

/** e — a FRESH session with no history: the clean path, where the switch applies
 *  with a receipt and no dialog. This is the shape the hook has to cover too. */
async function armFresh() {
  const session = new Session("e-fresh-no-history");
  const pinAtSpawn = guard.readKey("model");
  if (!(await session.boot())) return session.finish({ verdict: "BOOT FAILED", pinAtSpawn });
  const drive = await driveValueSwitch(session, {
    kind: "model",
    value: "sonnet",
    answer: "yes",
    label: "e-fresh-no-history",
  });
  return session.finish({
    question: "clean path: Post without a dialog; timing",
    pinAtSpawn,
    warmupTurn: false,
    ...drive,
    settingsWhileLive: guard.diffSinceSnapshot(),
  });
}

/**
 * f — the PICKER-driven switch: bare `/model`, arrow to a row, Enter.
 * g — the same walk, but `s` ("for this session only", F16) instead of Enter.
 *
 * g is the F68-ruling arm and the design input for candidate slice U4, so it
 * records the full key sequence, both hook payloads (`source` especially), the
 * receipt wording, whether a cache-miss dialog appears at all, and — the decisive
 * cell — whether `~/.claude/settings.json` moves.
 */
async function armPicker(name, confirmKey) {
  const session = new Session(name);
  const pinAtSpawn = guard.readKey("model");
  if (!(await session.boot())) return session.finish({ verdict: "BOOT FAILED", pinAtSpawn });
  const warm = await session.oneRealTurn(WARMUP_PROMPT);

  const opened = await openModelPicker(session, name);
  if (!opened.opened) {
    return session.finish({ verdict: "PICKER DID NOT OPEN", pinAtSpawn, warmupTurn: warm, opened });
  }
  session.frame(`${name} — picker rows (the 's' hint is in the footer)`);
  // The focused label carries the row DIGIT and then the description, e.g.
  // `5. Haiku Haiku 4.5 · Fastest for quick answers` (measured on the first run of
  // this arm, whose `/^Haiku/` anchor never matched and walked the list twice).
  const walk = await walkPickerTo(session, /^\d+\.\s*Haiku\b/i, name);
  if (!walk.landed) {
    session.host.writeRaw("\x1b");
    await delay(1200);
    return session.finish({ verdict: "TARGET ROW NEVER FOCUSED", pinAtSpawn, warmupTurn: warm, opened, walk });
  }

  const armIndex = session.chunks.length;
  const crAtMs = session.at();
  session.host.writeRaw(confirmKey === "enter" ? "\r" : "s");
  await delay(3000);
  const dialogSeen = session.dialogOnGrid();
  session.frame(`${name} — after '${confirmKey}' (dialog on grid? ${dialogSeen})`);
  let answered = null;
  if (dialogSeen) {
    answered = await answerCacheMiss(session, 1, name);
    answered.via = "row-1";
  }
  await delay(18_000);
  session.frame(`${name} — settled`);

  const engine = session.replayEngine(armIndex, "model", "haiku");
  return session.finish({
    question:
      confirmKey === "enter"
        ? "picker Enter: `source` value vs \"command\"; same payload keys; does it persist settings"
        : "picker `s`: receipt wording; Pre/Post payloads incl. `source`; settings.json UNCHANGED?; dialog?",
    pinAtSpawn,
    warmupTurn: warm,
    keySequence: `/model + CR (open) → Down×${walk.steps} (verified each) → ${confirmKey === "enter" ? "Enter" : "'s'"}`,
    opened: { openedAtMs: opened.armIndex, focusedAtOpen: opened.focused, sent: opened.sent },
    walk,
    confirmKey,
    confirmAtMs: crAtMs,
    dialogSeen,
    answered,
    engine: {
      receipt: engine.receipt && { ...engine.receipt, afterConfirmMs: engine.receipt.atMs - crAtMs },
      dialog: engine.dialog && { ...engine.dialog, afterConfirmMs: engine.dialog.atMs - crAtMs },
      cancelled: engine.cancelled && { ...engine.cancelled, afterConfirmMs: engine.cancelled.atMs - crAtMs },
    },
    receiptLines: session.receiptLines(crAtMs),
    hookRunnerLines: session.hookRunnerLines(crAtMs),
    unanchoredResidual: (() => {
      const foreign = session.replayEngine(armIndex, "model", "a-value-never-asked-for");
      return {
        foreignValue: "a-value-never-asked-for",
        verdict: foreign.receipt?.verdict ?? null,
        afterCrMs: foreign.receipt ? foreign.receipt.atMs - crAtMs : null,
      };
    })(),
    modelSwitchHooks: session.hooksSince(crAtMs, (h) => /ModelSwitch/.test(h.event)),
    allHooksAfterConfirm: session.hooksSince(crAtMs).map((h) => `${h.event}@+${h.afterCrMs}ms`),
    modelSwitchHooksAfterAnswer: answered?.answered
      ? session
          .hooksSince(answered.crAtMs, (h) => /ModelSwitch/.test(h.event))
          .map((h) => `${h.event}@+${h.afterCrMs}ms`)
      : null,
    settingsWhileLive: guard.diffSinceSnapshot(),
  });
}

/**
 * h — the F19 repaint condition, which is the whole point of the slice: a switch
 * that RESHAPES the banner forces a full transcript redraw, replaying every older
 * receipt through the very window the confirm reads. Two switches in one session:
 * `opus[1m]` (adds the 1M-context banner) then `haiku` (which DROPS the effort
 * segment — F19's measured repaint transition). The question is whether the HOOK
 * arrives cleanly for the second one while the stream is full of the first one's
 * receipt.
 */
async function armRepaint() {
  const session = new Session("h-banner-repaint");
  const pinAtSpawn = guard.readKey("model");
  if (!(await session.boot())) return session.finish({ verdict: "BOOT FAILED", pinAtSpawn });
  const warm = await session.oneRealTurn(WARMUP_PROMPT);
  const first = await driveValueSwitch(session, {
    kind: "model",
    value: "opus[1m]",
    answer: "yes",
    label: "h-leg1-opus1m",
  });
  await delay(4000);
  const second = await driveValueSwitch(session, {
    kind: "model",
    value: "haiku",
    answer: "yes",
    label: "h-leg2-haiku",
  });
  return session.finish({
    question: "does the hook arrive independent of the replayed receipts?",
    pinAtSpawn,
    warmupTurn: warm,
    leg1: first,
    leg2: second,
    settingsWhileLive: guard.diffSinceSnapshot(),
  });
}

const ARMS = {
  a1: () => armYes("a1-yes-haiku"),
  a2: () => armYes("a2-yes-haiku"),
  a3: () => armYes("a3-yes-haiku"),
  b1: () => armCancel("b1-cancel-esc", "esc"),
  b2: () => armCancel("b2-cancel-no-row", "no"),
  c: () => armBogus(),
  d: () => armEffort(),
  e: () => armFresh(),
  f: () => armPicker("f-picker-enter", "enter"),
  g: () => armPicker("g-picker-session-only", "s"),
  h: () => armRepaint(),
};

// ─── run ────────────────────────────────────────────────────────────────────

fs.mkdirSync(RESULT_DIR, { recursive: true });

const argv = process.argv.slice(2);
const captureOnly = argv.includes("--capture-only");
const only = argv.filter((a) => !a.startsWith("-"));
const selected = captureOnly ? [] : only.length > 0 ? only : Object.keys(ARMS);

let selfTest = null;
if (!captureOnly) {
  // Against a THROWAWAY file, never the real one (m1's shape): a guard that has
  // never been observed working is not a guard, but proving it must not itself be
  // the run's first mutation of `~/.claude/settings.json`.
  const selfTestFile = path.join(ROOT, "guard-self-test.json");
  fs.writeFileSync(selfTestFile, `${JSON.stringify({ model: "fable", canary: true }, null, 2)}\n`);
  selfTest = runSettingsGuardSelfTest(createSettingsGuard({ settingsPath: selfTestFile }));
  process.stderr.write(`[settings guard self-test] pass=${selfTest.pass}\n`);
  if (selfTest.pass !== true) {
    console.log(JSON.stringify({ success: false, reason: "settings-guard self-test FAILED", selfTest }));
    process.exit(2);
  }
  fs.writeFileSync(path.join(RESULT_DIR, "guard-selftest.json"), JSON.stringify(selfTest, null, 2));
} else {
  // `--capture-only` assembles across batches, so the self-test it reports is the
  // one the batch actually ran rather than a blank.
  try {
    selfTest = JSON.parse(fs.readFileSync(path.join(RESULT_DIR, "guard-selftest.json"), "utf8"));
  } catch {
    /* the batch that ran it kept no record — say so rather than claim a pass */
  }
}

try {
  for (const name of selected) {
    const arm = ARMS[name];
    if (!arm) {
      console.error(`unknown arm: ${name}`);
      continue;
    }
    process.stderr.write(`\n[h4] running arm ${name}…\n`);
    let result;
    try {
      result = await arm();
    } catch (error) {
      result = { arm: name, verdict: "THREW", error: sanitize(String(error?.stack ?? error)) };
    }
    // The bracket closes PER ARM: an arm that persisted a model must not leave the
    // next arm racing a user default it did not choose (F70).
    const restore = guard.restoreNow(name);
    result.settingsRestore = {
      label: restore.label,
      mutatedByProbe: restore.mutatedByProbe ?? false,
      restored: restore.restored ?? null,
      changedKeys: restore.changedKeys ?? [],
    };
    result.ranAt = new Date().toISOString();
    fs.writeFileSync(path.join(RESULT_DIR, `${name}.json`), JSON.stringify(result, null, 2));
    process.stderr.write(
      `[h4] arm ${name}: settings ${restore.mutatedByProbe ? `MOVED (${(restore.changedKeys ?? []).join("; ")}) → restored ${restore.restored}` : "unchanged"}\n`,
    );
  }
} finally {
  guard.restore();
  fs.writeFileSync(GUARD_HISTORY_FILE, JSON.stringify(guard.history(), null, 2));
}

const endPin = pinVersion("probe end");
// A `--capture-only` re-render against a MOVED binary would rewrite a committed
// record with pins that do not describe the run it reports. The capture is
// evidence; refuse rather than corrupt it. (A spot-check run is exempt by
// construction — its own EXPECT_VERSION is the binary it is about.)
if (captureOnly && endPin.drifted) {
  console.log(
    JSON.stringify({
      success: false,
      reason: `refusing to re-render the ${EXPECT_VERSION} capture: the binary is now ${endPin.version}. Re-run the arms, or set SONATA_PROBE_SPOTCHECK_VERSION to record a new one.`,
    }),
  );
  process.exit(2);
}

// ─── capture assembly ───────────────────────────────────────────────────────

const results = Object.keys(ARMS)
  .map((name) => {
    try {
      return JSON.parse(fs.readFileSync(path.join(RESULT_DIR, `${name}.json`), "utf8"));
    } catch {
      return null;
    }
  })
  .filter(Boolean);

const guardHistory = fs
  .readdirSync(RESULT_DIR)
  .filter((f) => /^guard-history-\d+\.json$/.test(f))
  .sort()
  .flatMap((f) => {
    try {
      return JSON.parse(fs.readFileSync(path.join(RESULT_DIR, f), "utf8")).map((h) => ({ file: f, ...h }));
    } catch {
      return [];
    }
  });

const fmt = (value) => (value == null ? "—" : `+${value}ms`);

/** One row of the timings table. The value-axis arms zero on the CR that submitted
 *  the command; the PICKER arms (f/g) zero on the confirm key instead, which is the
 *  same instant in the user's terms — the moment the choice was committed. */
function timingRow(arm, legName, leg) {
  const picker = leg && leg.confirmKey != null;
  if (!leg || (!leg.slash && !picker)) return null;
  const pre = (leg.modelSwitchHooks ?? []).filter((h) => h.event === "PreModelSwitch");
  const post = (leg.modelSwitchHooks ?? []).filter((h) => h.event === "PostModelSwitch");
  const receiptMs = picker ? leg.engine?.receipt?.afterConfirmMs : leg.engine?.receipt?.afterCrMs;
  const dialogMs = picker ? leg.engine?.dialog?.afterConfirmMs : leg.engine?.dialog?.afterCrMs;
  return [
    picker ? `${legName} [picker '${leg.confirmKey}']` : legName,
    pre.length === 0 ? "none" : pre.map((h) => `+${h.afterCrMs}ms`).join(", "),
    post.length === 0 ? "none" : post.map((h) => `+${h.afterCrMs}ms`).join(", "),
    leg.engine?.receipt ? `${leg.engine.receipt.verdict} ${fmt(receiptMs)}` : "none",
    leg.dialogSeen ? `yes ${fmt(dialogMs)} (${leg.answered?.via ?? "unanswered"})` : "no",
    (arm.settingsRestore?.changedKeys ?? []).join("; ") || "unchanged",
  ];
}

const timingRows = [];
for (const arm of results) {
  if (arm.leg1 || arm.leg2) {
    const a = timingRow(arm, `${arm.arm} leg1`, arm.leg1);
    const b = timingRow(arm, `${arm.arm} leg2`, arm.leg2);
    if (a) timingRows.push(a);
    if (b) timingRows.push(b);
    continue;
  }
  const row = timingRow(arm, arm.arm, arm);
  if (row) timingRows.push(row);
}

const lines = [];
const add = (title, body) => {
  lines.push(`\n${"=".repeat(78)}\n${title}\n${"=".repeat(78)}\n${body}`);
};

lines.push(
  SPOTCHECK_VERSION
    ? `H4 SPOT-CHECK at ${SPOTCHECK_VERSION} — NOT the slice record (the record is the ${PINNED_VERSION} capture)`
    : "H4 — PostModelSwitch as the model-axis confirm + the picker-`s` path",
);
lines.push(`claude ${version} (start pin ${startPin.version}, end pin ${endPin.version}${endPin.drifted ? " — DRIFTED" : ""})`);
lines.push(`assembled ${new Date().toISOString()}`);
lines.push(`arms on record: ${results.map((r) => r.arm).join(", ")}`);
lines.push(``);
lines.push(`METHOD`);
lines.push(`  spawn        production TerminalHost from dist/, production argv, production`);
lines.push(`               ensureClaudeRuntimeSettings + hook-sink.js command.`);
lines.push(`  injection    the probe-local wrapper LAYERED: ${[...layeredEvents].join(", ") || "(nothing)"}`);
lines.push(`               already written by PRODUCTION: ${[...productionEvents].join(", ") || "(neither)"}`);
lines.push(`               The production INJECTED_HOOK_EVENTS list is never EDITED by this probe —`);
lines.push(`               the wrapper only adds what production did not already write, so once a`);
lines.push(`               patch takes an event into that list, this line records the handover.`);
lines.push(`  hook time    read off the sink FILENAME (hook-<Date.now() base36>-…), i.e. the`);
lines.push(`               instant the CLI's hook fired. The probe polls at ${PROBE_HOOK_POLL_MS}ms with the same`);
lines.push(`               read-then-delete protocol HookWatcher uses. PRODUCTION's watcher polls`);
lines.push(`               at ${PRODUCTION_HOOK_POLL_MS}ms, so production DELIVERY = the figures below + [0, ${PRODUCTION_HOOK_POLL_MS}]ms.`);
lines.push(`  receipt time taken by replaying the arm's own pty chunks through the SHIPPED`);
lines.push(`               parseClaudeControlReceipt over the SHIPPED ${CONTROL_SWITCH_SCAN_LIMIT}-char window, one`);
lines.push(`               chunk at a time, first verdict wins — production's arming shape. So`);
lines.push(`               it is "when the engine would have settled", not "when a string appeared".`);
lines.push(`  zero         the CR that submitted the command (or, for f/g, the confirm key).`);
lines.push(`  guard        settings-guard.mjs, closing PER ARM. Self-test against a throwaway`);
lines.push(`               file before the first spawn: pass=${selfTest ? selfTest.pass : "(capture-only pass — see guard-selftest.json)"}.`);

add(
  "TIMINGS — Pre / Post / receipt, all relative to the CR",
  [
    ["arm", "PreModelSwitch", "PostModelSwitch", "engine receipt", "cache-miss dialog", "settings.json"]
      .join(" | "),
    "---",
    ...timingRows.map((r) => r.join(" | ")),
  ].join("\n"),
);

const residualRows = [];
for (const arm of results) {
  for (const [legName, leg] of [
    [arm.arm, arm],
    [`${arm.arm} leg1`, arm.leg1],
    [`${arm.arm} leg2`, arm.leg2],
  ]) {
    if (!leg?.unanchoredResidual) continue;
    residualRows.push(
      `${legName} | asked for: ${leg.slash?.text ?? `picker row + '${leg.confirmKey}'`} | replayed as "${leg.unanchoredResidual.foreignValue}" → ${leg.unanchoredResidual.verdict ?? "no verdict"} ${fmt(leg.unanchoredResidual.afterCrMs)}`,
    );
  }
}
add(
  "THE UNANCHORED SUCCESS NEEDLE, replayed against a value the leg never asked for",
  [
    "Each row re-runs the SAME window through the SAME shipped parser with a pending",
    "value the session never used. A `settled` verdict means the needle decided the",
    "switch without reading the value at all — the KNOWN RESIDUAL, reproduced on this",
    "binary in these bytes rather than argued from the regex.",
    "",
    ...residualRows,
  ].join("\n"),
);

const runnerRows = [];
for (const arm of results) {
  for (const [legName, leg] of [
    [arm.arm, arm],
    [`${arm.arm} leg1`, arm.leg1],
    [`${arm.arm} leg2`, arm.leg2],
  ]) {
    if (!leg?.hookRunnerLines) continue;
    runnerRows.push(`${legName} | ${JSON.stringify(leg.hookRunnerLines)}`);
  }
}
add(
  "WHAT THE INJECTION COSTS ON SCREEN — the CLI's own hook-runner line",
  [
    "2.1.258 paints `Running <Event> hooks…` while it executes them. Sonata's",
    "Terminal pane is co-visible, so adding an event to the production injection",
    "list adds this line to what the user sees during a switch. Measured per leg:",
    "",
    ...runnerRows,
  ].join("\n"),
);

const gArm = results.find((r) => r.arm === "g-picker-session-only");
const fArm = results.find((r) => r.arm === "f-picker-enter");
add(
  "ARM g vs ARM f — the F68 ruling's decisive cell (U4 design input)",
  gArm && fArm
    ? [
        `key sequence (both)   ${gArm.keySequence}`,
        `rows walked           ${gArm.walk?.steps} Down(s), cursor verified after each; landed on "${gArm.walk?.focused}"`,
        "",
        `f — Enter  receipt:   ${JSON.stringify(fArm.receiptLines)}`,
        `           settings:  ${(fArm.settingsRestore?.changedKeys ?? []).join("; ") || "unchanged"}`,
        `           dialog:    ${fArm.dialogSeen ? "yes, still raised, answered on row 1" : "no"}`,
        `           hooks:     ${JSON.stringify(fArm.allHooksAfterConfirm)}`,
        `           source:    ${(fArm.modelSwitchHooks ?? [])[0]?.payload?.source}`,
        `           requested: ${(fArm.modelSwitchHooks ?? [])[0]?.payload?.requested_model}`,
        "",
        `g — 's'    receipt:   ${JSON.stringify(gArm.receiptLines)}`,
        `           settings:  ${(gArm.settingsRestore?.changedKeys ?? []).join("; ") || "UNCHANGED"}`,
        `           dialog:    ${gArm.dialogSeen ? "yes, still raised, answered on row 1" : "no"}`,
        `           hooks:     ${JSON.stringify(gArm.allHooksAfterConfirm)}`,
        `           source:    ${(gArm.modelSwitchHooks ?? [])[0]?.payload?.source}`,
        `           requested: ${(gArm.modelSwitchHooks ?? [])[0]?.payload?.requested_model}`,
      ].join("\n")
    : "(one of the picker arms is not on record)",
);

add(
  "SETTINGS GUARD — every bracket this run performed",
  guardHistory.length === 0
    ? "(no guard history files found)"
    : guardHistory
        .map(
          (h) =>
            `${h.file} :: ${h.label}: mutatedByProbe=${h.mutatedByProbe} restored=${h.restored} ${(h.changedKeys ?? []).join("; ")}`,
        )
        .join("\n"),
);

/** The verbatim settle WINDOW is 4096 chars of raw ANSI per leg — evidence, but
 *  evidence that belongs in a fixture file rather than inline in a capture six
 *  people will read. It stays in the per-arm result JSON under
 *  `/private/tmp/sonata-sync-2026-09/model-switch-hooks/results/`; the capture
 *  records its size and where the smoke's copy of it lives. */
function withoutWindows(value) {
  if (Array.isArray(value)) return value.map(withoutWindows);
  if (value && typeof value === "object") {
    const out = {};
    for (const [key, raw] of Object.entries(value)) {
      if (key === "window" && typeof raw === "string") {
        out.windowChars = raw.length;
        continue;
      }
      out[key] = withoutWindows(raw);
    }
    return out;
  }
  return value;
}

for (const arm of results) {
  add(`ARM ${arm.arm} — ${arm.question ?? arm.verdict ?? ""}`, JSON.stringify(withoutWindows(arm), null, 2));
}

for (const arm of results) {
  for (const frame of arm.frames ?? []) {
    add(`FRAME · ${arm.arm} @${frame.atMs}ms · ${frame.label}`, frame.screen);
  }
}

const capturePath = path.join(OUT_DIR, CAPTURE_NAME);
fs.writeFileSync(capturePath, sanitize(lines.join("\n")) + "\n");

console.log(
  JSON.stringify(
    {
      probe: "h4-model-switch-hooks",
      version,
      endPin,
      arms: results.map((r) => ({
        arm: r.arm,
        verdict: r.verdict ?? "ran",
        settings: r.settingsRestore?.changedKeys ?? [],
      })),
      capture: capturePath,
      success: !endPin.drifted,
    },
    null,
    2,
  ),
);
if (endPin.drifted) process.exit(2);
