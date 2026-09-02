// H1 (2026-09 sync, SL-9) — the claude HOOK-EVENT CENSUS at 2.1.258 under
// PRODUCTION injection.
//
// QUESTION (brief objective 1): SL-2b measured the completion-relevant slice of
// the hook family at 2.1.257. SL-9 needs the whole census at 2.1.258: of the 33
// events the binary declares, which ones ACTUALLY fire across a standard turn and
// the SL-2b scenario set, and what do their payloads carry? Three named unknowns:
//   - `PreModelSwitch` / `PostModelSwitch` (2.1.251) — do they fire under our
//     injection, and what is in the payload (from_model/to_model)?
//   - `SessionStart` payload GROWTH — staleness / re-cache fields.
//   - the approve-always decision shape (`updatedPermissions`) — does the CLI
//     still accept it at 2.1.258, measured through Sonata's REAL broker?
//
// METHOD. Same shape as q11 (SL-2b): a real `TerminalHost` from `dist/` with
// Sonata's own spawn args, the production `HookWatcher`, and the production
// settings writer — then the CANDIDATE arm layers the remaining declared events
// onto the settings file the production writer just wrote, never overriding a
// production entry, reusing production's own sink command. The spawn shape stays
// production's; the only variable is which events are registered.
//
// The census arm is deliberately BROAD (every declared event except the one
// production owns). Sonata's sink writes files and emits nothing on stdout, so
// registering an event costs one file per fire and can decide nothing — which is
// exactly what makes a census safe to take.
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
const { writeApprovalReply } = require(APP_DIR + "dist/runtime/cli-signal/approval-watcher");

const EXPECT_VERSION = "2.1.258";
const ROOT = "/private/tmp/sonata-sync-2026-09/hook-census";
const COLS = 120;
const ROWS = 40;

const HOME = os.homedir();
const USER_MUNGED = `-${HOME.replace(/\//g, "-").replace(/^-/, "")}-`;
const sanitize = (value) =>
  String(value).split(HOME).join("$HOME").split(USER_MUNGED).join("-$USER_MUNGED-");

function pinVersion(where) {
  const version = execFileSync("claude", ["--version"], { encoding: "utf8" }).trim();
  if (!version.startsWith(EXPECT_VERSION)) {
    // SL-4 method note: an END drift must not DISCARD a completed capture. Record
    // the drift, let the caller save, exit non-zero afterwards.
    return { version, drifted: true, where };
  }
  return { version, drifted: false, where };
}
const startPin = pinVersion("probe start");
if (startPin.drifted) {
  console.log(JSON.stringify({ success: false, reason: `binary moved off ${EXPECT_VERSION} at start`, version: startPin.version }));
  process.exit(2);
}
const version = startPin.version;

// ─── the declared universe, read from the binary this run is pinned to ──────
// Not a hand-copied list: the array is extracted from the bundle each run, so a
// census taken against a moved binary can never silently measure yesterday's
// universe.
function declaredEvents() {
  const binary = execFileSync("bash", ["-c", 'readlink -f "$(which claude)" || which claude'], { encoding: "utf8" }).trim();
  const hay = fs.readFileSync(binary).toString("latin1");
  const anchor = '"PreToolUse","PostToolUse","PostToolUseFailure","PostToolBatch","Notification"';
  const at = hay.indexOf(anchor);
  if (at < 0) return null;
  const close = hay.indexOf("]", at);
  const list = hay.slice(at, close);
  return list.split(",").map((s) => s.replace(/^"|"$/g, "")).filter((s) => /^[A-Za-z]+$/.test(s));
}
const DECLARED = declaredEvents();
if (!DECLARED) {
  console.log(JSON.stringify({ success: false, reason: "could not extract the declared hook-event list from the binary" }));
  process.exit(2);
}

