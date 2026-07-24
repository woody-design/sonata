import assert from "node:assert/strict";

// Restart-guard fence (auto-update S2 review fix). The controller can't load
// outside a real Electron main process (it imports electron + electron-updater),
// so the restart handoff DECISIONS — including the macOS ShipIt silent-no-op
// recovery — live in the pure layer and are unit-tested here in plain node,
// mirroring how the phase machine is tested by `smoke:updater-state`.
//
// The bug this guards against: before the fix, a non-throwing quitAndInstall
// no-op left `restarting=true` + `autoInstallOnAppQuit=false` forever — every
// later retry swallowed by the in-flight guard, and the install-on-quit fallback
// dead for the session. Recovery must release the guard AND revive the fallback.
const { reduceRestartGuard, INITIAL_RESTART_GUARD_STATE } = await import(
  "../../dist/main/updater/updater-state.js"
);

// Initial guard: idle, fallback armed.
assert.deepEqual(INITIAL_RESTART_GUARD_STATE, {
  restarting: false,
  autoInstallOnAppQuit: true,
});

// A request with nothing staged is a no-op — no handoff, fallback untouched.
assert.deepEqual(
  reduceRestartGuard(INITIAL_RESTART_GUARD_STATE, { type: "request", hasStaged: false }),
  { state: { restarting: false, autoInstallOnAppQuit: true }, directive: "none" },
);

// A request with a staged update begins the handoff: install-on-quit cleared
// BEFORE quitAndInstall (electron-builder #6418), guard marked in-flight.
const requested = reduceRestartGuard(INITIAL_RESTART_GUARD_STATE, {
  type: "request",
  hasStaged: true,
});
assert.deepEqual(requested, {
  state: { restarting: true, autoInstallOnAppQuit: false },
  directive: "quit-and-install",
});

// A second request while restarting is ignored (double-click / second window).
assert.deepEqual(reduceRestartGuard(requested.state, { type: "request", hasStaged: true }), {
  state: requested.state,
  directive: "none",
});

// quitAndInstall returned without throwing → arm the recovery timer; guard
// stays in-flight until we learn whether the process actually died.
const returned = reduceRestartGuard(requested.state, { type: "quit-returned" });
assert.deepEqual(returned, {
  state: { restarting: true, autoInstallOnAppQuit: false },
  directive: "arm-recovery",
});

// Recovery fires (app still alive ⇒ ShipIt no-op): guard released, fallback
// revived. This is the core of the fix.
const recovered = reduceRestartGuard(returned.state, { type: "recovery-fired" });
assert.deepEqual(recovered, {
  state: { restarting: false, autoInstallOnAppQuit: true },
  directive: "none",
});

// End-to-end no-op sequence: a retry AFTER recovery is real again — it produces
// a fresh quit-and-install, proving the guard is no longer stuck.
const afterNoOp = [
  { type: "request", hasStaged: true },
  { type: "quit-returned" },
  { type: "recovery-fired" },
].reduce((state, event) => reduceRestartGuard(state, event).state, INITIAL_RESTART_GUARD_STATE);
assert.deepEqual(afterNoOp, { restarting: false, autoInstallOnAppQuit: true });
assert.equal(
  reduceRestartGuard(afterNoOp, { type: "request", hasStaged: true }).directive,
  "quit-and-install",
  "a retry after a silent no-op is not swallowed by a stuck guard",
);

// Throwing path (electron-builder #6418 etc.): guard released, fallback revived,
// and NO recovery armed (the throw already recovered — no double-schedule).
const threw = reduceRestartGuard(requested.state, { type: "quit-threw" });
assert.deepEqual(threw, {
  state: { restarting: false, autoInstallOnAppQuit: true },
  directive: "none",
});
assert.notEqual(threw.directive, "arm-recovery", "throwing path must not arm a recovery timer");

console.log(JSON.stringify({ success: true }, null, 2));
