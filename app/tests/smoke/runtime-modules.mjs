import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { RunIndex, TerminalHost, isRunIndexEvent } = require("../../dist/runtime");

const taskId = "task-runtime-smoke";
const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "sonata-runtime-smoke-"));
const reportPath = path.join(workspace, ".sonata", "runtime-report.json");
const artifactName = "artifact.md";
const artifactPath = path.join(workspace, artifactName);

let runId = null;
let fileAttributedToRun = false;
const eventTypes = [];

const runIndex = new RunIndex({ taskId, reportPath });
const host = new TerminalHost({
  taskId,
  defaultWorkspace: workspace,
  eventSink: (event) => {
    if (event.type === "pty:data" || event.type === "report:updated") {
      return;
    }

    eventTypes.push(event.type);
    // Mirror the controller's consume boundary (OBS S6): `file:changed` LEFT the
    // run-index allowlist, so only real RunIndex events cross into consume — the
    // watcher's file:changed stream is inspected here but never consumed.
    if (isRunIndexEvent(event)) {
      runIndex.consume(event);
    }

    if (event.type === "run:started") {
      runId = event.payload.id;
    }
    // The watcher still emits file:changed for Preview (S5); we assert it still
    // fires and attributes to the active run. The report's changedFiles now come
    // from the turn-boundary reconcile (this file is written by raw fs, not a
    // tool hook), verified after completeActiveRun below.
    if (event.type === "file:changed" && event.payload.path === artifactName) {
      fileAttributedToRun = event.payload.runId === runId;
    }
  },
});

try {
  host.startTask({
    cwd: workspace,
    command: process.env.SHELL || "zsh",
    args: ["-lc", "sleep 8"],
    rows: 12,
    cols: 80,
  });

  await delay(500);
  host.submitPrompt("Runtime module smoke prompt.");
  await waitUntil(() => Boolean(runId), 4000);

  fs.writeFileSync(artifactPath, "# Sonata runtime smoke\n\nArtifact candidate content.\n");
  await waitUntil(() => fileAttributedToRun, 8000);

  host.completeActiveRun("runtime module smoke");
  await delay(250);

  const report = runIndex.read();
  const latestRun = report.runs[report.runs.length - 1] ?? null;

  // The recorder's report is the surviving contract: a live PTY run attributes
  // the written file to its run, and the report carries changedFiles +
  // artifactCandidates (isArtifactCandidate is a recorder concern; the old
  // ArtifactPreview/WorkspacePreview reader modules retired in S5).
  const success =
    Boolean(runId) &&
    fileAttributedToRun &&
    latestRun?.status === "completed" &&
    latestRun?.rawTerminalPointer === null &&
    latestRun?.changedFiles.some((file) => file.path === artifactName) &&
    latestRun?.artifactCandidates.some((artifactCandidate) => artifactCandidate.path === artifactName) &&
    !JSON.stringify(report).includes("pty:data");

  console.log(
    JSON.stringify(
      {
        workspace,
        reportPath,
        runStarted: Boolean(runId),
        fileAttributedToRun,
        latestRunStatus: latestRun?.status,
        changedFiles: latestRun?.changedFiles.length ?? 0,
        artifactCandidates: latestRun?.artifactCandidates.length ?? 0,
        eventTypes: [...new Set(eventTypes)],
      },
      null,
      2,
    ),
  );

  process.exitCode = success ? 0 : 1;
} finally {
  host.dispose();
  fs.rmSync(workspace, { recursive: true, force: true });
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitUntil(predicate, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) {
      return true;
    }
    await delay(100);
  }
  return false;
}
