// Layer-1 smoke — the CodexSettingsStore round-trip (the Duet-owned default
// approval policy new Codex sessions launch with). Mirrors the Claude
// permission-default store fence: positive enum for all four official `-a`
// values, garbage/missing normalize to the behaviour-neutral "on-request".

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { CodexSettingsStore } = require("../../dist/main/settings-store");

const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "duet-codex-approval-"));
const failures = [];
const assert = (cond, label) => {
  if (!cond) failures.push(label);
};

const store = new CodexSettingsStore(path.join(workspace, "codex-settings.json"));

// Default (nothing written yet) is Codex's own default → behaviour-neutral.
assert(store.read().defaultApprovalMode === "on-request", "default is 'on-request'");

// All four official Codex approval-policy values round-trip.
for (const mode of ["untrusted", "on-request", "on-failure", "never"]) {
  assert(
    store.write({ defaultApprovalMode: mode }).defaultApprovalMode === mode,
    `write ${mode}`,
  );
  assert(store.read().defaultApprovalMode === mode, `${mode} round-trips`);
}

// Unknown values normalize back to the default (fail-safe read).
assert(
  store.write({ defaultApprovalMode: "garbage" }).defaultApprovalMode === "on-request",
  "garbage normalizes to on-request",
);
assert(
  store.write({}).defaultApprovalMode === "on-request",
  "empty object normalizes to on-request",
);

// A missing file reads as the default rather than throwing.
assert(
  new CodexSettingsStore(path.join(workspace, "missing.json")).read().defaultApprovalMode ===
    "on-request",
  "missing file reads as on-request",
);

fs.rmSync(workspace, { recursive: true, force: true, maxRetries: 5 });
const success = failures.length === 0;
console.log(JSON.stringify({ success, failures }, null, 2));
process.exitCode = success ? 0 : 1;
