// Q34 (2026-09 sync, SL-15) — WHEN does Esc interrupt a codex turn, and when
// does it not? A premise correction, forced by an unexpected control leg.
//
// WHAT HAPPENED. q33's v1 arm ran an A/B inside one live turn: first the key the
// stop used to write (Esc, expected inert per C17), then the production stop.
// The CONTROL leg interrupted — `Interrupt` hook +128ms, `■ Conversation
// interrupted`. C17 measured the opposite three times over (rounds 0–2: a human
// Esc, a raw Esc, and production `stopRun()`, each leaving the turn to finish
// with an ordinary `Stop`). Two measurements of the same binary disagree, so one
// of them is answering a different question than it thinks.
//
// THE ONE VARIABLE THAT DIFFERS, read off the two captures rather than guessed:
// HOW FAR INTO THE TURN the key landed.
//
//   h3 round 0   UserPromptSubmit@8655   Esc@13400   (+4.7s)   → Stop, reached 400
//   h3 round 1   UserPromptSubmit@42670  Esc@47407   (+4.7s)   → Stop, reached 400
//   h3 round 2   UserPromptSubmit@76681  Esc@79716   (+3.0s)   → Stop, reached 400
//   q33 v1       UserPromptSubmit@6416   Esc@8409    (+2.0s)   → Interrupt @+128ms
//
// Both probes gated on "the screen is still growing", and that gate is too weak
// to tell the two phases apart: codex's own `• Working (2s • esc to interrupt)`
// row TICKS ITS TIMER once a second, so a screen grows during the model's
// thinking phase exactly as it does mid-stream.
//
// SO THIS PROBE MEASURES THE PHASE EXPLICITLY. The turn is a count, so its output
// is unmistakable: a screen line that is a bare number means tokens are landing.
// Each arm presses ONE key at ONE named phase and records what followed.
//
//   PRE-OUTPUT   the turn has started (UserPromptSubmit) and NO bare-number line
//                has appeared yet — the model is still thinking.
//   STREAMING    at least one bare number is on screen and the count is still
//                climbing when the key is written.
//
// Both keys are run at both phases (4 cells, one spawn each so no cell inherits
// another's state), and the phase is re-verified at the instant of the press.
//
// SAFETY. Isolated CODEX_HOME under /private/tmp, credentials only, pre-trusted
// through Sonata's own ledger. The user's real `~/.codex` is never touched.
import fs from "node:fs";
import path from "node:path";
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
import { createRequire } from "node:module";

const OUT_DIR = new URL(".", import.meta.url).pathname;
const APP_DIR = new URL("../../../app/", import.meta.url).pathname;
const require = createRequire(APP_DIR + "package.json");
const { HookWatcher, codexHooksDirectory } = runtime;

const ROOT = "/private/tmp/sonata-sync-2026-09/codex-esc-phase";
const ESC = "\x1b";
const CTRL_C = "\x03";
const PROMPT = "Count from 1 to 900, one number per line, nothing else.";

assertCodexVersion("probe start");
const version = codexVersion();

/** The count's own output, and the only unambiguous "tokens are landing" signal
 *  on this screen: a line that is nothing but a number. The `Working (Ns …)`
 *  timer row and the prompt echo both fail it. */
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

class Arm {
  constructor(name) {
    this.name = name;
    this.hooks = [];
    this.notes = [];
    const runRoot = path.join(ROOT, name);
    fs.rmSync(runRoot, { recursive: true, force: true });
    this.workspace = path.join(runRoot, "ws");
    this.runtimeDir = path.join(runRoot, "runtime");
    this.binDir = path.join(runRoot, "bin");
    this.codexHome = seedCodexHome(path.join(runRoot, "codex-home"));
    for (const dir of [this.workspace, this.runtimeDir, this.binDir]) fs.mkdirSync(dir, { recursive: true });
    this.boot = new CodexBoot({
      taskId: `task-q34-${name}`,
      cwd: this.workspace,
      runtimeDir: this.runtimeDir,
      binDir: this.binDir,
      pretrustCwd: this.workspace,
      codexHome: this.codexHome,
      rows: 40,
      cols: 120,
      approvalBroker: false,
    });
    this.watcher = new HookWatcher({
      sinkDir: codexHooksDirectory,
      pollMs: 100,
      onPayload: (payload) => {
        const event = typeof payload.hook_event_name === "string" ? payload.hook_event_name : "<none>";
        this.hooks.push({ atMs: this.boot.at(), event });
        const host = this.boot.host;
        if (event === "SessionStart") host.noteHookSessionStart();
        if (event === "UserPromptSubmit") host.beginRunFromHook(String(payload.prompt ?? ""), { promptId: null });
        if (event === "Stop") host.completeRunFromTurnEnd();
        if (event === "Interrupt") host.completeRunFromTurnEnd({ ending: "interrupt" });
      },
      onError: () => {},
    });
  }

