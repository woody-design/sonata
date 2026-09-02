import assert from "node:assert/strict";
import { createRequire } from "node:module";

/**
 * SL-16 — "ended, expecting wake" (upstream sync 2026-09, findings F42–F48).
 *
 * ONE behaviour across four layers, so it is pinned as one fence: the payload
 * reader, the live cli-state, the run lifecycle + revival attribution, the
 * notification policy, and the card copy. The value of the fence is that the
 * layers AGREE — split across four files, a change could satisfy each of them
 * and still leave the user with the lie this slice removes.
 *
 * PROVENANCE. Every payload below is MEASURED, from
 * `spikes/upstream-sync-2026-09/claude/z1-background-wake.capture.txt`
 * (claude 2.1.258, 4 wake runs + a foreground control). The capture keeps
 * `background_tasks` / `session_crons` whole (its summarizer's KEEP_WHOLE_KEYS),
 * so the entry shape here is the wire shape, not a reconstruction. The one
 * COMPOSED payload is the "field absent" arm — a shape the CLI emits on every
 * pre-2.1.25x event and on codex, but which this capture had no reason to hold.
 */
const require = createRequire(import.meta.url);
const {
  TerminalHost,
  readBackgroundWork,
  BackgroundWorkTracker,
  CliStateModel,
} = require("../../dist/runtime");
const { NotificationPolicy } = require("../../dist/main/notification-policy");
const R = require("../../dist/reading-core/selectors/runs");
const REDUCER = require("../../dist/reading-core/runtime-reducer");
const STATE = require("../../dist/reading-core/state");

const failures = [];
const NOW_MS = Date.parse("2026-09-02T03:00:00.000Z");

// MEASURED (z1a, the closing Stop of a turn that backgrounded `sleep 70`).
const RUNNING_SHELL = {
  id: "b8ylzf16p",
  type: "shell",
  status: "running",
  description: "Sleep 70 then echo",
  command: "sleep 70; echo BGDONE",
};
// MEASURED — the closing Stop's payload, trimmed to the keys under test.
const stopPending = () => ({
  hook_event_name: "Stop",
  stop_hook_active: false,
  last_assistant_message: "STARTED",
  background_tasks: [RUNNING_SHELL],
  session_crons: [],
});
// MEASURED — the POST-WAKE Stop from the same arm, and the foreground control's.
const stopFinal = () => ({
  hook_event_name: "Stop",
  stop_hook_active: false,
  last_assistant_message: "The background command finished (exit code 0).",
  background_tasks: [],
  session_crons: [],
});
// MEASURED — the wake's own UserPromptSubmit prompt (elided after the summary).
const TASK_NOTIFICATION_PROMPT =
  "<task-notification>\n<task-id>b8ylzf16p</task-id>\n" +
  "<status>completed</status>\n" +
  '<summary>Background command "Sleep 70 then echo" completed (exit code 0)</summary>\n' +
  "</task-notification>";
// MEASURED — fires 60s after EVERY turn end, carrying none of the stop fields.
const notificationIdlePrompt = () => ({
  hook_event_name: "Notification",
  notification_type: "idle_prompt",
  message: "Claude is waiting for your input",
});

// ── 1. The reader: three answers, and `unstated` is not `none` ──────────────

await check("readBackgroundWork: a non-empty array names its tasks by id and kind", () => {
  const claim = readBackgroundWork(stopPending());
  assert.equal(claim.kind, "pending");
  assert.deepEqual(
    claim.tasks,
    [{ id: "b8ylzf16p", kind: "shell" }],
    "the CLI's own id and kind label, verbatim — the id is what makes the set diffable",
  );
});

await check("readBackgroundWork: an EMPTY array is positive evidence of none", () => {
  assert.equal(readBackgroundWork(stopFinal()).kind, "none");
});

// F44's lesson applied to a second field: a payload carrying no
// `background_tasks` key said NOTHING, and silence must never be promoted to
// "nothing in flight". Pinned as a CONTRACT rather than as a live fix, and the
// distinction is stated because the A/B measured it: inverting this arm alone
// breaks only this check, because every consumer today happens to be
// insensitive to it (claude's Stop always carries the field; codex's endings
// never arm a pause). It is what keeps the NEXT consumer from inheriting
// "silence means done" for free.
await check("readBackgroundWork: an ABSENT field is `unstated`, never `none` (COMPOSED)", () => {
  assert.equal(readBackgroundWork(notificationIdlePrompt()).kind, "unstated");
  assert.equal(readBackgroundWork({ hook_event_name: "Stop" }).kind, "unstated");
  assert.equal(
    readBackgroundWork({ hook_event_name: "Stop", background_tasks: "nonsense" }).kind,
    "unstated",
    "an unreadable field is also 'was not told' — never a claim",
  );
});

