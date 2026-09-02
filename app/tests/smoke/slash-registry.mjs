import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

// Fake HOME/CODEX_HOME before requiring the modules: os.homedir() reads $HOME
// on POSIX at call time, so discovery scans the fixture tree, not the real one.
const fixtureHome = fs.mkdtempSync(path.join(os.tmpdir(), "sonata-slash-smoke-"));
process.env.HOME = fixtureHome;
process.env.CODEX_HOME = path.join(fixtureHome, ".codex");

const require = createRequire(import.meta.url);
const { builtinSlashCommands } = require("../../dist/shared/slash/builtins");
const {
  listSlashCommands,
  clearSlashCommandCache,
  parseFrontmatter,
} = require("../../dist/main/skills-discovery");

function writeSkill(root, name, frontmatterLines, body = "Do the thing.") {
  const dir = path.join(root, name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, "SKILL.md"),
    ["---", ...frontmatterLines, "---", "", body, ""].join("\n"),
  );
}

// --- frontmatter parsing ---
{
  const { frontmatter, body } = parseFrontmatter(
    ['---', 'name: demo', 'description: "A quoted description"', "argument-hint: [target]", "---", "", "Body line."].join("\n"),
  );
  assert.equal(frontmatter.name, "demo");
  assert.equal(frontmatter.description, "A quoted description");
  assert.equal(frontmatter["argument-hint"], "[target]");
  assert.equal(body.trim(), "Body line.");
}
{
  const { frontmatter, body } = parseFrontmatter("No frontmatter here.\n");
  assert.deepEqual(frontmatter, {});
  assert.equal(body, "No frontmatter here.\n");
}

// --- builtin snapshots (S3: every builtin is a verbatim passthrough) ---
for (const provider of ["claude", "codex"]) {
  const builtins = builtinSlashCommands(provider);
  const names = builtins.map((entry) => entry.name);
  assert.equal(new Set(names).size, names.length, `${provider} builtin names must be unique`);
  for (const entry of builtins) {
    assert.equal(entry.kind, "builtin", `${provider} /${entry.name} is a builtin entry`);
    assert.equal(entry.invocation, `/${entry.name}`, `${provider} /${entry.name} invokes verbatim`);
  }
  assert.ok(builtins.some((entry) => entry.listed), `${provider} must list some builtins`);
  assert.ok(
    builtins.some((entry) => !entry.listed),
    `${provider} must keep some builtins unlisted — the snapshot records what the CLI accepts, the picker shows only the curated subset`,
  );
}

// --- the CURATED listed set is the whole picker (SL-10) ---------------------
// The listing policy is a deliberate, small, Woody-owned set — "widening it is
// a follow-up, not a routing concern". At 130 claude entries an accidental
// `listed: true` is a one-character edit that nothing else would catch, so the
// set is pinned exactly rather than by count.
assert.deepEqual(
  builtinSlashCommands("claude").filter((e) => e.listed).map((e) => e.name),
  ["model", "effort", "permissions", "compact", "status", "init", "security-review", "code-review", "simplify", "btw", "fast"],
  "claude listed set (order is the curated picker order, not alphabetical)",
);
assert.deepEqual(
  builtinSlashCommands("codex").filter((e) => e.listed).map((e) => e.name),
  ["model", "permissions", "compact", "status", "diff", "init", "mcp", "fast"],
  "codex listed set",
);

