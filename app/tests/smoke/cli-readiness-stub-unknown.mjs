// CLI readiness S1 — a CLI that is there but does not answer in a shape we know.
//
// This is the permissive rule's fence, and it needs a real subprocess: the
// classifier has to meet output it has never been told about, arriving through
// the same `execFile` seam production uses. Stub binaries on a controlled PATH
// give us that — a CLI that exists (so `install` is `present`) and then prints
// garbage, exits oddly, or hangs (so `auth` is `unknown`, never `signedOut`).
//
// Why it matters more than it looks: `signedOut` sends the user to a login
// screen. Deriving one from output we do not understand would accuse a
// perfectly signed-in user of being signed out every time a CLI upgrade
// reworded a line. Unknown says nothing, and the spawn path — the final truth —
// carries on.
//
// Own process: PATH is mutated globally here, so this cannot share with the
// empty-PATH sibling (cli-readiness-absent).

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const distRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../../dist");

const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "sonata-cliready-stub-"));
const stubBin = path.join(workspace, "bin");
fs.mkdirSync(stubBin, { recursive: true });

/**
 * A stub CLI. `--version` always exits 0 with a plausible line (so the install
 * axis is a confirmed `present` and the auth axis is the only thing under test);
 * anything else runs `authBody`.
 *
 * COMPOSED fixtures, and deliberately so: these are the shapes the real CLIs do
 * NOT produce. The MEASURED outputs of the real commands are pinned in
 * cli-readiness-probe.mjs; this file's job is the complement — everything else.
 */
function writeStub(name, versionLine, authBody) {
  return writeScript(
    name,
    `if [ "$1" = "--version" ]; then
  printf '%s\\n' '${versionLine}'
  exit 0
fi
${authBody}`,
  );
}

/**
 * The stubs need `sleep`/`touch`, and the harness PATH deliberately contains
 * NOTHING but the stub directory — that is what guarantees a real `claude` or
 * `codex` can never satisfy a probe here. So each stub restores a system PATH for
 * its own use: hermetic on both sides, and the resolution under test stays
 * exactly one directory wide. (Without this a stub's `sleep 30` silently becomes
 * `sh: sleep: not found` + exit 127, and a timeout test passes for the wrong
 * reason.)
 */
function writeScript(name, body) {
  const file = path.join(stubBin, name);
  fs.writeFileSync(file, `#!/bin/sh\nPATH=/usr/bin:/bin\nexport PATH\n${body}\n`, { mode: 0o755 });
  return file;
}

process.env.PATH = stubBin;
process.env.SONATA_DISABLE_LOGIN_SHELL_PATH = "1";

const { CLAUDE_PROBE, CODEX_PROBE, probeCliReadiness, probeProvider } = require(
  path.join(distRoot, "main/cli-readiness/probe"),
);
const { hasUnhealthyCliReadiness } = require(path.join(distRoot, "shared/types/cli-readiness"));

const results = {};

// 1) Claude present, auth output unparseable → present / unknown.
{
  writeStub("claude", "9.9.9 (Claude Code)", "printf 'not json at all\\n'\nexit 0");
  const fact = await probeProvider(CLAUDE_PROBE);
  assert.deepEqual(fact, { install: "present", auth: "unknown" });
  results.claudeGarbage = fact;
}

// 2) A CLI old enough not to have the subcommand — the realistic drift case. The
//    stub reproduces what MEASURED reality looks like there: exit 1 with a
//    commander-style error on stderr and nothing on stdout.
{
  writeStub(
    "claude",
    "1.0.0 (Claude Code)",
    "printf \"error: unknown command 'auth'\\n\" >&2\nexit 1",
  );
  const fact = await probeProvider(CLAUDE_PROBE);
  assert.deepEqual(
    fact,
    { install: "present", auth: "unknown" },
    "a missing subcommand is not a signed-out user",
  );
  results.claudeOldCli = fact;
}

