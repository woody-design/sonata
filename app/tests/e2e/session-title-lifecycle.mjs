// Restart/reopen title-ownership fence. Electron-as-Node loads the real main
// controller, starts a complete runtime through openTask with a deterministic
// fake provider, routes usage/run events through handleRuntimeEvent, and feeds
// the emitted event stream into the real renderer reducer.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "sonata-session-title-lifecycle-"));
const fakeBin = path.join(tempRoot, "bin");
fs.mkdirSync(fakeBin, { recursive: true });
installFakeClaude();
process.env.PATH = `${fakeBin}${path.delimiter}${process.env.PATH ?? ""}`;
process.env.SONATA_DATA_DIR = path.join(tempRoot, "sonata-data");
const require = createRequire(import.meta.url);
const { RuntimeController } = require("../../dist/main/runtime-controller");
const { ProjectsStore } = require("../../dist/main/projects-store");
const {
  ResumeSettingsStore,
  ClaudeSettingsStore,
  CodexSettingsStore,
  SonataSettingsStore,
} = require("../../dist/main/settings-store");
const { projectRecordRoot } = require("../../dist/main/sonata-paths");
const { freshTaskManifestV1 } = require("../../dist/shared/schemas/task-manifest");
const reducer = require("../../dist/reading-core/runtime-reducer");
const readingState = require("../../dist/reading-core/state");

const settingsRoot = path.join(tempRoot, "settings");
const workspace = path.join(tempRoot, "workspace");
fs.mkdirSync(workspace, { recursive: true });
const controllers = [];

function controllerHarness() {
  const events = [];
  let renderer = null;
  const controller = new RuntimeController({
    sendEvent: (event) => {
      events.push(event);
      if (renderer) {
        reducer.reduceRuntimeEvent(renderer.state, event, Date.parse(event.ts));
      }
    },
    projectsStore: new ProjectsStore(path.join(settingsRoot, "projects.json")),
    resumeSettingsStore: new ResumeSettingsStore(path.join(settingsRoot, "resume.json")),
    claudeSettingsStore: new ClaudeSettingsStore(path.join(settingsRoot, "claude.json")),
    codexSettingsStore: new CodexSettingsStore(path.join(settingsRoot, "codex.json")),
    sonataSettingsStore: new SonataSettingsStore(path.join(settingsRoot, "sonata.json")),
  });
  controllers.push(controller);
  return {
    controller,
    events,
    attachRenderer(value) {
      const state = readingState.createInitialState({ theme: "paper", mode: "system", textStep: 0 });
      const view = readingState.createTaskView(value, "Ready");
      readingState.upsertTaskView(state, view);
      state.activeTaskId = value.id;
      renderer = { state, view };
      return view;
    },
  };
}

function task(id, title, titleOrigin) {
  const result = {
    id,
    title,
    provider: "claude",
    model: null,
    reasoningEffort: null,
    speedMode: null,
    sandbox: null,
    approval: null,
    permissionMode: null,
    runtimeSessionId: `runtime-${id}`,
    providerSessionRef: null,
    providerCwd: workspace,
    workingDirectory: workspace,
    status: "idle",
    createdAt: "2026-07-14T13:00:00.000Z",
    updatedAt: "2026-07-14T13:00:00.000Z",
  };
  if (titleOrigin !== undefined) {
    result.titleOrigin = titleOrigin;
  }
  return result;
}

function writeTask(value) {
  const storageRoot = projectRecordRoot(value.id);
  fs.mkdirSync(storageRoot, { recursive: true });
  fs.writeFileSync(
    path.join(storageRoot, "task.json"),
    `${JSON.stringify(freshTaskManifestV1(value), null, 2)}\n`,
  );
  return storageRoot;
}

function readTask(storageRoot) {
  return JSON.parse(fs.readFileSync(path.join(storageRoot, "task.json"), "utf8")).task;
}

function reopen(harness, taskId) {
  const response = harness.controller.openTask({ taskId, resume: false });
  const view = harness.attachRenderer(response.task);
  const active = harness.controller.taskRuntimes.get(taskId);
  assert.ok(active?.runIndex, "openTask installed a complete runtime and RunIndex");
  return { response, view, active };
}

