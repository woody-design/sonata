// Q33 (2026-09 sync, SL-15) — the FIX, verified against the real codex CLI
// through the production `TerminalHost.stopRun()`.
//
// q31 mapped what the keys DO. This runs Sonata's own stop button at them.
//
// ARMS
//   v1-production-stop  production `stopRun()` on a turn that is verifiably
//                       STREAMING — the phase where the key it used to write is
//                       measured NOT to interrupt (q34).
//
// THE PHASE IS THE POINT, and this arm's first draft got it wrong. It ran an A/B
// inside one turn — Esc first as an "inert" control, then the stop — and the
// CONTROL LEG INTERRUPTED, contradicting C17. q34 resolved it: at 0.152.1 Esc
// interrupts a codex turn only BEFORE output starts, and does nothing once tokens
// are landing (2/2 each way), while Ctrl+C interrupts in both phases (4/4). The
// draft's Esc had landed +2.0s in, still in the thinking phase; C17's three
// rounds landed +3.0…4.7s in, mid-stream. Both were right about the cell they
// measured. So the control leg is dropped from this arm — a control whose phase
// is uncontrolled proves nothing — and q34 carries the A/B properly: the same
// key, at the same phase, repeated. What v1 must show is the end-to-end claim:
// at the phase where the old key does nothing, the stop button now stops the turn.
//   v2-interrupt-source a human interrupt in the co-visible Terminal, driven
//                       through the production hook dispatch, to prove the run
//                       closes as `hook-interrupt` on the EVENT — the value
//                       `RuntimeController.isPendingTurnEnd` reads to release a
//                       broker ask the interrupt orphaned (SL-9 B1 / C25).
//   v4-hold-interrupt   the C25 scenario itself, re-run through the fix: the
//                       PRODUCTION broker HOLDING a real ask when the interrupt
//                       lands. The state SL-9's B1 defect lived in.
//   v3-idle-stop        the stop pressed at an IDLE composer — empty, then
//                       holding a draft. The arm that has to prove a negative:
//                       nothing harmful happens. A single Ctrl+C in the empty
//                       case QUITS this binary (q31 s2), so "the pty is still
//                       alive and the session still answers" is the assertion.
//
// WHY v1 CANNOT ASSERT `hook-interrupt`. A Sonata-initiated stop closes the run
// LOCALLY inside `stopRun` (`finishActiveRun("stopped", …)`, source
// `native-control`) — the honest source, since Sonata is what ended it. The
// `Interrupt` hook lands ~130ms later on a run that is already closed and is a
// no-op by design. `hook-interrupt` is therefore the shape of an interrupt
// Sonata did NOT initiate (a human's Ctrl+C in the Terminal), which is v2.
//
// AND WHY THAT IS THE WHOLE CHAIN. The release of an orphaned broker ask lives in
// `RuntimeController`, not in the host. It is pinned on the REAL controller (real
// ApprovalWatcher, real HookWatcher, real dispatch) by
// `tests/smoke/interrupt-hook-pending-approval.mjs`, which passes UNCHANGED
// across this slice — it pins behaviour, not the mechanism underneath. v2 closes
// the other half: that a LIVE codex interrupt now produces the typed event that
// smoke's controller acts on. Live CLI → typed event (here); typed event →
// release (there).
//
// SAFETY. Isolated CODEX_HOME under /private/tmp, credentials only, pre-trusted
// through Sonata's own ledger. The user's real `~/.codex` is never read for
// config nor written.
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import {
  CodexBoot,
  EXPECT_CODEX_VERSION,
  assertCodexVersion,
  codexVersion,
  runtime,
  seedCodexHome,
  sanitize,
  sleep,
} from "./driver.mjs";

const OUT_DIR = new URL(".", import.meta.url).pathname;
const APP_DIR = new URL("../../../app/", import.meta.url).pathname;
const require = createRequire(APP_DIR + "package.json");
const { HookWatcher, codexHooksDirectory } = runtime;
const { enableCodexAnswering } = require(APP_DIR + "dist/runtime/providers/codex/codex-approvals");

const ROOT = "/private/tmp/sonata-sync-2026-09/codex-stop-fix-live";
const ESC = "\x1b";
const CTRL_C = "\x03";
const LONG_PROMPT = "Count from 1 to 900, one number per line, nothing else.";

