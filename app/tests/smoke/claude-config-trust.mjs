// Layer-1 smoke — the ~/.claude.json single write path (S4 trust pre-write).
// Everything runs against TEMP config files; the real ~/.claude.json is never
// touched. Locks the safety rules the primitive promises:
//   atomic + format-faithful (bytes outside the mutated key identical),
//   idempotent, merge-don't-clobber, backup-once (from the exact pre-write
//   bytes), never-create-the-file, realpath keying, conflict retry.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { ensureClaudeProjectTrust, updateClaudeConfig, claudeProjectKey } =
  require("../../dist/main/claude-config");

const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "sonata-claude-config-smoke-"));
const failures = [];
const assert = (cond, label) => {
  if (!cond) failures.push(label);
};

// A representative config: several top-level keys, a projects map with real
// shapes (incl. a previously-DECLINED entry), serialized exactly the way the
// CLI writes it (stringify(_, null, 2), no trailing newline).
function freshConfig(configPath) {
  const config = {
    installMethod: "brew",
    numStartups: 42,
    tipsHistory: { "shift-enter": 3 },
    projects: {
      "/Users/someone/existing": {
        allowedTools: ["Bash(ls *)"],
        hasTrustDialogAccepted: true,
        projectOnboardingSeenCount: 2,
      },
      "/Users/someone/declined": {
        allowedTools: [],
        hasTrustDialogAccepted: false,
      },
    },
    resumeReturnDismissed: true,
  };
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2), "utf8");
  return fs.readFileSync(configPath, "utf8");
}

// --- 1. adds the entry; every byte outside it unchanged ----------------------
{
  const configPath = path.join(workspace, "config-1.json");
  const before = freshConfig(configPath);
  const dir = fs.mkdtempSync(path.join(workspace, "picked-"));
  const result = ensureClaudeProjectTrust(dir, { configPath, backupPath: null });
  assert(result.applied && result.reason === "written", "1: entry written");
  assert(result.projectKey === claudeProjectKey(dir), "1: result reports the key");

  const after = fs.readFileSync(configPath, "utf8");
  const parsed = JSON.parse(after);
  assert(
    JSON.stringify(parsed.projects[result.projectKey]) ===
      JSON.stringify({ hasTrustDialogAccepted: true }),
    "1: minimal flag only (no onboarding companions)",
  );
  // Remove the added key and re-serialize: must reproduce the original bytes.
  delete parsed.projects[result.projectKey];
  assert(
    JSON.stringify(parsed, null, 2) === before,
    "1: bytes outside the added key are identical",
  );

  // --- 2. idempotent: second call is a no-op --------------------------------
  const again = ensureClaudeProjectTrust(dir, { configPath, backupPath: null });
  assert(!again.applied && again.reason === "no-change", "2: already-trusted no-ops");
  assert(fs.readFileSync(configPath, "utf8") === after, "2: no-op leaves bytes alone");
}

// --- 3. merge, don't clobber; a pick overrides a previous decline -----------
{
  const configPath = path.join(workspace, "config-3.json");
  freshConfig(configPath);
  const result = ensureClaudeProjectTrust("/Users/someone/declined", {
    configPath,
    backupPath: null,
  });
  // claudeProjectKey falls back to the resolved path for a dir that doesn't
  // exist locally — which is exactly the fixture key.
  assert(result.applied, "3: declined entry re-granted on a fresh pick");
  const entry = JSON.parse(fs.readFileSync(configPath, "utf8")).projects[
    "/Users/someone/declined"
  ];
  assert(entry.hasTrustDialogAccepted === true, "3: flag flipped true");
  assert(Array.isArray(entry.allowedTools), "3: sibling fields preserved");
}

// --- 4. missing config: never created ----------------------------------------
{
  const configPath = path.join(workspace, "config-4-missing.json");
  const result = ensureClaudeProjectTrust(workspace, { configPath, backupPath: null });
  assert(!result.applied && result.reason === "config-missing", "4: missing → no-op");
  assert(!fs.existsSync(configPath), "4: file not created");
}

// --- 5. unparseable config: untouched ----------------------------------------
{
  const configPath = path.join(workspace, "config-5.json");
  fs.writeFileSync(configPath, "{ not json", "utf8");
  const result = ensureClaudeProjectTrust(workspace, { configPath, backupPath: null });
  assert(!result.applied && result.reason === "config-invalid", "5: invalid → no-op");
  assert(fs.readFileSync(configPath, "utf8") === "{ not json", "5: bytes untouched");
}

