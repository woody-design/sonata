// The shared e2e fake-CLI helper, fenced against the product's OWN readers.
//
// `tests/e2e/helpers/fake-cli.mjs` makes two promises, and a string comparison
// would prove neither of them — it would only prove the helper agrees with this
// file. So both are checked through the code that actually consumes the fake:
//
//   1. **It answers the readiness probe and EXITS.** Driven by the real
//      `probeProvider` over a real subprocess: `present`/`signedIn` is reachable
//      only if both commands ran and exited in a shape the product's own readers
//      recognize. Plus a direct timing fence on `--version`, because the failure
//      this helper exists to remove is not a wrong fact — it is a process that
//      never dies (see the helper's header for the MEASURED before-state).
//   2. **Its ready output opens the boot latch.** Driven by
//      `detectIdlePromptForProvider`, the very detector `acceptsPromptInput()`
//      consults. A fake whose prompt the detector rejects would leave every
//      session it hosts stuck before its first prompt.
//
// Then the observation artifacts, one assertion per `records` name, because each
// name is a file some e2e reads by that name.
//
// Own process, plain `require` of dist: needs Electron's node for terminal-host's
// native neighbours (the `smoke:*` script pins that).

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import {
  FAKE_CLI_READY_OUTPUT,
  FAKE_CLI_VERSIONS,
  fakeCliSource,
  installFakeCli,
} from "../e2e/helpers/fake-cli.mjs";

const require = createRequire(import.meta.url);
const distRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../../dist");
const { CLAUDE_PROBE, CODEX_PROBE, probeProvider } = require(
  path.join(distRoot, "main/cli-readiness/probe"),
);
const { detectIdlePromptForProvider } = require(
  path.join(distRoot, "runtime/terminal-host/terminal-host"),
);

/** Well inside the probe's own 5s budget: a fake that has not exited by here is
 *  the immortal process this helper exists to make impossible. */
const EXIT_BUDGET_MS = 2_000;

const root = fs.mkdtempSync(path.join(os.tmpdir(), "sonata-fake-cli-smoke-"));
const binDir = path.join(root, "bin");
const originalPath = process.env.PATH;
const results = {};

