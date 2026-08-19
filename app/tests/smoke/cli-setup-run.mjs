// CLI readiness S2 — the setup-run controller: what actually happens when the
// card's buttons are pressed.
//
// Six things have to hold, and each of them is a way the card could lie:
//
//   A. the SHIPPED command strings are the vendors' official ones (D7) — the one
//      constant in this slice that reaches into a user's machine with a
//      privileged installer's authority, so it is pinned verbatim;
//   B. an install that WORKS clears the run, and the verdict comes from a REAL
//      re-probe with the PATH cache busted (L7) — driven here through the real
//      CliReadiness + a real subprocess, because the whole bug L7 exists for is
//      invisible to a mocked probe;
//   C. an install that FAILS lands on the failed phase — non-zero exit, and
//      (separately) exit 0 with the CLI still absent, which is the case a
//      "Success!"-printing installer produces;
//   D. a `start` run clears rather than failing, and re-probes WITHOUT a bust;
//   E. the pty is interactive and hosted: keystrokes reach it, resizes reach it,
//      and both are scoped to the live run's id so a stale message cannot land in
//      its successor;
//   F. output is buffered for replay (a CLI window opened or reopened mid-run must
//      not show a blank grid) and the buffer's seq lets a hydrating window splice
//      the live tail exactly.
//
// Runs under Electron's node (real node-pty in B/C/D/E).

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "sonata-cli-setup-run-"));
process.env.HOME = path.join(tempRoot, "home");
fs.mkdirSync(process.env.HOME, { recursive: true });
// The login-shell merge is a separate subsystem with its own fence
// (cli-readiness-login-shell-path); here it would only add a shell subprocess and
// the machine's real PATH to every case.
process.env.SONATA_DISABLE_LOGIN_SHELL_PATH = "1";

const binDir = path.join(tempRoot, "bin");
fs.mkdirSync(binDir, { recursive: true });
process.env.PATH = `${binDir}${path.delimiter}/usr/bin:/bin`;

const {
  CliSetupRunController,
  CLI_INSTALL_COMMANDS,
  CLI_LOGIN_COMMAND_ARGS,
  SETUP_RUN_OUTPUT_LIMIT_CHARS,
  spawnInputFor,
  setupRunEnv,
  hasCompletedClaudeOnboarding,
} = require("../../dist/main/cli-readiness/setup-run");
const { CliReadiness } = require("../../dist/main/cli-readiness/cli-readiness");

const results = {};

/** A controller wired to record everything main would broadcast. `authState`
 *  defaults to `signedOut` — the state every pre-gate case in this file was
 *  written for; the gate section overrides it. */
function harness({ reprobe, isAbsent, spawn, authState }) {
  const states = [];
  const chunks = [];
  const windowShows = [];
  const logs = [];
  const controller = new CliSetupRunController({
    broadcastState: (run) => states.push(run),
    broadcastData: (chunk) => chunks.push(chunk),
    showTerminalWindow: async () => {
      windowShows.push(states.length);
    },
    reprobe,
    isAbsent,
    authState: authState ?? (() => "signedOut"),
    ...(spawn ? { spawn } : {}),
    log: (message) => logs.push(message),
  });
  return { controller, states, chunks, windowShows, logs };
}

function phases(states) {
  return states.map((run) => (run === null ? "cleared" : `${run.kind}:${run.phase}`));
}

