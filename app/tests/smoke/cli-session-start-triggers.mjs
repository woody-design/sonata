// CLI readiness S4 — the two session-start triggers, on the REAL RuntimeController.
//
// The banner's copy and presence rules are fenced purely (cli-session-start-banner);
// what THIS fence covers is the half that cannot be tested purely, because it is
// made of a real pty's lifecycle and a real clock:
//
//   1. a PTY that dies before the boot latch opens is diagnosed — and the reason
//      comes from a probe run AFTER the failure, not from facts already in hand;
//   2. a diagnosis that finds a HEALTHY machine says nothing at all (the boundary:
//      no generic error UI for a failure Sonata cannot name);
//   3. an exit Sonata caused itself is never diagnosed — and costs no probe;
//   4. a PTY that is ALIVE but never reaches a prompt is diagnosed when the boot
//      observation window elapses (L5);
//   5. a session that boots normally is never diagnosed, however long it then sits;
//   6. the window belongs to its spawn: closing the session retires it, so it can
//      never fire over a dead runtime;
//   7. a session mid-TURN is never diagnosed — `acceptsPromptInput()` is false there
//      for the opposite reason, and a run in flight is proof the session started.
//
// Every one of these fails SILENTLY if it is wired wrong — a banner that simply
// never appears — so the fence drives the actual controller against real ptys
// rather than a copy of its logic. Harness shape lifted from
// cli-updater-spawn-gate.mjs.
//
// The observation window is the PRODUCTION 10s constant, deliberately not an
// injected test seam: the value is a judgement about a real CLI's boot (1–3s
// MEASURED), and a seam would leave the shipped number the one thing nothing runs.
// Four of the seven blocks therefore wait it out; the whole file lands well inside
// the runner's per-test budget.
//
// Expected stderr noise: the fake CLIs of blocks 1–3 exit instantly, so a
// `closeTask` teardown write hits a dead pty and node-pty logs its own caught
// `EIO`. An artifact of a CLI that exits in zero milliseconds, not a failure.

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "sonata-cli-session-start-"));
// Isolate every path anything in this test can write: Sonata's own data, the Codex
// profile home, and HOME — the last because a claude spawn records project trust in
// `~/.claude.json` and this fence must not touch the developer's real one.
process.env.SONATA_DATA_DIR = path.join(tempRoot, "sonata-data");
process.env.CODEX_HOME = path.join(tempRoot, "codex-home");
process.env.HOME = path.join(tempRoot, "home");
fs.mkdirSync(process.env.HOME, { recursive: true });

const binDir = path.join(tempRoot, "bin");
fs.mkdirSync(binDir, { recursive: true });
process.env.PATH = `${binDir}${path.delimiter}${process.env.PATH ?? ""}`;

const workspace = path.join(tempRoot, "workspace");
fs.mkdirSync(workspace, { recursive: true });

const { RuntimeController } = require("../../dist/main/runtime-controller");
const {
  detectIdlePromptForProvider,
} = require("../../dist/runtime/terminal-host/terminal-host");
const { INERT_CODEX_SPAWN_GATE } = require("../../dist/main/cli-updater/cli-updater");
const { ProjectsStore } = require("../../dist/main/projects-store");
const { TagsStore } = require("../../dist/main/tags-store");
const {
  ResumeSettingsStore,
  ClaudeSettingsStore,
  CodexSettingsStore,
  SonataSettingsStore,
} = require("../../dist/main/settings-store");

/** The production window (runtime-controller `CLI_BOOT_OBSERVATION_WINDOW_MS`) plus
 *  room for the diagnosis that follows it. */
const OBSERVATION_WINDOW_MS = 10_000;
const WINDOW_WAIT_MS = OBSERVATION_WINDOW_MS + 3_000;

const results = {};

/**
 * What the "ready" fixture paints: claude's own composer glyph (U+276F) followed by
 * the idle footer token `detectIdlePrompt` looks for after it (the profile's
 * `idlePromptModelHints`). Same shape as the fake CLI in
 * tests/e2e/last-used-provider.mjs. Hoisted so block 5's oracle checks the EXACT
 * bytes the pty will emit rather than a hand-copied approximation.
 */
const READY_TAIL = "Fake Claude ready\n\u276f sonnet high ~  ? for shortcuts\n";

