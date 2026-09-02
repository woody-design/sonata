// Q31 (2026-09 sync, SL-15) — the STATE MAP of Ctrl+C at codex 0.152.1, measured
// BEFORE any key is wired into Sonata's stop path.
//
// WHY THIS PROBE EXISTS. C17 measured one cell of the table: mid-turn, Ctrl+C
// interrupts and Esc does not. That is enough to know the stop button is broken
// and NOT enough to fix it, because 0.152.1 binds Ctrl+C to a FIXED action named
// `fixed.interrupt_or_quit` (the binary's own keymap-action vocabulary — see
// `keymapActions()` below, read out of the binary each run), and the same binary
// carries the footer fragment `" again to quit"` and the log line
// `"failed to append Ctrl+C-cleared draft to history: no active thread id"`.
// Both strings say the key means something OTHER than "interrupt" when no turn
// is running. The trust-flip lesson (SL-1: a dialog's default row moved and
// Sonata's approve started EXITING the CLI) is exactly this shape — a key whose
// meaning is state-dependent, wired on the strength of one state's measurement.
//
// So: map the state space first, then wire.
//
// ARMS (each its own spawn, production TerminalHost + production hook dispatch)
//   s1-midturn        a live turn + Ctrl+C. Re-pins C17 round 3 and adds three
//                     questions C17 did not ask: does the interrupted prompt come
//                     BACK into the composer (the `cliInputMaybeDirty` premise
//                     `writeUserInput` encodes for Esc)? does the codex GRID read
//                     as an idle composer WHILE the turn runs (i.e. can a grid
//                     predicate serve as a second, independent "a turn is live"
//                     signal, or is it the coin flip F12 measured on claude)? and
//                     what does a SECOND Ctrl+C do a beat after the interrupt —
//                     the shape Sonata's own one-shot stop resend would take?
//   s2-idle-empty     ONE Ctrl+C at an idle EMPTY composer.
//   s3-idle-draft     ONE Ctrl+C at an idle composer holding TEXT, then a SECOND
//                     one on the composer the first press left behind.
//   s7-picker         `/model` picker open: Ctrl+C, and Esc (the rollback
//                     choreography `CODEX_MODEL_MAX_ROLLBACK_ESCS` depends on).
//   s8-approval       a native approval panel owning the screen: Ctrl+C. Sonata's
//                     stop writes Esc here today and BOOKS IT AS A DENY
//                     (`settleApprovalAsEscDeny`), so this cell decides whether
//                     the approval arm may change key at all.
//
// ARMS DESIGNED AND DROPPED, and why — the measurement collapsed them. The first
// draft carried four more arms (a fast Ctrl+C pair, a slow pair at the measured
// arming window, a "does typing disarm it" arm, and an "arm the quit at idle,
// then run a turn, then interrupt" trap arm). All four presuppose that the first
// press ARMS a quit rather than performing one — the shape the binary's
// `" again to quit"` fragment suggested. s2 measured the stronger fact: at an
// idle EMPTY composer the FIRST Ctrl+C quits, `exitCode 0`, no hint, no
// confirmation. There is no arming window to bisect, no arming to disarm, and no
// armed state to carry into a turn. Recorded rather than deleted silently,
// because "we looked for a confirmation step and there is none" is the finding.
//
// CHANNEL. The interrupt is written with `writeRaw`, which is the byte path
// `stopRun` itself uses — not `writeUserInput`, whose human-input settle timer
// and Esc-dirty branch would put probe scaffolding between the key and the CLI.
// Where the question is about the HUMAN path (s1's composer-restore check) the
// difference is called out in the note.
//
// SAFETY. Isolated CODEX_HOME under /private/tmp seeded with credentials only,
// pre-trusted through Sonata's own ledger. The user's real `~/.codex` is never
// read for config nor written. Several arms deliberately KILL the CLI; each owns
// its own spawn so no other arm's measurement rides on a dead pty.
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
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

const {
  detectIdlePromptForProvider,
  codexModelPickerFooterVisible,
  codexModelPickerLevel1Open,
} = runtime;

const OUT_DIR = new URL(".", import.meta.url).pathname;
const APP_DIR = new URL("../../../app/", import.meta.url).pathname;
const require = createRequire(APP_DIR + "package.json");
const { HookWatcher, codexHooksDirectory } = runtime;

const ROOT = "/private/tmp/sonata-sync-2026-09/codex-ctrlc-state-map";
const COLS = 120;
const ROWS = 40;
const CTRL_C = "\x03";
const KILL_LINE = "\x15";
const ESC = "\x1b";

