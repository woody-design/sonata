// The fake provider binary the app-level e2e put on PATH in place of a real CLI.
//
// It is the SESSION species of fake CLI: a process that boots, paints an idle
// prompt so Sonata's boot latch opens, records what the test wants to observe, and
// then stays alive exactly as a real TUI does until something kills it. Its sibling
// `cli-readiness-fixture.mjs` is the MACHINE species — control-file-driven shell
// stubs whose job is to be absent, or present-but-signed-out, and to change mid-run.
// Keep them apart: a test that needs a broken machine wants that one, and a test
// that needs a working session wants this one.
//
// ── Why every one of these MUST answer the readiness probe ───────────────────
//
// Since CLI readiness S1, EVERY app launch runs `<provider> --version` and then the
// provider's auth command against whatever is on PATH — which, in these tests, is
// this script. A script that ignores those two invocations and falls through to its
// stay-alive tail becomes an immortal process: it outlives its temp dir, and on an
// interrupted run it outlives the app (S2 found and killed ten of them).
//
// MEASURED 2026-08-06 by running each pre-migration script as the probe would
// (`--version`, with no SONATA_RUNTIME_DIR — it is a per-spawn binding the probe's
// environment does not have). The six fixtures this helper REPLACED split five/one:
//
//   - FIVE crashed on `fs.mkdirSync(undefined)` / `mkdirSync(null)` and exited 1
//     (cli-lifecycle-races, cli-start-without-prompt, composer-focus-retention,
//     cli-resume-without-prompt, cli-surface-chrome). No leak — but a non-zero exit
//     reads as `install: unknown`, so each was describing a machine whose CLIs
//     cannot be read, which is not the machine any of them meant to describe. And
//     each was one defensive `if (runtimeDir)` away from becoming a leaker: adding
//     exactly that guard is what turned S3's copy into one.
//   - ONE hung (session-title-lifecycle, which touches no runtime dir). Its script
//     WOULD be immortal under a probe, but no probe ever ran against it: that file
//     drives a bare `RuntimeController` with `INERT_CLI_READINESS_SOURCE`. Arming it
//     is still right — the harness is the only thing standing between that script
//     and the leak — but it never actually leaked, and saying otherwise would be
//     inventing evidence.
//
// The scripts whose bodies stay bespoke and take only the arms below are measured
// separately, and two of them are where the real leak lived: `fake-codex-source`
// and `cli-background-generation` both HUNG under a real app launch, and orphaned
// `codex --version` processes from the latter were found by `pgrep` after this
// round's own runs. `cli-runtime-liveness` hung too, and worse — see its own note.
//
// So the probe arms come FIRST, before anything else the script does, and they
// EXIT. Both of them, not just `--version` (S4's D-16): the probe is sequential and
// short-circuiting, so answering only the version command would leave the auth call
// hanging into its 5s timeout on every launch.
//
// ── The machine this describes ───────────────────────────────────────────────
//
// Installed and signed in — deliberately the only shape on offer here. It leaves
// every readiness surface silent, which is what a test about something else needs,
// and a test that wants a DIFFERENT shape should reach for the machine fixture
// rather than teach this one to lie in a second way.
//
// Provenance: the probe's output shapes are MEASURED (claude 2.1.222 / codex-cli
// 0.146.0, recorded in the S1 slice record and pinned by
// tests/smoke/cli-readiness-probe.mjs) — claude answers `auth status --json` with a
// `loggedIn` document on stdout, codex answers `login status` on STDERR. The
// session bodies are COMPOSED, lifted from the fixtures they replace so each
// test's observable behaviour is byte-for-byte what it was.

import fs from "node:fs";
import path from "node:path";

/** MEASURED version lines (S1). Not parsed by the probe — a clean exit is the
 *  whole `present` claim — but honest output costs nothing. */
export const FAKE_CLI_VERSIONS = {
  claude: "2.1.222 (Claude Code)",
  codex: "codex-cli 0.146.0",
};

/** What a booted session prints once: a banner plus the provider's own idle-prompt
 *  glyph and footer, which is what `detectIdlePromptForProvider` accepts — i.e. what
 *  makes Sonata's boot latch open. Per-test variants pass `readyOutput`. */
export const FAKE_CLI_READY_OUTPUT = {
  claude: "Fake Claude ready\n❯ sonnet high ~\n",
  codex: "Fake Codex ready\n› gpt-5.6-luna high ~\n",
};

/** Every artifact a test can ask this fake to leave in `SONATA_RUNTIME_DIR`. Named
 *  one-to-one with the file it writes, because the test reads it by that name. */
const RECORDS = new Set(["spawned", "spawn-record", "spawn-count", "spawn-argv", "stdin"]);

/**
 * The probe-answering prologue, as node source — for scripts with a body too
 * bespoke to generate (today: `fake-codex-source.mjs`).
 *
 * Written against `process.argv` directly rather than a local `argv`, so it can be
 * spliced above any script's own declarations without colliding with them.
 */
export function fakeCliProbeArms(provider) {
  const version = JSON.stringify(`${FAKE_CLI_VERSIONS[provider]}\n`);
  const authArm =
    provider === "claude"
      ? `if (process.argv[2] === "auth" && process.argv[3] === "status") {
  process.stdout.write(${JSON.stringify('{"loggedIn":true,"authMethod":"claude.ai"}\n')});
  process.exit(0);
}`
      : `if (process.argv[2] === "login" && process.argv[3] === "status") {
  process.stderr.write(${JSON.stringify("Logged in using ChatGPT\n")});
  process.exit(0);
}`;
  return `// The CLI readiness probe (S1) runs these two against whatever is on PATH at
// every launch. Answer and EXIT — a fall-through here is an immortal process that
// outlives this test's temp dir (see tests/e2e/helpers/fake-cli.mjs).
if (process.argv[2] === "--version") {
  process.stdout.write(${version});
  process.exit(0);
}
${authArm}`;
}