// `session_crons` names FUTURE wakeups and is deliberately not a pause: a
// session with a standing cron is done for now, and folding it in would
// suppress the completion ping of every turn that session ever runs.
await check("readBackgroundWork: session_crons never opens a pause", () => {
  const claim = readBackgroundWork({
    hook_event_name: "Stop",
    background_tasks: [],
    session_crons: [{ id: "c1", schedule: "0 9 * * *", recurring: true, prompt: "daily" }],
  });
  assert.equal(claim.kind, "none", "a scheduled wakeup is not a paused turn");
});

// ── 1b. The memory: session state → per-turn fact (review B1) ──────────────
//
// The array is SESSION-scoped ("registered in this session"), so the pause is
// not "is anything in flight" but "did THIS turn leave something behind" — a
// question about identity over time. These arms pin the diff itself.

await check("tracker: the launching turn opens; a later turn naming the same work does not", () => {
  const track = new BackgroundWorkTracker();
  const first = track.noteTurnEnd(readBackgroundWork(stopPending()));
  assert.deepEqual(first.opened.tasks, [{ id: "b8ylzf16p", kind: "shell" }]);
  assert.equal(first.returned, false);

  const second = track.noteTurnEnd(readBackgroundWork(stopPending()));
  assert.equal(second.opened, null, "the SAME task id is not new work");
  assert.equal(second.returned, false, "and it has not come back either");
});

await check("tracker: work leaving the set is a return, even with other work still running", () => {
  const track = new BackgroundWorkTracker();
  const dev = { id: "dev-1", type: "shell" };
  const shell = { id: "b8ylzf16p", type: "shell" };
  track.noteTurnEnd(readBackgroundWork({ background_tasks: [dev] }));
  const opened = track.noteTurnEnd(readBackgroundWork({ background_tasks: [dev, shell] }));
  assert.deepEqual(opened.opened.tasks, [{ id: "b8ylzf16p", kind: "shell" }], "only the NEW one");

  const returned = track.noteTurnEnd(readBackgroundWork({ background_tasks: [dev] }));
  assert.equal(returned.returned, true, "the shell came back — a dev server outliving it is irrelevant");
  assert.equal(returned.opened, null);
});

await check("tracker: an `unstated` payload advances nothing and says nothing", () => {
  const track = new BackgroundWorkTracker();
  track.noteTurnEnd(readBackgroundWork(stopPending()));
  assert.equal(
    track.noteTurnEnd(readBackgroundWork({ hook_event_name: "Stop" })),
    null,
    "a payload that said nothing must not be read as 'the work vanished'",
  );
  const still = track.noteTurnEnd(readBackgroundWork(stopPending()));
  assert.equal(still.opened, null, "…and the memory is intact: the shell is still known");
  assert.equal(still.returned, false);
});

// The fail direction, stated: a payload naming no id degrades to "not new",
// which costs a notification too many, never one too few.
await check("tracker: an id-less task fails toward pinging, not toward silence (COMPOSED)", () => {
  const track = new BackgroundWorkTracker();
  const anon = { type: "shell" };
  assert.ok(track.noteTurnEnd(readBackgroundWork({ background_tasks: [anon] })).opened);
  assert.equal(
    track.noteTurnEnd(readBackgroundWork({ background_tasks: [anon] })).opened,
    null,
    "unidentifiable work is treated as already-known — the safe direction",
  );
});

// ── 2. cli-state: the qualifier, and the two ways it must not be lost ───────

await check("cli-state: a pending Stop ends the turn AND carries the pause", () => {
  const { model, seen } = liveSession();
  model.turn("do it");
  model.stop(stopPending());

  const last = seen.at(-1);
  assert.equal(last.activity, "turn-ended");
  assert.deepEqual(last.turnEndWake.opened.tasks, [{ id: "b8ylzf16p", kind: "shell" }]);
  assert.equal(last.turnEndWake.returned, false);
  assert.equal(last.source, "hook:Stop(background work pending)");
});