assertCodexVersion("probe start");
const version = codexVersion();

// ─── the documentation half, read from the binary this run is pinned to ──────
function codexBinaryPath() {
  return execFileSync("bash", ["-c", 'readlink -f "$(which codex)" || which codex'], {
    encoding: "utf8",
  }).trim();
}

/** The keymap ACTION names 0.152.1 ships. `fixed.*` actions are the ones that
 *  are NOT rebindable through `tui.keymap` — which is the interesting fact here:
 *  `chat.interrupt_turn` is configurable, `fixed.interrupt_or_quit` is not. */
const ACTION_SCOPES = ["chat", "composer", "fixed", "list", "approval", "editor", "global"];
function keymapActions() {
  const hay = fs.readFileSync(codexBinaryPath()).toString("latin1");
  const at = hay.indexOf("fixed.interrupt_or_quit");
  if (at < 0) return null;
  const window = hay.slice(Math.max(0, at - 700), at + 700);
  // The action names are stored CONCATENATED with no separator, so a greedy
  // `[a-z_]+` swallows the head of the next name. Trim any trailing scope word
  // back off — `chat.decrease_reasoning_effortchat` → `chat.decrease_reasoning_effort`.
  const raw = window.match(/(?:chat|composer|fixed|list|approval|editor|global)\.[a-z_]+/g) ?? [];
  const trimmed = raw.map((name) => {
    let out = name;
    for (const scope of ACTION_SCOPES) {
      if (out.endsWith(scope) && out.length > scope.length + 1) out = out.slice(0, -scope.length);
    }
    return out;
  });
  return [...new Set(trimmed)].sort();
}

/** The two literal strings that made this probe necessary. Recorded verbatim so
 *  the findings can cite the binary rather than an inference from the screen. */
function quitVocabulary() {
  const hay = fs.readFileSync(codexBinaryPath()).toString("latin1");
  return {
    againToQuit: hay.includes(" again to quit"),
    ctrlCClearedDraft: hay.includes("failed to append Ctrl+C-cleared draft to history"),
    interruptOrQuitAction: hay.includes("fixed.interrupt_or_quit"),
    fixedQuitAction: hay.includes("fixed.quit"),
  };
}

// ─── harness ────────────────────────────────────────────────────────────────

const REDACT_VALUE_KEYS = new Set(["transcript_path", "cwd", "session_id", "turn_id", "tool_use_id"]);
function renderPayload(payload) {
  const out = {};
  for (const [key, raw] of Object.entries(payload)) {
    if (REDACT_VALUE_KEYS.has(key)) {
      out[key] = typeof raw === "string" ? `<${key}:${raw.length}ch>` : raw;
      continue;
    }
    if (typeof raw === "string") {
      out[key] = sanitize(raw.length > 160 ? `${raw.slice(0, 160)}…[${raw.length}ch]` : raw);
      continue;
    }
    out[key] = raw;
  }
  return out;
}

class Arm {
  constructor(name, { approvalBroker = false } = {}) {
    this.name = name;
    this.hooks = [];
    this.notes = [];
    this.frames = [];
    const runRoot = path.join(ROOT, name);
    fs.rmSync(runRoot, { recursive: true, force: true });
    this.workspace = path.join(runRoot, "ws");
    this.runtimeDir = path.join(runRoot, "runtime");
    this.binDir = path.join(runRoot, "bin");
    this.codexHome = seedCodexHome(path.join(runRoot, "codex-home"));
    fs.mkdirSync(this.workspace, { recursive: true });
    fs.mkdirSync(this.runtimeDir, { recursive: true });
    fs.mkdirSync(this.binDir, { recursive: true });

    this.boot = new CodexBoot({
      taskId: `task-q31-${name}`,
      cwd: this.workspace,
      runtimeDir: this.runtimeDir,
      binDir: this.binDir,
      pretrustCwd: this.workspace,
      codexHome: this.codexHome,
      rows: ROWS,
      cols: COLS,
      approvalBroker,
    });
    this.watcher = new HookWatcher({
      sinkDir: codexHooksDirectory,
      pollMs: 100,
      onPayload: (payload) => {
        const event = typeof payload.hook_event_name === "string" ? payload.hook_event_name : "<none>";
        this.hooks.push({ atMs: this.boot.at(), event, payload: renderPayload(payload) });
        this.applyProductionDispatch(event, payload);
      },
      onError: (error, filePath) => this.notes.push(`hook-watcher error ${filePath}: ${error.message}`),
    });
  }

