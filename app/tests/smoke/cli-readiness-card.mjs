// CLI readiness S2 — the New Chat readiness card's presence matrix and its copy.
//
// The card is the perception-sensitive part of the slice, and the part a
// screenshot cannot check: a frame proves ONE row of the matrix looks right and
// says nothing about the rows that must show NOTHING. So the whole decision is a
// pure function (reading-core/selectors/cli-readiness-card) and this fence walks
// it exhaustively:
//
//   1. the presence matrix — every install × auth reading × both providers,
//      including the rows where `unknown` must stay silent (D3's permissive rule,
//      the one that keeps Sonata from accusing a machine it could not read);
//   2. the two absent variants — both-absent (D8) vs one-absent (L1);
//   3. absent BEFORE signedOut (D9's priority);
//   4. the setup run's overlay — installing / failed, whose provider each speaks
//      for, and healthy-wins-over-any-run;
//   5. the copy, VERBATIM per D8/L1 — every string a user can read, pinned here,
//      because a typo in it is invisible to every other test in the suite;
//   6. the surface gate — a card exists on New Chat only (D9), and its presence
//      is exactly what closes the send path.
//
// Pure: no DOM, no Electron, no subprocess. Runs under plain node.

import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { createInitialState } = require("../../dist/reading-core/state");
const {
  cliReadinessCard,
  cliReadinessBlocksSend,
} = require("../../dist/reading-core/selectors/cli-readiness-card");

const INSTALL_STATES = ["present", "absent", "unknown"];
const AUTH_STATES = ["signedIn", "signedOut", "unknown"];
const results = {};

/** A New Chat state: no task, a preselected draft provider, facts, and an
 *  optional setup run. Everything the card is allowed to read. */
function newChatState({ provider = "claude", claude, codex, run = null }) {
  const state = createInitialState({ theme: "paper", mode: "system", textStep: 0 });
  state.taskDraft.provider = provider;
  state.cliReadiness = { claude, codex };
  state.cliSetupRun = run;
  return state;
}

function fact(install, auth) {
  return { install, auth };
}

const HEALTHY = fact("present", "signedIn");
const ABSENT = fact("absent", "unknown");
const SIGNED_OUT = fact("present", "signedOut");
const UNKNOWN = fact("unknown", "unknown");

// ── 1. The presence matrix ──────────────────────────────────────────────────
// Every reading of the DRAFT's provider, over every reading of the other one.
// The card is a statement about the draft's provider, so the other provider may
// only change WHICH absent variant appears — never whether a card appears at all.
{
  const rows = [];
  for (const install of INSTALL_STATES) {
    for (const auth of AUTH_STATES) {
      for (const otherInstall of INSTALL_STATES) {
        const state = newChatState({
          provider: "claude",
          claude: fact(install, auth),
          codex: fact(otherInstall, "unknown"),
        });
        const card = cliReadinessCard(state);
        // The rule, restated as an assertion rather than trusted from the source:
        // a card appears iff the draft's provider is actionable — absent, or
        // present-but-signed-out. Nothing else, and in particular nothing about
        // `unknown` on either axis.
        const actionable = install === "absent" || auth === "signedOut";
        assert.equal(
          card !== null,
          actionable,
          `claude=${install}/${auth} codex=${otherInstall}/unknown → ` +
            `expected ${actionable ? "a card" : "NO card"}, got ${card?.kind ?? "null"}`,
        );
        // The send gate is the card's presence, by construction — asserted here so
        // the two can never be separately edited into disagreement.
        assert.equal(cliReadinessBlocksSend(state), actionable);
        if (card) {
          rows.push(`claude=${install}/${auth} codex=${otherInstall} → ${card.kind}`);
        }
      }
    }
  }
  // A signed-out reading over an ABSENT install is unreachable from the probe (it
  // only asks about auth over a binary it found), but the selector must still be
  // total, and `absent` must win if it ever arrives.
  const silentRows = 27 - rows.length;
  results.matrix = { cardRows: rows.length, silentRows };
  assert.equal(
    silentRows,
    // present×{signedIn,unknown} × 3 others = 6, unknown×{signedIn,unknown} × 3 = 6
    12,
    "exactly the twelve non-actionable readings are silent",
  );
}