  async start() {
    await this.boot.start();
    this.watcher.watchWorkspace(this.runtimeDir);
    const ready = await this.boot.waitUntil((b) => b.ready(), 90_000);
    this.notes.push(`ready=${ready !== null} at ${ready ?? "TIMEOUT"}ms`);
    return ready !== null;
  }

  async submitAndConfirm(text) {
    if (this.boot.ptyExited) return { ok: false };
    const before = this.hooks.length;
    const submitted = () => this.hooks.slice(before).some((h) => h.event === "UserPromptSubmit");
    this.boot.host.submitPrompt(text);
    const deadline = Date.now() + 120_000;
    let retries = 0;
    while (Date.now() < deadline && !this.boot.ptyExited) {
      if (submitted()) return { ok: true, atMs: this.boot.at() };
      await sleep(1500);
      if (submitted()) return { ok: true, atMs: this.boot.at() };
      if (!this.boot.screen().includes(text.slice(0, 40))) continue;
      retries += 1;
      try {
        this.boot.host.writeRaw(retries % 2 === 1 ? "\r" : "\x1b[13u");
      } catch {
        break;
      }
    }
    return { ok: submitted(), atMs: this.boot.at() };
  }

  async warmUp() {
    const before = this.hooks.length;
    if (!(await this.submitAndConfirm("Reply with exactly: OK")).ok) return false;
    const closed = await this.boot.waitUntil(() => this.hooks.slice(before).some((h) => h.event === "Stop"), 180_000);
    this.notes.push(`warm-up closed=${closed !== null} at ${closed ?? "TIMEOUT"}ms`);
    return closed !== null;
  }

