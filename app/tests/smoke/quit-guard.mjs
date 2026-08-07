/**
 * The quit / last-window confirmation guard (Focus/Flow S4, D5) — every DECISION
 * and every WORD, exhaustively, against the compiled dist. All pure: no Electron,
 * no windows, no dialog.
 *
 * This is where the paths the e2e harness cannot drive are covered. The e2e
 * fence (tests/e2e/quit-confirm.mjs) exercises ⌘Q, the last-window close, the
 * zero-window quit and the native fallback against the real app; what it CANNOT
 * stage is the full cross-product of guard facts, and it is exactly the
 * combinations nobody thinks to stage that let a guard quietly stop asking.
 * So the truth tables are enumerated here.
 *
 * Fixture provenance: COMPOSED — the fact records are the guards' own input
 * types, enumerated over their full boolean cross-product; nothing is sampled
 * from a recording.
 */
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const {
  buildQuitDialog,
  quitConfirmRequestFrom,
  decideQuitRequest,
  decideWindowClose,
} = require("../../dist/main/quit-guard");
const { isQuitConfirmAnswer, isQuitConfirmRequest } = require("../../dist/shared/types/ipc");

// ── The copy (D5, Woody-approved) ───────────────────────────────────────────
// The wording itself is pinned in smoke:ui-vocabulary-corpus (the repo's home
// for copy literals). What is asserted HERE is the SHAPE that makes the two
// surfaces answer the same question: which button is the default, which is the
// cancel, and which one means "quit".
const spec = buildQuitDialog();
assert.deepEqual(
  spec,
  {
    title: "Quit Sonata?",
    body: "All sessions will be terminated",
    buttons: ["Close Sonata", "Cancel"],
    defaultId: 0,
    cancelId: 1,
    confirmButtonId: 0,
  },
  "the quit dialog spec is the approved copy in native button order",
);
assert.equal(
  spec.defaultId,
  spec.confirmButtonId,
  "Return activates Close Sonata — the default button IS the confirm (macOS alert semantics)",
);
assert.notEqual(spec.cancelId, spec.confirmButtonId, "Esc cannot land on the confirm");
assert.deepEqual(
  buildQuitDialog(),
  spec,
  "the dialog takes no arguments: the same question regardless of session liveness (D5)",
);

// ── One source for the copy, across two surfaces ─────────────────────────────
// The renderer holds NO quit wording of its own; it paints this projection. So
// the branded dialog and the native message box are provably the same words —
// asserted by reading the labels back out of the spec's own button list.
const request = quitConfirmRequestFrom(spec, 7);
assert.deepEqual(
  request,
  {
    requestId: 7,
    title: "Quit Sonata?",
    body: "All sessions will be terminated",
    confirmLabel: "Close Sonata",
    cancelLabel: "Cancel",
  },
  "the renderer push carries the spec's own words",
);
assert.equal(request.confirmLabel, spec.buttons[spec.confirmButtonId], "confirm label is the spec's");
assert.equal(request.cancelLabel, spec.buttons[spec.cancelId], "cancel label is the spec's");
assert.ok(isQuitConfirmRequest(request), "the push satisfies its own inbound type guard");

// ── decideQuitRequest: the ⌘Q truth table, exhaustive ────────────────────────
// Three booleans-ish facts, every combination, with the expected action stated
// as data rather than derived — a table that re-derives the code proves nothing.
const quitCases = [
  // asking wins over everything: a second ⌘Q must not stack a second dialog.
  { asking: true, openWindowCount: 0, mainWindowCanAsk: false, expected: { action: "ignore" } },
  { asking: true, openWindowCount: 0, mainWindowCanAsk: true, expected: { action: "ignore" } },
  { asking: true, openWindowCount: 1, mainWindowCanAsk: false, expected: { action: "ignore" } },
  { asking: true, openWindowCount: 1, mainWindowCanAsk: true, expected: { action: "ignore" } },
  { asking: true, openWindowCount: 3, mainWindowCanAsk: true, expected: { action: "ignore" } },
  // D5's one exception: zero windows means the runtimes are already disposed,
  // so there is nothing to protect and nothing to ask.
  { asking: false, openWindowCount: 0, mainWindowCanAsk: false, expected: { action: "quit" } },
  { asking: false, openWindowCount: 0, mainWindowCanAsk: true, expected: { action: "quit" } },
  // Windows open: always ask (regardless of session liveness — the guard is
  // never told about liveness, which is what makes "always confirm" structural).
  { asking: false, openWindowCount: 1, mainWindowCanAsk: true, expected: { action: "ask", host: "renderer" } },
  { asking: false, openWindowCount: 3, mainWindowCanAsk: true, expected: { action: "ask", host: "renderer" } },
  // …and with no main window to draw it, the native fallback.
  { asking: false, openWindowCount: 1, mainWindowCanAsk: false, expected: { action: "ask", host: "native" } },
  { asking: false, openWindowCount: 2, mainWindowCanAsk: false, expected: { action: "ask", host: "native" } },
];
for (const { expected, ...facts } of quitCases) {
  assert.deepEqual(decideQuitRequest(facts), expected, `decideQuitRequest(${JSON.stringify(facts)})`);
}
assert.equal(
  quitCases.length,
  11,
  "the ⌘Q table covers every reachable fact combination (asking short-circuits the rest)",
);
// The guard has NO liveness input at all — stated as a fact about its signature,
// so a future "only ask when something is running" cannot slip in unnoticed.
assert.equal(decideQuitRequest.length, 1, "decideQuitRequest takes one fact record");