// The mirror image: the SAME facts with the draft on the other provider must
// produce the other provider's card. The draft's provider is the subject.
{
  const facts = { claude: ABSENT, codex: SIGNED_OUT };
  const onClaude = cliReadinessCard(newChatState({ provider: "claude", ...facts }));
  const onCodex = cliReadinessCard(newChatState({ provider: "codex", ...facts }));
  assert.equal(onClaude.kind, "absent");
  assert.equal(onClaude.provider, "claude");
  assert.equal(onCodex.kind, "signed-out");
  assert.equal(onCodex.provider, "codex");
  results.subjectIsTheDraftProvider = `${onClaude.kind} / ${onCodex.kind}`;
}

// ── 2 + 3. The absent variants, and absent before signedOut ─────────────────
{
  const both = cliReadinessCard(
    newChatState({ provider: "claude", claude: ABSENT, codex: ABSENT }),
  );
  assert.equal(both.kind, "both-absent");
  assert.equal(both.copy, "Claude Code CLI or Codex CLI not installed.");
  assert.deepEqual(
    both.actions.map((action) => [action.kind, action.provider, action.label, action.domId]),
    [
      ["install", "claude", "Install Claude Code CLI", "cli-readiness-install-claude"],
      ["install", "codex", "Install Codex CLI", "cli-readiness-install-codex"],
    ],
    "both-absent offers both installs, Claude first",
  );
  // The pair does NOT reorder with the draft: a set of choices that rearranges
  // itself under the user is a set they have to re-read.
  const bothOnCodex = cliReadinessCard(
    newChatState({ provider: "codex", claude: ABSENT, codex: ABSENT }),
  );
  assert.deepEqual(
    bothOnCodex.actions.map((action) => action.provider),
    ["claude", "codex"],
  );

  // L1: one absent, the other usable → only the missing one is named.
  const claudeOnly = cliReadinessCard(
    newChatState({ provider: "claude", claude: ABSENT, codex: HEALTHY }),
  );
  assert.equal(claudeOnly.kind, "absent");
  assert.equal(claudeOnly.copy, "Claude Code CLI not installed.");
  assert.deepEqual(
    claudeOnly.actions.map((action) => action.label),
    ["Install Claude Code CLI"],
  );
  const codexOnly = cliReadinessCard(
    newChatState({ provider: "codex", claude: HEALTHY, codex: ABSENT }),
  );
  assert.equal(codexOnly.copy, "Codex CLI not installed.");
  assert.deepEqual(
    codexOnly.actions.map((action) => action.label),
    ["Install Codex CLI"],
  );

  // `unknown` on the OTHER provider is not `absent`: the permissive rule applies
  // there too, so this is the ONE-absent variant, not the both-absent one.
  const otherUnknown = cliReadinessCard(
    newChatState({ provider: "claude", claude: ABSENT, codex: UNKNOWN }),
  );
  assert.equal(
    otherUnknown.kind,
    "absent",
    "an unreadable other provider is not an absent one",
  );

  // D9's priority, on a fact set carrying both (unreachable from the probe, but
  // the ordering must be the card's, not an accident of branch order).
  const both2 = cliReadinessCard(
    newChatState({
      provider: "claude",
      claude: fact("absent", "signedOut"),
      codex: HEALTHY,
    }),
  );
  assert.equal(both2.kind, "absent", "absent outranks signedOut");
  results.absentVariants = { both: both.kind, one: claudeOnly.kind, priority: both2.kind };
}

// ── 5. The signed-out copy, per provider (D8 — each CLI's own vocabulary) ────
{
  const claude = cliReadinessCard(
    newChatState({ provider: "claude", claude: SIGNED_OUT, codex: HEALTHY }),
  );
  assert.equal(
    claude.copy,
    "Claude Code CLI isn't logged in.",
  );
  assert.deepEqual(
    claude.actions.map((action) => [action.kind, action.label, action.domId]),
    [["start", "Log in", "cli-readiness-login"]],
  );
  const codex = cliReadinessCard(
    newChatState({ provider: "codex", claude: HEALTHY, codex: SIGNED_OUT }),
  );
  assert.equal(
    codex.copy,
    "Codex CLI isn't logged in.",
  );
  assert.deepEqual(
    codex.actions.map((action) => action.label),
    ["Log in"],
  );
  results.signedOut = { claude: claude.copy, codex: codex.copy };
}