/**
 * A fake `claude` on PATH. Three shapes, and the difference is the whole point:
 *
 *  - `"instant-exit"` — the shape of a MISSING binary as the pty sees it (execvp
 *    fails, the process is gone in milliseconds, nothing is ever painted). Verified
 *    against a real missing binary: node-pty spawns fine and reports exit 1.
 *  - `"login-screen"` — the shape of a CLI parked on its own first-run screen: it
 *    prints a welcome with NO composer prompt glyph and stays alive, so
 *    `acceptsPromptInput()` never becomes true and no prompt is ever reached.
 *  - `"ready"` — a normal boot: paints {@link READY_TAIL}, which claude's own
 *    idle-prompt detector accepts, then stays alive.
 */
function installFakeClaude(shape) {
  const body =
    shape === "instant-exit"
      ? "exit 1\n"
      : shape === "login-screen"
        ? [
            'echo "Welcome to Claude Code"',
            'echo "Choose a login method:"',
            'echo "  1. Subscription"',
            'echo "  2. API key"',
            "while :; do sleep 0.2; done",
            "",
          ].join("\n")
        : [
            // A quoted heredoc, so the glyph and the line breaks reach the pty
            // exactly as written (`printf` escape handling is not portable enough
            // to trust with either).
            "cat <<'SONATA_READY_EOF'",
            READY_TAIL.replace(/\n$/, ""),
            "SONATA_READY_EOF",
            "while :; do sleep 0.2; done",
            "",
          ].join("\n");
  const file = path.join(binDir, "claude");
  fs.writeFileSync(file, `#!/bin/sh\n${body}`, { mode: 0o755 });
  fs.chmodSync(file, 0o755);
}

/**
 * A recording stand-in for the readiness controller — the `CliReadinessSource`
 * surface only.
 *
 * `revealed` is what a re-probe LEARNS, and it is deliberately not what `read()`
 * answers until `reprobe()` has run. That encodes the contract's ordering as a
 * TEST: code that read the facts it already had would see the healthy `initial`
 * set and stay silent, so every "reason" assertion below is also proof the probe
 * ran first.
 */
function fakeReadiness({ revealed }) {
  const healthy = { install: "present", auth: "signedIn" };
  const initial = { claude: healthy, codex: healthy };
  const calls = { reprobe: 0 };
  let facts = initial;
  return {
    calls,
    reprobe() {
      calls.reprobe += 1;
      facts = revealed;
      return Promise.resolve();
    },
    read() {
      return facts;
    },
  };
}

function makeController(readiness, seq) {
  const root = path.join(tempRoot, `ctl-${seq}`);
  fs.mkdirSync(root, { recursive: true });
  const events = [];
  const controller = new RuntimeController({
    sendEvent: (event) => events.push(event),
    projectsStore: new ProjectsStore(path.join(root, "projects.json")),
    tagsStore: new TagsStore(path.join(root, "tags.json")),
    resumeSettingsStore: new ResumeSettingsStore(path.join(root, "resume.json")),
    claudeSettingsStore: new ClaudeSettingsStore(path.join(root, "claude.json")),
    codexSettingsStore: new CodexSettingsStore(path.join(root, "codex.json")),
    sonataSettingsStore: new SonataSettingsStore(path.join(root, "sonata.json")),
    cliUpdater: INERT_CODEX_SPAWN_GATE,
    cliReadiness: readiness,
  });
  return {
    controller,
    events,
    blocked: () => events.filter((e) => e.type === "cli-session-start:blocked"),
    /** The latest boot-latch reading, straight off the delivery state the controller
     *  publishes — the bit the pre-latch-exit trigger reads, observed the way the
     *  renderer observes it rather than through a test-only accessor. */
    bootLatched: () =>
      events.filter((e) => e.type === "delivery:state").at(-1)?.payload.bootLatched === true,
  };
}

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(predicate, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) {
      return;
    }
    await delay(50);
  }
  throw new Error(`Timed out waiting for ${label}.`);
}

const ABSENT_FACTS = {
  claude: { install: "absent", auth: "unknown" },
  codex: { install: "present", auth: "signedIn" },
};
const SIGNED_OUT_FACTS = {
  claude: { install: "present", auth: "signedOut" },
  codex: { install: "present", auth: "signedIn" },
};
const HEALTHY_FACTS = {
  claude: { install: "present", auth: "signedIn" },
  codex: { install: "present", auth: "signedIn" },
};

