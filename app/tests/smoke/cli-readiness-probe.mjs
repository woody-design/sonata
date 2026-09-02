// CLI readiness S1 — the probe's classification, over MEASURED CLI output.
//
// The provenance of every fixture string below is MEASURED on this machine —
// originally 2026-08-05 (claude 2.1.222, codex-cli 0.146.0) and RE-PINNED
// 2026-09-01 at claude **2.1.258** / codex-cli **0.152.0** (upstream sync SL-6,
// capture `spikes/upstream-sync-2026-09/codex/q24-cli-readiness.capture.txt`).
// Each was captured by running the command and dumping the raw bytes of both
// streams, including which stream carried the answer. Nothing here is invented,
// because the point of this file is that the classifier agrees with the CLIs as
// they actually behave — a COMPOSED fixture would only prove the classifier
// agrees with itself.
//
// Where a case could NOT be measured on this machine (the six codex auth modes
// this account does not use), the fixture says so in its own comment and is
// labelled SOURCE-DERIVED rather than promoted to MEASURED.
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
  readClaudeProjectsDirectory,
  readCodexAuth,
} = require(path.join(distRoot, "main/cli-readiness/probe"));

const results = {};

// ── MEASURED fixtures ────────────────────────────────────────────────────────

// `claude auth status --json`, signed in → exit 0, stdout, pretty-printed.
// MEASURED at 2.1.258; account identity replaced with placeholders, field ORDER
// and field SET verbatim. `analyticsDisabled` and `projectsDirectory` are new
// since the 2.1.222 pin — kept in the fixture precisely because the classifier
// must go on ignoring everything but `loggedIn`.
const CLAUDE_SIGNED_IN_JSON = `{
  "loggedIn": true,
  "authMethod": "claude.ai",
  "apiProvider": "firstParty",
  "analyticsDisabled": false,
  "projectsDirectory": "/home/someone/.claude/projects",
  "email": "someone@example.com",
  "orgId": "00000000-0000-0000-0000-000000000000",
  "orgName": "someone@example.com's Organization",
  "subscriptionType": "max"
}
`;
// Same command under a fresh HOME → **exit 1**, and still a well-formed
// document. MEASURED at 2.1.258; a fresh HOME alone is enough, with or without
// CLAUDE_CONFIG_DIR redirected alongside it.
const CLAUDE_SIGNED_OUT_JSON = `{
  "loggedIn": false,
  "authMethod": "none",
  "apiProvider": "firstParty",
  "analyticsDisabled": false,
  "projectsDirectory": "/tmp/fresh-home/.claude/projects"
}
`;
// The 2.1.222 shape, kept as a second MEASURED fixture rather than replaced: the
// classifier's whole claim is that it reads `loggedIn` and nothing else, and an
// old document still parsing is what makes that claim testable across versions.
const CLAUDE_SIGNED_OUT_JSON_2_1_222 = `{
  "loggedIn": false,
  "authMethod": "none",
  "apiProvider": "firstParty"
}
`;
// An `auth` subcommand the CLI does not know → exit 1, empty stdout, stderr text.
const CLAUDE_UNKNOWN_COMMAND_STDERR = "error: unknown command 'bogus-subcommand'\n";

// `codex login status` — the phrase arrives on STDERR, stdout is empty.
// MEASURED at 0.152.0, unchanged from 0.146.0.
const CODEX_SIGNED_IN_STDERR = "Logged in using ChatGPT\n";
const CODEX_SIGNED_OUT_STDERR = "Not logged in\n";
// …and over a malformed config.toml, exit 1 with neither phrase. MEASURED at
// 0.152.0 (the path is this machine's scratch dir, elided).
const CODEX_CONFIG_ERROR_STDERR =
  "Error loading configuration: /tmp/broken/config.toml:1:6: key with no value, expected `=`\n";
