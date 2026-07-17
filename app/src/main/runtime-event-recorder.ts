import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { RuntimeEvent } from "../shared/types";

/**
 * Env-gated runtime-event recorder (decomposition map §2.4). When
 * SONATA_RUNTIME_EVENT_LOG names a directory, every RuntimeEvent broadcast to
 * the renderer is appended (JSONL) to one file per app instance — recorded
 * reality for the reading-core reducer's replay fixtures.
 *
 * Capture-mode semantics (test/dev only, review 2026-07-03): writes are
 * SYNCHRONOUS on the broadcast path by design — lossless and ordered, which
 * fixture fidelity requires; an async queue would need a drop policy, and a
 * corpus with holes is worse than a slightly slower capture run. Measured
 * overhead on a full e2e (run-reading-surface): 18 s with recorder vs 20 s
 * without — noise-level. Not intended to stay enabled in normal daily use.
 * Default off; must never interfere: any write failure disables the recorder
 * for the rest of the process. Captures are RAW (prompts, paths, account
 * strings included) — pin fixtures only through scripts/sanitize-runtime-corpus.mjs.
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