// --- the 2026-09-02 walk, pinned where the measurement CHANGED --------------
// Presence pins are cheap and would rot into noise if applied to all 182
// entries; these are the ones whose status the walk actually moved, which is
// also the set a future refresh most needs protected.
{
  const claude = new Map(builtinSlashCommands("claude").map((e) => [e.name, e]));
  const codex = new Map(builtinSlashCommands("codex").map((e) => [e.name, e]));

  // /review stopped being its own command and became an alias of /code-review
  // (measured: submitting it starts a code-review run). It has to stay in the
  // snapshot — the CLI still accepts it — but out of the picker, where
  // /code-review already sits. This is the one entry claude 2.1.236's
  // fuzzy-match removal would have punished if the walk had read it as gone.
  assert.equal(claude.get("review")?.listed, false, "/review is an alias, not a picker row");
  assert.match(claude.get("review")?.description ?? "", /alias of \/code-review/);
  assert.equal(claude.get("code-review")?.listed, true, "/code-review carries the listing");

  // Every alias spelling s2 submitted and measured as still ACCEPTED.
  for (const [alias, canonical] of [
    ["checkpoint", "rewind"], ["undo", "rewind"], ["stats", "usage"], ["cost", "usage"],
    ["bashes", "tasks"], ["quit", "exit"], ["plugins", "plugin"],
  ]) {
    const entry = claude.get(alias);
    assert.ok(entry, `claude /${alias} stays in the snapshot (measured accepted at 2.1.258)`);
    assert.equal(entry.listed, false, `/${alias} is unlisted`);
    assert.match(entry.description, new RegExp(`alias of /${canonical}`), `/${alias} names its canonical`);
  }

  // Measured PRESENT at 2.1.258 / 0.152.1 and absent from the previous pin.
  assert.ok(claude.has("ultrareview"), "claude /ultrareview (missing from the snapshot since ~2.1.206)");
  for (const name of ["export", "cd", "pwd", "agents", "recap"]) {
    assert.ok(codex.has(name), `codex /${name} is new at 0.152.1`);
  }

  // Measured ABSENT. `/agent` is a strict prefix of the `/agents` that replaced
  // it, so a picker that still knew it would have offered it — this is the one
  // removal in either pool, and the only kind of drift that can leave a dead
  // row in Sonata's own picker.
  assert.equal(codex.has("agent"), false, "codex /agent was renamed to /agents at 0.152");
  assert.equal(claude.has("ultraplan"), false, "claude /ultraplan does not exist (measured: Unknown command)");
}

// --- the unlisted tail is alphabetical (the file's maintenance contract) ----
// Refreshing this snapshot means diffing a sorted file against a sorted walk.
// The ordering is load-bearing for that, and nothing else enforces it.
for (const provider of ["claude", "codex"]) {
  const unlisted = builtinSlashCommands(provider).filter((e) => !e.listed).map((e) => e.name);
  assert.deepEqual(
    unlisted,
    [...unlisted].sort(),
    `${provider} unlisted builtins must stay alphabetical`,
  );
}

// --- Claude discovery: personal skill + legacy command + project shadowing ---
const claudeSkillsRoot = path.join(fixtureHome, ".claude", "skills");
writeSkill(claudeSkillsRoot, "deploy-docs", ["name: deploy-docs", "description: Deploy the docs site", "argument-hint: [env]"]);
writeSkill(claudeSkillsRoot, "secret-helper", ["description: Hidden", "user-invocable: false"]);
const claudeCommandsRoot = path.join(fixtureHome, ".claude", "commands");
fs.mkdirSync(claudeCommandsRoot, { recursive: true });
fs.writeFileSync(
  path.join(claudeCommandsRoot, "ship.md"),
  "---\ndescription: Legacy ship command\n---\n\nShip it.\n",
);

const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "sonata-slash-project-"));
fs.mkdirSync(path.join(projectRoot, ".git"), { recursive: true });
writeSkill(path.join(projectRoot, ".claude", "skills"), "deploy-docs", [
  "description: Project-local deploy override",
]);

clearSlashCommandCache();
const claude = listSlashCommands("claude", projectRoot);
const claudeByName = new Map(claude.entries.map((entry) => [entry.name, entry]));
assert.equal(claudeByName.get("deploy-docs")?.scope, "project", "project skill shadows personal");
assert.equal(claudeByName.get("deploy-docs")?.description, "Project-local deploy override");
assert.equal(claudeByName.get("deploy-docs")?.invocation, "/deploy-docs");
assert.equal(claudeByName.get("ship")?.description, "Legacy ship command");
assert.equal(claudeByName.has("secret-helper"), false, "user-invocable: false stays hidden");

