// Q18 (2026-09 sync, SL-5) — the OFF-CYCLE origins, the PRODUCTION drive, and
// the permission MIRROR under a flip Sonata did not perform.
//
// Q17 answered the happy path: the cycle is exactly `default → acceptEdits →
// plan → auto → default` at 2.1.258, 27ms per step, `bypassPermissions` not in
// it. It also turned up a mode the tables do not know — a `--permission-mode
// dontAsk` spawn paints `⏵⏵ don't ask on (shift+tab to cycle)`, which
// `parseClaudePermissionModeLine` reads as NULL. That makes three questions
// this probe has to answer before any table is touched:
//
//   E — OFF-CYCLE ORIGINS. `expectedPermissionLandings` gives an off-cycle
//       origin (`dontAsk` / `bypassPermissions`) a blind-seek exemption: ANY
//       cycle member is an accepted first landing. That models an origin the
//       cycle cannot return to. Is that true at 2.1.258? Walk Shift+Tab 8 times
//       from each, reading the mode line every step. Two things decide code:
//       (1) does the walk RE-ENTER the origin (if so the engine's return-home
//       could actually get there, and today it cannot recognize the arrival);
//       (2) do these origins even paint a phrase the parser knows.
//       `bypassPermissions` is spawned READ-ONLY — no prompt is ever submitted,
//       the pty is killed after the walk. Observing the mode it paints is
//       exactly what keeps the parser table honest; Sonata still never DRIVES
//       into it (Q17 measured it off-cycle, so it cannot).
//
//   F — THE PRODUCTION DRIVE. Q17 pressed keys by hand. This arm runs the real
//       `TerminalHost.injectClaudeControlSwitch("permission", …)` and reads the
//       `control-switch:state` events, so the claim "the engine settles" is
//       measured on the engine, not on a probe's imitation of it.
//
//   G — THE MIRROR UNDER AN UNDRIVEN FLIP. Sonata's permission SSOT is the hook
//       payload's `permission_mode` (`applyHookPermissionMode`), reconciled
//       LAZILY — on the next hook event, whenever that is. A mode change Sonata
//       did not drive (the user's own Shift+Tab in the Terminal pane; a
//       server-side or Remote-Control flip) is the same shape from the mirror's
//       point of view: nobody told it. So the measurable question is: after an
//       undriven flip, does ANY hook fire on its own — and if not, how long does
//       the mirror stay wrong, and what finally corrects it? Measured with the
//       production HookWatcher, and the answer is what decides whether the mode
//       line has to become a second (weaker) mirror source or stay receipt-only.
//
// Scratch dirs are /private/tmp/... (never the agent scratchpad, whose path
// embeds the username): these frames become findings and the pre-push leak
// fence scans blob content.
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
  ensureClaudeRuntimeSettings,
  parseClaudePermissionModeLine,
  CLAUDE_MODE_LINE_ON_SCREEN_RE,
} = require(APP_DIR + "dist/runtime");

const { Probe, Capture, KEYS, sleep } = await import("../../upstream-sync-2026-08/claude/driver.mjs");

const EXPECT_VERSION = "2.1.258";
const ROOT = "/private/tmp/sonata-sync-2026-09/permission-drive";
const COLS = 120;
const ROWS = 40;
const SCAN_LIMIT = 4096;

const HOME = os.homedir();
const USER_MUNGED = `-${HOME.replace(/\//g, "-").replace(/^-/, "")}-`;
const sanitize = (value) =>
  String(value).split(HOME).join("$HOME").split(USER_MUNGED).join("-$USER_MUNGED-");

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

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

function modeLineRow(screen) {
  for (const line of screen.split("\n")) {
    const t = line.trim();
    if (/[⏸⏵]/.test(t)) return t;
  }
  return null;
}

// ─── Arm E: off-cycle origins (raw Probe — the question is the CLI's) ────────

