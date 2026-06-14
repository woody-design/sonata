import assert from "node:assert/strict";
import { createRequire } from "node:module";

// Pure intent classifier for the semantic-slash router (CLI Slice 4). Tied to
// the real builtin registry so a behavior/nativeMenu drift (e.g. /model losing
// its duet menu) is caught here.
const require = createRequire(import.meta.url);
const { classifySlashIntent } = require("../../dist/shared/slash/intent");
const { builtinSlashCommands } = require("../../dist/shared/slash/builtins");

function entry(provider, name) {
  const found = builtinSlashCommands(provider).find((candidate) => candidate.name === name);
  assert.ok(found, `expected builtin /${name} for ${provider}`);
  return found;
}

// --- unknown: nothing in the registry --------------------------------------
assert.equal(classifySlashIntent(null), "unknown", "null → unknown");
assert.equal(classifySlashIntent(undefined), "unknown", "undefined → unknown");

// --- skill: a prompt macro (kind:"skill") ----------------------------------
const skill = {
  invocation: "/architect",
  name: "architect",
  provider: "claude",
  kind: "skill",
  behavior: "prompt",
  description: "Architect mode",
  argumentHint: null,
  scope: "personal",
  listed: true,
  nativeMenu: null,
};
assert.equal(classifySlashIntent(skill), "skill", "kind:skill → skill");
// A skill must win even if it somehow carried a panel behavior.
assert.equal(
  classifySlashIntent({ ...skill, behavior: "panel" }),
  "skill",
  "skill behavior:panel still → skill",
);

// --- control: native-menu wins over its panel behavior ---------------------
assert.equal(classifySlashIntent(entry("claude", "model")), "control", "/model → control");
assert.equal(classifySlashIntent(entry("claude", "effort")), "control", "/effort → control");
assert.equal(
  classifySlashIntent(entry("claude", "permissions")),
  "control",
  "/permissions → control",
);
assert.equal(classifySlashIntent(entry("codex", "model")), "control", "codex /model → control");
// /model carries behavior:"panel" — confirm the nativeMenu check precedes it.
assert.equal(entry("claude", "model").behavior, "panel", "fixture: /model is behavior:panel");

// --- panel: interactive TUI, no duet menu → take-over floor ----------------
assert.equal(classifySlashIntent(entry("claude", "config")), "panel", "/config → panel");
assert.equal(classifySlashIntent(entry("claude", "resume")), "panel", "/resume → panel");
assert.equal(classifySlashIntent(entry("claude", "theme")), "panel", "/theme → panel");
assert.equal(classifySlashIntent(entry("codex", "resume")), "panel", "codex /resume → panel");

// --- passthrough: local / session / prompt builtins submit verbatim --------
assert.equal(classifySlashIntent(entry("claude", "status")), "passthrough", "/status → passthrough");
assert.equal(classifySlashIntent(entry("claude", "clear")), "passthrough", "/clear → passthrough");
assert.equal(classifySlashIntent(entry("claude", "init")), "passthrough", "/init → passthrough");
assert.equal(
  classifySlashIntent(entry("claude", "code-review")),
  "passthrough",
  "/code-review → passthrough",
);

console.log(JSON.stringify({ smoke: "slash-intent", success: true }, null, 2));
