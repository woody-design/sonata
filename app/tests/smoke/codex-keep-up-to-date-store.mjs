// Codex CLI auto-update S2 — the `keepCodexUpToDate` setting.
//
// This is the ONE setting in codex-settings.json whose default is ON, so the
// normalize path deserves its own fence: an existing install (whose file
// predates the key) must pick the feature UP on upgrade, not opt out of it by
// accident. That is the intent — an install that has been running Codex for
// months is exactly the one most likely to be stale — but a silent default flip
// in the other direction would be invisible, so it is pinned here.
//
// Mirrors codex-approval-default-store.mjs, the store fence for the sibling
// boolean (`autoTrustProjectFolders`, which defaults OFF).

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { CodexSettingsStore } = require("../../dist/main/settings-store");
const { DEFAULT_CODEX_SETTINGS, normalizeCodexSettings } = require(
  "../../dist/shared/types/codex-settings",
);

const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "sonata-codex-keep-current-"));
const store = new CodexSettingsStore(path.join(workspace, "codex-settings.json"));
const results = {};

// 1) The default is ON — and deliberately so. Codex has no background
//    self-updater; the boot prompt it does have goes unanswered inside a pty.
{
  assert.equal(DEFAULT_CODEX_SETTINGS.keepCodexUpToDate, true, "the shipped default is on");
  assert.equal(store.read().keepCodexUpToDate, true, "a missing file reads as on");
  results.default = true;
}

// 2) A pre-toggle file (the upgrade case) adopts the default rather than
//    reading absence as "off". COMPOSED — a codex-settings.json exactly as an
//    install from before this feature would have written it.
{
  const preToggle = {
    defaultPermissionMode: "approve-for-me",
    autoTrustProjectFolders: true,
    defaultModel: "gpt-5.6-sol",
    defaultReasoningEffort: "high",
  };
  const normalized = normalizeCodexSettings(preToggle);
  assert.equal(normalized.keepCodexUpToDate, true, "an upgrading install opts IN");
  // …and nothing else about their file moves.
  assert.equal(normalized.defaultPermissionMode, "approve-for-me", "their permission default holds");
  assert.equal(normalized.autoTrustProjectFolders, true, "their trust default holds");
  assert.equal(normalized.defaultModel, "gpt-5.6-sol", "their model default holds");
  results.preToggleFile = "adopts the default, disturbs nothing else";
}

// 3) Both values round-trip through the real atomic write.
{
  for (const value of [false, true, false]) {
    assert.equal(store.write({ keepCodexUpToDate: value }).keepCodexUpToDate, value, `write ${value}`);
    assert.equal(store.read().keepCodexUpToDate, value, `${value} round-trips`);
  }
  // An explicit off is preserved across a re-read — the one thing a
  // default-on setting must never do is quietly turn itself back on.
  store.write({ keepCodexUpToDate: false });
  assert.equal(store.read().keepCodexUpToDate, false, "an explicit opt-out STAYS out");
  const onDisk = JSON.parse(fs.readFileSync(store.filePath, "utf8"));
  assert.equal(onDisk.keepCodexUpToDate, false, "…and is on disk, not merely in memory");
  results.roundTrip = "ok";
}

// 4) Garbage normalizes to the default (fail-safe read), same as every sibling.
{
  for (const bad of ["true", 1, null, {}, []]) {
    assert.equal(
      normalizeCodexSettings({ keepCodexUpToDate: bad }).keepCodexUpToDate,
      true,
      `${JSON.stringify(bad)} → default`,
    );
  }
  assert.equal(normalizeCodexSettings(null).keepCodexUpToDate, true, "no document → default");
  results.garbage = "→ default";
}

// 5) The toggle is independent — flipping it moves nothing else.
{
  store.write({ ...DEFAULT_CODEX_SETTINGS, keepCodexUpToDate: false });
  const off = store.read();
  store.write({ ...off, keepCodexUpToDate: true });
  const on = store.read();
  assert.deepEqual(
    { ...off, keepCodexUpToDate: true },
    on,
    "flipping the switch changes exactly one field",
  );
  results.independent = "one field";
}

fs.rmSync(workspace, { recursive: true, force: true });
console.log(JSON.stringify({ success: true, results }, null, 2));
process.exitCode = 0;
