import assert from "node:assert/strict";
import { createRequire } from "node:module";

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
// wrap, tall enough that the whole dialog is inside one viewport.
const DIMENSIONS = normalizeTerminalDimensions(120, 30);

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
// claiming otherwise would be the lie. What makes it unreachable is STRUCTURAL,
// and both guards are asserted below rather than asserted here: the watchdog is
// one-shot 4s after spawn (nothing has answered a prompt yet, so no model prose
// exists), and it fires only while `acceptsPromptInput()` is false.

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
    // LEFT on the grid (no screen clear), because Sonata has not measured
    // codex's post-answer repaint and the banner must not depend on it. The
    // readiness fence is the signal here: the codex `bootDialogHints` guard holds
    // shut for exactly as long as the dialog is unanswered, so a composer that
    // reads ready IS the answer having been given.
    const answered = `${DIALOG_BYTES}\r\n${POST_TRUST_BYTES}`;
    host.rawTail = answered;
    host.screenModel = await screenModelFor(answered);
    assert.equal(
      isCodexTrustDialog(host.screenModel.viewportText()),
      true,
      "leg 1 is NOT what clears this case — the dialog's cells are still on the grid",
    );
    assert.equal(host.acceptsPromptInput(), true, "the composer came back");
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