function routeProviderName(harness, active, taskId, sessionName) {
  harness.controller.handleRuntimeEvent(
    {
      type: "usage:updated",
      payload: {
        taskId,
        snapshot: {
          provider: "claude",
          capturedAt: Date.now(),
          context: null,
          limits: [],
          sessionName,
        },
      },
      ts: new Date().toISOString(),
    },
    active.runIndex,
  );
}

let runCounter = 0;
function routeRunStart(harness, active, taskId, title) {
  runCounter += 1;
  const ts = new Date(Date.now() + runCounter).toISOString();
  harness.controller.handleRuntimeEvent(
    {
      type: "run:started",
      payload: {
        id: `run-${taskId}-${runCounter}`,
        taskId,
        kind: "prompt",
        prompt: title,
        title,
        status: "active",
        startedAt: ts,
        endedAt: null,
        elapsedMs: null,
        completion: null,
        approvalIds: [],
        changedFilePaths: [],
        rawTerminalPointer: null,
      },
      ts,
    },
    active.runIndex,
  );
}

try {
  // 1) A real dormant rename persists ownership. A new controller then reopens
  // the task through openTask; provider and run events traverse the real router
  // but cannot overwrite either main manifest or renderer state.
  const automatic = task("manual-survives-restart", "0714-Initial", "automatic");
  const manualRoot = writeTask(automatic);
  const beforeRestart = controllerHarness();
  const renamed = beforeRestart.controller.renameSession(automatic.id, " 0714-New task ").task;
  assert.deepEqual([renamed.title, renamed.titleOrigin], ["0714-New task", "user"]);

  const afterRestart = controllerHarness();
  const manualOpen = reopen(afterRestart, automatic.id);
  assert.deepEqual(
    [manualOpen.response.task.title, manualOpen.response.task.titleOrigin],
    ["0714-New task", "user"],
    "openTask preserves persisted user ownership",
  );
  routeProviderName(afterRestart, manualOpen.active, automatic.id, "Provider overwrite");
  routeRunStart(afterRestart, manualOpen.active, automatic.id, "Run overwrite");
  assert.deepEqual(
    [readTask(manualRoot).title, readTask(manualRoot).titleOrigin],
    ["0714-New task", "user"],
    "routed automatic candidates cannot overwrite the reopened manifest",
  );
  assert.deepEqual(
    [manualOpen.view.task.title, manualOpen.view.task.titleOrigin],
    ["0714-New task", "user"],
    "main event stream and renderer reducer preserve the same ownership",
  );

  // Prefix removal follows the same real lifecycle, then survives archival.
  // This is deliberately not a seeded user-owned fixture: it proves the public
  // rename operation establishes ownership for an unprefixed value.
  const prefixRemoved = task("manual-prefix-removal", "0714-Initial", "automatic");
  const prefixRemovedRoot = writeTask(prefixRemoved);
  const beforePrefixRemovalRestart = controllerHarness();
  const prefixRemovalRename = beforePrefixRemovalRestart.controller.renameSession(
    prefixRemoved.id,
    "  Research without prefix  ",
  ).task;
  assert.deepEqual(
    [prefixRemovalRename.title, prefixRemovalRename.titleOrigin],
    ["Research without prefix", "user"],
    "manual rename may remove the complete creation prefix",
  );
  const afterPrefixRemovalRestart = controllerHarness();
  const prefixRemovalOpen = reopen(afterPrefixRemovalRestart, prefixRemoved.id);
  routeProviderName(
    afterPrefixRemovalRestart,
    prefixRemovalOpen.active,
    prefixRemoved.id,
    "Provider overwrite",
  );
  routeRunStart(
    afterPrefixRemovalRestart,
    prefixRemovalOpen.active,
    prefixRemoved.id,
    "Run overwrite",
  );
  assert.deepEqual(
    [readTask(prefixRemovedRoot).title, readTask(prefixRemovedRoot).titleOrigin],
    ["Research without prefix", "user"],
    "prefix removal survives restart and later automatic candidates",
  );
  assert.deepEqual(
    [prefixRemovalOpen.view.task.title, prefixRemovalOpen.view.task.titleOrigin],
    ["Research without prefix", "user"],
    "renderer preserves the restarted unprefixed user title",
  );
  afterPrefixRemovalRestart.controller.archiveSession(prefixRemoved.id, true);
  assert.deepEqual(
    [
      readTask(prefixRemovedRoot).title,
      readTask(prefixRemovedRoot).titleOrigin,
      readTask(prefixRemovedRoot).archived,
    ],
    ["Research without prefix", "user", true],
    "archive preserves the renamed title and ownership",
  );

  // 2) Persisted automatic ownership intentionally survives reopen: provider
  // naming may improve it, preserves the original date, and task:updated drives
  // the renderer to the same canonical value. The reopen running transition may
  // update activity; the provider metadata update itself must not.
  const providerAutomatic = task("automatic-after-restart", "0714-First prompt", "automatic");
  const automaticRoot = writeTask(providerAutomatic);
  const providerRestart = controllerHarness();
  const providerOpen = reopen(providerRestart, providerAutomatic.id);
  const activityBeforeProvider = readTask(automaticRoot).updatedAt;
  routeProviderName(
    providerRestart,
    providerOpen.active,
    providerAutomatic.id,
    "Provider title after midnight",
  );
  const improved = readTask(automaticRoot);
  assert.deepEqual(
    [improved.title, improved.titleOrigin],
    ["0714-Provider title after midnight", "automatic"],
  );
  assert.equal(improved.updatedAt, activityBeforeProvider, "provider naming is not activity");
  assert.equal(providerOpen.view.task.title, improved.title, "task:updated converges renderer");

  // 3) Priority is monotonic through the real event router: provider-first is
  // never downgraded by a later prompt, and first-prompt→provider is never
  // downgraded by a second prompt.
  const providerFirst = task("provider-before-run", "0714-New task", "automatic");
  const providerFirstRoot = writeTask(providerFirst);
  const providerFirstHarness = controllerHarness();
  const providerFirstOpen = reopen(providerFirstHarness, providerFirst.id);
  routeProviderName(providerFirstHarness, providerFirstOpen.active, providerFirst.id, "Native first");
  routeRunStart(providerFirstHarness, providerFirstOpen.active, providerFirst.id, "Later prompt");
  assert.equal(readTask(providerFirstRoot).title, "0714-Native first");
  assert.equal(providerFirstOpen.view.task.title, "0714-Native first");

  const promptFirst = task("prompt-provider-second-prompt", "0714-New task", "automatic");
  const promptFirstRoot = writeTask(promptFirst);
  const promptFirstHarness = controllerHarness();
  const promptFirstOpen = reopen(promptFirstHarness, promptFirst.id);
  routeRunStart(promptFirstHarness, promptFirstOpen.active, promptFirst.id, "First prompt");
  routeProviderName(promptFirstHarness, promptFirstOpen.active, promptFirst.id, "Native title");
  routeRunStart(promptFirstHarness, promptFirstOpen.active, promptFirst.id, "Second prompt");
  assert.equal(readTask(promptFirstRoot).title, "0714-Native title");
  assert.equal(promptFirstOpen.view.task.title, "0714-Native title");

  // 4) Merely indexing legacy/malformed records never rewrites them. A malformed
  // automatic record also fails closed when reopened and offered a provider name.
  const legacy = task("legacy-index-read", "New Task", undefined);
  const legacyRoot = writeTask(legacy);
  const legacyPath = path.join(legacyRoot, "task.json");
  const legacyBytes = fs.readFileSync(legacyPath, "utf8");
  const legacyHarness = controllerHarness();
  const index = legacyHarness.controller.readSessionIndex({ includeArchived: true });
  const indexedLegacy = [...index.projects.flatMap((project) => project.sessions), ...index.chats]
    .find((session) => session.task.id === legacy.id)?.task;
  assert.equal(indexedLegacy?.title, "New Task");
  assert.equal(indexedLegacy?.titleOrigin, undefined);
  assert.equal(fs.readFileSync(legacyPath, "utf8"), legacyBytes, "index read does not rewrite legacy");

  const malformed = task("malformed-automatic", "Quarterly plan", "automatic");
  const malformedRoot = writeTask(malformed);
  const malformedHarness = controllerHarness();
  const malformedOpen = reopen(malformedHarness, malformed.id);
  routeProviderName(malformedHarness, malformedOpen.active, malformed.id, "Provider overwrite");
  assert.equal(readTask(malformedRoot).title, "Quarterly plan", "malformed automatic state fails closed");
  assert.equal(malformedOpen.view.task.title, "Quarterly plan");

  // 5) One disk-backed mixed index keeps every ownership/presentation class
  // distinct: legacy, new automatic, user-renamed (including prefix removal),
  // chosen-project, project-less, live, and archived. This is the migration
  // fence: indexing may project those records, never normalize them into one
  // naming generation.
  const projectless = {
    ...task("projectless-automatic", "0714-Loose research", "automatic"),
    autoWorkspace: true,
  };
  writeTask(projectless);
  new ProjectsStore(path.join(settingsRoot, "projects.json")).setDisplayName(
    workspace,
    "Chosen Project",
  );

  const mixedDefault = providerRestart.controller.readSessionIndex();
  const mixed = providerRestart.controller.readSessionIndex({ includeArchived: true });
  const everySummary = [
    ...mixed.projects.flatMap((project) => project.sessions),
    ...mixed.chats,
  ];
  const summary = (id) => everySummary.find((entry) => entry.task.id === id);
  assert.equal(
    mixed.projects.find((project) => project.path === workspace)?.name,
    "Chosen Project",
    "chosen-folder display identity is independent of title generation",
  );
  assert.deepEqual(
    [summary(legacy.id)?.task.title, summary(legacy.id)?.task.titleOrigin],
    ["New Task", undefined],
    "legacy record remains unowned and undated inside a mixed index",
  );
  assert.deepEqual(
    [summary(providerAutomatic.id)?.task.title, summary(providerAutomatic.id)?.task.titleOrigin],
    ["0714-Provider title after midnight", "automatic"],
    "live automatic record retains its canonical creation prefix",
  );
  assert.equal(summary(providerAutomatic.id)?.live, true, "mixed fixture includes a live session");
  assert.deepEqual(
    [summary(automatic.id)?.task.title, summary(automatic.id)?.task.titleOrigin],
    ["0714-New task", "user"],
    "manual automatic-looking title remains user-owned",
  );
  assert.deepEqual(
    [summary(projectless.id)?.task.title, summary(projectless.id)?.task.titleOrigin],
    ["0714-Loose research", "automatic"],
    "project-less automatic title remains canonical",
  );
  assert.equal(
    mixed.chats.some((entry) => entry.task.id === projectless.id),
    true,
    "auto workspace projects into Tasks rather than a chosen project",
  );
  assert.deepEqual(
    [summary(prefixRemoved.id)?.task.title, summary(prefixRemoved.id)?.task.titleOrigin],
    ["Research without prefix", "user"],
    "real manual prefix removal remains canonical after archive",
  );
  assert.equal(summary(prefixRemoved.id)?.archived, true, "mixed fixture includes archive state");
  assert.equal(
    [
      ...mixedDefault.projects.flatMap((project) => project.sessions),
      ...mixedDefault.chats,
    ].some((entry) => entry.task.id === prefixRemoved.id),
    false,
    "default index filtering hides archived without rewriting its title",
  );

  console.log(
    "session-title-lifecycle: reopen/runtime/renderer priority and mixed-index ownership pass",
  );
} finally {
  for (const controller of controllers) {
    controller.dispose();
  }
  fs.rmSync(tempRoot, { recursive: true, force: true, maxRetries: 5 });
}

function installFakeClaude() {
  const filePath = path.join(fakeBin, "claude");
  fs.writeFileSync(
    filePath,
    `#!/usr/bin/env node
if (process.stdin.isTTY) { try { process.stdin.setRawMode(true); } catch {} }
process.stdin.resume();
process.stdout.write("Fake Claude ready\\n❯ \\n");
setInterval(() => {}, 1 << 30);
`,
    { mode: 0o755 },
  );
  fs.chmodSync(filePath, 0o755);
}
