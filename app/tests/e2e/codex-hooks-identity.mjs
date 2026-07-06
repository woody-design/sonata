// Codex control plane S2 — end-to-end identity + liveness, with a FAKE codex.
//
// Real Codex needs a one-time human trust ceremony and auth, so this fence
// drives a stand-in `codex` on PATH (helpers/fake-codex-source.mjs) that speaks
// exactly the sink shim's `hook-*.json` protocol. It holds three S2 contracts:
//   1. Spawn wiring — the codex spawn carries `-p duet` + DUET_RUNTIME_DIR, and
//      Duet wrote its profile into $CODEX_HOME and its shims into ~/.duet/bin.
//   2. Same-cwd isolation — two codex tasks in ONE folder each adopt THEIR OWN
//      transcript from the per-task hook handshake; bindings never cross (the
//      historical mtime blind spot, now hooks-only for codex).
//   3. Hooks liveness — a codex task whose hooks never handshake raises the
//      Terminal trust-ceremony banner, and a LATE handshake clears it.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { _electron as electron } from "playwright-core";
import { selectSidebarSession } from "./helpers/session.mjs";
import { FAKE_CODEX_SOURCE } from "./helpers/fake-codex-source.mjs";

const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "duet-codex-hooks-e2e-"));
const codexHome = fs.mkdtempSync(path.join(os.tmpdir(), "duet-codex-home-"));
const fakeBinDir = fs.mkdtempSync(path.join(os.tmpdir(), "duet-fake-bin-"));
// ONE shared folder for the isolation pair; a separate silent folder for liveness.
const sharedFolder = fs.mkdtempSync(path.join(os.tmpdir(), "duet-codex-shared-"));
const silentFolder = fs.mkdtempSync(path.join(os.tmpdir(), "duet-codex-silent-"));
fs.writeFileSync(path.join(silentFolder, "DUET_FAKE_SILENT"), "");

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
      DUET_DATA_DIR: workspaceRoot,
      DUET_WORKSPACES_DIR: workspaceRoot,
      CODEX_HOME: codexHome,
      // Fake codex wins PATH resolution over any real one.
      PATH: `${fakeBinDir}${path.delimiter}${process.env.PATH ?? ""}`,
    },
  });

  const page = await electronApp.firstWindow();
  page.setDefaultTimeout(60000);

  // --- Same-cwd isolation: two codex tasks, one folder --------------------------
  const alpha = await page.evaluate(
    async (cwd) => window.duetRuntime.createTask({ provider: "codex", cwd }),
    sharedFolder,
  );
  const beta = await page.evaluate(
    async (cwd) => window.duetRuntime.createTask({ provider: "codex", cwd }),
    sharedFolder,
  );

  // The hooks handshake writes transcript-sources.json — wait for both.
  await waitFor(() => readSources(alpha.task.id).length > 0 && readSources(beta.task.id).length > 0, 30000,
    "transcript-sources for both codex tasks");

  const alphaRef = readManifest(alpha.task.id)?.task?.providerSessionRef ?? null;
  const betaRef = readManifest(beta.task.id)?.task?.providerSessionRef ?? null;
  const alphaSources = readSources(alpha.task.id).map((s) => s.providerSessionId);
  const betaSources = readSources(beta.task.id).map((s) => s.providerSessionId);

  // Each adopted ITS OWN session (id carries its own taskId), and nothing crossed.
  const bindingsDistinct =
    Boolean(alphaRef) && Boolean(betaRef) && alphaRef !== betaRef &&
    alphaRef.includes(alpha.task.id) && betaRef.includes(beta.task.id) &&
    alphaSources.every((id) => !betaSources.includes(id));

  // Spawn wiring proof: the fake recorded its argv + env.
  const alphaSpawn = readSpawnRecord(alpha.task.id);
  const betaSpawn = readSpawnRecord(beta.task.id);
  const spawnWired =
    alphaSpawn?.hasProfileFlag === true &&
    betaSpawn?.hasProfileFlag === true &&
    alphaSpawn.duetRuntimeDir === runtimeDir(alpha.task.id) &&
    betaSpawn.duetRuntimeDir === runtimeDir(beta.task.id);

  // Duet's injection artifacts on disk.
  const profileWritten = fs.existsSync(path.join(codexHome, "duet.config.toml"));
  const shimsWritten =
    fs.existsSync(path.join(workspaceRoot, "bin", "codex-hook-sink.js")) &&
    fs.existsSync(path.join(workspaceRoot, "bin", "codex-approval-broker.js"));

  // --- Liveness: a codex task whose hooks never handshake -----------------------
  const gamma = await page.evaluate(
    async (cwd) => window.duetRuntime.createTask({ provider: "codex", cwd }),
    silentFolder,
  );
  await selectSidebarSession(page, gamma.task.id);
  const banner = page.locator('.attention-banner[data-kind="codex-hooks-liveness"]');
  // Window is 12s; allow margin.
  await banner.waitFor({ state: "visible", timeout: 30000 });
  const bannerAppeared = await banner.isVisible();

  // Late handshake: the user completes the trust ceremony → a SessionStart hook
  // finally lands. Duet must clear the banner.
  const lateRuntimeDir = runtimeDir(gamma.task.id);
  const lateRollout = path.join(lateRuntimeDir, "rollout-late.jsonl");
  fs.writeFileSync(lateRollout, `${JSON.stringify({ type: "session_meta", payload: { id: "codexsess-late", cwd: silentFolder, timestamp: new Date().toISOString() } })}\n`);
  const hooksDir = path.join(lateRuntimeDir, "hooks");
  fs.mkdirSync(hooksDir, { recursive: true });
  const lateHook = path.join(hooksDir, `hook-${Date.now().toString(36)}-late.json`);
  fs.writeFileSync(`${lateHook}.tmp`, JSON.stringify({
    hook_event_name: "SessionStart",
    session_id: "codexsess-late",
    transcript_path: lateRollout,
    cwd: silentFolder,
  }));
  fs.renameSync(`${lateHook}.tmp`, lateHook);

  await banner.waitFor({ state: "hidden", timeout: 30000 });
  const bannerCleared = !(await banner.isVisible());

  Object.assign(results, {
    workspaceRoot,
    codexHome,
    alphaTask: alpha.task.id,
    betaTask: beta.task.id,
    gammaTask: gamma.task.id,
    alphaRef,
    betaRef,
    alphaSources,
    betaSources,
    bindingsDistinct,
    alphaSpawnArgv: alphaSpawn?.argv ?? null,
    spawnWired,
    profileWritten,
    shimsWritten,
    bannerAppeared,
    bannerCleared,
  });

  const success =
    bindingsDistinct && spawnWired && profileWritten && shimsWritten && bannerAppeared && bannerCleared;
  results.success = success;
  console.log(JSON.stringify(results, null, 2));
  process.exitCode = success ? 0 : 1;
} finally {
  if (electronApp) {
    await electronApp.close();
  }
  for (const dir of [workspaceRoot, codexHome, fakeBinDir, sharedFolder, silentFolder]) {
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
async function waitFor(predicate, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`Timed out waiting for: ${label}`);
}
