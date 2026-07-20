import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const cascade = require("../../dist/reading-core/cascade-menu");
const transitions = require("../../dist/reading-core/transitions/sidebar");
const { createInitialState } = require("../../dist/reading-core/state");

const RECT = { left: 10, top: 20, right: 30, bottom: 40, width: 20, height: 20 };

function freshState() {
  return createInitialState({ theme: "default", mode: "light", textStep: 16 });
}

// Open-path and editor state are durable product state. Every transition keeps
// the session root identity/anchor while draft, validation, and IME ownership
// survive unrelated state mutations.
{
  const state = freshState();
  transitions.openSessionMenu(state, "task-1", "A task", false, RECT);
  assert.deepEqual(state.sidebar.menu, {
    kind: "session",
    taskId: "task-1",
    title: "A task",
    archived: false,
    renameSurface: "sidebar",
    anchor: RECT,
    tagsOpen: false,
    group: null,
    input: null,
  });
  assert.equal(transitions.openSessionTags(state), true);
  assert.equal(transitions.openSessionTagGroup(state, "type"), true);
  assert.equal(transitions.enterSessionTagInput(state, "type"), true);
  transitions.updateSessionTagInput(state, {
    draft: "Long lived draft",
    error: "Duplicate",
    composing: true,
  });
  state.status = "background update";
  assert.equal(state.sidebar.menu.tagsOpen, true);
  assert.equal(state.sidebar.menu.group, "type");
  assert.deepEqual(state.sidebar.menu.input, {
    group: "type",
    draft: "Long lived draft",
    error: "Duplicate",
    composing: true,
  });
  assert.equal(transitions.cancelSessionTagInput(state), true);
  assert.equal(state.sidebar.menu.input, null);
  assert.equal(state.sidebar.menu.group, "type", "editor Escape keeps the option level");
  assert.equal(transitions.closeSessionTagGroup(state), true);
  assert.equal(state.sidebar.menu.group, null);
  assert.equal(state.sidebar.menu.tagsOpen, true, "option Escape keeps the group panel");
  assert.equal(transitions.closeSessionTags(state), true);
  assert.equal(state.sidebar.menu.tagsOpen, false);
}

// Side placement: right-start, left flip, vertical clamp, max-height sizing,
// and neither-side-fit overlap are pure table-driven policy.
{
  const viewport = { left: 0, top: 0, right: 1000, bottom: 700 };
  assert.deepEqual(
    cascade.calculateCascadePlacement(
      { left: 100, top: 100, right: 200, bottom: 130, width: 100, height: 30 },
      { width: 180, height: 240 },
      viewport,
    ),
    { side: "right", left: 204, top: 100, availableHeight: 592 },
  );
  assert.equal(
    cascade.calculateCascadePlacement(
      { left: 850, top: 100, right: 950, bottom: 130, width: 100, height: 30 },
      { width: 180, height: 240 },
      viewport,
    ).side,
    "left",
  );
  const clamped = cascade.calculateCascadePlacement(
    { left: 300, top: 660, right: 400, bottom: 690, width: 100, height: 30 },
    { width: 180, height: 240 },
    viewport,
  );
  assert.equal(clamped.top, 452);
  assert.equal(clamped.availableHeight, 240);
  const tall = cascade.calculateCascadePlacement(
    { left: 300, top: 40, right: 400, bottom: 70, width: 100, height: 30 },
    { width: 180, height: 900 },
    viewport,
  );
  assert.equal(tall.top, 8);
  assert.equal(tall.availableHeight, 684);
  const overlap = cascade.calculateCascadePlacement(
    { left: 40, top: 20, right: 60, bottom: 50, width: 20, height: 30 },
    { width: 180, height: 120 },
    { left: 0, top: 0, right: 200, bottom: 300 },
  );
  assert.equal(overlap.left, 12, "neither side fits, so the panel clamps on-screen");
  assert.equal(overlap.side, "right", "the side with more usable width wins");
}

// Direction-aware grace works on both physical sides and expires. Reversing
// direction deliberately defeats protection even while inside the polygon.
{
  const rightChild = { left: 110, top: 40, right: 260, bottom: 240, width: 150, height: 200 };
  const right = {
    polygon: cascade.buildPointerGracePolygon({ x: 100, y: 100 }, rightChild, "right"),
    side: "right",
    expiresAt: 1300,
  };
  assert.equal(
    cascade.pointerGraceProtects(right, { x: 101, y: 100 }, { x: 108, y: 102 }, 1100),
    true,
  );
  assert.equal(
    cascade.pointerGraceProtects(right, { x: 109, y: 102 }, { x: 105, y: 103 }, 1100),
    false,
    "right-side pointer reversal cancels grace",
  );
  assert.equal(
    cascade.pointerGraceProtects(right, { x: 101, y: 100 }, { x: 108, y: 102 }, 1301),
    false,
    "expired right-side grace is inert",
  );

  const leftChild = { left: 20, top: 40, right: 170, bottom: 240, width: 150, height: 200 };
  const left = {
    polygon: cascade.buildPointerGracePolygon({ x: 180, y: 100 }, leftChild, "left"),
    side: "left",
    expiresAt: 1300,
  };
  assert.equal(
    cascade.pointerGraceProtects(left, { x: 179, y: 100 }, { x: 172, y: 102 }, 1100),
    true,
  );
  assert.equal(
    cascade.pointerGraceProtects(left, { x: 171, y: 102 }, { x: 176, y: 103 }, 1100),
    false,
    "left-side pointer reversal cancels grace",
  );
}

console.log("sidebar-tag-menu-core: state/openPath/draft + placement + direction-aware polygon pass");
