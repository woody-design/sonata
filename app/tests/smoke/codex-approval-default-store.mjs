// Layer-1 smoke — the CodexSettingsStore round-trip (the Sonata-owned default
// permission preset new Codex sessions launch with). Mirrors the Claude
// permission-default store fence: positive enum for the three offered modes,
// legacy `-a` defaults migrate on read (never escalating), garbage/missing
// fail safe to "ask-for-approval"; an absent key/file takes the fresh-install
// default "full-access".

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { CodexSettingsStore } = require("../../dist/main/settings-store");

const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "sonata-codex-permission-"));
const failures = [];
const assert = (cond, label) => {
  if (!cond) failures.push(label);
};

const store = new CodexSettingsStore(path.join(workspace, "codex-settings.json"));

// Default (nothing written yet) is the fresh-install default: Full Access.
assert(store.read().defaultPermissionMode === "full-access", "default is 'full-access'");

// All three offered permission modes round-trip.
for (const mode of ["ask-for-approval", "approve-for-me", "full-access"]) {
  assert(
    store.write({ defaultPermissionMode: mode }).defaultPermissionMode === mode,
    `write ${mode}`,
  );
  assert(store.read().defaultPermissionMode === mode, `${mode} round-trips`);
}

// Legacy `defaultApprovalMode` values migrate on read, by ask-frequency intent
// and NEVER escalating: `never` (Codex approves everything) → approve-for-me;
// everything that asked before (untrusted, on-request) and the retired
// `on-failure` → ask-for-approval. Nothing legacy reaches full-access.
const legacyMigration = {
  untrusted: "ask-for-approval",
  "on-request": "ask-for-approval",
  never: "approve-for-me",
  "on-failure": "ask-for-approval",
};
for (const [legacy, expected] of Object.entries(legacyMigration)) {
  assert(
    store.write({ defaultApprovalMode: legacy }).defaultPermissionMode === expected,
    `legacy ${legacy} migrates to ${expected}`,
  );
  assert(store.read().defaultPermissionMode === expected, `migrated ${legacy} round-trips`);
}

// Unknown values normalize to the default (fail-safe read).
assert(
  store.write({ defaultPermissionMode: "garbage" }).defaultPermissionMode === "ask-for-approval",
  "garbage fails safe to ask-for-approval",
);
assert(
  store.write({}).defaultPermissionMode === "full-access",
  "empty object normalizes to full-access",
);

// A missing file reads as the default rather than throwing.
assert(
  new CodexSettingsStore(path.join(workspace, "missing.json")).read().defaultPermissionMode ===
    "full-access",
  "missing file reads as full-access",
);

fs.rmSync(workspace, { recursive: true, force: true, maxRetries: 5 });
const success = failures.length === 0;
console.log(JSON.stringify({ success, failures }, null, 2));
process.exitCode = success ? 0 : 1;
