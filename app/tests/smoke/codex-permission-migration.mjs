// Layer-1 fence — the Codex permission MIGRATION seam. Two layers:
//
//  A. Unit: migrateCodexPermissionMode (the pure record→mode mapper) — legacy
//     (sandbox, approval) priority order (danger-full-access beats never), the
//     Claude-null invariant (a Claude manifest that persisted explicit
//     sandbox/approval nulls carries NO Codex mode — verified against real
//     ~/.sonata manifests), and passthrough of an already-migrated value.
//
//  B. Seam: the real RuntimeController's manifest-read migration. A legacy
//     manifest written to disk, read + re-persisted through archiveSession
//     (the spawn-free dormant path: requirePersistedSession → readTaskManifest →
//     migrateTaskPermissionRecord → persistTaskManifest), must (1) resolve the
//     right mode, (2) leave a Claude task's Codex mode null, and (3) STRIP the
//     legacy sandbox/approval keys so they never persist forward.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const {
  CODEX_PERMISSION_MODE_OPTIONS,
  codexPermissionModeFromTurnContext,
  isCodexOfferedPermissionMode,
  isCodexPermissionMode,
  migrateCodexPermissionMode,
  normalizeCodexSettings,
} = require("../../dist/shared/types/codex-settings");
const { freshTaskManifestV1 } = require("../../dist/shared/schemas");

const failures = [];
const assert = (cond, label) => {
  if (!cond) failures.push(label);
};

// ---- A. Unit: migrateCodexPermissionMode ---------------------------------

// Legacy pairs, never escalating; danger-full-access wins over a `never`
// approval (priority order).
assert(
  migrateCodexPermissionMode({ provider: "codex", sandbox: "danger-full-access", approval: "never" }) ===
    "full-access",
  "danger-full-access beats never → full-access",
);
assert(
  migrateCodexPermissionMode({ provider: "codex", sandbox: "read-only", approval: "never" }) ===
    "approve-for-me",
  "read-only + never → approve-for-me",
);
assert(
  migrateCodexPermissionMode({ provider: "codex", sandbox: "read-only", approval: "on-request" }) ===
    "ask-for-approval",
  "read-only + on-request → ask-for-approval",
);
assert(
  migrateCodexPermissionMode({ provider: "codex", sandbox: "workspace-write", approval: "on-failure" }) ===
    "ask-for-approval",
  "the retired on-failure → ask-for-approval (never a dead spawn)",
);
// An already-migrated record passes through unchanged.
assert(
  migrateCodexPermissionMode({ provider: "codex", codexPermissionMode: "full-access" }) === "full-access",
  "an explicit codexPermissionMode passes through",
);

// Claude-null invariant: a Claude manifest carries NO Codex mode. Real
// manifests persisted explicit null (not undefined) — both must resolve to null.
assert(
  migrateCodexPermissionMode({ provider: "claude", sandbox: null, approval: null }) === null,
  "Claude task with null/null axes → null (the invariant)",
);
assert(
  migrateCodexPermissionMode({ provider: "claude", permissionMode: "default" }) === null,
  "Claude task with no axis fields → null",
);
// Even absent a provider hint, an empty / no-axis record has no Codex mode.
assert(migrateCodexPermissionMode({}) === null, "empty record → null");
assert(
  migrateCodexPermissionMode({ sandbox: null, approval: null }) === null,
  "null/null with no provider → null",
);

// ---- A2. Unit: codexPermissionModeFromTurnContext (item E reconcile map) --
// The rollout turn_context reconcile must NOT reuse the manifest reverse-map
// above. It maps (sandbox_policy.type, approval_policy, approvals_reviewer) to
// the mode the turn ran under; the latest observation wins (Subtraction X1 fix
// round F1). `reconcile` mimics the controller's `mapped ?? current`. The
// measured payload shapes themselves are pinned in codex-permission-turn-context.
const reconcile = (current, sandbox, approval, reviewer = null) =>
  codexPermissionModeFromTurnContext(sandbox, approval, reviewer) ?? current;