// ─── the user's real settings file is a probe HAZARD, not a probe input ─────
// INCIDENT, 2026-09-02 01:20:50 (this probe's own): the `c1-census` arm drives a
// real `/model haiku` to trigger the ModelSwitch pair, and a `/model` switch
// PERSISTS the new default into `~/.claude/settings.json`. The spawn deliberately
// uses the REAL config dir — the census is about what the CLI does in production,
// and an isolated `CLAUDE_CONFIG_DIR` would be logged out (SL-3) — so the switch
// mutated the user's actual default from `opus[1m]` to `haiku` and left it there.
//
// The arm DID attempt to switch back with a second `/model opus[1m]`, and that
// restore SILENTLY FAILED: the slash never reached the composer (the arm's own
// note recorded `on the composer before CR: false`) and the failure was read as
// missing measurement data rather than as an unrestored user setting.
//
// The lesson is not "try the slash harder". A restore driven through a composer
// is a best-effort UI action with a failure mode; a restore of a FILE is
// deterministic. So: snapshot the bytes before any arm runs, write them back
// unconditionally afterwards — on success, on throw, and on signal — and VERIFY
// the bytes match, reporting a mismatch loudly instead of trusting the write.
// Overridable ONLY so the guard itself can be tested against a throwaway file
// (`--self-test` below). Production runs of this probe never set it and always
// protect the real one.
const CLAUDE_SETTINGS =
  process.env.SONATA_PROBE_SETTINGS_PATH || path.join(os.homedir(), ".claude", "settings.json");

function snapshotUserSettings() {
  try {
    return { path: CLAUDE_SETTINGS, bytes: fs.readFileSync(CLAUDE_SETTINGS, "utf8") };
  } catch {
    return null; // no settings file → nothing to protect
  }
}

/** Put the user's settings back exactly as they were. Returns a record for the
 *  capture: what changed under us, and whether the restore actually took. */
function restoreUserSettings(snapshot) {
  if (!snapshot) return { checked: false };
  let after = null;
  try {
    after = fs.readFileSync(snapshot.path, "utf8");
  } catch {
    // deleted under us — restore it anyway
  }
  const mutated = after !== snapshot.bytes;
  if (!mutated) return { checked: true, mutatedByProbe: false, restored: true };
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
  return {
    checked: true,
    mutatedByProbe: true,
    restored: verified,
    // The DIFF, not the whole file: settings can carry tokens, and a capture is
    // committed. Key-level only.
    changedKeys: diffJsonKeys(snapshot.bytes, after),
  };
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
// Signals too: a Ctrl-C mid-arm must not leave the user on haiku.
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    restoreOnce();
    process.exit(130);
  });
}

// Production owns PermissionRequest (the broker). Everything else the binary
// declares is registered for the census.
const PRODUCTION_OWNED = new Set(["PermissionRequest"]);
// Tool-scoped events take `matcher:"*"`; session-scoped ones take a bare entry —
// production's own convention (MATCHER_EVENTS in claude-runtime-settings).
const MATCHER_EVENTS = new Set(["PreToolUse", "PostToolUse", "PostToolUseFailure", "PostToolBatch", "Notification"]);

function installCensusInjection() {
  const module = require(APP_DIR + "dist/runtime/cli-signal/claude-runtime-settings.js");
  const original = module.ensureClaudeRuntimeSettings;
  let enabled = false;
  module.ensureClaudeRuntimeSettings = (runtimeDir, options) => {
    const settingsPath = original(runtimeDir, options);
    if (!enabled) return settingsPath;
    const settings = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
    const sinkCommand = settings.hooks.Stop[0].hooks[0].command;
    for (const event of DECLARED) {
      if (PRODUCTION_OWNED.has(event) || settings.hooks[event]) continue;
      settings.hooks[event] = MATCHER_EVENTS.has(event)
        ? [{ matcher: "*", hooks: [{ type: "command", command: sinkCommand }] }]
        : [{ hooks: [{ type: "command", command: sinkCommand }] }];
    }
    fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
    return settingsPath;
  };
  return (value) => { enabled = value; };
}
const setCensus = installCensusInjection();

// ─── harness ────────────────────────────────────────────────────────────────

const REDACT_VALUE_KEYS = new Set(["transcript_path", "cwd", "session_id", "prompt_id", "turn_id", "tool_use_id", "agent_id", "uuid"]);

