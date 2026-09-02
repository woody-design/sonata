import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

// Codex boot directory-trust dialog surfacing (codex-trust S2). When codex parks
// on its onboarding trust screen instead of the composer, Sonata must name what
// is happening and point at the CLI window — and must NEVER answer the dialog.
// Three fences, one subject:
//
//   1. SIGNATURE (`isCodexTrustDialog`) — fires on the real dialog SCREEN, read
//      through a real `TaskScreenModel` so the test drives the same grid the
//      product does (D-1: a state query belongs on the grid, never the tail).
//   2. FORGERY RESISTANCE — assistant prose carrying the dialog's own hint
//      vocabulary must NOT fire it. This dialog's question is exactly the
//      sentence a session ABOUT this code prints, which is why the signature is
//      a three-way co-occurrence rather than a substring.
//   3. CLEARING (plan L2) — once the human answers, the banner retires by
//      itself. Both of the retirement disjuncts are exercised INDEPENDENTLY,
//      because they are meant to be independent.
//
// Plus the RED LINE these three exist under, asserted at the byte level: the
// watchdog writes ZERO bytes to the pty. Its "Yes, continue" is a consent
// decision about what a folder's own `.codex/` layer may load; its other answer
// quits the process. Sonata surfaces; the user answers.
//
// ── FIXTURE PROVENANCE ──────────────────────────────────────────────────────
//
// MEASURED. `DIALOG_BYTES` and `POST_TRUST_BYTES` are byte-derived from the
// 2026-07-17 field repro (the BeDog session whose first delivery's Enter
// silently answered this dialog) — the capture that also produced the
// `bootDialogHints` readiness guard. The spike directory itself is gone from the
// tree (spikes are process-private and throwaway by default, D6), but its
// derived screens survive verbatim in `tests/smoke/task-ready-detection.mjs`
// (":206-216" the dialog, ":222-227" the answered screen), where the readiness
// guard consumes them; every literal below is transcribed from there character
// for character. Each of those literals was then re-verified VERBATIM against
// upstream `codex-rs/tui/src/onboarding/trust_directory.rs` @ `rust-v0.146.1`
// (S0 report §6, dialog-wording row: byte-identical at 0.146.1).
//
// ADAPTED. Those two are STREAM fixtures — the collapsed cell-diff form, with
// the option rows glued into one line ("Yes, continue2.No,quit…"). Feeding them
// to a real `TaskScreenModel` is the adaptation: the emulator lays the bytes out
// as a grid and the test reads `viewportText()`, which is precisely the shape
// the product hands the signature. Nothing is re-typed to make it match — the
// whitespace-strip in the parser is what makes the collapsed and laid-out forms
// read alike, and `DIALOG_146_GRID` below proves it on the laid-out form.
//
// COMPOSED. (a) `DIALOG_146_GRID` — the 0.146.1 widget as it lays out on a real
// grid, including the git-root note and an error line. Its STRINGS are upstream
// verbatim (the `trust_directory.rs` read above: the header, the git-root note,
// the three-sentence question paragraph, the two option labels, the footer); the
// LAYOUT — which row each lands on, the indents, the digits — is composed. This
// fixture's job is tolerance: the note and the error line must change nothing.
// (b) The `\x1b[2J\x1b[H` screen clear that stands in for codex's post-answer
// repaint. Sonata has never measured that repaint, and has reason to think it is
// NOT a clean wipe: codex is launched with `--no-alt-screen`, so the answered
// dialog's rows stay inline and scroll rather than vanishing with a buffer swap.
// That is exactly why the banner's retirement has two independent legs and why
// this composed clear is confined to the leg that is ABOUT the grid — leg 2
// below deliberately leaves the dialog's cells standing. (c) Every prose
// negative.
const require = createRequire(import.meta.url);
const { TerminalHost, isCodexTrustDialog, detectIdlePromptForProvider, normalizeTerminalDimensions } =
  require("../../dist/runtime");