// ── 1. Pre-latch exit + a probe that finds the binary gone ───────────────────
{
  installFakeClaude("instant-exit");
  const readiness = fakeReadiness({ revealed: ABSENT_FACTS });
  const { controller, blocked } = makeController(readiness, "prelatch-absent");
  try {
    const task = await controller.createTask({ provider: "claude", cwd: workspace });
    await waitFor(() => blocked().length > 0, 10_000, "the blocked event");
    assert.equal(blocked().length, 1, "exactly one diagnosis for one failed spawn");
    assert.deepEqual(
      blocked()[0].payload,
      { taskId: task.task.id, provider: "claude", reason: "absent" },
      "the event names the task, its provider, and what the PROBE found",
    );
    assert.equal(readiness.calls.reprobe, 1, "diagnosed by re-probing, exactly once");
    results.prelatchAbsent = blocked()[0].payload;
  } finally {
    controller.dispose();
  }
}

// ── 2. Pre-latch exit, healthy machine → silence (the boundary) ──────────────
// The session still failed. Sonata still has no idea why. The design's hard line is
// that it must therefore say NOTHING — no banner, no invented error UI — and keep
// exactly today's behaviour. What it must NOT do is skip looking.
{
  installFakeClaude("instant-exit");
  const readiness = fakeReadiness({ revealed: HEALTHY_FACTS });
  const { controller, blocked } = makeController(readiness, "prelatch-healthy");
  try {
    await controller.createTask({ provider: "claude", cwd: workspace });
    await waitFor(() => readiness.calls.reprobe > 0, 10_000, "the diagnosis probe");
    await delay(500);
    assert.equal(blocked().length, 0, "a failure the probe cannot name raises nothing");
    assert.equal(readiness.calls.reprobe, 1, "but the machine WAS re-examined");
    results.prelatchHealthy = "probed, said nothing";
  } finally {
    controller.dispose();
  }
}

// ── 3. An exit Sonata caused is not a failed start ───────────────────────────
// A close, a respawn, an app quit: the CLI never got the chance to boot, and its
// health is not what ended the session. Not even a probe — this one is free.
//
// What this block proves is the user-visible property (closing a live, pre-prompt
// session raises nothing and costs nothing). It does NOT isolate the
// `sonataInitiated` check in the controller: that exit's runtime is already retired
// by the time node-pty's onExit fires, so the handler skips the branch anyway —
// verified by neutralising the condition, which leaves this block green. See the
// controller's own note; the condition is kept as the right predicate, not as a
// tested one.
{
  installFakeClaude("login-screen");
  const readiness = fakeReadiness({ revealed: ABSENT_FACTS });
  const { controller, blocked } = makeController(readiness, "sonata-initiated");
  try {
    const task = await controller.createTask({ provider: "claude", cwd: workspace });
    // Alive, pre-latch, and now closed BY Sonata — the exact state a naive
    // "pty died before the latch" rule would misread.
    controller.closeTask(task.task.id);
    await delay(1_000);
    assert.equal(blocked().length, 0, "a Sonata-initiated exit is never diagnosed");
    assert.equal(readiness.calls.reprobe, 0, "…and costs no probe at all");
    results.sonataInitiated = "not diagnosed, not probed";
  } finally {
    controller.dispose();
  }
}

// ── 4. The observation window: alive, but never a prompt (L5) ────────────────
{
  installFakeClaude("login-screen");
  const readiness = fakeReadiness({ revealed: SIGNED_OUT_FACTS });
  const { controller, blocked } = makeController(readiness, "window-signedout");
  try {
    const task = await controller.createTask({ provider: "claude", cwd: workspace });
    await delay(1_500);
    assert.equal(blocked().length, 0, "nothing is said during a normal boot's worth of time");
    assert.equal(readiness.calls.reprobe, 0, "…and nothing is probed either");

    await waitFor(() => blocked().length > 0, WINDOW_WAIT_MS, "the window's diagnosis");
    assert.deepEqual(
      blocked()[0].payload,
      { taskId: task.task.id, provider: "claude", reason: "signedOut" },
      "the window diagnoses a live-but-promptless session from the probe's reading",
    );
    assert.equal(readiness.calls.reprobe, 1, "one window, one probe");
    results.observationWindow = blocked()[0].payload;
  } finally {
    controller.dispose();
  }
}