// ── 4. The setup run overlay ────────────────────────────────────────────────
{
  const installing = (provider) => ({
    id: 1,
    kind: "install",
    provider,
    phase: "running",
  });
  const failed = (provider) => ({ id: 2, kind: "install", provider, phase: "failed" });
  const starting = (provider) => ({ id: 3, kind: "start", provider, phase: "running" });

  const live = cliReadinessCard(
    newChatState({
      provider: "claude",
      claude: ABSENT,
      codex: ABSENT,
      run: installing("claude"),
    }),
  );
  assert.equal(live.kind, "installing");
  assert.equal(
    live.copy,
    "Installing Claude Code — follow along in the CLI window.",
  );
  assert.deepEqual(live.actions, [], "nothing to click while it runs");
  assert.equal(
    cliReadinessCard(
      newChatState({ provider: "codex", claude: ABSENT, codex: ABSENT, run: installing("codex") }),
    ).copy,
    "Installing Codex — follow along in the CLI window.",
  );

  // A LIVE run is narrated whatever provider it belongs to: the user just asked
  // for it and the CLI window is in front, so "Installing Codex…" is truer than
  // a both-absent card with two buttons while an installer is running.
  const liveOther = cliReadinessCard(
    newChatState({
      provider: "claude",
      claude: ABSENT,
      codex: ABSENT,
      run: installing("codex"),
    }),
  );
  assert.equal(liveOther.kind, "installing");
  assert.equal(liveOther.provider, "codex");

  // A FINISHED failure is a fact ABOUT a provider: it speaks only on that
  // provider's card, so a failed Codex attempt cannot occupy Claude's card and
  // hide Claude's own Install button behind an unrelated "Try again".
  const failedOwn = cliReadinessCard(
    newChatState({ provider: "claude", claude: ABSENT, codex: HEALTHY, run: failed("claude") }),
  );
  assert.equal(failedOwn.kind, "install-failed");
  assert.equal(
    failedOwn.copy,
    "Installation didn't finish — check the output in the CLI window.",
  );
  assert.deepEqual(
    failedOwn.actions.map((action) => [action.kind, action.label, action.domId]),
    [["install-retry", "Try again", "cli-readiness-retry"]],
  );
  const failedOther = cliReadinessCard(
    newChatState({ provider: "claude", claude: ABSENT, codex: ABSENT, run: failed("codex") }),
  );
  assert.equal(
    failedOther.kind,
    "both-absent",
    "another provider's failed attempt does not speak on this card",
  );

  // A `start` run in flight: the sentence still holds, the button does not —
  // offering to start a second copy of a CLI already waiting for input would be
  // an invitation to make a mess.
  const loggingIn = cliReadinessCard(
    newChatState({ provider: "claude", claude: SIGNED_OUT, codex: HEALTHY, run: starting("claude") }),
  );
  assert.equal(loggingIn.kind, "signed-out");
  assert.deepEqual(loggingIn.actions, []);

  // HEALTHY WINS. The gate runs before any run branch, so a run whose provider
  // came good shows nothing at all — no "didn't finish" over a working CLI, and
  // no "Installing…" after the facts went green (which is exactly how the card
  // disappears on its own when the machine heals).
  for (const run of [installing("claude"), failed("claude"), starting("claude")]) {
    assert.equal(
      cliReadinessCard(
        newChatState({ provider: "claude", claude: HEALTHY, codex: ABSENT, run }),
      ),
      null,
      `a healthy provider shows no card even with a ${run.kind}/${run.phase} run`,
    );
  }
  results.setupRun = {
    installing: live.copy,
    failed: failedOwn.copy,
    liveRunNarratedForAnyProvider: liveOther.provider,
    failedRunScopedToItsProvider: failedOther.kind,
    healthyWins: "no card for any run phase",
  };
}

// ── 6. New Chat only (D9) ───────────────────────────────────────────────────
{
  const state = newChatState({ provider: "claude", claude: ABSENT, codex: ABSENT });
  assert.ok(cliReadinessCard(state), "the card is there on New Chat");

  // An open session: the same broken CLI, but this surface belongs to the banner
  // family (D10 / S4). Nothing here, and nothing blocking its composer.
  state.activeTaskId = "task-1";
  state.taskViews = [
    {
      taskId: "task-1",
      task: { id: "task-1", title: "A session", provider: "claude" },
      live: false,
      pendingAttachments: [],
      optionPromptDrafts: [],
    },
  ];
  assert.equal(
    cliReadinessCard(state),
    null,
    "an open session is not this card's surface (D9/D10)",
  );
  assert.equal(cliReadinessBlocksSend(state), false);
  results.surface = "New Chat only";
}

console.log(JSON.stringify({ success: true, results }, null, 2));
