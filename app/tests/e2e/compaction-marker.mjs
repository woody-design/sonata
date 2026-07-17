// S7 renderer acceptance — a transcript-derived context-compaction record must
// render in the Reading window as a calm state-register SEPARATOR (design A),
// not a husk turn card and not folded into a reply.
//
// The full path is exercised end-to-end with a FAKE codex: it writes a rollout +
// SessionStart handshake (helpers/fake-codex-source.mjs), Sonata adopts + tails it,
// and the test appends a real `task_started` + `compacted` boundary turn to that
// rollout. The tailer → codex-normalizer → reducer → renderRuns then draws the
// marker. We assert the marker is present with role="separator", the exact copy
// "Context compacted", and that the copy NEVER says cleared/reset/lost.
//
//   npm run e2e:compaction-marker

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import { _electron as electron } from "playwright-core";
import { FAKE_CODEX_SOURCE } from "./helpers/fake-codex-source.mjs";

const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "sonata-compaction-e2e-"));
const codexHome = fs.mkdtempSync(path.join(os.tmpdir(), "sonata-codex-home-"));
const fakeBinDir = fs.mkdtempSync(path.join(os.tmpdir(), "sonata-fake-bin-"));
const folder = fs.mkdtempSync(path.join(os.tmpdir(), "sonata-compaction-folder-"));

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

  // Create the codex task, then select it so its reading surface is the active
  // view (createTask alone does not switch the renderer's active task).
  const created = await page.evaluate(
    async (cwd) => window.sonataRuntime.createTask({ provider: "codex", cwd }),
    folder,
  );
  const taskId = created.task.id;
  const row = page.locator(`.sidebar-session[data-task-id="${taskId}"]`);
  await row.waitFor({ state: "visible", timeout: 30000 });
  await row.click();

  let rolloutPath = null;
  await waitFor(
    () => {
      const sources = readSources(taskId);
      rolloutPath = sources[0]?.path ?? null;
      return Boolean(rolloutPath) && fs.existsSync(rolloutPath);
    },
    30000,
    "codex handshake (transcript source + rollout on disk)",
  );

  // Append a real compaction boundary turn: a non-user-initiated `task_started`
  // (new turn_id, no user_message) then the top-level `compacted` record — the
  // exact shape codex 0.144.4 writes (P3).
  const boundaryTurnId = "019f6535-da11-7163-9a4d-b9390d489271";
  fs.appendFileSync(
    rolloutPath,
    JSON.stringify({
      timestamp: new Date().toISOString(),
      type: "event_msg",
      payload: { type: "task_started", turn_id: boundaryTurnId, collaboration_mode_kind: "default" },
    }) +
      "\n" +
      JSON.stringify({
        timestamp: new Date().toISOString(),
        type: "compacted",
        payload: {
          message: "",
          replacement_history: [
            { type: "compaction", id: "cmp_x", encrypted_content: "gAAAAAB_secret_never_render" },
          ],
          window_number: 1,
        },
      }) +
      "\n",
  );

  // The marker must appear in the reading surface (the tailer → codex-normalizer
  // → reducer → renderRuns path, driven by the appended rollout records).
  const marker = page.locator(".compaction-marker");
  await marker.waitFor({ state: "visible", timeout: 40000 });

  const role = await marker.getAttribute("role");
  const ariaLabel = await marker.getAttribute("aria-label");
  const text = (await marker.innerText()).trim();
  // The marker must NOT be a turn card, and the reply text of no turn should be
  // swallowed — the marker is its own standalone node.
  const isInsideTurnCard = await marker.evaluate((el) => Boolean(el.closest(".turn-card")));
  const forbidden = ["cleared", "reset", "lost", "deleted", "erased"];
  const usesForbidden = forbidden.some((w) => text.toLowerCase().includes(w));

  Object.assign(results, { taskId, role, ariaLabel, text, isInsideTurnCard, usesForbidden });

  assert.equal(role, "separator", "marker is a role=separator");
  assert.equal(ariaLabel, "Context compacted", "aria-label names the boundary");
  assert.equal(text, "Context compacted", "visible copy is exactly 'Context compacted'");
  assert.equal(isInsideTurnCard, false, "the marker is a standalone separator, not a turn card");
  assert.equal(usesForbidden, false, "copy never says cleared/reset/lost");

  results.success = true;
  console.log(JSON.stringify(results, null, 2));
  process.exitCode = 0;
} catch (error) {
  results.success = false;
  results.error = String(error?.stack ?? error);
  console.error(JSON.stringify(results, null, 2));
  process.exitCode = 1;
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
function readSources(taskId) {
  try {
    return (
      JSON.parse(fs.readFileSync(path.join(recordDir(taskId), "transcript-sources.json"), "utf8"))
        ?.sources ?? []
    );
  } catch {
    return [];
  }
}
async function waitFor(predicate, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`Timed out waiting for: ${label}`);
}