  /** EXACTLY the run-lifecycle edges `RuntimeController.handleHookPayload` applies
   *  for a codex task (h3's dispatch, unchanged) — without them the host never
   *  opens a run and "was a turn live?" has no answer on Sonata's side. */
  applyProductionDispatch(event, payload) {
    const host = this.boot.host;
    if (event === "SessionStart") host.noteHookSessionStart();
    if (event === "UserPromptSubmit") {
      host.beginRunFromHook(typeof payload.prompt === "string" ? payload.prompt : "", {
        promptId: typeof payload.turn_id === "string" ? payload.turn_id : null,
      });
    }
    if (event === "Stop" || event === "Interrupt") host.completeRunFromTurnEnd();
  }

  async start() {
    await this.boot.start();
    this.watcher.watchWorkspace(this.runtimeDir);
    const ready = await this.boot.waitUntil((b) => b.ready(), 90_000);
    this.notes.push(`ready=${ready !== null} at ${ready ?? "TIMEOUT"}ms`);
    return ready !== null;
  }

  /** Submit and CONFIRM the CLI took it (a `UserPromptSubmit` hook), with the
   *  Enter-retry ladder h3 measured to be necessary on a first submission. Probe
   *  scaffolding, and only ever used BEFORE the key under test is pressed. */
  async submitAndConfirm(text, { timeoutMs = 120_000 } = {}) {
    const before = this.hooks.length;
    const submitted = () => this.hooks.slice(before).some((h) => h.event === "UserPromptSubmit");
    this.boot.host.submitPrompt(text);
    const deadline = Date.now() + timeoutMs;
    let retries = 0;
    while (Date.now() < deadline && !this.boot.ptyExited) {
      if (submitted()) return { ok: true, retries, atMs: this.boot.at() };
      await sleep(2000);
      if (submitted()) return { ok: true, retries, atMs: this.boot.at() };
      if (!this.boot.screen().includes(text.slice(0, 40))) continue;
      retries += 1;
      this.boot.host.writeRaw(retries % 2 === 1 ? "\r" : "\x1b[13u");
      this.notes.push(`submit retry ${retries} at ${this.boot.at()}ms`);
    }
    return { ok: submitted(), retries, atMs: this.boot.at() };
  }

  /** Run a warm-up turn to completion. Every state question downstream of "the
   *  composer is idle AFTER a turn" needs a turn to have happened — a virgin
   *  composer is a different state (no history to backtrack into, no draft to
   *  clear) and would answer a question nobody asked. */
  async warmUp(text = "Reply with exactly: OK") {
    // Scoped to the hooks THIS warm-up produces: an arm that warms up twice
    // (s2's proof turn) would otherwise see the FIRST turn's `Stop` and return
    // instantly, reporting a turn that never ran as closed.
    const before = this.hooks.length;
    const submit = await this.submitAndConfirm(text);
    this.notes.push(`warm-up "${text.slice(0, 24)}" submitted=${submit.ok} (${submit.retries} retries)`);
    if (!submit.ok) return false;
    const closed = await this.boot.waitUntil((b) => {
      void b;
      return this.hooks.slice(before).some((h) => h.event === "Stop");
    }, 180_000);
    this.notes.push(`warm-up closed=${closed !== null} at ${closed ?? "TIMEOUT"}ms`);
    return closed !== null;
  }

  /** Type `text` a character at a time. A single multi-character `write` trips
   *  codex's paste-burst detection and lands as a `[pasted text]` placeholder,
   *  which is a different composer state than the one s3 is asking about. */
  async type(text, perCharMs = 45) {
    for (const char of text) {
      this.boot.host.writeRaw(char);
      await sleep(perCharMs);
    }
  }

  /** Wait for the turn to be GENUINELY streaming — a screen that is still
   *  growing and no `Stop` yet. C17's method: a key pressed into a finished turn
   *  measures nothing. */
  async waitForLiveTurn(before) {
    const stopped = () => this.hooks.slice(before).some((h) => h.event === "Stop");
    const started = await this.boot.waitUntil(
      () => this.hooks.slice(before).some((h) => h.event === "UserPromptSubmit"),
      120_000,
    );
    if (started === null) return { started: false, grew: false, stoppedAlready: stopped() };
    let grew = false;
    for (let i = 0; i < 40 && !grew && !stopped(); i += 1) {
      const first = this.boot.screen();
      await sleep(250);
      grew = this.boot.screen() !== first;
    }
    return { started: true, grew, stoppedAlready: stopped() };
  }

