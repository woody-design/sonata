// CLI readiness S4 — the existing-chat banner's presence matrix, its copy, and the
// composer's boot-narration yield.
//
// The banner's danger is the mirror of the card's: a screenshot proves one frame
// reads well and says nothing about the far larger set of states that must show
// NOTHING AT ALL. An existing chat is the surface where a false alarm is worst — the
// user is mid-conversation, and a banner claiming their CLI is missing while it
// plainly works would be the exact opposite of what this program is for. So the
// whole decision is a pure function and this fence walks it:
//
//   1. the three presence conditions, each shown to be load-bearing — a diagnosis
//      must exist, the FACTS must still agree, and the fact must be about THIS
//      task's provider;
//   2. the two sentences and the two button labels, VERBATIM per D8/L1 — and proved
//      to be the SAME strings the New Chat card says, not copies of them (D10: one
//      fact, two mount points, one copy pass);
//   3. the action's subtraction while a setup run for that provider is live;
//   4. the send-gate ASYMMETRY with the card: New Chat's card closes send, this
//      banner deliberately does not;
//   5. the composer's yield — the two strings that promise a boot must stop
//      promising it, and everything else about the composer must not move;
//   6. the shared classification's priority (absent before signedOut) and its
//      refusal to classify anything else.
//
// Pure: no DOM, no Electron, no subprocess. Runs under plain node. The main-side
// triggers that WRITE the diagnosis are fenced separately, against a real
// RuntimeController (cli-session-start-triggers.mjs).

import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { createInitialState, createTaskView } = require("../../dist/reading-core/state");
const {
  cliReadinessBanner,
} = require("../../dist/reading-core/selectors/cli-readiness-banner");
const {
  cliReadinessCard,
  cliReadinessBlocksSend,
} = require("../../dist/reading-core/selectors/cli-readiness-card");
const {
  composerPlaceholder,
  sendPromptTitle,
} = require("../../dist/reading-core/selectors/composer");
const {
  cliSessionStartBlockReason,
} = require("../../dist/shared/types/cli-readiness");

const results = {};

function fact(install, auth) {
  return { install, auth };
}

const HEALTHY = fact("present", "signedIn");
const ABSENT = fact("absent", "unknown");
const SIGNED_OUT = fact("present", "signedOut");
const UNKNOWN = fact("unknown", "unknown");

/**
 * An open session on `provider`, with the machine facts and (optionally) a recorded
 * diagnosis for it. `live` is the pty's liveness — false is the absent shape (the
 * process died), true the signed-out shape (it is sitting on a login screen), which
 * is why both appear below.
 */
function sessionState({
  provider = "claude",
  claude = HEALTHY,
  codex = HEALTHY,
  blocked = null,
  live = true,
  bootLatched = false,
  run = null,
  taskId = "task-1",
}) {
  const state = createInitialState({ theme: "paper", mode: "system", textStep: 0 });
  state.cliReadiness = { claude, codex };
  state.cliSetupRun = run;
  const view = createTaskView({ id: taskId, title: "A session", provider }, "Ready", live);
  view.deliveryState = {
    taskId,
    provider,
    deliverable: bootLatched,
    activeRun: false,
    approvalActive: false,
    rewindPanelOpen: false,
    bootLatched,
    attachmentNotice: null,
    queue: [],
  };
  state.taskViews = [view];
  state.activeTaskId = taskId;
  if (blocked) {
    state.cliSessionStartBlocked[taskId] = blocked;
  }
  return { state, view };
}

