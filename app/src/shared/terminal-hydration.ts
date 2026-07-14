/**
 * Stitching a mid-stream terminal hydration.
 *
 * When the terminal window creates a fresh xterm for a task that is already
 * streaming, it hydrates from the main-process headless mirror: it `await`s a
 * replay snapshot while live `pty:data` keeps arriving. The renderer buffers
 * those live chunks (rather than dropping them) and, once the snapshot lands,
 * stitches them onto its tail — writing the snapshot body, then only the
 * buffered chunks the snapshot does not already contain.
 *
 * This module is the pure decision core of that stitch — no xterm, no DOM — so
 * the no-loss / no-duplication contract is unit-provable in isolation. Task ids
 * persist across runtime reopen, so the snapshot and tail also carry a
 * main-process-monotonic TerminalHost generation. Only the newest generation
 * represented on either side may contribute bytes.
 *
 * The invariant, from the seq-tagged mirror: every live chunk carries its
 * 0-based ingest `seq`, and `snapshot.seq` is the count of chunks already folded
 * into the snapshot (== the seq of the first chunk NOT in it). So a buffered
 * chunk belongs to the tail — and must be written — iff `chunk.seq >=
 * snapshot.seq`:
 *   - `seq <  snapshot.seq` → already in the snapshot body → skip (else duplicate)
 *   - `seq >= snapshot.seq` → the gap the old drop-during-hydration lost → write
 * Contiguous, exactly once, by construction.
 */

/** A live `pty:data` chunk the renderer buffered while hydrating: the raw bytes
 *  plus the mirror's ingest seq that tags them. */
export interface HydrationChunk {
  generation: number;
  data: string;
  seq: number;
}

export interface HydrationSnapshot {
  generation: number;
  data: string;
  seq: number;
}

/** The newest runtime represented by either side of an in-flight replay. Main
 *  assigns generations monotonically, so a reopen that races hydration wins
 *  without relying on task id, IPC arrival timing, or a late exit event. */
export function hydrationGeneration(
  snapshot: HydrationSnapshot | null,
  buffered: readonly HydrationChunk[],
): number | null {
  let generation = snapshot?.generation ?? null;
  for (const chunk of buffered) {
    generation = generation === null ? chunk.generation : Math.max(generation, chunk.generation);
  }
  return generation;
}

/**
 * Compute the exact writes to apply when a hydrating terminal receives its
 * replay snapshot: the snapshot body first, then every buffered chunk at or
 * beyond the snapshot's seq boundary, in buffer order.
 *
 * A null snapshot (the task had no live mirror to replay) contributes no body
 * and a seq floor of 0, so every buffered chunk is written — strictly better
 * than the old "start blank and tail forward".
 *
 * Pure: callers apply the returned strings via `terminal.write` in order.
 */
export function stitchHydration(
  snapshot: HydrationSnapshot | null,
  buffered: readonly HydrationChunk[],
): string[] {
  const generation = hydrationGeneration(snapshot, buffered);
  const compatibleSnapshot = snapshot?.generation === generation ? snapshot : null;
  const seqFloor = compatibleSnapshot ? compatibleSnapshot.seq : 0;
  const writes: string[] = [];
  if (compatibleSnapshot) {
    writes.push(compatibleSnapshot.data);
  }
  for (const chunk of buffered) {
    if (chunk.generation === generation && chunk.seq >= seqFloor) {
      writes.push(chunk.data);
    }
  }
  return writes;
}
