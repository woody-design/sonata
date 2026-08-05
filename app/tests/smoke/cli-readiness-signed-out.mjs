// CLI readiness S1 — signed OUT, read from the real Claude Code CLI.
//
// The signed-out fact is the one this program cannot afford to get wrong in
// either direction: a false positive accuses a signed-in user, and a false
// negative leaves them staring at "Starting Claude…" forever (the silent hang
// this whole program replaces). No stub can settle it, because the question is
// whether we agree with the CLI — so this drives the REAL binary and gets a real
// signed-out answer out of it, by handing it a HOME with no credentials in it.
//
// MEASURED 2026-08-05 (claude 2.1.222): `HOME=<fresh dir> claude auth status
// --json` genuinely reports `{"loggedIn":false,…}` — on **exit 1**, which is
// exactly why the verdict is read from the JSON and not from the exit code. The
// command creates the CLI's own config skeleton inside that fresh HOME (nowhere
// else), and the directory is removed afterwards.
//
// Own process: HOME and PATH are mutated globally here.
//
// Skips (exit 77) when there is no `claude` on PATH, or when this machine's real
// HOME cannot produce a structured auth answer at all — in both cases there is
// no agreement left to verify.

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const distRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../../dist");

// Resolve `claude` from the INHERITED PATH only, with the login-shell merge off,
// so what the guard checks and what the probe runs are the same binary. (A
// packaged app relies on that merge; a test that let it in would be asserting
// against whichever CLI a shell profile happened to prefer.)
process.env.SONATA_DISABLE_LOGIN_SHELL_PATH = "1";

const { CLAUDE_PROBE, probeProvider } = require(path.join(distRoot, "main/cli-readiness/probe"));

// Generous per-command ceiling on purpose. What is under test is the
// CLASSIFICATION of a real signed-out answer; the 5s production bound and its
// timeout→unknown mapping are pinned in cli-readiness-stub-unknown.mjs, so
// there is nothing to gain here from letting a slow first run look like a
// classification bug.
const TIMEOUT_MS = 20_000;

if (resolveOnPath("claude") === null) {
  console.log("SKIP: no `claude` on PATH — nothing to agree with.");
  process.exit(77);
}

const results = {};

// 1) The real HOME, for the differential. If the CLI cannot give a structured
//    answer here, this machine cannot settle the question either way.
const realHome = await probeProvider(CLAUDE_PROBE, { timeoutMs: TIMEOUT_MS });
assert.equal(realHome.install, "present", "the guard found claude, so the probe must too");
if (realHome.auth === "unknown") {
  console.log(
    "SKIP: this machine's `claude auth status --json` gave no structured answer " +
      "(auth=unknown) — no signed-in/out reading to compare against.",
  );
  process.exit(77);
}
results.realHome = realHome;

// 2) A fresh HOME with no credentials in it. This is the state a new user's
//    machine is in right after installing the CLI, reproduced honestly rather
//    than faked.
const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), "sonata-cliready-home-"));
const previousHome = process.env.HOME;
process.env.HOME = fakeHome;
try {
  const freshHome = await probeProvider(CLAUDE_PROBE, { timeoutMs: TIMEOUT_MS });

  assert.equal(
    freshHome.install,
    "present",
    "an unauthenticated CLI is INSTALLED — the two axes are independent, and " +
      "collapsing them would offer an install to someone who only needs to log in",
  );
  assert.equal(
    freshHome.auth,
    "signedOut",
    `a credential-less HOME reads signedOut, not unknown (got ${JSON.stringify(freshHome)})`,
  );

  // 3) The differential — only meaningful when the real HOME is signed in. It is
  //    what proves the reading tracks the CREDENTIALS rather than something
  //    ambient about the binary or the machine.
  if (realHome.auth === "signedIn") {
    assert.notEqual(realHome.auth, freshHome.auth, "the same binary, two honest answers");
    results.differential = `${realHome.auth} → ${freshHome.auth}`;
  } else {
    results.differential = `skipped — this machine's real HOME is already ${realHome.auth}`;
  }

  // 4) The CLI wrote only inside the fresh HOME (MEASURED: `.claude.json`,
  //    `.claude/`, a lock file). Sonata itself persists nothing at all — the
  //    facts are memory-only — so everything on disk here belongs to the CLI.
  const written = fs.readdirSync(fakeHome).sort();
  assert.ok(written.length > 0, "the CLI did initialize its own config skeleton");
  results.cliWroteInFakeHome = written;
  results.freshHome = freshHome;
} finally {
  if (previousHome === undefined) {
    delete process.env.HOME;
  } else {
    process.env.HOME = previousHome;
  }
  fs.rmSync(fakeHome, { recursive: true, force: true });
}

console.log(JSON.stringify({ success: true, results }, null, 2));
process.exitCode = 0;

/** First executable match for `name` on the inherited PATH, or null. */
function resolveOnPath(name) {
  for (const dir of (process.env.PATH ?? "").split(path.delimiter)) {
    if (!dir) {
      continue;
    }
    const candidate = path.join(dir, name);
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch {
      // Not here, or not executable — keep looking.
    }
  }
  return null;
}