/** The count's own output — a screen line that is nothing but a number. The only
 *  unambiguous "tokens are landing" signal on this screen (q34's method note):
 *  codex's `Working (Ns …)` row and the prompt echo both fail it. */
function countedLines(screen) {
  return screen.split("\n").filter((line) => /^\s*\d+\s*$/.test(line)).length;
}
function highestCount(screen) {
  let highest = 0;
  for (const line of screen.split("\n")) {
    const match = /^\s*(\d+)\s*$/.exec(line);
    if (match) highest = Math.max(highest, Number(match[1]));
  }
  return highest;
}

assertCodexVersion("probe start");
const version = codexVersion();

class Arm {
  constructor(name, { approvalBroker = false } = {}) {
    this.name = name;
    this.hooks = [];
    this.notes = [];
    this.frames = [];
    this.runEvents = [];
    const runRoot = path.join(ROOT, name);
    fs.rmSync(runRoot, { recursive: true, force: true });
    this.workspace = path.join(runRoot, "ws");
    this.runtimeDir = path.join(runRoot, "runtime");
    this.binDir = path.join(runRoot, "bin");
    this.codexHome = seedCodexHome(path.join(runRoot, "codex-home"));
    for (const dir of [this.workspace, this.runtimeDir, this.binDir]) fs.mkdirSync(dir, { recursive: true });

    this.boot = new CodexBoot({
      taskId: `task-q33-${name}`,
      cwd: this.workspace,
      runtimeDir: this.runtimeDir,
      binDir: this.binDir,
      pretrustCwd: this.workspace,
      codexHome: this.codexHome,
      rows: 40,
      cols: 120,
      approvalBroker,
    });
    // The run-lifecycle fields this probe asserts on (status / completionSource /
    // statusReason) ride `CodexBoot`'s compact event projection — widened for
    // this probe in driver.mjs, additively.
    this.watcher = new HookWatcher({
      sinkDir: codexHooksDirectory,
      pollMs: 100,
      onPayload: (payload) => {
        const event = typeof payload.hook_event_name === "string" ? payload.hook_event_name : "<none>";
        this.hooks.push({ atMs: this.boot.at(), event });
        this.applyProductionDispatch(event, payload);
      },
      onError: (error, filePath) => this.notes.push(`hook-watcher error ${filePath}: ${error.message}`),
    });
  }

  /** EXACTLY the run-lifecycle edges `RuntimeController.handleHookPayload` applies
   *  for a codex task — including SL-15's typed ending on `Interrupt`. */
  applyProductionDispatch(event, payload) {
    const host = this.boot.host;
    if (event === "SessionStart") host.noteHookSessionStart();
    if (event === "UserPromptSubmit") {
      host.beginRunFromHook(typeof payload.prompt === "string" ? payload.prompt : "", {
        promptId: typeof payload.turn_id === "string" ? payload.turn_id : null,
      });
    }
    if (event === "Stop") host.completeRunFromTurnEnd();
    if (event === "Interrupt") host.completeRunFromTurnEnd({ ending: "interrupt" });
  }

  async start() {
    await this.boot.start();
    this.watcher.watchWorkspace(this.runtimeDir);
    const ready = await this.boot.waitUntil((b) => b.ready(), 90_000);
    this.notes.push(`ready=${ready !== null} at ${ready ?? "TIMEOUT"}ms`);
    return ready !== null;
  }

  async submitAndConfirm(text, { timeoutMs = 120_000 } = {}) {
    if (this.boot.ptyExited) return { ok: false, retries: 0 };
    const before = this.hooks.length;
    const submitted = () => this.hooks.slice(before).some((h) => h.event === "UserPromptSubmit");
    this.boot.host.submitPrompt(text);
    const deadline = Date.now() + timeoutMs;
    let retries = 0;
    while (Date.now() < deadline && !this.boot.ptyExited) {
      if (submitted()) return { ok: true, retries };
      await sleep(2000);
      if (submitted()) return { ok: true, retries };
      if (!this.boot.screen().includes(text.slice(0, 40))) continue;
      retries += 1;
      try {
        this.boot.host.writeRaw(retries % 2 === 1 ? "\r" : "\x1b[13u");
      } catch {
        break;
      }
    }
    return { ok: submitted(), retries };
  }

