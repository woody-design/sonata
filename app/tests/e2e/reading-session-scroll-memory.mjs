// Focus/flow S3 (D3) — PER-SESSION SCROLL MEMORY. The invariant: a session you
// come back to opens where you left off reading it, and a session you left at
// the live edge opens at its NEW live edge.
//
// Before this slice the reading surface had no scroll handling for a session
// switch at all: the outgoing cards were removed (dropping scrollTop to 0) and
// the incoming transcript inherited the OUTGOING DOM's nearBottom /
// previousScrollTop, captured before the reconcile. Whatever the returning
// session did was an accident of what the reader happened to be doing in the
// session they left.
//
// Four positions are pinned here, each one a different branch of
// planTaskSwitchScroll (reading-core/reading-scroll.ts):
//   · first open of a session this run  → the bottom (nothing remembered);
//   · left mid-history, nothing changed → that exact offset;
//   · left at the bottom, transcript grew while away → the NEW bottom, not the
//     pixel where the old bottom used to be;
//   · a second session's positions are its own (the two never leak into each
//     other, which is precisely what the old inheritance did).
//
// Driven end-to-end against the built app with a fake `codex` on PATH
// (helpers/fake-codex-source.mjs): it writes a rollout + SessionStart
// handshake, Sonata adopts and tails it, and this fence appends real
// `agent_message` records to that rollout — the same tailer → codex-normalizer
// → reducer → renderRuns path a live reply takes.
//
// Fixture provenance:
//   · the rollout records: ADAPTED from tests/e2e/compaction-marker.mjs, which
//     appends to the same fake rollout; the `event_msg` / `agent_message` shape
//     is the one the fake codex itself writes (helpers/fake-codex-source.mjs)
//     and the one codex-normalizer.ts pins.
//   · the reply bodies: COMPOSED — numbered lines, sized only to make the
//     transcript overflow its viewport by a known amount. No provider output is
//     being imitated; only its height matters here.
//
//   npm run e2e:reading-session-scroll-memory

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { _electron as electron } from "playwright-core";
import { FAKE_CODEX_SOURCE } from "./helpers/fake-codex-source.mjs";

const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "sonata-scroll-memory-"));
const codexHome = fs.mkdtempSync(path.join(os.tmpdir(), "sonata-scroll-memory-home-"));
const fakeBinDir = fs.mkdtempSync(path.join(os.tmpdir(), "sonata-scroll-memory-bin-"));
const folderA = fs.mkdtempSync(path.join(os.tmpdir(), "sonata-scroll-memory-a-"));
const folderB = fs.mkdtempSync(path.join(os.tmpdir(), "sonata-scroll-memory-b-"));

fs.writeFileSync(path.join(fakeBinDir, "codex"), FAKE_CODEX_SOURCE, { mode: 0o755 });
fs.chmodSync(path.join(fakeBinDir, "codex"), 0o755);

/** Where the reader parks in session A before leaving it. */
const READING_OFFSET = 300;

let app = null;
const checks = {};
const results = {};

