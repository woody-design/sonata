// Focus/flow S3 (D4) — REPLY-TOP ANCHORING. The model shift this slice exists
// for: Reading is reading, not monitoring. Every time a new assistant answer
// segment appears, its TOP edge goes to the reading line near the top of the
// viewport and the view then HOLDS STILL — the reader reads from the start of
// what arrived instead of chasing a tail that keeps moving.
//
// Five properties are pinned, each a claim the design makes:
//   1. a new segment puts its own top edge at the reading line, and the
//      near-bottom tail-follow retires there (the view is no longer at the live
//      edge, and nothing pulls it back);
//   2. a multi-segment turn re-anchors PER SEGMENT — there is no "final reply"
//      detection, each new segment is a new place to start reading;
//   3. a reader who scrolled somewhere of their own choosing is NEVER moved,
//      however much arrives while they are there (position is the whole
//      evidence — no wheel listeners, no scrolled-away flag);
//   4. a segment born at the live edge with no room below it is CLAMPED, not
//      achieved — and the same anchor keeps pulling as the content below grows
//      until the segment's top edge finally reaches the reading line. This is
//      the ordinary shape of a real reply (it is born at the bottom of the
//      scroller), so without it the feature would only ever work for replies
//      that arrive complete;
//   5. the anchor target is the REPLY's top edge, never the turn's: a long
//      prompt must not push the reply it belongs to out of sight (Woody's
//      explicit ruling).
//
// Driven end-to-end against the built app with a fake `codex` on PATH
// (helpers/fake-codex-source.mjs): it writes a rollout + SessionStart
// handshake, Sonata adopts and tails it, and this fence appends real
// `agent_message` records — the tailer → codex-normalizer → reducer →
// renderRuns path a live reply takes. Consecutive agent_messages with no
// intervening `task_started` land in ONE turn, which is exactly the
// multi-segment turn property 2 is about.
//
// Fixture provenance:
//   · the rollout records: ADAPTED from tests/e2e/compaction-marker.mjs (same
//     fake rollout, same append), shapes pinned by codex-normalizer.ts and
//     written by the fake codex itself;
//   · the reply bodies and the long prompt: COMPOSED — sized only for height;
//     no provider output is being imitated;
//   · growing the transcript BELOW a clamped segment by inflating its settled
//     turn card in place: ADAPTED from tests/e2e/reading-scroll-during-render.mjs,
//     which grows a keyed card the same way to stand in for stream growth
//     without a live provider.
//
//   npm run e2e:reading-reply-anchor

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { _electron as electron } from "playwright-core";
import { FAKE_CODEX_SOURCE } from "./helpers/fake-codex-source.mjs";

const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "sonata-reply-anchor-"));
const codexHome = fs.mkdtempSync(path.join(os.tmpdir(), "sonata-reply-anchor-home-"));
const fakeBinDir = fs.mkdtempSync(path.join(os.tmpdir(), "sonata-reply-anchor-bin-"));
const folder = fs.mkdtempSync(path.join(os.tmpdir(), "sonata-reply-anchor-folder-"));

fs.writeFileSync(path.join(fakeBinDir, "codex"), FAKE_CODEX_SOURCE, { mode: 0o755 });
fs.chmodSync(path.join(fakeBinDir, "codex"), 0o755);

/** Where an anchored segment's top edge must land, below the scroll-edge fade
 *  and the sticky prompt pill (READING_ANCHOR_TOP_INSET_PX). */
