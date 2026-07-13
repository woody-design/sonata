import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TASK_MANIFEST_SCHEMA_ID = "duet.task-manifest.v1";
const RAW_TERMINAL_POLICY = "raw-terminal-not-persisted-by-default";

export const SIDEBAR_FIXED_NOW = "2030-01-15T17:00:00.000Z";
export const SIDEBAR_BOUNDARY_TOTALS = Object.freeze([0, 5, 6, 15, 16, 25, 26]);

// Activity order, display-name order, path order, and session-count order are
// deliberately uncorrelated. A renderer that accidentally re-sorts projects
// alphabetically or by size must not satisfy the canonical-order oracle.
export const DEFAULT_SIDEBAR_PROJECT_SPECS = Object.freeze([
  { slug: "mango-26", name: "Mango", count: 26 },
  { slug: "zulu-5", name: "Zulu", count: 5 },
  { slug: "alpha-16", name: "Alpha", count: 16 },
  { slug: "echo-6", name: "Echo", count: 6 },
  { slug: "bravo-25", name: "Bravo", count: 25 },
  { slug: "hotel-1", name: "Hotel", count: 1 },
  { slug: "delta-15", name: "Delta", count: 15 },
  { slug: "kilo-1", name: "Kilo", count: 1 },
  { slug: "cedar-1", name: "Cedar", count: 1 },
  { slug: "quartz-1", name: "Quartz", count: 1 },
  { slug: "birch-1", name: "Birch", count: 1 },
  { slug: "tango-1", name: "Tango", count: 1 },
  { slug: "fox-1", name: "Fox", count: 1 },
  { slug: "indigo-1", name: "Indigo", count: 1 },
  { slug: "lima-1", name: "Lima", count: 1 },
  { slug: "gamma-1", name: "Gamma", count: 1 },
  { slug: "archive-1", name: "Archive", count: 1, archived: true },
]);

/**
 * A deterministic, fully isolated sidebar corpus shared by visual and
 * interaction E2E tests. The product derives projects from task manifests, so
 * this fixture writes the same records the main process reads instead of
 * injecting renderer-only data.
 *
 * `projectSpecs: []` and `chatCount: 0` form the real zero-result corpus.
 * Other boundary-specific tests can supply their own project specs without
 * duplicating schema or isolation setup.
 */
export function createSidebarFixture(options = {}) {
  const now = new Date(options.now ?? SIDEBAR_FIXED_NOW);
  if (!Number.isFinite(now.getTime())) {
    throw new Error(`Invalid Sidebar fixture clock: ${String(options.now)}`);
  }
  const projectSpecs = cloneProjectSpecs(
    options.projectSpecs ?? DEFAULT_SIDEBAR_PROJECT_SPECS,
  );
  const chatCount = nonNegativeInteger(options.chatCount ?? 7, "chatCount");
  const archivedChatCount = nonNegativeInteger(
    options.archivedChatCount ?? Math.min(1, chatCount),
    "archivedChatCount",
  );
  if (archivedChatCount > chatCount) {
    throw new Error("archivedChatCount must not exceed chatCount");
  }

  const root = fs.mkdtempSync(path.join(os.tmpdir(), "duet-sidebar-fixture-"));
  const dataRoot = path.join(root, "duet-data");
  const settingsRoot = path.join(root, "settings");
  const userDataDir = path.join(root, "electron-user-data");
  const workspacesRoot = path.join(root, "workspaces");
  const recordsRoot = path.join(dataRoot, "data", "projects");

  for (const directory of [dataRoot, settingsRoot, userDataDir, workspacesRoot, recordsRoot]) {
    fs.mkdirSync(directory, { recursive: true });
  }

  const startOfToday = new Date(now);
  startOfToday.setHours(0, 0, 0, 0);

  const projects = [];
  const overlayFolders = {};
  let sequence = 0;

  for (const [projectIndex, spec] of projectSpecs.entries()) {
    const projectPath = path.join(workspacesRoot, spec.slug);
    fs.mkdirSync(projectPath, { recursive: true });
    overlayFolders[projectPath] = {
      displayName: spec.name,
      ...(spec.archived ? { archived: true } : {}),
    };

    const sessions = [];
    for (let sessionIndex = 0; sessionIndex < spec.count; sessionIndex += 1) {
      sequence += 1;
      const id = `fixture-project-${String(sequence).padStart(3, "0")}`;
      const updatedAt = fixtureTimestamp({
        now,
        startOfToday,
        projectIndex,
        sessionIndex,
      });
      const task = writeTask({
        recordsRoot,
        id,
        title: `${spec.name} session ${String(sessionIndex + 1).padStart(2, "0")}`,
        providerCwd: projectPath,
        updatedAt,
        archived: false,
        autoWorkspace: false,
      });
      sessions.push(task);
    }
    projects.push({ ...spec, path: projectPath, sessions });
  }

  const chats = [];
  for (let chatIndex = 0; chatIndex < chatCount; chatIndex += 1) {
    sequence += 1;
    const id = `fixture-chat-${String(chatIndex + 1).padStart(2, "0")}`;
    const providerCwd = path.join(workspacesRoot, id);
    fs.mkdirSync(providerCwd, { recursive: true });
    const task = writeTask({
      recordsRoot,
      id,
      title: `Chat session ${String(chatIndex + 1).padStart(2, "0")}`,
      providerCwd,
      updatedAt: new Date(now.getTime() - (chatIndex + 2) * 90_000).toISOString(),
      archived: chatIndex >= chatCount - archivedChatCount,
      autoWorkspace: true,
    });
    chats.push(task);
  }

  writeJson(path.join(settingsRoot, "projects.json"), {
    version: 1,
    lastUsedFolder: projects.find((project) => !project.archived)?.path ?? null,
    folders: overlayFolders,
  });
  writeJson(path.join(settingsRoot, "reading-settings.json"), {
    theme: "duet",
    mode: "light",
    textStep: 16,
  });

  const fixture = {
    root,
    dataRoot,
    settingsRoot,
    userDataDir,
    workspacesRoot,
    recordsRoot,
    fixedNowIso: now.toISOString(),
    fixedNowMs: now.getTime(),
    projects,
    chats,
    env: {
      DUET_DATA_DIR: dataRoot,
      DUET_WORKSPACES_DIR: workspacesRoot,
      DUET_SETTINGS_DIR: settingsRoot,
    },
    expectations: {
      projectOrder: projectSpecs.filter((project) => project.count > 0).map((project) => project.name),
      projectCounts: Object.fromEntries(
        projectSpecs
          .filter((project) => project.count > 0)
          .map((project) => [project.name, project.count]),
      ),
      activeProjectOrder: projectSpecs
        .filter((project) => project.count > 0 && !project.archived)
        .map((project) => project.name),
      activeChatCount: chatCount - archivedChatCount,
      allChatCount: chatCount,
    },
    manifestPath(taskId) {
      return path.join(recordsRoot, taskId, "task.json");
    },
    /**
     * Makes the next atomic manifest write fail reliably by occupying the
     * production `.tmp` path with a directory. The returned restore callback
     * is idempotent, so rename tests can exercise failure and retry without
     * depending on OS permission semantics.
     */
    blockManifestWrites(taskId) {
      const manifestPath = fixture.manifestPath(taskId);
      if (!fs.existsSync(manifestPath)) {
        throw new Error(`Cannot block writes for unknown fixture task: ${taskId}`);
      }
      const blockerPath = `${manifestPath}.tmp`;
      fs.rmSync(blockerPath, { recursive: true, force: true });
      fs.mkdirSync(blockerPath, { recursive: false });
      return () => {
        fs.rmSync(blockerPath, { recursive: true, force: true });
      };
    },
    /** Forces the production ProjectsStore atomic temp write to fail until
     * the returned cleanup runs. */
    blockProjectSettingsWrites() {
      const blockerPath = path.join(settingsRoot, "projects.json.tmp");
      fs.rmSync(blockerPath, { recursive: true, force: true });
      fs.mkdirSync(blockerPath, { recursive: false });
      return () => {
        fs.rmSync(blockerPath, { recursive: true, force: true });
      };
    },
    cleanup() {
      fs.rmSync(root, { recursive: true, force: true });
    },
  };

  return fixture;
}

export function createEmptySidebarFixture(options = {}) {
  return createSidebarFixture({
    ...options,
    projectSpecs: [],
    chatCount: 0,
    archivedChatCount: 0,
  });
}

function cloneProjectSpecs(specs) {
  const names = new Set();
  const slugs = new Set();
  return Array.from(specs, (raw, index) => {
    const name = String(raw.name ?? "").trim();
    const slug = String(raw.slug ?? "").trim();
    if (!name || !slug) {
      throw new Error(`Sidebar project spec ${index} needs a name and slug`);
    }
    if (names.has(name) || slugs.has(slug)) {
      throw new Error(`Duplicate Sidebar project spec at index ${index}: ${name}/${slug}`);
    }
    names.add(name);
    slugs.add(slug);
    return {
      slug,
      name,
      count: nonNegativeInteger(raw.count, `projectSpecs[${index}].count`),
      ...(raw.archived ? { archived: true } : {}),
    };
  });
}

function nonNegativeInteger(value, label) {
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`${label} must be a non-negative integer`);
  }
  return value;
}

function writeTask(options) {
  const createdAt = new Date(Date.parse(options.updatedAt) - 3_600_000).toISOString();
  const task = {
    id: options.id,
    title: options.title,
    provider: "codex",
    model: null,
    reasoningEffort: null,
    speedMode: null,
    sandbox: "workspace-write",
    approval: "on-request",
    permissionMode: null,
    runtimeSessionId: `runtime-${options.id}`,
    providerSessionRef: null,
    providerCwd: options.providerCwd,
    workingDirectory: options.providerCwd,
    status: "idle",
    archived: options.archived,
    autoWorkspace: options.autoWorkspace,
    createdAt,
    updatedAt: options.updatedAt,
  };
  writeJson(path.join(options.recordsRoot, options.id, "task.json"), {
    schemaId: TASK_MANIFEST_SCHEMA_ID,
    version: 1,
    generatedAt: options.updatedAt,
    task,
    rawTerminalPolicy: RAW_TERMINAL_POLICY,
    runtimeReportPath: "runtime-report.json",
  });
  return task;
}

function fixtureTimestamp({ now, startOfToday, projectIndex, sessionIndex }) {
  const minuteOffset = projectIndex * 3 + sessionIndex + 10;
  switch (sessionIndex % 4) {
    case 0:
      return new Date(now.getTime() - minuteOffset * 60_000).toISOString();
    case 1:
      return new Date(startOfToday.getTime() - (120 + minuteOffset) * 60_000).toISOString();
    case 2:
      return new Date(startOfToday.getTime() - (2 * 24 * 60 + minuteOffset) * 60_000).toISOString();
    default:
      return new Date(startOfToday.getTime() - (10 * 24 * 60 + minuteOffset) * 60_000).toISOString();
  }
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}
