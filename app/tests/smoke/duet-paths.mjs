import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const paths = require("../../dist/main/duet-paths");

const savedEnv = process.env.DUET_DATA_DIR;

function withDataDir(value, fn) {
  if (value === undefined) {
    delete process.env.DUET_DATA_DIR;
  } else {
    process.env.DUET_DATA_DIR = value;
  }
  try {
    fn();
  } finally {
    if (savedEnv === undefined) {
      delete process.env.DUET_DATA_DIR;
    } else {
      process.env.DUET_DATA_DIR = savedEnv;
    }
  }
}

// 1. Default home: ~/.duet, sibling of ~/.claude / ~/.codex.
withDataDir(undefined, () => {
  assert.equal(paths.duetDataRoot(), path.join(os.homedir(), ".duet"), "default root is ~/.duet");
});

// 2. Explicit override wins (the workshop launcher / tests / future rename).
withDataDir("/tmp/duet-probe-root", () => {
  assert.equal(paths.duetDataRoot(), "/tmp/duet-probe-root", "DUET_DATA_DIR override wins");
});

// 3. A relative override is resolved to an absolute path (no surprise CWD-relative roots).
withDataDir("relative/root", () => {
  assert.equal(
    paths.duetDataRoot(),
    path.resolve("relative/root"),
    "relative override resolved to absolute",
  );
});

// 4. Whitespace-only override is ignored (falls back to the default).
withDataDir("   ", () => {
  assert.equal(paths.duetDataRoot(), path.join(os.homedir(), ".duet"), "blank override ignored");
});

// 5. The full topology composes off the one root, and nothing escapes it.
withDataDir("/tmp/duet-probe-root", () => {
  const root = "/tmp/duet-probe-root";
  const taskId = "task-1750000000-7";

  assert.equal(paths.duetConfigDir(), path.join(root, "config"));
  assert.equal(paths.duetCacheDir(), path.join(root, "cache"));
  assert.equal(paths.duetLogsDir(), path.join(root, "logs"));
  assert.equal(paths.projectsDataDir(), path.join(root, "data", "projects"));
  assert.equal(paths.projectRecordRoot(taskId), path.join(root, "data", "projects", taskId));
  assert.equal(paths.runtimeDir(taskId), path.join(root, "data", "runtime", taskId));
  assert.equal(
    paths.attachmentsRootForTask(taskId),
    path.join(root, "data", "attachments", taskId),
  );

  // Records, runtime, and attachments are siblings under data/ — never nested in
  // each other, never outside the root.
  const everything = [
    paths.duetConfigDir(),
    paths.duetCacheDir(),
    paths.duetLogsDir(),
    paths.projectsDataDir(),
    paths.projectRecordRoot(taskId),
    paths.runtimeDir(taskId),
    paths.attachmentsRootForTask(taskId),
  ];
  for (const p of everything) {
    assert.ok(p.startsWith(`${root}${path.sep}`), `${p} stays under the single root`);
  }
});

console.log("ok   duet-paths single-source root + topology");