/**
 * The whole fake CLI, as node source.
 *
 * @param {"claude"|"codex"} provider
 * @param {{
 *   readyOutput?: string,
 *   records?: ReadonlyArray<"spawned"|"spawn-record"|"spawn-count"|"spawn-argv"|"stdin">,
 *   echoStdin?: boolean,
 * }} [options]
 *   `readyOutput` — the banner + idle prompt this session paints (defaults to the
 *   provider's shape above). `records` — which observation files to leave in
 *   `SONATA_RUNTIME_DIR`. `echoStdin` — echo written bytes back to stdout, which is
 *   how a test earns DeliveryController's pty-composer-echo receipt instead of
 *   waiting out its 45s timeout on every send.
 */
export function fakeCliSource(provider, options = {}) {
  const {
    readyOutput = FAKE_CLI_READY_OUTPUT[provider],
    records = [],
    echoStdin = false,
  } = options;
  for (const record of records) {
    if (!RECORDS.has(record)) {
      throw new Error(`unknown fake-cli record: ${record}`);
    }
  }
  const wants = (record) => records.includes(record);
  // spawn-argv names its file by the spawn number, so it needs the counter kept.
  const counted = wants("spawn-count") || wants("spawn-argv");

  const observations = [
    ...(wants("spawned") ? [`  fs.writeFileSync(path.join(runtimeDir, "spawned"), "1");`] : []),
    ...(wants("spawn-record")
      ? [
          `  fs.writeFileSync(`,
          `    path.join(runtimeDir, "spawn-record.json"),`,
          `    JSON.stringify({ provider: ${JSON.stringify(provider)}, argv, sonataRuntimeDir: process.env.SONATA_RUNTIME_DIR || null }),`,
          `  );`,
        ]
      : []),
    ...(counted
      ? [
          `  const countPath = path.join(runtimeDir, "spawn-count");`,
          `  let count = 0;`,
          `  try { count = Number(fs.readFileSync(countPath, "utf8")) || 0; } catch {}`,
          `  count += 1;`,
          `  fs.writeFileSync(countPath, String(count));`,
        ]
      : []),
    ...(wants("spawn-argv")
      ? [
          `  fs.writeFileSync(path.join(runtimeDir, "spawn-" + count + ".json"), JSON.stringify({ argv }));`,
        ]
      : []),
  ];

  const stdinHandler =
    wants("stdin") || echoStdin
      ? [
          `process.stdin.on("data", (chunk) => {`,
          ...(wants("stdin")
            ? [
                `  if (runtimeDir) {`,
                `    fs.appendFileSync(path.join(runtimeDir, "stdin.bin"), chunk);`,
                `  }`,
              ]
            : []),
          ...(echoStdin ? [`  process.stdout.write(chunk);`] : []),
          `});`,
        ]
      : [];

  return [
    `#!/usr/bin/env node`,
    `"use strict";`,
    `const fs = require("node:fs");`,
    `const path = require("node:path");`,
    ``,
    fakeCliProbeArms(provider),
    ``,
    `// Anything else is the CLI itself being run: this is the session.`,
    `const argv = process.argv.slice(2);`,
    `// SONATA_RUNTIME_DIR is the per-spawn binding; \`--settings\` is the fallback for`,
    `// a spawn shape that carries the path but not the variable.`,
    `const settingsIndex = argv.indexOf("--settings");`,
    `const runtimeDir =`,
    `  process.env.SONATA_RUNTIME_DIR ||`,
    `  (settingsIndex >= 0 && argv[settingsIndex + 1] ? path.dirname(argv[settingsIndex + 1]) : null);`,
    `if (runtimeDir) {`,
    `  fs.mkdirSync(runtimeDir, { recursive: true });`,
    ...observations,
    `}`,
    `// Raw mode like a real TUI, so PTY input surfaces byte-by-byte: Sonata terminates`,
    `// prompts with CSI-u Enter (\\x1b[13u), which a canonical-mode TTY would line-buffer`,
    `// forever without ever emitting "data".`,
    `if (process.stdin.isTTY) { try { process.stdin.setRawMode(true); } catch {} }`,
    `process.stdin.resume();`,
    ...stdinHandler,
    `process.stdout.write(${JSON.stringify(readyOutput)});`,
    `// Stay alive: a real TUI holds the PTY open until the user quits.`,
    `setInterval(() => {}, 1 << 30);`,
    ``,
  ].join("\n");
}

/**
 * Write the fake CLI into `binDir` under the provider's own name and make it
 * executable. Returns the path.
 *
 * @param {string} binDir  a bin dir already on the app's PATH
 * @param {"claude"|"codex"} provider
 * @param {Parameters<typeof fakeCliSource>[1]} [options]
 */
export function installFakeCli(binDir, provider, options = {}) {
  const filePath = path.join(binDir, provider);
  fs.mkdirSync(binDir, { recursive: true });
  fs.writeFileSync(filePath, fakeCliSource(provider, options), { mode: 0o755 });
  // Explicit chmod: the `mode` option is masked by the process umask.
  fs.chmodSync(filePath, 0o755);
  return filePath;
}