const { TaskScreenModel } = require("../../dist/runtime/terminal-host/task-screen-model");

const failures = [];

// The task's real geometry class: wide enough that the widget's own lines do not
// wrap, tall enough that the whole dialog is inside one viewport. (A viewport too
// SHORT to hold the whole widget is a known, documented boundary of the grid
// channel — see the KNOWN BOUNDARY note on `isCodexTrustDialog`.)
const DIMENSIONS = normalizeTerminalDimensions(120, 30);

// Declared with the constants, not down among the helpers: the source-shape
// fence runs at top level, so a `const` below it would be in its TDZ.
const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../src");

/** Read a product source file for the source-shape fence (the
 *  terminal-grid-substrate.mjs pattern). Source, never dist: the fence is about
 *  what is WRITTEN, and a compiler could legitimately reshape the emitted form. */
function readProductSource(relative) {
  return fs.readFileSync(path.join(SRC, relative), "utf8");
}

// MEASURED (see PROVENANCE). The dialog as it reached the byte stream: codex
// paints the option cursor with the composer's own `›`, and the cell-diff
// repaint glues the second row and the footer onto the first.
const DIALOG_BYTES =
  ">You are in /var/folders/xx/T/sonata-task-dir\r\n" +
  "Do you trust the contents of this directory?\r\n" +
  "Working with untrusted contents comes with higher risk of prompt injection.\r\n" +
  "Trusting the directory allows project-local config, hooks, and exec policies to load.\r\n" +
  "› 1. Yes, continue2.No,quitPress enter to continue";

// MEASURED (see PROVENANCE). After the human answers in the CLI, the real
// composer renders: the welcome box, the MCP boot activity line, and the `›`
// composer with its idle footer.
const POST_TRUST_BYTES =
  "╭───╮\r\n│ >_ OpenAI Codex (v0.144.5) │\r\n│ model: gpt-5.6-sol high │\r\n╰───╯\r\n" +
  "• Starting MCP servers (0/4): codex_apps, node_repl (0s • esc to interrupt)\r\n" +
  "›Use /skills to list available skillsgpt-5.6-sol high · /var/folders/xx/T/sonata-task-dir";

// COMPOSED layout over upstream-verbatim strings (see PROVENANCE). The two extra
// rows 0.146.1 can render — the git-root note and a caller-supplied error — are
// the whole point: the signature must tolerate them without depending on them.
const DIALOG_146_GRID =
  "> You are in /private/tmp/repo/packages/app\n" +
  "\n" +
  "Note: You're in a subdirectory of a Git project. Trusting will apply to the repository root: /private/tmp/repo\n" +
  "\n" +
  "Do you trust the contents of this directory? Working with untrusted contents comes with higher risk of\n" +
  "prompt injection. Trusting the directory allows project-local config, hooks, and exec policies to load.\n" +
  "\n" +
  "› 1. Yes, continue\n" +
  "  2. No, quit\n" +
  "\n" +
  "failed to write trust decision: permission denied\n" +
  "\n" +
  "Press enter to continue and create a sandbox for this session\n";

// ── 1. SIGNATURE ────────────────────────────────────────────────────────────

await check("signature: the MEASURED dialog fires on the reconstructed SCREEN", async () => {
  const screen = await renderScreen(DIALOG_BYTES);
  assert.equal(isCodexTrustDialog(screen), true, "the dialog is identified on the grid");
});

await check("signature: the 0.146.1 widget's extra lines are tolerated, not required", () => {
  assert.equal(
    isCodexTrustDialog(DIALOG_146_GRID),
    true,
    "git-root note + error line + the longer footer change nothing",
  );
  // The laid-out grid and the collapsed cell-diff stream are ONE needle set: the
  // parser's whitespace-strip is what makes that true, so a regression to
  // space-sensitive needles fails on one form or the other.
  assert.equal(
    isCodexTrustDialog(DIALOG_146_GRID.replace(/\n/g, "")),
    true,
    "row layout is irrelevant after the whitespace-strip",
  );
});