// ── 1. The three presence conditions ────────────────────────────────────────
{
  // (a) A diagnosis is REQUIRED. Broken facts alone say nothing here — a machine
  //     can be signed out of one CLI for a week while the user works in the other,
  //     and every session of the healthy one would otherwise wear a banner.
  const noDiagnosis = sessionState({ provider: "claude", claude: ABSENT });
  assert.equal(
    cliReadinessBanner(noDiagnosis.state, noDiagnosis.view),
    null,
    "broken facts with no diagnosis raise nothing (the card's surface is New Chat, not this)",
  );

  // (b) The FACTS are required too — this is the heal. The user clicks the action,
  //     finishes setup, S2's post-run re-probe turns the facts green, and the
  //     banner retires itself with nobody clearing anything.
  const healed = sessionState({ provider: "claude", claude: HEALTHY, blocked: "signedOut" });
  assert.equal(
    cliReadinessBanner(healed.state, healed.view),
    null,
    "a healed machine retires the banner with no clearing path",
  );
  const stillUnknown = sessionState({ provider: "claude", claude: UNKNOWN, blocked: "absent" });
  assert.equal(
    cliReadinessBanner(stillUnknown.state, stillUnknown.view),
    null,
    "…and `unknown` is not an accusation either (D3's permissive rule)",
  );

  // (c) It must be THIS task's provider. A codex machine problem cannot speak on a
  //     claude session, whatever the register happens to hold.
  const wrongProvider = sessionState({
    provider: "claude",
    claude: HEALTHY,
    codex: ABSENT,
    blocked: "absent",
  });
  assert.equal(
    cliReadinessBanner(wrongProvider.state, wrongProvider.view),
    null,
    "the other provider's breakage never speaks on this task",
  );

  // And a New Chat (no task) is never this surface.
  const newChat = sessionState({ provider: "claude", claude: ABSENT, blocked: "absent" });
  assert.equal(cliReadinessBanner(newChat.state, null), null, "no task, no banner");

  results.presence = "diagnosis AND live facts AND this provider";
}

// ── 2. The copy, verbatim — and shared with the card, not copied ────────────
{
  const expected = {
    "claude/absent": {
      copy: "Claude Code CLI not installed.",
      label: "Install Claude Code CLI",
    },
    "codex/absent": {
      copy: "Codex CLI not installed.",
      label: "Install Codex CLI",
    },
    "claude/signedOut": {
      copy:
        "Claude Code CLI isn't signed in. Finish its first-run setup in the terminal window.",
      label: "Start Claude Code CLI",
    },
    "codex/signedOut": {
      copy: "Codex CLI isn't signed in. Finish its setup in the terminal window.",
      label: "Start Codex CLI",
    },
  };
  const seen = {};
  for (const provider of ["claude", "codex"]) {
    for (const reason of ["absent", "signedOut"]) {
      const brokenFact = reason === "absent" ? ABSENT : SIGNED_OUT;
      const { state, view } = sessionState({
        provider,
        claude: provider === "claude" ? brokenFact : HEALTHY,
        codex: provider === "codex" ? brokenFact : HEALTHY,
        blocked: reason,
        live: reason === "signedOut",
      });
      const banner = cliReadinessBanner(state, view);
      assert.ok(banner, `${provider}/${reason} raises a banner`);
      assert.equal(banner.provider, provider);
      assert.equal(banner.reason, reason);
      const key = `${provider}/${reason}`;
      assert.equal(banner.copy, expected[key].copy, `${key} copy is verbatim (D8/L1)`);
      assert.equal(banner.action.label, expected[key].label, `${key} button label`);
      assert.equal(banner.action.kind, reason === "absent" ? "install" : "start");
      assert.equal(banner.action.provider, provider);
      seen[key] = { copy: banner.copy, label: banner.action.label };
    }
  }

  // The strings are the CARD's strings, reached through the card's own vocabulary
  // rather than respelled here. Proved by comparing the two surfaces' output for
  // the same machine fact — this is what makes one copy pass move both mount
  // points (S2's note for S4), and it fails the moment either side forks its own
  // wording.
  for (const provider of ["claude", "codex"]) {
    for (const reason of ["absent", "signedOut"]) {
      const brokenFact = reason === "absent" ? ABSENT : SIGNED_OUT;
      // The card's single-absent variant (L1) needs the OTHER provider healthy,
      // else D8's both-absent card answers instead — a genuinely different
      // sentence, and one the banner has no analogue for (an existing chat is
      // pinned to one provider, so "one or the other" is never its question).
      const cardState = createInitialState({ theme: "paper", mode: "system", textStep: 0 });
      cardState.taskDraft.provider = provider;
      cardState.cliReadiness = {
        claude: provider === "claude" ? brokenFact : HEALTHY,
        codex: provider === "codex" ? brokenFact : HEALTHY,
      };
      const card = cliReadinessCard(cardState);
      assert.equal(
        card.copy,
        seen[`${provider}/${reason}`].copy,
        `${provider}/${reason}: banner and card say the SAME sentence`,
      );
      assert.equal(
        card.actions[0].label,
        seen[`${provider}/${reason}`].label,
        `${provider}/${reason}: …and name the action identically`,
      );
    }
  }
  results.copy = seen;
}

