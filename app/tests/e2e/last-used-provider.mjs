// CLI readiness S3 — the last-used-provider loop, in the real app.
//
// The unit fences (tests/smoke/last-used-provider.mjs) cover the migration, the
// store, the seed rule, and the write SITE against the real RuntimeController.
// What only the app can show is the loop closing across all three layers:
//
//   1. an UPGRADED install (the retired `defaultProvider` key) opens its first
//      draft on exactly the provider it opened on before;
//   2. switching the draft records NOTHING — only a session start does;
//   3. after that start, a New Chat in the SAME run opens on it (the renderer
//      mirror follows main's write; without that sync the draft would wear the
//      boot value until a relaunch);
//   4. and so does a New Chat after a RESTART (the record outlives the process).
//
// Deterministic by construction: fake `claude`/`codex` binaries on PATH (the
// cli-start-without-prompt harness) and "Start CLI", so a session is born from a
// real PTY with no model, no network, and no reply to wait for.

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { _electron as electron } from "playwright-core";
import { chooseDraftProvider } from "./helpers/session.mjs";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "sonata-last-used-provider-e2e-"));
const dataRoot = path.join(root, "data-root");
const settingsDir = path.join(root, "settings");
const homeDir = path.join(root, "home");
const fakeBin = path.join(root, "bin");
const sonataSettingsPath = path.join(settingsDir, "sonata-settings.json");
for (const dir of [settingsDir, homeDir, fakeBin]) {
  fs.mkdirSync(dir, { recursive: true });
}
installFakeProvider("claude");
installFakeProvider("codex");

// The fixture is an UPGRADED install: the retired `defaultProvider` key, exactly
// as it sits on a machine that ran Sonata before S3. Claude here, so the switch
// to Codex below is a real change and every later assertion is non-vacuous.
fs.writeFileSync(sonataSettingsPath, `${JSON.stringify({ defaultProvider: "claude" }, null, 2)}\n`);

let app = null;
const observed = {};
try {
  let main = await launch();
  // 1. The migration, seen from the outside: the draft opens on Claude.
  await main.locator("#provider-chip", { hasText: "Claude" }).waitFor({ state: "visible" });
  observed.upgradedInstallOpensOn = "Claude";
  assert.deepEqual(
    readJson(sonataSettingsPath),
    { defaultProvider: "claude" },
    "reading the record does not rewrite the legacy file",
  );

  // 2. A draft switch is a draft choice, not a record.
  await chooseDraftProvider(main, "codex");
  await main.locator("#provider-chip", { hasText: "Codex" }).waitFor({ state: "visible" });
  assert.deepEqual(
    readJson(sonataSettingsPath),
    { defaultProvider: "claude" },
    "switching the draft's provider records nothing",
  );

  // A session actually starts — no prompt, no model: "Start CLI" in the terminal
  // window spawns the (fake) PTY the draft is configured for.
  const cli = await waitForWindow(app, (page) => page.url().endsWith("/terminal.html"));
  cli.setDefaultTimeout(30_000);
  await cli.locator("#terminal-empty-action:not(:disabled)", { hasText: "Start CLI" }).waitFor({
    state: "visible",
  });
  await cli.locator("#terminal-empty-action", { hasText: "Start CLI" }).click();
  await main.locator(".sidebar-session.active").waitFor({ state: "visible" });

  // The record is written at the START, and the retired key is gone with it.
  await waitUntil(() => readJson(sonataSettingsPath)?.lastUsedProvider === "codex");
  assert.deepEqual(
    readJson(sonataSettingsPath),
    { lastUsedProvider: "codex" },
    "the session start records Codex and drops the retired key",
  );
  observed.recordAfterStart = readJson(sonataSettingsPath);

  // 3. THE mirror: a New Chat in this same run opens on Codex, not on the Claude
  //    this run booted with.
  await main.locator("#sidebar-new-chat").click();
  await main.locator(".task-entry-panel").waitFor({ state: "visible" });
  await main.locator("#provider-chip", { hasText: "Codex" }).waitFor({ state: "visible" });
  observed.newChatSameRunOpensOn = "Codex";

  await app.close();
  app = null;

  // 4. And across a restart, from the record on disk.
  main = await launch();
  await main.locator("#provider-chip", { hasText: "Codex" }).waitFor({ state: "visible" });
  observed.newChatAfterRestartOpensOn = "Codex";

  console.log(JSON.stringify({ ...observed, success: true }, null, 2));
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  if (app) {
    await app.close();
  }
  fs.rmSync(root, { recursive: true, force: true });
}

