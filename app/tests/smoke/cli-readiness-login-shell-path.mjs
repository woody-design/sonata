// CLI readiness S1 — probes really do resolve through the MERGED login-shell PATH.
//
// This is the #42350 class, and it is the one property the other real-subprocess
// smokes structurally cannot cover: they all either strip the parent PATH or set
// `SONATA_DISABLE_LOGIN_SHELL_PATH=1`, so they would pass identically if
// `cliCommandEnv()`'s merged PATH were quietly ignored. A Finder/Dock-launched
// `.app` inherits launchd's minimal PATH, so a probe that reads only the
// INHERITED PATH reports `absent` on machines whose sessions run that CLI every
// day — and it reports it silently, accusing the user of not having installed
// what they installed.
//
// The setup reproduces that machine exactly: a real stub CLI that lives ONLY on
// the login-shell PATH, an inherited PATH that does not contain it, and a fake
// `$SHELL` that reports the former. So the probe can only succeed by consulting
// the merge — and the A/B (same everything, merge disabled vs enabled) makes that
// the only variable.
//
// It then drives L7 end to end through the production call sequence S2 will use:
// stale cache → `reprobe()` still absent (the bug) → `reprobe({bustPathCache})`
// → present (the fix), with the fake shell's invocation count proving when the
// cache was consulted and when it was re-captured.
//
// Own process: PATH, SHELL and the login-shell escape hatch are mutated globally.
// darwin-only, because that is where `resolveLoginShellPath` is active at all.

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const distRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../../dist");

if (process.platform !== "darwin") {
  console.log("SKIP: login-shell PATH resolution is darwin-only by design.");
  process.exit(77);
}

const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "sonata-cliready-loginpath-"));
const cliBin = path.join(workspace, "cli-bin"); // the stub CLI lives HERE…
const emptyBin = path.join(workspace, "empty"); // …and the inherited PATH is THIS
const loginPathFile = path.join(workspace, "login-path"); // what the fake shell reports
const shellCallsFile = path.join(workspace, "shell-calls"); // one char per invocation
fs.mkdirSync(cliBin, { recursive: true });
fs.mkdirSync(emptyBin, { recursive: true });
fs.writeFileSync(shellCallsFile, "");

// A stub `claude` that answers both probe commands cleanly, so a successful
// resolution shows up as the strongest possible signal: present/signedIn.
// (COMPOSED body; the MEASURED real outputs are pinned in cli-readiness-probe.mjs.
// Each stub restores a system PATH for its own utilities — see the sibling
// stub-unknown smoke for why that lesson is written down.)
fs.writeFileSync(
  path.join(cliBin, "claude"),
  `#!/bin/sh
PATH=/usr/bin:/bin
export PATH
if [ "$1" = "--version" ]; then
  printf '2.1.222 (Claude Code)\\n'
  exit 0
fi
printf '{"loggedIn":true}\\n'
exit 0
`,
  { mode: 0o755 },
);

// A fake login shell: ignores the `-ilc` script it is handed, records that it ran,
// and prints whatever PATH the current phase wants inside the sentinels the real
// capture parses.
const fakeShell = path.join(workspace, "fake-login-shell");
fs.writeFileSync(
  fakeShell,
  `#!/bin/sh
PATH=/usr/bin:/bin
export PATH
printf 'x' >> '${shellCallsFile}'
printf '%s%s%s' '__SONATA_PATH_BEGIN__' "$(cat '${loginPathFile}')" '__SONATA_PATH_END__'
`,
  { mode: 0o755 },
);

process.env.PATH = emptyBin;
process.env.SHELL = fakeShell;
delete process.env.SONATA_DISABLE_LOGIN_SHELL_PATH;

const { CLAUDE_PROBE, probeProvider } = require(path.join(distRoot, "main/cli-readiness/probe"));
const { bustLoginShellPathCache, cliCommandEnv } = require(
  path.join(distRoot, "main/cli-readiness/cli-env"),
);
const { CliReadiness } = require(path.join(distRoot, "main/cli-readiness/cli-readiness"));

const results = {};
const shellCalls = () => fs.readFileSync(shellCallsFile, "utf8").length;