assert(
  codexPermissionModeFromTurnContext("danger-full-access", "never", "user") === "full-access",
  "(danger-full-access, never) → full-access",
);
assert(
  codexPermissionModeFromTurnContext("workspace-write", "on-request", "auto_review") ===
    "approve-for-me",
  "(workspace-write, on-request, auto_review) → approve-for-me",
);
assert(
  codexPermissionModeFromTurnContext("workspace-write", "on-request", "user") === "ask-for-approval",
  "(workspace-write, on-request, user) → ask-for-approval",
);
assert(
  codexPermissionModeFromTurnContext("workspace-write", "on-request", null) === "ask-for-approval",
  "…and an ABSENT reviewer reads as ask-for-approval (the prompting mode)",
);
// The three formerly ACCEPTED residuals (2026-09-02, superseded) now reconcile.
assert(
  reconcile("ask-for-approval", "workspace-write", "on-request", "auto_review") === "approve-for-me" &&
    reconcile("approve-for-me", "workspace-write", "on-request", "user") === "ask-for-approval",
  "(a) ask ↔ approve switched in the Terminal reconciles both ways",
);
assert(
  reconcile("full-access", "workspace-write", "on-request", "user") === "ask-for-approval",
  "(b) a downgrade out of Full Access reconciles — a reopen can no longer re-grant it",
);
assert(
  reconcile("read-only", "workspace-write", "on-request", "auto_review") === "approve-for-me",
  "(c) a cycle out of Read Only reconciles",
);
// Read Only on the SANDBOX alone (MEASURED 0.152.1, SL-17 q35); the approval
// axis is the ask-frequency knob (SL-8/r4 corpus: never ×186, on-request ×61).
assert(
  codexPermissionModeFromTurnContext("read-only", "on-request", "user") === "read-only" &&
    codexPermissionModeFromTurnContext("read-only", "never", null) === "read-only" &&
    codexPermissionModeFromTurnContext("read-only", null, null) === "read-only",
  "a read-only sandbox reads as Read Only whatever the approval axis says",
);
assert(
  reconcile("approve-for-me", "read-only", "on-request", "user") === "read-only",
  "a cycle into Read Only moves the mirror",
);
// Unmeasured shapes and an unknown reviewer keep the current value — never a guess.
assert(
  codexPermissionModeFromTurnContext("workspace-write", "on-request", "some_future_reviewer") === null,
  "an unknown reviewer value → null (keep current)",
);
assert(
  codexPermissionModeFromTurnContext("workspace-write", "never", "user") === null &&
    codexPermissionModeFromTurnContext("danger-full-access", "on-request", "user") === null,
  "unmeasured sandbox/approval pairings → null (keep current)",
);
assert(
  codexPermissionModeFromTurnContext(null, null, null) === null,
  "turn_context with no axes → null (keep current)",
);
// The OFFERED/NAMEABLE split: `read-only` is a mode Sonata can mirror, never one
// it can launch into or store as a standing default.
assert(
  isCodexPermissionMode("read-only") && !isCodexOfferedPermissionMode("read-only"),
  "read-only is nameable but NOT offered (the mirror/launch split)",
);
for (const mode of CODEX_PERMISSION_MODE_OPTIONS) {
  assert(
    isCodexPermissionMode(mode) && isCodexOfferedPermissionMode(mode),
    `${mode} is both nameable and offered`,
  );
}
// A persisted mirror of the fourth mode must SURVIVE a manifest read. Reading it
// back through the offered guard would relabel a session that ran read-only as
// "Ask for approval" — claiming more access than it had.
assert(
  migrateCodexPermissionMode({ provider: "codex", codexPermissionMode: "read-only" }) ===
    "read-only",
  "a persisted read-only mirror round-trips through the manifest read",
);
// …while the standing LAUNCH default refuses it and falls back to codex's own
// default, because a default is a mode Sonata would have to spawn.
assert(
  normalizeCodexSettings({ defaultPermissionMode: "read-only" }).defaultPermissionMode ===
    "ask-for-approval",
  "read-only is refused as a standing launch default (offered guard)",
);

// ---- B. Seam: RuntimeController manifest-read migration -------------------

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "sonata-codex-migration-"));
process.env.SONATA_DATA_DIR = path.join(tempRoot, "sonata-data");

const { projectRecordRoot } = require("../../dist/main/sonata-paths");
const { RuntimeController } = require("../../dist/main/runtime-controller");
// A bare controller has no Codex auto-updater: it never suppresses codex's own
// boot prompt, never waits on an update, never schedules a cycle.
const { INERT_CODEX_SPAWN_GATE } = require("../../dist/main/cli-updater/cli-updater");
const { INERT_CLI_READINESS_SOURCE } = require("../../dist/main/cli-readiness/session-start-diagnosis");
const { ProjectsStore } = require("../../dist/main/projects-store");
const {
  ResumeSettingsStore,
  ClaudeSettingsStore,
  CodexSettingsStore,
  SonataSettingsStore,
} = require("../../dist/main/settings-store");