const READING_LINE = 40;
const TOLERANCE = 2;

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

  const created = await page.evaluate(
    async (cwd) => window.sonataRuntime.createTask({ provider: "codex", cwd }),
    folder,
  );
  const taskId = created.task.id;
  const row = page.locator(`.sidebar-session[data-task-id="${taskId}"]`);
  await row.waitFor({ state: "visible" });
  await row.click();

  let rolloutPath = null;
  await waitFor(() => {
    rolloutPath = readSources(taskId)[0]?.path ?? null;
    return Boolean(rolloutPath) && fs.existsSync(rolloutPath);
  }, "codex handshake (transcript source + rollout on disk)");

  // A long prompt, then a first reply. The prompt is what property 5 is about:
  // it is taller than the viewport, so anchoring the TURN would hide the reply
  // completely.
  appendPrompt(rolloutPath, 40);
  appendReply(rolloutPath, 1, 120);
  await waitForSegments(page, 1);
  await settle(page);

  // ——— 1. A new segment lands at the reading line, and tail-follow retires.
  await scrollToBottom(page);
  appendReply(rolloutPath, 2, 120);
  await waitForSegments(page, 2);
  await settle(page);
  const anchored = await segmentGeometry(page, 2);
  results.anchoredSegment = anchored;
  checks.newSegmentLandsAtReadingLine = Math.abs(anchored.topInViewport - READING_LINE) <= TOLERANCE;
  assert(
    checks.newSegmentLandsAtReadingLine,
    `the new segment's top edge is at the reading line (${JSON.stringify(anchored)})`,
  );
  checks.tailFollowRetires = anchored.distanceFromBottom > 200;
  assert(
    checks.tailFollowRetires,
    `the view holds at the anchor instead of the live edge (${JSON.stringify(anchored)})`,
  );

  // ——— 5. The anchor is the REPLY's top, not the turn's. The prompt above it is
  // taller than the viewport, so a turn-level anchor would leave the reply off
  // screen entirely.
  const promptGeometry = await page.evaluate(() => {
    const list = document.querySelector("#run-list");
    const prompt = list.querySelector(".turn-user-text");
    return {
      promptHeight: prompt.getBoundingClientRect().height,
      promptTopInViewport: prompt.getBoundingClientRect().top - list.getBoundingClientRect().top,
      viewportHeight: list.clientHeight,
    };
  });
  results.promptGeometry = promptGeometry;
  checks.promptIsTallerThanViewport = promptGeometry.promptHeight > promptGeometry.viewportHeight;
  checks.anchorTargetsReplyNotTurn =
    checks.promptIsTallerThanViewport && promptGeometry.promptTopInViewport < 0;
  assert(
    checks.anchorTargetsReplyNotTurn,
    `a prompt taller than the viewport is scrolled past, not anchored (${JSON.stringify(promptGeometry)})`,
  );

  // ——— 2. Multi-segment turn: each new segment re-anchors, in the SAME turn.
  appendReply(rolloutPath, 3, 120);
  await waitForSegments(page, 3);
  await settle(page);
  const reanchored = await segmentGeometry(page, 3);
  results.reanchoredSegment = reanchored;
  checks.multiSegmentReanchors = Math.abs(reanchored.topInViewport - READING_LINE) <= TOLERANCE;
  assert(
    checks.multiSegmentReanchors,
    `the next segment of the same turn re-anchors (${JSON.stringify(reanchored)})`,
  );
  const turnCards = await page.locator("#run-list .turn-card").count();
  checks.segmentsShareOneTurn = turnCards === 1;
  assert(checks.segmentsShareOneTurn, `all three segments are one turn (${turnCards} cards)`);

  // ——— 3. A reader who scrolled away is never moved.
  await scrollTo(page, 0);
  appendReply(rolloutPath, 4, 120);
  await waitForSegments(page, 4);
  await settle(page);
  await page.waitForFunction(
    (expected) =>
      document.querySelectorAll("#run-list .turn-answer > [data-block-key]").length === expected,
    4,
  );
  const afterScrolledAway = await metrics(page);
  results.afterScrolledAway = afterScrolledAway;
  checks.scrolledAwayReaderIsNotMoved = afterScrolledAway.scrollTop === 0;
  assert(
    checks.scrolledAwayReaderIsNotMoved,
    `a reader parked in history stays there (${JSON.stringify(afterScrolledAway)})`,
  );

  // ——— 4. A segment born at the live edge is clamped, and the SAME anchor
  // keeps pulling until it lands. This is the ordinary shape of a real reply:
  // it appears at the bottom of the scroller with nothing beneath it yet.
  await scrollToBottom(page);
  appendReply(rolloutPath, 5, 1);
  await waitForSegments(page, 5);
  await settle(page);
  const born = await segmentGeometry(page, 5);
  results.bornAtLiveEdge = born;
  checks.segmentBornAtLiveEdgeIsClamped =
    born.topInViewport > READING_LINE + 100 && born.distanceFromBottom <= 64;
  assert(
    checks.segmentBornAtLiveEdgeIsClamped,
    `a segment with no room below it clamps to the bottom (${JSON.stringify(born)})`,
  );

  // Content grows below it (the stream continuing), and renders keep coming.
  await page.evaluate(() => {
    const card = document.querySelector("#run-list .turn-card");
    card.style.minHeight = `${card.getBoundingClientRect().height + 1400}px`;
  });
  const readingSettings = page.locator("#reading-settings");
  await readingSettings.click();
  await readingSettings.click();
  await settle(page);
  const converged = await segmentGeometry(page, 5);
  results.converged = converged;
  checks.clampedAnchorConvergesAsContentGrows =
    Math.abs(converged.topInViewport - READING_LINE) <= TOLERANCE;
  assert(
    checks.clampedAnchorConvergesAsContentGrows,
    `the clamped anchor lands once there is room (${JSON.stringify(converged)})`,
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
  for (const dir of [workspaceRoot, codexHome, fakeBinDir, folder]) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function appendPrompt(rolloutPath, lines) {
  const body = [];
  for (let line = 1; line <= lines; line += 1) {
    body.push(`prompt line ${line}`);
  }
  fs.appendFileSync(
    rolloutPath,
    `${JSON.stringify({
      timestamp: new Date().toISOString(),
      type: "event_msg",
      payload: { type: "user_message", message: body.join("\n") },
    })}\n`,
  );
}

function appendReply(rolloutPath, index, lines) {
  const body = [`## Reply ${index}`];
  for (let line = 1; line <= lines; line += 1) {
    body.push(`reply ${index} line ${line}`);
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

async function waitForSegments(page, count) {
  await page.waitForFunction(
    (expected) =>
      document.querySelectorAll("#run-list .turn-answer > [data-block-key]").length >= expected,
    count,
  );
}

/** Geometry of the nth (1-based) answer segment, in the scroller's viewport. */
async function segmentGeometry(page, index) {
  return page.evaluate((position) => {
    const list = document.querySelector("#run-list");
    const segments = list.querySelectorAll(".turn-answer > [data-block-key]");
    const node = segments[position - 1];
    const listRect = list.getBoundingClientRect();
    return {
      index: position,
      count: segments.length,
      blockKey: node.dataset.blockKey,
      topInViewport: node.getBoundingClientRect().top - listRect.top,
      scrollTop: list.scrollTop,
      distanceFromBottom: Math.max(0, list.scrollHeight - list.scrollTop - list.clientHeight),
    };
  }, index);
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

async function scrollTo(page, top) {
  await page.evaluate((target) => {
    const runList = document.querySelector("#run-list");
    runList.scrollTop = target;
    runList.dispatchEvent(new Event("scroll"));
  }, top);
  await settle(page);
}

async function scrollToBottom(page) {
  await page.evaluate(() => {
    const runList = document.querySelector("#run-list");
    runList.scrollTop = runList.scrollHeight;
    runList.dispatchEvent(new Event("scroll"));
  });
  await settle(page);
}

/** Let the transcript debounce (160 ms) and its render land. */
async function settle(page) {
  await page.waitForTimeout(400);
  await page.evaluate(
    () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
  );
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
    throw new Error(`Reply-anchor assertion failed: ${label}`);
  }
}
