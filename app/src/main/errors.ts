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
