import assert from "node:assert/strict";
import { createRequire } from "node:module";

// Pure planner — require directly (no DOM, no node-pty).
const require = createRequire(import.meta.url);
const { planKeyedReconcile } = require("../../dist/shared/keyed-reconcile");

const E = (key, sig) => ({ key, sig });
const actions = (plan) => plan.ordered.map((s) => `${s.key}:${s.action}`);
const order = (plan) => plan.ordered.map((s) => s.key);

// 1) create — empty existing → everything renders, nothing removed.
{
  const plan = planKeyedReconcile([], [E("a", "1"), E("b", "1")]);
  assert.deepEqual(actions(plan), ["a:render", "b:render"]);
  assert.deepEqual(plan.removed, []);
}

// 2) reuse — identical keys + sigs → all reuse (selection survives).
{
  const existing = [E("a", "1"), E("b", "1"), E("c", "1")];
  const plan = planKeyedReconcile(existing, existing);
  assert.deepEqual(actions(plan), ["a:reuse", "b:reuse", "c:reuse"]);
  assert.deepEqual(plan.removed, []);
}

// 3) changed — one sig differs (the streaming/just-completed turn) → only it
//    renders; the stable siblings reuse.
{
  const plan = planKeyedReconcile(
    [E("a", "1"), E("b", "1"), E("c", "1")],
    [E("a", "1"), E("b", "2"), E("c", "1")],
  );
  assert.deepEqual(actions(plan), ["a:reuse", "b:render", "c:reuse"]);
  assert.deepEqual(plan.removed, []);
}

// 4) remove — a key disappears → listed in removed, others reuse.
{
  const plan = planKeyedReconcile([E("a", "1"), E("b", "1")], [E("a", "1")]);
  assert.deepEqual(actions(plan), ["a:reuse"]);
  assert.deepEqual(plan.removed, ["b"]);
}

// 5) insert in the middle — new key renders, neighbours reuse, order preserved.
{
  const plan = planKeyedReconcile(
    [E("a", "1"), E("c", "1")],
    [E("a", "1"), E("b", "1"), E("c", "1")],
  );
  assert.deepEqual(order(plan), ["a", "b", "c"]);
  assert.deepEqual(actions(plan), ["a:reuse", "b:render", "c:reuse"]);
  assert.deepEqual(plan.removed, []);
}

// 6) reorder — same keys + sigs, different order → all reuse, plan follows the
//    desired order (the applier moves them; reorder is rare).
{
  const plan = planKeyedReconcile(
    [E("a", "1"), E("b", "1"), E("c", "1")],
    [E("c", "1"), E("a", "1"), E("b", "1")],
  );
  assert.deepEqual(order(plan), ["c", "a", "b"]);
  assert.deepEqual(actions(plan), ["c:reuse", "a:reuse", "b:reuse"]);
  assert.deepEqual(plan.removed, []);
}

// 7) the streaming scenario: stable turns reuse while the last (live) turn's
//    sig grows every batch → only the live turn re-renders.
{
  const stable = [E("t1", "s"), E("t2", "s")];
  let live = "v1";
  let plan = planKeyedReconcile([...stable, E("t3", live)], [...stable, E("t3", "v2")]);
  assert.deepEqual(actions(plan), ["t1:reuse", "t2:reuse", "t3:render"]);
  plan = planKeyedReconcile([...stable, E("t3", "v2")], [...stable, E("t3", "v3")]);
  assert.deepEqual(actions(plan), ["t1:reuse", "t2:reuse", "t3:render"]);
}

console.log("transcript-reconcile smoke: OK");
