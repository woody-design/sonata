import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

// Claude BOOT-INTERSTITIAL guard (upstream sync 2026-09-01, SL-3). The boot
// ceremony sweep found exactly one screen between spawn and the first idle
// composer that Sonata could deliver into: the fullscreen-renderer offer. This
// pins the guard that holds readiness on it.
//
// Three fences, one subject:
//
//   1. SIGNATURE (`claudeFullscreenOfferOpen`) — fires on the real offer FRAME,
//      read through a real `TaskScreenModel` so the test drives the same grid
//      the product does (D-1: a state query belongs on the grid, never the tail).
//   2. FORGERY RESISTANCE — the offer's own vocabulary in assistant prose, or
//      half of it, must not fire the guard; and the OTHER boot screens of the
//      same ceremony (the trust dialog, the release-notes banner, the answered
//      composer) must not either.
//   3. THE GATE — `acceptsPromptInput()` reads false while the offer owns the
//      screen, and it outranks the SessionStart hook short-circuit. That last
//      case is the discriminating one: without the guard the gate reads TRUE
//      there, the boot latch opens, and delivery writes into the offer.
//
// Plus the RED LINE: the guard writes ZERO bytes. MEASURED (q9 case C), a
// delivery's paste is discarded at this screen and its submit CR answers
// `1. Yes, try it` — the CLI re-execs under a new renderer and the user's prompt
// is gone with no receipt and no error. Sonata holds; the human answers in the
// co-visible Terminal.
//
// ── FIXTURE PROVENANCE ──────────────────────────────────────────────────────
//
// MEASURED. `tests/fixtures/claude-boot/fullscreen-offer-2.1.257.txt` and
// `…-answered-2.1.257.txt` are the rendered viewports of a live claude 2.1.257
// booted through a real `TerminalHost` with Sonata's own spawn args
// (spikes/upstream-sync-2026-09/claude/q9-fullscreen-offer-input.mjs, case B:
// the frame before any key, and the composer the same session reached once the
// offer was answered). Written to disk by the probe, not retyped. The full boot
// catalog and every number quoted below live in that spike's findings.md, F7/F8
// — tracked, unlike the captures themselves (spikes are gitignored, D6).
//
// One artifact of the capture is deliberate and load-bearing to understand: the
// header reads `API Usage Billing` and the answered frame's footer carries
// `Not logged in`. The offer is exhausted on the probe machine's real account
// (`fullscreenUpsellSeenCount` 3, the binary's cap), so the probe re-armed it in
// a COPY of the config under a scratch `CLAUDE_CONFIG_DIR` — and this account
// keeps its credentials in the macOS Keychain keyed to the DEFAULT config dir,
// so the copy is logged out. The renderer offer is a client-side choice and is
// unaffected; only the header/footer differ from a production boot. The
// production boot's own frames are pinned in the same probe family
// (q8-boot-ceremony.production.capture.txt) and carry no offer at all.
//
// ADAPTED. `TRUST_DIALOG_FRAME` is the tracked SL-1 fixture
// (approval-panels/trust-2.1.252.txt), reused here as a negative.
//
// COMPOSED. Every prose negative below.
const require = createRequire(import.meta.url);
const {
  TerminalHost,
  claudeFullscreenOfferOpen,
  detectIdlePromptForProvider,
  normalizeTerminalDimensions,
} = require("../../dist/runtime");
const { TaskScreenModel } = require("../../dist/runtime/terminal-host/task-screen-model");

const failures = [];
const FIXTURES = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../fixtures");

// Wide enough that the offer's own lines do not wrap, tall enough to hold the
// whole widget in one viewport — the task geometry class the product uses.
const DIMENSIONS = normalizeTerminalDimensions(120, 40);

const OFFER_FRAME = readFixture("claude-boot/fullscreen-offer-2.1.257.txt");
const ANSWERED_FRAME = readFixture("claude-boot/fullscreen-offer-answered-2.1.257.txt");
const TRUST_DIALOG_FRAME = readFixture("approval-panels/trust-2.1.252.txt");

// ── 1. SIGNATURE ────────────────────────────────────────────────────────────

await check("the measured offer frame fires the signature", async () => {
  assert.equal(claudeFullscreenOfferOpen(OFFER_FRAME), true);
});

await check("the signature survives a real TaskScreenModel round-trip", async () => {
  // The product never hands this function a file — it hands it
  // `screenModel.viewportText()`. Laying the fixture out on a real grid and
  // reading it back is the shape the guard actually sees, wrapping included.
  const rendered = await renderScreen(OFFER_FRAME.replaceAll("\n", "\r\n"));
  assert.equal(claudeFullscreenOfferOpen(rendered), true);
});

