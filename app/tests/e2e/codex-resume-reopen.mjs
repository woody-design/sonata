// Codex control plane S6 — end-to-end native resume on reopen, with a FAKE codex.
//
// Proves the codex resume chain closes the loop the plan describes:
//   persisted transcript-sources tail → resumeRef → respawn `codex resume <ref>
//   -p sonata` → SessionStart re-fires source:"resume" → handshake re-adoption
//   (identity preserved, no fork) → the rollout continues and re-tails.
//
// The fake `codex` (helpers/fake-codex-source.mjs) records its argv (so we can
// read the resume positional + `-p sonata`) and, on a resume spawn, APPENDS a
// fresh line to the same rollout (so the reopened tailer has something new to
// surface). Real codex needs a human trust ceremony + auth; that live pass is
// run separately (spikes probe-home method).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { _electron as electron } from "playwright-core";
import { FAKE_CODEX_SOURCE } from "./helpers/fake-codex-source.mjs";

const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "sonata-codex-resume-e2e-"));
const codexHome = fs.mkdtempSync(path.join(os.tmpdir(), "sonata-codex-home-"));
const fakeBinDir = fs.mkdtempSync(path.join(os.tmpdir(), "sonata-fake-bin-"));
const folder = fs.mkdtempSync(path.join(os.tmpdir(), "sonata-codex-resume-folder-"));

const fakeCodex = path.join(fakeBinDir, "codex");
fs.writeFileSync(fakeCodex, FAKE_CODEX_SOURCE, { mode: 0o755 });
fs.chmodSync(fakeCodex, 0o755);

let electronApp = null;
const results = {};

try {
  electronApp = await electron.launch({
    args: ["dist/main/main.js"],
    env: {
      ...process.env,
      SONATA_DATA_DIR: workspaceRoot,
      SONATA_WORKSPACES_DIR: workspaceRoot,
      CODEX_HOME: codexHome,
      PATH: `${fakeBinDir}${path.delimiter}${process.env.PATH ?? ""}`,
    },
  });

  const page = await electronApp.firstWindow();
  page.setDefaultTimeout(60000);

  // --- 1. Fresh codex session: adopt identity via the startup handshake --------
  const created = await page.evaluate(
    async (cwd) => window.sonataRuntime.createTask({ provider: "codex", cwd }),
    folder,
  );
  const taskId = created.task.id;

  await waitFor(
    () => readSources(taskId).length > 0 && Boolean(readManifest(taskId)?.task?.providerSessionRef),
    30000,
    "initial codex handshake (transcript-sources + providerSessionRef)",
  );

  const initialRef = readManifest(taskId)?.task?.providerSessionRef ?? null;
  const initialSpawn = readSpawnRecord(taskId);
  const initialSource = readLastSessionStart(taskId)?.source ?? null;

  // --- 2. Close the session — the PTY dies, the binding persists ----------------
  await page.evaluate(async (id) => window.sonataRuntime.closeTask({ taskId: id }), taskId);
  // The reopen must observe a genuinely NEW spawn. The startup spawn wrote
  // resumeArg:null; wait until the record is superseded by the resume spawn.
  await waitFor(
    () => readSpawnRecord(taskId)?.resumeArg != null,
    30000,
    "resume spawn superseding the startup spawn-record",
    // Kick the reopen once the close has settled.
    async () => {
      await page.evaluate(async (id) => window.sonataRuntime.openTask({ taskId: id, resume: true }), taskId);
    },
  );

  // --- 3. Reopen re-fires the handshake as a resume; identity is preserved ------
  await waitFor(
    () => readLastSessionStart(taskId)?.source === "resume",
    30000,
    "resume handshake (source:resume)",
  );

  const reopenSpawn = readSpawnRecord(taskId);
  const reopenRef = readManifest(taskId)?.task?.providerSessionRef ?? null;
  const reopenSources = readSources(taskId).map((s) => s.providerSessionId);
  const reopenSource = readLastSessionStart(taskId)?.source ?? null;

  // The reopened transcript keeps following the SAME rollout — the fake appended
  // a post-resume agent_message, which must surface as an assistant-text block.
  let transcriptContinues = false;
  await waitFor(
    async () => {
      const transcript = await page.evaluate(
        async (id) => window.sonataRuntime.readTranscript({ taskId: id }),
        taskId,
      );
      transcriptContinues = (transcript?.blocks ?? []).some((block) =>
        [block?.text, block?.markdown].some(
          (value) => typeof value === "string" && value.includes("resumed and continuing"),
        ),
      );
      return transcriptContinues;
    },
    30000,
    "post-resume transcript block (rollout re-tailed)",
  );

  // resumeRef reconstructed from the persisted tail, spawned as `resume <ref>`.
  const resumeWired = reopenSpawn?.resumeArg === initialRef && reopenSpawn?.hasProfileFlag === true;
  // Re-adoption preserved identity — the same session id, not a fresh fork.
  const identityPreserved =
    Boolean(initialRef) &&
    reopenRef === initialRef &&
    reopenSources.length > 0 &&
    reopenSources.every((id) => id === initialRef);

  Object.assign(results, {
    taskId,
    initialRef,
    initialSource,
    initialResumeArg: initialSpawn?.resumeArg ?? null,
    reopenRef,
    reopenSources,
    reopenSource,
    reopenResumeArg: reopenSpawn?.resumeArg ?? null,
    reopenArgv: reopenSpawn?.argv ?? null,
    resumeWired,
    identityPreserved,
    transcriptContinues,
  });

  const success =
    initialSource === "startup" &&
    initialSpawn?.resumeArg == null &&
    reopenSource === "resume" &&
    resumeWired &&
    identityPreserved &&
    transcriptContinues;
  results.success = success;
  console.log(JSON.stringify(results, null, 2));
  process.exitCode = success ? 0 : 1;
} finally {
  if (electronApp) {
    await electronApp.close();
  }
  for (const dir of [workspaceRoot, codexHome, fakeBinDir, folder]) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function recordDir(taskId) {
  return path.join(workspaceRoot, "data", "projects", taskId);
}
function runtimeDir(taskId) {
  return path.join(workspaceRoot, "data", "runtime", taskId);
}
function readManifest(taskId) {
  try {
    return JSON.parse(fs.readFileSync(path.join(recordDir(taskId), "task.json"), "utf8"));
  } catch {
    return null;
  }
}
function readSources(taskId) {
  try {
    return (
      JSON.parse(fs.readFileSync(path.join(recordDir(taskId), "transcript-sources.json"), "utf8"))?.sources ?? []
    );
  } catch {
    return [];
  }
}
function readSpawnRecord(taskId) {
  try {
    return JSON.parse(fs.readFileSync(path.join(runtimeDir(taskId), "spawn-record.json"), "utf8"));
  } catch {
    return null;
  }
}
function readLastSessionStart(taskId) {
  try {
    return JSON.parse(fs.readFileSync(path.join(runtimeDir(taskId), "last-session-start.json"), "utf8"));
  } catch {
    return null;
  }
}
async function waitFor(predicate, timeoutMs, label, onFirstTick) {
  const deadline = Date.now() + timeoutMs;
  let kicked = false;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    if (!kicked && onFirstTick) {
      kicked = true;
      await onFirstTick();
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`Timed out waiting for: ${label}`);
}