async function launch() {
  app = await electron.launch({
    args: ["dist/main/main.js"],
    env: {
      ...process.env,
      HOME: homeDir,
      SONATA_DATA_DIR: dataRoot,
      SONATA_WORKSPACES_DIR: path.join(root, "workspaces"),
      SONATA_SETTINGS_DIR: settingsDir,
      SONATA_NOTIFICATIONS: "0",
      PATH: `${fakeBin}${path.delimiter}${process.env.PATH ?? ""}`,
    },
  });
  const page = await app.firstWindow();
  page.setDefaultTimeout(30_000);
  await page.locator(".task-entry-panel").waitFor({ state: "visible" });
  return page;
}

/** A deterministic fake CLI: answers the readiness probe's structured commands and
 *  exits; otherwise records its argv, prints a ready prompt line so the boot latch
 *  opens, and then just stays alive (the session behaviour is lifted verbatim from
 *  cli-start-without-prompt.mjs — the same reason applies here).
 *
 *  The probe arm is not decoration. Since S1, EVERY launch runs `<provider>
 *  --version` (and then the auth command) against whatever is on PATH — which here
 *  is this script. Without an early exit it fell through to the session behaviour
 *  and hung forever on those calls, so each launch left two node processes that
 *  outlived their temp dir and, on an interrupted run, the app itself (S2 found and
 *  killed ten of them). Answering is also the honest shape: the machine this
 *  fixture describes has both CLIs installed and signed in.
 *
 *  Output shapes MEASURED in S1 (claude 2.1.222 / codex-cli 0.146.0) and reused
 *  verbatim from tests/e2e/helpers/cli-readiness-fixture.mjs: claude puts a
 *  `loggedIn` JSON document on stdout, codex puts a line-anchored phrase on
 *  STDERR. The resulting facts (both present + signedIn) leave every readiness
 *  surface silent, which is what this test's New Chat assertions require. */
function installFakeProvider(provider) {
  const filePath = path.join(fakeBin, provider);
  fs.writeFileSync(
    filePath,
    `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const provider = path.basename(process.argv[1]);
const argv = process.argv.slice(2);
if (argv[0] === "--version") {
  process.stdout.write(provider === "claude" ? "2.1.222 (Claude Code)\\n" : "codex-cli 0.146.0\\n");
  process.exit(0);
}
if ((provider === "claude" && argv[0] === "auth" && argv[1] === "status") ||
    (provider === "codex" && argv[0] === "login" && argv[1] === "status")) {
  if (provider === "claude") {
    process.stdout.write('{"loggedIn":true,"authMethod":"claude.ai"}\\n');
  } else {
    process.stderr.write("Logged in using ChatGPT\\n");
  }
  process.exit(0);
}
const settingsIndex = argv.indexOf("--settings");
const runtimeDir = process.env.SONATA_RUNTIME_DIR || (settingsIndex >= 0 ? path.dirname(argv[settingsIndex + 1]) : null);
if (runtimeDir) {
  fs.mkdirSync(runtimeDir, { recursive: true });
  fs.writeFileSync(path.join(runtimeDir, "spawn-record.json"), JSON.stringify({ provider, argv }));
}
if (process.stdin.isTTY) { try { process.stdin.setRawMode(true); } catch {} }
process.stdin.resume();
process.stdout.write(provider === "claude" ? "Fake Claude ready\\n❯ sonnet high ~\\n" : "Fake Codex ready\\n› gpt-5.6-luna high ~\\n");
setInterval(() => {}, 1 << 30);
`,
    { mode: 0o755 },
  );
  fs.chmodSync(filePath, 0o755);
}

async function waitForWindow(electronApp, predicate) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const found = electronApp.windows().find(predicate);
    if (found) {
      return found;
    }
    await delay(100);
  }
  throw new Error("timed out waiting for the CLI window");
}

async function waitUntil(predicate, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) {
      return;
    }
    await delay(100);
  }
  throw new Error("timed out waiting for the last-used record");
}

function readJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
