/**
 * Typed errors for the main process. A typed error is an honest
 * contract: consumers (e.g. the Local API mapping a lookup failure to
 * a protocol error code) match on the class, not on a message string
 * that can be reworded without warning.
 */

/** Thrown when a requested task/session cannot be located. */
export class TaskNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TaskNotFoundError";
  }
}

/**
 * Thrown when a task exists on disk (a persisted manifest) but has no live
 * PTY runtime — the caller asked to act on it as if running. Distinct from
 * TaskNotFoundError so the Local API can tell a companion "open it first"
 * (-32002 taskNotLive) instead of "it never existed" (-32001 taskNotFound).
 */
export class TaskNotLiveError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TaskNotLiveError";
  }
}