/** A payload rendered for the record: every key, with values kept where they are
 *  the evidence and elided where they are an id or a transcript. */
function renderPayload(payload) {
  const out = {};
  for (const [key, raw] of Object.entries(payload)) {
    if (REDACT_VALUE_KEYS.has(key)) {
      out[key] = typeof raw === "string" ? `<${key}:${raw.length}ch>` : raw;
      continue;
    }
    if (typeof raw === "string") {
      out[key] = sanitize(raw.length > 220 ? `${raw.slice(0, 220)}…[${raw.length}ch]` : raw);
      continue;
    }
    if (raw && typeof raw === "object") {
      const json = sanitize(JSON.stringify(raw));
      out[key] = json.length > 300 ? `${json.slice(0, 300)}…[${json.length}ch]` : json;
      continue;
    }
    out[key] = raw;
  }
  return out;
}

class Session {
  constructor(name, { census = true, approvalBroker = false } = {}) {
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
    setCensus(census);

    this.host = new TerminalHost({
      taskId: `task-h1-${name}`,
      provider: "claude",
      defaultWorkspace: this.workspace,
      eventSink: (event) => this.onHostEvent(event),
    });
    this.approvalBroker = approvalBroker;
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
    if (event.type === "report:updated" || event.type === "file:changed" || event.type === "run:updated") return;
    if (event.type === "pty:exit") this.ptyExited = true;
    this.events.push({ atMs: this.at(), type: event.type, payload: compactPayload(event.payload) });
  }

  onHookPayload(payload) {
    const event = typeof payload.hook_event_name === "string" ? payload.hook_event_name : "<none>";
    this.hooks.push({ atMs: this.at(), event, keys: Object.keys(payload).sort(), payload: renderPayload(payload) });
    // Only the completion-path dispatch edges the controller applies — enough to
    // keep the run lifecycle honest so the CLI is driven the way production
    // drives it; the census question is about ARRIVAL, not consumption.
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
    this.startedPty = this.host.startTask({
      cwd: this.workspace,
      runtimeDir: this.runtimeDir,
      permissionMode: "default",
      rows: ROWS,
      cols: COLS,
      // Census arms run native-approval (the grid answers the trust dialog);
      // the approval arm runs the PRODUCTION broker, which is its whole point.
      approvalBroker: this.approvalBroker,
    });
    this.watcher.watchWorkspace(this.runtimeDir);
    this.settingsSnapshot = (() => {
      try {
        return JSON.parse(fs.readFileSync(path.join(this.runtimeDir, "claude-runtime-settings.json"), "utf8"));
      } catch { return null; }
    })();

    // Trust dialog. With the broker ON, production SUPPRESSES the native approval
    // scrape (`nativeApprovalSurfaceSuppressed`), so `approval:detected` never
    // arrives and `sendApprove` has nothing to answer — the arm has to walk the
    // dialog off the GRID itself. Same walk either way (SL-1: grid-verified Down
    // then CR, never a blind key); only the trigger differs.
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
    const deadline = Date.now() + 90_000;
    let ok = false;
    while (Date.now() < deadline && !this.ptyExited) {
      if (this.host.acceptsPromptInput()) { ok = true; break; }
      if (!trustAnswered) {
        if (this.events.some((e) => e.type === "approval:detected" && e.payload?.kind === "workspace-trust")) {
          trustAnswered = true;
          this.notes.push(`trust dialog answered via sendApprove at ${this.at()}ms`);
          void this.host.sendApprove().catch((error) => this.notes.push(`trust approve error: ${error?.message ?? error}`));
        } else if (await answerTrustFromGrid()) {
          trustAnswered = true;
        }
      }
      await delay(200);
    }
    this.notes.push(`ready=${ok} at ${this.at()}ms`);
    await delay(2500);
    return ok;
  }

