// CLI readiness S3 — last-used provider, end to end.
//
// The "default provider" SETTING is gone; a new chat opens on the provider the
// last session actually started on (D5/L3). Four things have to hold together,
// and each fails silently on its own:
//
//   A. the L4 migration — an existing install's `defaultProvider` becomes the
//      initial `lastUsedProvider`, so nobody's preselection changes on upgrade;
//   B. the record's write semantics (`SonataSettingsStore.noteProviderUsed`);
//   C. the draft seed — last-used, else the sole usable CLI, else Claude — and
//      the seed NEVER records itself;
//   D. the write SITE: a real session start records; nothing else does.
//
// D drives the REAL RuntimeController against fake `claude`/`codex` scripts on
// PATH (the codex-approval-injection harness), because "we forgot to call it" is
// invisible to every unit assertion above it — and so is the opposite mistake,
// a reopen of an old chat silently redirecting the next new chat.

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "sonata-last-used-provider-"));
// Isolate every Sonata-owned path AND the two CLI profile homes — this smoke
// spawns real (fake) ptys, and the Claude spawn's trust pre-write reads
// ~/.claude.json, so HOME points at temp too.
process.env.SONATA_DATA_DIR = path.join(tempRoot, "sonata-data");
process.env.CODEX_HOME = path.join(tempRoot, "codex-home");
process.env.HOME = path.join(tempRoot, "home");
fs.mkdirSync(process.env.HOME, { recursive: true });