// THE SHARPEST LIVE HAZARD, and the rule that closes it. Claude fires
// `Notification(idle_prompt)` 60s after every turn end (MEASURED at Stop+60.2s
// in every z1 arm) and it reaches the SAME `turn-ended` state while carrying no
// stop fields at all. The protection is `CliStateModel.set`'s keep-on-omit rule
// — only a payload that actually SPOKE about background work may change the
// claim — and it is genuinely load-bearing: A/B'd, inverting that one rule to
// "an omitted value clears" fails this check and the F43 check below with it.
await check("cli-state: the post-turn idle notification does NOT cancel the pause", () => {
  const { model, seen } = liveSession();
  model.turn("do it");
  model.stop(stopPending());
  const before = seen.length;
  model.hook(notificationIdlePrompt());

  assert.equal(seen.length, before, "it is not a change — nothing is emitted");
  assert.ok(model.current().turnEndWake.opened, "and the pause survives it");
});

// THE F43 TOLERANCE. 1 of 9 measured revivals fired NO `UserPromptSubmit`: the
// CLI ran the injected turn and closed it, and the only trace on this wire is a
// SECOND `Stop` whose `background_tasks` is now empty. Activity does not move
// (turn-ended → turn-ended), so without `pendingWake` in the change comparison
// the dedup swallows it and the held notification never fires.
await check("cli-state: turn-ended(opened) → turn-ended(returned) IS a change (F43)", () => {
  const { model, seen } = liveSession();
  model.turn("do it");
  model.stop(stopPending());
  model.hook(notificationIdlePrompt()); // the 60s idle ping, still no wake
  const before = seen.length;
  model.stop(stopFinal()); // the revival's own Stop — no UPS ever fired

  assert.equal(seen.length, before + 1, "the pause closing is emitted");
  assert.equal(seen.at(-1).activity, "turn-ended");
  assert.equal(seen.at(-1).turnEndWake.opened, null);
  assert.equal(seen.at(-1).turnEndWake.returned, true, "the awaited shell came back");
});

// REVIEW M1: every main-turn ending carries the verdict, not just `Stop`. The
// first cut stamped the run record on a `StopFailure` but left cli-state's own
// branch blind, so a failed turn that had left a shell running emitted no pause
// and fired the double-notification anyway — the two sides had drifted on
// exactly the path nobody looked at. Whether `StopFailure` actually carries
// `background_tasks` is UNMEASURED, which is why this is shape-tolerant: both
// arms are pinned so the fix holds whichever way upstream turns out to behave.
await check("cli-state: StopFailure carries the pause the same way Stop does (M1)", () => {
  const { model, seen } = liveSession();
  model.turn("do it");
  model.stop({ ...stopPending(), hook_event_name: "StopFailure", error: "model_not_found" });

  const last = seen.at(-1);
  assert.equal(last.activity, "turn-ended");
  assert.ok(last.turnEndWake.opened, "a failed turn that left work running is still paused");
  assert.equal(last.source, "hook:StopFailure(background work pending)");
});

await check("cli-state: a StopFailure carrying NO such field is unchanged (M1, shape-tolerant)", () => {
  const { model, seen } = liveSession();
  model.turn("do it");
  model.stop({ hook_event_name: "StopFailure", error: "model_not_found" });

  assert.equal(seen.at(-1).activity, "turn-ended");
  assert.equal(seen.at(-1).turnEndWake, null, "said nothing → claims nothing");
  assert.equal(seen.at(-1).source, "hook:StopFailure");
});

await check("cli-state: the pause qualifies turn-ended and nothing else", () => {
  const { model } = liveSession();
  model.turn("do it");
  model.stop(stopPending());
  assert.ok(model.current().turnEndWake.opened, "armed at the pause");

  model.turn(TASK_NOTIFICATION_PROMPT);
  assert.equal(model.current().activity, "busy");
  assert.equal(model.current().turnEndWake, null, "the session is awake — the pause is over");
});

// SL-16 objective 4, decided on evidence rather than left silent. `SubagentStop`
// carries the SAME two fields (MEASURED: z1's SubagentStop 1.5s after the parent
// Stop named the same running shell), and it is still a no-op — a subagent
// finishing normally lands MID-turn, where "paused waiting for background work"
// is simply false. The pause belongs to the main turn's ending.
await check("cli-state: SubagentStop carrying in-flight work changes nothing", () => {
  const { model, seen } = liveSession();
  model.hook({ hook_event_name: "PreToolUse", tool_name: "Task" });
  const before = seen.length;
  model.hook({
    hook_event_name: "SubagentStop",
    agent_id: "agent-1",
    background_tasks: [RUNNING_SHELL],
    session_crons: [],
  });

  assert.equal(seen.length, before, "no cli-state event");
  assert.equal(model.current().activity, "busy", "the main turn is still running");
  assert.equal(model.current().turnEndWake, null, "and no pause was opened");
  // …and, decisively, it did not CONSUME the growth: the main turn's own Stop
  // must still be the one that reports the shell. A tracker advanced here would
  // have seen the shell first and left `Stop` with nothing new to say.
  model.stop(stopPending());
  assert.ok(model.current().turnEndWake.opened, "the parent Stop still opens the pause");
});

