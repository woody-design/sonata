import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const hover = require("../../dist/reading-core/sidebar-hover-card");

const enter = (state, taskId, now) =>
  hover.reduceSidebarHoverCard(state, { type: "row-enter", taskId, now });
const leave = (state, now) =>
  hover.reduceSidebarHoverCard(state, { type: "row-leave", now });
const timer = (state, now) =>
  hover.reduceSidebarHoverCard(state, { type: "timer", now });

{
  const idle = { kind: "idle" };
  const pending = enter(idle, "task-a", 1000);
  assert.deepEqual(pending, { kind: "pending", taskId: "task-a", openAt: 1500 });
  assert.strictEqual(timer(pending, 1499), pending, "the card cannot open before 500ms");
  assert.deepEqual(timer(pending, 1500), { kind: "open", taskId: "task-a" });
  assert.deepEqual(leave(pending, 1200), { kind: "idle" }, "early leave cancels dwell");
}

{
  const openA = { kind: "open", taskId: "task-a" };
  assert.deepEqual(
    enter(openA, "task-b", 2000),
    { kind: "open", taskId: "task-b" },
    "an open card relocates directly without pending/idle",
  );
  assert.strictEqual(enter(openA, "task-a", 2000), openA, "same-owner enter is a no-op");
}

{
  const warm = leave({ kind: "open", taskId: "task-a" }, 3000);
  assert.deepEqual(warm, { kind: "warm", until: 3250 });
  assert.deepEqual(
    enter(warm, "task-b", 3249),
    { kind: "open", taskId: "task-b" },
    "the 250ms warm window opens immediately",
  );
  assert.deepEqual(
    enter(warm, "task-b", 3251),
    { kind: "pending", taskId: "task-b", openAt: 3751 },
    "an expired warm window restores deliberate dwell",
  );
}

{
  const open = { kind: "open", taskId: "task-a" };
  assert.deepEqual(
    hover.reduceSidebarHoverCard(open, { type: "dismiss" }),
    { kind: "idle" },
    "forced dismissal clears ownership and warmth",
  );
}

console.log("sidebar-hover-card-core: 500ms dwell + 250ms warm + direct relocation + dismiss pass");
