// Q11 (2026-09 sync, SL-2b) — the HOOK COVERAGE MATRIX for turn completion.
//
// QUESTION: claude turn-completion is already hook-primary (Stop/StopFailure).
// The scrape leg that survives beside it exists for ONE reason — the silent-tool-
// stop class (anthropics/claude-code#29881), a turn that ends without Stop — and
// SL-2 measured that leg DEAD under production spawns (F5b: the alt-screen
// differential repaint leaves no footer in the stream window, so the MEDIUM gate
// can never be reached). Before retiring it we must know what the hook family
// ACTUALLY covers. For each completion-relevant scenario: which hooks fire, and
// does Sonata's run close?
//
// WHY A REAL TerminalHost + A MINI-CONTROLLER, not the spike Probe: the answer
// is about SONATA's run lifecycle, not the CLI's screen. The completion path is
// `hookSessionStarted` (SessionStart) → `beginRunFromHook` (UserPromptSubmit) →
// `completeRunFromTurnEnd` (Stop/StopFailure) with `checkCompletionHeuristic` as
// the backstop, and NONE of it runs without the hook sink being consumed. So
// this probe stands up the production HookWatcher and replays exactly the four
// dispatch edges `RuntimeController.handleHookPayload` applies to the completion
// path — no more, no less (see applyProductionDispatch).
//
// CANDIDATE-EVENT ARM. Sonata injects 8 fire-and-forget events today
// (INJECTED_HOOK_EVENTS) + PermissionRequest. 2.1.257's binary carries 33
// (`var Hh=[…]`, extracted from the bundle). Three of them are completion-
// relevant and unwired: SessionEnd, PostToolUseFailure, PermissionDenied. The
// arm ADDS them to the settings file the production writer just wrote (never
// overriding a production entry), so the spawn shape stays production's and the
// only variable is the extra events. The patch is applied at the dist export
// (tsc's CJS re-export barrel is a getter onto the source module, so patching
// the source module's export is what terminal-host actually calls) — see
// installCandidateEventInjection.
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
const {
  TerminalHost,
  HookWatcher,
  claudeHooksDirectory,
  detectIdlePromptForProvider,
  detectIdleComposerForProvider,
} = require(APP_DIR + "dist/runtime");

const EXPECT_VERSION = "2.1.257";
const ROOT = "/private/tmp/sonata-sync-2026-09/hook-coverage";
const COLS = 120;
const ROWS = 40;

const HOME = os.homedir();
const USER_MUNGED = `-${HOME.replace(/\//g, "-").replace(/^-/, "")}-`;
const sanitize = (value) =>
  String(value).split(HOME).join("$HOME").split(USER_MUNGED).join("-$USER_MUNGED-");

function pinVersion(where) {
  const version = execFileSync("claude", ["--version"], { encoding: "utf8" }).trim();
  if (!version.startsWith(EXPECT_VERSION)) {
    console.log(JSON.stringify({ success: false, reason: `binary moved off ${EXPECT_VERSION} (${where})`, version }));
    process.exit(2);
  }
  return version;
}
const version = pinVersion("probe start");

// ─── candidate events (2.1.257 `var Hh=[…]`, presence-only evidence) ────────
// Only the completion-relevant unwired ones. `matcher` mirrors the production
// writer's convention: tool-scoped events take `"*"`, session-scoped ones take a
// bare entry.
const CANDIDATE_EVENTS = [
  { event: "SessionEnd", matcher: null, why: "brief-named: does it fire under our --settings injection? reasons enum = clear|resume|logout|prompt_input_exit|other" },
  { event: "PostToolUseFailure", matcher: "*", why: "a turn whose TOOL failed — is the failure its own event, or does PostToolUse carry it?" },
  { event: "PermissionDenied", matcher: "*", why: "a denied tool ends the turn by a non-model path — the closest reproducible silent-stop shape" },
];

/** Patch the dist export the terminal-host calls, so a scenario can opt into the
 *  candidate events without changing the spawn shape. Returns a setter. */
function installCandidateEventInjection() {
  const module = require(APP_DIR + "dist/runtime/cli-signal/claude-runtime-settings.js");
  const original = module.ensureClaudeRuntimeSettings;
  let enabled = false;
  module.ensureClaudeRuntimeSettings = (runtimeDir, options) => {
    const settingsPath = original(runtimeDir, options);
    if (!enabled) {
      return settingsPath;
    }
    const settings = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
    // Reuse the command production itself wrote — the sink script, its
    // interpreter prefix and its hooks dir all stay production's.
    const sinkCommand = settings.hooks.Stop[0].hooks[0].command;
    for (const { event, matcher } of CANDIDATE_EVENTS) {
      if (settings.hooks[event]) continue; // never override a production entry
      settings.hooks[event] = matcher
        ? [{ matcher, hooks: [{ type: "command", command: sinkCommand }] }]
        : [{ hooks: [{ type: "command", command: sinkCommand }] }];
    }
    fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
    return settingsPath;
  };
  return (value) => {
    enabled = value;
  };
}
const setCandidateEvents = installCandidateEventInjection();