async function waitUntil(predicate, label, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) {
      return;
    }
    await delay(25);
  }
  throw new Error(`timed out waiting for ${label}`);
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ════════════════════════════════════════════════════════════════════════════
// A. The shipped install commands (D7), verbatim.
// ════════════════════════════════════════════════════════════════════════════
{
  assert.deepEqual(CLI_INSTALL_COMMANDS, {
    claude: "curl -fsSL https://claude.ai/install.sh | bash",
    codex: "curl -fsSL https://chatgpt.com/codex/install.sh | sh",
  });

  // How each kind reaches the machine. An install is a PIPELINE, so it needs a
  // shell — the user's own, because the vendors' scripts inspect `$SHELL` to pick
  // the profile they edit.
  //
  // `-c` and NOT `-lc`, and this assertion is the fence for a MEASURED trap: a
  // login shell on macOS sources /etc/profile → `path_helper`, which REPLACES PATH
  // with the system list. `-lc` therefore throws away the merged login-shell PATH
  // this module just built and re-creates the #42350 detect/run mismatch inside the
  // install itself. (Observed for real: an `-lc` install ignored a fixture's fake
  // `curl` on the merged PATH and reached the network instead.)
  const install = spawnInputFor({ kind: "install", provider: "claude" });
  assert.deepEqual(install.args, ["-c", CLI_INSTALL_COMMANDS.claude]);
  assert.ok(
    !install.args[0].includes("l"),
    "the shell must not be a LOGIN shell — path_helper would replace the merged PATH",
  );
  assert.ok(
    install.command === (process.env.SHELL || "/bin/sh"),
    `install runs through the user's own shell, got ${install.command}`,
  );
  // A `start` run spawns the BINARY, not a shell — the same resolution the session
  // spawn uses (D2), with nothing between the user's keys and the CLI's screens.
  // Since the login-run redesign (2026-08-19) the command is the provider's own
  // LOGIN command, pinned verbatim like the install strings: both are line-
  // oriented, both EXIT when the ceremony ends, so the run settles by itself.
  assert.deepEqual(CLI_LOGIN_COMMAND_ARGS, { claude: ["auth", "login"], codex: ["login"] });
  const start = spawnInputFor({ kind: "start", provider: "codex" });
  assert.equal(start.command, "codex");
  assert.deepEqual(start.args, ["login"], "codex always gets its login command");

  // The Claude exception: a machine whose first-run wizard never completed gets
  // the BARE CLI (`auth login` completes only the login; the next session would
  // park on the theme picker). The flag is `hasCompletedOnboarding` in the CLI's
  // own `.claude.json` — HOME here is this test's temp dir, so both branches are
  // drivable, and every read failure lands on the bare-CLI status quo.
  assert.equal(hasCompletedClaudeOnboarding(process.env), false, "no .claude.json yet");
  const freshClaude = spawnInputFor({ kind: "start", provider: "claude" });
  assert.deepEqual(freshClaude.args, [], "unonboarded claude gets the bare CLI (the wizard)");
  const claudeJson = path.join(process.env.HOME, ".claude.json");
  fs.writeFileSync(claudeJson, JSON.stringify({ hasCompletedOnboarding: true }), "utf8");
  const onboardedClaude = spawnInputFor({ kind: "start", provider: "claude" });
  assert.equal(onboardedClaude.command, "claude");
  assert.deepEqual(onboardedClaude.args, ["auth", "login"], "onboarded claude gets auth login");
  fs.writeFileSync(claudeJson, "{ not json", "utf8");
  assert.deepEqual(
    spawnInputFor({ kind: "start", provider: "claude" }).args,
    [],
    "an unreadable flag degrades to the bare CLI, never past the status quo",
  );
  fs.writeFileSync(claudeJson, JSON.stringify({ hasCompletedOnboarding: true }), "utf8");
  // CLAUDE_CONFIG_DIR moves the file, so the check must follow it — reading a HOME
  // the CLI is not using would answer about the wrong machine.
  const configDir = path.join(tempRoot, "claude-config");
  fs.mkdirSync(configDir, { recursive: true });
  process.env.CLAUDE_CONFIG_DIR = configDir;
  assert.deepEqual(
    spawnInputFor({ kind: "start", provider: "claude" }).args,
    [],
    "CLAUDE_CONFIG_DIR set and empty: the flag in HOME does not answer for it",
  );
  fs.writeFileSync(path.join(configDir, ".claude.json"), JSON.stringify({ hasCompletedOnboarding: true }), "utf8");
  assert.deepEqual(spawnInputFor({ kind: "start", provider: "claude" }).args, ["auth", "login"]);
  delete process.env.CLAUDE_CONFIG_DIR;
  // Home for both: setting up a CLI is not project work, and a project cwd would
  // drag the CLI's directory-trust dialog into a flow that has no directory.
  assert.equal(install.cwd, os.homedir());
  assert.equal(start.cwd, os.homedir());

  // The pty env scrub (the terminal-host treatment, same reasons): a `claude`
  // doing its FIRST RUN must not inherit the nested-session markers that suppress
  // its session side channel, and nothing must inherit Electron's node mode.
  process.env.CLAUDECODE = "1";
  process.env.CLAUDE_CODE_ENTRYPOINT = "cli";
  process.env.CLAUDE_CONFIG_DIR = "/tmp/sonata-keepme";
  process.env.ELECTRON_RUN_AS_NODE = "1";
  const env = setupRunEnv();
  assert.equal(env.CLAUDECODE, undefined);
  assert.equal(env.CLAUDE_CODE_ENTRYPOINT, undefined);
  assert.equal(env.ELECTRON_RUN_AS_NODE, undefined);
  assert.equal(env.CLAUDE_CONFIG_DIR, "/tmp/sonata-keepme", "user config passes through");
  assert.equal(env.TERM, "xterm-256color");
  delete process.env.CLAUDECODE;
  delete process.env.CLAUDE_CODE_ENTRYPOINT;
  delete process.env.ELECTRON_RUN_AS_NODE;
  delete process.env.CLAUDE_CONFIG_DIR;
  results.commands = {
    claude: CLI_INSTALL_COMMANDS.claude,
    codex: CLI_INSTALL_COMMANDS.codex,
    installArgs: install.args,
    startCommand: start.command,
    startArgs: { codex: start.args, claudeOnboarded: onboardedClaude.args, claudeFresh: [] },
    envScrub: "CLAUDECODE + CLAUDE_CODE_* + ELECTRON_RUN_AS_NODE dropped; CLAUDE_CONFIG_DIR kept",
  };
}