  frame(label) {
    const screen = this.boot.screen();
    const entry = {
      label,
      atMs: this.boot.at(),
      ptyExited: this.boot.ptyExited,
      hostReady: this.boot.ptyExited ? null : this.boot.host.acceptsPromptInput(),
      activeRun: this.boot.host.activeRunId(),
      quitHint: quitHintLine(screen),
      composer: composerState(screen),
      tail: sanitize(screen.split("\n").slice(-14).join("\n")),
    };
    this.frames.push(entry);
    return entry;
  }

  /** Poll until the pty dies, up to `timeoutMs`. Returns the elapsed ms or null.
   *  The DESTRUCTIVE arms' verdict is read off this. */
  async waitForExit(timeoutMs) {
    const exited = await this.boot.waitUntil((b) => b.ptyExited, timeoutMs, 100);
    return exited;
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
      /* teardown is best-effort; the capture must still be written */
    }
    return out;
  }
}

/** The screen line carrying a quit hint, or null. Deliberately matched on the
 *  binary's own fragment (` again to quit`) plus the looser `quit` scan, so a
 *  reworded hint is REPORTED rather than silently read as "no arming". */
/** The production idle-composer detector's verdict on the CURRENT stream, read
 *  through the exported test seam so the probe cannot drift from the predicate
 *  the host runs. Fed the same raw tail `acceptsPromptInput()` feeds it. */
function idlePromptRead(boot) {
  try {
    const verdict = detectIdlePromptForProvider(boot.raw.slice(-20_000), "codex");
    return { ready: verdict.ready, confidence: verdict.confidence, hasModelOrCwdHint: verdict.hasModelOrCwdHint };
  } catch (error) {
    return { error: error.message };
  }
}

/**
 * What the COMPOSER holds — the last composer-glyph line in the viewport, and
 * whether it is empty.
 *
 * Written as its own reader after the first s1 run got this wrong: asking
 * `screen.includes(prompt)` matched the prompt's own echo in the TRANSCRIPT
 * (codex renders a submitted prompt as a `› …` history row) and reported the
 * composer as holding restored text while the real composer line read
 * `› Ask Codex to do anything`. The distinction is load-bearing here — an EMPTY
 * composer is the state s2 measured a single Ctrl+C to QUIT from.
 */
function composerState(screen) {
  const lines = screen.split("\n").map((line) => line.trimEnd());
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const match = /^\s*([›»>❯])\s?(.*)$/.exec(lines[i]);
    if (!match) continue;
    const text = match[2].trim();
    const placeholder = /^Ask Codex to do anything$|^Ask a follow-up question$/i.test(text);
    return { line: sanitize(lines[i].trim()), empty: text === "" || placeholder, placeholder };
  }
  return { line: null, empty: null, placeholder: null };
}

function quitHintLine(screen) {
  const lines = screen.split("\n");
  const hit = lines.find((line) => /again to quit|to quit|quit\b/i.test(line));
  return hit ? sanitize(hit.trim()) : null;
}

// ─── arms ───────────────────────────────────────────────────────────────────

/** s1 — the C17 re-pin, the grid-belt viability question, the composer-restore
 *  question, and (last, because it is destructive) the second-press question. */