await check("signature: recognition is cursor-position-INDEPENDENT", () => {
  // Arrowing onto "No, quit" moves the `›` and nothing else. A predicate that
  // reasoned about where the cursor sits is defeated by exactly that keypress
  // (the B1 lesson pinned in claudeRewindPanelOpen) — and this is the sub-state
  // where the dialog's Enter QUITS the process.
  const arrowed = DIALOG_146_GRID.replace("› 1. Yes, continue", "  1. Yes, continue").replace(
    "  2. No, quit",
    "› 2. No, quit",
  );
  assert.notEqual(arrowed, DIALOG_146_GRID, "the fixture really did change");
  assert.equal(isCodexTrustDialog(arrowed), true, "arrowing must not change the verdict");
});

await check("signature: an answered dialog's SCREEN reads false", async () => {
  const screen = await renderScreen(`${DIALOG_BYTES}\x1b[2J\x1b[H${POST_TRUST_BYTES}`);
  assert.equal(isCodexTrustDialog(screen), false, "the repainted-past dialog is simply gone");
  assert.equal(isCodexTrustDialog(""), false, "no grid is never the dialog");
});

// ── 2. FORGERY RESISTANCE ───────────────────────────────────────────────────

await check("forgery: prose carrying the hint vocabulary does NOT fire the signature", () => {
  // COMPOSED negatives — the shapes a model actually writes. The strong anchor
  // alone is the dangerous one: this dialog's question is literally the sentence
  // a session discussing this slice prints.
  const quotesTheQuestion =
    "⏺ The codex trust gate asks \"Do you trust the contents of this directory?\" before it will\n" +
    "  start a session, and Sonata pre-trusts the cwd so it never appears.\n";
  assert.equal(isCodexTrustDialog(quotesTheQuestion), false, "the question alone is prose");

  const quotesTheOptions =
    "⏺ The onboarding screen offers two answers: 1. Yes, continue and 2. No, quit — there is no\n" +
    "  third option, which is why pre-trusting is the same as pre-answering it.\n";
  assert.equal(isCodexTrustDialog(quotesTheOptions), false, "the option rows alone are prose");

  const hintWordSoup =
    "⏺ Do you trust this directory? Working with untrusted contents is risky. Press enter to\n" +
    "  continue and I will say yes, continue with the plan — otherwise, no, quit early.\n";
  assert.equal(
    isCodexTrustDialog(hintWordSoup),
    false,
    "every bootDialogHints word present, unnumbered rows and a re-worded question → prose",
  );

  // The Full Access consent dialog shares the `Yes, continue` PREFIX (its row is
  // `Yes, continue anyway`) and is a real screen, not prose. It must not collide:
  // it carries neither the trust question nor a `No, quit` row.
  const consentScreen =
    "Enable full access?\n" +
    "› 1. Yes, continue anyway  Apply full access for this session\n" +
    "  2. Cancel                Go back without enabling full access\n" +
    "Press enter to confirm or esc to go back\n";
  assert.equal(isCodexTrustDialog(consentScreen), false, "the consent dialog is a different screen");
});

// A verbatim reproduction of the whole widget is, by construction, textually
// indistinguishable from the widget — no signature can separate them, and
// claiming otherwise would be the lie. What makes it unreachable is STRUCTURAL:
// two guards, which this file checks at two DIFFERENT strengths. Saying so
// precisely matters, because the weaker of the two is the load-bearing half.
//
//   GUARD 1 — the watchdog is ONE-SHOT, `CODEX_BOOT_TRUST_DIALOG_CHECK_MS` after
//   the spawn. This is what makes the verbatim quotation unreachable IN GENERAL:
//   at t+4s of a boot no prompt has been answered, so no model prose exists yet
//   to quote it. It is pinned in "arming" below at SOURCE-SHAPE strength only —
//   the window value, the single `setTimeout` arming site, the handle nulled as
//   the callback's first act, and the teardown clear. That is weaker than a
//   behavioural assertion and is labelled as such there; see the section's own
//   note for why a behavioural one was rejected.
//
//   GUARD 2 — it fires only while `acceptsPromptInput()` is false. BEHAVIOURALLY
//   asserted, in "watchdog: a ready composer suppresses the banner even with the
//   dialog on screen" below.
//
// Neither guard is asserted by the prose negatives above; those pin the
// signature's own specificity, which is a separate claim.