// ════════════════════════════════════════════════════════════════════════════
// B. An install that WORKS — with the real readiness controller on the other end.
//
// The fake "installer" writes a `claude` stub into a directory that is NOT on the
// probe's PATH until it also appends it to the shell profile the login-shell
// capture reads. That is the L7 shape in miniature: the pre-install PATH cannot
// see the new binary, so the run can only be judged correctly if the re-probe
// busts the cache first.
// ════════════════════════════════════════════════════════════════════════════
{
  const { resetLoginShellPathCache } = require("../../dist/runtime/terminal-host/login-shell-path");
  delete process.env.SONATA_DISABLE_LOGIN_SHELL_PATH;

  // The machine: a bin dir the inherited PATH does not contain, and a "shell
  // profile" the login-shell capture reads. Installing = write the binary AND
  // append its dir to the profile, which is what both real installers do — and is
  // exactly why the PATH captured at launch is stale at the moment of the verdict.
  const installedDir = path.join(tempRoot, "installed-bin");
  const profile = path.join(tempRoot, "shell-profile");
  fs.mkdirSync(installedDir, { recursive: true });
  fs.writeFileSync(profile, "", "utf8");
  process.env.SHELL = writeProfileShellStub(path.join(tempRoot, "fake-shell"), profile).shell;
  resetLoginShellPathCache();

  const captures = [];
  const readiness = new CliReadiness({ broadcast: () => {}, log: () => {} });
  await readiness.probe("launch");
  assert.equal(readiness.read().claude.install, "absent", "nothing installed yet");

  const install = () => {
    writeVersionStub(path.join(installedDir, "claude"), "claude");
    fs.writeFileSync(profile, `${installedDir}:`, "utf8");
    return 0;
  };

  const { controller, states, windowShows, logs } = harness({
    reprobe: (options) => {
      captures.push(options);
      return readiness.reprobe(options);
    },
    isAbsent: (provider) => readiness.read()[provider].install === "absent",
    spawn: fakeInstaller(install),
  });

  await controller.start({ kind: "install", provider: "claude" });
  await waitUntil(() => states.length >= 2, "the install to settle");

  assert.deepEqual(phases(states), ["install:running", "cleared"]);
  // `running` is published BEFORE the window work, so the card says "Installing…"
  // while the CLI window opens rather than after.
  assert.deepEqual(windowShows, [1], "the window is shown after the first state push");
  assert.deepEqual(captures, [{ bustPathCache: true }], "an install re-probes WITH the bust");
  assert.equal(readiness.read().claude.install, "present");
  assert.equal(controller.read().run, null);
  results.installSuccess = {
    phases: phases(states),
    reprobe: captures,
    factAfter: readiness.read().claude,
    log: logs.at(-1),
  };

  // The L7 bug itself, demonstrated rather than asserted about: the SAME
  // successful install, re-probed WITHOUT the bust, still reads absent — i.e. the
  // card would show a failure for a success. The number of shell captures is the
  // proof that the cache (not the filesystem) is what answered.
  const secondDir = path.join(tempRoot, "installed-bin-2");
  const profile2 = path.join(tempRoot, "shell-profile-2");
  fs.mkdirSync(secondDir, { recursive: true });
  fs.writeFileSync(profile2, "", "utf8");
  const stub2 = writeProfileShellStub(path.join(tempRoot, "fake-shell-2"), profile2);
  process.env.SHELL = stub2.shell;
  resetLoginShellPathCache();
  const readiness2 = new CliReadiness({ broadcast: () => {}, log: () => {} });
  await readiness2.probe("launch");
  writeVersionStub(path.join(secondDir, "codex"), "codex");
  fs.writeFileSync(profile2, `${secondDir}:`, "utf8");
  await readiness2.reprobe({ bustPathCache: false });
  const withoutBust = readiness2.read().codex.install;
  const capturesBeforeBust = stub2.captureCount();
  await readiness2.reprobe({ bustPathCache: true });
  const withBust = readiness2.read().codex.install;
  assert.equal(withoutBust, "absent", "the stale PATH cache hides a fresh install (the L7 bug)");
  assert.equal(withBust, "present", "the bust is what makes the verdict correct");
  assert.equal(capturesBeforeBust, 1, "the un-busted re-probe consulted the CACHE, not the shell");
  assert.equal(stub2.captureCount(), 2, "the bust re-captured");
  results.l7 = { withoutBust, withBust, shellCaptures: stub2.captureCount() };

  process.env.SONATA_DISABLE_LOGIN_SHELL_PATH = "1";
  resetLoginShellPathCache();
}