// ─── the session harness ────────────────────────────────────────────────────

class Session {
  constructor(name, { candidates }) {
    this.name = name;
    this.t0 = Date.now();
    this.hooks = [];
    this.events = [];
    this.raw = "";
    this.notes = [];
    this.runStates = [];
    this.ptyExited = false;
    this.exitInfo = null;

    const runRoot = path.join(ROOT, name);
    fs.rmSync(runRoot, { recursive: true, force: true });
    this.workspace = path.join(runRoot, "ws");
    this.runtimeDir = path.join(runRoot, "runtime");
    fs.mkdirSync(this.workspace, { recursive: true });
    fs.mkdirSync(this.runtimeDir, { recursive: true });

    this.term = new Terminal({ cols: COLS, rows: ROWS, allowProposedApi: true, scrollback: 4000 });
    setCandidateEvents(candidates);

    this.host = new TerminalHost({
      taskId: `task-q11-${name}`,
      provider: "claude",
      defaultWorkspace: this.workspace,
      eventSink: (event) => this.onHostEvent(event),
    });

    // The production watcher, resolving the sink dir exactly as the controller
    // does (runtimeDir/hooks, provider-neutral).
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
    if (event.type === "report:updated" || event.type === "file:changed") return;
    if (event.type === "pty:exit") {
      this.ptyExited = true;
      this.exitInfo = event.payload;
    }
    if (event.type === "run:updated") {
      const run = event.payload;
      this.runStates.push({
        atMs: this.at(),
        id: run.id,
        kind: run.kind,
        status: run.status,
        statusReason: run.statusReason ?? null,
        completionSource: run.completionSource ?? null,
        completionConfidence: run.completionConfidence ?? null,
      });
      return;
    }
    this.events.push({
      atMs: this.at(),
      type: event.type,
      payload: compactPayload(event.payload),
    });
  }

  onHookPayload(payload) {
    const event = typeof payload.hook_event_name === "string" ? payload.hook_event_name : "<none>";
    this.hooks.push({
      atMs: this.at(),
      event,
      // The completion-relevant fields, verbatim; `keys` records the whole
      // envelope shape without dumping transcripts.
      reason: payload.reason ?? null,
      tool_name: payload.tool_name ?? null,
      notification_type: payload.notification_type ?? null,
      message: typeof payload.message === "string" ? payload.message.slice(0, 120) : null,
      error: typeof payload.error === "string" ? payload.error.slice(0, 200) : null,
      stop_hook_active: payload.stop_hook_active ?? null,
      keys: Object.keys(payload).sort(),
    });
    this.applyProductionDispatch(event, payload);
  }

  /** EXACTLY the completion-path edges `RuntimeController.handleHookPayload`
   *  applies for a claude task. Anything else the controller does (permission
   *  mode, option prompts, tool-change attribution, codex liveness) is outside
   *  the completion question and deliberately not replayed. */
  applyProductionDispatch(event, payload) {
    if (event === "SessionStart") {
      this.host.noteHookSessionStart();
    }
    if (event === "UserPromptSubmit") {
      this.host.beginRunFromHook(typeof payload.prompt === "string" ? payload.prompt : "", {
        promptId: typeof payload.prompt_id === "string" ? payload.prompt_id : null,
      });
    }
    if (event === "Stop") {
      this.host.completeRunFromTurnEnd();
    }
    if (event === "StopFailure") {
      const error = typeof payload.error === "string" && payload.error.trim() ? payload.error.trim() : "API error";
      this.host.completeRunFromTurnEnd({ errorExcerpt: error });
    }
  }

  async boot() {
    this.startedPty = this.host.startTask({
      cwd: this.workspace,
      runtimeDir: this.runtimeDir,
      permissionMode: "default",
      rows: ROWS,
      cols: COLS,
      // native-approval mode: broker-ON suppresses the grid scrape entirely
      // (nativeApprovalSurfaceSuppressed), and this probe needs the scrape both
      // to answer the trust dialog and to see the deny panel. The completion
      // path under test is broker-independent.
      approvalBroker: false,
    });
    this.watcher.watchWorkspace(this.runtimeDir);

    // Answer the trust dialog with the COMMITTED production walk (SL-1).
    let trustAnswered = false;
    const ok = await this.waitUntil(
      () => {
        if (!trustAnswered && this.events.some((e) => e.type === "approval:detected" && e.payload?.kind === "workspace-trust")) {
          trustAnswered = true;
          this.notes.push(`trust dialog answered at ${this.at()}ms`);
          void this.host.sendApprove().catch((error) => this.notes.push(`trust approve error: ${error?.message ?? error}`));
        }
        return this.host.acceptsPromptInput();
      },
      60_000,
    );
    this.notes.push(
      `ready=${ok} at ${this.at()}ms (SessionStart hook already consumed at that instant: ${this.hooks.some((h) => h.event === "SessionStart")})`,
    );
    // Let the boot ceremony settle (the statusline render lands ~11s in; F7) and
    // give the SessionStart sink file time to land — the completion gate under
    // test (`heuristicMayClose`) is only in its production shape once
    // `hookSessionStarted` is true.
    await delay(2000);
    this.notes.push(`SessionStart consumed before the first turn: ${this.hooks.some((h) => h.event === "SessionStart")}`);
    return ok;
  }