// --- 6. backup-once, from the exact pre-write bytes ---------------------------
{
  const configPath = path.join(workspace, "config-6.json");
  const backupPath = path.join(workspace, "config-6.json.sonata-bak");
  const original = freshConfig(configPath);
  const dirA = fs.mkdtempSync(path.join(workspace, "bak-a-"));
  const dirB = fs.mkdtempSync(path.join(workspace, "bak-b-"));

  const first = ensureClaudeProjectTrust(dirA, { configPath, backupPath });
  assert(first.applied && first.backupCreated, "6: first write creates the backup");
  assert(fs.readFileSync(backupPath, "utf8") === original, "6: backup = pre-write bytes");

  const second = ensureClaudeProjectTrust(dirB, { configPath, backupPath });
  assert(second.applied && !second.backupCreated, "6: second write reuses the backup");
  assert(
    fs.readFileSync(backupPath, "utf8") === original,
    "6: backup still the OLDEST pre-Sonata bytes",
  );
}

// --- 7. realpath keying (symlinked pick) --------------------------------------
{
  const configPath = path.join(workspace, "config-7.json");
  freshConfig(configPath);
  const realDir = fs.mkdtempSync(path.join(workspace, "real-"));
  const linkPath = path.join(workspace, "link-to-real");
  fs.symlinkSync(realDir, linkPath);
  const result = ensureClaudeProjectTrust(linkPath, { configPath, backupPath: null });
  const realKey = fs.realpathSync.native
    ? fs.realpathSync.native(realDir)
    : fs.realpathSync(realDir);
  assert(result.projectKey === realKey, "7: key is the realpath, not the symlink");
  const projects = JSON.parse(fs.readFileSync(configPath, "utf8")).projects;
  assert(projects[realKey]?.hasTrustDialogAccepted === true, "7: realpath entry written");
  assert(!(linkPath in projects), "7: no symlink-keyed duplicate");
}

// --- 8. conflict retry: a concurrent writer wins, our edit lands on top,
//        and the backup captures the SURVIVING attempt's bytes ---------------
{
  const configPath = path.join(workspace, "config-8.json");
  const backupPath = path.join(workspace, "config-8.json.sonata-bak");
  freshConfig(configPath);
  let calls = 0;
  const result = updateClaudeConfig(
    (config) => {
      calls += 1;
      if (calls === 1) {
        // Simulate the CLI rewriting the file between our read and write.
        const concurrent = JSON.parse(fs.readFileSync(configPath, "utf8"));
        concurrent.numStartups = 43;
        fs.writeFileSync(configPath, JSON.stringify(concurrent, null, 2), "utf8");
      }
      config.sonataProbe = true;
      return true;
    },
    { configPath, backupPath },
  );
  assert(result.applied && calls === 2, "8: conflict retried from a fresh read");
  const parsed = JSON.parse(fs.readFileSync(configPath, "utf8"));
  assert(parsed.numStartups === 43, "8: the concurrent write survived");
  assert(parsed.sonataProbe === true, "8: our edit landed on top of it");
  // The recovery point must be the bytes the SURVIVING write was computed
  // from — i.e. include the concurrent change, not attempt 1's stale read
  // (review P2: a stale backup would lose the CLI's write on restore).
  const backup = JSON.parse(fs.readFileSync(backupPath, "utf8"));
  assert(backup.numStartups === 43, "8: backup holds the fresh (post-conflict) bytes");
  assert(!("sonataProbe" in backup), "8: backup is pre-write (no Sonata edit)");
  assert(result.backupCreated === true, "8: backupCreated reported on the surviving attempt");
}

// --- 9. the resume-bridge mutator shape (same primitive) ----------------------
{
  const configPath = path.join(workspace, "config-9.json");
  freshConfig(configPath);
  const revert = (opts) =>
    updateClaudeConfig((config) => {
      if (config.resumeReturnDismissed !== true) return false;
      delete config.resumeReturnDismissed;
      return true;
    }, opts);
  const first = revert({ configPath, backupPath: null });
  assert(first.applied, "9: bridge removed");
  assert(
    !("resumeReturnDismissed" in JSON.parse(fs.readFileSync(configPath, "utf8"))),
    "9: key gone",
  );
  const second = revert({ configPath, backupPath: null });
  assert(!second.applied && second.reason === "no-change", "9: absent bridge no-ops");
}

fs.rmSync(workspace, { recursive: true, force: true });

const success = failures.length === 0;
console.log(JSON.stringify({ success, failures }, null, 2));
process.exitCode = success ? 0 : 1;