// ════════════════════════════════════════════════════════════════════════════
// C. The two failures. Both must reach the same card state — the user's next move
//    is the same either way, and Sonata has no more to say (it does not read the
//    installer's output).
// ════════════════════════════════════════════════════════════════════════════
{
  // C1 — a non-zero exit.
  const nonZero = harness({
    reprobe: async () => {},
    isAbsent: () => true,
    spawn: fakeInstaller(() => 1, "install.sh: could not write /usr/local/bin\r\n"),
  });
  await nonZero.controller.start({ kind: "install", provider: "claude" });
  await waitUntil(() => nonZero.states.length >= 2, "the failed install to settle");
  assert.deepEqual(phases(nonZero.states), ["install:running", "install:failed"]);
  assert.equal(nonZero.states.at(-1).provider, "claude");

  // C2 — exit 0, and the CLI is STILL absent. This is the case that makes "never
  // parse the installer's output" safe: a script that prints Success! and installs
  // nothing is caught by the probe, not by reading its claims.
  const lying = harness({
    reprobe: async () => {},
    isAbsent: () => true,
    spawn: fakeInstaller(() => 0, "Success! Claude Code installed.\r\n"),
  });
  await lying.controller.start({ kind: "install", provider: "codex" });
  await waitUntil(() => lying.states.length >= 2, "the lying install to settle");
  assert.deepEqual(phases(lying.states), ["install:running", "install:failed"]);

  // C3 — a spawn that cannot even start (no shell, node-pty failure). Same state:
  // "could not run it" and "ran and did not work" are one thing to the user.
  const brokenSpawn = harness({
    reprobe: async () => {},
    isAbsent: () => true,
    spawn: () => {
      throw new Error("spawn ENOENT");
    },
  });
  await brokenSpawn.controller.start({ kind: "install", provider: "claude" });
  await waitUntil(() => brokenSpawn.states.length >= 2, "the unspawnable install to settle");
  assert.deepEqual(phases(brokenSpawn.states), ["install:running", "install:failed"]);
  assert.ok(
    brokenSpawn.chunks.some((chunk) => chunk.data.includes("spawn ENOENT")),
    "the reason is printed into the window rather than swallowed",
  );

  // Retry after a failure starts a NEW run with a fresh id and an empty buffer —
  // a "Try again" that showed the previous attempt's log would be unreadable.
  let attempt = 0;
  const retry = harness({
    reprobe: async () => {},
    isAbsent: () => true,
    spawn: () => {
      attempt += 1;
      return fakeInstaller(() => 1, `attempt-${attempt}\r\n`)();
    },
  });
  await retry.controller.start({ kind: "install", provider: "claude" });
  await waitUntil(() => retry.states.length >= 2, "the first attempt");
  const firstId = retry.states[0].id;
  await retry.controller.start({ kind: "install", provider: "claude" });
  await waitUntil(() => retry.states.length >= 4, "the retry");
  assert.ok(retry.states[2].id > firstId, "the retry is a new run");
  const retried = retry.controller.read();
  assert.equal(
    retried.output,
    "attempt-2\r\n",
    "a Try again shows its own output, not the failed attempt's log stacked above it",
  );
  assert.equal(retried.outputSeq, 1, "and its seq restarts, so a hydrating window splices right");
  results.installFailure = {
    nonZeroExit: phases(nonZero.states),
    exitZeroStillAbsent: phases(lying.states),
    unspawnable: phases(brokenSpawn.states),
    retryIsANewRun: `#${firstId} → #${retry.states[2].id}, buffer reset`,
  };
}

