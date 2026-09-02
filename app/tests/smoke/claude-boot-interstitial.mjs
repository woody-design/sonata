import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

// Claude BOOT-INTERSTITIAL guard + banner (upstream sync 2026-09-01, SL-3; the
// banner half added by SL-18). The boot ceremony sweep found exactly one screen
// between spawn and the first idle composer that Sonata could deliver into: the
// fullscreen-renderer offer. This pins the guard that holds readiness on it, and
// the surface that tells the user WHY the boot is holding.
//
// Six fences, one subject:
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
//   4. ARMING (SL-18) — the banner watchdog is WRITTEN one-shot, at the spawn
//      window. Source-shape strength, and labelled as such where it runs.
//   5. THE WATCHDOG (SL-18) — the offer's SCREEN surfaces needs-attention, the
//      grid is the channel (a tail-reading regression fires on an answered
//      offer), and no other screen raises it.
//   6. CLEARING (SL-18) — the banner retires when the offer leaves the screen,
//      once, and never without a raise.
//
// Plus the RED LINE, asserted at the byte level in 3 and 5: the guard and the
// watchdog write ZERO bytes. MEASURED (q9 case C), a delivery's paste is
// discarded at this screen and its submit CR answers `1. Yes, try it` — the CLI
// re-execs under a new renderer and the user's prompt is gone with no receipt and
// no error. Sonata holds and SAYS SO; the human answers in the co-visible
// Terminal.
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
//
// ── LIVE BACKING FOR §4–6 (SL-18) ───────────────────────────────────────────
//
// Fixtures cannot pin a timing claim, and the banner rests on two: that the 4s
// watchdog lands INSIDE a real offer window, and that the answering repaint
// actually reaches the coalesced scan the clearing pass rides. Both were measured
// against a live claude 2.1.258 through the production TerminalHost, with the
// one-time offer re-armed in a scratch CLAUDE_CONFIG_DIR the way q8 arm B does
// (probe q36; run twice, both runs tabulated in that spike's findings.md, F61 —
// TRACKED, unlike the capture, which the probe overwrites per run. The figures
// below are the SURVIVING capture's, i.e. run 2):
//
//   offer on the grid   837ms  ·  acceptsPromptInput() false (the SL-3 hold)
//   detected           4028ms
//   the human's Down   4073ms  ·  their Enter ("2. Not now")  4474ms
//   cleared            4620ms  ·  146ms after the ANSWERING ENTER — the next tick
//                                 of the 120ms APPROVAL_SCAN_CADENCE_MS the
//                                 clearing pass rides (148ms on run 1)
//
// …and the RED LINE held live: between the offer owning the grid and the human's
// own keystrokes, NOTHING reached the pty. Sonata's trust-dialog walk wrote at
// 332/683ms — a different screen, before the offer existed.
//
// The cases below are the fixture-level fences on the same behaviour, and they
// are what runs in CI; the probe is not part of this suite (it needs a live
// binary, a real config to copy, and ~5s of wall clock).
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
  // separates them is that a composer is UNDER them — and a composer carries a
  // glyph-anchored mode line (F6, in every mode), while the real offer paints
  // before any session exists and cannot.
  //
  // "NEVER absent" was over-stated and SL-5 falsified it (F28, q17 arm D at
  // 2.1.258): a single Ctrl-C at an idle composer REPLACES the mode-line row
  // with `Press Ctrl-C again to exit` for ~1–2s, so this negative fails OPEN for
  // that window. The guard survives on its two POSITIVE needles — see the
  // occlusion case at the end of this block.
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
  // The negative leans on one vocabulary, so it has to be true for every mode a
  // session can be in, not just the one the fixture happens to show. Rows are
  // MEASURED at 2.1.258 (SL-5 q17 arms A/C), byte-exact from the capture's
  // rendered rows — 2-space indent included, trailing padding trimmed by the
  // grid reader exactly as it is here.
  //
  // `dontAsk` joined this list in SL-5, and it is the reason the list is worth
  // looping: the shared phrase table did not carry its row, so a live `dontAsk`
  // composer read as "no mode line on screen" and this negative failed OPEN for
  // the entire life of such a session. A test that only knew the cycle's four
  // members could not have caught that — the fifth mode is not in the cycle, it
  // is spawn-only (`--permission-mode dontAsk`, reachable via the local API).
  for (const modeLine of [
    "  ⏸ manual mode on · ← for agents",
    "  ⏵⏵ accept edits on (shift+tab to cycle) · ← for agents",
    "  ⏸ plan mode on (shift+tab to cycle) · ← for agents",
    "  ⏵⏵ auto mode on (shift+tab to cycle) · ← for agents",
    "  ⏵⏵ don't ask on (shift+tab to cycle) · ← for agents",
  ]) {
    assert.equal(
      claudeFullscreenOfferOpen(`${OFFER_FRAME}\n❯ \n${modeLine}`),
      false,
      `a composer in ${modeLine.trim()} must defuse the signature`,
    );
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// THIS CASE PINS A KNOWN FALSE POSITIVE AS EXPECTED BEHAVIOUR.
//
// It is not a guard-correctness test. The first assertion asserts the WRONG
// answer on purpose, because that wrong answer is the measured truth at 2.1.258
// and leaving it unpinned would let it drift silently. Read a failure here as
// the BOUNDARY MOVING, not as a regression — most likely someone narrowed the
// occlusion window or added a second composer-presence signal, in which case the
// correct response is to delete this assertion and say so, never to "fix" the
// code back into firing. The second assertion is the one that must never fail:
// it is what keeps the false positive harmless in practice.
// ─────────────────────────────────────────────────────────────────────────────
await check("KNOWN BOUNDARY: the Ctrl-C hint occludes the mode line (pinned false positive)", async () => {
  // MEASURED (SL-5, F28 / q17 arm D at 2.1.258): one Ctrl-C at an idle composer
  // replaces the footer's mode-line row with this hint for ~1–2s. Row is
  // byte-exact from the capture — 2-space indent, 87 spaces, `/rc`, 118 cols.
  const occludedFooter =
    "  Press Ctrl-C again to exit                                                                                       /rc";

  // The negative genuinely fails, and for the resumed-repaint forgery class the
  // discriminator is the only thing standing between that screen and a true
  // verdict — so the surface is OPEN for the hint's lifetime, not merely wider.
  assert.equal(
    claudeFullscreenOfferOpen(`${OFFER_FRAME}\n❯ \n${occludedFooter}`),
    true,
    "KNOWN FALSE POSITIVE (expected): with the mode line occluded, condition 3 cannot defuse the signature",
  );

  // What keeps it harmless: the two POSITIVE needles are what a real screen has
  // to carry. An ORDINARY idle composer under the hint — the state a user
  // actually reaches by pressing Ctrl-C once — has neither, so the guard reads
  // closed and readiness is never held on it. THIS assertion is load-bearing.
  const idleUnderHint =
    "❯ \n" +
    "────────────────────────────────────────────\n" +
    `${occludedFooter}`;
  assert.equal(
    claudeFullscreenOfferOpen(idleUnderHint),
    false,
    "an idle composer under the Ctrl-C hint is not the boot offer",
  );

  // …and the hold that the false positive can produce is transient by
  // construction: the predicate re-evaluates per call (no latch of its own), so
  // the same host reads ready again the moment the mode line is back.
  const host = await hostShowing(`${OFFER_FRAME}\n❯ \n${occludedFooter}`);
  try {
    assert.equal(host.isFullscreenOfferOpen(), true, "premise: the host holds during the window");
    // Repaint the SAME host with the post-hint screen (the mode line is back).
    const occluded = host.screenModel;
    host.screenModel = await screenModelFor(
      `${OFFER_FRAME}\n❯ \n  ⏸ manual mode on · ← for agents`.replaceAll("\n", "\r\n"),
    );
    occluded.dispose();
    assert.equal(
      host.isFullscreenOfferOpen(),
      false,
      "the hold lifts as soon as the hint expires — bounded by the hint, not by the session",
    );
  } finally {
    host.dispose();
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

// ── 4. ARMING: one-shot, at the spawn window (SL-18) ────────────────────────
//
// Pinned at SOURCE-SHAPE strength, and this section does not pretend otherwise:
// it reads the product source and asserts on its text. It proves the arming is
// WRITTEN one-shot; it does not execute a timer. (The same construction, and the
// same honest limit, as the codex sibling in tests/smoke/codex-trust-dialog.mjs
// — see that file's section 2b for why a behavioural version was rejected: a
// >4s wall-clock PTY spawn for one boolean with no runtime inputs, or a
// never-taken idempotence branch added to the product purely to be observed.)
//
// WHAT IT BUYS, honestly. The signature is FORGEABLE by a verbatim quotation —
// nothing textual can separate a reproduction of the whole widget from the
// widget, and section 2's "resumed session repainting the offer" case is exactly
// that shape, held off only by the mode-line negative whose known occlusion
// window is pinned above. What makes the forgery unreachable is STRUCTURAL: at
// t+4s of a boot no prompt has been answered, so no model prose exists yet to
// quote it. That argument survives only while this check is one-shot. Making it
// periodic is not a hypothetical regression — the clearing pass rides a REPEATING
// cadence (`scheduleApprovalScan`), the two live in the same file and read the
// same grid, and unifying them is a natural-looking tidy-up. Nothing else in this
// suite would notice.

await check("arming: the offer watchdog is written one-shot, at the spawn window", () => {
  const source = readProductSource("runtime/terminal-host/terminal-host.ts");

  // The window, pinned by VALUE: the whole "no prose exists yet" argument is
  // about this number being a BOOT window, so a silent widening must not pass.
  assert.match(
    source,
    /const CLAUDE_BOOT_FULLSCREEN_OFFER_CHECK_MS = 4000;/,
    "the offer watchdog's window is 4000ms",
  );

  // Exactly ONE arming site, and it is a setTimeout — never an interval.
  const armings = source.match(/this\.claudeFullscreenOfferTimer = setTimeout\(/g) ?? [];
  assert.equal(armings.length, 1, "the timer is armed in exactly one place");
  assert.equal(
    /claudeFullscreenOfferTimer\s*=\s*setInterval/.test(source),
    false,
    "and never from setInterval — a periodic offer check is the forgery regression",
  );

  // ONE-SHOT: the handle is nulled as the callback's FIRST act, so the callback
  // has no live handle to re-arm and no second firing to schedule.
  assert.match(
    source,
    /this\.claudeFullscreenOfferTimer = setTimeout\(\(\) => \{\s*this\.claudeFullscreenOfferTimer = null;/,
    "the callback drops its own handle before doing anything else",
  );

  // Claude-only, and armed on the SPAWN path — not on a data or readiness path,
  // which is what would make it re-triggerable within a session.
  const spawnBlock = source.slice(
    source.indexOf('if (this.profile.provider === "claude") {\n      this.claudeFullscreenOfferTimer'),
    source.indexOf("this.claudeFullscreenOfferTimer.unref?.();"),
  );
  assert.ok(spawnBlock.length > 0, "the arming sits inside the claude provider branch");
  assert.match(spawnBlock, /CLAUDE_BOOT_FULLSCREEN_OFFER_CHECK_MS/, "…using the boot window constant");

  // Teardown clears it, so a dead/replaced session can never fire the watchdog it
  // armed — the other half of "once per spawn".
  assert.match(
    source,
    /if \(this\.claudeFullscreenOfferTimer\) \{\s*clearTimeout\(this\.claudeFullscreenOfferTimer\);\s*this\.claudeFullscreenOfferTimer = null;\s*\}/,
    "disposeProcess clears the armed timer",
  );

  // ONE CALL SITE — the assertion that actually names the regression this section
  // is about (SL-18 review, minor 1). Everything above pins the TIMER; none of it
  // pins where the CHECK is invoked from, so the specific tidy-up the section
  // header warns about — moving the detect check onto the repeating scan next to
  // its own clearing pass, which reads like a simplification — passed every one of
  // them. A periodic detect fires during a live turn, where model prose CAN quote
  // the offer's wording onto the grid, and the whole forgery argument collapses.
  const invocations = source.match(/this\.checkClaudeBootFullscreenOffer\(\)/g) ?? [];
  assert.equal(invocations.length, 1, "the offer check is invoked from exactly one place");
  assert.match(
    settledApprovalScanBody(source),
    /^(?!.*checkClaudeBootFullscreenOffer)/s,
    "…and that place is NOT the repeating settled-grid scan",
  );
});

// ── 5. THE WATCHDOG: surface, never answer (SL-18) ──────────────────────────
//
// SL-3 made readiness HOLD here. That hold is right and it is SILENT — the task
// reads "starting", the queued prompt waits, and nothing tells the user the CLI
// is parked on a question only the terminal pane can answer. These cases pin the
// surface that ends the silence, and the red line it lives under.

await check("watchdog: the offer SCREEN surfaces needs-attention with NO bytes written", async () => {
  const writes = [];
  const events = [];
  const host = await hostShowing(OFFER_FRAME, { writes, events });
  try {
    host.checkClaudeBootFullscreenOffer();

    const detected = events.filter((e) => e.type === "claude-fullscreen-offer:detected");
    assert.equal(detected.length, 1, "exactly one claude-fullscreen-offer:detected emitted");
    assert.equal(detected[0].payload.taskId, "claude-boot-interstitial-smoke");
    assert.deepEqual(writes, [], "RED LINE: the watchdog writes NO keys to the pty");
  } finally {
    host.dispose();
  }
});

await check("watchdog: reads the GRID, not the pty tail", async () => {
  // The tail CONTRADICTS the screen, or this case would prove nothing: it still
  // holds the offer — where the offer's bytes stay forever, which is the whole
  // reason SL-3's signature moved off the stream — while the grid has repainted
  // past it to the MEASURED answered composer. A watchdog that regressed to
  // reading `rawTail` raises a banner here, over an offer already answered.
  //
  // The tail is the offer ALONE, and the reason is worth stating rather than
  // hiding, because it BOUNDS what this case proves. On the ordinary production
  // tail — offer bytes followed by the answered composer's — a tail read already
  // returns false, because the signature's third condition (a composer's
  // glyph-anchored mode line on the frame) is channel-agnostic and defuses it.
  // So the channel choice is not what saves that everyday case; condition 3 is.
  // What condition 3 canNOT defuse is a frame carrying the offer with no legible
  // mode line under it — the measured Ctrl-C occlusion window pinned in section
  // 2, and any stream window whose composer paint has not landed yet. Stripping
  // the tail to the offer isolates exactly that residual, which is the class this
  // watchdog's channel is load-bearing for.
  const events = [];
  const host = await hostShowing(ANSWERED_FRAME, { tail: OFFER_FRAME, events });
  try {
    assert.equal(
      claudeFullscreenOfferOpen(host.rawTail),
      true,
      "premise: a tail-reading watchdog WOULD fire here",
    );
    assert.equal(
      claudeFullscreenOfferOpen(host.screenModel.viewportText()),
      false,
      "…and the grid, which the watchdog actually reads, says the offer is gone",
    );
    host.checkClaudeBootFullscreenOffer();
    assert.equal(
      events.filter((e) => e.type === "claude-fullscreen-offer:detected").length,
      0,
      "an answered offer lingering in the tail must not raise the banner",
    );
  } finally {
    host.dispose();
  }
});

await check("watchdog: an ordinary boot surfaces nothing — no banner flash", async () => {
  // The release-notes boot screen from section 2: a banner over a LIVE composer,
  // measured `ready` at 937ms. It is the state the overwhelming majority of boots
  // are in when the watchdog elapses, and it must produce silence.
  const events = [];
  const notesFrame =
    " ▐▛███▛█   Claude Code v2.1.257\n" +
    "  Updated to latest. Got 62 features, 379 bugfixes, and 211 other changes.\n" +
    "  code.claude.com/docs/en/changelog for details\n" +
    "❯ \n" +
    "  ⏸ manual mode on · ← for agents";
  const host = await hostShowing(notesFrame, { events });
  try {
    assert.equal(host.acceptsPromptInput(), true, "premise: this is a healthy boot");
    host.checkClaudeBootFullscreenOffer();
    assert.equal(
      events.filter((e) => e.type === "claude-fullscreen-offer:detected").length,
      0,
      "no banner without the offer signature",
    );
  } finally {
    host.dispose();
  }
});

await check("watchdog: a codex session can never raise the claude banner", async () => {
  // Provider scoping is carried by the predicate itself (`isFullscreenOfferOpen`
  // is claude-only), so a codex host handed the offer's own frame stays silent.
  // The claude and codex watchdogs share a settled-grid pass in production; this
  // is what keeps that sharing from crossing the providers.
  const events = [];
  const host = await hostShowing(OFFER_FRAME, { provider: "codex", events });
  try {
    host.checkClaudeBootFullscreenOffer();
    assert.equal(
      events.filter((e) => e.type === "claude-fullscreen-offer:detected").length,
      0,
      "a claude-shaped needle cannot fire on a codex host",
    );
  } finally {
    host.dispose();
  }
});

// ── 6. CLEARING (SL-18) ─────────────────────────────────────────────────────
//
// ONE leg, where the codex trust-dialog sibling has two, and the asymmetry is
// structural. `isCodexTrustDialogOpen()` is ranked BELOW the SessionStart
// short-circuit, so a hook-live codex session can read ready with the answered
// dialog's cells still on the grid — hence that banner's second, readiness-shaped
// disjunct. `isFullscreenOfferOpen()` is ranked ABOVE that short-circuit (pinned
// in section 3), so while the offer owns the grid `acceptsPromptInput()` is false
// BY CONSTRUCTION and a readiness disjunct could never be the one that fires. The
// grid leaving the offer behind is the only operative signal, and the case below
// isolates it: the tail is left holding the offer, so only the grid can tell.

await check("clearing: the pass is WIRED into the repeating settled-grid scan", () => {
  // THE GAP THIS CLOSES (SL-18 review, minor 1 — family-wide). Every behavioural
  // case in this section calls `checkClaudeFullscreenOfferCleared()` by hand, so
  // they pin what the method DOES and nothing at all about whether the product
  // ever calls it. Delete the ride-along from `scheduleApprovalScan` and the whole
  // suite stayed green while the banner became un-retirable short of `pty:exit` —
  // a stale "answer it in the CLI" pointer standing over a live composer, which is
  // precisely the pointer-at-nothing this family's copy is not allowed to be.
  //
  // The gap was inherited verbatim from the codex trust-dialog sibling, whose
  // clearing cases call their method directly for the same reason. So the fence is
  // written FAMILY-WIDE and duplicated into both smokes rather than living in one:
  // the site is shared, and each member's own test must fail when that site loses
  // EITHER call — a fence that lives only in the sibling's file is a fence the
  // person deleting your call never runs.
  //
  // Source-shape strength, and scoped to the CALLBACK rather than the file: what
  // matters is not that the name appears somewhere in terminal-host.ts but that it
  // is invoked from the REPEATING scan, which is the thing that makes the banner
  // retire promptly (MEASURED at 146ms after the answering Enter — see the live
  // backing in this file's header).
  const body = settledApprovalScanBody(readProductSource("runtime/terminal-host/terminal-host.ts"));
  assert.match(
    body,
    /this\.checkClaudeFullscreenOfferCleared\(\);/,
    "the claude offer banner's clearing pass rides the settled-grid scan",
  );
  assert.match(
    body,
    /this\.checkCodexTrustDialogCleared\(\);/,
    "…and so does its codex sibling — one site, both members, neither droppable alone",
  );
});

await check("clearing: the offer leaves the SCREEN → cleared, exactly once", async () => {
  const events = [];
  const host = await hostShowing(OFFER_FRAME, { events });
  try {
    host.checkClaudeBootFullscreenOffer();
    assert.equal(
      events.filter((e) => e.type === "claude-fullscreen-offer:detected").length,
      1,
      "banner raised",
    );

    // The human answered in the CLI; the screen repainted past the offer. The
    // MEASURED answered frame, and the tail deliberately still carries the offer.
    const answered = host.screenModel;
    host.screenModel = await screenModelFor(ANSWERED_FRAME.replaceAll("\n", "\r\n"));
    answered.dispose();
    assert.equal(
      claudeFullscreenOfferOpen(host.rawTail),
      true,
      "the offer is still in the tail — only the grid says it is gone",
    );
    host.checkClaudeFullscreenOfferCleared();

    const cleared = events.filter((e) => e.type === "claude-fullscreen-offer:cleared");
    assert.equal(cleared.length, 1, "exactly one claude-fullscreen-offer:cleared emitted");
    assert.equal(cleared[0].payload.taskId, "claude-boot-interstitial-smoke");

    // One-shot: a second pass over the same state says nothing more.
    host.checkClaudeFullscreenOfferCleared();
    assert.equal(
      events.filter((e) => e.type === "claude-fullscreen-offer:cleared").length,
      1,
      "cleared is emitted at most once per detection",
    );
  } finally {
    host.dispose();
  }
});

await check("clearing: a still-open offer keeps the banner up", async () => {
  // The pass runs on every settled grid while the banner is raised, so the frames
  // BEFORE the answer must say nothing — a `cleared` here would retire the banner
  // over an offer that is still waiting for the human.
  const events = [];
  const host = await hostShowing(OFFER_FRAME, { events });
  try {
    host.checkClaudeBootFullscreenOffer();
    host.checkClaudeFullscreenOfferCleared();
    host.checkClaudeFullscreenOfferCleared();
    assert.equal(
      events.filter((e) => e.type === "claude-fullscreen-offer:cleared").length,
      0,
      "the offer still owns the grid",
    );
  } finally {
    host.dispose();
  }
});

await check("clearing: a banner that was never raised is never 'cleared'", async () => {
  const events = [];
  const host = await hostShowing(ANSWERED_FRAME, { events });
  try {
    host.checkClaudeFullscreenOfferCleared();
    assert.equal(
      events.filter((e) => e.type === "claude-fullscreen-offer:cleared").length,
      0,
      "no cleared without a detected",
    );
  } finally {
    host.dispose();
  }
});

await check("clearing: a dead PTY resets the flag instead of leaking a stale verdict", async () => {
  // `disposeProcess` emits no `cleared` on the way out — the renderer retires the
  // banner on the task's `pty:exit`. What the host owes is that the NEXT spawn
  // starts from scratch: a surfaced flag inherited across a teardown would make
  // the first post-answer repaint of the next session emit a `cleared` for a
  // banner this session never raised.
  const events = [];
  const host = await hostShowing(OFFER_FRAME, { events });
  try {
    host.checkClaudeBootFullscreenOffer();
    assert.equal(
      events.filter((e) => e.type === "claude-fullscreen-offer:detected").length,
      1,
      "banner raised",
    );
    host.dispose();
    events.length = 0;

    // A fresh session on a screen with no offer: the flag must be down, so the
    // clearing pass has nothing to retire.
    host.ptyProcess = fakePty([]);
    host.screenModel = await screenModelFor(ANSWERED_FRAME.replaceAll("\n", "\r\n"));
    host.checkClaudeFullscreenOfferCleared();
    assert.equal(
      events.filter((e) => e.type === "claude-fullscreen-offer:cleared").length,
      0,
      "teardown reset the surfaced flag",
    );
  } finally {
    host.dispose();
  }
});

// ── harness ─────────────────────────────────────────────────────────────────

/** Read a product source file for the source-shape fence in section 4 (the
 *  tests/smoke/codex-trust-dialog.mjs and terminal-grid-substrate.mjs pattern).
 *  Source, never dist: the fence is about what is WRITTEN, and a compiler could
 *  legitimately reshape the emitted form. */
function readProductSource(relative) {
  return fs.readFileSync(path.resolve(FIXTURES, "../../src", relative), "utf8");
}

/** The body of `scheduleApprovalScan` — the REPEATING, throttled grid pass. Sliced
 *  rather than grepped file-wide because both fences that use it are claims about
 *  WHERE a call lives, not whether the name occurs: the clearing pass must be
 *  inside this callback (so the banner retires on a repaint) and the detect check
 *  must be outside it (so it stays one-shot at the boot window). The slice is
 *  anchored on the method's own opening line and the cadence constant that closes
 *  its setTimeout, both of which are pinned by name elsewhere in this family. */
function settledApprovalScanBody(source) {
  const start = source.indexOf("private scheduleApprovalScan(): void {");
  assert.notEqual(start, -1, "premise: scheduleApprovalScan is still spelled that way");
  const end = source.indexOf("}, APPROVAL_SCAN_CADENCE_MS);", start);
  assert.notEqual(end, -1, "premise: the scan still closes on the cadence constant");
  return source.slice(start, end);
}

/** A host parked on one screen, with BOTH channels populated: the grid the
 *  guard reads AND the pty tail the composer scrape reads. Setting the tail is
 *  not decoration — leaving it empty makes `detectIdlePrompt` fail on a
 *  degenerate `lastPromptIndex === -1`, so every gate case would "pass" without
 *  the scrape ever being open, and the guard would be pinned by nothing. */
async function hostShowing(
  frame,
  { tail = frame, provider = "claude", writes = [], events = null } = {},
) {
  const host =
    provider === "claude"
      ? makeClaudeHost(events)
      : new TerminalHost({
          taskId: "claude-boot-interstitial-smoke-codex",
          provider,
          defaultWorkspace: process.cwd(),
          eventSink: events ? (event) => events.push(event) : () => {},
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

function makeClaudeHost(events = null) {
  return new TerminalHost({
    taskId: "claude-boot-interstitial-smoke",
    provider: "claude",
    defaultWorkspace: process.cwd(),
    eventSink: events ? (event) => events.push(event) : () => {},
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