try {
  app = await electron.launch({
    args: ["dist/main/main.js"],
    env: {
      ...process.env,
      SONATA_DATA_DIR: workspaceRoot,
      SONATA_WORKSPACES_DIR: workspaceRoot,
      CODEX_HOME: codexHome,
      SONATA_NOTIFICATIONS: "0",
      PATH: `${fakeBinDir}${path.delimiter}${process.env.PATH ?? ""}`,
    },
  });
  const page = await app.firstWindow();
  page.setDefaultTimeout(60_000);
  await page.setViewportSize({ width: 1180, height: 720 });
  await page.locator(".task-entry-panel").waitFor({ state: "visible" });
  await page.waitForFunction(() => Boolean(document.documentElement.dataset.readingFirstFrame));

  // Count the assistant segments the RENDERER has received per task — the
  // reducer applies `transcript:blocks` for background views too, so this is the
  // one signal that says "the view behind the curtain is up to date" without
  // looking at a surface that is not on screen.
  await page.evaluate(() => {
    window.__segments = {};
    window.sonataRuntime.onRuntimeEvent((event) => {
      if (event.type !== "transcript:blocks") {
        return;
      }
      const seen = (window.__segments[event.payload.taskId] ??= new Set());
      for (const block of event.payload.upserts) {
        if (block.kind === "assistant-text") {
          seen.add(block.id);
        }
      }
    });
  });

  const taskA = await createTask(page, folderA);
  const taskB = await createTask(page, folderB);
  const rolloutA = await waitForRollout(taskA);
  const rolloutB = await waitForRollout(taskB);

  // Both transcripts are grown while NEITHER session is displayed, so the first
  // click on each is a plain first open with nothing to anchor.
  appendReply(rolloutA, "A", 1, 90);
  appendReply(rolloutA, "A", 2, 90);
  appendReply(rolloutB, "B", 1, 90);
  await waitForSegments(page, taskA, 2);
  await waitForSegments(page, taskB, 1);

  // ——— 1. First open of a session this run: the bottom.
  await openSession(page, taskA);
  await page.waitForFunction(() => document.querySelectorAll("#run-list .turn-card").length > 0);
  const firstOpen = await metrics(page);
  results.firstOpen = firstOpen;
  checks.firstOpenIsBottom = distance(firstOpen) <= 64;
  assert(checks.firstOpenIsBottom, `first open lands at the bottom (${JSON.stringify(firstOpen)})`);
  assert(overflow(firstOpen) > 900, `transcript A overflows enough to be scrollable (${overflow(firstOpen)})`);

  // ——— 2. Left mid-history: that exact offset comes back.
  await scrollTo(page, READING_OFFSET);
  await openSession(page, taskB);
  const firstOpenB = await metrics(page);
  results.firstOpenB = firstOpenB;
  checks.secondSessionOpensAtItsOwnBottom = distance(firstOpenB) <= 64;
  assert(
    checks.secondSessionOpensAtItsOwnBottom,
    `session B opens at its own bottom, not A's offset (${JSON.stringify(firstOpenB)})`,
  );

  await openSession(page, taskA);
  const restored = await metrics(page);
  results.restored = restored;
  checks.midHistoryOffsetRestored = Math.abs(restored.scrollTop - READING_OFFSET) <= 1;
  assert(
    checks.midHistoryOffsetRestored,
    `returning to A restores the reading offset (${JSON.stringify(restored)})`,
  );

  // ——— 3. Left at the bottom, transcript grew while away: the NEW bottom.
  await scrollTo(page, "bottom");
  const beforeGrowth = await metrics(page);
  await openSession(page, taskB);
  appendReply(rolloutA, "A", 3, 120);
  await waitForSegments(page, taskA, 3);
  await openSession(page, taskA);
  // The growth is on screen (its own height is the evidence — no dependence on
  // any per-block DOM contract, which belongs to the anchoring half).
  await page.waitForFunction(
    (minimum) => document.querySelector("#run-list").scrollHeight > minimum,
    beforeGrowth.scrollHeight + 900,
  );
  const afterGrowth = await metrics(page);
  results.beforeGrowth = beforeGrowth;
  results.afterGrowth = afterGrowth;
  checks.grewWhileAwayReturnsToNewBottom =
    afterGrowth.scrollHeight > beforeGrowth.scrollHeight + 900 && distance(afterGrowth) <= 64;
  assert(
    checks.grewWhileAwayReturnsToNewBottom,
    `a session left at the live edge returns to the NEW live edge (${JSON.stringify({ beforeGrowth, afterGrowth })})`,
  );
  // And the growth that landed while A was in the background must not ANCHOR on
  // the way in — switching into a session shows it, it never moves inside it.
  // Distinct from the check above, which only says "at the bottom": this reads
  // the arriving segment's own geometry, so an anchor would be caught even if it
  // happened to land near the bottom. An anchored segment sits at the reading
  // line (+40px); a seeded one is scrolled far past, above the viewport.
  const arrivedSegmentTop = await page.evaluate(() => {
    const list = document.querySelector("#run-list");
    const segments = list.querySelectorAll(".turn-answer > [data-block-key]");
    const node = segments[segments.length - 1];
    return node.getBoundingClientRect().top - list.getBoundingClientRect().top;
  });
  results.arrivedSegmentTop = arrivedSegmentTop;
  checks.backgroundGrowthDoesNotAnchor = arrivedSegmentTop < 0;
  assert(
    checks.backgroundGrowthDoesNotAnchor,
    `background growth is seeded, never anchored (segment top ${arrivedSegmentTop})`,
  );

  // ——— 4. Two sessions parked at two different offsets keep them apart. This
  // is the shape the old inheritance got wrong: whatever the reader was doing
  // in the session they LEFT decided where the incoming session opened.
  await scrollTo(page, 900);
  await openSession(page, taskB);
  await scrollTo(page, 180);
  await openSession(page, taskA);
  const restoredA2 = await metrics(page);
  await openSession(page, taskB);
  const restoredB2 = await metrics(page);
  results.restoredA2 = restoredA2;
  results.restoredB2 = restoredB2;
  checks.perSessionPositionsAreIndependent =
    Math.abs(restoredA2.scrollTop - 900) <= 1 && Math.abs(restoredB2.scrollTop - 180) <= 1;
  assert(
    checks.perSessionPositionsAreIndependent,
    `each session keeps its own place (${JSON.stringify({ restoredA2, restoredB2 })})`,
  );

  results.success = true;
  results.checks = checks;
  console.log(JSON.stringify(results, null, 2));
  process.exitCode = 0;
} catch (error) {
  results.success = false;
  results.checks = checks;
  results.error = String(error?.stack ?? error);
  console.error(JSON.stringify(results, null, 2));
  process.exitCode = 1;
} finally {
  await app?.close();
  for (const dir of [workspaceRoot, codexHome, fakeBinDir, folderA, folderB]) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

async function createTask(page, cwd) {
  const created = await page.evaluate(
    async (folder) => window.sonataRuntime.createTask({ provider: "codex", cwd: folder }),
    cwd,
  );
  const taskId = created.task.id;
  await page.locator(`.sidebar-session[data-task-id="${taskId}"]`).waitFor({ state: "visible" });
  return taskId;
}

/** Click a session in the sidebar and wait until the surface is showing it. */
async function openSession(page, taskId) {
  await page.locator(`.sidebar-session[data-task-id="${taskId}"]`).click();
  await page.waitForFunction(
    (expected) =>
      document.querySelector(`.sidebar-session[data-task-id="${expected}"]`)?.classList.contains("active") ??
      false,
    taskId,
  );
  // One frame for the switch render's finalize to have written scrollTop.
  await page.evaluate(
    () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
  );
}

function appendReply(rolloutPath, label, index, lines) {
  const body = [`## Session ${label} reply ${index}`];
  for (let line = 1; line <= lines; line += 1) {
    body.push(`${label}${index} line ${line}`);
  }
  fs.appendFileSync(
    rolloutPath,
    `${JSON.stringify({
      timestamp: new Date().toISOString(),
      type: "event_msg",
      payload: { type: "agent_message", message: body.join("\n\n"), phase: "final_answer" },
    })}\n`,
  );
}

async function waitForRollout(taskId) {
  let rolloutPath = null;
  await waitFor(() => {
    rolloutPath = readSources(taskId)[0]?.path ?? null;
    return Boolean(rolloutPath) && fs.existsSync(rolloutPath);
  }, `codex handshake for ${taskId}`);
  return rolloutPath;
}

async function waitForSegments(page, taskId, count) {
  await page.waitForFunction(
    ({ id, expected }) => (window.__segments?.[id]?.size ?? 0) >= expected,
    { id: taskId, expected: count },
  );
}

async function scrollTo(page, top) {
  await page.evaluate((target) => {
    const runList = document.querySelector("#run-list");
    runList.scrollTop = target === "bottom" ? runList.scrollHeight : target;
    runList.dispatchEvent(new Event("scroll"));
  }, top);
  await page.evaluate(
    () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
  );
}

async function metrics(page) {
  return page.evaluate(() => {
    const runList = document.querySelector("#run-list");
    return {
      scrollTop: runList.scrollTop,
      scrollHeight: runList.scrollHeight,
      clientHeight: runList.clientHeight,
    };
  });
}

function distance(m) {
  return Math.max(0, m.scrollHeight - m.scrollTop - m.clientHeight);
}

function overflow(m) {
  return m.scrollHeight - m.clientHeight;
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

async function waitFor(predicate, label, timeoutMs = 40_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`Timed out waiting for: ${label}`);
}

function assert(value, label) {
  if (!value) {
    throw new Error(`Scroll-memory assertion failed: ${label}`);
  }
}