// ════════════════════════════════════════════════════════════════════════════
// D. A `start` run: clears rather than failing, and re-probes WITHOUT a bust.
// ════════════════════════════════════════════════════════════════════════════
{
  const captures = [];
  // Still signed out when the CLI exits — the user closed it without finishing.
  // The run STILL clears: Sonata cannot tell that from a normal exit, so it says
  // nothing and lets the re-probed facts put the signed-out card back by
  // themselves.
  const stillOut = harness({
    reprobe: async (options) => {
      captures.push(options);
    },
    isAbsent: () => false,
    spawn: fakeInstaller(() => 0, "Welcome to Claude Code\r\n"),
  });
  await stillOut.controller.start({ kind: "start", provider: "claude" });
  await waitUntil(() => stillOut.states.length >= 2, "the start run to settle");
  assert.deepEqual(phases(stillOut.states), ["start:running", "cleared"]);
  // TWO re-probes since the login gate: one BEFORE the spawn (the signed-out
  // admission check) and one after the exit (the settle). Neither busts — nothing
  // moved on disk.
  assert.deepEqual(
    captures,
    [{ bustPathCache: false }, { bustPathCache: false }],
    "a start re-probes at the gate and at the settle, without a bust",
  );

  // Even a non-zero exit clears: there is no failure copy for a login (D8 has
  // none), and inventing one would be Sonata claiming to know why a CLI exited.
  const crashed = harness({
    reprobe: async () => {},
    isAbsent: () => false,
    spawn: fakeInstaller(() => 130),
  });
  await crashed.controller.start({ kind: "start", provider: "codex" });
  await waitUntil(() => crashed.states.length >= 2, "the interrupted start to settle");
  assert.deepEqual(phases(crashed.states), ["start:running", "cleared"]);
  results.startRun = { phases: phases(stillOut.states), reprobe: captures };
}

// ════════════════════════════════════════════════════════════════════════════
// D2. The signed-out gate (login-run redesign, 2026-08-19). A `start` run spawns
//     the CLI's own login command, and `codex login` REVOKES the existing
//     credential before its flow begins (openai/codex#27674) — so admission is a
//     safety invariant: re-probe first, then only a CONFIRMED signedOut spawns.
//     `unknown` fails CLOSED here, the one deliberate inversion of this
//     subsystem's permissive-unknown rule: everywhere else a wrong guess costs a
//     false alarm; here it can cost the user their credential.
// ════════════════════════════════════════════════════════════════════════════
{
  // signedIn → refused: no run published, nothing spawned, no window shown.
  const events = [];
  const signedIn = harness({
    reprobe: async () => {
      events.push("reprobe");
    },
    isAbsent: () => false,
    authState: () => "signedIn",
    spawn: () => {
      events.push("spawn");
      throw new Error("must not spawn");
    },
  });
  await signedIn.controller.start({ kind: "start", provider: "codex" });
  assert.deepEqual(signedIn.states, [], "a signed-in machine gets no login run");
  assert.deepEqual(events, ["reprobe"], "the gate re-probed, then refused before any spawn");
  assert.equal(signedIn.windowShows.length, 0, "and no window opens for a refusal");
  assert.ok(
    signedIn.logs.some((line) => line.includes("refused start")),
    "the refusal is logged",
  );

  // unknown → refused too (fail closed on the destructive door).
  const unknown = harness({
    reprobe: async () => {},
    isAbsent: () => false,
    authState: () => "unknown",
    spawn: () => {
      throw new Error("must not spawn");
    },
  });
  await unknown.controller.start({ kind: "start", provider: "codex" });
  assert.deepEqual(unknown.states, [], "unknown auth gets no login run either");

  // A gate re-probe that THROWS refuses as well — belt and braces on the same
  // rule. `authState` answers `signedOut` HERE on purpose (review 2026-08-19
  // minor 1): a throw must refuse on its own, because falling through to a check
  // over facts the failed refresh left STALE would admit exactly the revocation
  // the gate exists to prevent. With `unknown` this case would pass for the
  // wrong reason.
  const throwing = harness({
    reprobe: async () => {
      throw new Error("probe wedged");
    },
    isAbsent: () => false,
    authState: () => "signedOut",
    spawn: () => {
      throw new Error("must not spawn");
    },
  });
  await throwing.controller.start({ kind: "start", provider: "claude" });
  assert.deepEqual(
    throwing.states,
    [],
    "a wedged gate probe refuses on the throw itself, not on the stale facts",
  );

  // The reentrancy window the gate opened: two clicks racing through a SLOW gate
  // probe must still produce ONE run. Before the gate, publishing `running` before
  // the first await was what kept this to one; the single-flight flag restores it.
  let releaseProbe = () => {};
  const probeHeld = new Promise((resolve) => {
    releaseProbe = resolve;
  });
  let spawns = 0;
  const raced = harness({
    reprobe: () => probeHeld,
    isAbsent: () => false,
    spawn: () => {
      spawns += 1;
      return fakeInstaller(() => 0)();
    },
  });
  const first = raced.controller.start({ kind: "start", provider: "codex" });
  const second = raced.controller.start({ kind: "start", provider: "codex" });
  releaseProbe();
  await Promise.all([first, second]);
  await waitUntil(() => raced.states.length >= 2, "the raced start to settle");
  assert.equal(spawns, 1, "a double-click through the gate spawns exactly one login run");

  // An INSTALL is not gated: a machine can be signed in and still missing the
  // other CLI, and an installer destroys nothing.
  const installUngated = harness({
    reprobe: async () => {},
    isAbsent: () => false,
    authState: () => "signedIn",
    spawn: fakeInstaller(() => 0),
  });
  await installUngated.controller.start({ kind: "install", provider: "claude" });
  await waitUntil(() => installUngated.states.length >= 2, "the ungated install to settle");
  assert.deepEqual(phases(installUngated.states), ["install:running", "cleared"]);

  results.loginGate = {
    signedIn: "refused before spawn",
    unknown: "refused (fail closed)",
    wedgedProbe: "refused",
    doubleClick: `${spawns} spawn`,
    install: "not gated",
  };
}