// SOURCE-DERIVED, not measured: the other six sentences `run_login_status` can
// print, read verbatim from `codex-rs/cli/src/login.rs` at tag rust-v0.152.0.
// This account is a ChatGPT login, so only the first was observable here. They
// are pinned because the reader's design claim is that ONE prefix covers every
// auth mode — a claim that is worth nothing if only the mode we happen to use is
// ever exercised.
const CODEX_SIGNED_IN_VARIANTS_SOURCE_DERIVED = [
  "Logged in using workload identity\n",
  "Logged in using an API key - sk-…abcd\n",
  "Logged in using access token\n",
  "Logged in using personal access token\n",
  "Logged in using Amazon Bedrock API key\n",
  "Logged in using Amazon Bedrock AWS access keys\n",
];
// The non-answer on the same path (also SOURCE-DERIVED, login.rs): auth storage
// could not be read. It names neither phrase and must land on `unknown`.
const CODEX_STATUS_ERROR_STDERR = "Error checking login status: keyring unavailable\n";

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
  // Version-spanning: the 2.1.222 document (two fields shorter) classifies
  // identically to the 2.1.258 one. This is the "reads `loggedIn` and nothing
  // else" claim, tested rather than asserted in a comment.
  assert.equal(
    readClaudeAuth(exit(1, CLAUDE_SIGNED_OUT_JSON_2_1_222)),
    "signedOut",
    "an older, shorter auth document still classifies — no field-set coupling",
  );

  // Everything unreadable is unknown — never signedOut.
  const unreadable = [
    ["an unknown subcommand", exit(1, "", CLAUDE_UNKNOWN_COMMAND_STDERR)],
    ["empty output", exit(0, "")],
    ["not JSON", exit(0, "2.1.258 (Claude Code)\n")],
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

  // Every auth mode `run_login_status` can report shares the `Logged in` prefix,
  // which is what lets one anchor cover all seven without a per-mode table.
  for (const variant of CODEX_SIGNED_IN_VARIANTS_SOURCE_DERIVED) {
    assert.equal(
      readCodexAuth(exit(0, "", variant)),
      "signedIn",
      `every auth mode's sentence reads signedIn: ${JSON.stringify(variant)}`,
    );
  }

  assert.equal(
    readCodexAuth(exit(1, "", CODEX_CONFIG_ERROR_STDERR)),
    "unknown",
    "a config the CLI cannot load says nothing about auth",
  );
  assert.equal(
    readCodexAuth(exit(1, "", CODEX_STATUS_ERROR_STDERR)),
    "unknown",
    "auth storage that could not be read is unknown, never signedOut",
  );
  for (const [label, outcome] of [
    ["empty output", exit(1, "")],
    ["a version line", exit(0, "codex-cli 0.152.0\n")],
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
        ? exit(0, "codex-cli 0.152.0\n")
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
        return args[0] === "--version" ? exit(0, "2.1.258 (Claude Code)\n") : { kind: "failed" };
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

// 9) The details side channel (D2 U2 / F2): `projectsDirectory` off the SAME
//    document, delivered out of band so the readiness facts stay the renderer's
//    closed payload.
{
  assert.equal(
    readClaudeProjectsDirectory(exit(0, CLAUDE_SIGNED_IN_JSON)),
    "/home/someone/.claude/projects",
  );
  // Read on exit 1 too — the signed-out document carries the field, and a
  // machine whose CLI is signed out still has a transcript root.
  assert.equal(
    readClaudeProjectsDirectory(exit(1, CLAUDE_SIGNED_OUT_JSON)),
    "/tmp/fresh-home/.claude/projects",
  );
  // The 2.1.222 document predates the field entirely: null, which means "derive
  // it", not "there is none".
  assert.equal(readClaudeProjectsDirectory(exit(1, CLAUDE_SIGNED_OUT_JSON_2_1_222)), null);
  assert.equal(readClaudeProjectsDirectory(exit(1, "", CLAUDE_UNKNOWN_COMMAND_STDERR)), null);
  assert.equal(readClaudeProjectsDirectory(exit(0, '{"projectsDirectory":"   "}')), null, "blank is null");
  assert.equal(readClaudeProjectsDirectory(exit(0, '{"projectsDirectory":42}')), null, "non-string is null");

  // …and end to end through the probe, which must observe on EVERY pass — the
  // successful one, and the one where the auth command never ran, so a consumer
  // can never keep a value from a machine that has since lost the binary.
  const seen = [];
  const facts = await probeCliReadiness({
    observe: (details) => seen.push(details.claudeProjectsDirectory),
    run: async (command, args) => {
      if (command === "claude") {
        return args[0] === "--version"
          ? exit(0, "2.1.258 (Claude Code)\n")
          : exit(0, CLAUDE_SIGNED_IN_JSON);
      }
      return args[0] === "--version" ? { kind: "absent" } : exit(0);
    },
  });
  assert.equal(facts.claude.auth, "signedIn");
  assert.deepEqual(seen, ["/home/someone/.claude/projects"], "claude observes once; codex never");

  const afterUninstall = [];
  await probeCliReadiness({
    observe: (details) => afterUninstall.push(details.claudeProjectsDirectory),
    run: async () => ({ kind: "absent" }),
  });
  assert.deepEqual(afterUninstall, [null], "an absent binary observes null, not silence");

  // An observer that throws is a listener misbehaving, not a probe failing.
  const stillFacts = await probeCliReadiness({
    observe: () => {
      throw new Error("hostile observer");
    },
    run: async (command, args) =>
      args[0] === "--version" ? exit(0, "x") : exit(0, CLAUDE_SIGNED_IN_JSON),
  });
  assert.equal(stillFacts.claude.install, "present", "a throwing observer cannot break the probe");

  results.details = "projectsDirectory observed out of band, on every pass";
}

console.log(JSON.stringify({ success: true, results }, null, 2));