// --- Codex discovery: $ invocation, system scope, .agents project root ---
writeSkill(path.join(fixtureHome, ".codex", "skills", ".system"), "skill-creator", [
  "name: skill-creator",
  "description: Create or update a skill",
]);
writeSkill(path.join(fixtureHome, ".agents", "skills"), "publish-changes", [
  "description: Commit, push, and open a PR",
]);
writeSkill(path.join(projectRoot, ".agents", "skills"), "sonata-probe-skill", [
  "name: sonata-probe-skill",
  "description: Probe skill",
]);

clearSlashCommandCache();
const codex = listSlashCommands("codex", projectRoot);
const codexByName = new Map(codex.entries.map((entry) => [entry.name, entry]));
assert.equal(codexByName.get("sonata-probe-skill")?.invocation, "$sonata-probe-skill");
assert.equal(codexByName.get("sonata-probe-skill")?.scope, "project");
assert.equal(codexByName.get("skill-creator")?.scope, "system");
assert.equal(codexByName.get("publish-changes")?.scope, "personal");
assert.equal(
  codexByName.get("publish-changes")?.kind,
  "skill",
  "codex skills surface as skill entries",
);

// --- symlink discovery (regression: ~/.claude/skills/* are all symlinks) ---
// Woody's real skills are symlinks (→ another repo's skills tree). A symlink
// dirent reports isDirectory()/isFile() === false, so a bare guard dropped
// every one of them silently (0 entries, 0 warnings). Discovery must follow
// the link. Mirror that exact shape here — the regression was untested.
const linkStore = fs.mkdtempSync(path.join(os.tmpdir(), "sonata-slash-linkstore-"));

// Claude skill whose <name>/ directory is a symlink into the store.
writeSkill(linkStore, "linked-skill", ["name: linked-skill", "description: Reached through a symlink"]);
fs.symlinkSync(path.join(linkStore, "linked-skill"), path.join(claudeSkillsRoot, "linked-skill"), "dir");
// Legacy .claude/commands/*.md that is itself a symlinked file.
const linkedCommandTarget = path.join(linkStore, "linked-command.md");
fs.writeFileSync(linkedCommandTarget, "---\ndescription: Linked legacy command\n---\n\nRun it.\n");
fs.symlinkSync(linkedCommandTarget, path.join(claudeCommandsRoot, "linked-command.md"), "file");
// A broken symlink must be skipped, never thrown.
fs.symlinkSync(path.join(linkStore, "missing-target"), path.join(claudeSkillsRoot, "broken-link"), "dir");

clearSlashCommandCache();
const claudeLinked = listSlashCommands("claude", projectRoot);
const claudeLinkedByName = new Map(claudeLinked.entries.map((entry) => [entry.name, entry]));
assert.equal(
  claudeLinkedByName.get("linked-skill")?.description,
  "Reached through a symlink",
  "symlinked skill directory is followed",
);
assert.equal(claudeLinkedByName.get("linked-skill")?.invocation, "/linked-skill");
assert.equal(
  claudeLinkedByName.get("linked-command")?.description,
  "Linked legacy command",
  "symlinked legacy command file is followed",
);
assert.equal(claudeLinkedByName.has("broken-link"), false, "broken symlink is skipped, not thrown");

// Codex: a $CODEX_HOME/skills entry reached through a symlink.
writeSkill(linkStore, "codex-linked", ["name: codex-linked", "description: Codex via symlink"]);
fs.symlinkSync(
  path.join(linkStore, "codex-linked"),
  path.join(fixtureHome, ".codex", "skills", "codex-linked"),
  "dir",
);
clearSlashCommandCache();
const codexLinked = listSlashCommands("codex", projectRoot);
const codexLinkedByName = new Map(codexLinked.entries.map((entry) => [entry.name, entry]));
assert.equal(
  codexLinkedByName.get("codex-linked")?.invocation,
  "$codex-linked",
  "symlinked codex skill is followed",
);

fs.rmSync(fixtureHome, { recursive: true, force: true });
fs.rmSync(projectRoot, { recursive: true, force: true });
fs.rmSync(linkStore, { recursive: true, force: true });
console.log("slash-registry smoke: all assertions passed (incl. symlink discovery)");