  async warmUp(text = "Reply with exactly: OK") {
    const before = this.hooks.length;
    const submit = await this.submitAndConfirm(text);
    if (!submit.ok) return false;
    const closed = await this.boot.waitUntil(() => this.hooks.slice(before).some((h) => h.event === "Stop"), 180_000);
    this.notes.push(`warm-up "${text.slice(0, 22)}" closed=${closed !== null} at ${closed ?? "TIMEOUT"}ms`);
    return closed !== null;
  }

  /** Is the turn still producing? Two consecutive screens, 900ms apart. Used to
   *  judge "the key did nothing" without waiting out a whole turn. */
  async screenStillGrowing(windowMs = 900) {
    const first = this.boot.screen();
    await sleep(windowMs);
    return this.boot.screen() !== first;
  }

  async waitForLiveTurn(before) {
    const started = await this.boot.waitUntil(
      () => this.hooks.slice(before).some((h) => h.event === "UserPromptSubmit"),
      120_000,
    );
    if (started === null) return { started: false, grew: false };
    let grew = false;
    for (let i = 0; i < 40 && !grew; i += 1) {
      if (await this.screenStillGrowing(250)) grew = true;
    }
    return { started: true, grew };
  }

  frame(label) {
    const entry = {
      label,
      atMs: this.boot.at(),
      ptyExited: this.boot.ptyExited,
      hostReady: this.boot.ptyExited ? null : this.boot.host.acceptsPromptInput(),
      activeRun: this.boot.host.activeRunId(),
      tail: sanitize(this.boot.screen().split("\n").slice(-12).join("\n")),
    };
    this.frames.push(entry);
    return entry;
  }

  /** The run-lifecycle events this arm saw, with the payload fields SL-15 is
   *  about. `CodexBoot`'s compact projection drops them, so they are re-read from
   *  its raw list here. */
  runLifecycle() {
    return this.boot.events
      .filter((event) => event.type.startsWith("run:"))
      .map((event) => ({ atMs: event.atMs, type: event.type, ...event.payload }));
  }

  finish(extra = {}) {
    const out = {
      arm: this.name,
      version,
      hookOrder: this.hooks.map((h) => `${h.event}@${h.atMs}`),
      notes: this.notes,
      frames: this.frames,
      ptyExited: this.boot.ptyExited,
      exitInfo: this.boot.exitInfo,
      ...extra,
    };
    try {
      this.watcher.dispose();
      this.boot.dispose();
    } catch {
      /* best-effort */
    }
    return out;
  }
}

/**
 * v1 — production `stopRun()` against a turn that is verifiably STREAMING.
 *
 * "Streaming" is judged from the count's own output — a screen line that is a
 * bare number — and the count must still be CLIMBING when the stop is called.
 * Nothing weaker will do: codex's `• Working (Ns • esc to interrupt)` row ticks
 * its timer once a second, so "the screen is growing" (the gate both C17 and this
 * arm's first draft used) is satisfied by a turn that has produced nothing at all.
 */
