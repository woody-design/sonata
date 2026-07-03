import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { RuntimeEvent } from "../shared/types";

/**
 * Env-gated runtime-event recorder (decomposition map §2.4). When
 * DUET_RUNTIME_EVENT_LOG names a directory, every RuntimeEvent broadcast to
 * the renderer is appended (JSONL) to one file per app instance — recorded
 * reality for the reading-core reducer's replay fixtures, and a standing
 * debug tool. Default off; must never interfere: any write failure disables
 * the recorder for the rest of the process.
 */
export function createRuntimeEventRecorder(
  targetDir: string | undefined,
): (event: RuntimeEvent) => void {
  if (!targetDir) {
    return () => {};
  }
  let file: string | null = null;
  let disabled = false;
  return (event) => {
    if (disabled) {
      return;
    }
    try {
      if (!file) {
        mkdirSync(targetDir, { recursive: true });
        file = join(targetDir, `runtime-events-${process.pid}-${Date.now()}.jsonl`);
      }
      appendFileSync(file, `${JSON.stringify({ at: Date.now(), event })}\n`);
    } catch (error) {
      disabled = true;
      console.error("[runtime-event-recorder] disabled after write failure:", error);
    }
  };
}