  async waitUntil(predicate, timeoutMs, stepMs = 150) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      if (predicate()) return true;
      if (Date.now() > deadline || this.ptyExited) return false;
      await delay(stepMs);
    }
  }

  /** Type a slash command and submit it SEPARATELY, after grid-verifying the
   *  composer carries it — a bare `writeRaw("/x\r")` can land while the CLI's own
   *  slash picker is open, where CR selects the top fuzzy match instead of
   *  forwarding verbatim (SL-10 register item). */
  async sendSlash(text) {
    this.host.writeRaw(text);
    await delay(1200);
    const onScreen = this.screen().includes(text);
    this.notes.push(`slash "${text}" on the composer before CR: ${onScreen}`);
    this.host.writeRaw("\r");
    return onScreen;
  }

  eventsSeen() { return [...new Set(this.hooks.map((h) => h.event))]; }

  /** First payload of each event, for the shape record. */
  shapes() {
    const byEvent = new Map();
    for (const hook of this.hooks) {
      if (!byEvent.has(hook.event)) byEvent.set(hook.event, hook);
    }
    return [...byEvent.values()].map((h) => ({ event: h.event, atMs: h.atMs, keys: h.keys, payload: h.payload }));
  }

  finish(extra = {}) {
    const out = {
      scenario: this.name,
      version,
      injectedEvents: this.settingsSnapshot ? Object.keys(this.settingsSnapshot.hooks).sort() : null,
      hookOrder: this.hooks.map((h) => `${h.event}@${h.atMs}`),
      eventsSeen: this.eventsSeen(),
      shapes: this.shapes(),
      notes: this.notes,
      events: this.events,
      ptyExited: this.ptyExited,
      screenTail: this.screen().split("\n").slice(-14).join("\n"),
      ...extra,
    };
    try { this.watcher.dispose(); this.host.dispose(); this.term.dispose(); } catch { /* best-effort */ }
    return out;
  }
}

// ─── arms ───────────────────────────────────────────────────────────────────

/** c1 — the CENSUS. Every declared event registered; one ordinary turn that uses
 *  a tool, then a `/model` switch (the ModelSwitch pair's only trigger), then a
 *  quiet window past the 60s idle-notification threshold. */
async function armCensus() {
  const session = new Session("c1-census", { census: true });
  if (!(await session.boot())) return session.finish({ verdict: "BOOT FAILED" });

  const sessionStartPayload = session.hooks.find((h) => h.event === "SessionStart") ?? null;

  session.host.submitPrompt(
    "Use the Read tool once on ./README-none.txt (it does not exist; do not create it, do not retry, do not use any other tool). Then reply with exactly: DONE",
  );
  const turnOver = await session.waitUntil(() => session.hooks.some((h) => h.event === "Stop"), 180_000);
  const afterTurn = session.at();
  await delay(3000);

  // The ModelSwitch pair. `/model haiku` is the cheapest switch that changes the
  // model for real (SL-4 measured the receipt vocabulary at this binary).
  const slashLanded = await session.sendSlash("/model haiku");
  await delay(8000);
  const modelSwitchHooks = session.hooks.filter((h) => /ModelSwitch/.test(h.event));

  // A second switch, purely to try to get a SECOND pair on the record (a pair
  // that only fires once is not a pair). This is NOT the restore — the restore is
  // the settings-file bracket at the top of this probe, because a slash driven
  // through a composer can be swallowed and this one MEASURABLY was.
  await session.sendSlash("/model opus[1m]");
  await delay(8000);

  // Past the 60s idle threshold: SL-2b measured Notification(idle_prompt) there.
  await delay(60_000);

  return session.finish({
    turnOver,
    afterTurnMs: afterTurn,
    slashLanded,
    sessionStartPayload,
    modelSwitchHooks,
    declared: DECLARED,
    neverFired: DECLARED.filter((e) => !session.eventsSeen().includes(e)),
    verdict: `${session.eventsSeen().length}/${DECLARED.length} declared events fired`,
  });
}

/** c2 — the PRODUCTION approval channel end to end, with Sonata's REAL broker
 *  answering. The question the h2 stdout audit cannot answer alone: does 2.1.258
 *  still ACCEPT the bytes Sonata emits — specifically the `approve-always` shape
 *  with `updatedPermissions`, whose schema is the one that could have drifted?
 *  Ground truth is the FILE: an accepted allow writes it, a rejected/ignored
 *  decision does not. */