// ── 2b. ARMING: one-shot, at the spawn window ───────────────────────────────
//
// GUARD 1 of the forgery argument above. Pinned at SOURCE-SHAPE strength, and
// this section does not pretend otherwise: it reads the product source and
// asserts on its text. It proves the arming is WRITTEN one-shot; it does not
// execute a timer.
//
// Why not behavioural. Driving the real thing means `startTask`, which spawns a
// PTY — an Electron interpreter, a spawnable stand-in binary, and a >4s
// wall-clock wait for one boolean. That is a slow, environment-coupled test for
// a property with no runtime inputs, and the only alternative (an idempotence
// guard inside `checkCodexBootTrustDialog` so a double call is observable) means
// adding a branch to the product that can never be taken — defensive noise by
// this codebase's own standard, and the same reason the signature refuses a
// negative lookahead the co-occurrence already covers.
//
// What it therefore buys, honestly stated: it catches the regression that
// actually threatens the forgery argument — someone making this check PERIODIC.
// That is not hypothetical. The clearing pass 500 lines below deliberately rides
// a repeating cadence (`scheduleApprovalScan`), the two live in the same file
// and read the same grid, and unifying them is a natural-looking tidy-up. A
// re-arming trust check fires during a live turn, where model prose exists and a
// verbatim quotation is reachable. Nothing else in this suite would notice.
//
// Precedent for reading product source in a fence: tests/smoke/
// terminal-grid-substrate.mjs (same reasoning — the property lives in an
// internal with no public accessor, and adding one purely for a test would put
// test scaffolding in the product).

