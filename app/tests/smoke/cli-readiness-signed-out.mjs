// CLI readiness S1 — signed OUT, read from the REAL CLIs, both providers.
//
// The signed-out fact is the one this program cannot afford to get wrong in
// either direction: a false positive accuses a signed-in user, and a false
// negative leaves them staring at "Starting Claude…" forever (the silent hang
// this whole program replaces). No stub can settle it, because the question is
// whether we agree with the CLI — so this drives the REAL binaries and gets real
// signed-out answers out of them, by handing each a credential-less home.
//
// MEASURED 2026-08-05 (claude 2.1.222) and re-measured 2026-09-01 (claude
// 2.1.258, codex-cli 0.152.0 — upstream sync SL-6):
//   - `HOME=<fresh dir> claude auth status --json` reports `{"loggedIn":false,…}`
//     on **exit 1**, which is exactly why the verdict is read from the JSON and
//     not from the exit code. A fresh HOME alone is enough; CLAUDE_CONFIG_DIR
//     does not also have to be redirected. The command creates the CLI's own
//     config skeleton inside that fresh HOME (nowhere else).
//   - `CODEX_HOME=<fresh dir> codex login status` prints `Not logged in` on
//     **stderr**, also on exit 1 — a different register entirely, which is the
//     reason the two providers have separate readers rather than one "parser".
//   - `CODEX_HOME=<dir with a malformed config.toml> codex login status` prints
//     `Error loading configuration: …` and must read **unknown**. That arm is the
//     FAIL-DIRECTION test and the sharpest thing in this file: `unknown` says
//     nothing to the user, while `signedOut` sends them to a login screen to fix
//     a TOML syntax error. Anything that widens the phrase match into "contains
//     'logged in'" fails here.
//
// Each fresh home is removed afterwards; nothing outside them is written.
//
// Own process: HOME, CODEX_HOME and PATH are mutated globally here.
//
// Skips (exit 77) when NEITHER CLI is on PATH. Each provider's section skips
// itself — recording why — when its own binary is missing or when this machine's
// real home cannot produce a structured answer to compare against.

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

const { CLAUDE_PROBE, CODEX_PROBE, probeProvider } = require(
  path.join(distRoot, "main/cli-readiness/probe"),
);

// Generous per-command ceiling on purpose. What is under test is the
// CLASSIFICATION of a real signed-out answer; the 5s production bound and its
// timeout→unknown mapping are pinned in cli-readiness-stub-unknown.mjs, so
// there is nothing to gain here from letting a slow first run look like a
// classification bug.
const TIMEOUT_MS = 20_000;

if (resolveOnPath("claude") === null && resolveOnPath("codex") === null) {
  console.log("SKIP: neither `claude` nor `codex` on PATH — nothing to agree with.");
  process.exit(77);
}

const results = {};

// ── claude ───────────────────────────────────────────────────────────────────
if (resolveOnPath("claude") === null) {
  results.claude = "skipped — no `claude` on PATH";
} else {
  // 1) The real HOME, for the differential. If the CLI cannot give a structured
  //    answer here, this machine cannot settle the question either way.
  const realHome = await probeProvider(CLAUDE_PROBE, { timeoutMs: TIMEOUT_MS });
  assert.equal(realHome.install, "present", "the guard found claude, so the probe must too");
  if (realHome.auth === "unknown") {
    results.claude =
      "skipped — this machine's `claude auth status --json` gave no structured answer " +
      "(auth=unknown); no signed-in/out reading to compare against";
  } else {
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

      // 3) The differential — only meaningful when the real HOME is signed in. It
      //    is what proves the reading tracks the CREDENTIALS rather than something
      //    ambient about the binary or the machine.
      const differential =
        realHome.auth === "signedIn"
          ? `${realHome.auth} → ${freshHome.auth}`
          : `skipped — this machine's real HOME is already ${realHome.auth}`;
      if (realHome.auth === "signedIn") {
        assert.notEqual(realHome.auth, freshHome.auth, "the same binary, two honest answers");
      }

      // 4) The CLI wrote only inside the fresh HOME (MEASURED: `.claude.json`,
      //    `.claude/`, a lock file). Sonata itself persists nothing at all — the
      //    facts are memory-only — so everything on disk here belongs to the CLI.
      const written = fs.readdirSync(fakeHome).sort();
      assert.ok(written.length > 0, "the CLI did initialize its own config skeleton");
      results.claude = { realHome, freshHome, differential, cliWroteInFakeHome: written };
    } finally {
      if (previousHome === undefined) {
        delete process.env.HOME;
      } else {
        process.env.HOME = previousHome;
      }
      fs.rmSync(fakeHome, { recursive: true, force: true });
    }
  }
}

