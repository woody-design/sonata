import type { RuntimeEvent, Task } from "../shared/types";

/** A live runtime, seen through the only surface TaskMirror needs: the task
 *  record and where it persists. `ActiveTaskRuntime` satisfies this. */
export interface TaskMirrorTarget {
  task: Task;
  storageRoot: string;
}

/**
 * The single home of the "mirror a settled runtime-status change onto the task
 * record" discipline. A runtime-status refresh — claude permission mode, a codex
 * `/model` or `/permissions` receipt, the codex turn_context reconcile — is
 * METADATA, not activity:
 *
 *  - `updatedAt` stays put, so the sidebar's activity ordering never jumps on a
 *    mode/model chip repaint;
 *  - the manifest is persisted (default `session-updated` reason, which also
 *    emits `sessions:updated`);
 *  - exactly ONE `task:updated` (`reason: "runtime-status"`) is emitted, and
 *    ONLY when a patched field actually changed value.
 *
 * Callers own the provider-specific validation and derivation that turns a raw
 * payload into a `Partial<Task>` patch; TaskMirror owns the write. Before this
 * module the tail was copied at four sites (applyHookPermissionMode,
 * applyCodexPermissionSwitchReceipt, applyCodexModelSwitchReceipt,
 * reconcileCodexTurnContext), each re-deriving the change check and the emit.
 */
export class TaskMirror {
  constructor(
    private readonly persist: (task: Task, storageRoot: string) => void,
    private readonly emit: (event: RuntimeEvent) => void,
  ) {}

  /**
   * Apply `patch` to `target.task` in place, persist, and emit one
   * `task:updated`. A no-op that returns `false` when every patched field
   * already equals its current value — so a caller can hand over an idempotent
   * reconcile without pre-checking whether anything moved.
   */
  apply(target: TaskMirrorTarget, patch: Partial<Task>): boolean {
    const changed = (Object.keys(patch) as (keyof Task)[]).some(
      (key) => target.task[key] !== patch[key],
    );
    if (!changed) {
      return false;
    }
    target.task = { ...target.task, ...patch };
    this.persist(target.task, target.storageRoot);
    this.emit({
      type: "task:updated",
      payload: { taskId: target.task.id, task: target.task, reason: "runtime-status" },
      ts: new Date().toISOString(),
    });
    return true;
  }
}