await check("the signature is digit-agnostic on the affirm row", async () => {
  // 2.1.252 stripped the digits off the TRUST rows and broke the parse that
  // assumed them (SL-1). The same hand can strip these, so the needle must not
  // depend on `1.`.
  assert.equal(claudeFullscreenOfferOpen(OFFER_FRAME.replace("1. Yes, try it", "Yes, try it")), true);
});

await check("the signature tolerates the cursor sitting on the DECLINE row", async () => {
  // A user who arrowed down before Sonata sampled must not un-guard the screen.
  const arrowed = OFFER_FRAME.replace("  ❯ 1. Yes, try it\n    2. Not now", "    1. Yes, try it\n  ❯ 2. Not now");
  assert.notEqual(arrowed, OFFER_FRAME, "the substitution actually applied");
  assert.equal(claudeFullscreenOfferOpen(arrowed), true);
});

// ── 2. FORGERY RESISTANCE ───────────────────────────────────────────────────

await check("the answered composer does NOT fire the signature", async () => {
  assert.equal(claudeFullscreenOfferOpen(ANSWERED_FRAME), false);
});

await check("the workspace-trust dialog does NOT fire the signature", async () => {
  // The two screens share a footer (`Enter to confirm · Esc to cancel`) — which
  // is exactly the incidental coupling this guard exists to stop relying on.
  assert.ok(TRUST_DIALOG_FRAME.includes("Enter to confirm"), "the shared footer is really shared");
  assert.equal(claudeFullscreenOfferOpen(TRUST_DIALOG_FRAME), false);
});

await check("the release-notes boot banner stays READY — the guard must not over-reach", async () => {
  // MEASURED in the same sweep (F7, notes-only arm): after any auto-update the
  // welcome block carries this line above a LIVE composer, and readiness came up
  // at 937ms. It is a banner, not a modal. This is the OVER-REACH direction of
  // the guard, and it is the one that would hurt every user after every update:
  // a predicate that held here would wedge the boot latch on a healthy session,
  // so the assertion is on the GATE, not just on the parser.
  //
  // ADAPTED — the measured frame's rows, trimmed to the ones that matter (the
  // full frame's 20 blank rows carry no signal). The banner text is verbatim.
  const notesFrame =
    " ▐▛███▛█   Claude Code v2.1.257\n" +
    "  Updated to latest. Got 62 features, 379 bugfixes, and 211 other changes.\n" +
    "  code.claude.com/docs/en/changelog for details\n" +
    "❯ \n" +
    "  ⏸ manual mode on · ← for agents";
  const host = await hostShowing(notesFrame);
  try {
    assert.equal(host.isFullscreenOfferOpen(), false, "a banner is not a modal");
    assert.equal(host.acceptsPromptInput(), true, "a post-update boot must still latch");
  } finally {
    host.dispose();
  }
});

await check("half the signature is not the signature", async () => {
  assert.equal(
    claudeFullscreenOfferOpen(OFFER_FRAME.replace("Try the new fullscreen renderer?", "")),
    false,
    "the affirm row alone must not hold readiness",
  );
  assert.equal(
    claudeFullscreenOfferOpen(OFFER_FRAME.replace("1. Yes, try it", "1. Something else")),
    false,
    "the question alone must not hold readiness",
  );
});

await check("assistant prose about the offer does not forge it", async () => {
  const prose =
    "❯ explain the boot guard\n" +
    "The fullscreen offer asks whether you want the new renderer, and its first row\n" +
    "is the one whose Enter restarts the CLI.\n" +
    "❯ \n" +
    "  ⏸ manual mode on · ← for agents";
  assert.equal(claudeFullscreenOfferOpen(prose), false);
});

await check("prose QUOTING the question inline does not forge it", async () => {
  // Line-scoping, condition 1. The question is present verbatim, but as part of
  // a sentence — so the compacted LINE is not the question.
  const inline =
    "The offer asks Try the new fullscreen renderer? and its rows are 1. Yes, try it\n" +
    "and 2. Not now, so a bare Enter accepts.";
  assert.equal(claudeFullscreenOfferOpen(inline), false);
});

