import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const paths = require("../../dist/main/sonata-paths");

const savedEnv = process.env.SONATA_DATA_DIR;

function withDataDir(value, fn) {
  if (value === undefined) {
    delete process.env.SONATA_DATA_DIR;
  } else {
    process.env.SONATA_DATA_DIR = value;
  }
  try {
    fn();
  } finally {
    if (savedEnv === undefined) {
      delete process.env.SONATA_DATA_DIR;
    } else {
      process.env.SONATA_DATA_DIR = savedEnv;
    }
  }
}

// 1. Default home: ~/.sonata, sibling of ~/.claude / ~/.codex.
withDataDir(undefined, () => {
  assert.equal(paths.sonataDataRoot(), path.join(os.homedir(), ".sonata"), "default root is ~/.sonata");
});

// 2. Explicit override wins (the workshop launcher / tests / future rename).
withDataDir("/tmp/sonata-probe-root", () => {
  assert.equal(paths.sonataDataRoot(), "/tmp/sonata-probe-root", "SONATA_DATA_DIR override wins");
});

// 3. A relative override is resolved to an absolute path (no surprise CWD-relative roots).
withDataDir("relative/root", () => {
  assert.equal(
    paths.sonataDataRoot(),
    path.resolve("relative/root"),
    "relative override resolved to absolute",
  );
});

// 4. Whitespace-only override is ignored (falls back to the default).
withDataDir("   ", () => {
  assert.equal(paths.sonataDataRoot(), path.join(os.homedir(), ".sonata"), "blank override ignored");
});

// 5. The full topology composes off the one root, and nothing escapes it.
withDataDir("/tmp/sonata-probe-root", () => {
  const root = "/tmp/sonata-probe-root";
  const taskId = "task-1750000000-7";

  assert.equal(paths.sonataConfigDir(), path.join(root, "config"));
  assert.equal(paths.sonataCacheDir(), path.join(root, "cache"));
  assert.equal(paths.sonataLogsDir(), path.join(root, "logs"));
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
    paths.sonataConfigDir(),
    paths.sonataCacheDir(),
    paths.sonataLogsDir(),
    paths.projectsDataDir(),
    paths.projectRecordRoot(taskId),
    paths.runtimeDir(taskId),
    paths.attachmentsRootForTask(taskId),
  ];
  for (const p of everything) {
    assert.ok(p.startsWith(`${root}${path.sep}`), `${p} stays under the single root`);
  }
});

console.log("ok   sonata-paths single-source root + topology");
