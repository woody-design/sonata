// Layer-1 smoke — the default-permission-mode plumbing:
//   1. ClaudeSettingsStore round-trip + normalize (positive enum, default
//      "default"; gated modes like bypassPermissions rejected from the
//      standing default).
//   2. claudeArgs maps each mode (incl. auto) to --permission-mode <mode>.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { claudeArgs } = require("../../dist/runtime");
const { ClaudeSettingsStore } = require("../../dist/main/settings-store");

const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "duet-claude-perm-"));
const failures = [];
const assert = (cond, label) => { if (!cond) failures.push(label); };

// --- store ------------------------------------------------------------------
const store = new ClaudeSettingsStore(path.join(workspace, "claude-settings.json"));
assert(store.read().defaultPermissionMode === "default", "default is 'default'");
assert(store.write({ defaultPermissionMode: "auto" }).defaultPermissionMode === "auto", "write auto");
assert(store.read().defaultPermissionMode === "auto", "auto round-trips");
assert(
  store.write({ defaultPermissionMode: "acceptEdits" }).defaultPermissionMode === "acceptEdits",
  "write acceptEdits",
);
// Gated/CI modes must NOT survive as a standing default.
assert(
  store.write({ defaultPermissionMode: "bypassPermissions" }).defaultPermissionMode === "default",
  "bypassPermissions normalized out of the default",
);
assert(
  store.write({ defaultPermissionMode: "dontAsk" }).defaultPermissionMode === "default",
  "dontAsk normalized out of the default",
);
assert(
  store.write({ defaultPermissionMode: "garbage" }).defaultPermissionMode === "default",
  "garbage normalizes to default",
);
assert(
  new ClaudeSettingsStore(path.join(workspace, "missing.json")).read().defaultPermissionMode === "default",
  "missing file reads as default",
);

// --- claudeArgs maps the flag ----------------------------------------------
for (const mode of ["default", "acceptEdits", "plan", "auto"]) {
  const args = claudeArgs({ permissionMode: mode });
  const i = args.indexOf("--permission-mode");
  assert(i >= 0 && args[i + 1] === mode, `claudeArgs maps --permission-mode ${mode}`);
}

fs.rmSync(workspace, { recursive: true, force: true, maxRetries: 5 });
const success = failures.length === 0;
console.log(JSON.stringify({ success, failures }, null, 2));
process.exitCode = success ? 0 : 1;