  /** The run the host currently believes is active, in the shape the report needs. */
  activeRun() {
    const run = this.host.activeRun;
    return run ? { id: run.id, kind: run.kind, status: run.status, lifecyclePhase: run.lifecyclePhase } : null;
  }

  async waitUntil(predicate, timeoutMs, stepMs = 150) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      if (predicate()) return true;
      if (Date.now() > deadline || this.ptyExited) return false;
      await delay(stepMs);
    }
  }

  /** One sample of BOTH channels plus the host's own run state — the shape the
   *  retire/keep decision is made on. `runRaw` is what
   *  `checkCompletionHeuristic` actually judges (the RUN's bytes, not rawTail);
   *  `grid` is the rendered viewport D-1 says a state question belongs on. */
  sample() {
    const grid = this.screen();
    const runRaw = this.host.activeRunRaw ?? "";
    return {
      atMs: this.at(),
      run: this.activeRun(),
      streamPrompt: detectIdlePromptForProvider(this.raw, "claude"),
      gridPrompt: detectIdlePromptForProvider(grid, "claude"),
      runRawComposer: detectIdleComposerForProvider(runRaw, "claude"),
      gridComposer: detectIdleComposerForProvider(grid, "claude"),
      // The activity vocabulary as it renders on the GRID. SL-2a measured that
      // under the injected statusLine the claude activity evidence is the
      // spinner glyphs alone (`esc to interrupt` is suppressed) — so whether a
      // BUSY frame still carries one is what decides if a grid-fed state test
      // can tell busy from idle at all.
      gridHasSpinnerGlyph: /[✢✳✶✻✽]/.test(grid),
      gridHasEllipsisVerb: /\w+…/.test(grid),
    };
  }

  channels() {
    const grid = this.screen();
    return {
      stream: detectIdlePromptForProvider(this.raw, "claude"),
      grid: detectIdlePromptForProvider(grid, "claude"),
      streamComposer: detectIdleComposerForProvider(this.raw, "claude"),
      gridComposer: detectIdleComposerForProvider(grid, "claude"),
    };
  }

  /** The pty stream with CSI/OSC sequences stripped — enough to see what the CLI
   *  actually printed, without pasting a raw escape soup into the capture. */
  rawTail(chars = 2500) {
    const stripped = this.raw
      .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "")
      .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "")
      .replace(/\x1b[()][AB012]/g, "")
      .replace(/\x1b[=>]/g, "")
      .replace(/\r/g, "\n")
      .replace(/\n{3,}/g, "\n\n");
    return stripped.slice(-chars);
  }

  finish(extra = {}) {
    const tail = this.screen().split("\n").slice(-14).join("\n");
    const out = {
      scenario: this.name,
      version,
      hooks: this.hooks,
      hookEvents: [...new Set(this.hooks.map((h) => h.event))],
      runStates: this.runStates,
      events: this.events,
      notes: this.notes,
      ptyExited: this.ptyExited,
      exitInfo: this.exitInfo,
      activeRunAtEnd: this.activeRun(),
      channelsAtEnd: this.channels(),
      screenTail: tail,
      rawStreamTail: this.rawTail(),
      ...extra,
    };
    try {
      this.watcher.dispose();
      this.host.dispose();
      this.term.dispose();
    } catch {
      /* teardown is best-effort */
    }
    return out;
  }
}

// ─── scenarios ──────────────────────────────────────────────────────────────
// Every prompt is trivial and side-effect-free except where the scenario is
// ABOUT a side effect (the write-approval arm), which writes only inside its own
// /private/tmp workspace.

/** S1 — normal turn end, PRODUCTION hook set (the control arm). Also the only
 *  arm that keeps watching past 60s of idle: `messageIdleNotifThresholdMs`
 *  defaults to 60000 in the 2.1.257 bundle, and Notification is ALREADY in
 *  Sonata's injected set — so if `Notification(idle_prompt)` ever fires, this is
 *  the arm that sees it, and it would be a hook-channel idle beacon. */