async function armProductionStop() {
  const arm = new Arm("v1-production-stop");
  if (!(await arm.start())) return arm.finish({ verdict: "BOOT FAILED" });
  if (!(await arm.warmUp())) return arm.finish({ verdict: "WARM-UP FAILED" });

  const before = arm.hooks.length;
  if (!(await arm.submitAndConfirm(LONG_PROMPT)).ok) return arm.finish({ verdict: "SUBMIT FAILED" });
  const submittedAt = arm.hooks.slice(before).find((h) => h.event === "UserPromptSubmit")?.atMs ?? arm.boot.at();

  const appeared = await arm.boot.waitUntil((b) => countedLines(b.screen()) > 0, 90_000, 100);
  const countBefore = highestCount(arm.boot.screen());
  await sleep(1200);
  const countAfter = highestCount(arm.boot.screen());
  const streaming = appeared !== null && countAfter > countBefore;
  arm.notes.push(`streaming=${streaming} (count ${countBefore} → ${countAfter}, first output at ${appeared ?? "TIMEOUT"}ms)`);
  arm.frame("turn streaming");
  if (!streaming) return arm.finish({ verdict: "NEVER REACHED THE STREAMING PHASE — cell UNMEASURED" });

  const stopAt = arm.boot.at();
  const countAtStop = highestCount(arm.boot.screen());
  let stopResult = null;
  try {
    stopResult = await arm.boot.host.stopRun({ inspectDelayMs: 60_000 });
  } catch (error) {
    arm.notes.push(`stopRun threw: ${error.message}`);
  }
  await sleep(3000);
  const interrupt = arm.hooks.slice(before).find((h) => h.event === "Interrupt" && h.atMs > stopAt) ?? null;
  const stopHook = arm.hooks.slice(before).find((h) => h.event === "Stop" && h.atMs > stopAt) ?? null;
  // The decisive observation, and it is about the OUTPUT rather than about any
  // hook: a turn that survived the key keeps counting.
  const countAfterStop = highestCount(arm.boot.screen());
  await sleep(2500);
  const countLater = highestCount(arm.boot.screen());
  arm.frame("after the production stop");

  const scrollback = arm.boot.scrollback();
  const stopped = countLater === countAfterStop;
  return arm.finish({
    msIntoTurn: stopAt - submittedAt,
    countAtStop,
    countAfterStop,
    countLater,
    countStoppedClimbing: stopped,
    stopResult,
    interruptHookAtMs: interrupt ? interrupt.atMs - stopAt : null,
    stopHookAfterStop: Boolean(stopHook),
    interruptedBanner: /Conversation interrupted/i.test(scrollback),
    reachedEnd: /^\s*900\s*$/m.test(scrollback),
    ptyAlive: !arm.boot.ptyExited,
    runLifecycle: arm.runLifecycle(),
    verdict:
      interrupt && stopped && !arm.boot.ptyExited
        ? `FIXED — the production stop interrupted a STREAMING turn (Interrupt +${interrupt.atMs - stopAt}ms, count froze at ${countLater}/900)`
        : "UNEXPECTED — see the fields",
  });
}

/** v2 — a human interrupt, and the typed source it must produce. */
async function armInterruptSource() {
  const arm = new Arm("v2-interrupt-source");
  if (!(await arm.start())) return arm.finish({ verdict: "BOOT FAILED" });
  if (!(await arm.warmUp())) return arm.finish({ verdict: "WARM-UP FAILED" });

  const before = arm.hooks.length;
  if (!(await arm.submitAndConfirm(LONG_PROMPT)).ok) return arm.finish({ verdict: "SUBMIT FAILED" });
  const live = await arm.waitForLiveTurn(before);
  arm.notes.push(`live turn: started=${live.started} grew=${live.grew}`);

  // The co-visible-Terminal path a human actually types on.
  const pressedAt = arm.boot.at();
  arm.boot.host.writeUserInput(CTRL_C);
  await sleep(3000);
  arm.frame("after the human Ctrl+C");

  const interruptHook = arm.hooks.slice(before).find((h) => h.event === "Interrupt" && h.atMs > pressedAt) ?? null;
  const lifecycle = arm.runLifecycle();
  const closing = lifecycle.filter((event) => event.type === "run:updated" && event.status === "completed").at(-1);

  return arm.finish({
    interruptHookAtMs: interruptHook ? interruptHook.atMs - pressedAt : null,
    stopHookAfterPress: arm.hooks.slice(before).some((h) => h.event === "Stop" && h.atMs > pressedAt),
    closingEvent: closing ?? null,
    completionSource: closing?.completionSource ?? null,
    statusReason: closing?.statusReason ?? null,
    runLifecycle: lifecycle,
    verdict:
      closing?.completionSource === "hook-interrupt"
        ? "TYPED — the live interrupt closes the run as hook-interrupt"
        : `UNEXPECTED completionSource: ${closing?.completionSource ?? "<no completion>"}`,
  });
}

/**
 * v3 — the stop pressed at an idle composer, twice over: empty, then holding a
 * draft. The assertion is a NEGATIVE, so it is made positively: the pty is still
 * alive, the draft is still on the line, and the session still answers a prompt.
 */
