// Z2 (2026-09 sync, SL-12 / decision D1) — SPONTANEOUS RESUMPTION, shape (b):
// the INTERRUPTED-TURN auto-resume, and the TRIGGER SCOPE Woody asked for.
//
// THE HYPOTHESIS UNDER TEST (D1, Woody): "user Esc is EXEMPT from auto-resume —
// the CLI needs Esc to stick too." Confirm or refute, and state the scope.
//
// WHAT THE BINARY SAYS (static, 2.1.258 — the map this probe was built to test).
// `CLAUDE_CODE_RESUME_INTERRUPTED_TURN` is not a user setting and not a default;
// it is an env var the CLI sets ON ITSELF when it respawns its own child, at
// exactly two sites:
//   - the cloud-runner session spawner, when the worker epoch is > 1
//     (`CLAUDE_CODE_RESUME_INTERRUPTED_TURN: o > 1 ? "1" : void 0`), and
//   - the background-session PTY manager, on a retry attempt
//     (`if (this.attempt > 1 && g && !i) U.CLAUDE_CODE_RESUME_INTERRUPTED_TURN = "1"`).
// It is READ in one place, and only while RESTORING a transcript into a fresh
// process — whose own debug line names the case: "[sessionRestore] Auto-resuming
// interrupted turn for bg crash-respawn". It also travels in `lme`, the list of
// `CLAUDE_BG_*`-family variables the CLI SCRUBS from what it spawns.
//
// So the static reading is: auto-resume belongs to CRASH RESPAWN, not to the
// interactive session, and nothing in a live session re-submits a turn the user
// stopped. That is a claim about code the probe cannot see running, so it is a
// HYPOTHESIS until measured — and "I read the bundle and it looked exempt" is not
// the evidence D1 asked for. Three arms measure it:
//
//   z2a — LIVE Esc, production path. Esc a streaming turn through the real
//         `TerminalHost` and then write NOTHING for three minutes. Anything that
//         happens in that window is the CLI acting on its own. This is the arm
//         that answers the question as the user meets it.
//   z2b — Esc, kill the session, RESUME it. Same interrupted transcript, fresh
//         process, no env var — i.e. the shape a user gets from `--continue`.
//   z2c — identical to z2b except `CLAUDE_CODE_RESUME_INTERRUPTED_TURN=1` is set
//         on the spawn. The CONTRAST arm, and the reason this probe can state a
//         SCOPE rather than an absence: if z2c resumes and z2b does not, then the
//         exemption is real AND its exact boundary is named — one env var that
//         Sonata never sets, set by the CLI only when it respawns itself.
//
// z2b/z2c deliberately drive a RAW pty rather than `TerminalHost`: the question
// is what the CLI does on restore, `startTask` does not take `--continue` or a
// spawn env, and the 2026-08 canonical `Probe` strips every `CLAUDE*` variable
// from the child (driver.mjs:41) — which would silently delete z2c's entire
// independent variable. A local spawn is the honest instrument here.
//
// GROUND TRUTH IS THE TRANSCRIPT, not the screen. An auto-resume injects a user
// message whose content is `CLAUDE_CODE_RESUME_PROMPT || "Continue from where you
// left off."`, flagged `isMeta`. The jsonl under ~/.claude/projects records it
// either way, so each resume arm ends by reading its own session file back.
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
const pty = require("node-pty");
const { TerminalHost, HookWatcher, claudeHooksDirectory } = require(APP_DIR + "dist/runtime");

const EXPECT_VERSION = "2.1.258";
const ROOT = "/private/tmp/sonata-sync-2026-09/esc-resume";
const COLS = 120;
const ROWS = 40;

// The interruptible turn: long, pure TEXT, no tools. A tool call would raise a
// permission prompt under `--permission-mode default` and make the arm about
// approvals instead of about Esc.
const LONG_TURN_PROMPT =
  "Count from 1 to 400. Print one number per line, nothing else — no preamble, no commentary, no tools.";