const binDir = path.join(tempRoot, "bin");
fs.mkdirSync(binDir, { recursive: true });
for (const cli of ["claude", "codex"]) {
  const fake = path.join(binDir, cli);
  fs.writeFileSync(fake, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  fs.chmodSync(fake, 0o755);
}
process.env.PATH = `${binDir}${path.delimiter}${process.env.PATH ?? ""}`;

const workspace = path.join(tempRoot, "workspace");
fs.mkdirSync(workspace, { recursive: true });

const {
  DEFAULT_SONATA_SETTINGS,
  normalizeSonataSettings,
} = require("../../dist/shared/types/sonata-settings");
const {
  UNKNOWN_CLI_READINESS_FACTS,
  soleHealthyCliProvider,
} = require("../../dist/shared/types/cli-readiness");
const { SonataSettingsStore } = require("../../dist/main/settings-store");
const { createInitialState } = require("../../dist/reading-core/state");
const session = require("../../dist/reading-core/transitions/session");

const results = {};

// ── A. The record's shape and the L4 migration ─────────────────────────────
{
  assert.deepEqual(
    DEFAULT_SONATA_SETTINGS,
    { lastUsedProvider: null },
    "the absent state is ABSENT, not a pre-declared claude",
  );
  assert.deepEqual(normalizeSonataSettings(null), { lastUsedProvider: null }, "unreadable → absent");
  assert.deepEqual(normalizeSonataSettings({}), { lastUsedProvider: null }, "empty → absent");
  assert.deepEqual(
    normalizeSonataSettings({ lastUsedProvider: "codex" }),
    { lastUsedProvider: "codex" },
    "a stored record survives",
  );
  assert.deepEqual(
    normalizeSonataSettings({ lastUsedProvider: "gemini" }),
    { lastUsedProvider: null },
    "an unknown provider is not a record",
  );

  // THE migration (L4). Woody's machine holds `defaultProvider: "claude"`; every
  // existing install holds one of these two, and its preselection must not move.
  for (const provider of ["claude", "codex"]) {
    assert.deepEqual(
      normalizeSonataSettings({ defaultProvider: provider }),
      { lastUsedProvider: provider },
      `legacy defaultProvider:${provider} migrates to the same preselection`,
    );
  }
  // The retired key is DROPPED, not carried: the normalized shape has no room
  // for it, so the first write erases it from disk.
  assert.deepEqual(
    Object.keys(normalizeSonataSettings({ defaultProvider: "codex" })),
    ["lastUsedProvider"],
    "the migrated shape carries no legacy key",
  );
  // A half-migrated file (both keys). Precedence is by VALIDITY, not by presence:
  // the first key that holds a real provider wins. So a live key that survived
  // the migration wins outright, and a live key someone corrupted by hand falls
  // back to the still-valid retired one — last known good beats dropping to the
  // seed, which would silently move an install's preselection.
  assert.deepEqual(
    normalizeSonataSettings({ lastUsedProvider: "claude", defaultProvider: "codex" }),
    { lastUsedProvider: "claude" },
    "a valid live key wins over the retired one",
  );
  assert.deepEqual(
    normalizeSonataSettings({ lastUsedProvider: "gemini", defaultProvider: "codex" }),
    { lastUsedProvider: "codex" },
    "a corrupt live key falls back to the retired value, not to absent",
  );
  assert.deepEqual(
    normalizeSonataSettings({ lastUsedProvider: null, defaultProvider: "codex" }),
    { lastUsedProvider: "codex" },
    "…and so does an explicit null (the shape a hand-cleared record leaves)",
  );
  // Idempotent: normalizing a normalized value is a fixed point (the read path
  // runs on every read, and the write path normalizes again before writing).
  const once = normalizeSonataSettings({ defaultProvider: "codex" });
  assert.deepEqual(normalizeSonataSettings(once), once, "normalize is idempotent");
  results.migration = "defaultProvider → lastUsedProvider, legacy key dropped, idempotent";
}

// ── B. The store's write semantics ─────────────────────────────────────────
{
  const filePath = path.join(tempRoot, "store", "sonata-settings.json");
  const store = new SonataSettingsStore(filePath);

  assert.equal(store.read().lastUsedProvider, null, "no file → no record");
  assert.equal(fs.existsSync(filePath), false, "…and reading created nothing");

  store.noteProviderUsed("codex");
  assert.deepEqual(readJson(filePath), { lastUsedProvider: "codex" }, "recorded, and nothing else");

  store.noteProviderUsed("claude");
  assert.deepEqual(readJson(filePath), { lastUsedProvider: "claude" }, "a switch overwrites");

  // Unchanged is a NO-OP, not a rewrite: a run of sessions on one provider must
  // not touch the file per spawn. A sentinel key proves it — a real write would
  // normalize it away.
  writeJson(filePath, { lastUsedProvider: "claude", sentinel: 1 });
  store.noteProviderUsed("claude");
  assert.deepEqual(
    readJson(filePath),
    { lastUsedProvider: "claude", sentinel: 1 },
    "recording the same provider writes nothing at all",
  );

  // The legacy file, through the real store: read migrates, and the first
  // recording rewrites the file without the retired key.
  const legacyPath = path.join(tempRoot, "legacy", "sonata-settings.json");
  writeJson(legacyPath, { defaultProvider: "codex" });
  const legacyStore = new SonataSettingsStore(legacyPath);
  assert.equal(legacyStore.read().lastUsedProvider, "codex", "legacy file reads as codex");
  assert.deepEqual(readJson(legacyPath), { defaultProvider: "codex" }, "…without rewriting on read");
  legacyStore.noteProviderUsed("codex");
  assert.deepEqual(
    readJson(legacyPath),
    { defaultProvider: "codex" },
    "a recording that agrees with the migrated value leaves the legacy file alone",
  );
  legacyStore.noteProviderUsed("claude");
  assert.deepEqual(
    readJson(legacyPath),
    { lastUsedProvider: "claude" },
    "the first real recording drops the retired key",
  );
  results.store = "write on change only; legacy key erased on the first real write";
}

// ── C. The draft seed (reading-core, pure) ─────────────────────────────────
{
  // The fact helper the seed's second term reads. "Usable" is the NEGATION of
  // unhealthy, so `unknown` counts in (the permissive rule).
  const facts = (claude, codex) => ({ claude, codex });
  const present = { install: "present", auth: "signedIn" };
  const absent = { install: "absent", auth: "unknown" };
  const signedOut = { install: "present", auth: "signedOut" };
  const unknown = { install: "unknown", auth: "unknown" };

  assert.equal(soleHealthyCliProvider(UNKNOWN_CLI_READINESS_FACTS), null, "no facts single nobody out");
  assert.equal(soleHealthyCliProvider(facts(present, present)), null, "both usable → no tiebreak");
  assert.equal(soleHealthyCliProvider(facts(absent, absent)), null, "both broken → no tiebreak");
  assert.equal(soleHealthyCliProvider(facts(present, absent)), "claude", "sole usable: claude");
  assert.equal(soleHealthyCliProvider(facts(absent, present)), "codex", "sole usable: codex");
  assert.equal(
    soleHealthyCliProvider(facts(signedOut, present)),
    "codex",
    "signedOut is unhealthy too, so it does not compete",
  );
  assert.equal(
    soleHealthyCliProvider(facts(unknown, absent)),
    "claude",
    "unknown counts as usable — a CLI we could not read is not a CLI we rule out",
  );

  // The seed itself, through both real entry points (boot hydration and every
  // new-chat reset go through seedTaskDraftFromLaunchDefaults).
  const seeded = (lastUsed, cliReadiness, reset = false) => {
    const state = createInitialState({ theme: "paper", mode: "system", textStep: 0 });
    state.lastUsedProvider = lastUsed;
    state.cliReadiness = cliReadiness;
    // A leftover from the previous draft, so a passing assertion can only come
    // from the seed and never from the initial value.
    state.taskDraft.provider = "codex";
    if (reset) {
      session.resetTaskDraftForNewChat(state);
    } else {
      session.seedTaskDraftFromLaunchDefaults(state);
    }
    return state;
  };

  assert.equal(
    seeded("claude", facts(absent, present)).taskDraft.provider,
    "claude",
    "the record wins over the facts — an unhealthy last-used provider is still preselected (D6)",
  );
  assert.equal(
    seeded(null, facts(absent, present)).taskDraft.provider,
    "codex",
    "no record → the sole usable CLI",
  );
  assert.equal(
    seeded(null, facts(present, present)).taskDraft.provider,
    "claude",
    "no record, both usable → Claude",
  );
  assert.equal(
    seeded(null, facts(absent, absent)).taskDraft.provider,
    "claude",
    "no record, nothing usable → Claude (the status card carries the truth)",
  );
  assert.equal(
    seeded(null, UNKNOWN_CLI_READINESS_FACTS).taskDraft.provider,
    "claude",
    "no record, no facts yet → Claude",
  );
  assert.equal(
    seeded(null, facts(absent, present), true).taskDraft.provider,
    "codex",
    "the new-chat reset seeds by the same rule",
  );

  // THE anti-stickiness property: seeding a provider is not learning one. If the
  // seed wrote its own guess back, a codex-only machine would inherit a
  // permanent "claude" from the one launch where the probe had not landed yet.
  const seedOnly = seeded(null, facts(absent, present));
  assert.equal(seedOnly.lastUsedProvider, null, "the seed does not record itself");
  results.seed = "record ?? sole-usable ?? claude; never recorded";
}

// ── D. The write site: a real session start, and nothing else ──────────────
{
  const { RuntimeController } = require("../../dist/main/runtime-controller");
  const { INERT_CODEX_SPAWN_GATE } = require("../../dist/main/cli-updater/cli-updater");
  const { INERT_CLI_READINESS_SOURCE } = require("../../dist/main/cli-readiness/session-start-diagnosis");
  const { ProjectsStore } = require("../../dist/main/projects-store");
  const {
    ResumeSettingsStore,
    ClaudeSettingsStore,
    CodexSettingsStore,
  } = require("../../dist/main/settings-store");

  const root = path.join(tempRoot, "controller");
  fs.mkdirSync(root, { recursive: true });
  const sonataPath = path.join(root, "sonata-settings.json");
  const controller = new RuntimeController({
    sendEvent: () => {},
    projectsStore: new ProjectsStore(path.join(root, "projects.json")),
    resumeSettingsStore: new ResumeSettingsStore(path.join(root, "resume-settings.json")),
    claudeSettingsStore: new ClaudeSettingsStore(path.join(root, "claude-settings.json")),
    codexSettingsStore: new CodexSettingsStore(path.join(root, "codex-settings.json")),
    sonataSettingsStore: new SonataSettingsStore(sonataPath),
    cliUpdater: INERT_CODEX_SPAWN_GATE,
    cliReadiness: INERT_CLI_READINESS_SOURCE,
  });

  try {
    assert.equal(fs.existsSync(sonataPath), false, "a fresh controller has recorded nothing");

    const codexTask = await controller.createTask({ provider: "codex", cwd: workspace });
    assert.deepEqual(
      readJson(sonataPath),
      { lastUsedProvider: "codex" },
      "starting a Codex session records Codex",
    );

    await controller.createTask({ provider: "claude", cwd: workspace });
    assert.deepEqual(
      readJson(sonataPath),
      { lastUsedProvider: "claude" },
      "starting a Claude session records Claude",
    );

    // Same provider again → no write (the store's no-op, reached through the
    // controller). The sentinel survives only if nothing wrote.
    writeJson(sonataPath, { lastUsedProvider: "claude", sentinel: 1 });
    await controller.createTask({ provider: "claude", cwd: workspace });
    assert.deepEqual(
      readJson(sonataPath),
      { lastUsedProvider: "claude", sentinel: 1 },
      "a second Claude session rewrites nothing",
    );

    // Reopening an OLD chat is not a provider choice — its provider is a
    // property of the record. Reading yesterday's Codex thread must not
    // redirect the next new chat, exactly as it does not move the last-used
    // FOLDER (noteFolderUsed lives in createTask only, for the same reason).
    controller.closeTask(codexTask.task.id);
    await controller.openTask({ taskId: codexTask.task.id, resume: false });
    assert.deepEqual(
      readJson(sonataPath),
      { lastUsedProvider: "claude", sentinel: 1 },
      "reopening a dormant Codex session records nothing",
    );

    // The upgrade path, through the controller's own read: a legacy file reads
    // migrated, and the next session start rewrites it clean.
    writeJson(sonataPath, { defaultProvider: "codex" });
    assert.deepEqual(
      controller.readSonataSettings(),
      { lastUsedProvider: "codex" },
      "the controller's read migrates a legacy file",
    );
    await controller.createTask({ provider: "claude", cwd: workspace });
    assert.deepEqual(
      readJson(sonataPath),
      { lastUsedProvider: "claude" },
      "the next session start rewrites it without the retired key",
    );
    results.writeSite = "createTask records; a second same-provider start and a reopen do not";
  } finally {
    controller.dispose();
  }
}

fs.rmSync(tempRoot, { recursive: true, force: true });
console.log(JSON.stringify({ success: true, results }, null, 2));

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}