// ── codex ────────────────────────────────────────────────────────────────────
// Same question, a genuinely different answer channel: codex says it in a
// sentence, on stderr. The third arm has no claude counterpart and is the one
// that matters most — see the header's FAIL-DIRECTION note.
if (resolveOnPath("codex") === null) {
  results.codex = "skipped — no `codex` on PATH";
} else {
  const realHome = await probeProvider(CODEX_PROBE, { timeoutMs: TIMEOUT_MS });
  assert.equal(realHome.install, "present", "the guard found codex, so the probe must too");
  if (realHome.auth === "unknown") {
    results.codex =
      "skipped — this machine's `codex login status` gave no recognized phrase " +
      "(auth=unknown); no signed-in/out reading to compare against";
  } else {
    const freshCodexHome = fs.mkdtempSync(path.join(os.tmpdir(), "sonata-cliready-codex-"));
    const brokenCodexHome = fs.mkdtempSync(path.join(os.tmpdir(), "sonata-cliready-codexbad-"));
    // A key with no value on line 1 — the shape whose error message is pinned as
    // a MEASURED fixture in cli-readiness-probe.mjs.
    fs.writeFileSync(path.join(brokenCodexHome, "config.toml"), "model\n");
    const previousCodexHome = process.env.CODEX_HOME;
    try {
      process.env.CODEX_HOME = freshCodexHome;
      const freshHome = await probeProvider(CODEX_PROBE, { timeoutMs: TIMEOUT_MS });
      assert.equal(freshHome.install, "present", "an unauthenticated codex is still INSTALLED");
      assert.equal(
        freshHome.auth,
        "signedOut",
        `a credential-less CODEX_HOME reads signedOut, not unknown (got ${JSON.stringify(freshHome)})`,
      );

      process.env.CODEX_HOME = brokenCodexHome;
      const brokenConfig = await probeProvider(CODEX_PROBE, { timeoutMs: TIMEOUT_MS });
      // The install axis FIRST, and it is not ceremony: `probeProvider`
      // short-circuits to `auth: "unknown"` whenever the version command did not
      // answer cleanly. If `codex --version` ever started loading config (it
      // does not today — MEASURED exit 0 over this same broken home), the auth
      // assertion below would keep passing while testing the short-circuit
      // instead of the phrase reader. Pinning `install: "present"` is what keeps
      // the next line about what it says it is about.
      assert.equal(
        brokenConfig.install,
        "present",
        "`codex --version` does not load config, so the auth command actually ran",
      );
      assert.equal(
        brokenConfig.auth,
        "unknown",
        "a config the CLI cannot load must read unknown — never signedOut, which " +
          `would send a signed-in user to a login screen for a TOML syntax error (got ${JSON.stringify(brokenConfig)})`,
      );

      const differential =
        realHome.auth === "signedIn"
          ? `${realHome.auth} → ${freshHome.auth}`
          : `skipped — this machine's real CODEX_HOME is already ${realHome.auth}`;
      if (realHome.auth === "signedIn") {
        assert.notEqual(realHome.auth, freshHome.auth, "the same binary, two honest answers");
      }
      results.codex = { realHome, freshHome, brokenConfig, differential };
    } finally {
      if (previousCodexHome === undefined) {
        delete process.env.CODEX_HOME;
      } else {
        process.env.CODEX_HOME = previousCodexHome;
      }
      fs.rmSync(freshCodexHome, { recursive: true, force: true });
      fs.rmSync(brokenCodexHome, { recursive: true, force: true });
    }
  }
}

// Two per-provider sections mean a whole-file SKIP is wrong when only ONE of
// them cannot run — but a file that skipped BOTH and still exits 0 reports PASS
// while having verified nothing, which is the worse failure. So: in-band skip
// reasons per provider, and exit 77 only when neither section ran.
const skipped = Object.entries(results).filter(([, value]) => typeof value === "string");
if (skipped.length === Object.keys(results).length) {
  console.log(`SKIP: ${skipped.map(([provider, why]) => `${provider}: ${why}`).join("; ")}`);
  process.exit(77);
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