await check("a RESUMED SESSION repainting the offer verbatim does NOT hold readiness", async () => {
  // THE FORGERY THAT MATTERS (review round 1, minor #1). claude ≥2.1.186
  // repaints transcript history on resume — the documented reason the hook
  // short-circuit exists — so a session that once displayed this screen brings
  // its exact wording back onto the grid at boot. The guard outranks that hook
  // and the boot latch is ONE-WAY, so a false hold here wedges the queue for the
  // life of the session with nothing left to override it.
  //
  // Every needle of the real frame is present, on its own line, unmangled. What
  // separates them is that a composer is UNDER them — and a composer always
  // carries a glyph-anchored mode line (F6: present in all four modes, never
  // absent), while the real offer paints before any session exists and cannot.
  //
  // COMPOSED — the repaint layout; the offer block inside it is the MEASURED
  // fixture verbatim, which is the whole point.
  const repaint =
    "❯ what does the fullscreen offer look like?\n" +
    OFFER_FRAME +
    "\n" +
    "That is the frame the boot guard recognizes.\n" +
    "────────────────────────────────────────────\n" +
    "❯ \n" +
    "────────────────────────────────────────────\n" +
    "  ⏸ manual mode on · ← for agents";
  assert.ok(repaint.includes("Try the new fullscreen renderer?"), "premise: the wording really is on this frame");
  assert.equal(claudeFullscreenOfferOpen(repaint), false, "content under a composer is not a boot modal");

  const host = await hostShowing(repaint);
  try {
    host.noteHookSessionStart();
    assert.equal(host.acceptsPromptInput(), true, "a resumed session must still latch");
  } finally {
    host.dispose();
  }
});

await check("the mode-line negative holds in EVERY permission mode", async () => {
  // The negative leans on one vocabulary, so it has to be true for all four
  // modes, not just the one the fixture happens to show (F6 measured all four).
  for (const modeLine of [
    "  ⏸ manual mode on · ← for agents",
    "  ⏵⏵ accept edits on (shift+tab to cycle) · ← for agents",
    "  ⏸ plan mode on (shift+tab to cycle) · ← for agents",
    "  ⏵⏵ auto mode on (shift+tab to cycle) · ← for agents",
  ]) {
    assert.equal(
      claudeFullscreenOfferOpen(`${OFFER_FRAME}\n❯ \n${modeLine}`),
      false,
      `a composer in ${modeLine.trim()} must defuse the signature`,
    );
  }
});

// ── 3. THE GATE ─────────────────────────────────────────────────────────────

await check("readiness holds while the offer owns the screen", async () => {
  const host = await hostShowing(OFFER_FRAME);
  try {
    assert.equal(host.isFullscreenOfferOpen(), true, "the host sees the offer on its grid");
    assert.equal(host.acceptsPromptInput(), false, "the boot latch must not open here");
  } finally {
    host.dispose();
  }
});

await check("readiness holds when the SHARED FOOTER is gone — the guard is the only thing left", async () => {
  // WHY THIS CASE EXISTS. Readiness already held on the offer BEFORE this guard,
  // but only by accident: the offer's footer is spelled `Enter to confirm · Esc
  // to cancel`, and both halves are already in claude's needle list (the
  // workspace-trust hints and CLAUDE_PANEL_END_MARKERS), so `detectIdlePrompt`'s
  // ordering rule found an "approval" after the `❯` and refused. Nothing about
  // that is a promise: tool panels ALREADY dropped `Enter to confirm` once, at
  // 2.1.17x, which is why those end markers exist at all.
  //
  // COMPOSED — the reworded footer is a hypothesis about a change upstream has
  // made before to a neighbouring screen, not a measurement. Its job is to
  // remove the crutch so the case measures the GUARD. The case fails on a build
  // without the guard: the boot latch opens on a modal whose Enter re-execs the
  // CLI and destroys the queued prompt.
  const noSharedFooter = OFFER_FRAME.replace("Enter to confirm · Esc to cancel", "Press enter to choose");
  assert.notEqual(noSharedFooter, OFFER_FRAME, "the substitution actually applied");
  const host = await hostShowing(noSharedFooter);
  try {
    assert.equal(
      detectIdlePromptForProvider(host.rawTail, "claude").ready,
      true,
      "premise: with the shared footer gone the composer scrape reads READY on this modal",
    );
    assert.equal(host.isFullscreenOfferOpen(), true, "the signature still knows the screen");
    assert.equal(host.acceptsPromptInput(), false, "readiness must hold on the offer's own identity");
  } finally {
    host.dispose();
  }
});