  finish(extra = {}) {
    const out = {
      arm: this.name,
      version,
      hookOrder: this.hooks.map((h) => `${h.event}@${h.atMs}`),
      notes: this.notes,
      ptyExited: this.boot.ptyExited,
      screenTail: sanitize(this.boot.screen().split("\n").slice(-10).join("\n")),
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
 * One cell of the matrix: `key` written at `phase`.
 *
 * `settleMs` after the phase is reached is deliberately SMALL for `pre-output`
 * (the phase is transient — the model starts emitting within seconds) and is the
 * only place this probe uses a clock at all. The phase itself is judged from the
 * screen, and RE-judged at the instant of the press, so a cell that drifted out
 * of its intended phase reports the phase it was actually in.
 */
async function cell(name, { key, keyLabel, phase }) {
  const arm = new Arm(name);
  if (!(await arm.start())) return arm.finish({ verdict: "BOOT FAILED" });
  if (!(await arm.warmUp())) return arm.finish({ verdict: "WARM-UP FAILED" });

  const before = arm.hooks.length;
  const submit = await arm.submitAndConfirm(PROMPT);
  if (!submit.ok) return arm.finish({ verdict: "SUBMIT FAILED" });
  const submittedAt = arm.hooks.slice(before).find((h) => h.event === "UserPromptSubmit")?.atMs ?? arm.boot.at();

  let reachedPhase = false;
  if (phase === "pre-output") {
    // Wait only long enough for the turn to be genuinely under way — codex paints
    // its `Working` row immediately — then confirm no output has landed yet.
    await sleep(1500);
    reachedPhase = countedLines(arm.boot.screen()) === 0;
  } else {
    // STREAMING: wait for output to appear AND to keep climbing, so the press
    // cannot land in the gap before the first token or after the last.
    const appeared = await arm.boot.waitUntil((b) => countedLines(b.screen()) > 0, 90_000, 100);
    if (appeared !== null) {
      const first = highestCount(arm.boot.screen());
      await sleep(1200);
      reachedPhase = highestCount(arm.boot.screen()) > first;
    }
  }

  const screenAtPress = arm.boot.screen();
  const pressedAt = arm.boot.at();
  const observedPhase = countedLines(screenAtPress) === 0 ? "pre-output" : "streaming";
  const countAtPress = highestCount(screenAtPress);
  const stoppedBeforePress = arm.hooks.slice(before).some((h) => h.event === "Stop");
  arm.boot.host.writeRaw(key);

  // Watch long enough for BOTH outcomes to be distinguishable: an interrupt lands
  // in ~130ms, while a turn that survives runs on for tens of seconds.
  const settled = await arm.boot.waitUntil(
    () => arm.hooks.slice(before).some((h) => (h.event === "Interrupt" || h.event === "Stop") && h.atMs > pressedAt),
    180_000,
    100,
  );
  const after = arm.hooks.slice(before).filter((h) => h.atMs > pressedAt);
  const interrupt = after.find((h) => h.event === "Interrupt") ?? null;
  const stop = after.find((h) => h.event === "Stop") ?? null;
  const scrollback = arm.boot.scrollback();

  return arm.finish({
    key: keyLabel,
    intendedPhase: phase,
    observedPhase,
    phaseAsIntended: reachedPhase && observedPhase === phase,
    stoppedBeforePress,
    msIntoTurn: pressedAt - submittedAt,
    countAtPress,
    settledAtMs: settled,
    interruptAfterMs: interrupt ? interrupt.atMs - pressedAt : null,
    stopAfterMs: stop ? stop.atMs - pressedAt : null,
    interruptedBanner: /Conversation interrupted/i.test(scrollback),
    reachedEnd: /^\s*900\s*$/m.test(scrollback),
    verdict: interrupt
      ? `${keyLabel} INTERRUPTED at ${observedPhase} (+${interrupt.atMs - pressedAt}ms)`
      : stop
        ? `${keyLabel} did NOT interrupt at ${observedPhase} — the turn ran to its own Stop`
        : `${keyLabel}: no turn-end hook within the watch`,
  });
}

const CELLS = {
  "esc-pre": { key: ESC, keyLabel: "Esc", phase: "pre-output" },
  "esc-stream": { key: ESC, keyLabel: "Esc", phase: "streaming" },
  "ctrlc-pre": { key: CTRL_C, keyLabel: "Ctrl+C", phase: "pre-output" },
  "ctrlc-stream": { key: CTRL_C, keyLabel: "Ctrl+C", phase: "streaming" },
};

const SHARD_DIR = path.join(OUT_DIR, "q34-shards");
fs.mkdirSync(SHARD_DIR, { recursive: true });
const REQUESTED = (process.env.ARMS ?? Object.keys(CELLS).join(",")).split(",").map((n) => n.trim());
// Each cell is repeated, because a single observation of "the turn survived"
// cannot be told apart from a swallowed key. `REPEATS` is small on purpose — the
// interesting result is a CONSISTENT split between the phases, which two runs
// per cell already make or break.
const REPEATS = Number(process.env.REPEATS ?? 2);

const results = {};
for (const [key, spec] of Object.entries(CELLS)) {
  const shard = path.join(SHARD_DIR, `${key}.json`);
  if (!REQUESTED.includes(key)) {
    try {
      results[key] = JSON.parse(fs.readFileSync(shard, "utf8"));
    } catch {
      results[key] = null;
    }
    continue;
  }
  const runs = [];
  for (let i = 0; i < REPEATS; i += 1) runs.push(await cell(`${key}-r${i + 1}`, spec));
  results[key] = { cell: key, ...spec, key: spec.keyLabel, runs };
  fs.writeFileSync(shard, sanitize(JSON.stringify(results[key], null, 2)));
}

let endVersion = null;
let versionDrift = null;
try {
  endVersion = codexVersion();
  if (!endVersion.includes(EXPECT_CODEX_VERSION)) versionDrift = `drifted to ${endVersion}`;
} catch (error) {
  versionDrift = `version check failed: ${error.message}`;
}

const outPath = path.join(OUT_DIR, "q34-esc-vs-ctrlc-phase.capture.txt");
fs.writeFileSync(
  outPath,
  sanitize(
    JSON.stringify(
      {
        probe: "q34-esc-vs-ctrlc-phase",
        question: "Does Esc interrupt a codex turn, and does the answer depend on whether output has started?",
        version,
        endVersion,
        versionDrift,
        repeats: REPEATS,
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
      matrix: Object.fromEntries(
        Object.entries(results).map(([name, value]) => [name, (value?.runs ?? []).map((run) => run.verdict)]),
      ),
    },
    null,
    2,
  ),
);