async function bootRaw(label, permissionMode) {
  const cwd = path.join(ROOT, label);
  const runtimeDir = path.join(ROOT, `${label}-runtime`);
  fs.mkdirSync(cwd, { recursive: true });
  fs.mkdirSync(runtimeDir, { recursive: true });
  const settingsPath = ensureClaudeRuntimeSettings(runtimeDir, {});
  const p = new Probe({
    cwd,
    rows: ROWS,
    cols: COLS,
    args: ["--permission-mode", permissionMode, "--settings", settingsPath],
  });
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
  // Wait on the COMPOSER, not the mode line: an off-cycle origin may paint a
  // phrase the mode-line needle does not know, which is half the question.
  const ready = await p.waitFor(/❯/, 60_000);
  await sleep(2500);
  return p;
}

async function armE(cap, results) {
  results.e = [];
  for (const origin of ["dontAsk", "bypassPermissions"]) {
    const p = await bootRaw(`e-${origin}`, origin);
    const scan = { s: "" };
    p.pty.onData((chunk) => {
      scan.s = (scan.s + chunk).slice(-SCAN_LIMIT);
    });
    try {
      scan.s = p.raw.slice(-SCAN_LIMIT);
      const boot = {
        gridRow: modeLineRow(p.screen()),
        parser: parseClaudePermissionModeLine(scan.s),
        readinessNeedle: CLAUDE_MODE_LINE_ON_SCREEN_RE.test(p.screen()),
      };
      cap.frame(p, `E — boot --permission-mode ${origin}`);
      const walk = [];
      // 8 presses: two full 4-mode cycles' worth, so a re-entry into the origin
      // would have to show up if the origin is a cycle member at all.
      for (let i = 0; i < 8; i++) {
        scan.s = "";
        p.write(KEYS.shiftTab);
        await sleep(700);
        walk.push({
          press: i + 1,
          gridRow: modeLineRow(p.screen()),
          parser: parseClaudePermissionModeLine(scan.s),
          readinessNeedle: CLAUDE_MODE_LINE_ON_SCREEN_RE.test(p.screen()),
        });
        cap.frame(p, `E — ${origin} press ${i + 1}`);
      }
      const entry = {
        origin,
        boot,
        walk,
        // The two decisions this arm feeds:
        reEntersOrigin: walk.some((s) => s.gridRow && boot.gridRow && s.gridRow === boot.gridRow),
        parserBlindAtOrigin: boot.parser === null,
      };
      results.e.push(entry);
      cap.add(`E — ${origin} verdict`, JSON.stringify(entry, null, 2));
    } finally {
      p.kill();
      await sleep(600);
    }
  }
}

// ─── Arms F + G: the production engine and the mirror (real TerminalHost) ────