async function scenarioNormalTurn() {
  const session = new Session("s1-normal-turn", { candidates: false });
  if (!(await session.boot())) return session.finish({ verdict: "BOOT FAILED" });

  session.host.submitPrompt("Reply with exactly: OK");
  const stopSeen = await session.waitUntil(() => session.hooks.some((h) => h.event === "Stop"), 120_000);
  const stopAtMs = session.hooks.find((h) => h.event === "Stop")?.atMs ?? null;
  const runClosedAtStop = session.activeRun() === null;

  // 75s of post-turn idle: does ANY further hook arrive (the 60s idle
  // notification is the hypothesis), and does the scrape channel still read the
  // way F5b measured at 2.1.252?
  const idleStart = session.at();
  await delay(75_000);
  const postTurnHooks = session.hooks.filter((h) => h.atMs > (stopAtMs ?? 0));

  return session.finish({
    stopSeen,
    stopAtMs,
    runClosedAtStop,
    idleWatchStartedAtMs: idleStart,
    postTurnHooks,
    verdict: stopSeen && runClosedAtStop ? "COVERED by Stop" : "GAP",
  });
}

/** S2 — a turn whose TOOL fails. Read on a missing path needs no approval in
 *  default mode, so the turn runs unattended. Question: PostToolUseFailure vs
 *  PostToolUse, and does the turn still end on Stop (not StopFailure)? */
async function scenarioToolError() {
  const session = new Session("s2-tool-error", { candidates: true });
  if (!(await session.boot())) return session.finish({ verdict: "BOOT FAILED" });

  const missing = path.join(session.workspace, "definitely-missing.txt");
  session.host.submitPrompt(
    `Use the Read tool on ${missing} exactly once. It does not exist; do not create it, do not retry, do not use any other tool. Then reply with exactly: DONE`,
  );
  const stopSeen = await session.waitUntil(() => session.hooks.some((h) => h.event === "Stop"), 120_000);

  await delay(3000);
  return session.finish({
    stopSeen,
    toolHooks: session.hooks.filter((h) => /Tool/.test(h.event)),
    runClosedAtStop: session.activeRun() === null,
    verdict: stopSeen ? "COVERED by Stop" : "GAP",
  });
}

/** S3 — the user presses Esc mid-turn in the co-visible Terminal. Sonata's OWN
 *  stop button is a different path (`stopRun` finishes the run locally); this is
 *  the one no Sonata code sees the intent of. Does any hook close the turn? */
async function scenarioEscMidTurn() {
  const session = new Session("s3-esc-mid-turn", { candidates: true });
  if (!(await session.boot())) return session.finish({ verdict: "BOOT FAILED" });

  session.host.submitPrompt(
    "Write out the numbers 1 to 400, one per line, with no other text. Do not use any tools.",
  );
  const started = await session.waitUntil(() => session.hooks.some((h) => h.event === "UserPromptSubmit"), 60_000);
  // Let the turn genuinely run before interrupting it — sampling both channels
  // while it does, so the BUSY baseline is on the record beside the idle one.
  const busySamples = [];
  for (let i = 0; i < 4; i++) {
    await delay(1500);
    busySamples.push(session.sample());
  }
  const runBeforeEsc = session.activeRun();
  const escAtMs = session.at();
  // `writeUserInput`, not `writeRaw`: this scenario IS the human typing into the
  // co-visible Terminal, and that path carries the settle pass + the
  // `cliInputMaybeDirty` marking a raw write would skip.
  session.host.writeUserInput("\x1b");
  session.notes.push(`user Esc written at ${escAtMs}ms`);

  // 100s, not 45s: past every settle constant in the completion path AND past
  // the 60s `messageIdleNotifThresholdMs` — so if `Notification(idle_prompt)` is
  // the hook-channel idle beacon S1 measured, an interrupted turn is where it
  // has to prove it fires too.
  const idleSamples = [];
  for (let i = 0; i < 20; i++) {
    await delay(5000);
    idleSamples.push(session.sample());
  }
  const hooksAfterEsc = session.hooks.filter((h) => h.atMs > escAtMs);

  // The MEASURED fixture the SL-2b tests pin: the interrupted run's own bytes,
  // verbatim (this is what `checkCompletionHeuristic` judges — `activeRunRaw`,
  // not `rawTail`). Parked beside the results rather than embedded in the
  // capture: it is an escape-code stream, not something to read.
  const fixturePath = path.join(ROOT, "s3-esc-interrupted-run-raw.json");
  fs.writeFileSync(fixturePath, JSON.stringify(sanitize(session.host.activeRunRaw ?? "")));
  session.notes.push(`interrupted run raw parked at ${fixturePath} (${(session.host.activeRunRaw ?? "").length} chars)`);

  return session.finish({
    turnStarted: started,
    runBeforeEsc,
    escAtMs,
    busySamples,
    idleSamples,
    hooksAfterEsc,
    runStillActive: session.activeRun() !== null,
    verdict: hooksAfterEsc.length > 0
      ? `hooks after Esc: ${hooksAfterEsc.map((h) => `${h.event}@${h.atMs}`).join(", ")}`
      : "NO HOOK after user Esc",
  });
}

/** S4 — the CLI process is killed mid-turn (crash class). Nothing can fire a
 *  hook from a dead process; the question is whether Sonata's own pty:exit path
 *  closes the run honestly. */
