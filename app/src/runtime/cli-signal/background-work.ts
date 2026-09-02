/**
 * What a turn-end hook payload says about in-flight background work (SL-16,
 * upstream sync 2026-09 — findings F42/F47/F56, claude 2.1.258).
 *
 * THE SIGNAL. Claude's `Stop` (and `SubagentStop`) payload carries
 * `background_tasks` + `session_crons`, and the binary's own schema states the
 * purpose verbatim (STATIC, 2.1.258):
 *
 *   background_tasks — "In-flight background work (running/pending +
 *   backgrounded) registered in this session. Lets hooks distinguish 'session
 *   is done' from 'session is paused waiting for background work to wake it'.
 *   Empty array when nothing is in flight."
 *
 * MEASURED (probe `z1-background-wake`, 4/4 runs + a foreground control): a turn
 * that backgrounds a shell and ends carries `[{id, type:"shell",
 * status:"running", description, command}]` on its CLOSING `Stop`, the session
 * wakes ~69s later when the shell finishes, and the post-wake `Stop` carries
 * `[]`. The control — same turn, foreground shell — carries `[]` and never wakes.
 *
 * ── THE SENTENCE THAT DECIDES THE DESIGN: "registered in this session" ───────
 *
 * The array is SESSION state, not turn state. Every corroborating reading agrees:
 * the same array rides `SubagentStop` mid-turn, and the CLI's own footer counts
 * it as a standing session fact (`· 1 shell`). So "non-empty" cannot mean "this
 * turn is expecting a wake" — a long-lived task (a dev server, a file watcher, a
 * `tail -f`) is `status:"running"` for the REST OF THE SESSION and would make
 * every later turn end look paused. Keying a notification hold on non-emptiness
 * would silently swallow every completion ping for the rest of that session, and
 * stamp every card "waiting on background work" until the user quit.
 *
 * The honest question is therefore not "is anything in flight?" but "did THIS
 * turn end leave behind work that was not already running?" — which is a
 * question about IDENTITY OVER TIME, and needs memory. `readBackgroundWork` is
 * the pure per-payload read; {@link BackgroundWorkTracker} is the memory. Both
 * halves are needed and neither is useful alone.
 *
 * WHY THE ARRAY'S EMPTINESS IS STILL THE WHOLE MEMBERSHIP TEST, with no `status`
 * filtering of our own. The CLI filters before it emits (STATIC, 2.1.258): an
 * entry reaches the payload only if its status is `running` or `pending` AND it
 * is not explicitly un-backgrounded. So every entry that arrives is, by the
 * vendor's own definition, live background work. Re-deriving that from `status`
 * here would be Sonata second-guessing a filter it can read.
 *
 * WHY `session_crons` IS DELIBERATELY NOT A PAUSE. It is carried on the same
 * payloads and it also names future wakeups (`CronCreate`, `ScheduleWakeup`,
 * `/loop`), but the vendor's two descriptions differ in exactly the way that
 * matters: background work leaves the session "PAUSED waiting … to wake it",
 * while a cron merely "will wake this session later". A standing schedule is not
 * a paused turn — a session with a daily cron is DONE for today. Read here so
 * the fact is not lost, reported as its own field, and NOT folded into the pause.
 *
 * THREE-VALUED ON PURPOSE — `unstated` is not `none`. A payload that carries no
 * `background_tasks` key says NOTHING about background work, and absence must
 * never be read as "nothing in flight". This is the same lesson F44 taught on
 * `UserPromptSubmit.source` (specified, unemitted at 2.1.258, and its absence
 * must never read as `user`).
 *
 * Stated honestly, because the A/B measured it rather than assuming it: TODAY
 * every live caller is insensitive to the distinction. The turn-end hooks are
 * the only consumers, and claude's `Stop` always carries the field at 2.1.258
 * while codex's endings never do and never open a pause to cancel. The shape
 * that WOULD bite — claude's `Notification(idle_prompt)`, which fires 60s after
 * every turn end and reaches the same `turn-ended` state while carrying none of
 * these fields — is closed one layer up instead, by `CliStateModel.set`'s
 * keep-on-omit rule (A/B'd: inverting that rule alone breaks the pause). So the
 * third value is a CONTRACT, not a live fix: it is what stops the next consumer
 * — an older CLI's Stop, a Notification branch, an event not yet wired — from
 * inheriting "silence means done" for free.
 *
 * `readBackgroundWork` is pure and provider-agnostic, like its sibling
 * `tool-changes`: it reads only the payload, so codex — which carries neither
 * field — answers `unstated` everywhere and needs no provider gate.
 */

import type { HookPayload } from "../../shared/types/cli-signal";
import type { PendingWake, PendingWakeTask, TurnEndWake } from "../../shared/types/domain";