async function armMidTurn() {
  const arm = new Arm("s1-midturn");
  if (!(await arm.start())) return arm.finish({ verdict: "BOOT FAILED" });
  if (!(await arm.warmUp())) return arm.finish({ verdict: "WARM-UP FAILED" });

  const before = arm.hooks.length;
  const PROMPT = "Count from 1 to 900, one number per line, nothing else.";
  const submit = await arm.submitAndConfirm(PROMPT);
  if (!submit.ok) return arm.finish({ verdict: "SUBMIT FAILED" });
  const live = await arm.waitForLiveTurn(before);
  arm.notes.push(`live turn: started=${live.started} grew=${live.grew} stoppedAlready=${live.stoppedAlready}`);
  arm.frame("before Ctrl+C (turn live)");

  // Can a GRID predicate serve as a second, independent "a turn is live" signal?
  // `acceptsPromptInput()` cannot — it returns false whenever `activeRun` is set,
  // so it is a restatement of the run pointer, not evidence beside it. The raw
  // detector is the only candidate. Sampled repeatedly across a genuinely live
  // turn, because F12 measured this exact read to be a COIN FLIP on repaint
  // order on claude; a belt that is a coin flip would refuse real interrupts.
  const liveTurnIdleReads = [];
  for (let i = 0; i < 20 && !arm.hooks.slice(before).some((h) => h.event === "Stop"); i += 1) {
    liveTurnIdleReads.push(idlePromptRead(arm.boot));
    await sleep(300);
  }

  const pressedAt = arm.boot.at();
  arm.boot.host.writeRaw(CTRL_C);
  await sleep(2500);
  arm.frame("after Ctrl+C");

  const interruptHook = arm.hooks.slice(before).find((h) => h.event === "Interrupt" && h.atMs > pressedAt) ?? null;
  const stopHook = arm.hooks.slice(before).find((h) => h.event === "Stop" && h.atMs > pressedAt) ?? null;
  const screen = arm.boot.screen();
  const interruptedBanner = /interrupted/i.test(screen);
  // The `writeUserInput` Esc branch marks `cliInputMaybeDirty` because an Esc
  // interrupt RESTORES the interrupted prompt into the CLI's composer. If Ctrl+C
  // does the same, that branch is keyed on the wrong byte for codex.
  const composerAfterInterrupt = composerState(screen);
  const postInterruptIdleRead = idlePromptRead(arm.boot);

  // LAST, and destructive if the answer is "quit": a second Ctrl+C a beat after
  // the interrupt. This is the shape of Sonata's own one-shot stop resend
  // (`noteToolActivityAfterStop`), and of a user pressing ■ twice.
  const secondAt = arm.boot.at();
  let secondPressExitedMs = null;
  if (!arm.boot.ptyExited) {
    arm.boot.host.writeRaw(CTRL_C);
    const exitAt = await arm.waitForExit(6000);
    secondPressExitedMs = exitAt === null ? null : exitAt - secondAt;
    if (!arm.boot.ptyExited) arm.frame("survived the second Ctrl+C");
  }

  return arm.finish({
    pressedAt,
    interruptHookAtMs: interruptHook ? interruptHook.atMs - pressedAt : null,
    stopHookAfterPress: Boolean(stopHook),
    interruptedBanner,
    reachedEnd: /^\s*900\s*$/m.test(arm.boot.scrollback()),
    composerAfterInterrupt,
    promptRestoredToComposer:
      composerAfterInterrupt.empty === false && composerAfterInterrupt.line?.includes(PROMPT.slice(0, 20)),
    liveTurnIdleReads,
    postInterruptIdleRead,
    secondPressExitedMs,
    secondPressQuit: arm.boot.ptyExited,
    verdict: interruptHook ? "INTERRUPTED (hook fired)" : "NO INTERRUPT HOOK",
  });
}

/**
 * s2 — one Ctrl+C at an idle EMPTY composer, and the length of whatever it arms.
 * Non-destructive by construction: exactly one press, then observation.
 */
async function armIdleEmpty() {
  const arm = new Arm("s2-idle-empty");
  if (!(await arm.start())) return arm.finish({ verdict: "BOOT FAILED" });
  if (!(await arm.warmUp())) return arm.finish({ verdict: "WARM-UP FAILED" });
  await sleep(1500);
  const beforeFrame = arm.frame("idle composer, empty, before Ctrl+C");

  const pressedAt = arm.boot.at();
  arm.boot.host.writeRaw(CTRL_C);
  await sleep(400);
  const armedFrame = arm.frame("+400ms after one Ctrl+C");

  // How long does the arming last? Poll the hint away. A hint that never clears
  // means the window is not a clock at all — which is a stronger constraint on
  // the fix, not a weaker one, so it is recorded as such rather than rounded.
  let hintGoneAtMs = null;
  if (armedFrame.quitHint) {
    for (let i = 0; i < 120 && !arm.boot.ptyExited; i += 1) {
      await sleep(500);
      if (!quitHintLine(arm.boot.screen())) {
        hintGoneAtMs = arm.boot.at() - pressedAt;
        break;
      }
    }
  }
  arm.notes.push(`quit hint cleared after ${hintGoneAtMs ?? "NEVER (60s watch)"}ms`);
  arm.frame("after hint watch");

  // Proof the session is unharmed: a real prompt still runs.
  const stillWorks = arm.boot.ptyExited ? false : await arm.warmUp("Reply with exactly: STILL_ALIVE");
  arm.frame("after the proof turn");

  return arm.finish({
    pressedAt,
    quitHintBefore: beforeFrame.quitHint,
    quitHintAfter: armedFrame.quitHint,
    hintGoneAtMs,
    exitedOnSinglePress: arm.boot.ptyExited,
    sessionStillWorks: stillWorks,
    verdict: arm.boot.ptyExited
      ? "SINGLE PRESS QUIT THE CLI"
      : armedFrame.quitHint
        ? "SINGLE PRESS ARMED A QUIT HINT"
        : "SINGLE PRESS: NO VISIBLE EFFECT",
  });
}

