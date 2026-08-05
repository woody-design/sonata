// CLI readiness S1 — the probe's classification, over MEASURED CLI output.
//
// The provenance of every fixture string below is MEASURED on this machine
// 2026-08-05 (claude 2.1.222, codex-cli 0.146.0): each was captured by running
// the command and dumping the raw bytes of both streams, including which stream
// carried the answer. Nothing here is invented, because the point of this file is
// that the classifier agrees with the CLIs as they actually behave — a COMPOSED
// fixture would only prove the classifier agrees with itself.
//
// The effect seam is injected, so this file spawns nothing. Three sibling smokes
// drive the real binaries instead, each in its own process because each needs a
// different global environment: cli-readiness-absent (empty PATH),
// cli-readiness-stub-unknown (stubs on PATH), cli-readiness-signed-out (fresh
// HOME).

import assert from "node:assert/strict";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const distRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../../dist");

const {
  CLAUDE_PROBE,
  CODEX_PROBE,
  PROBE_TIMEOUT_MS,
  probeCliReadiness,
  probeProvider,
  readClaudeAuth,
  readCodexAuth,
} = require(path.join(distRoot, "main/cli-readiness/probe"));

const results = {};

// ── MEASURED fixtures ────────────────────────────────────────────────────────

// `claude auth status --json`, signed in → exit 0, stdout, pretty-printed.
const CLAUDE_SIGNED_IN_JSON = `{
  "loggedIn": true,
  "authMethod": "claude.ai",
  "apiProvider": "firstParty",
  "email": "someone@example.com",
  "orgId": "00000000-0000-0000-0000-000000000000",
  "orgName": "someone@example.com's Organization",
  "subscriptionType": "max"
}
`;
// Same command under a fresh HOME → **exit 1**, and still a well-formed document.
const CLAUDE_SIGNED_OUT_JSON = `{
  "loggedIn": false,
  "authMethod": "none",
  "apiProvider": "firstParty"
}
`;
// An `auth` subcommand the CLI does not know → exit 1, empty stdout, stderr text.
const CLAUDE_UNKNOWN_COMMAND_STDERR = "error: unknown command 'bogus-subcommand'\n";

// `codex login status` — the phrase arrives on STDERR, stdout is empty.
const CODEX_SIGNED_IN_STDERR = "Logged in using ChatGPT\n";
const CODEX_SIGNED_OUT_STDERR = "Not logged in\n";
// …and over a malformed config.toml, exit 1 with neither phrase.
const CODEX_CONFIG_ERROR_STDERR =
  "Error loading configuration: /tmp/broken/config.toml:1:6: key with no value, expected `=`\n";

const exit = (code, stdout = "", stderr = "") => ({ kind: "exit", code, stdout, stderr });

// 1) The shared timeout ceiling (L2) matches the CLI updater's.
assert.equal(PROBE_TIMEOUT_MS, 5_000, "5s per command");