class HostSession {
  constructor(name) {
    this.name = name;
    this.t0 = Date.now();
    this.hooks = [];
    this.switchEvents = [];
    this.raw = "";
    this.notes = [];
    this.ptyExited = false;
    /** The production SSOT replay: `applyHookPermissionMode` writes the mode off
     *  EVERY hook payload that carries one. This is that write, and nothing else
     *  — the mirror's value and the instant it moved. */
    this.mirror = null;
    this.mirrorHistory = [];

    const runRoot = path.join(ROOT, name);
    fs.rmSync(runRoot, { recursive: true, force: true });
    this.workspace = path.join(runRoot, "ws");
    this.runtimeDir = path.join(runRoot, "runtime");
    fs.mkdirSync(this.workspace, { recursive: true });
    fs.mkdirSync(this.runtimeDir, { recursive: true });

    this.term = new Terminal({ cols: COLS, rows: ROWS, allowProposedApi: true, scrollback: 4000 });
    this.host = new TerminalHost({
      taskId: `task-q18-${name}`,
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

  onHostEvent(event) {
    if (event.type === "pty:data") {
      this.raw += event.payload.data;
      this.term.write(event.payload.data);
      return;
    }
    if (event.type === "pty:exit") {
      this.ptyExited = true;
    }
    if (event.type === "control-switch:state") {
      this.switchEvents.push({ atMs: this.at(), ...event.payload });
    }
    if (event.type === "approval:detected") {
      this.notes.push(`approval:detected ${event.payload?.kind ?? "?"} at ${this.at()}ms`);
    }
  }

  onHookPayload(payload) {
    const event = typeof payload.hook_event_name === "string" ? payload.hook_event_name : "<none>";
    const mode = typeof payload.permission_mode === "string" ? payload.permission_mode : null;
    this.hooks.push({ atMs: this.at(), event, permission_mode: mode });
    if (event === "SessionStart") this.host.noteHookSessionStart();
    if (event === "UserPromptSubmit") {
      this.host.beginRunFromHook(typeof payload.prompt === "string" ? payload.prompt : "", {
        promptId: typeof payload.prompt_id === "string" ? payload.prompt_id : null,
      });
    }
    if (event === "Stop") this.host.completeRunFromTurnEnd();
    // `applyHookPermissionMode`, replayed verbatim in spirit: any hook carrying
    // a mode moves the mirror.
    if (mode && mode !== this.mirror) {
      this.mirror = mode;
      this.mirrorHistory.push({ atMs: this.at(), via: event, mode });
    }
  }

  async boot(permissionMode) {
    this.host.startTask({
      cwd: this.workspace,
      runtimeDir: this.runtimeDir,
      permissionMode,
      rows: ROWS,
      cols: COLS,
      approvalBroker: false,
    });
    this.watcher.watchWorkspace(this.runtimeDir);
    let trustAnswered = false;
    const ok = await this.waitUntil(() => {
      if (!trustAnswered && this.notes.some((n) => n.startsWith("approval:detected workspace-trust"))) {
        trustAnswered = true;
        void this.host.sendApprove().catch((e) => this.notes.push(`trust approve error: ${e?.message ?? e}`));
      }
      return this.host.acceptsPromptInput();
    }, 60_000);
    this.notes.push(`ready=${ok} at ${this.at()}ms`);
    await delay(3000);
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

  /** The screen's own answer to "what mode am I in", independent of the mirror. */
  gridMode() {
    return { row: modeLineRow(this.screen()), parsed: parseClaudePermissionModeLine(this.raw.slice(-SCAN_LIMIT)) };
  }

  dispose() {
    try { this.watcher.dispose(); } catch { /* already stopped */ }
    try { this.host.dispose(); } catch { /* already gone */ }
  }
}

async function armF(cap, results) {
  const s = new HostSession("f-drive");
  try {
    const ready = await s.boot("default");
    cap.add("F — boot", JSON.stringify({ ready, notes: s.notes, hooks: s.hooks, mirror: s.mirror }, null, 2));
    const drives = [];
    // Each target is driven FROM the mode the previous drive left us in, which
    // is what the renderer does (`from` = the chip's current value). The
    // distances exercised: +1 (default→acceptEdits), +2 (acceptEdits→auto,
    // through plan), and the WRAP (auto→plan, three steps the long way round —
    // the cycle has no reverse).
    for (const [target, from] of [
      ["acceptEdits", "default"],
      ["auto", "acceptEdits"],
      ["plan", "auto"],
      ["default", "plan"],
    ]) {
      const t0 = Date.now();
      const before = s.switchEvents.length;
      const response = s.host.injectClaudeControlSwitch("permission", target, from);
      // Bounded: 4 steps × 1.5s per-step window + slack.
      await s.waitUntil(
        () => s.switchEvents.slice(before).some((e) => e.phase === "settled" || e.phase === "needs-attention"),
        12_000,
      );
      const emitted = s.switchEvents.slice(before);
      const terminal = emitted.find((e) => e.phase === "settled" || e.phase === "needs-attention") ?? null;
      const entry = {
        target,
        from,
        response,
        elapsedMs: Date.now() - t0,
        phases: emitted.map((e) => e.phase),
        terminalPhase: terminal ? terminal.phase : null,
        observedModes: terminal ? (terminal.observedModes ?? null) : null,
        gridAfter: s.gridMode(),
        mirrorAfter: s.mirror,
      };
      drives.push(entry);
      cap.add(`F — drive ${from} → ${target}`, JSON.stringify(entry, null, 2));
      await delay(1200);
    }
    results.f = {
      ready,
      drives,
      hooks: s.hooks,
      mirrorHistory: s.mirrorHistory,
      allSettled: drives.every((d) => d.terminalPhase === "settled"),
    };
    cap.add("F — verdict", JSON.stringify(results.f, null, 2));
  } finally {
    s.dispose();
    await delay(800);
  }
}

async function armG(cap, results) {
  const s = new HostSession("g-mirror");
  try {
    const ready = await s.boot("default");
    const mirrorAtBoot = s.mirror;
    const gridAtBoot = s.gridMode();

    // The UNDRIVEN flip: a Shift+Tab through `writeUserInput` — the exact path
    // the user's own keystroke in the Terminal pane takes. Sonata's engine is
    // NOT involved: no pending switch, no receipt watch, no write-lock. This is
    // the local stand-in for every flip nobody tells the mirror about.
    s.host.writeUserInput(KEYS.shiftTab);
    await delay(1500);
    const afterFlip = {
      atMs: s.at(),
      grid: s.gridMode(),
      mirror: s.mirror,
      hooksSinceBoot: s.hooks.length,
    };
    cap.add("G — immediately after an undriven Shift+Tab", JSON.stringify(afterFlip, null, 2));

    // Does ANY hook fire on its own for a mode change? Watch a full minute —
    // long enough to also catch the 60s `Notification(idle_prompt)` SL-2b
    // measured, which is the only self-firing event in this window.
    const flipHookCount = s.hooks.length;
    await s.waitUntil(() => s.hooks.length > flipHookCount, 65_000);
    const quietWindow = {
      watchedMs: s.at() - afterFlip.atMs,
      newHooks: s.hooks.slice(flipHookCount),
      mirror: s.mirror,
      grid: s.gridMode(),
    };
    cap.add("G — 65s watch after the flip (any self-firing hook?)", JSON.stringify(quietWindow, null, 2));

    // What finally corrects it: the next hook-bearing activity. A one-word turn
    // is the cheapest real one (`UserPromptSubmit` carries `permission_mode`).
    const beforePrompt = s.hooks.length;
    const tPrompt = Date.now();
    s.host.submitPrompt("Reply with exactly: ok");
    await s.waitUntil(() => s.hooks.length > beforePrompt, 60_000);
    const correction = {
      msFromPromptToFirstHook: Date.now() - tPrompt,
      hook: s.hooks[beforePrompt] ?? null,
      mirror: s.mirror,
      grid: s.gridMode(),
    };
    cap.add("G — the correcting hook", JSON.stringify(correction, null, 2));
    await s.waitUntil(() => s.hooks.some((h) => h.event === "Stop"), 90_000);

    results.g = {
      ready,
      mirrorAtBoot,
      gridAtBoot,
      afterFlip,
      quietWindow,
      correction,
      mirrorHistory: s.mirrorHistory,
      hooks: s.hooks,
      notes: s.notes,
      // The finding in one boolean each:
      flipFiredNoHook: quietWindow.newHooks.every((h) => h.event !== "UserPromptSubmit") && quietWindow.newHooks.length === 0,
      mirrorWentStale: afterFlip.mirror !== afterFlip.grid.parsed,
    };
    cap.add("G — verdict", JSON.stringify(results.g, null, 2));
  } finally {
    s.dispose();
    await delay(800);
  }
}

async function main() {
  fs.rmSync(ROOT, { recursive: true, force: true });
  fs.mkdirSync(ROOT, { recursive: true });
  const cap = new Capture(
    path.join(OUT_DIR, "q18-permission-drive-mirror.capture.txt"),
    `Q18 — off-cycle origins, the production permission drive, the mirror under an undriven flip (claude ${version})`,
  );
  const results = { version };

  await armE(cap, results);
  await armF(cap, results);
  await armG(cap, results);

  results.userSettingsUnchanged = fs.readFileSync(USER_SETTINGS, "utf8") === settingsBefore;
  const endVersion = readVersion();
  results.versionAtEnd = endVersion;
  results.versionDrift = !endVersion.startsWith(EXPECT_VERSION);
  cap.add("fence", JSON.stringify({ userSettingsUnchanged: results.userSettingsUnchanged, endVersion }, null, 2));
  cap.save();
  console.log(sanitize(JSON.stringify(results, null, 2)));
  if (results.versionDrift) process.exitCode = 2;
}

main().catch((error) => {
  console.error(sanitize(String(error?.stack ?? error)));
  process.exit(1);
});