/** s3 — one Ctrl+C at an idle composer holding a draft. */
async function armIdleDraft() {
  const arm = new Arm("s3-idle-draft");
  if (!(await arm.start())) return arm.finish({ verdict: "BOOT FAILED" });
  if (!(await arm.warmUp())) return arm.finish({ verdict: "WARM-UP FAILED" });
  await sleep(1500);

  const DRAFT = "DRAFTKEEP";
  await arm.type(DRAFT);
  await sleep(1200);
  const withDraft = arm.frame("draft typed, before Ctrl+C");
  const draftOnScreenBefore = arm.boot.screen().includes(DRAFT);

  const pressedAt = arm.boot.at();
  arm.boot.host.writeRaw(CTRL_C);
  await sleep(1200);
  const afterFirst = arm.frame("+1.2s after Ctrl+C on a draft");
  const draftOnScreenAfter = arm.boot.screen().includes(DRAFT);

  // The compounding leg: whatever the first press left behind, press again. If
  // clearing the draft leaves an EMPTY composer, the second press meets s2's
  // state — so on codex a stop's key and its resend are not two tries at the
  // same thing, they are two DIFFERENT actions.
  let secondPressExitedMs = null;
  const secondAt = arm.boot.at();
  if (!arm.boot.ptyExited) {
    arm.boot.host.writeRaw(CTRL_C);
    const exitAt = await arm.waitForExit(6000);
    secondPressExitedMs = exitAt === null ? null : exitAt - secondAt;
    if (!arm.boot.ptyExited) arm.frame("survived the second Ctrl+C");
  }

  return arm.finish({
    draftOnScreenBefore,
    draftOnScreenAfter,
    quitHintWithDraft: withDraft.quitHint,
    quitHintAfter: afterFirst.quitHint,
    exitedOnFirstPress: afterFirst.ptyExited,
    secondPressExitedMs,
    secondPressQuit: arm.boot.ptyExited,
    pressedAt,
    verdict: afterFirst.ptyExited
      ? "QUIT with a draft on the line"
      : draftOnScreenBefore && !draftOnScreenAfter
        ? `DRAFT CLEARED; second press ${arm.boot.ptyExited ? "QUIT" : "did not quit"}`
        : "DRAFT SURVIVED",
  });
}

/**
 * s7 — the picker. Ctrl+C on it, and Esc's remaining semantics (the premise the
 * `CODEX_MODEL_MAX_ROLLBACK_ESCS` rollback choreography rests on). Two questions
 * in one spawn because the Esc leg is non-destructive and runs first.
 *
 * The picker is opened and recognised with PRODUCTION predicates
 * (`codexModelPickerLevel1Open` / `codexModelPickerFooterVisible`) using q27's
 * measured choreography — kill the line, type `/model` as ONE write, CR at
 * +150ms. The first draft of this arm typed the command character-by-character
 * and pressed CR 600ms later, which let the slash-autocomplete popup come up
 * first and EAT the CR: the arm measured a composer holding the text `/model`,
 * not a picker, and reported "Ctrl+C did not quit from the picker" about a
 * screen that had no picker on it. Recorded because the wrong version passed.
 */