// ── 3. The action yields to a live setup run ────────────────────────────────
{
  const running = (provider, kind) => ({ id: 1, kind, provider, phase: "running" });
  const signedOut = sessionState({
    provider: "claude",
    claude: SIGNED_OUT,
    blocked: "signedOut",
    run: running("claude", "start"),
  });
  const banner = cliReadinessBanner(signedOut.state, signedOut.view);
  assert.ok(banner, "the sentence still holds while the CLI is up in the CLI window");
  assert.equal(
    banner.action,
    null,
    "…but no button: starting a second copy of a CLI awaiting input is a mess, not a fix",
  );
  assert.equal(
    banner.copy,
    "Claude Code CLI isn't signed in. Finish its first-run setup in the terminal window.",
    "and the copy is NOT rewritten for that state — the subtraction is the whole change",
  );

  // A run for the OTHER provider takes nothing away: the CLI window is busy with
  // something unrelated to this task's problem.
  const otherRun = sessionState({
    provider: "claude",
    claude: SIGNED_OUT,
    blocked: "signedOut",
    run: running("codex", "install"),
  });
  assert.ok(
    cliReadinessBanner(otherRun.state, otherRun.view).action,
    "another provider's run does not withdraw this provider's action",
  );

  // A run that has FINISHED (failed) withdraws nothing either — the fact it failed
  // is the card's story; here the recovery is still on offer.
  const failedRun = sessionState({
    provider: "claude",
    claude: ABSENT,
    blocked: "absent",
    live: false,
    run: { id: 2, kind: "install", provider: "claude", phase: "failed" },
  });
  assert.ok(
    cliReadinessBanner(failedRun.state, failedRun.view).action,
    "a finished run leaves the retry on offer",
  );
  results.runOverlay = "live same-provider run withdraws the button, nothing else does";
}

// ── 4. The send-gate asymmetry (deliberate) ────────────────────────────────
{
  // New Chat: a send CREATES a session, so a card closes the send path — a prompt
  // sent there queues into a CLI that will never boot, the wound this program
  // exists to close.
  const cardState = createInitialState({ theme: "paper", mode: "system", textStep: 0 });
  cardState.cliReadiness = { claude: ABSENT, codex: HEALTHY };
  assert.equal(cliReadinessBlocksSend(cardState), true, "New Chat's card closes send");

  // An existing chat: the conversation already exists, and both failure shapes stay
  // honest — a dormant session's send is a RESUME the user may want to retry, and a
  // live-but-signed-out session's send is held in the delivery queue until the
  // login finishes. So nothing is taken away.
  const { state, view } = sessionState({ provider: "claude", claude: ABSENT, blocked: "absent", live: false });
  assert.ok(cliReadinessBanner(state, view), "the banner is up");
  assert.equal(
    cliReadinessBlocksSend(state),
    false,
    "…and the existing chat's send is NOT closed (the asymmetry is the design)",
  );
  results.sendGate = "card closes send; banner does not";
}