// ════════════════════════════════════════════════════════════════════════════
// E. It is a REAL, interactive pty — the whole reason for the mechanism. A run
//    that could not be typed into could not answer a sudo prompt, an installer
//    confirm, or a login menu.
// ════════════════════════════════════════════════════════════════════════════
{
  const echoScript = path.join(tempRoot, "echo-pty.sh");
  fs.writeFileSync(
    echoScript,
    // Reads one line and echoes it back, then reports the terminal size it sees.
    '#!/bin/sh\nread answer\necho "ANSWER=$answer"\necho "SIZE=$(stty size 2>/dev/null | tr " " "x")"\n',
    { mode: 0o755 },
  );
  fs.chmodSync(echoScript, 0o755);

  const live = harness({
    reprobe: async () => {},
    isAbsent: () => false,
    spawn: (input) => realSpawn({ ...input, command: "/bin/sh", args: [echoScript] }),
  });
  await live.controller.start({ kind: "start", provider: "claude" });
  const runId = live.states[0].id;
  live.controller.resize(runId, 120, 40);
  live.controller.write(runId, "yes\r");
  // Wait for BOTH lines: the script prints ANSWER and SIZE as separate echoes, and
  // they can land as separate pty chunks — asserting on the transcript after only
  // the first is a race (hit for real when the login gate shifted the event-loop
  // timing ahead of the spawn).
  await waitUntil(
    () => live.chunks.some((chunk) => chunk.data.includes("SIZE=")),
    "the pty to echo the answer and report its size",
  );
  const transcript = live.chunks.map((chunk) => chunk.data).join("");
  assert.match(transcript, /ANSWER=yes/, "keystrokes reach the pty");
  assert.match(transcript, /SIZE=40x120/, "the window's geometry reaches the pty");

  // Scoping: a message naming a run that is not the live one is dropped rather
  // than delivered to its successor. Nothing to assert but the absence of a
  // throw and of an effect — so this drives a stale id at a live pty.
  live.controller.write(runId + 99, "rm -rf /\r");
  live.controller.resize(runId + 99, 10, 10);
  await waitUntil(() => live.states.length >= 2, "the interactive run to settle");
  assert.equal(
    live.chunks.map((chunk) => chunk.data).join("").includes("rm -rf"),
    false,
    "a keystroke for a stale run id never reaches the pty",
  );
  results.interactive = {
    answered: "ANSWER=yes",
    geometry: "SIZE=40x120",
    staleIdDropped: true,
  };
}

// ════════════════════════════════════════════════════════════════════════════
// F. The output buffer — what makes "follow along in the terminal window" true
//    for a window the run itself opened, or one reopened mid-install.
// ════════════════════════════════════════════════════════════════════════════
{
  const buffered = harness({
    reprobe: async () => {},
    isAbsent: () => true,
    spawn: fakeInstaller(() => 1, ["one\r\n", "two\r\n", "three\r\n"]),
  });
  await buffered.controller.start({ kind: "install", provider: "claude" });
  await waitUntil(() => buffered.states.length >= 2, "the buffered run to settle");
  const snapshot = buffered.controller.read();
  assert.equal(snapshot.output, "one\r\ntwo\r\nthree\r\n", "the run's output is replayable");
  assert.equal(snapshot.outputSeq, 3, "and the seq names the last chunk it contains");
  assert.deepEqual(
    buffered.chunks.map((chunk) => chunk.seq),
    [1, 2, 3],
    "live chunks are seq'd from 1, so a hydrating window can splice by seq",
  );

  // Bounded, keeping the TAIL: when an installer floods, the end is the part that
  // says what happened.
  const flooding = harness({
    reprobe: async () => {},
    isAbsent: () => true,
    spawn: fakeInstaller(() => 1, [
      "x".repeat(SETUP_RUN_OUTPUT_LIMIT_CHARS),
      "THE-END\r\n",
    ]),
  });
  await flooding.controller.start({ kind: "install", provider: "claude" });
  await waitUntil(() => flooding.states.length >= 2, "the flooding run to settle");
  const capped = flooding.controller.read();
  assert.equal(capped.output.length, SETUP_RUN_OUTPUT_LIMIT_CHARS);
  assert.ok(capped.output.endsWith("THE-END\r\n"), "the cap keeps the tail");
  results.buffer = {
    output: snapshot.output.replace(/\r\n/g, "\\n"),
    outputSeq: snapshot.outputSeq,
    cappedAt: SETUP_RUN_OUTPUT_LIMIT_CHARS,
    capKeeps: "the tail",
  };
}

// ── Single-run discipline: a second request while one is live only raises the
//    window. Two installers writing the same global prefix is a corruption
//    hazard, and the card that could issue the second request already shows
//    "Installing…" rather than a button.
{
  let release = () => {};
  const held = new Promise((resolve) => {
    release = resolve;
  });
  const busy = harness({
    reprobe: async () => {},
    isAbsent: () => true,
    spawn: () => {
      let exitListener = () => {};
      void held.then(() => exitListener({ exitCode: 0 }));
      return {
        onData: () => {},
        onExit: (listener) => {
          exitListener = listener;
        },
        write: () => {},
        resize: () => {},
      };
    },
  });
  await busy.controller.start({ kind: "install", provider: "claude" });
  assert.equal(busy.states.length, 1);
  await busy.controller.start({ kind: "install", provider: "codex" });
  assert.equal(busy.states.length, 1, "a second request starts nothing");
  assert.equal(busy.windowShows.length, 2, "but it does bring the window forward");
  release();
  await waitUntil(() => busy.states.length >= 2, "the held run to settle");
  results.singleRun = {
    states: phases(busy.states),
    windowShows: busy.windowShows.length,
  };
}

// ── dispose() stops broadcasting and calls no kill of its own. Note the LIMIT of
//    that claim (review O1): the pty is not detached, so a real quit takes the
//    installer with it anyway (MEASURED — a node-pty child dies with its parent).
//    What this pins is only that dispose adds no kill on top; the survivable case
//    it serves is macOS's close-all-windows, which does not end the process.
{
  let killed = false;
  const disposed = harness({
    reprobe: async () => {},
    isAbsent: () => true,
    spawn: () => ({
      onData: () => {},
      onExit: () => {},
      write: () => {},
      resize: () => {},
      kill: () => {
        killed = true;
      },
    }),
  });
  await disposed.controller.start({ kind: "install", provider: "claude" });
  const before = disposed.states.length;
  disposed.controller.dispose();
  await disposed.controller.start({ kind: "install", provider: "codex" });
  assert.equal(disposed.states.length, before, "a disposed controller is inert");
  assert.equal(killed, false, "dispose adds no kill of its own");
  results.dispose = "inert; adds no kill (a real quit still ends the pty — see O1)";
}

