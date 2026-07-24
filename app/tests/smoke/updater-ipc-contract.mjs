import assert from "node:assert/strict";

// Contract fence for the auto-update IPC surface (S1): channel names and the
// renderer-facing payload shape are test API — the sidebar button (S2) and any
// future consumer bind to exactly these. A rename here is a breaking change and
// must fail this test loudly.
const { IPC_CHANNELS } = await import("../../dist/shared/types/ipc.js");
const { isUpdaterState, updaterStateEquals, IDLE_UPDATER_STATE } = await import(
  "../../dist/shared/types/updater.js"
);

// 1) Channel names are frozen.
assert.equal(IPC_CHANNELS.updaterState, "updater:state");
assert.equal(IPC_CHANNELS.updaterStateRead, "updater:state:read");
assert.equal(IPC_CHANNELS.updaterRestart, "updater:restart");

// 2) The idle constant is the canonical nothing-actionable payload.
assert.deepEqual(IDLE_UPDATER_STATE, { status: "idle" });
assert.equal(isUpdaterState(IDLE_UPDATER_STATE), true);

// 3) Payload validation — only the two contract shapes pass.
assert.equal(isUpdaterState({ status: "idle" }), true);
assert.equal(isUpdaterState({ status: "staged", version: "1.2.3" }), true);
assert.equal(isUpdaterState({ status: "staged" }), false, "staged requires a version");
assert.equal(isUpdaterState({ status: "staged", version: "" }), false, "version must be non-empty");
assert.equal(isUpdaterState({ status: "idle", extra: 1 }), false, "no extra keys on idle");
assert.equal(
  isUpdaterState({ status: "staged", version: "1.0.0", extra: 1 }),
  false,
  "no extra keys on staged",
);
assert.equal(isUpdaterState({ status: "downloading" }), false, "internal phases never cross IPC");
assert.equal(isUpdaterState(null), false);
assert.equal(isUpdaterState("staged"), false);

// 4) Equality — used to suppress redundant broadcasts.
assert.equal(updaterStateEquals({ status: "idle" }, { status: "idle" }), true);
assert.equal(
  updaterStateEquals({ status: "staged", version: "1.0.0" }, { status: "staged", version: "1.0.0" }),
  true,
);
assert.equal(
  updaterStateEquals({ status: "staged", version: "1.0.0" }, { status: "staged", version: "1.1.0" }),
  false,
);
assert.equal(updaterStateEquals({ status: "idle" }, { status: "staged", version: "1.0.0" }), false);

console.log(JSON.stringify({ success: true }, null, 2));