// 2) Claude's auth verdict comes from the JSON, NOT the exit code. The signed-out
//    answer arriving on exit 1 is the whole reason: reading the code would call
//    the CLI's clearest possible answer a failure.
{
  assert.equal(readClaudeAuth(exit(0, CLAUDE_SIGNED_IN_JSON)), "signedIn");
  assert.equal(
    readClaudeAuth(exit(1, CLAUDE_SIGNED_OUT_JSON)),
    "signedOut",
    "exit 1 + loggedIn:false is a CONFIDENT signed-out",
  );
  // Contrapositive: the same document on the other exit code reads the same way.
  assert.equal(readClaudeAuth(exit(0, CLAUDE_SIGNED_OUT_JSON)), "signedOut");
  assert.equal(readClaudeAuth(exit(1, CLAUDE_SIGNED_IN_JSON)), "signedIn");

  // Everything unreadable is unknown — never signedOut.
  const unreadable = [
    ["an unknown subcommand", exit(1, "", CLAUDE_UNKNOWN_COMMAND_STDERR)],
    ["empty output", exit(0, "")],
    ["not JSON", exit(0, "2.1.222 (Claude Code)\n")],
    ["JSON without the field", exit(0, '{"authMethod":"none"}')],
    ["JSON with a non-boolean field", exit(0, '{"loggedIn":"yes"}')],
    ["a JSON array", exit(0, "[]")],
    ["a JSON null", exit(0, "null")],
    ["truncated JSON", exit(0, '{"loggedIn": tr')],
  ];
  for (const [label, outcome] of unreadable) {
    assert.equal(readClaudeAuth(outcome), "unknown", `${label} → unknown`);
  }

  // The stderr fallback: today the document is on stdout, but a CLI that moved
  // its machine output to the other stream (as codex already does) still reads.
  assert.equal(readClaudeAuth(exit(1, "", CLAUDE_SIGNED_OUT_JSON)), "signedOut");
  // stdout wins when both parse, so a stale stderr copy can never override it.
  assert.equal(
    readClaudeAuth(exit(0, CLAUDE_SIGNED_IN_JSON, CLAUDE_SIGNED_OUT_JSON)),
    "signedIn",
    "stdout is the authority",
  );
  results.claudeAuth = "json-driven";
}

// 3) Codex answers in a sentence, on stderr. Only the two MEASURED phrases count.
{
  assert.equal(readCodexAuth(exit(0, "", CODEX_SIGNED_IN_STDERR)), "signedIn");
  assert.equal(readCodexAuth(exit(1, "", CODEX_SIGNED_OUT_STDERR)), "signedOut");
  // Stream-agnostic: a future codex that prints to stdout classifies identically.
  assert.equal(readCodexAuth(exit(0, CODEX_SIGNED_IN_STDERR)), "signedIn");
  assert.equal(readCodexAuth(exit(1, CODEX_SIGNED_OUT_STDERR)), "signedOut");

  assert.equal(
    readCodexAuth(exit(1, "", CODEX_CONFIG_ERROR_STDERR)),
    "unknown",
    "a config the CLI cannot load says nothing about auth",
  );
  for (const [label, outcome] of [
    ["empty output", exit(1, "")],
    ["a version line", exit(0, "codex-cli 0.146.0\n")],
    ["JSON", exit(0, '{"loggedIn":false}')],
  ]) {
    assert.equal(readCodexAuth(outcome), "unknown", `${label} → unknown`);
  }

  // The one mistake that matters: a sentence that CONTAINS "logged in" while
  // saying the opposite must not read as healthy. The match is line-anchored, so
  // an error narrating the phrase is refused rather than believed.
  assert.equal(
    readCodexAuth(exit(1, "", "Error: could not determine whether you are logged in\n")),
    "unknown",
    "a false HEALTHY is the expensive failure — anchored match refuses it",
  );
  // Negative-first within a line, and tolerant of banner noise around the answer.
  assert.equal(
    readCodexAuth(exit(1, "", "warning: config key ignored\nNot logged in\n")),
    "signedOut",
  );
  assert.equal(readCodexAuth(exit(0, "", "  Logged in using an API key\n")), "signedIn");
  results.codexAuth = "phrase-anchored";
}

// 4) The install axis: `absent` is ENOENT and nothing else. Every other failure
//    is `unknown`, and a clean exit is `present` whatever the binary printed.
{
  const spec = { ...CLAUDE_PROBE, readAuth: () => "signedIn" };
  const withVersion = async (outcome) =>
    probeProvider(spec, { run: async (_c, args) => (args[0] === "--version" ? outcome : exit(0)) });

  assert.deepEqual(await withVersion({ kind: "absent" }), {
    install: "absent",
    auth: "unknown",
  });
  assert.deepEqual(await withVersion({ kind: "failed" }), {
    install: "unknown",
    auth: "unknown",
  });
  assert.deepEqual(await withVersion(exit(1, "", "boom")), {
    install: "unknown",
    auth: "unknown",
  });
  assert.deepEqual(
    await withVersion(exit(0, "not a version at all")),
    { install: "present", auth: "signedIn" },
    "a clean --version is present; the string is never parsed",
  );
  results.install = "enoent-only-absent";
}