async function scenarioKillMidTurn() {
  const session = new Session("s4-kill-mid-turn", { candidates: true });
  if (!(await session.boot())) return session.finish({ verdict: "BOOT FAILED" });

  const started = session.host.submitPrompt(
    "Write out the numbers 1 to 400, one per line, with no other text. Do not use any tools.",
  );
  await session.waitUntil(() => session.hooks.some((h) => h.event === "UserPromptSubmit"), 60_000);
  await delay(5000);
  const runBeforeKill = session.activeRun();
  const pid = session.startedPty?.pid ?? null;
  const killAtMs = session.at();
  if (pid) {
    try {
      process.kill(pid, "SIGKILL");
    } catch (error) {
      session.notes.push(`kill failed: ${error?.message ?? error}`);
    }
  }
  await delay(8000);

  return session.finish({
    submitted: Boolean(started),
    pid: pid === null ? null : "<pid>",
    runBeforeKill,
    killAtMs,
    hooksAfterKill: session.hooks.filter((h) => h.atMs > killAtMs),
    verdict: session.ptyExited ? "pty:exit observed" : "NO pty:exit",
  });
}

/** S5 — the CLI exits itself (`/exit`, the graceful-quit class). Does SessionEnd
 *  fire under our `--settings` injection, and with which reason? */
async function scenarioSelfExit() {
  const session = new Session("s5-self-exit", { candidates: true });
  if (!(await session.boot())) return session.finish({ verdict: "BOOT FAILED" });

  // One real turn first, so the session has something to end.
  session.host.submitPrompt("Reply with exactly: OK");
  await session.waitUntil(() => session.hooks.some((h) => h.event === "Stop"), 120_000);
  await delay(2000);

  const exitAtMs = session.at();
  session.host.writeRaw("/exit\r");
  session.notes.push(`/exit written at ${exitAtMs}ms`);
  await session.waitUntil(() => session.ptyExited, 30_000);
  await delay(3000); // the sink files land after the CLI's own teardown

  const sessionEnd = session.hooks.filter((h) => h.event === "SessionEnd");
  return session.finish({
    exitAtMs,
    sessionEnd,
    hooksAfterExit: session.hooks.filter((h) => h.atMs > exitAtMs),
    verdict: sessionEnd.length > 0 ? `SessionEnd fires (reason=${sessionEnd.map((h) => h.reason).join(",")})` : "SessionEnd DID NOT FIRE",
  });
}

/** S6 — a tool the user DENIES. The turn ends by a non-model path, which is the
 *  closest reproducible shape to the silent-tool-stop class. Answered from the
 *  GRID (never a blind key): find the deny row's digit on the rendered panel. */
async function scenarioDeniedTool() {
  const session = new Session("s6-denied-tool", { candidates: true });
  if (!(await session.boot())) return session.finish({ verdict: "BOOT FAILED" });

  session.host.submitPrompt(
    "Create a file named hello.txt in the current directory containing the single word hi. Then reply with exactly: DONE",
  );
  const panelSeen = await session.waitUntil(
    () => session.events.some((e) => e.type === "approval:detected" && e.payload?.kind !== "workspace-trust"),
    120_000,
  );
  const panelAtMs = session.at();
  const panelFrame = session.screen();
  let denyKey = null;
  if (panelSeen) {
    // Claude 2.1.257 approval rows still carry digits (F3b); read the deny row
    // off the grid rather than assuming its position.
    for (const line of panelFrame.split("\n")) {
      const match = /^\s*(?:❯\s*)?(\d)\.\s*(No\b.*)$/.exec(line.trim());
      if (match) {
        denyKey = match[1];
        session.notes.push(`deny row read from the grid: "${match[0].trim()}"`);
        break;
      }
    }
    if (denyKey) {
      // `writeUserInput` (not `writeRaw`): the production path for a human
      // answering the native panel in the co-visible Terminal — it arms the
      // native-answer reconcile that clears `approvalActive` and returns the run
      // to `active`. A raw write would leave the run parked at
      // waiting-for-approval and the measurement would be about the probe, not
      // about the CLI.
      session.host.writeUserInput(denyKey);
    } else {
      session.notes.push("no deny row parsed from the grid — panel left unanswered");
    }
  }
  await delay(3000);
  const frameAfterDeny = session.screen().split("\n").slice(-16).join("\n");
  const runAfterDeny = session.activeRun();
  // Same 100s window as S3, for the same reason: the 60s idle-notification
  // threshold has to be inside it.
  const idleSamples = [];
  for (let i = 0; i < 20; i++) {
    await delay(5000);
    idleSamples.push(session.sample());
  }

  return session.finish({
    panelSeen,
    panelAtMs,
    denyKey,
    panelFrame: panelFrame.split("\n").slice(-16).join("\n"),
    frameAfterDeny,
    runAfterDeny,
    idleSamples,
    hooksAfterPanel: session.hooks.filter((h) => h.atMs > panelAtMs),
    stopAfterDeny: session.hooks.some((h) => h.event === "Stop" && h.atMs > panelAtMs),
    runStillActive: session.activeRun() !== null,
    verdict: session.hooks.some((h) => h.event === "Stop" && h.atMs > panelAtMs) ? "COVERED by Stop" : "GAP",
  });
}