// Guard the guard: the CLI must be genuinely unreachable from the inherited PATH,
// or every assertion below passes for the wrong reason.
assert.equal(fs.existsSync(path.join(emptyBin, "claude")), false, "the inherited PATH has no claude");
assert.equal(fs.existsSync(path.join(cliBin, "claude")), true, "the login-shell PATH does");
assert.equal(process.env.PATH, emptyBin, "and the harness PATH is only the empty dir");

// 1) The A/B. Same stub, same inherited PATH, same fake shell — the ONLY
//    difference is whether the login-shell merge is consulted.
{
  fs.writeFileSync(loginPathFile, cliBin);

  process.env.SONATA_DISABLE_LOGIN_SHELL_PATH = "1";
  bustLoginShellPathCache();
  const withoutMerge = await probeProvider(CLAUDE_PROBE);
  assert.deepEqual(
    withoutMerge,
    { install: "absent", auth: "unknown" },
    "merge OFF → the launchd-PATH machine reports absent (the #42350 symptom)",
  );
  assert.equal(shellCalls(), 0, "…and the login shell was never even consulted");

  delete process.env.SONATA_DISABLE_LOGIN_SHELL_PATH;
  bustLoginShellPathCache();
  const withMerge = await probeProvider(CLAUDE_PROBE);
  assert.deepEqual(
    withMerge,
    { install: "present", auth: "signedIn" },
    "merge ON → the same machine resolves the CLI its own shell would",
  );
  assert.equal(shellCalls(), 1, "the login shell was captured exactly once");
  assert.equal(
    process.env.PATH,
    emptyBin,
    "and NOTHING mutated the harness PATH — the resolution came from the merge",
  );
  results.abTest = { mergeOff: withoutMerge, mergeOn: withMerge };
}

// 2) The merge DIRECTION, at the seam the probe actually hands to execFile:
//    inherited entries keep their order and authority, login entries are appended
//    to fill gaps. (Login-first would demote a harness's or direnv's deliberately
//    prepended toolchain — see login-shell-path.ts.)
{
  const env = cliCommandEnv();
  assert.equal(env.PATH, `${emptyBin}:${cliBin}`, "inherited first, login appended, deduped");
  results.mergedPath = env.PATH;
}

// 3) L7 end to end, through the production call sequence S2 will use — and with a
//    real subprocess on the other end, so this pins the mechanism rather than a
//    mock of it. The stale-cache bug is demonstrated BEFORE the fix is applied,
//    which is what makes the fix's assertion mean something.
{
  const broadcasts = [];
  const logs = [];
  const readiness = new CliReadiness({
    broadcast: (facts) => broadcasts.push(facts),
    // Real probe, real bust — no seams overridden.
    log: (message) => logs.push(message),
  });

  // Pre-install: the CLI is on neither PATH, and the launch probe caches that.
  fs.writeFileSync(loginPathFile, emptyBin);
  bustLoginShellPathCache();
  await readiness.probe("launch");
  assert.equal(readiness.read().claude.install, "absent", "pre-install: absent");
  const afterLaunch = shellCalls();

  // "The installer just ran" — it dropped the binary AND edited the shell profile,
  // which is the case L7 exists for.
  fs.writeFileSync(loginPathFile, cliBin);

  await readiness.reprobe();
  assert.equal(
    readiness.read().claude.install,
    "absent",
    "a re-probe WITHOUT the bust still reads absent — the stale-PATH bug, live",
  );
  assert.equal(shellCalls(), afterLaunch, "…because the cache answered, no shell run");
  assert.equal(broadcasts.length, 1, "and nothing changed, so nothing was pushed");

  await readiness.reprobe({ bustPathCache: true });
  assert.deepEqual(
    readiness.read().claude,
    { install: "present", auth: "signedIn" },
    "the bust re-captures the profile's new PATH and the install is seen",
  );
  assert.equal(shellCalls(), afterLaunch + 1, "exactly one re-capture");
  assert.equal(broadcasts.length, 2, "EXACTLY one further broadcast for the one change");
  assert.equal(
    logs.some((line) => line.includes("failed")),
    false,
    `no probe reported a failure (${JSON.stringify(logs)})`,
  );

  readiness.dispose();
  results.l7 = { broadcasts: broadcasts.length, shellCaptures: shellCalls(), logs };
}

fs.rmSync(workspace, { recursive: true, force: true });
console.log(JSON.stringify({ success: true, results }, null, 2));
process.exitCode = 0;