// 5) The auth command runs ONLY over a positively confirmed binary — and the
//    short-circuit is a correctness rule, not an optimization: `signedOut` is
//    actionable, so it may never be derived from a CLI whose version command
//    failed. It also bounds a wedged machine at one timeout per provider.
{
  for (const [label, versionOutcome] of [
    ["absent", { kind: "absent" }],
    ["timed out", { kind: "failed" }],
    ["non-zero exit", exit(3)],
  ]) {
    const calls = [];
    const fact = await probeProvider(CODEX_PROBE, {
      run: async (command, args) => {
        calls.push([command, ...args].join(" "));
        return args[0] === "--version" ? versionOutcome : exit(1, "", CODEX_SIGNED_OUT_STDERR);
      },
    });
    assert.deepEqual(calls, ["codex --version"], `${label}: the auth command is never attempted`);
    assert.equal(fact.auth, "unknown", `${label}: auth stays unknown`);
  }

  // …and when the binary IS confirmed, both commands run, in order.
  const calls = [];
  const fact = await probeProvider(CODEX_PROBE, {
    run: async (command, args) => {
      calls.push([command, ...args].join(" "));
      return args[0] === "--version"
        ? exit(0, "codex-cli 0.146.0\n")
        : exit(0, "", CODEX_SIGNED_IN_STDERR);
    },
  });
  assert.deepEqual(calls, ["codex --version", "codex login status"]);
  assert.deepEqual(fact, { install: "present", auth: "signedIn" });
  results.shortCircuit = "auth only over a confirmed binary";
}

// 6) The argv is the MEASURED structured commands — and NOTHING interactive. A
//    probe that ever launched a CLI's TUI would hang forever behind its own 5s
//    timeout, and scraping the screen is the failure mode this design exists to
//    refuse (D2).
{
  assert.deepEqual([CLAUDE_PROBE.command, ...CLAUDE_PROBE.versionArgs], ["claude", "--version"]);
  assert.deepEqual(
    [CLAUDE_PROBE.command, ...CLAUDE_PROBE.authArgs],
    ["claude", "auth", "status", "--json"],
  );
  assert.deepEqual([CODEX_PROBE.command, ...CODEX_PROBE.versionArgs], ["codex", "--version"]);
  assert.deepEqual([CODEX_PROBE.command, ...CODEX_PROBE.authArgs], ["codex", "login", "status"]);
  assert.equal(CLAUDE_PROBE.provider, "claude");
  assert.equal(CODEX_PROBE.provider, "codex");
  results.argv = "structured only";
}

// 7) Both providers, one call — independent, so one broken CLI cannot cost the
//    other its fact.
{
  const facts = await probeCliReadiness({
    run: async (command, args) => {
      if (command === "claude") {
        return args[0] === "--version" ? exit(0, "2.1.222 (Claude Code)\n") : { kind: "failed" };
      }
      return args[0] === "--version" ? { kind: "absent" } : exit(0);
    },
  });
  assert.deepEqual(facts, {
    claude: { install: "present", auth: "unknown" },
    codex: { install: "absent", auth: "unknown" },
  });
  results.pair = facts;
}

// 8) Nothing escapes as an exception — not even a seam that throws. The module's
//    contract is that a probe ALWAYS produces facts, so no caller above it needs
//    a catch block.
{
  const facts = await probeCliReadiness({
    run: async () => {
      throw new Error("hostile seam");
    },
  });
  assert.deepEqual(facts, {
    claude: { install: "unknown", auth: "unknown" },
    codex: { install: "unknown", auth: "unknown" },
  });
  results.totality = "a throwing seam degrades to unknown";
}

console.log(JSON.stringify({ success: true, results }, null, 2));