/** S7 — the SAFETY arm, and the one that decides whether a grid-fed confidence
 *  leg is shippable at all. A `sleep` under Bash is a genuinely BUSY turn that
 *  is printable-QUIET for its whole length — structurally the same shape as the
 *  five field misfires (claude 2.1.211: a post-submit stall left a >=1.75s
 *  printable-quiet window while the model worked for minutes, and the scrape
 *  read the submit frame as completed). Two questions, one arm:
 *   (a) does anything close the run while it is genuinely live? A close here is
 *       a FALSE COMPLETION — the failure direction Woody ranks worst.
 *   (b) does `Notification(idle_prompt)` false-fire mid-turn? It is only usable
 *       as a completion backstop if the CLI never calls a live turn idle.
 *  100s of sleep, so the 60s idle threshold falls INSIDE the busy window. */
async function scenarioQuietBusyTurn() {
  const session = new Session("s7-quiet-busy-turn", { candidates: true });
  if (!(await session.boot())) return session.finish({ verdict: "BOOT FAILED" });

  // FOREGROUND is load-bearing and was learned the hard way: the first run of
  // this arm said only "wait for it", and claude ran the sleep as a BACKGROUND
  // shell — the turn ended (Stop at 8.8s) with the shell still running, so it
  // measured nothing. The tool call has to hold the turn open.
  // NOT a bare `sleep 90`: 2.1.257's own harness BLOCKS a standalone sleep
  // ("Blocked: standalone sleep 90 … use Monitor with an until-loop"), measured
  // on the previous run of this arm — the turn then ended in 5s having run
  // nothing. A python sleep is the same wait without the guarded shape.
  session.host.submitPrompt(
    'Run this exact bash command in the FOREGROUND and wait for it to finish: python3 -c "import time; time.sleep(90); print(\'slept\')" . ' +
      "Do not run it in the background, do not use run_in_background, do not run anything else. " +
      "After it finishes, reply with exactly: DONE",
  );
  // Bash may or may not paint a permission panel (2.1.257 auto-allowed a bare
  // `sleep` in default mode — measured). Wait BRIEFLY for one; its absence is
  // not a failure.
  const panelSeen = await session.waitUntil(
    () => session.events.some((e) => e.type === "approval:detected" && e.payload?.kind !== "workspace-trust"),
    20_000,
  );
  let approveKey = null;
  if (panelSeen) {
    await delay(500);
    for (const line of session.screen().split("\n")) {
      const match = /^\s*(?:❯\s*)?(\d)\.\s*(Yes)\s*$/.exec(line.trim());
      if (match) {
        approveKey = match[1];
        session.notes.push(`approve row read from the grid: "${match[0].trim()}"`);
        break;
      }
    }
    if (approveKey) {
      session.host.writeUserInput(approveKey);
    } else {
      session.notes.push("no bare-Yes row parsed from the grid — the sleep never started");
    }
  }

  // The busy window opens when the tool call actually starts.
  const toolStarted = await session.waitUntil(
    () => session.hooks.some((h) => h.event === "PreToolUse" && h.tool_name === "Bash"),
    60_000,
  );
  const busyStartedAtMs = session.at();
  const stopAfterBusy = () => session.hooks.find((h) => h.event === "Stop" && h.atMs > busyStartedAtMs);
  // A false close can only be claimed if the turn was genuinely LIVE when the
  // window opened. Without the tool call the arm measures nothing and says so.
  const runAtBusyStart = session.activeRun();
  const samples = [];
  let falseCloseAtMs = null;
  for (let i = 0; i < 26; i++) {
    await delay(5000);
    const sample = session.sample();
    samples.push(sample);
    if (toolStarted && runAtBusyStart && falseCloseAtMs === null && sample.run === null && !stopAfterBusy()) {
      falseCloseAtMs = sample.atMs;
    }
    if (stopAfterBusy()) break;
  }

  const stopHook = stopAfterBusy();
  const notifDuringBusy = session.hooks.filter(
    (h) => h.event === "Notification" && h.atMs > busyStartedAtMs && (!stopHook || h.atMs < stopHook.atMs),
  );
  return session.finish({
    panelSeen,
    approveKey,
    toolStarted,
    runAtBusyStart,
    busyStartedAtMs,
    samples,
    falseCloseAtMs,
    stopAtMs: stopHook?.atMs ?? null,
    notifDuringBusy,
    verdict: !toolStarted || !runAtBusyStart
      ? "UNREPRODUCED — no live foreground tool call held the turn open"
      : falseCloseAtMs !== null
        ? `FALSE COMPLETION at ${falseCloseAtMs}ms — a live turn was closed`
        : notifDuringBusy.length > 0
          ? "idle Notification FIRED mid-turn (unusable as a beacon)"
          : `live turn held ${(stopHook?.atMs ?? 0) - busyStartedAtMs}ms with no false close and no mid-turn idle Notification`,
  });
}