async function armPicker() {
  const arm = new Arm("s7-picker");
  if (!(await arm.start())) return arm.finish({ verdict: "BOOT FAILED" });
  if (!(await arm.warmUp())) return arm.finish({ verdict: "WARM-UP FAILED" });
  await sleep(1500);

  const openPicker = async (label) => {
    arm.boot.host.writeRaw(KILL_LINE);
    await sleep(200);
    arm.boot.host.writeRaw("/model");
    await sleep(150);
    arm.boot.host.writeRaw("\r");
    const headerAt = await arm.boot.waitUntil((b) => codexModelPickerLevel1Open(b.raw), 10_000, 60);
    await arm.boot.waitUntil((b) => codexModelPickerFooterVisible(b.raw), 4000, 60);
    arm.notes.push(`${label}: level-1 header at ${headerAt ?? "TIMEOUT"}ms`);
    const frame = arm.frame(label);
    return { headerAt, frame, level1: codexModelPickerLevel1Open(arm.boot.screen()) };
  };

  // Leg 1 (non-destructive): Esc still closes a picker level.
  const escOpen = await openPicker("picker open (Esc leg)");
  if (!escOpen.level1) return arm.finish({ verdict: "PICKER DID NOT OPEN — cell UNMEASURED", escOpen });
  arm.boot.host.writeRaw(ESC);
  await sleep(900);
  const afterEsc = arm.frame("after one Esc on the picker");
  const escClosedPicker = !codexModelPickerLevel1Open(arm.boot.screen()) && !codexModelPickerFooterVisible(arm.boot.screen());

  // Leg 2 (possibly destructive): Ctrl+C on the same screen.
  await sleep(1200);
  const ctrlOpen = await openPicker("picker open (Ctrl+C leg)");
  // Read the picker's presence on BOTH channels in the same breath as the press.
  // `openPicker`'s grid read can go stale under `--no-alt-screen` (the level-1
  // header scrolls out of a tall viewport while the picker still owns input), so
  // the stream read is what the claim rests on. s2 is the control that makes this
  // arm self-validating either way: an idle EMPTY composer QUITS on one press, so
  // a Ctrl+C here that does not quit proves something owned the screen.
  const pickerAtPressStream = codexModelPickerFooterVisible(arm.boot.raw.slice(-6000));
  const pickerAtPressGrid = codexModelPickerLevel1Open(arm.boot.screen()) || codexModelPickerFooterVisible(arm.boot.screen());
  const pressedAt = arm.boot.at();
  arm.boot.host.writeRaw(CTRL_C);
  const exitAt = await arm.waitForExit(5000);
  let afterCtrl = null;
  let ctrlClosedPicker = null;
  if (!arm.boot.ptyExited) {
    await sleep(1200);
    afterCtrl = arm.frame("after Ctrl+C on the picker");
    ctrlClosedPicker =
      !codexModelPickerLevel1Open(arm.boot.screen()) && !codexModelPickerFooterVisible(arm.boot.screen());
  }

  return arm.finish({
    escLeg: { headerAt: escOpen.headerAt, level1: escOpen.level1, afterEsc, escClosedPicker },
    ctrlLeg: {
      headerAt: ctrlOpen.headerAt,
      level1: ctrlOpen.level1,
      pickerAtPressStream,
      pickerAtPressGrid,
      afterCtrl,
      ctrlClosedPicker,
      exitedMs: exitAt === null ? null : exitAt - pressedAt,
    },
    verdict: arm.boot.ptyExited
      ? "Ctrl+C QUIT from the picker"
      : `Esc closed the picker: ${escClosedPicker}; Ctrl+C closed it: ${ctrlClosedPicker}`,
  });
}

/**
 * s8 — a native approval panel owning the screen. Broker OFF so codex paints its
 * own card (the state `settleApprovalAsEscDeny` models). NETWORK is the reliable
 * escalation at this binary (C25: /tmp is INSIDE the sandbox, so a write there is
 * run unattended); it also has no filesystem effect, which matters for a command
 * this arm never approves.
 */
async function armApproval() {
  const arm = new Arm("s8-approval", { approvalBroker: false });
  if (!(await arm.start())) return arm.finish({ verdict: "BOOT FAILED" });
  if (!(await arm.warmUp())) return arm.finish({ verdict: "WARM-UP FAILED" });
  await sleep(1500);

  const before = arm.hooks.length;
  const submit = await arm.submitAndConfirm(
    "Run this exact shell command and report what happened: curl -sS -m 5 https://example.com/",
  );
  if (!submit.ok) return arm.finish({ verdict: "SUBMIT FAILED" });

  const panel = await arm.boot.waitUntil(
    (b) => /allow|approve|yes, proceed|escalated|network/i.test(b.screen()) && !b.host.acceptsPromptInput(),
    120_000,
  );
  const panelFrame = arm.frame("approval panel (or timeout)");
  arm.notes.push(`panel detected=${panel !== null} at ${panel ?? "TIMEOUT"}ms`);
  if (panel === null) return arm.finish({ verdict: "NO APPROVAL PANEL — cell UNMEASURED", panelFrame });

  const pressedAt = arm.boot.at();
  arm.boot.host.writeRaw(CTRL_C);
  const exitAt = await arm.waitForExit(5000);
  if (!arm.boot.ptyExited) {
    await sleep(2500);
    arm.frame("after Ctrl+C on the approval panel");
  }
  const interruptHook = arm.hooks.slice(before).find((h) => h.event === "Interrupt" && h.atMs > pressedAt) ?? null;
  const stopHook = arm.hooks.slice(before).find((h) => h.event === "Stop" && h.atMs > pressedAt) ?? null;

  return arm.finish({
    panelFrame,
    interruptHookAtMs: interruptHook ? interruptHook.atMs - pressedAt : null,
    stopHookAfterPress: stopHook ? stopHook.atMs - pressedAt : null,
    exitedMs: exitAt === null ? null : exitAt - pressedAt,
    hostReadyAfter: arm.boot.ptyExited ? null : arm.boot.host.acceptsPromptInput(),
    verdict: arm.boot.ptyExited
      ? "Ctrl+C QUIT from an approval panel"
      : interruptHook
        ? "Ctrl+C interrupted the turn from the approval panel"
        : "Ctrl+C did something else (see frames)",
  });
}