// Write a LEGACY manifest (old (sandbox, approval) pair, NO codexPermissionMode)
// straight to the record root archiveSession reads from.
function writeLegacyManifest(taskId, extra) {
  const root = projectRecordRoot(taskId);
  fs.mkdirSync(root, { recursive: true });
  const now = new Date().toISOString();
  const task = {
    id: taskId,
    title: taskId,
    provider: extra.provider,
    model: null,
    reasoningEffort: null,
    speedMode: null,
    // legacy axis fields (the shape this migration retires):
    sandbox: extra.sandbox,
    approval: extra.approval,
    permissionMode: extra.permissionMode ?? null,
    runtimeSessionId: `runtime-${taskId}`,
    providerSessionRef: null,
    providerCwd: root,
    workingDirectory: root,
    status: "idle",
    createdAt: now,
    updatedAt: now,
  };
  fs.writeFileSync(
    path.join(root, "task.json"),
    `${JSON.stringify(freshTaskManifestV1(task), null, 2)}\n`,
  );
  return root;
}

const codexFullId = "task-1000000000001-1"; // danger-full-access + never → full-access
const codexApproveId = "task-1000000000002-2"; // read-only + never → approve-for-me
const claudeId = "task-1000000000003-3"; // null/null → codex mode null

writeLegacyManifest(codexFullId, {
  provider: "codex",
  sandbox: "danger-full-access",
  approval: "never",
});
writeLegacyManifest(codexApproveId, {
  provider: "codex",
  sandbox: "read-only",
  approval: "never",
});
writeLegacyManifest(claudeId, {
  provider: "claude",
  sandbox: null,
  approval: null,
  permissionMode: "default",
});

const controller = new RuntimeController({
  sendEvent: () => {},
  projectsStore: new ProjectsStore(path.join(tempRoot, "projects.json")),
  resumeSettingsStore: new ResumeSettingsStore(path.join(tempRoot, "resume-settings.json")),
  claudeSettingsStore: new ClaudeSettingsStore(path.join(tempRoot, "claude-settings.json")),
  codexSettingsStore: new CodexSettingsStore(path.join(tempRoot, "codex-settings.json")),
  sonataSettingsStore: new SonataSettingsStore(path.join(tempRoot, "sonata-settings.json")),
  cliUpdater: INERT_CODEX_SPAWN_GATE,
  cliReadiness: INERT_CLI_READINESS_SOURCE,
});

const readPersistedTask = (taskId) =>
  JSON.parse(fs.readFileSync(path.join(projectRecordRoot(taskId), "task.json"), "utf8")).task;

let persisted = {};
try {
  // archiveSession reads the manifest through the migrating seam, then
  // re-persists — so the on-disk task.json is the migrated shape.
  for (const id of [codexFullId, codexApproveId, claudeId]) {
    controller.archiveSession(id, true);
    persisted[id] = readPersistedTask(id);
  }

  assert(
    persisted[codexFullId].codexPermissionMode === "full-access",
    "seam: danger-full-access + never → full-access",
  );
  assert(
    persisted[codexApproveId].codexPermissionMode === "approve-for-me",
    "seam: read-only + never → approve-for-me",
  );
  assert(
    persisted[claudeId].codexPermissionMode === null,
    "seam: Claude null/null → codexPermissionMode null (invariant holds through re-persist)",
  );

  // The retired axis keys are STRIPPED on every re-persist — never carried forward.
  for (const [id, task] of Object.entries(persisted)) {
    assert(!("sandbox" in task), `seam: ${id} re-persist drops the legacy 'sandbox' key`);
    assert(!("approval" in task), `seam: ${id} re-persist drops the legacy 'approval' key`);
    assert("codexPermissionMode" in task, `seam: ${id} re-persist carries codexPermissionMode`);
  }
} finally {
  controller.dispose();
  fs.rmSync(tempRoot, { recursive: true, force: true, maxRetries: 5 });
}

const success = failures.length === 0;
console.log(JSON.stringify({ success, failures, persisted }, null, 2));
process.exitCode = success ? 0 : 1;