// ── decideWindowClose: the last-window truth table, exhaustive ───────────────
// Five booleans = 32 combinations. Enumerated in full, with the expectation
// computed from the RULING rather than from the implementation:
//   quitting → close · confirmed → close · not last → close ·
//   asking → ignore · else ask (renderer in the main window, native elsewhere)
let closeCases = 0;
for (const quitting of [false, true]) {
  for (const closeConfirmed of [false, true]) {
    for (const isLastWindow of [false, true]) {
      for (const isMainWindow of [false, true]) {
        for (const asking of [false, true]) {
          const facts = { quitting, closeConfirmed, isLastWindow, isMainWindow, asking };
          const expected =
            quitting || closeConfirmed || !isLastWindow
              ? { action: "close" }
              : asking
                ? { action: "ignore" }
                : { action: "ask", host: isMainWindow ? "renderer" : "native" };
          assert.deepEqual(decideWindowClose(facts), expected, JSON.stringify(facts));
          closeCases += 1;
        }
      }
    }
  }
}
assert.equal(closeCases, 32, "the window-close table is the full 2^5 cross-product");

// The four behaviors worth naming, so a reader sees the rulings without
// reconstructing them from the loop above.
assert.deepEqual(
  decideWindowClose({ quitting: true, closeConfirmed: false, isLastWindow: true, isMainWindow: true, asking: false }),
  { action: "close" },
  "windows closing during a confirmed quit are the quit's own teardown — never re-asked",
);
assert.deepEqual(
  decideWindowClose({ quitting: false, closeConfirmed: false, isLastWindow: false, isMainWindow: true, asking: true }),
  { action: "close" },
  "a satellite close is never at stake, even with a confirmation already on screen",
);
assert.deepEqual(
  decideWindowClose({ quitting: false, closeConfirmed: false, isLastWindow: true, isMainWindow: false, asking: false }),
  { action: "ask", host: "native" },
  "the last window with no Sonata dialog surface (CLI / Preview) gets the native fallback",
);
assert.deepEqual(
  decideWindowClose({ quitting: false, closeConfirmed: true, isLastWindow: true, isMainWindow: true, asking: false }),
  { action: "close" },
  "the confirmed re-entry proceeds — this is how a yes becomes a close",
);

// ── The answer's inbound guard ───────────────────────────────────────────────
// It crosses the IPC boundary from a renderer, so it is validated like every
// other inbound payload.
assert.ok(isQuitConfirmAnswer({ requestId: 1, confirmed: true }));
assert.ok(isQuitConfirmAnswer({ requestId: 0, confirmed: false }));
for (const bad of [
  null,
  undefined,
  "quit",
  [],
  {},
  { requestId: 1 },
  { confirmed: true },
  { requestId: "1", confirmed: true },
  { requestId: 1.5, confirmed: true },
  { requestId: 1, confirmed: "yes" },
  { requestId: 1, confirmed: true, extra: 1 },
]) {
  assert.equal(isQuitConfirmAnswer(bad), false, `rejects ${JSON.stringify(bad)}`);
}
for (const bad of [
  { ...request, title: "" },
  { ...request, confirmLabel: "" },
  { ...request, cancelLabel: "" },
  { ...request, requestId: "7" },
  { ...request, extra: 1 },
]) {
  assert.equal(isQuitConfirmRequest(bad), false, `rejects ${JSON.stringify(bad)}`);
}

console.log(
  `quit-guard smoke: OK (${quitCases.length} quit-request cases, ${closeCases} window-close cases, ` +
    "copy shape + one-source projection + inbound guards)",
);