// ── 5. A session that booted is never diagnosed ──────────────────────────────
{
  installFakeClaude("ready");
  const readiness = fakeReadiness({ revealed: SIGNED_OUT_FACTS });
  const { controller, blocked } = makeController(readiness, "window-ready");
  try {
    // Independent oracle first: a silent block 5 would otherwise prove only that
    // the fixture is unreadable. This is the very detector `acceptsPromptInput()`
    // consults, run over the exact bytes this fake CLI prints.
    assert.equal(
      detectIdlePromptForProvider(READY_TAIL, "claude").ready,
      true,
      "the ready fixture really does paint a prompt claude's own detector accepts",
    );
    await controller.createTask({ provider: "claude", cwd: workspace });
    await delay(WINDOW_WAIT_MS);
    assert.equal(blocked().length, 0, "a session that reached a prompt is never diagnosed");
    assert.equal(
      readiness.calls.reprobe,
      0,
      "…and costs no probe — which is also why a no-prompt session's window is cheap",
    );
    results.readySession = "prompt reached → window fires nothing";
  } finally {
    controller.dispose();
  }
}

// ── 6. The window belongs to its spawn ──────────────────────────────────────
// Closing the session retires the window. Without this, a timer armed by a spawn
// the user has since closed would fire over a dead runtime — and, worse, could
// diagnose a session nobody is looking at.
{
  installFakeClaude("login-screen");
  const readiness = fakeReadiness({ revealed: SIGNED_OUT_FACTS });
  const { controller, blocked } = makeController(readiness, "window-retired");
  try {
    const task = await controller.createTask({ provider: "claude", cwd: workspace });
    await delay(500);
    controller.closeTask(task.task.id);
    await delay(WINDOW_WAIT_MS);
    assert.equal(blocked().length, 0, "the closed session's window never fires");
    assert.equal(readiness.calls.reprobe, 0, "and never probes");
    results.windowRetired = "cleared with the runtime";
  } finally {
    controller.dispose();
  }
}

// ── 7. A session mid-TURN is never diagnosed (review round 1, O1) ───────────
// `acceptsPromptInput()` is false while a run owns the screen — for the opposite
// reason to a parked login — so the window would read a working session as one that
// never reached a prompt. This is not a corner: a session that boots in 1–3s and is
// still answering at the 10s mark is the ordinary case, so without this every busy
// session paid for a probe. And on a machine where the fact is true-but-wrong — a
// Claude Code running on `ANTHROPIC_API_KEY`, where `auth status` reports signed out —
// it would have accused a session that was working perfectly.
{
  installFakeClaude("ready");
  const readiness = fakeReadiness({ revealed: SIGNED_OUT_FACTS });
  const { controller, events, blocked, bootLatched } = makeController(readiness, "active-run");
  try {
    const task = await controller.createTask({ provider: "claude", cwd: workspace });
    // A real delivery is what starts a real run, and the SEND is what drives it: the
    // enqueue pumps, the pump latches once the fixture's prompt is on screen, the
    // bytes go out, and the host begins the turn. (The latch flips inside the pump,
    // so waiting for it before sending would wait forever — the same fact D-2's
    // correction turns on.) The fixture never paints a SECOND prompt, so the run
    // stays open, which is precisely the state this block is about.
    controller.submitPrompt(task.task.id, "hello");
    await waitFor(
      () => events.some((event) => event.type === "run:started"),
      10_000,
      "the run to start",
    );
    assert.equal(bootLatched(), true, "the session demonstrably reached a prompt");
    assert.equal(
      controller.taskRuntimes.get(task.task.id).terminalHost.acceptsPromptInput(),
      false,
      "…and the composer is NOT accepting input, because the run owns the screen",
    );

    await delay(WINDOW_WAIT_MS);
    assert.equal(blocked().length, 0, "a session mid-turn is never diagnosed");
    assert.equal(readiness.calls.reprobe, 0, "…and costs no probe either");
    results.activeRun = "a run in flight is proof the session started";
  } finally {
    controller.dispose();
  }
}

fs.rmSync(tempRoot, { recursive: true, force: true });
console.log(JSON.stringify({ success: true, results }, null, 2));