/** S8 — the FIX, verified live against the same gap. Identical to S3 in every
 *  respect except that it runs against a `dist/` carrying SL-2b's
 *  `stoplessTurnEndConfirmed`. S3's parked result is the BEFORE (run `active` for
 *  108s, no hook, no close); this is the AFTER. Keep both: a fix claim with only
 *  the after-state measured is not a measurement. */
async function scenarioEscMidTurnFixed() {
  const session = new Session("s8-esc-mid-turn-fixed", { candidates: false });
  if (!(await session.boot())) return session.finish({ verdict: "BOOT FAILED" });

  session.host.submitPrompt(
    "Write out the numbers 1 to 400, one per line, with no other text. Do not use any tools.",
  );
  await session.waitUntil(() => session.hooks.some((h) => h.event === "UserPromptSubmit"), 60_000);
  await delay(6000);
  const escAtMs = session.at();
  session.host.writeUserInput("\x1b");

  // The window is 30s; 75s leaves room for the judge cadence and proves the
  // close is the window's, not a coincidence of the watch ending.
  const closed = await session.waitUntil(() => session.activeRun() === null, 75_000, 500);
  const close = session.runStates.find((state) => state.status === "completed");
  await delay(2000);

  return session.finish({
    escAtMs,
    closed,
    close,
    msFromEscToClose: close ? close.atMs - escAtMs : null,
    hooksAfterEsc: session.hooks.filter((h) => h.atMs > escAtMs),
    verdict: close
      ? `CLOSED ${close.atMs - escAtMs}ms after Esc — ${close.statusReason} / ${close.completionConfidence}`
      : "STILL WEDGED (fix not in this dist, or not working)",
  });
}

const SCENARIOS = {
  "s1-normal-turn": scenarioNormalTurn,
  "s2-tool-error": scenarioToolError,
  "s3-esc-mid-turn": scenarioEscMidTurn,
  "s4-kill-mid-turn": scenarioKillMidTurn,
  "s5-self-exit": scenarioSelfExit,
  "s6-denied-tool": scenarioDeniedTool,
  "s7-quiet-busy-turn": scenarioQuietBusyTurn,
  "s8-esc-mid-turn-fixed": scenarioEscMidTurnFixed,
};

// ─── run ────────────────────────────────────────────────────────────────────

// Scenarios are runnable one at a time (each is a real model turn; re-running
// the whole set to re-measure one is wasteful and burns account quota). Each
// run's raw result is parked under /private/tmp and the capture is REBUILT from
// every parked result, so the committed capture always holds the full matrix
// however the arms were run.
const RESULT_DIR = path.join(ROOT, "results");
fs.mkdirSync(RESULT_DIR, { recursive: true });

const only = process.argv.slice(2).filter((arg) => !arg.startsWith("-"));
// `--capture-only` re-renders the capture from the parked results without
// spending another real turn (the arms are run one at a time by design).
const selected = process.argv.includes("--capture-only")
  ? []
  : only.length > 0
    ? only
    : Object.keys(SCENARIOS);

for (const name of selected) {
  const scenario = SCENARIOS[name];
  if (!scenario) {
    console.error(`unknown scenario: ${name}`);
    process.exitCode = 2;
    continue;
  }
  process.stderr.write(`\n=== ${name} ===\n`);
  let result;
  try {
    result = await scenario();
  } catch (error) {
    result = { scenario: name, error: String(error?.stack ?? error) };
  }
  result.ranAt = new Date().toISOString();
  fs.writeFileSync(path.join(RESULT_DIR, `${name}.json`), JSON.stringify(result, null, 2));
  process.stderr.write(`${name}: ${result.verdict ?? result.error ?? "?"}\n`);
}

pinVersion("probe end");

const results = Object.keys(SCENARIOS)
  .map((name) => path.join(RESULT_DIR, `${name}.json`))
  .filter((file) => fs.existsSync(file))
  .map((file) => JSON.parse(fs.readFileSync(file, "utf8")));