async function armApprovalDecision() {
  const session = new Session("c2-approval-decision", { census: false, approvalBroker: true });
  if (!(await session.boot())) return session.finish({ verdict: "BOOT FAILED" });

  const approvalsDir = path.join(session.runtimeDir, "approvals");
  const answered = [];
  // Answer every ask the broker surfaces with the PRODUCTION approve-always JSON
  // (built by the same function the controller uses).
  const { default: _ignored } = { default: null };
  const brokerDecision = (payload) => ({
    hookSpecificOutput: {
      hookEventName: "PermissionRequest",
      decision: {
        behavior: "allow",
        updatedPermissions: alwaysAllowRuleFor(payload),
      },
    },
  });
  const poller = setInterval(() => {
    let entries = [];
    try { entries = fs.readdirSync(approvalsDir); } catch { return; }
    for (const entry of entries) {
      if (!/^ask-.+\.json$/.test(entry)) continue;
      const id = entry.slice("ask-".length, -".json".length);
      if (answered.some((a) => a.id === id)) continue;
      let ask;
      try { ask = JSON.parse(fs.readFileSync(path.join(approvalsDir, entry), "utf8")); } catch { continue; }
      const decision = brokerDecision(ask.payload ?? {});
      answered.push({ id, atMs: session.at(), tool: ask.payload?.tool_name ?? null, decision });
      writeApprovalReply(session.runtimeDir, id, decision);
    }
  }, 100);

  session.host.submitPrompt(
    "Create a file named hello.txt in the current directory containing the single word hi. Then reply with exactly: DONE",
  );
  const turnOver = await session.waitUntil(() => session.hooks.some((h) => h.event === "Stop"), 240_000);
  await delay(4000);
  clearInterval(poller);

  const filePath = path.join(session.workspace, "hello.txt");
  const fileWritten = fs.existsSync(filePath);
  const answeredMarkers = (() => {
    try { return fs.readdirSync(approvalsDir).filter((n) => n.startsWith("answered-")); } catch { return []; }
  })();

  return session.finish({
    turnOver,
    asksAnswered: answered.map((a) => ({ atMs: a.atMs, tool: a.tool, decisionBytes: JSON.stringify(a.decision).length, decision: a.decision })),
    answeredMarkers: answeredMarkers.length,
    fileWritten,
    fileContents: fileWritten ? fs.readFileSync(filePath, "utf8").slice(0, 80) : null,
    verdict: answered.length === 0
      ? "UNREPRODUCED — the broker surfaced no ask (no permission was requested)"
      : fileWritten
        ? `ACCEPTED — ${answered.length} approve-always decision(s) with updatedPermissions, tool ran`
        : `REJECTED — ${answered.length} decision(s) emitted but the tool did not run`,
  });
}

/** The production `alwaysAllowRule` shape, mirrored here so the arm measures the
 *  bytes production would actually send (the controller's own builder is not
 *  exported). Kept deliberately narrow — Bash by first token, Write by tool. */
function alwaysAllowRuleFor(payload) {
  const tool = typeof payload.tool_name === "string" ? payload.tool_name : "";
  const input = payload.tool_input && typeof payload.tool_input === "object" ? payload.tool_input : {};
  if (tool === "Bash") {
    const first = String(input.command ?? "").trim().split(/\s+/, 1)[0] ?? "";
    return first ? [{ type: "addRules", rules: [{ toolName: "Bash", ruleContent: `${first} *` }], behavior: "allow", destination: "session" }] : undefined;
  }
  return [{ type: "addRules", rules: [{ toolName: tool || "Write" }], behavior: "allow", destination: "session" }];
}

const ARMS = {
  "c1-census": armCensus,
  "c2-approval-decision": armApprovalDecision,
};

// ─── run ────────────────────────────────────────────────────────────────────
const RESULT_DIR = path.join(ROOT, "results");
fs.mkdirSync(RESULT_DIR, { recursive: true });