// ─── run ────────────────────────────────────────────────────────────────────

// Arms run in their own spawns and each writes its own capture shard, so a run
// can be split across invocations (`ARMS=s1,s2 node q31…`) without any arm's
// measurement depending on another process staying alive. The shards are merged
// into the single capture at the end of every invocation, so a partial run
// leaves a capture that says exactly which cells it holds.
const SHARD_DIR = path.join(OUT_DIR, "q31-shards");
fs.mkdirSync(SHARD_DIR, { recursive: true });
const REQUESTED = (process.env.ARMS ?? "s1,s2,s3,s7,s8")
  .split(",")
  .map((name) => name.trim())
  .filter(Boolean);

function loadShard(key) {
  try {
    return JSON.parse(fs.readFileSync(path.join(SHARD_DIR, `${key}.json`), "utf8"));
  } catch {
    return null;
  }
}
async function runArm(key, body) {
  if (!REQUESTED.includes(key)) return loadShard(key);
  const result = await body();
  fs.writeFileSync(path.join(SHARD_DIR, `${key}.json`), sanitize(JSON.stringify(result, null, 2)));
  // Append-only history beside the latest shard. Added after a re-run of s1
  // OVERWROTE the run that had produced the interesting reading (a mid-turn
  // `ready:true`): a shard that only ever holds the last run silently discards
  // exactly the variance a "is this read stable?" question is asking about.
  fs.appendFileSync(
    path.join(SHARD_DIR, `${key}.history.jsonl`),
    sanitize(
      `${JSON.stringify({
        ts: new Date().toISOString(),
        verdict: result.verdict,
        liveTurnIdleReads: result.liveTurnIdleReads ?? null,
        secondPressQuit: result.secondPressQuit ?? null,
      })}\n`,
    ),
  );
  return result;
}

function loadHistory(key) {
  try {
    return fs
      .readFileSync(path.join(SHARD_DIR, `${key}.history.jsonl`), "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  } catch {
    return [];
  }
}

const results = {};
const binaryFacts = { keymapActions: keymapActions(), quitVocabulary: quitVocabulary() };

results.s1 = await runArm("s1", armMidTurn);
results.s2 = await runArm("s2", armIdleEmpty);
results.s3 = await runArm("s3", armIdleDraft);
results.s7 = await runArm("s7", armPicker);
results.s8 = await runArm("s8", armApproval);

let endVersion = null;
let versionDrift = null;
try {
  endVersion = codexVersion();
  if (!endVersion.includes(EXPECT_CODEX_VERSION)) versionDrift = `drifted to ${endVersion}`;
} catch (error) {
  versionDrift = `version check failed: ${error.message}`;
}

const capture = {
  probe: "q31-ctrlc-state-map",
  question:
    "What does Ctrl+C mean in every state Sonata's stop button can reach at codex 0.152.1 — and is it quit-capable anywhere?",
  version,
  endVersion,
  versionDrift,
  armsRunThisInvocation: REQUESTED,
  // Every recorded run of the arms whose reading is not expected to be stable.
  s1History: loadHistory("s1"),
  binaryFacts,
  results,
};
const outPath = path.join(OUT_DIR, "q31-ctrlc-state-map.capture.txt");
fs.writeFileSync(outPath, sanitize(JSON.stringify(capture, null, 2)));
console.log(
  JSON.stringify(
    {
      success: true,
      outPath,
      versionDrift,
      verdicts: Object.fromEntries(
        Object.entries(results).map(([key, value]) => [key, value?.verdict ?? "<not run>"]),
      ),
    },
    null,
    2,
  ),
);