await check("the guard OUTRANKS the SessionStart hook short-circuit", async () => {
  // THE DISCRIMINATING CASE. `acceptsPromptInput()` short-circuits true on the
  // hook, so a guard ranked below it would be invisible. The offer is measured
  // painting BEFORE the session starts (q8: no hook in 60s of it standing open),
  // which is upstream's ordering, not a promise Sonata holds — so the guard is
  // ranked above the short-circuit and this case pins that ranking.
  const host = await hostShowing(OFFER_FRAME);
  try {
    host.noteHookSessionStart();
    assert.equal(host.acceptsPromptInput(), false, "a modal over the composer outranks the hook");
  } finally {
    host.dispose();
  }
});

await check("readiness returns once the offer is answered", async () => {
  // The SAME session, one frame later: the offer answered and the composer up.
  // The hold self-clears with no event — the delivery pump's re-poll is what
  // picks it up in production, so nothing here needs to fire. The tail carries
  // BOTH screens, because that is what a real stream carries: an answered
  // dialog's bytes never leave it, which is exactly why this reads the grid.
  const host = await hostShowing(ANSWERED_FRAME, { tail: `${OFFER_FRAME}\n${ANSWERED_FRAME}` });
  try {
    assert.equal(host.isFullscreenOfferOpen(), false);
    assert.equal(host.acceptsPromptInput(), true, "the composer came back");
  } finally {
    host.dispose();
  }
});

await check("RED LINE: recognizing the offer writes NO bytes to the pty", async () => {
  const writes = [];
  const host = await hostShowing(OFFER_FRAME, { writes });
  try {
    host.isFullscreenOfferOpen();
    host.acceptsPromptInput();
    assert.deepEqual(writes, [], "Sonata never answers a renderer choice on the user's behalf");
  } finally {
    host.dispose();
  }
});

await check("the guard is claude-only", async () => {
  // A codex frame can never reach a claude-shaped needle — the same construction
  // rule the Rewind panel carries.
  const host = await hostShowing(OFFER_FRAME, { provider: "codex" });
  try {
    assert.equal(host.isFullscreenOfferOpen(), false);
  } finally {
    host.dispose();
  }
});

await check("no screen model reads CLOSED, never a hold", async () => {
  // No PTY means no grid. Matching every other gate here: absence reads "nothing
  // on screen", so a hostless host cannot wedge a task at 'starting'.
  const host = makeClaudeHost();
  try {
    assert.equal(host.isFullscreenOfferOpen(), false);
  } finally {
    host.dispose();
  }
});

// ── harness ─────────────────────────────────────────────────────────────────

/** A host parked on one screen, with BOTH channels populated: the grid the
 *  guard reads AND the pty tail the composer scrape reads. Setting the tail is
 *  not decoration — leaving it empty makes `detectIdlePrompt` fail on a
 *  degenerate `lastPromptIndex === -1`, so every gate case would "pass" without
 *  the scrape ever being open, and the guard would be pinned by nothing. */
async function hostShowing(frame, { tail = frame, provider = "claude", writes = [] } = {}) {
  const host =
    provider === "claude"
      ? makeClaudeHost()
      : new TerminalHost({
          taskId: "claude-boot-interstitial-smoke-codex",
          provider,
          defaultWorkspace: process.cwd(),
          eventSink: () => {},
        });
  host.ptyProcess = fakePty(writes);
  host.screenModel = await screenModelFor(frame.replaceAll("\n", "\r\n"));
  host.rawTail = tail;
  return host;
}

function readFixture(relative) {
  return fs.readFileSync(path.join(FIXTURES, relative), "utf8");
}

async function screenModelFor(bytes) {
  const model = new TaskScreenModel(DIMENSIONS);
  model.write(bytes);
  await new Promise((resolve) => model.whenSettled(resolve));
  return model;
}

async function renderScreen(bytes) {
  const model = await screenModelFor(bytes);
  const text = model.viewportText();
  model.dispose();
  return text;
}

function fakePty(writes) {
  return {
    pid: 0,
    write: (data) => writes.push(data),
    kill() {},
    resize() {},
    onData() {},
    onExit() {},
  };
}

function makeClaudeHost() {
  return new TerminalHost({
    taskId: "claude-boot-interstitial-smoke",
    provider: "claude",
    defaultWorkspace: process.cwd(),
    eventSink: () => {},
  });
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

if (failures.length > 0) {
  console.error(`\n${failures.length} failing check(s): ${failures.join(", ")}`);
  process.exit(1);
}
console.log("\nclaude-boot-interstitial: all checks passed");