// How long to sit after the Esc writing NOTHING. SL-2b watched 108s; this covers
// that with margin, and past the 60s idle-notification threshold.
const WATCH_AFTER_ESC_MS = 180_000;
// How long a resumed session is watched for an unprompted turn.
const WATCH_AFTER_RESUME_MS = 90_000;
const RESUME_PROMPT_NEEDLE = "Continue from where you left off";

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
  console.log(JSON.stringify({ success: false, reason: `binary moved off ${EXPECT_VERSION} at start`, version: startPin.version }));
  process.exit(2);
}
const version = startPin.version;

// ─── user-settings guard (SL-9 F41 / F4h incident) ──────────────────────────
// Unconditional, for the reason F4h taught: the failure was not a probe that
// switched models without a guard, it was a probe that mutated the user's config
// and read its own evidence of it as missing data. A snapshot/restore bracket is
// cheap; being wrong about which probes can write is not.
const CLAUDE_SETTINGS =
  process.env.SONATA_PROBE_SETTINGS_PATH || path.join(os.homedir(), ".claude", "settings.json");

function snapshotUserSettings() {
  try { return { path: CLAUDE_SETTINGS, bytes: fs.readFileSync(CLAUDE_SETTINGS, "utf8") }; } catch { return null; }
}
function diffJsonKeys(beforeText, afterText) {
  try {
    const before = JSON.parse(beforeText);
    const after = JSON.parse(afterText ?? "{}");
    return [...new Set([...Object.keys(before), ...Object.keys(after)])]
      .filter((key) => JSON.stringify(before[key]) !== JSON.stringify(after[key]))
      .map((key) => `${key}: ${JSON.stringify(before[key])} → ${JSON.stringify(after[key])}`);
  } catch { return ["<unparseable; bytes differ>"]; }
}
function restoreUserSettings(snapshot) {
  if (!snapshot) return { checked: false };
  let after = null;
  try { after = fs.readFileSync(snapshot.path, "utf8"); } catch { /* deleted under us */ }
  if (after === snapshot.bytes) return { checked: true, mutatedByProbe: false, restored: true };
  try { fs.writeFileSync(snapshot.path, snapshot.bytes, "utf8"); }
  catch (error) { return { checked: true, mutatedByProbe: true, restored: false, error: String(error?.message ?? error) }; }
  const verified = (() => { try { return fs.readFileSync(snapshot.path, "utf8") === snapshot.bytes; } catch { return false; } })();
  return { checked: true, mutatedByProbe: true, restored: verified, changedKeys: diffJsonKeys(snapshot.bytes, after) };
}
const userSettings = snapshotUserSettings();
let settingsRestore = { checked: false };
const restoreOnce = () => {
  if (settingsRestore.checked) return settingsRestore;
  settingsRestore = restoreUserSettings(userSettings);
  if (settingsRestore.mutatedByProbe) {
    process.stderr.write(`\n[settings guard] the probe changed ~/.claude/settings.json (${(settingsRestore.changedKeys ?? []).join("; ")}) — restored: ${settingsRestore.restored}\n`);
  }
  return settingsRestore;
};
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => { restoreOnce(); process.exit(130); });
}

// ─── transcript reading (the ground truth) ──────────────────────────────────