// ── 3. The run lifecycle + the revival link ─────────────────────────────────

await check("terminal-host: a pending Stop completes the run AND stamps the pause", () => {
  const events = [];
  const host = makeHost(events);
  try {
    host.ptyProcess = fakePty();
    host.activeRun = activeRun();

    const finished = host.completeRunFromTurnEnd({ turnEndWake: tracker().note(stopPending()) });

    // The turn ENDED — that half was never the lie, and the evidence axis is
    // untouched: demoting confidence would answer a different question badly.
    assert.equal(finished.status, "completed");
    assert.equal(finished.completionSource, "hook-stop");
    assert.equal(finished.completionConfidence, "high");
    // …and the second axis carries what `completed` alone would hide.
    assert.deepEqual(finished.pendingWake.tasks, [{ id: "b8ylzf16p", kind: "shell" }]);
    assert.equal(finished.statusReason, "stop hook (turn ended, background work pending)");

    const updated = events.filter(
      (event) => event.type === "run:updated" && event.payload.status === "completed",
    );
    assert.equal(updated.length, 1, "exactly one completion");
    assert.ok(
      updated[0].payload.pendingWake,
      "the stamp has to reach the EVENT — the run-index reads it off there",
    );
  } finally {
    host.dispose();
  }
});

await check("terminal-host: an ordinary Stop is byte-for-byte what it always was", () => {
  const host = makeHost([]);
  try {
    host.ptyProcess = fakePty();
    host.activeRun = activeRun();
    const finished = host.completeRunFromTurnEnd({ turnEndWake: tracker().note(stopFinal()) });
    assert.equal(finished.status, "completed");
    assert.equal(finished.completionSource, "hook-stop");
    assert.equal(finished.statusReason, "stop hook (turn ended)");
    assert.equal(finished.pendingWake, undefined, "absent, not null — no claim was made");
  } finally {
    host.dispose();
  }
});

// The attribution (objective 3). Two terms, and both are required: the prompt
// text proves the turn is machine-injected (the only discriminator at 2.1.258 —
// `UserPromptSubmit.source` is specified and NOT emitted, F44), and the awaited
// wake proves there was something to return from.
await check("terminal-host: the wake's run names the run it continues", () => {
  const events = [];
  const host = makeHost(events);
  try {
    const track = tracker();
    host.ptyProcess = fakePty();
    host.activeRun = activeRun();
    const paused = host.completeRunFromTurnEnd({ turnEndWake: track.note(stopPending()) });

    host.beginRunFromHook(TASK_NOTIFICATION_PROMPT, { promptId: "pid-wake" });
    const started = events.filter((event) => event.type === "run:started").at(-1);

    assert.equal(started.payload.title, "(background task returned)", "the title, as before");
    assert.equal(
      started.payload.revivalOf,
      paused.id,
      "and now the run MODEL agrees with the title about WHICH run returned",
    );
  } finally {
    host.dispose();
  }
});

// The other half of the conjunction, and the reason it is a conjunction: the
// user can type during a pause. Their prompt is their own turn — attributing it
// to the background task would be a fabricated link, and the background work is
// still in flight behind it either way.
await check("terminal-host: a prompt the USER types during the pause is not the revival", () => {
  const events = [];
  const host = makeHost(events);
  try {
    const track = tracker();
    host.ptyProcess = fakePty();
    host.activeRun = activeRun();
    host.completeRunFromTurnEnd({ turnEndWake: track.note(stopPending()) });

    host.beginRunFromHook("meanwhile, what does the config say?", { promptId: "pid-human" });
    const started = events.filter((event) => event.type === "run:started").at(-1);
    assert.equal(started.payload.revivalOf, undefined, "no fabricated link");

    // …and the wake is still awaited, so the REAL revival still links. The
    // human's turn ended with the SAME shell still running, so it opened nothing
    // (B1) — the pointer it leaves untouched is the one from the first turn.
    host.completeRunFromTurnEnd({ turnEndWake: track.note(stopPending()) });
    host.beginRunFromHook(TASK_NOTIFICATION_PROMPT);
    assert.ok(
      events.filter((event) => event.type === "run:started").at(-1).payload.revivalOf,
      "the pause outlives an interleaved human turn",
    );
  } finally {
    host.dispose();
  }
});

// F43 again, at the host: the wake left no run to attribute, so nothing is
// claimed — but the pointer MUST still settle on the empty-array Stop, or a
// later, unrelated task-notification would be attributed to a wake that has
// already happened. This is what the pre-guard placement in
// `completeRunFromTurnEnd` buys.
await check("terminal-host: an unannounced wake still settles the pointer (F43)", () => {
  const events = [];
  const host = makeHost(events);
  try {
    const track = tracker();
    host.ptyProcess = fakePty();
    host.activeRun = activeRun();
    host.completeRunFromTurnEnd({ turnEndWake: track.note(stopPending()) });

    // The revival ran with NO UserPromptSubmit; its Stop is all we ever see.
    assert.equal(
      host.completeRunFromTurnEnd({ turnEndWake: track.note(stopFinal()) }),
      null,
      "no run was active — nothing to complete",
    );

    host.beginRunFromHook(TASK_NOTIFICATION_PROMPT);
    assert.equal(
      events.filter((event) => event.type === "run:started").at(-1).payload.revivalOf,
      undefined,
      "a LATER task-notification is not back-attributed to a settled wake",
    );
  } finally {
    host.dispose();
  }
});

// The Stop-less ending (SL-2b's arm) is untouched and must stay so: a claude Esc
// fires NO hook at all (F45), so there is no payload and Sonata knows nothing
// about background work. It must therefore CLAIM nothing — the quiescence
// closer's completion carries no pause, and a later wake gets an honest,
// unlinked run rather than an invented connection.
await check("terminal-host: a Stop-less close claims no pause (Esc'd-then-waking)", () => {
  const events = [];
  const host = makeHost(events);
  try {
    host.ptyProcess = fakePty();
    host.activeRun = activeRun();
    host.finishActiveRun("completed", "sustained idle composer (Stop-less turn end)", {
      completionSource: "terminal-idle-heuristic",
      completionConfidence: "low",
    });
    const closed = events.filter(
      (event) => event.type === "run:updated" && event.payload.status === "completed",
    );
    assert.equal(closed.at(-1).payload.pendingWake, undefined, "no payload, no claim");

    host.beginRunFromHook(TASK_NOTIFICATION_PROMPT);
    assert.equal(
      events.filter((event) => event.type === "run:started").at(-1).payload.revivalOf,
      undefined,
      "and no link is invented for a wake nothing announced",
    );
  } finally {
    host.dispose();
  }
});

// ── 4. The notification: ONE ping, at the honest moment ─────────────────────

const T0 = Date.parse("2026-09-02T03:00:00.000Z");
const at = (sec) => new Date(T0 + sec * 1000).toISOString();
const cli = (taskId, activity, sec, turnEndWake = null) => ({
  type: "cli-state:changed",
  payload: { taskId, activity, turnEndWake },
  ts: at(sec),
});
const SHELL_TASK = { id: "b8ylzf16p", kind: "shell" };
/** A turn end that OPENED a pause (this turn started the work). */
const OPENED = { opened: { tasks: [SHELL_TASK] }, returned: false };
/** A turn end where awaited work CAME BACK. */
const RETURNED = { opened: null, returned: true };
/** A turn end while a long-lived task keeps running: nothing new, nothing back. */
const UNCHANGED = { opened: null, returned: false };

// THE REGRESSION, pinned as fixed. Before SL-16 this arc produced TWO "task
// complete" notifications for one user request — one at the pause (false) and
// one ~70s later at the real end. Timings are the measured ones: Stop at +8s,
// the wake's UserPromptSubmit at +77s, its Stop at +79s.
await check("notification: the background-wake arc fires exactly ONE complete", () => {
  const policy = new NotificationPolicy();
  assert.equal(policy.observe(cli("t1", "busy", 0)), null);
  assert.equal(
    policy.observe(cli("t1", "turn-ended", 8, OPENED)),
    null,
    "the pause is not 'your turn' — nothing is being asked of the user",
  );
  assert.equal(policy.observe(cli("t1", "busy", 77)), null, "the wake resumes the SAME arc");
  const decision = policy.observe(cli("t1", "turn-ended", 79, RETURNED));
  assert.ok(decision, "and the real ending fires");
  assert.equal(decision.kind, "complete");
  assert.equal(decision.taskId, "t1");
});

// The arc is HELD, not restarted: the clock keeps running from the original
// submit, because the whole paused stretch is time the user was away. A wake
// that resumes and finishes quickly must still ping.
await check("notification: the held arc measures from the ORIGINAL submit", () => {
  const policy = new NotificationPolicy();
  policy.observe(cli("t1", "busy", 0));
  policy.observe(cli("t1", "turn-ended", 5, OPENED)); // under the 30s floor at the pause
  policy.observe(cli("t1", "busy", 70));
  assert.ok(
    policy.observe(cli("t1", "turn-ended", 72, RETURNED)),
    "70s away is 70s away — a restarted clock would have gone silent here",
  );
});

// F43's arc, which needs no special handling and is pinned because that is the
// claim: the wake announced itself with nothing but its own Stop.
await check("notification: an unannounced wake still fires the held ping (F43)", () => {
  const policy = new NotificationPolicy();
  policy.observe(cli("t1", "busy", 0));
  policy.observe(cli("t1", "turn-ended", 7, OPENED));
  // No `busy` ever arrives — no UserPromptSubmit, no PreToolUse.
  const decision = policy.observe(cli("t1", "turn-ended", 78, RETURNED));
  assert.ok(decision && decision.kind === "complete", "the second Stop closes the arc");
});

// ── THE B1 REGRESSION, pinned at every layer it reached ────────────────────
//
// `background_tasks` is SESSION state ("registered in this session"), so a
// long-lived task — a dev server, a watcher, a `tail -f` — sits in the array for
// the REST OF THE SESSION. The first cut held on mere non-emptiness, which meant
// every later turn's completion ping was silently swallowed and every later card
// was stamped "waiting on background work". That is strictly worse than the
// double-fire it was fixing: pre-slice, those turns pinged.
await check("B1 dev server: only the LAUNCHING turn holds; later turns ping normally", () => {
  const policy = new NotificationPolicy();
  const track = tracker();
  const devServer = { id: "dev-1", type: "shell", status: "running", command: "npm run dev" };
  const stopWithDev = () => ({ hook_event_name: "Stop", background_tasks: [devServer], session_crons: [] });

  // Turn 1 starts it. It is new, so this turn genuinely is expecting a wake.
  policy.observe(cli("t1", "busy", 0));
  const turn1 = track.note(stopWithDev());
  assert.ok(turn1.opened, "the launching turn opened a pause");
  assert.equal(policy.observe(cli("t1", "turn-ended", 8, turn1)), null, "…and is held");

  // Turn 2, minutes later. The dev server is STILL running and still in the
  // array — but this turn started nothing, so it is an ordinary turn end.
  policy.observe(cli("t1", "busy", 300));
  const turn2 = track.note(stopWithDev());
  assert.equal(turn2.opened, null, "nothing NEW — the array did not grow");
  assert.equal(turn2.returned, false, "and nothing came back either");
  const decision = policy.observe(cli("t1", "turn-ended", 340, turn2));
  assert.ok(decision && decision.kind === "complete", "turn 2 pings — the regression is gone");

  // …and its card carries no stamp, from the same predicate.
  assert.equal(
    R.runOutcome({ status: "completed", completionSource: "hook-stop", stopEvents: [] }, "Claude"),
    "Completed",
    "a turn that opened nothing is labelled plainly",
  );
});

// The other half of B1: a turn end that opens nothing must also measure ITSELF.
// Holding the arc's clock across an unrelated turn would ping "finished" at a
// user who is sitting right there, which is exactly what the floor exists to
// prevent.
await check("B1 secondary: a short human turn during a pause does NOT ping", () => {
  const policy = new NotificationPolicy();
  policy.observe(cli("t1", "busy", 0));
  policy.observe(cli("t1", "turn-ended", 8, OPENED)); // held, arc starts at 0

  // The user types something while the shell runs. 3s later it is done.
  policy.observe(cli("t1", "busy", 20));
  assert.equal(
    policy.observe(cli("t1", "turn-ended", 23, UNCHANGED)),
    null,
    "3s turn, user at the keyboard — the arc's ancient clock must not be used",
  );

  // …and the real wake still resolves the ORIGINAL arc, from the original start.
  policy.observe(cli("t1", "busy", 77));
  const decision = policy.observe(cli("t1", "turn-ended", 79, RETURNED));
  assert.ok(decision && decision.kind === "complete", "the held arc still fires, once");
});

// The interleaved-human arc END TO END through the policy — the fence the review
// required, because the host-layer version of this scenario existed and asserted
// only `revivalOf`, which is precisely why the notification bug survived it.
await check("B1 fence: interleaved human turn — the whole arc fires exactly ONE complete", () => {
  const policy = new NotificationPolicy();
  const decisions = [];
  const feed = (activity, sec, wake = null) => {
    const decision = policy.observe(cli("t1", activity, sec, wake));
    if (decision) decisions.push({ sec, ...decision });
  };
  feed("busy", 0);
  feed("turn-ended", 8, OPENED); // the shell is launched, pause held
  feed("busy", 20); // the human types
  feed("turn-ended", 25, UNCHANGED); // their short turn — no ping (under floor)
  feed("busy", 40); // and a LONG one
  feed("turn-ended", 75, UNCHANGED); // 35s > floor → its own honest ping
  feed("busy", 77); // the wake
  feed("turn-ended", 79, RETURNED); // resolves the original arc

  assert.deepEqual(
    decisions.map((d) => d.sec),
    [75, 79],
    "one ping for the human's own long turn, one for the arc — and none at the pause",
  );
  assert.ok(decisions.every((d) => d.kind === "complete"));
});

// The arc is held; the TURN is not. The second clock is what buys this for free:
// because the wake's `busy` is an ordinary new turn, it clears the turn-scoped
// ask dedup like any other, so an approval raised after the wake pings even when
// the pre-pause turn raised one with the same fingerprint. (An earlier cut
// suppressed the whole busy branch during a pause and had to re-add the clear by
// hand — a carve-out that also broke the floor. Pinned so the simpler structure
// cannot regress to it.) Contrast the approval resume, which stays inside ONE
// turn and correctly keeps its dedup set.
await check("notification: the wake starts a new TURN, so ask dedup resets with it", () => {
  const policy = new NotificationPolicy();
  const ask = () => ({
    type: "approval:detected",
    payload: { taskId: "t1", fingerprintHash: "fp-same-command" },
    ts: at(0),
  });
  policy.observe(cli("t1", "busy", 0));
  assert.ok(policy.observe(ask()), "the first ask pings");
  assert.equal(policy.observe(ask()), null, "…and is deduped within the same turn");

  policy.observe(cli("t1", "turn-ended", 8, OPENED));
  policy.observe(cli("t1", "busy", 77));
  assert.ok(policy.observe(ask()), "after the wake it is a NEW question and pings again");
});

await check("notification: a dead PTY drops the held arc rather than waiting forever", () => {
  const policy = new NotificationPolicy();
  policy.observe(cli("t1", "busy", 0));
  policy.observe(cli("t1", "turn-ended", 8, OPENED));
  policy.observe(cli("t1", "idle", 20)); // pty:exit
  assert.equal(
    policy.observe(cli("t1", "turn-ended", 90, RETURNED)),
    null,
    "no ping for a dead session",
  );
});

// An ordinary turn is untouched — the hold is keyed on the pause and nothing
// else, and a payload-less `turn-ended` (recorded fixtures, codex) must behave
// exactly as it did before.
await check("notification: an ordinary turn is unchanged, with or without the field", () => {
  const policy = new NotificationPolicy();
  policy.observe(cli("t1", "busy", 0));
  assert.ok(policy.observe(cli("t1", "turn-ended", 45)), "explicit null pendingWake → fires");

  const legacy = new NotificationPolicy();
  legacy.observe({ type: "cli-state:changed", payload: { taskId: "t2", activity: "busy" }, ts: at(0) });
  assert.ok(
    legacy.observe({
      type: "cli-state:changed",
      payload: { taskId: "t2", activity: "turn-ended" },
      ts: at(45),
    }),
    "a payload with no pendingWake key at all → fires (fixture compatibility)",
  );
});

// ── 5. The card ────────────────────────────────────────────────────────────

await check("card: a paused run says the third thing, in the waiting tone", () => {
  const paused = {
    status: "completed",
    completionSource: "hook-stop",
    pendingWake: { tasks: [SHELL_TASK] },
    stopEvents: [],
  };
  assert.equal(R.runOutcome(paused, "Claude"), "Waiting on background work\u2026");
  assert.equal(R.runTone(paused), "waiting", "nothing is asked of the user — not `attention`");
  // The lifecycle predicates must NOT treat it as live: the turn ended, the
  // composer accepts input, and the stop button must not reappear.
  assert.equal(R.isActiveRunStatus(paused.status), false);
});

await check("card: an ordinary completed run still reads exactly as before", () => {
  const done = { status: "completed", completionSource: "hook-stop", stopEvents: [] };
  assert.equal(R.runOutcome(done, "Claude"), "Completed");
  assert.equal(R.runTone(done), "complete");
});

// The last surface that still said "finished" while the card said "waiting"
// (review, pre-existing): the sidebar's finished-while-away dot. Taken under
// this slice because it is the SAME fact consulted once, on the same event.
await check("sidebar: the finished-while-away dot does not light at a pause", () => {
  const settled = (extra) => ({
    type: "run:updated",
    payload: {
      taskId: "t1",
      id: "run-1",
      kind: "prompt",
      prompt: "p",
      title: "p",
      status: "completed",
      lifecyclePhase: "completed",
      startedAt: at(0),
      endedAt: at(8),
      elapsedMs: 8000,
      completionSource: "hook-stop",
      completionConfidence: "high",
      ...extra,
    },
    ts: at(8),
  });

  const paused = backgroundView();
  REDUCER.reduceRuntimeEvent(paused.state, settled({ pendingWake: { tasks: [SHELL_TASK] } }), NOW_MS);
  assert.equal(paused.view.completedUnseen, false, "ended expecting a wake is not 'finished'");

  const done = backgroundView();
  REDUCER.reduceRuntimeEvent(done.state, settled({}), NOW_MS);
  assert.equal(done.view.completedUnseen, true, "a genuine finish still lights it");
});

if (failures.length > 0) {
  process.exitCode = 1;
} else {
  console.log("background-wake-modeling smoke: OK");
}

/** The production memory, as the controller owns it: one per session. */
function tracker() {
  const instance = new BackgroundWorkTracker();
  return { note: (payload) => instance.noteTurnEnd(readBackgroundWork(payload)) ?? undefined };
}

/** A cli-state model driven the way `applyHookToTask` drives it: one tracker,
 *  advanced on main-turn endings only, its verdict handed to the model. */
function liveSession() {
  const seen = [];
  const model = new CliStateModel((snapshot) => seen.push(snapshot));
  const track = tracker();
  return {
    seen,
    model: {
      current: () => model.current(),
      hook: (payload) => model.applyHook(payload),
      turn: (prompt) => model.applyHook({ hook_event_name: "UserPromptSubmit", prompt }),
      stop: (payload) => {
        const turnEndWake = track.note(payload);
        model.applyHook(payload, turnEndWake ? { turnEndWake } : {});
      },
    },
  };
}

/** A task view that is NOT the active one — the only state in which the
 *  finished-while-away dot can light at all. */
function backgroundView() {
  const state = STATE.createInitialState({ theme: "default", mode: "auto", textStep: 16 });
  const view = STATE.createTaskView(
    {
      id: "t1",
      title: "Background wake",
      provider: "claude",
      model: "opus",
      reasoningEffort: null,
      speedMode: null,
      sandbox: null,
      approval: null,
      permissionMode: null,
      runtimeSessionId: "rs-t1",
      providerSessionRef: null,
      providerCwd: "/workspace/fixture",
      workingDirectory: "/workspace/fixture",
      status: "running",
      createdAt: at(0),
      updatedAt: at(0),
    },
    "Claude PTY 1",
    true,
  );
  STATE.upsertTaskView(state, view);
  state.activeTaskId = null; // the user is looking elsewhere
  return { state, view };
}

function makeHost(events) {
  return new TerminalHost({
    taskId: "background-wake-smoke",
    provider: "claude",
    defaultWorkspace: process.cwd(),
    eventSink: (event) => events.push(event),
  });
}

function activeRun() {
  const now = Date.now();
  return {
    taskId: "background-wake-smoke",
    id: `run-${now}-1`,
    kind: "prompt",
    prompt: "run the suite in the background",
    title: "run the suite in the background",
    status: "active",
    lifecyclePhase: "active",
    startedAt: new Date(now - 8000).toISOString(),
    endedAt: null,
    elapsedMs: null,
    completionSource: null,
    completionConfidence: null,
  };
}

function fakePty() {
  return {
    pid: 0,
    write() {},
    kill() {},
    resize() {},
    onData() {},
    onExit() {},
  };
}

async function check(name, fn) {
  try {
    await fn();
    console.log(`ok   ${name}`);
  } catch (error) {
    failures.push(name);
    console.error(`FAIL ${name}`);
    console.error(error);
  }
}