try {
  // The probe merges the login-shell PATH but keeps the INHERITED PATH's order and
  // authority, so prepending the fake bin dir is what decides resolution. The rest
  // of the inherited PATH stays: the fake is `#!/usr/bin/env node`, so `node` has
  // to remain findable.
  process.env.SONATA_DISABLE_LOGIN_SHELL_PATH = "1";
  process.env.PATH = `${binDir}:${originalPath}`;

  // ── 1. The probe answers, in the product's own reading ─────────────────────
  const probed = {};
  for (const [provider, spec] of [
    ["claude", CLAUDE_PROBE],
    ["codex", CODEX_PROBE],
  ]) {
    installFakeCli(binDir, provider);
    const facts = await probeProvider(spec);
    assert.deepEqual(
      facts,
      { install: "present", auth: "signedIn" },
      `${provider}: the fake answers both probe commands as an installed, signed-in CLI`,
    );
    probed[provider] = facts;
  }
  results.probe = probed;

  // ── 2. …and it EXITS. The leak fence. ─────────────────────────────────────
  const exits = {};
  for (const provider of ["claude", "codex"]) {
    const outcome = await runFake(path.join(binDir, provider), ["--version"]);
    assert.equal(
      outcome.hung,
      false,
      `${provider} --version must exit, not become an immortal process`,
    );
    assert.equal(outcome.code, 0, `${provider} --version exits clean`);
    assert.equal(
      outcome.stdout.trim(),
      FAKE_CLI_VERSIONS[provider],
      `${provider} --version prints the MEASURED version line`,
    );
    exits[provider] = `exit ${outcome.code} in ${outcome.elapsedMs}ms`;
  }
  results.exits = exits;

  // ── 3. The ready output really is an idle prompt ───────────────────────────
  const latch = {};
  for (const provider of ["claude", "codex"]) {
    assert.equal(
      detectIdlePromptForProvider(FAKE_CLI_READY_OUTPUT[provider], provider).ready,
      true,
      `${provider}: the default ready output is a prompt the product's own detector accepts`,
    );
    latch[provider] = "boot latch opens";
  }
  // The one variant that trims the footer to nothing (session-title-lifecycle) must
  // still latch, or that test's sessions would never reach a prompt.
  assert.equal(
    detectIdlePromptForProvider("Fake Claude ready\n❯ \n", "claude").ready,
    true,
    "the bare-prompt variant latches too",
  );
  latch.bareVariant = "boot latch opens";
  results.bootLatch = latch;

  // ── 4. Every observation artifact, by the name its readers use ─────────────
  const runtimeDir = path.join(root, "runtime");
  installFakeCli(binDir, "claude", {
    records: ["spawned", "spawn-record", "spawn-count", "spawn-argv", "stdin"],
    echoStdin: true,
  });
  const session = await runFake(
    path.join(binDir, "claude"),
    ["--settings", path.join(runtimeDir, "claude-runtime-settings.json"), "--flag"],
    { stdinBytes: "hello pty", killAfterMs: 700, env: { SONATA_RUNTIME_DIR: runtimeDir } },
  );
  assert.equal(session.hung, true, "the session stays alive until something kills it");
  assert.match(session.stdout, /Fake Claude ready/, "…having painted its banner");
  assert.match(session.stdout, /hello pty/, "…and echoed what was written to it (echoStdin)");
  assert.equal(read(runtimeDir, "spawned"), "1", "spawned marker");
  assert.deepEqual(
    JSON.parse(read(runtimeDir, "spawn-record.json")),
    {
      provider: "claude",
      argv: ["--settings", path.join(runtimeDir, "claude-runtime-settings.json"), "--flag"],
      sonataRuntimeDir: runtimeDir,
    },
    "spawn-record.json carries provider + argv + the runtime-dir binding",
  );
  assert.equal(read(runtimeDir, "spawn-count"), "1", "spawn-count");
  assert.deepEqual(
    JSON.parse(read(runtimeDir, "spawn-1.json")).argv,
    ["--settings", path.join(runtimeDir, "claude-runtime-settings.json"), "--flag"],
    "spawn-<n>.json is keyed by the spawn number",
  );
  assert.equal(read(runtimeDir, "stdin.bin"), "hello pty", "stdin.bin");
  results.records = "spawned, spawn-record, spawn-count, spawn-argv, stdin — all written";

  // A second spawn advances the counter (what the resume fences read it for).
  const second = await runFake(path.join(binDir, "claude"), [], {
    killAfterMs: 500,
    env: { SONATA_RUNTIME_DIR: runtimeDir },
  });
  assert.equal(second.hung, true, "the second session also stays alive");
  assert.equal(read(runtimeDir, "spawn-count"), "2", "spawn-count advances per spawn");
  assert.deepEqual(JSON.parse(read(runtimeDir, "spawn-2.json")).argv, [], "…and so does spawn-<n>");
  results.repeatSpawn = "count advances, per-spawn argv written";

  // ── 5. The probe arms come FIRST — a probe never leaves a session artifact ──
  const probeOnlyDir = path.join(root, "probe-only");
  const probeOnly = await runFake(path.join(binDir, "claude"), ["--version"], {
    env: { SONATA_RUNTIME_DIR: probeOnlyDir },
  });
  assert.equal(probeOnly.hung, false, "the probe arm still exits with a runtime dir bound");
  assert.equal(
    fs.existsSync(probeOnlyDir),
    false,
    "a probe invocation records nothing: the arms run before the session body",
  );
  results.probeArmsFirst = "a --version call writes no runtime dir";

  // ── 6. An unknown record name is a typo, not silence ───────────────────────
  assert.throws(
    () => fakeCliSource("claude", { records: ["spwaned"] }),
    /unknown fake-cli record: spwaned/,
    "a misspelled record fails loudly instead of writing nothing",
  );
  results.unknownRecord = "rejected";

  console.log(JSON.stringify({ success: true, results }, null, 2));
} finally {
  process.env.PATH = originalPath;
  fs.rmSync(root, { recursive: true, force: true });
}

function read(dir, name) {
  return fs.readFileSync(path.join(dir, name), "utf8");
}

/**
 * Run the fake and report how it ended. `killAfterMs` is how a SESSION is
 * observed (it is contracted to stay alive, so `hung: true` is the pass there);
 * without it the budget is {@link EXIT_BUDGET_MS} and `hung: true` is a failure.
 */
function runFake(binary, args, { stdinBytes = null, killAfterMs = null, env = {} } = {}) {
  return new Promise((resolve) => {
    const startedAt = Date.now();
    const child = spawn(binary, args, { env: { ...process.env, ...env } });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    if (stdinBytes !== null) {
      child.stdin.write(stdinBytes);
    }
    let killed = false;
    const timer = setTimeout(() => {
      killed = true;
      child.kill("SIGKILL");
    }, killAfterMs ?? EXIT_BUDGET_MS);
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ hung: killed, code, stdout, stderr, elapsedMs: Date.now() - startedAt });
    });
  });
}