// ── 5. The composer's boot-narration yield ────────────────────────────────
{
  // The signed-out shape is where the eternal pin lives: the pty is alive, the boot
  // latch never opens, so both of these strings would repeat forever.
  const { state, view } = sessionState({
    provider: "codex",
    codex: SIGNED_OUT,
    blocked: "signedOut",
    live: true,
    bootLatched: false,
  });
  assert.ok(cliReadinessBanner(state, view), "the banner is up");

  const pinnedPlaceholder = composerPlaceholder(view, false, false, false);
  const pinnedTitle = sendPromptTitle(view, false, false, true, false);
  assert.equal(
    pinnedPlaceholder,
    "Codex is starting — your message will send when it's ready",
    "unyielded, the placeholder promises a boot that is not coming",
  );
  assert.equal(
    pinnedTitle,
    "Codex is starting — your message sends as soon as it accepts input.",
    "…and so does the send title",
  );

  const yieldedPlaceholder = composerPlaceholder(view, false, false, true);
  const yieldedTitle = sendPromptTitle(view, false, false, true, true);
  assert.equal(yieldedPlaceholder, "Codex can't start yet", "the placeholder states the fact");
  assert.equal(
    yieldedTitle,
    "Queued — delivers when Codex is ready.",
    "the send title yields by SUBTRACTION onto the truthful queue statement",
  );

  // The absent shape: the pty is dead, so the view is dormant and the placeholder
  // would otherwise invite a resume with no hint that it cannot work.
  const dormant = sessionState({
    provider: "claude",
    claude: ABSENT,
    blocked: "absent",
    live: false,
  });
  assert.equal(
    composerPlaceholder(dormant.view, false, false, false),
    "Message Claude — resumes this session",
    "unyielded, a dormant session invites a resume that cannot start",
  );
  assert.equal(
    composerPlaceholder(dormant.view, false, false, true),
    "Claude can't start yet",
    "…and the diagnosis outranks the dormant arm",
  );

  // Everything ELSE about the composer's copy is untouched: a working turn, an
  // approval, and an empty composer all speak exactly as before.
  assert.equal(
    composerPlaceholder(view, true, false, true),
    "Codex is working — Enter queues your message",
    "an active run still outranks the diagnosis (the CLI is plainly working)",
  );
  assert.equal(
    sendPromptTitle(view, true, false, true, true),
    "Stop Codex",
    "the stop affordance is untouched",
  );
  assert.equal(
    sendPromptTitle(view, false, false, false, true),
    "Type a message before sending.",
    "an empty composer is untouched",
  );
  assert.equal(
    composerPlaceholder(null, false, false, true),
    "Describe a task or ask a question",
    "New Chat's placeholder is untouched",
  );
  results.pinYield = { pinnedPlaceholder, yieldedPlaceholder, pinnedTitle, yieldedTitle };
}

// ── 6. The shared classification ───────────────────────────────────────────
{
  assert.equal(cliSessionStartBlockReason(ABSENT), "absent");
  assert.equal(cliSessionStartBlockReason(SIGNED_OUT), "signedOut");
  assert.equal(cliSessionStartBlockReason(HEALTHY), null, "a healthy CLI is not classified");
  assert.equal(cliSessionStartBlockReason(UNKNOWN), null, "nor is an unreadable one");
  assert.equal(
    cliSessionStartBlockReason(fact("unknown", "signedOut")),
    "signedOut",
    "a signed-out reading over an unreadable install still speaks",
  );
  // The priority, on a fact set the probe cannot actually produce (it only asks
  // about auth over a binary it found) — pinned so a future fact source cannot
  // silently reorder the two.
  assert.equal(
    cliSessionStartBlockReason(fact("absent", "signedOut")),
    "absent",
    "absent outranks signedOut: there is no login screen on a CLI that is not there",
  );
  results.classification = "absent > signedOut; healthy/unknown → null";
}

console.log(JSON.stringify({ success: true, results }, null, 2));
