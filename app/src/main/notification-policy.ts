import type { RuntimeEvent } from "../shared/types/events";
import type { CliActivity } from "../shared/types/cli-signal";

/**
 * The native-notification decision layer — pure, Electron-free, deterministic.
 *
 * A notification is the OUT-OF-APP channel of an attention signal Duet already
 * renders in-app (the attention banners, the "finished while away" dot). We do
 * NOT gate on window focus: a focused window is a poor proxy for a present human
 * (you can walk away leaving it up), and the error is asymmetric — suppressing a
 * notification you needed (you'd left) costs far more than a redundant ping you
 * can ignore. So the only "am I still watching?" heuristic is TIME: a reply that
 * comes back inside `completeFloorMs` almost certainly found you still at the
 * keyboard (you just hit send), so it stays silent.
 *
 * Two user-facing moments, matching the converged Complete/Request grammar:
 *  - `complete`  — the turn ended (`cli-state:changed → turn-ended`), and it ran
 *                  long enough that you may have drifted away. Failed turns land
 *                  here too (StopFailure → turn-ended), so a silent failure still
 *                  reaches you as "your turn."
 *  - `needs-you` — the agent is blocked on a decision: an approval
 *                  (`approval:detected`) or a multiple-choice question
 *                  (`option-prompt:detected`). No floor — a block is worth
 *                  surfacing whenever it happens.
 *
 * This layer only READS the already-settled signals and returns a decision; it
 * writes nothing back into app state. Keeping it a pure leaf is deliberate — a
 * consumer that fed state back would become an actor in the state machine.
 */

export type NotificationKind = "complete" | "needs-you";

export interface NotificationDecision {
  kind: NotificationKind;
  taskId: string;
  /** What drove a `needs-you` (or the `turn-ended` for complete). Reserved for
   *  future copy differentiation / telemetry; the MVP body is uniform per kind. */
  reason: "turn-ended" | "approval" | "option-prompt";
}

interface TaskState {
  activity: CliActivity | null;
  /** Epoch ms when the current turn entered `busy` from a resting state; null
   *  when we never observed this turn start (a resumed/boot session). */
  turnStartedAt: number | null;
  /** True once a genuine busy→…→turn-ended arc is in flight. Gates `complete`
   *  so a resume/boot `turn-ended` with no observed start never fires. */
  turnArmed: boolean;
  /** Ask ids already notified within the current turn (fire-once dedup). */
  notifiedAsks: Set<string>;
}

/** Below this, a completed turn stays silent — you were almost certainly still
 *  watching (you just hit send). ~Nielsen's 10–30s task-switch knee. */
const DEFAULT_COMPLETE_FLOOR_MS = 30_000;

export class NotificationPolicy {
  private readonly floorMs: number;
  private readonly tasks = new Map<string, TaskState>();

  constructor(opts: { completeFloorMs?: number } = {}) {
    this.floorMs = opts.completeFloorMs ?? DEFAULT_COMPLETE_FLOOR_MS;
  }

  /** Feed every runtime event; returns a decision to notify, or null. */
  observe(event: RuntimeEvent): NotificationDecision | null {
    switch (event.type) {
      case "cli-state:changed":
        return this.onCliState(event.payload.taskId, event.payload.activity, event.ts);
      case "approval:detected":
        // A resurfaced approval is the same ask re-rendered after a broker
        // timeout — the user hasn't been asked anything new. Stay quiet.
        if (event.payload.resurfacedAfterDecision) {
          return null;
        }
        return this.onAsk(
          event.payload.taskId,
          askId(
            "approval",
            event.payload.approvalId,
            event.payload.fingerprintHash,
            event.payload.runId,
          ),
          "approval",
        );
      case "option-prompt:detected":
        return this.onAsk(event.payload.taskId, askId("option", event.payload.toolUseId), "option-prompt");
      default:
        return null;
    }
  }

  private onCliState(taskId: string, activity: CliActivity, ts: string): NotificationDecision | null {
    const state = this.stateFor(taskId);
    const prev = state.activity;
    state.activity = activity;

    // A fresh turn begins on entering `busy` from a resting state. Re-entering
    // `busy` from `waiting-approval` is the SAME turn resuming after the user
    // answered, so the turn clock must NOT reset (a turn with an approval is a
    // long turn — that is the point).
    if (activity === "busy" && prev !== "busy" && prev !== "waiting-approval") {
      state.turnStartedAt = parseTs(ts);
      state.turnArmed = true;
      state.notifiedAsks.clear();
      return null;
    }

    if (activity === "turn-ended") {
      const startedAt = state.turnStartedAt;
      const armed = state.turnArmed;
      // Disarm regardless: one notification per turn, immune to a re-emitted
      // turn-ended (the idle heuristic can fire it more than once).
      state.turnStartedAt = null;
      state.turnArmed = false;
      if (!armed || startedAt === null) {
        return null;
      }
      const endedAt = parseTs(ts);
      if (endedAt === null || endedAt - startedAt < this.floorMs) {
        return null;
      }
      return { kind: "complete", taskId, reason: "turn-ended" };
    }

    if (activity === "idle") {
      state.turnStartedAt = null;
      state.turnArmed = false;
    }
    return null;
  }

  private onAsk(
    taskId: string,
    id: string,
    reason: "approval" | "option-prompt",
  ): NotificationDecision | null {
    const state = this.stateFor(taskId);
    if (state.notifiedAsks.has(id)) {
      return null;
    }
    state.notifiedAsks.add(id);
    return { kind: "needs-you", taskId, reason };
  }

  private stateFor(taskId: string): TaskState {
    let state = this.tasks.get(taskId);
    if (!state) {
      state = { activity: null, turnStartedAt: null, turnArmed: false, notifiedAsks: new Set() };
      this.tasks.set(taskId, state);
    }
    return state;
  }
}

/** First non-empty id wins, namespaced by source so an approval and an
 *  option-prompt can never collide on a shared underlying id. */
function askId(prefix: string, ...parts: Array<string | null | undefined>): string {
  const key = parts.find((part) => typeof part === "string" && part.length > 0);
  return `${prefix}:${key ?? "anon"}`;
}

function parseTs(ts: string): number | null {
  const ms = Date.parse(ts);
  return Number.isNaN(ms) ? null : ms;
}