const capture = [
  `# Q11 — claude hook COVERAGE MATRIX for turn completion (SL-2b)`,
  ``,
  `binary: ${version} (re-pinned at probe end)`,
  `spawn: production TerminalHost from dist/, --permission-mode default, injected --settings,`,
  `       approvalBroker:false (native-approval mode — the scrape is the trust/deny channel)`,
  `candidate events injected (arms marked candidates:true): ${CANDIDATE_EVENTS.map((c) => c.event).join(", ")}`,
  ``,
  `## matrix`,
  ``,
  `| scenario | hooks observed (in order) | run closed? | verdict |`,
  `|---|---|---|---|`,
  ...results.map((result) => {
    const order = (result.hooks ?? []).map((h) => h.event).join(" → ") || "—";
    const closed = result.activeRunAtEnd === null || result.activeRunAtEnd === undefined ? "yes" : `NO (${result.activeRunAtEnd.status})`;
    return `| ${result.scenario} | ${order} | ${closed} | ${result.verdict ?? result.error ?? "?"} |`;
  }),
  ``,
  `## per-scenario detail`,
  ``,
  ...results.map(renderScenario),
].join("\n");

/** Render one arm. The two long arrays — the ~1.8s completion-judge re-arms and
 *  the 5s channel samples — are rendered as TABLES with consecutive identical
 *  rows collapsed: a hundred byte-identical JSON objects is data, not evidence,
 *  and the point of a capture is that it can be read. */
function renderScenario(result) {
  const { runStates, busySamples, idleSamples, samples, ...rest } = result;
  const parts = [`### ${result.scenario}`, ``, sanitize(JSON.stringify(rest, null, 2)), ``];
  if (runStates?.length) {
    parts.push(`run lifecycle (${runStates.length} run:updated events, identical rows collapsed):`, "```", ...collapse(
      runStates,
      (state) => `${state.status} / ${state.statusReason ?? "-"} / ${state.completionSource ?? "-"} / ${state.completionConfidence ?? "-"}`,
      (state) => `${String(state.atMs).padStart(7)}  ${state.status} · ${state.statusReason ?? "-"} · ${state.completionSource ?? "-"} · ${state.completionConfidence ?? "-"}`,
    ), "```", ``);
  }
  for (const [label, rows] of [
    ["busy samples (the turn genuinely running)", busySamples],
    ["samples", samples],
    ["samples after the event", idleSamples],
  ]) {
    if (!rows?.length) continue;
    parts.push(
      `${label} (${rows.length}; run | stream detectIdlePrompt | grid detectIdlePrompt | runRaw detectIdleComposer | grid detectIdleComposer | grid spinner/verb):`,
      "```",
      ...collapse(rows, sampleKey, sampleRow),
      "```",
      ``,
    );
  }
  return parts.join("\n");
}

function sampleKey(sample) {
  return [
    sample.run?.status ?? "closed",
    sample.streamPrompt.ready, sample.streamPrompt.confidence,
    sample.gridPrompt.ready, sample.gridPrompt.confidence,
    sample.runRawComposer.completed, sample.runRawComposer.confidence,
    sample.gridComposer.completed, sample.gridComposer.confidence,
    sample.gridHasSpinnerGlyph, sample.gridHasEllipsisVerb,
  ].join("|");
}

function sampleRow(sample) {
  const flag = (value) => (value ? "T" : "F");
  return (
    `${String(sample.atMs).padStart(7)}  run=${(sample.run?.status ?? "CLOSED").padEnd(20)}` +
    ` stream=${flag(sample.streamPrompt.ready)}/${sample.streamPrompt.confidence.padEnd(6)}` +
    ` grid=${flag(sample.gridPrompt.ready)}/${sample.gridPrompt.confidence.padEnd(6)}` +
    ` runRawComp=${flag(sample.runRawComposer.completed)}/${sample.runRawComposer.confidence.padEnd(6)}` +
    ` gridComp=${flag(sample.gridComposer.completed)}/${sample.gridComposer.confidence.padEnd(6)}` +
    ` spinner=${flag(sample.gridHasSpinnerGlyph)} verb=${flag(sample.gridHasEllipsisVerb)}`
  );
}

/** Collapse consecutive rows whose `key` is identical into first + a repeat
 *  marker + last. Nothing is dropped that changes. */
function collapse(rows, key, render) {
  const out = [];
  let index = 0;
  while (index < rows.length) {
    let end = index;
    while (end + 1 < rows.length && key(rows[end + 1]) === key(rows[index])) end += 1;
    out.push(render(rows[index]));
    if (end > index + 1) out.push(`         … ${end - index - 1} identical row(s) …`);
    if (end > index) out.push(render(rows[end]));
    index = end + 1;
  }
  return out;
}

fs.writeFileSync(path.join(OUT_DIR, "q11-hook-coverage.capture.txt"), capture);
console.log(
  JSON.stringify(
    {
      success: results.every((result) => !result.error),
      version,
      scenarios: results.map((result) => ({
        scenario: result.scenario,
        hooks: (result.hooks ?? []).map((h) => h.event),
        verdict: result.verdict ?? result.error ?? "?",
      })),
    },
    null,
    2,
  ),
);

function compactPayload(payload = {}) {
  const keep = {};
  for (const key of ["kind", "decision", "encodedAs", "reason", "exitCode", "signal", "sonataInitiated", "source"]) {
    if (payload[key] !== undefined) keep[key] = payload[key];
  }
  return keep;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
