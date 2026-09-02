import assert from "node:assert/strict";
import { createRequire } from "node:module";

// The 2-way intent classifier (S3, slash verbatim passthrough): skills get the
// composer's complete-don't-execute nicety; EVERYTHING else — builtins, panels,
// unknown — submits verbatim and any panel it opens renders in the co-visible
// terminal window. Tied to the real builtin registry so a registry drift (e.g.
// /model growing special routing again) is caught here.
const require = createRequire(import.meta.url);
const { classifySlashIntent } = require("../../dist/shared/slash/intent");
const { builtinSlashCommands } = require("../../dist/shared/slash/builtins");

function entry(provider, name) {
  const found = builtinSlashCommands(provider).find((candidate) => candidate.name === name);
  assert.ok(found, `expected builtin /${name} for ${provider}`);
  return found;
}

// --- unknown / absent entries → passthrough (never a special route) ---------
assert.equal(classifySlashIntent(null), "passthrough", "null → passthrough");
assert.equal(classifySlashIntent(undefined), "passthrough", "undefined → passthrough");

// --- skill: the one special intent (kind:"skill" completes, not executes) ---
const skill = {
  invocation: "/architect",
  name: "architect",
  provider: "claude",
  kind: "skill",
  description: "Architect mode",
  argumentHint: null,
  scope: "personal",
  listed: true,
};
assert.equal(classifySlashIntent(skill), "skill", "kind:skill → skill");

const codexSkill = { ...skill, invocation: "$architect", provider: "codex" };
assert.equal(classifySlashIntent(codexSkill), "skill", "codex $skill → skill");

// --- every builtin is a verbatim passthrough — incl. the ex-control and
// ex-panel classes (the retired 5-way's control/panel/unknown branches) ------
for (const provider of ["claude", "codex"]) {
  for (const builtin of builtinSlashCommands(provider)) {
    assert.equal(
      classifySlashIntent(builtin),
      "passthrough",
      `${provider} /${builtin.name} → passthrough`,
    );
  }
}
// The exact commands that used to route specially — locked to passthrough.
for (const name of ["model", "effort", "permissions"]) {
  assert.equal(classifySlashIntent(entry("claude", name)), "passthrough");
}
assert.equal(classifySlashIntent(entry("claude", "config")), "passthrough");
assert.equal(classifySlashIntent(entry("claude", "status")), "passthrough");
assert.equal(classifySlashIntent(entry("codex", "model")), "passthrough");
assert.equal(classifySlashIntent(entry("codex", "permissions")), "passthrough");

// The 2026-09-02 refresh added ALIAS entries (`/review` → /code-review,
// `/quit` → /exit, …). An alias is still a builtin and still submits verbatim:
// the CLI, not Sonata, resolves the fold. Locking both halves of a pair here
// makes that explicit — nothing in this file may start rewriting an alias to
// its canonical spelling on the way to the PTY.
for (const [alias, canonical] of [["review", "code-review"], ["quit", "exit"], ["stats", "usage"]]) {
  assert.equal(classifySlashIntent(entry("claude", alias)), "passthrough", `/${alias} → passthrough`);
  assert.equal(classifySlashIntent(entry("claude", canonical)), "passthrough", `/${canonical} → passthrough`);
  assert.equal(
    entry("claude", alias).invocation,
    `/${alias}`,
    `/${alias} submits as itself, not as /${canonical}`,
  );
}

console.log("slash-intent smoke: all assertions passed (2-way: skill | passthrough)");