/**
 * The answer to "what did this payload say about background work?".
 *  - `unstated` — the payload carries no `background_tasks` field. Says nothing;
 *    leave whatever was already believed untouched.
 *  - `none` — the payload carries the field and it is EMPTY. Positive evidence
 *    that nothing is in flight.
 *  - `pending` — the field is non-empty. NOTE this is the raw session-scoped
 *    read: it does NOT yet mean this turn is expecting a wake. Only
 *    {@link BackgroundWorkTracker} can say that, because only it remembers what
 *    was already running.
 */
export type BackgroundWorkClaim =
  | { kind: "unstated" }
  | { kind: "none" }
  | { kind: "pending"; tasks: PendingWakeTask[] };

const UNSTATED: BackgroundWorkClaim = { kind: "unstated" };
const NONE: BackgroundWorkClaim = { kind: "none" };

/**
 * Read a turn-end payload's background-work claim. Never throws: a field of the
 * wrong shape is `unstated` (we were told something we cannot read, which is
 * indistinguishable from not being told), and an entry that names no id or kind
 * contributes an empty string rather than being dropped — losing a task from the
 * set would understate what is in flight.
 */
export function readBackgroundWork(payload: HookPayload): BackgroundWorkClaim {
  const tasks = payload.background_tasks;
  if (!Array.isArray(tasks)) {
    return UNSTATED;
  }
  if (tasks.length === 0) {
    return NONE;
  }
  return { kind: "pending", tasks: tasks.map(readTask) };
}

/**
 * Scheduled wakeups the same payload named (`session_crons`). Reported
 * separately from the pause on purpose — see the module note. Null when the
 * field is absent or unreadable, so "no crons" and "was not told" stay apart.
 */
export function readSessionCronCount(payload: HookPayload): number | null {
  const crons = payload.session_crons;
  return Array.isArray(crons) ? crons.length : null;
}

/**
 * The memory that turns the session-scoped `background_tasks` array into a
 * per-turn fact (SL-16 review B1).
 *
 * ONE owner, deliberately. The growth question has three consumers — the run
 * record's `pendingWake` stamp (the card), the live cli-state (which the
 * notification policy reads), and the terminal host's revival pointer — and each
 * computing it from the raw array would be three copies of a stateful rule that
 * must agree exactly. `RuntimeController.applyHookToTask` advances this ONCE per
 * turn-end hook and hands the same `TurnEndWake` to every consumer, which is
 * what makes "these cannot drift apart" a true statement rather than a hopeful
 * one. (It was not true in the first cut: the `StopFailure` path stamped the run
 * but not cli-state, and the double-fire this slice exists to remove was still
 * live on that ending.)
 *
 * Advanced ONLY on main-turn endings (`Stop` / `StopFailure` / `Interrupt`),
 * never on `SubagentStop` — that event carries the same array but lands mid-turn,
 * where "paused waiting for background work" is simply false, and advancing the
 * memory there would let a subagent's view of the session consume the growth
 * that the main turn's end has to report.
 *
 * Lifetime is the session's: it is built with the task runtime and discarded
 * with it, so a respawn starts from "nothing known to be running", which is the
 * honest prior for a session that has not spoken yet.
 */
export class BackgroundWorkTracker {
  /** Ids in flight as of the last turn end that spoke. Never null — "we have not
   *  been told" is represented by not advancing at all. */
  private inFlight: string[] = [];

  /**
   * Advance the memory with one turn end's claim and return what it means.
   * Returns null for `unstated`: the payload said nothing, so nothing is known
   * to have changed and no consumer should act.
   */
  noteTurnEnd(claim: BackgroundWorkClaim): TurnEndWake | null {
    if (claim.kind === "unstated") {
      return null;
    }
    const tasks = claim.kind === "pending" ? claim.tasks : [];
    const ids = tasks.map((task) => task.id);
    const previous = this.inFlight;
    // NEW work — the pause. An entry whose id we already knew is pre-existing
    // session state (the dev-server case) and must not re-open one.
    const opened = tasks.filter((task) => !previous.includes(task.id));
    // RETURNED work — something we were told about is gone, i.e. it finished,
    // which is the event that wakes the session.
    const returned = previous.some((id) => !ids.includes(id));
    this.inFlight = ids;
    return { opened: opened.length > 0 ? { tasks: opened } : null, returned };
  }
}

function readTask(entry: unknown): PendingWakeTask {
  if (!entry || typeof entry !== "object") {
    return { id: "", kind: "" };
  }
  const record = entry as { id?: unknown; type?: unknown };
  return {
    id: typeof record.id === "string" ? record.id : "",
    kind: typeof record.type === "string" ? record.type : "",
  };
}