/** claude's per-project transcript directory for a workspace path. */
function projectDirFor(workspace) {
  return path.join(HOME, ".claude", "projects", workspace.replace(/\//g, "-"));
}

/** Every session file for a workspace, newest first. */
function sessionFiles(workspace) {
  const dir = projectDirFor(workspace);
  let names = [];
  try { names = fs.readdirSync(dir).filter((n) => n.endsWith(".jsonl")); } catch { return []; }
  return names
    .map((name) => {
      const file = path.join(dir, name);
      return { file, mtimeMs: fs.statSync(file).mtimeMs };
    })
    .sort((a, b) => b.mtimeMs - a.mtimeMs)
    .map((entry) => entry.file);
}

/** The turn spine of a transcript: who authored each user message, and whether an
 *  interruption was recorded. `promptSource` is the CLI's own discriminator —
 *  `typed` for the composer, `system` for a machine-injected turn. */
function readTurns(file) {
  let lines = [];
  try { lines = fs.readFileSync(file, "utf8").trim().split("\n"); } catch { return null; }
  const rows = [];
  let interruptionMarkers = 0;
  for (const line of lines) {
    let entry;
    try { entry = JSON.parse(line); } catch { continue; }
    const content = entry.message?.content;
    const text = Array.isArray(content)
      ? content.map((b) => (b.type === "text" ? b.text : `[${b.type}]`)).join(" ")
      : typeof content === "string" ? content : "";
    if (/\[Request interrupted|interrupted by user/i.test(text)) interruptionMarkers++;
    if (entry.type !== "user" && entry.type !== "assistant") continue;
    rows.push({
      type: entry.type,
      promptSource: entry.promptSource ?? null,
      isMeta: entry.isMeta === true,
      text: sanitize(text).replace(/\s+/g, " ").slice(0, 120),
    });
  }
  return { rows, interruptionMarkers };
}

// ─── z2a: the live Esc, through Sonata's production path ────────────────────

class HostSession {
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
      taskId: `task-z2-${name}`,
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
    if (event.type === "pty:data") { this.raw += event.payload.data; this.term.write(event.payload.data); return; }
    if (event.type === "report:updated" || event.type === "file:changed") return;
    if (event.type === "pty:exit") this.ptyExited = true;
    this.events.push({ atMs: this.at(), type: event.type, payload: compactPayload(event.payload) });
  }

  onHookPayload(payload) {
    const event = typeof payload.hook_event_name === "string" ? payload.hook_event_name : "<none>";
    this.hooks.push({ atMs: this.at(), event, keys: Object.keys(payload).sort(), notificationType: payload.notification_type ?? null, prompt: typeof payload.prompt === "string" ? sanitize(payload.prompt).slice(0, 200) : undefined, source: payload.source ?? "<field absent>" });
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
    this.host.startTask({ cwd: this.workspace, runtimeDir: this.runtimeDir, permissionMode: "default", rows: ROWS, cols: COLS, approvalBroker: false });
    this.watcher.watchWorkspace(this.runtimeDir);
    // Trust dialog: the EVENT path must win, because `approval:detected` latches
    // `approvalActive` and only `sendApprove()` clears it — a grid walk answers
    // the dialog but leaves the host permanently not-ready (z1's measured
    // `ready=false at 90207ms`). Grid walk stays as the fallback for a spawn that
    // raises no such event.
    const trustDetected = () => this.events.some((e) => e.type === "approval:detected" && e.payload?.kind === "workspace-trust");
    let trustAnswered = false;
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
    if (!trustAnswered && !this.host.acceptsPromptInput() && !this.ptyExited) {
      const affirmFocused = () => this.screen().split("\n").some((l) => /❯\s*Yes, I trust this folder/i.test(l));
      if (/Yes, I trust this folder/i.test(this.screen())) {
        for (let i = 0; i < 6 && !affirmFocused(); i++) { await delay(500); this.host.writeRaw("\x1b[B"); await delay(350); }
        if (affirmFocused()) { this.host.writeRaw("\r"); this.notes.push(`trust dialog answered from the grid at ${this.at()}ms`); }
      }
    }
    const deadline = Date.now() + 90_000;
    let ok = false;
    while (Date.now() < deadline && !this.ptyExited) {
      if (this.host.acceptsPromptInput()) { ok = true; break; }
      await delay(200);
    }
    this.notes.push(`ready=${ok} at ${this.at()}ms`);
    await delay(2000);
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

  finish(extra = {}) {
    const out = { scenario: this.name, version, hookOrder: this.hooks.map((h) => `${h.event}@${h.atMs}`), hooks: this.hooks, notes: this.notes, events: this.events, ptyExited: this.ptyExited, screenTail: sanitize(this.screen().split("\n").slice(-16).join("\n")), ...extra };
    try { this.watcher.dispose(); this.host.dispose(); this.term.dispose(); } catch { /* best-effort */ }
    return out;
  }
}

function compactPayload(payload = {}) {
  const keep = {};
  for (const key of ["kind", "decision", "reason", "exitCode", "signal", "sonataInitiated", "source", "status", "phase", "confidence"]) {
    if (payload[key] !== undefined) keep[key] = typeof payload[key] === "string" ? sanitize(payload[key]).slice(0, 200) : payload[key];
  }
  return keep;
}

async function armLiveEsc() {
  const session = new HostSession("z2a-live-esc");
  if (!(await session.boot())) return session.finish({ verdict: "BOOT FAILED" });

  session.host.submitPrompt(LONG_TURN_PROMPT);
  // Wait until the turn is provably STREAMING — Esc'ing before the model has
  // started would interrupt nothing and the arm would measure a no-op.
  const streaming = await session.waitUntil(() => /\n\s*1\s*\n/.test(session.screen()) || /\b(2[0-9]|3[0-9])\b/.test(session.screen()), 90_000);
  await delay(1500);
  const rawLenBefore = session.raw.length;
  const escAtMs = session.at();
  const screenBeforeEsc = sanitize(session.screen().split("\n").slice(-8).join("\n"));

  // The user's own Esc, as bytes — not `stopRun()`. The hypothesis is about what
  // the CLI does with the user's interrupt, so the probe sends the user's key.
  session.host.writeRaw("\x1b");

  // From here on the probe writes NOTHING. Every byte, hook and run event below
  // is the CLI and Sonata acting without input.
  const hooksAfterEsc = () => session.hooks.filter((h) => h.atMs > escAtMs);
  const resumed = await session.waitUntil(
    () => hooksAfterEsc().some((h) => h.event === "UserPromptSubmit" || h.event === "Stop"),
    WATCH_AFTER_ESC_MS,
  );
  await delay(3000);

  const turns = (() => {
    const files = sessionFiles(session.workspace);
    return files.length ? readTurns(files[0]) : null;
  })();

  return session.finish({
    streamingBeforeEsc: streaming,
    escAtMs,
    screenBeforeEsc,
    bytesPaintedAfterEsc: session.raw.length - rawLenBefore,
    hooksAfterEsc: hooksAfterEsc().map((h) => `${h.event}${h.notificationType ? `(${h.notificationType})` : ""}@+${h.atMs - escAtMs}ms`),
    runEventsAfterEsc: session.events.filter((e) => e.atMs > escAtMs && e.type.startsWith("run:")).map((e) => `${e.type}@+${e.atMs - escAtMs}ms`),
    // Sonata's OWN verdict, and when it reached it — SL-2b's stopless closer is
    // what ends the run here, since Esc fires no hook.
    sonataClosedRunAtMs: (session.events.find((e) => e.atMs > escAtMs && e.type === "run:updated" && e.payload?.status === "completed")?.atMs ?? null),
    transcriptTurns: turns?.rows ?? null,
    transcriptInterruptionMarkers: turns?.interruptionMarkers ?? null,
    autoResumedInTranscript: (turns?.rows ?? []).some((r) => r.text.includes(RESUME_PROMPT_NEEDLE)),
    verdict: resumed
      ? `RESUMED — the CLI started a turn on its own within ${Math.round(WATCH_AFTER_ESC_MS / 1000)}s of a user Esc`
      : `NO RESUME — ${Math.round(WATCH_AFTER_ESC_MS / 1000)}s after a user Esc the CLI did nothing unprompted`,
  });
}

// ─── z2b / z2c: Esc, kill, restore ──────────────────────────────────────────

/** A raw pty running claude, with the spawn ENV under the arm's control. The
 *  2026-08 canonical `Probe` deletes every `CLAUDE*` variable from the child,
 *  which is correct for its own purpose (do not let the CLI think it is nested)
 *  and fatal for z2c, whose independent variable is exactly such a variable. Same
 *  scrub, then the arm's overrides applied AFTER it. */
class EnvProbe {
  constructor({ cwd, args = [], env: overrides = {}, cmd = "claude" }) {
    this.raw = "";
    this.exited = false;
    this.exitInfo = null;
    this.term = new Terminal({ cols: COLS, rows: ROWS, allowProposedApi: true, scrollback: 4000 });
    const env = { ...process.env };
    for (const key of Object.keys(env)) {
      if (/^(CLAUDE|ANTHROPIC_MODEL|AI_AGENT)/i.test(key)) delete env[key];
    }
    env.TERM = "xterm-256color";
    Object.assign(env, overrides);
    this.env = overrides;
    this.pty = pty.spawn(cmd, args, { name: "xterm-256color", cols: COLS, rows: ROWS, cwd, env });
    this.pty.onData((d) => { this.raw += d; this.term.write(d); });
    this.pty.onExit((e) => { this.exited = true; this.exitInfo = e; });
  }
  write(s) { this.pty.write(s); }
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
  /** The predicate is tested BEFORE the exit guard, and once more after the loop.
   *  A short-lived child (z2d's `/bin/sh -c echo`) writes its output and exits in
   *  the same breath, so an `exited`-first loop can return false for a screen
   *  that plainly carries the match — measured: z2d reported PLUMBING BROKEN
   *  while quoting `SEEN:[1]` from its own screen. Exit is not evidence of
   *  absence; the buffer outlives the process. */
  async waitFor(re, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      if (re.test(this.screen())) return true;
      if (this.exited || Date.now() >= deadline) break;
      await delay(200);
    }
    return re.test(this.screen());
  }
  kill() { try { this.pty.kill(); } catch { /* already gone */ } }
}

/** Boot a raw probe to a composer, answering the trust dialog off the grid
 *  (SL-1: grid-verified Down then CR — the 2.1.252+ default row is "No, exit"). */
async function bootRaw(probe, notes) {
  const sawTrust = await probe.waitFor(/Quick safety check|trust this folder/i, 30_000);
  if (sawTrust) {
    const affirmFocused = () => probe.screen().split("\n").some((l) => /❯\s*Yes, I trust this folder/i.test(l));
    for (let i = 0; i < 6 && !affirmFocused(); i++) { await delay(500); probe.write("\x1b[B"); await delay(350); }
    if (affirmFocused()) { probe.write("\r"); notes.push("trust dialog answered from the grid"); }
    else notes.push("trust dialog: affirm row never focused — NOT answered");
  }
  const ok = await probe.waitFor(/for shortcuts|Welcome back|Try "|❯/i, 60_000);
  notes.push(`raw boot reached composer: ${ok} (trustDialogSeen=${sawTrust})`);
  await delay(2500);
  return ok;
}

/** Create a session whose newest turn was INTERRUPTED BY THE USER, then leave the
 *  process. Shared by z2b and z2c so both restore the same kind of transcript. */
async function makeInterruptedSession(workspace, notes) {
  const probe = new EnvProbe({ cwd: workspace, args: ["--permission-mode", "default"] });
  if (!(await bootRaw(probe, notes))) { probe.kill(); return { ok: false }; }
  probe.write(LONG_TURN_PROMPT);
  await delay(800);
  probe.write("\r");
  const streaming = await probe.waitFor(/\b(2[0-9]|3[0-9])\b/, 90_000);
  notes.push(`interruptible turn reached streaming: ${streaming}`);
  await delay(1500);
  probe.write("\x1b");
  await delay(4000);
  notes.push("user Esc sent to the raw session");
  // Leave the process the way a user closing the app would — the transcript is
  // already on disk, and `/exit` would end the turn cleanly rather than leaving
  // it interrupted.
  probe.kill();
  await delay(2000);
  return { ok: true, streaming };
}

/** z2b / z2c — restore the interrupted session and watch it, having typed
 *  nothing. `envOverrides` is the ONLY difference between the two arms. */
async function armRestore(name, envOverrides) {
  const notes = [];
  const runRoot = path.join(ROOT, name);
  fs.rmSync(runRoot, { recursive: true, force: true });
  const workspace = path.join(runRoot, "ws");
  fs.mkdirSync(workspace, { recursive: true });

  const made = await makeInterruptedSession(workspace, notes);
  if (!made.ok) return { scenario: name, version, notes, verdict: "SETUP FAILED — could not create an interrupted session" };

  const beforeFiles = sessionFiles(workspace);
  const transcriptBefore = beforeFiles.length ? readTurns(beforeFiles[0]) : null;
  notes.push(`interrupted transcript: ${transcriptBefore?.rows.length ?? 0} turns, ${transcriptBefore?.interruptionMarkers ?? 0} interruption marker(s)`);

  // `--continue` rather than `--resume <id>`: it restores the most recent session
  // for this cwd through the same sessionRestore path, without the id-picker
  // surface that `--resume` can open. The workspace is this arm's alone, so
  // "most recent" is unambiguous.
  const probe = new EnvProbe({ cwd: workspace, args: ["--continue", "--permission-mode", "default"], env: envOverrides });
  const t0 = Date.now();
  const booted = await bootRaw(probe, notes);
  const rawLenAtBoot = probe.raw.length;

  // Watch, writing NOTHING. A resume shows up as the CLI going busy on its own;
  // the transcript below is what decides it.
  let busySighting = null;
  const deadline = Date.now() + WATCH_AFTER_RESUME_MS;
  while (Date.now() < deadline && !probe.exited) {
    const screen = probe.screen();
    if (busySighting === null && /esc to interrupt|Continue from where you left off/i.test(screen)) {
      busySighting = Date.now() - t0;
      notes.push(`unprompted activity on screen at +${busySighting}ms`);
    }
    await delay(300);
  }

  const afterFiles = sessionFiles(workspace);
  const transcriptAfter = afterFiles.length ? readTurns(afterFiles[0]) : null;
  const resumeTurn = (transcriptAfter?.rows ?? []).find((r) => r.text.includes(RESUME_PROMPT_NEEDLE)) ?? null;
  // Proof the restore actually RESTORED. Without it, "no auto-resume" could just
  // be "`--continue` started a fresh session and there was no interrupted turn to
  // resume" — a negative about the probe, not about the CLI.
  const restoredHistoryVisible = /Count from 1 to 400|Request interrupted/i.test(probe.screen())
    || (transcriptAfter?.rows ?? []).some((r) => r.text.includes("Count from 1 to 400"));
  probe.kill();

  return {
    scenario: name,
    version,
    envOverrides,
    notes,
    booted,
    bytesPaintedAfterBoot: probe.raw.length - rawLenAtBoot,
    busySightingMs: busySighting,
    interruptionMarkersBefore: transcriptBefore?.interruptionMarkers ?? null,
    turnsBefore: transcriptBefore?.rows.length ?? null,
    turnsAfter: transcriptAfter?.rows.length ?? null,
    sessionFilesBefore: beforeFiles.length,
    sessionFilesAfter: afterFiles.length,
    restoredHistoryVisible,
    resumeTurn,
    autoResumed: resumeTurn !== null,
    transcriptTail: (transcriptAfter?.rows ?? []).slice(-6),
    screenTail: sanitize(probe.screen().split("\n").slice(-14).join("\n")),
    verdict: resumeTurn !== null
      ? `AUTO-RESUMED — the restored session injected "${RESUME_PROMPT_NEEDLE}…" with no user input`
      : `NO AUTO-RESUME — the restored session sat at its composer for ${Math.round(WATCH_AFTER_RESUME_MS / 1000)}s`,
  };
}

/** z2d — the PLUMBING control for z2c, and the reason z2c's negative is worth
 *  anything. A negative result from "set the env var and nothing happened" has
 *  two readings: the CLI ignored the variable, or the variable never arrived.
 *  macOS blocks reading another process's environment (`ps eww` returns the
 *  command line and no `KEY=value` pairs, measured), so the arrival has to be
 *  demonstrated rather than inspected: spawn a shell through the SAME `EnvProbe`
 *  path, with the SAME overrides, and have it print the variable back.
 *
 *  What this does and does not establish: it proves the scrub-then-override in
 *  `EnvProbe` delivers this exact name to a child of this exact spawn. It does
 *  not prove the CLI reads it — nothing outside the binary can — so z2c's
 *  conclusion stays scoped to "set on the spawn", which is the only lever anyone
 *  outside the CLI has anyway. */
async function armEnvPlumbing() {
  const workspace = path.join(ROOT, "z2d-env-plumbing");
  fs.rmSync(workspace, { recursive: true, force: true });
  fs.mkdirSync(workspace, { recursive: true });
  const overrides = { CLAUDE_CODE_RESUME_INTERRUPTED_TURN: "1" };
  const probe = new EnvProbe({
    cwd: workspace,
    cmd: "/bin/sh",
    args: ["-c", 'echo "SEEN:[${CLAUDE_CODE_RESUME_INTERRUPTED_TURN}]"'],
    env: overrides,
  });
  const saw = await probe.waitFor(/SEEN:\[1\]/, 15_000);
  const screen = probe.screen();
  probe.kill();
  return {
    scenario: "z2d-env-plumbing",
    version,
    envOverrides: overrides,
    childEcho: screen.split("\n").find((l) => l.includes("SEEN:")) ?? null,
    verdict: saw
      ? "PLUMBING OK — the override reaches a child of this exact spawn path (child echoed SEEN:[1])"
      : `PLUMBING BROKEN — the child did not echo the variable; z2c's negative is UNINTERPRETABLE (screen: ${JSON.stringify(screen.slice(0, 200))})`,
  };
}

const ARMS = {
  "z2a-live-esc": armLiveEsc,
  "z2d-env-plumbing": armEnvPlumbing,
  // No env override: the shape a user gets from `--continue`.
  "z2b-restore-plain": () => armRestore("z2b-restore-plain", {}),
  // The contrast arm. One variable.
  "z2c-restore-resume-env": () => armRestore("z2c-restore-resume-env", { CLAUDE_CODE_RESUME_INTERRUPTED_TURN: "1" }),
};

// ─── run ────────────────────────────────────────────────────────────────────
const RESULT_DIR = path.join(ROOT, "results");
fs.mkdirSync(RESULT_DIR, { recursive: true });

if (process.argv.includes("--self-test")) {
  if (!userSettings) { console.log(JSON.stringify({ selfTest: "SKIP — no settings file at " + CLAUDE_SETTINGS })); process.exit(0); }
  const mutated = userSettings.bytes.replace(/"model":\s*"[^"]*"/, '"model": "haiku"');
  fs.writeFileSync(CLAUDE_SETTINGS, mutated, "utf8");
  const seenMutated = fs.readFileSync(CLAUDE_SETTINGS, "utf8");
  const verdict = restoreOnce();
  const finalBytes = fs.readFileSync(CLAUDE_SETTINGS, "utf8");
  console.log(JSON.stringify({ selfTest: true, settingsPath: CLAUDE_SETTINGS, mutationLanded: seenMutated !== userSettings.bytes, guard: verdict, bytesBackToOriginal: finalBytes === userSettings.bytes, pass: seenMutated !== userSettings.bytes && verdict.restored === true && finalBytes === userSettings.bytes }, null, 2));
  process.exit(0);
}

const only = process.argv.slice(2).filter((arg) => !arg.startsWith("-"));
const selected = process.argv.includes("--capture-only") ? [] : only.length > 0 ? only : Object.keys(ARMS);

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
  restoreOnce();
}

const endPin = pinVersion("probe end");

const results = Object.keys(ARMS)
  .map((name) => path.join(RESULT_DIR, `${name}.json`))
  .filter((file) => fs.existsSync(file))
  .map((file) => JSON.parse(fs.readFileSync(file, "utf8")));

const live = results.find((r) => r.scenario === "z2a-live-esc");
const plain = results.find((r) => r.scenario === "z2b-restore-plain");
const withEnv = results.find((r) => r.scenario === "z2c-restore-resume-env");

const capture = [
  "# Z2 — spontaneous resumption shape (b): the Esc auto-resume TRIGGER SCOPE (SL-12 / D1)",
  "",
  `binary: ${version}${endPin.drifted ? ` — DRIFTED to ${endPin.version} at probe end; capture SAVED, exit non-zero` : " (re-pinned at probe end)"}`,
  "z2a spawn: production TerminalHost from dist/. z2b/z2c: raw pty, `claude --continue`.",
  "",
  "## the live Esc (z2a) — production path, nothing written after the Esc",
  "",
  live
    ? [
        `- turn was streaming when Esc was sent: **${live.streamingBeforeEsc}**`,
        `- hooks in the ${Math.round(WATCH_AFTER_ESC_MS / 1000)}s after the Esc: ${JSON.stringify(live.hooksAfterEsc)}`,
        `- Sonata run events after the Esc: ${JSON.stringify(live.runEventsAfterEsc)}`,
        `- bytes painted after the Esc: ${live.bytesPaintedAfterEsc}`,
        `- transcript interruption markers: ${live.transcriptInterruptionMarkers}`,
        `- an auto-resume prompt in the transcript: **${live.autoResumedInTranscript}**`,
        `- **${live.verdict}**`,
      ].join("\n")
    : "(arm not run)",
  "",
  "## the restore contrast (z2b vs z2c) — one variable",
  "",
  "| | z2b `--continue` | z2c `--continue` + `CLAUDE_CODE_RESUME_INTERRUPTED_TURN=1` |",
  "|---|---|---|",
  `| interruption markers in the restored transcript | ${plain?.interruptionMarkersBefore} | ${withEnv?.interruptionMarkersBefore} |`,
  `| turns before restore | ${plain?.turnsBefore} | ${withEnv?.turnsBefore} |`,
  `| turns after the watch | ${plain?.turnsAfter} | ${withEnv?.turnsAfter} |`,
  `| the restore actually restored the history | ${plain?.restoredHistoryVisible} | ${withEnv?.restoredHistoryVisible} |`,
  `| unprompted activity on screen | ${plain?.busySightingMs ?? "none"} | ${withEnv?.busySightingMs ?? "none"} |`,
  `| **auto-resumed** | **${plain?.autoResumed}** | **${withEnv?.autoResumed}** |`,
  `| verdict | ${plain?.verdict} | ${withEnv?.verdict} |`,
  "",
  "## user-settings guard",
  "",
  "```json",
  JSON.stringify(settingsRestore, null, 2),
  "```",
  "",
  "## per-arm detail",
  "",
  ...results.map((result) => [`### ${result.scenario}`, "", "```json", sanitize(JSON.stringify(result, null, 2)), "```", ""].join("\n")),
].join("\n");

fs.writeFileSync(path.join(OUT_DIR, "z2-esc-resume-scope.capture.txt"), capture);
console.log(JSON.stringify({
  success: results.every((r) => !r.error) && !endPin.drifted,
  version,
  endVersion: endPin.version,
  arms: results.map((r) => ({ scenario: r.scenario, verdict: r.verdict ?? r.error ?? "?" })),
  userSettingsGuard: settingsRestore,
}, null, 2));
if (endPin.drifted) process.exit(3);

function delay(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }
