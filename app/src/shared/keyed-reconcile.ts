/**
 * Pure keyed-reconcile planner (CLI Slice 2, Layer 3).
 *
 * Given the currently-rendered children (key + render signature) and the desired
 * children (key + signature), decide — for each desired child, in order —
 * whether its existing DOM node can be REUSED untouched (same key, same sig) or
 * must be (re)RENDERED, and which existing keys are REMOVED. The DOM applier
 * (renderer) does the positioning; this decision core is pure so it can be unit
 * tested (create / reuse / remove / reorder) without a DOM.
 *
 * "reuse" is the whole point of the slice: a node that is not re-created keeps
 * its text selection while a sibling turn streams.
 */

export interface KeyedEntry {
  key: string;
  /** A render signature: equal sig ⇒ identical rendered output ⇒ safe to reuse. */
  sig: string;
}

export type ReconcileAction = "reuse" | "render";

export interface ReconcilePlan {
  /** Desired children, in order, each tagged reuse|render. */
  ordered: { key: string; action: ReconcileAction }[];
  /** Existing keys no longer desired — their nodes are removed. */
  removed: string[];
}

export function planKeyedReconcile(
  existing: readonly KeyedEntry[],
  desired: readonly KeyedEntry[],
): ReconcilePlan {
  const existingSig = new Map(existing.map((e) => [e.key, e.sig]));
  const desiredKeys = new Set(desired.map((d) => d.key));
  const ordered = desired.map((d) => ({
    key: d.key,
    // reuse only when the key exists AND its signature is unchanged; a new key
    // or a changed signature (e.g. the streaming turn, or a turn that just
    // completed) renders fresh.
    action: (existingSig.get(d.key) === d.sig ? "reuse" : "render") as ReconcileAction,
  }));
  const removed = existing.filter((e) => !desiredKeys.has(e.key)).map((e) => e.key);
  return { ordered, removed };
}