async function armIdleStop() {
  const arm = new Arm("v3-idle-stop");
  if (!(await arm.start())) return arm.finish({ verdict: "BOOT FAILED" });
  if (!(await arm.warmUp())) return arm.finish({ verdict: "WARM-UP FAILED" });
  await sleep(1500);

  // Leg 1 — an EMPTY idle composer. The cell where one Ctrl+C quits (q31 s2).
  arm.frame("idle, empty, before the stop");
  const emptyStopAt = arm.boot.at();
  let emptyStopThrew = null;
  try {
    await arm.boot.host.stopRun({ inspectDelayMs: 60_000 });
  } catch (error) {
    emptyStopThrew = error.message;
  }
  await sleep(2500);
  const afterEmpty = arm.frame("after the stop at an empty idle composer");
  const survivedEmptyStop = !arm.boot.ptyExited;

  // Leg 2 — an idle composer holding a DRAFT the user typed in the Terminal.
  const DRAFT = "DRAFTKEEP";
  let draftBefore = null;
  let draftAfter = null;
  if (survivedEmptyStop) {
    for (const char of DRAFT) {
      arm.boot.host.writeUserInput(char);
      await sleep(45);
    }
    await sleep(1000);
    draftBefore = arm.boot.screen().includes(DRAFT);
    arm.frame("draft typed at an idle composer");
    try {
      await arm.boot.host.stopRun({ inspectDelayMs: 60_000 });
    } catch (error) {
      arm.notes.push(`draft-leg stopRun threw: ${error.message}`);
    }
    await sleep(1500);
    draftAfter = arm.boot.screen().includes(DRAFT);
    arm.frame("after the stop with a draft on the line");
  }

  // The proof the session is unharmed: it still runs a turn.
  const stillWorks = arm.boot.ptyExited ? false : await arm.warmUp("Reply with exactly: STILL_ALIVE");
  arm.frame("after the proof turn");

  return arm.finish({
    emptyStopAt,
    emptyStopThrew,
    survivedEmptyStop,
    draftBefore,
    draftAfter,
    afterEmptyReady: afterEmpty.hostReady,
    sessionStillWorks: stillWorks,
    stillAliveSaid: /STILL_ALIVE/.test(arm.boot.scrollback()),
    verdict: !survivedEmptyStop
      ? "HARM — the stop at an idle composer killed the CLI"
      : stillWorks
        ? "SAFE — the idle stop is inert and the session still answers"
        : "INCONCLUSIVE — survived, but the proof turn did not close",
  });
}

/**
 * v4 — C25, re-run through the fix.
 *
 * SL-9's B1 defect needed one specific state: the production broker HOLDING a
 * real `PermissionRequest` ask when the turn ends by interrupt. The interrupt
 * kills the holding hook, so nothing will ever write that ask a reply or an
 * expiry marker — and on the `hook-stop` route its id sat in
 * `pendingBrokerApprovals` forever, gating every later send INVISIBLY. This arm
 * establishes exactly that state against the real CLI and checks the event the
 * release now depends on.
 *
 * Two things are asserted, and the second is what makes the first mean anything:
 *   - the run closes as `hook-interrupt` (the value `isPendingTurnEnd` reads);
 *   - the ask is STILL on disk, unreplied and unexpired, when it does — i.e. the
 *     orphan is real and the typed source is the only thing standing between it
 *     and a permanent hold.
 *
 * The escalation is NETWORK, not a filesystem write: codex's own turn log shows
 * `WorkspaceWrite { exclude_slash_tmp: false }`, so a /tmp write runs unattended
 * (C25's method note). Network access is `false`, so it must escalate — and it
 * has no filesystem effect, which matters for a command this arm never approves.
 */