// 3) Valid JSON, wrong field. A renamed/dropped `loggedIn` must degrade, not
//    guess: JSON.parse succeeding is not the same as understanding the answer.
{
  writeStub("claude", "3.0.0 (Claude Code)", "printf '{\"authenticated\":true}\\n'\nexit 0");
  const fact = await probeProvider(CLAUDE_PROBE);
  assert.deepEqual(fact, { install: "present", auth: "unknown" });
  results.claudeRenamedField = fact;
}

// 4) A weird exit code with no output at all.
{
  writeStub("claude", "3.0.0 (Claude Code)", "exit 42");
  const fact = await probeProvider(CLAUDE_PROBE);
  assert.deepEqual(fact, { install: "present", auth: "unknown" });
  results.claudeWeirdExit = fact;
}

// 5) Codex, an error the phrase match must refuse — including one that NARRATES
//    the phrase. A `contains "logged in"` test would read this as healthy, which
//    is the expensive direction of the mistake: a false healthy hides the real
//    problem, while a false unknown merely stays silent.
{
  writeStub(
    "codex",
    "codex-cli 9.9.9",
    "printf 'Error: could not determine whether you are logged in\\n' >&2\nexit 1",
  );
  const fact = await probeProvider(CODEX_PROBE);
  assert.deepEqual(fact, { install: "present", auth: "unknown" });
  results.codexNarratedPhrase = fact;
}

// 6) A hung auth command: bounded by the timeout (L2) and reported as unknown,
//    not as a hang. Driven at a 300ms ceiling rather than the production 5s — what
//    is under test is the timeout's CLASSIFICATION, not its length — and the
//    elapsed window asserts the bound actually fired instead of the command
//    finishing some other way.
{
  writeStub("codex", "codex-cli 9.9.9", "sleep 30");
  const started = Date.now();
  const fact = await probeProvider(CODEX_PROBE, { timeoutMs: 300 });
  const elapsed = Date.now() - started;
  assert.deepEqual(fact, { install: "present", auth: "unknown" });
  assert.ok(elapsed >= 250, `the command really hung until the bound (${elapsed}ms)`);
  assert.ok(elapsed < 5_000, `…and the bound really cut it off (${elapsed}ms)`);
  results.codexHang = { fact, elapsedMs: elapsed };
}

// 7) A version command that hangs takes the whole provider to unknown — and
//    short-circuits, so the auth command is never even attempted. One wedged CLI
//    costs one timeout, not two, and the marker file proves the skip rather than
//    inferring it.
{
  const marker = path.join(workspace, "auth-was-called");
  writeScript(
    "codex",
    `if [ "$1" = "--version" ]; then
  sleep 30
fi
touch '${marker}'
exit 0`,
  );
  const started = Date.now();
  const fact = await probeProvider(CODEX_PROBE, { timeoutMs: 300 });
  const elapsed = Date.now() - started;
  assert.deepEqual(fact, { install: "unknown", auth: "unknown" });
  assert.equal(fs.existsSync(marker), false, "the auth command was never attempted");
  assert.ok(elapsed >= 250, `the version command hung (${elapsed}ms)`);
  assert.ok(elapsed < 1_500, `ONE timeout, not two (${elapsed}ms)`);
  assert.equal(
    hasUnhealthyCliReadiness({ claude: fact, codex: fact }),
    false,
    "a wedged CLI is silent, not broken",
  );
  results.codexWedgedVersion = { fact, elapsedMs: elapsed };
}

// 8) The whole pair through the real seam: one stub healthy, one unreadable. A
//    provider we cannot read must not cost the other its fact.
{
  writeStub("claude", "9.9.9 (Claude Code)", "printf '{\"loggedIn\":true}\\n'\nexit 0");
  writeStub("codex", "codex-cli 9.9.9", "printf 'something else entirely\\n'\nexit 0");
  const facts = await probeCliReadiness();
  assert.deepEqual(facts, {
    claude: { install: "present", auth: "signedIn" },
    codex: { install: "present", auth: "unknown" },
  });
  assert.equal(hasUnhealthyCliReadiness(facts), false);
  results.pair = facts;
}

fs.rmSync(workspace, { recursive: true, force: true });
console.log(JSON.stringify({ success: true, results }, null, 2));
process.exitCode = 0;