await check("arming: the trust watchdog is written one-shot, at the spawn window", () => {
  const source = readProductSource("runtime/terminal-host/terminal-host.ts");

  // The window. Pinned by VALUE so a silent widening cannot pass — the whole
  // "no prose exists yet" argument is about this number being a boot window.
  assert.match(
    source,
    /const CODEX_BOOT_TRUST_DIALOG_CHECK_MS = 4000;/,
    "the trust watchdog's window is 4000ms",
  );

  // Exactly ONE arming site, and it is a setTimeout — never an interval.
  const armings = source.match(/this\.codexTrustDialogTimer = setTimeout\(/g) ?? [];
  assert.equal(armings.length, 1, "the timer is armed in exactly one place");
  assert.equal(
    /codexTrustDialogTimer\s*=\s*setInterval/.test(source),
    false,
    "and never from setInterval — a periodic trust check is the forgery regression",
  );

  // ONE-SHOT: the handle is nulled as the callback's FIRST act, so the callback
  // has no live handle to re-arm and no second firing to schedule.
  assert.match(
    source,
    /this\.codexTrustDialogTimer = setTimeout\(\(\) => \{\s*this\.codexTrustDialogTimer = null;/,
    "the callback drops its own handle before doing anything else",
  );

  // Codex-only, and armed on the spawn path (not on a data/readiness path, which
  // is what would make it re-triggerable within a session).
  const spawnBlock = source.slice(
    source.indexOf('if (this.profile.provider === "codex") {'),
    source.indexOf("this.codexTrustDialogTimer.unref?.();"),
  );
  assert.ok(spawnBlock.length > 0, "the arming sits inside the codex provider branch");
  assert.match(spawnBlock, /CODEX_BOOT_TRUST_DIALOG_CHECK_MS/, "…using the boot window constant");

  // Teardown clears it, so a dead/replaced session can never fire the watchdog
  // it armed — the other half of "once per spawn".
  assert.match(
    source,
    /if \(this\.codexTrustDialogTimer\) \{\s*clearTimeout\(this\.codexTrustDialogTimer\);\s*this\.codexTrustDialogTimer = null;\s*\}/,
    "disposeProcess clears the armed timer",
  );
});

// ── 3. THE WATCHDOG: surface, never answer ──────────────────────────────────

await check("watchdog: the dialog SCREEN surfaces needs-attention with NO bytes written", async () => {
  const writes = [];
  const events = [];
  const host = makeCodexHost(events);
  try {
    host.ptyProcess = fakePty(writes);
    host.screenModel = await screenModelFor(DIALOG_BYTES);
    // The tail CONTRADICTS nothing here, but it is set to the byte form the
    // stream actually carries so a regression to `cleanTerminal(rawTail)` would
    // still have to go through the grid to be right.
    host.rawTail = DIALOG_BYTES;
    host.checkCodexBootTrustDialog();

    const detected = events.filter((e) => e.type === "codex-trust-dialog:detected");
    assert.equal(detected.length, 1, "exactly one codex-trust-dialog:detected emitted");
    assert.equal(detected[0].payload.taskId, "codex-trust-dialog-smoke");
    assert.equal(writes.length, 0, "RED LINE: the watchdog writes NO keys to the pty");
  } finally {
    host.dispose();
  }
});

await check("watchdog: reads the GRID, not the pty tail", async () => {
  const events = [];
  const host = makeCodexHost(events);
  try {
    host.ptyProcess = fakePty([]);
    // The tail is set to CONTRADICT the screen, or this case would prove nothing.
    // It holds the dialog — where its bytes stay forever, which is the whole
    // reason this signature moved off the stream — and therefore also holds
    // readiness (the `bootDialogHints` guard), so the outer `acceptsPromptInput()`
    // gate is OPEN and cannot be what suppresses the event. The only thing left
    // that can is the grid, which has repainted past the dialog. A watchdog that
    // regressed to `cleanTerminal(rawTail)` raises a banner here, over a dialog
    // the user answered minutes ago.
    host.rawTail = DIALOG_BYTES;
    host.screenModel = await screenModelFor(`${DIALOG_BYTES}\x1b[2J\x1b[H${POST_TRUST_BYTES}`);
    assert.equal(host.acceptsPromptInput(), false, "the readiness guard is NOT what suppresses it");
    assert.equal(isCodexTrustDialog(host.rawTail), true, "a tail-reading watchdog WOULD fire here");
    host.checkCodexBootTrustDialog();
    assert.equal(
      events.filter((e) => e.type === "codex-trust-dialog:detected").length,
      0,
      "an answered dialog lingering in the tail must not raise the banner",
    );
  } finally {
    host.dispose();
  }
});

await check("watchdog: a session with no dialog on screen surfaces nothing", async () => {
  const writes = [];
  const events = [];
  const host = makeCodexHost(events);
  try {
    host.ptyProcess = fakePty(writes);
    host.screenModel = await screenModelFor("• Working (2s · esc to interrupt)\r\n");
    host.rawTail = "• Working (2s · esc to interrupt)\r\n";
    host.checkCodexBootTrustDialog();
    assert.equal(
      events.filter((e) => e.type === "codex-trust-dialog:detected").length,
      0,
      "no banner without the dialog signature",
    );
    assert.equal(writes.length, 0, "still no bytes written");
  } finally {
    host.dispose();
  }
});

await check("watchdog: a ready composer suppresses the banner even with the dialog on screen", async () => {
  const events = [];
  const host = makeCodexHost(events);
  try {
    host.ptyProcess = fakePty([]);
    host.screenModel = await screenModelFor(DIALOG_BYTES);
    // The readiness gate is the outer guard: a session whose composer is up is
    // not parked, whatever is on screen. (Contrived here — the two cannot really
    // co-occur — but it pins the guard, which is also what makes the signature
    // unforgeable in practice: no model prose can exist before the first prompt.)
    host.noteHookSessionStart();
    assert.equal(host.acceptsPromptInput(), true, "the hook declared the composer up");
    host.checkCodexBootTrustDialog();
    assert.equal(
      events.filter((e) => e.type === "codex-trust-dialog:detected").length,
      0,
      "acceptsPromptInput() outranks the signature",
    );
  } finally {
    host.dispose();
  }
});

// ── 4. CLEARING (plan L2) ───────────────────────────────────────────────────
//
// The banner asserts a conjunction — no composer AND the dialog on screen — so it
// retires as soon as EITHER conjunct fails. The two legs are exercised
// separately, on purpose: each must be sufficient by itself.
//
// SL-6 NARROWED leg 2, and by more than it first looks.
// `isCodexTrustDialogOpen()` is now ranked inside `acceptsPromptInput()` (it is
// a screen owner: the boot latch must not open on a screen whose Enter answers a
// consent question), so a SCRAPE-derived composer can no longer read ready while
// the dialog's cells are on the grid. The hook path cannot rescue it AT BOOT
// either: codex emits SessionStart LAZILY — with the first UserPromptSubmit, not
// at spawn (probed 0.144.4/0.144.5; runtime-controller's `watchHooks` documents
// the same fact) — and a first UserPromptSubmit needs a delivery, which needs
// the very latch this guards. During a codex BOOT `hookSessionStarted` is
// therefore provably false, and LEG 1 IS THE ONLY OPERATIVE LEG THERE.
//
// So leg 2 below is a unit-level pin for the states where the hook HAS fired —
// after the first submit, across /clear, on resume — where an answered dialog's
// cells can still be scrolling up the viewport. It calls `noteHookSessionStart()`
// by hand, which is honest for exactly those states and is NOT a boot scenario;
// the case is kept because those states are real, not because boot reaches it.
//
// This strengthens the ranking decision rather than complicating it: with the
// hook provably unset during a boot, ranking the grid predicate BELOW the hook
// short-circuit cannot be bypassed pre-answer — there is no pre-answer state in
// which the short-circuit fires — while still avoiding a false hold on a
// post-answer session the CLI has already declared started.

await check("clearing, leg 1: the dialog leaves the SCREEN → cleared", async () => {
  const events = [];
  const host = makeCodexHost(events);
  try {
    host.ptyProcess = fakePty([]);
    host.screenModel = await screenModelFor(DIALOG_BYTES);
    host.rawTail = DIALOG_BYTES;
    host.checkCodexBootTrustDialog();
    assert.equal(detectedCount(events), 1, "banner raised");

    // The human answered; the screen repainted past the dialog. The TAIL is left
    // exactly as it was, so ONLY the grid can tell — and readiness still reads
    // false off that unchanged tail, which isolates this leg from leg 2.
    host.screenModel = await screenModelFor(`${DIALOG_BYTES}\x1b[2J\x1b[H• Booting MCP server: codex_apps\r\n`);
    assert.equal(host.acceptsPromptInput(), false, "leg 2 is NOT what clears this case");
    host.checkCodexTrustDialogCleared();

    const cleared = events.filter((e) => e.type === "codex-trust-dialog:cleared");
    assert.equal(cleared.length, 1, "exactly one codex-trust-dialog:cleared emitted");
    assert.equal(cleared[0].payload.taskId, "codex-trust-dialog-smoke");

    // One-shot: a second pass over the same state says nothing more.
    host.checkCodexTrustDialogCleared();
    assert.equal(
      events.filter((e) => e.type === "codex-trust-dialog:cleared").length,
      1,
      "cleared is emitted at most once per detection",
    );
  } finally {
    host.dispose();
  }
});

await check("clearing, leg 2: the composer accepts input again → cleared", async () => {
  const events = [];
  const host = makeCodexHost(events);
  try {
    host.ptyProcess = fakePty([]);
    host.screenModel = await screenModelFor(DIALOG_BYTES);
    host.rawTail = DIALOG_BYTES;
    host.checkCodexBootTrustDialog();
    assert.equal(detectedCount(events), 1, "banner raised");

    // The MEASURED answered screen — and the dialog's cells are deliberately
    // LEFT on the grid (no screen clear), because codex is spawned
    // `--no-alt-screen`: an answered dialog does not vanish with a buffer swap,
    // its rows scroll up, and the banner must not be hostage to how long that
    // takes. The signal here is the CLI's OWN declaration that its session
    // started. Codex only makes that declaration once a prompt has been
    // submitted (lazy SessionStart — see the section header), so this is the
    // POST-first-submit / post-/clear / resume shape, not the boot shape; a
    // hook-live session IS the answer having been given, whatever is still on
    // the grid.
    const answered = `${DIALOG_BYTES}\r\n${POST_TRUST_BYTES}`;
    host.rawTail = answered;
    host.screenModel = await screenModelFor(answered);
    assert.equal(
      isCodexTrustDialog(host.screenModel.viewportText()),
      true,
      "leg 1 is NOT what clears this case — the dialog's cells are still on the grid",
    );
    // Pre-hook, the grid predicate now holds readiness shut (SL-6) — recorded
    // here rather than left implicit, because it is the whole reason this case
    // needs the hook to say anything at all.
    assert.equal(
      host.acceptsPromptInput(),
      false,
      "with the dialog's cells on the grid, the SCRAPE alone no longer reads ready",
    );
    host.noteHookSessionStart();
    assert.equal(host.acceptsPromptInput(), true, "the composer came back, via the hook");
    host.checkCodexTrustDialogCleared();

    assert.equal(
      events.filter((e) => e.type === "codex-trust-dialog:cleared").length,
      1,
      "the readiness leg clears the banner on its own",
    );
  } finally {
    host.dispose();
  }
});

await check("clearing: a banner that was never raised is never 'cleared'", async () => {
  const events = [];
  const host = makeCodexHost(events);
  try {
    host.ptyProcess = fakePty([]);
    host.screenModel = await screenModelFor(POST_TRUST_BYTES);
    host.checkCodexTrustDialogCleared();
    assert.equal(
      events.filter((e) => e.type === "codex-trust-dialog:cleared").length,
      0,
      "no cleared without a detected",
    );
  } finally {
    host.dispose();
  }
});

// ── 5. THE TWO LAYERS AGREE ─────────────────────────────────────────────────
//
// The readiness guard (`bootDialogHints`, S1's untouched negative signal) and
// this banner are two halves of one statement: the guard is WHY delivery waits,
// the banner is Sonata SAYING so. A change that moved one without the other
// would put the app back in the state this slice exists to end — knowing the
// reason and not telling anyone — so the agreement is pinned rather than assumed.

await check("the readiness guard and the banner see the same screen", async () => {
  const screen = await renderScreen(DIALOG_BYTES);
  assert.equal(
    detectIdlePromptForProvider(DIALOG_BYTES, "codex").ready,
    false,
    "bootDialogHints still holds readiness on the dialog (S1 guard untouched)",
  );
  assert.equal(isCodexTrustDialog(screen), true, "and the banner names why");

  assert.equal(
    detectIdlePromptForProvider(`${DIALOG_BYTES}\r\n${POST_TRUST_BYTES}`, "codex").ready,
    true,
    "readiness restores once answered",
  );
});

if (failures.length > 0) {
  process.exitCode = 1;
}
console.log(JSON.stringify({ smoke: "codex-trust-dialog", success: failures.length === 0 }, null, 2));

/** Write `bytes` into a real TaskScreenModel and hand back the settled grid —
 *  the same substrate and the same drain discipline the product reads through. */
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

function detectedCount(events) {
  return events.filter((e) => e.type === "codex-trust-dialog:detected").length;
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

function makeCodexHost(events) {
  return new TerminalHost({
    taskId: "codex-trust-dialog-smoke",
    provider: "codex",
    defaultWorkspace: process.cwd(),
    eventSink: (event) => events.push(event),
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
