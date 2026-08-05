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
const { migrateCodexPermissionMode, codexPermissionModeFromTurnContext } = require(
  "../../dist/shared/types/codex-settings",
);
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
// The rollout turn_context reconcile (mid-session switch S5) must NOT reuse the
// manifest reverse-map above: turn_context carries (sandbox_policy.type,
// approval_policy) but NOT the reviewer axis that separates ask-for-approval from
// approve-for-me — they SHARE the (workspace-write, on-request) projection. So the
// reconcile map returns a mode ONLY on a UNIQUE projection (full-access), else
// null → the caller keeps the current mirror. Round-trip the whole triad + the
// review's staleness cases. `reconcile` mimics the controller's `mapped ?? current`
// so the "survives" assertions read as the real reconcile behavior.
const reconcile = (current, sandbox, approval) =>
  codexPermissionModeFromTurnContext(sandbox, approval) ?? current;

// full-access has a UNIQUE projection → reconciles (native upgrade lands it).
assert(
  codexPermissionModeFromTurnContext("danger-full-access", "never") === "full-access",
  "turn_context (danger-full-access, never) → full-access (the one unique projection)",
);
assert(
  reconcile("ask-for-approval", "danger-full-access", "never") === "full-access",
  "native UPGRADE to full-access reconciles the mirror",
);

// The shared ask/approve projection NEVER overwrites — the receipt-set mirror
// survives either way (this is the F1 corruption the fix closes).
assert(
  codexPermissionModeFromTurnContext("workspace-write", "on-request") === null,
  "turn_context (workspace-write, on-request) → null (ambiguous: ask|approve)",
);
assert(
  reconcile("approve-for-me", "workspace-write", "on-request") === "approve-for-me",
  "approve-for-me mirror SURVIVES an observed (workspace-write, on-request) — no corruption",
);
assert(
  reconcile("ask-for-approval", "workspace-write", "on-request") === "ask-for-approval",
  "ask-for-approval mirror SURVIVES the same shared projection",
);

// Native DOWNGRADE out of full-access lands on the ambiguous pair → mirror keeps
// full-access (accepted residual staleness — the rollout can't say ask vs approve,
// so we decline rather than guess; documented in plan S5(ii) + coupling inventory).
assert(
  reconcile("full-access", "workspace-write", "on-request") === "full-access",
  "native downgrade from full-access keeps the stale full-access mirror (residual staleness)",
);

// A non-representable pair (e.g. a native read-only sandbox on a Sonata session)
// also keeps the current mirror — never advertise a mode from unmapped state (F2).
assert(
  codexPermissionModeFromTurnContext("read-only", "on-request") === null,
  "turn_context (read-only, on-request) → null (non-representable)",
);
assert(
  reconcile("approve-for-me", "read-only", "on-request") === "approve-for-me",
  "a non-representable (read-only, on-request) keeps the current mirror (F2)",
);
assert(
  codexPermissionModeFromTurnContext(null, null) === null,
  "turn_context with no axes → null (keep current)",
);

// ---- B. Seam: RuntimeController manifest-read migration -------------------

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "sonata-codex-migration-"));
process.env.SONATA_DATA_DIR = path.join(tempRoot, "sonata-data");

const { projectRecordRoot } = require("../../dist/main/sonata-paths");
const { RuntimeController } = require("../../dist/main/runtime-controller");
// A bare controller has no Codex auto-updater: it never suppresses codex's own
// boot prompt, never waits on an update, never schedules a cycle.
const { INERT_CODEX_SPAWN_GATE } = require("../../dist/main/cli-updater/cli-updater");
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