// ════════════════════════════════════════════════════════════════════════════
// G. The CLI window's visibility precedence — a SOURCE fence (review S1).
//
// "A setup run exists" and "the setup run's grid is on screen" are different
// questions, and they diverge permanently the moment a run finishes: `phase:
// "failed"` is durable by design (the failed card's copy points at that grid), so
// `setupTerminal` stays truthy for the rest of the app session. Two call sites had
// drifted to the cheaper question, which cost a live session's xterm its refit on
// every window resize and printed "Setup › Install Codex" over its grid.
//
// The bug class is a CALL SITE asking the wrong question, so the fence is
// structural: every site that decides what the window SHOWS must consult the one
// predicate. A pure-logic test would not have caught either of these.
// ════════════════════════════════════════════════════════════════════════════
{
  const source = fs.readFileSync(
    path.join(import.meta.dirname, "../../src/renderer/terminal.ts"),
    "utf8",
  );

  /** The body of a named function/handler, by brace matching from its opener. */
  const blockAfter = (opener) => {
    const start = source.indexOf(opener);
    assert.notEqual(start, -1, `expected to find ${JSON.stringify(opener)} in terminal.ts`);
    let depth = 0;
    let i = source.indexOf("{", start);
    const from = i;
    for (; i < source.length; i += 1) {
      if (source[i] === "{") depth += 1;
      else if (source[i] === "}") {
        depth -= 1;
        if (depth === 0) return source.slice(from, i + 1);
      }
    }
    throw new Error(`unbalanced braces after ${opener}`);
  };

  const sites = {
    showActiveTerminal: blockAfter("function showActiveTerminal()"),
    activeEntry: blockAfter("function activeEntry()"),
    renderBreadcrumb: blockAfter("function renderBreadcrumb()"),
    resizeListener: blockAfter('window.addEventListener("resize"'),
  };
  for (const [name, body] of Object.entries(sites)) {
    assert.ok(
      body.includes("setupRunOwnsWindow()"),
      `${name} must decide through setupRunOwnsWindow() — not through "does a setup run exist"`,
    );
  }
  // The resize arm specifically: it must not branch on bare existence, which is the
  // exact regression (a hidden grid refit while the visible one goes stale).
  assert.ok(
    !/if \(setupTerminal\)\s*\{\s*fitSetupTerminal/.test(sites.resizeListener),
    "the resize arm must not fit the setup grid on mere existence",
  );
  // And the predicate itself is the ONE place bare existence is a legitimate
  // question, so it stays the single home of the rule.
  const predicate = blockAfter("function setupRunOwnsWindow()");
  assert.ok(predicate.includes("!setupTerminal"), "the predicate owns the existence check");
  assert.ok(
    predicate.includes('setupRun?.phase === "running"') && predicate.includes("liveTaskTerminal()"),
    "the predicate is running-wins-else-yield-to-a-live-session",
  );
  results.windowPrecedence = {
    sitesGated: Object.keys(sites),
    predicate: "running wins; a finished run yields to a live session, else shows",
  };
}

fs.rmSync(tempRoot, { recursive: true, force: true });
console.log(JSON.stringify({ success: true, results }, null, 2));

// ── harness helpers ─────────────────────────────────────────────────────────

/** A fake pty: emits `output` (a string or a list of chunks), then exits with
 *  whatever `exit()` returns — called at exit time so it can have side effects
 *  (the "installer" writing a binary). */
function fakeInstaller(exit, output = "") {
  return () => {
    const chunks = Array.isArray(output) ? output : output ? [output] : [];
    let dataListener = () => {};
    let exitListener = () => {};
    setTimeout(() => {
      for (const chunk of chunks) {
        dataListener(chunk);
      }
      exitListener({ exitCode: exit() });
    }, 5);
    return {
      onData: (listener) => {
        dataListener = listener;
      },
      onExit: (listener) => {
        exitListener = listener;
      },
      write: () => {},
      resize: () => {},
    };
  };
}

/** The production spawn path, reachable for the interactive case — node-pty for
 *  real, so "it is a pty" is demonstrated rather than asserted. */
function realSpawn(input) {
  const pty = require("node-pty");
  const child = pty.spawn(input.command, [...input.args], {
    name: "xterm-256color",
    cols: input.cols,
    rows: input.rows,
    cwd: input.cwd,
    env: input.env,
  });
  return {
    onData: (listener) => child.onData(listener),
    onExit: (listener) => child.onExit(({ exitCode }) => listener({ exitCode })),
    write: (data) => child.write(data),
    resize: (cols, rows) => child.resize(cols, rows),
  };
}

/**
 * A fake `$SHELL` that answers the login-shell PATH capture from a "shell
 * profile" file — so the captured PATH CHANGES when the installer edits that
 * profile, which is the real-world shape L7 exists for. `captures` (optional) gets
 * one entry per invocation, which is how the cache can be proven to have answered
 * instead of the shell.
 *
 * The marker names are the ones `resolveLoginShellPath` parses
 * (runtime/terminal-host/login-shell-path.ts) — the same technique
 * cli-readiness-login-shell-path.mjs uses.
 */
function writeProfileShellStub(filePath, profilePath) {
  const marker = `${filePath}.captures`;
  fs.writeFileSync(marker, "", "utf8");
  fs.writeFileSync(
    filePath,
    `#!/bin/sh\n` +
      `echo x >> '${marker}'\n` +
      `extra=$(cat '${profilePath}' 2>/dev/null)\n` +
      `printf '%s%s%s' '__SONATA_PATH_BEGIN__' "\${extra}/usr/bin:/bin" '__SONATA_PATH_END__'\n`,
    { mode: 0o755 },
  );
  fs.chmodSync(filePath, 0o755);
  return {
    shell: filePath,
    captureCount: () =>
      fs
        .readFileSync(marker, "utf8")
        .split("\n")
        .filter((line) => line.length > 0).length,
  };
}

/** A stub CLI that answers the probe's two structured commands as a healthy
 *  install: MEASURED output shapes (see cli-readiness-probe.mjs), enough for the
 *  probe to read present/signedIn. */
function writeVersionStub(filePath, provider) {
  const body =
    provider === "claude"
      ? `if [ "$1" = "--version" ]; then echo '9.9.9 (Claude Code)'; exit 0; fi\n` +
        `echo '{"loggedIn":true,"authMethod":"claude.ai"}'\n`
      : `if [ "$1" = "--version" ]; then echo 'codex-cli 9.9.9'; exit 0; fi\n` +
        `echo 'Logged in using ChatGPT' >&2\n`;
  fs.writeFileSync(filePath, `#!/bin/sh\n${body}`, { mode: 0o755 });
  fs.chmodSync(filePath, 0o755);
}
