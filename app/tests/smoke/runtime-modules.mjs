import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { ArtifactPreview, RunIndex, TerminalHost } = require("../../dist/runtime");

const taskId = "task-runtime-smoke";
const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "duet-runtime-smoke-"));
const reportPath = path.join(workspace, ".duet", "runtime-report.json");
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
    runIndex.consume(event);

    if (event.type === "run:started") {
      runId = event.payload.id;
    }
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

  fs.writeFileSync(artifactPath, "# Duet runtime smoke\n\nArtifact candidate content.\n");
  await waitUntil(() => fileAttributedToRun, 8000);

  host.completeActiveRun("runtime module smoke");
  await delay(250);

  const report = runIndex.read();
  const latestRun = report.runs[report.runs.length - 1] ?? null;
  const preview = new ArtifactPreview({ taskId, workspaceRoot: workspace, report });
  const artifacts = preview.listArtifacts();
  const artifact = preview.readArtifact(artifactName);

  let unknownBlocked = false;
  fs.writeFileSync(path.join(workspace, "notes.txt"), "Not report-listed.\n");
  try {
    preview.readArtifact("notes.txt");
  } catch {
    unknownBlocked = true;
  }

  const success =
    Boolean(runId) &&
    fileAttributedToRun &&
    latestRun?.status === "completed" &&
    latestRun?.rawTerminalPointer === null &&
    latestRun?.changedFiles.some((file) => file.path === artifactName) &&
    latestRun?.artifactCandidates.some((artifactCandidate) => artifactCandidate.path === artifactName) &&
    artifacts.some((artifactCandidate) => artifactCandidate.path === artifactName) &&
    artifact.previewKind === "text" &&
    artifact.content.includes("Artifact candidate content.") &&
    artifact.rawTerminalPointer === null &&
    unknownBlocked &&
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
        previewKind: artifact.previewKind,
        rawTerminalPointer: artifact.rawTerminalPointer,
        unknownBlocked,
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