async function armHoldInterrupt() {
  const arm = new Arm("v4-hold-interrupt", { approvalBroker: true });
  // Production arms answering in `watchHooks`; this probe drives the host
  // directly, so it must arm the marker itself or the broker shim exits inert
  // and codex paints its native card instead of holding.
  enableCodexAnswering(arm.runtimeDir);
  if (!(await arm.start())) return arm.finish({ verdict: "BOOT FAILED" });

  const approvalsDir = path.join(arm.runtimeDir, "approvals");
  const listApprovals = () => {
    try {
      return fs.readdirSync(approvalsDir).sort();
    } catch {
      return [];
    }
  };

  if (!(await arm.warmUp())) return arm.finish({ verdict: "WARM-UP FAILED" });
  await sleep(2000);

  const before = arm.hooks.length;
  const submit = await arm.submitAndConfirm(
    "Run exactly this shell command and nothing else: curl -sS https://example.com",
  );
  if (!submit.ok) return arm.finish({ verdict: "PROMPT NEVER SUBMITTED" });

  const askAppeared = await arm.boot.waitUntil(
    () => listApprovals().some((name) => /^ask-.+\.json$/.test(name)),
    120_000,
    200,
  );
  const approvalsAtHold = listApprovals();
  arm.notes.push(`ask surfaced=${askAppeared !== null} at ${askAppeared ?? "TIMEOUT"}ms — ${JSON.stringify(approvalsAtHold)}`);
  if (askAppeared === null) {
    return arm.finish({ approvalsAtHold, verdict: "UNREPRODUCED — no broker hold established, premise untested" });
  }

  await sleep(1500);
  arm.frame("broker holding a real ask");
  const pressedAt = arm.boot.at();
  arm.boot.host.writeUserInput(CTRL_C);
  await sleep(20_000);
  arm.frame("20s after the interrupt");

  const after = arm.hooks.slice(before).filter((h) => h.atMs > pressedAt);
  const interrupt = after.find((h) => h.event === "Interrupt") ?? null;
  const stop = after.find((h) => h.event === "Stop") ?? null;
  const approvalsAfter = listApprovals();
  const lifecycle = arm.runLifecycle();
  const closing = lifecycle.filter((event) => event.type === "run:updated" && event.status === "completed").at(-1);
  // The orphan, restated as a fact about the disk: the ask is still there, with
  // no `reply-` and no `expired-` sibling, long after the turn ended.
  const askId = approvalsAtHold.find((name) => /^ask-/.test(name)) ?? null;
  const stem = askId ? askId.replace(/^ask-/, "").replace(/\.json$/, "") : null;
  const orphaned = Boolean(
    stem &&
      approvalsAfter.includes(askId) &&
      !approvalsAfter.some((name) => name.startsWith(`reply-${stem}`) || name.startsWith(`expired-${stem}`)),
  );

  return arm.finish({
    approvalsAtHold,
    approvalsAfterInterrupt: approvalsAfter,
    askOrphaned: orphaned,
    interruptAfterMs: interrupt ? interrupt.atMs - pressedAt : null,
    stopAfterPress: Boolean(stop),
    completionSource: closing?.completionSource ?? null,
    statusReason: closing?.statusReason ?? null,
    runLifecycle: lifecycle,
    verdict:
      closing?.completionSource === "hook-interrupt" && orphaned
        ? "C25 RE-RUN — the ask is orphaned exactly as measured, and the run now closes as hook-interrupt (the pending-turn-end the release reads)"
        : `UNEXPECTED — source=${closing?.completionSource ?? "<none>"} orphaned=${orphaned}`,
  });
}

const results = {};
const REQUESTED = (process.env.ARMS ?? "v1,v2,v3,v4").split(",").map((name) => name.trim());
const SHARD_DIR = path.join(OUT_DIR, "q33-shards");
fs.mkdirSync(SHARD_DIR, { recursive: true });
async function runArm(key, body) {
  if (!REQUESTED.includes(key)) {
    try {
      return JSON.parse(fs.readFileSync(path.join(SHARD_DIR, `${key}.json`), "utf8"));
    } catch {
      return null;
    }
  }
  const result = await body();
  fs.writeFileSync(path.join(SHARD_DIR, `${key}.json`), sanitize(JSON.stringify(result, null, 2)));
  return result;
}

results.v1 = await runArm("v1", armProductionStop);
results.v2 = await runArm("v2", armInterruptSource);
results.v3 = await runArm("v3", armIdleStop);
results.v4 = await runArm("v4", armHoldInterrupt);

let endVersion = null;
let versionDrift = null;
try {
  endVersion = codexVersion();
  if (!endVersion.includes(EXPECT_CODEX_VERSION)) versionDrift = `drifted to ${endVersion}`;
} catch (error) {
  versionDrift = `version check failed: ${error.message}`;
}

const outPath = path.join(OUT_DIR, "q33-stop-fix-live.capture.txt");
fs.writeFileSync(
  outPath,
  sanitize(
    JSON.stringify(
      {
        probe: "q33-stop-fix-live",
        question: "Does Sonata's production stop button stop a codex turn now — and is it inert at an idle composer?",
        version,
        endVersion,
        versionDrift,
        armsRunThisInvocation: REQUESTED,
        results,
      },
      null,
      2,
    ),
  ),
);
console.log(
  JSON.stringify(
    {
      success: true,
      outPath,
      versionDrift,
      verdicts: Object.fromEntries(Object.entries(results).map(([k, v]) => [k, v?.verdict ?? "<not run>"])),
    },
    null,
    2,
  ),
);
