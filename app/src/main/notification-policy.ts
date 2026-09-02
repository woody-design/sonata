import type { RuntimeEvent } from "../shared/types/events";
import type { CliActivity } from "../shared/types/cli-signal";
import type { TurnEndWake } from "../shared/types/domain";

/**
 * The native-notification decision layer — pure, Electron-free, deterministic.
 *
 * A notification is the OUT-OF-APP channel of an attention signal Sonata already
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
 *                  reaches you as "your turn." A turn end that the CLI itself
 *                  declared PROVISIONAL — background work in flight that will
 *                  wake the session (SL-16) — is not that moment and does not
 *                  fire one; see `onCliState`.
 *  - `needs-you` — the agent is blocked and the user must act: an approval
 *                  (`approval:detected`), a multiple-choice question
 *                  (`option-prompt:detected`), or codex hooks failing to go
 *                  live (`cli-hooks:liveness → missing` — a pending trust
 *                  ceremony or a hookless-degraded spawn, where a native
 *                  approval has no card channel and must be answered in the
 *                  Terminal). No floor — a block is worth surfacing whenever it
 *                  happens.
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
  reason: "turn-ended" | "approval" | "option-prompt" | "hooks-missing";
}

interface TaskState {
  activity: CliActivity | null;
  /** Epoch ms when the current turn entered `busy` from a resting state; null
   *  when we never observed this turn start (a resumed/boot session). */
  turnStartedAt: number | null;
  /** True once a genuine busy→…→turn-ended arc is in flight. Gates `complete`
   *  so a resume/boot `turn-ended` with no observed start never fires. */
  turnArmed: boolean;
  /**
   * SL-16: when a turn end left NEW background work in flight, the moment that
   * arc STARTED — i.e. when the user last submitted before the session paused.
   * Null when no wake is being awaited.
   *
   * A SECOND clock beside `turnStartedAt`, and the two answer different
   * questions. `turnStartedAt` is "how long has THIS turn run" and always
   * restarts on a new turn; this is "how long has the user been away from the
   * request that is still unfinished". The wake's own turn is ~2s long, so
   * measuring it against `turnStartedAt` would silently drop the ping the whole
   * slice exists to deliver; measuring an ordinary interleaved turn against THIS
   * one would ping "finished" while the user sat at the keyboard (review B1,
   * secondary). Keeping both is what lets each turn end pick the honest one.
   */
  wakeArcStartedAt: number | null;
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
        return this.onCliState(
          event.payload.taskId,
          event.payload.activity,
          event.ts,
          event.payload.turnEndWake ?? null,
        );
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
      case "cli-hooks:liveness":
        // Hooks not live (codex): the SessionStart handshake never arrived
        // within the window — the hook shim failed to fire (e.g. interpreter not
        // on PATH), OR the spawn degraded hookless. (D4 overturned: hooks bypass
        // trust review, so this is no longer a pending trust ceremony.) Either
        // way the user must go to the Terminal:
        // there is NO card channel for a native approval in this state (S4), so
        // hooks-missing IS a genuine needs-you. Fire-once per task (the id is
        // stable), so a re-emitted `missing` does not re-notify.
        if (event.payload.status !== "missing") {
          return null;
        }
        return this.onAsk(event.payload.taskId, askId("hooks-missing", event.payload.taskId), "hooks-missing");
      default:
        return null;
    }
  }

  private onCliState(
    taskId: string,
    activity: CliActivity,
    ts: string,
    turnEndWake: TurnEndWake | null,
  ): NotificationDecision | null {
    const state = this.stateFor(taskId);
    const prev = state.activity;
    state.activity = activity;

    // A fresh turn begins on entering `busy` from a resting state. Re-entering
    // `busy` from `waiting-approval` is the SAME turn resuming after the user
    // answered, so the turn clock must NOT reset (a turn with an approval is a
    // long turn — that is the point).
    //
    // A wake needs NO carve-out here, and that is the point of the second clock:
    // the wake's turn is a real new turn and gets its own `turnStartedAt` like
    // any other, while `wakeArcStartedAt` remembers the unfinished request
    // underneath it. An earlier cut suppressed the reset instead, which handed a
    // human's 3s interleaved turn the paused arc's ancient clock and pinged
    // "finished" at someone sitting right there (review B1, secondary).
    if (activity === "busy" && prev !== "busy" && prev !== "waiting-approval") {
      state.turnStartedAt = parseTs(ts);
      state.turnArmed = true;
      state.notifiedAsks.clear();
      return null;
    }

    if (activity === "turn-ended") {
      // THE HELD PING (SL-16). The CLI's own turn-end payload says a shell (or
      // subagent, teammate, workflow…) that THIS turn started is still running
      // and WILL wake this session. "Your turn" is exactly what that is not:
      // nothing is being asked of the user, and the work they asked for is not
      // finished. Before this, Sonata fired `complete` here AND again ~70s later
      // when the revival's own turn ended — one request, two "task complete"
      // pings, the first of them false (F47, measured 4/4).
      //
      // `opened`, NOT "anything in flight" (review B1). `background_tasks` is
      // SESSION state, so a dev server or a watcher sits in it for the rest of
      // the session; holding on mere non-emptiness would swallow every
      // completion ping from then on — a regression against pre-slice behaviour,
      // and a far worse failure than the double-fire it was fixing. Only work a
      // turn newly left behind can pause that turn.
      //
      // Held, not cancelled: the arc's start is remembered so the ping fires ONCE
      // at whichever turn end is genuinely final, measured from the submit the
      // user is still waiting on. The residual, stated rather than hidden: if the
      // launching turn's work NEVER returns (that dev server), its own ping never
      // fires. That is one ping on one turn — every later turn in the session
      // pings normally, because none of them opened anything.
      if (turnEndWake?.opened) {
        state.wakeArcStartedAt ??= state.turnStartedAt;
        return null;
      }
      // Which clock? If work we were awaiting came back, this turn end is the
      // resolution of that arc and the honest elapsed time runs from the arc's
      // own start — the wake's turn is ~2s long and would never clear the floor
      // on its own. Otherwise this is an ordinary turn and measures itself.
      const resolvingArc = Boolean(turnEndWake?.returned) && state.wakeArcStartedAt !== null;
      const startedAt = resolvingArc ? state.wakeArcStartedAt : state.turnStartedAt;
      const armed = state.turnArmed;
      // Disarm regardless: one notification per turn, immune to a re-emitted
      // turn-ended (the idle heuristic can fire it more than once).
      state.turnStartedAt = null;
      state.turnArmed = false;
      // The ARC, though, survives turn ends that are none of its business. A
      // user's interleaved turn while the background job is still running must
      // not consume the arc — clearing it here would leave the eventual wake
      // measuring its own ~2s turn and silently drop the ping this slice exists
      // to deliver. (Caught by the interleaved-turn fence, which is exactly why
      // the review made it mandatory.) Only the arc's own resolution ends it —
      // or a dead PTY, below.
      if (resolvingArc) {
        state.wakeArcStartedAt = null;
      }
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
      // A dead PTY is the one thing that makes a wake impossible: nothing can
      // re-enter a session that no longer exists, so the held arc is dropped
      // rather than left waiting forever.
      state.wakeArcStartedAt = null;
    }
    return null;
  }

  private onAsk(
    taskId: string,
    id: string,
    reason: "approval" | "option-prompt" | "hooks-missing",
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
      state = {
        activity: null,
        turnStartedAt: null,
        turnArmed: false,
        wakeArcStartedAt: null,
        notifiedAsks: new Set(),
      };
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
