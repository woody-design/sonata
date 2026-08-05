// CLI readiness S1 — the machine with no CLI installed at all.
//
// The one fact this subsystem exists to produce is `absent`, and it is the one
// fact a fake cannot prove: ENOENT has to come from a real `execFile` against a
// real PATH, or the test only asserts that a stub returns what it was told to.
// So this drives the REAL stack — real subprocess seam, real ENOENT, real
// controller, real change broadcast — against a genuinely empty PATH
// (`cli-updater-codex-absent.mjs` is the precedent for the technique).
//
// It lives in its own process because the setup is process-GLOBAL: PATH and the
// login-shell escape hatch are mutated here, and a sibling test needing a
// different PATH (cli-readiness-stub-unknown) cannot coexist with it.

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const distRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../../dist");

const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "sonata-cliready-absent-"));

// A PATH with genuinely no `claude` and no `codex`. The login-shell merge is
// disabled too — otherwise a real ~/.zprofile would helpfully hand both CLIs
// back and this file would silently stop testing anything.
const emptyBin = path.join(workspace, "bin");
fs.mkdirSync(emptyBin, { recursive: true });
process.env.PATH = emptyBin;
process.env.SONATA_DISABLE_LOGIN_SHELL_PATH = "1";

const { probeCliReadiness } = require(path.join(distRoot, "main/cli-readiness/probe"));
const { CliReadiness } = require(path.join(distRoot, "main/cli-readiness/cli-readiness"));
const { hasUnhealthyCliReadiness } = require(path.join(distRoot, "shared/types/cli-readiness"));

const results = {};

// Guard the guard: if either CLI were somehow still resolvable, every assertion
// below would pass for the wrong reason.
for (const binary of ["claude", "codex"]) {
  assert.equal(
    fs.existsSync(path.join(emptyBin, binary)),
    false,
    `the harness PATH really has no ${binary}`,
  );
}

// 1) The real probe: both providers absent, no throw, and — the load-bearing part
//    — `absent` is NOT `unknown`. Conflating them is what would make the status
//    card impossible: there would be nothing to distinguish "we can offer an
//    install" from "we have no idea, say nothing".
{
  const started = Date.now();
  const facts = await probeCliReadiness();
  const elapsed = Date.now() - started;

  assert.deepEqual(facts, {
    claude: { install: "absent", auth: "unknown" },
    codex: { install: "absent", auth: "unknown" },
  });
  assert.equal(hasUnhealthyCliReadiness(facts), true, "an absent CLI is actionable");
  // ENOENT is immediate; nowhere near the 5s ceiling. A regression that let the
  // absent path wait out a timeout would show up here as seconds.
  assert.ok(elapsed < 2_000, `absent resolves immediately, not by timeout (${elapsed}ms)`);
  results.probe = { facts, elapsedMs: elapsed };
}

// 2) The real controller over the real probe: one broadcast for the transition out
//    of pre-probe `unknown`, then silence however many times it is asked again.
{
  const broadcasts = [];
  const logs = [];
  const readiness = new CliReadiness({
    broadcast: (facts) => broadcasts.push(facts),
    // No `probe` override and no `bustPathCache` override: both are the real thing.
    log: (message) => logs.push(message),
  });

  await readiness.probe("launch");
  assert.equal(broadcasts.length, 1, "the launch probe is a change (unknown → absent)");
  assert.deepEqual(broadcasts[0], {
    claude: { install: "absent", auth: "unknown" },
    codex: { install: "absent", auth: "unknown" },
  });

  // Focus DOES re-probe here (something is actionable) — and still says nothing,
  // because nothing changed. Repeated focus on a broken machine must not turn
  // into a repaint loop.
  for (let i = 0; i < 3; i += 1) {
    readiness.noteMainWindowFocus();
    await new Promise((resolve) => setImmediate(() => setImmediate(resolve)));
  }
  assert.equal(broadcasts.length, 1, "no further broadcast without a change");

  // The L7 path, end to end against the real cache-bust: still absent (nothing
  // was installed), and no exception from re-capturing a PATH that resolves to
  // nothing on a disabled login shell.
  await readiness.reprobe({ bustPathCache: true });
  assert.equal(broadcasts.length, 1);
  assert.deepEqual(readiness.read(), {
    claude: { install: "absent", auth: "unknown" },
    codex: { install: "absent", auth: "unknown" },
  });

  assert.equal(
    logs.some((line) => line.includes("failed")),
    false,
    `no probe reported a failure (${JSON.stringify(logs)})`,
  );
  readiness.dispose();
  results.controller = { broadcasts: broadcasts.length, logs };
}

// 3) Nothing was written anywhere. The facts are memory-only by design — no
//    store, no cache file, no logs directory — so a machine without either CLI
//    should end this test with exactly the empty bin directory it started with.
{
  assert.deepEqual(fs.readdirSync(workspace), ["bin"], "no files created beside the fake bin");
  assert.deepEqual(fs.readdirSync(emptyBin), [], "and none inside it");
  results.sideEffects = "none";
}

fs.rmSync(workspace, { recursive: true, force: true });
console.log(JSON.stringify({ success: true, results }, null, 2));
process.exitCode = 0;