const only = process.argv.slice(2).filter((arg) => !arg.startsWith("-"));
const selected = process.argv.includes("--capture-only") ? [] : only.length > 0 ? only : Object.keys(ARMS);

// `--self-test`: exercise the settings guard END TO END without spawning a CLI —
// mutate the protected file the way a `/model` switch would, then let the normal
// `finally` restore run and assert it took. A guard that has never been observed
// working is not a guard.
if (process.argv.includes("--self-test")) {
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

try {
  for (const name of selected) {
    const arm = ARMS[name];
    if (!arm) { console.error(`unknown arm: ${name}`); process.exitCode = 2; continue; }
    process.stderr.write(`\n=== ${name} ===\n`);
    let result;
    try { result = await arm(); } catch (error) { result = { scenario: name, error: String(error?.stack ?? error) }; }
    result.ranAt = new Date().toISOString();
    fs.writeFileSync(path.join(RESULT_DIR, `${name}.json`), JSON.stringify(result, null, 2));
    process.stderr.write(`${name}: ${result.verdict ?? result.error ?? "?"}\n`);
  }
} finally {
  // UNCONDITIONAL: a thrown arm, a failed boot, or a clean run all leave the
  // user's real `~/.claude/settings.json` exactly as it was found.
  restoreOnce();
}

const endPin = pinVersion("probe end");

const results = Object.keys(ARMS)
  .map((name) => path.join(RESULT_DIR, `${name}.json`))
  .filter((file) => fs.existsSync(file))
  .map((file) => JSON.parse(fs.readFileSync(file, "utf8")));

const census = results.find((r) => r.scenario === "c1-census");
const capture = [
  "# H1 — claude hook-event CENSUS under production injection (SL-9)",
  "",
  `binary: ${version}${endPin.drifted ? ` — DRIFTED to ${endPin.version} at probe end; capture SAVED, exit non-zero` : " (re-pinned at probe end)"}`,
  "spawn: production TerminalHost from dist/, --permission-mode default, injected --settings",
  `declared events in this binary (${DECLARED.length}): ${DECLARED.join(", ")}`,
  "",
  "## which declared events actually fire",
  "",
  census
    ? [
        `| event | fired? | first payload keys |`,
        `|---|---|---|`,
        ...DECLARED.map((event) => {
          const shape = census.shapes?.find((s) => s.event === event);
          return `| ${event} | ${shape ? `**yes** @${shape.atMs}ms` : "no"} | ${shape ? shape.keys.join(", ") : "—"} |`;
        }),
      ].join("\n")
    : "(census arm not run)",
  "",
  "## user-settings guard",
  "",
  "This probe drives real `/model` switches, which PERSIST the default model into",
  "`~/.claude/settings.json`. The bytes are snapshotted before any arm and written",
  "back unconditionally afterwards; this is what that guard saw:",
  "",
  "```json",
  JSON.stringify(settingsRestore, null, 2),
  "```",
  "",
  "## per-arm detail",
  "",
  ...results.map((result) => [`### ${result.scenario}`, "", "```json", sanitize(JSON.stringify(result, null, 2)), "```", ""].join("\n")),
].join("\n");

fs.writeFileSync(path.join(OUT_DIR, "h1-hook-census.capture.txt"), capture);
console.log(JSON.stringify({
  success: results.every((r) => !r.error) && !endPin.drifted,
  version,
  endVersion: endPin.version,
  declaredCount: DECLARED.length,
  arms: results.map((r) => ({ scenario: r.scenario, verdict: r.verdict ?? r.error ?? "?", eventsSeen: r.eventsSeen })),
  userSettingsGuard: settingsRestore,
}, null, 2));
if (endPin.drifted) process.exit(3);

function compactPayload(payload = {}) {
  const keep = {};
  for (const key of ["kind", "decision", "encodedAs", "reason", "exitCode", "signal", "sonataInitiated", "source"]) {
    if (payload[key] !== undefined) keep[key] = payload[key];
  }
  return keep;
}

function delay(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }
