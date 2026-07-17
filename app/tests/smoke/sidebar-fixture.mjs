import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  DEFAULT_SIDEBAR_PROJECT_SPECS,
  SIDEBAR_BOUNDARY_TOTALS,
  SIDEBAR_FIXED_NOW,
  createEmptySidebarFixture,
  createSidebarFixture,
} from "../e2e/helpers/sidebar-fixture.mjs";

assert.deepEqual(
  SIDEBAR_BOUNDARY_TOTALS,
  [0, 5, 6, 15, 16, 25, 26],
  "the fixture advertises every disclosure boundary from the plan",
);

for (const total of SIDEBAR_BOUNDARY_TOTALS) {
  const fixture =
    total === 0
      ? createEmptySidebarFixture()
      : createSidebarFixture({
          projectSpecs: [{ slug: `boundary-${total}`, name: `Boundary ${total}`, count: total }],
          chatCount: 0,
        });
  try {
    assert.equal(fixture.fixedNowIso, SIDEBAR_FIXED_NOW, `boundary ${total} uses fixed clock`);
    assert.equal(
      fixture.projects.reduce((sum, project) => sum + project.sessions.length, 0),
      total,
      `boundary ${total} writes the requested number of real manifests`,
    );
    assert.equal(fixture.chats.length, 0, `boundary ${total} has no incidental Chats`);
  } finally {
    const root = fixture.root;
    fixture.cleanup();
    assert.equal(fs.existsSync(root), false, `boundary ${total} cleans its temp root`);
  }
}

const fixture = createSidebarFixture();
try {
  assert.equal(
    fixture.expectations.activeProjectOrder.length,
    16,
    "default corpus crosses the outer-project +10 boundary",
  );
  assert.notDeepEqual(
    fixture.expectations.projectOrder,
    [...fixture.expectations.projectOrder].sort((a, b) => a.localeCompare(b)),
    "canonical project order must not correlate with alphabetical order",
  );
  assert.notDeepEqual(
    DEFAULT_SIDEBAR_PROJECT_SPECS.map((project) => project.count),
    [...DEFAULT_SIDEBAR_PROJECT_SPECS]
      .sort((a, b) => b.count - a.count)
      .map((project) => project.count),
    "canonical project order must not correlate with session-count order",
  );

  const taskId = fixture.projects[0].sessions[0].id;
  const manifestPath = fixture.manifestPath(taskId);
  const blockerPath = `${manifestPath}.tmp`;
  const restoreWrites = fixture.blockManifestWrites(taskId);
  assert.equal(fs.statSync(blockerPath).isDirectory(), true, "failure seam occupies atomic tmp path");
  assert.throws(
    () => fs.writeFileSync(blockerPath, "candidate"),
    (error) => error?.code === "EISDIR",
    "the seam produces a genuine filesystem persistence failure",
  );
  restoreWrites();
  fs.writeFileSync(blockerPath, "candidate");
  fs.rmSync(blockerPath);

  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  assert.equal(manifest.schemaId, "sonata.task-manifest.v1");
  assert.equal(manifest.task.id, taskId);
  assert.equal(manifest.rawTerminalPolicy, "raw-terminal-not-persisted-by-default");
} finally {
  fixture.cleanup();
}

const empty = createEmptySidebarFixture();
try {
  const projectsFile = JSON.parse(
    fs.readFileSync(path.join(empty.settingsRoot, "projects.json"), "utf8"),
  );
  assert.deepEqual(fs.readdirSync(empty.recordsRoot), [], "zero corpus has no task records");
  assert.deepEqual(empty.expectations.projectOrder, []);
  assert.equal(empty.expectations.allChatCount, 0);
  assert.equal(projectsFile.lastUsedFolder, null);
} finally {
  empty.cleanup();
}

console.log("ok   deterministic Sidebar boundary and persistence-failure fixtures");
