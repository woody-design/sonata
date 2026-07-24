import assert from "node:assert/strict";
import { createRequire } from "node:module";

// The updater state machine is pure — require it directly (no Electron, no
// electron-updater; type-only imports are erased in the compiled JS).
const require = createRequire(import.meta.url);
const {
  INITIAL_UPDATER_STATE,
  reduceUpdaterEvent,
  projectUpdaterState,
} = require("../../dist/main/updater/updater-state");

const reduce = (state, ...events) => events.reduce(reduceUpdaterEvent, state);

// 1) Initial state is idle, both internally and projected.
{
  assert.equal(INITIAL_UPDATER_STATE.phase, "idle");
  assert.equal(INITIAL_UPDATER_STATE.stagedVersion, null);
  assert.deepEqual(projectUpdaterState(INITIAL_UPDATER_STATE), { status: "idle" });
}

// 2) A full first-download cycle: idle → checking → downloading → staged. Every
//    non-staged phase projects to idle (no Downloading UI); staged carries the
//    version.
{
  const checking = reduce(INITIAL_UPDATER_STATE, { type: "checking-for-update" });
  assert.equal(checking.phase, "checking");
  assert.deepEqual(projectUpdaterState(checking), { status: "idle" });

  const available = reduce(checking, { type: "update-available", version: "1.4.0" });
  assert.equal(available.phase, "downloading");
  assert.deepEqual(projectUpdaterState(available), { status: "idle" });

  const progressing = reduce(available, { type: "download-progress" });
  assert.equal(progressing.phase, "downloading");
  assert.deepEqual(projectUpdaterState(progressing), { status: "idle" });

  const staged = reduce(progressing, { type: "update-downloaded", version: "1.4.0" });
  assert.equal(staged.phase, "staged");
  assert.equal(staged.stagedVersion, "1.4.0");
  assert.deepEqual(projectUpdaterState(staged), { status: "staged", version: "1.4.0" });
}

// 3) Staged-version carry: a re-check while an update is staged keeps the staged
//    projection through checking / not-available / error — the button must never
//    flicker away every 12h.
{
  const staged = reduce(
    INITIAL_UPDATER_STATE,
    { type: "update-downloaded", version: "2.0.0" },
  );

  const reChecking = reduce(staged, { type: "checking-for-update" });
  assert.equal(reChecking.phase, "checking");
  assert.deepEqual(
    projectUpdaterState(reChecking),
    { status: "staged", version: "2.0.0" },
    "checking while staged stays staged for the renderer",
  );

  const stillLatest = reduce(reChecking, { type: "update-not-available" });
  assert.equal(stillLatest.phase, "staged");
  assert.deepEqual(projectUpdaterState(stillLatest), { status: "staged", version: "2.0.0" });

  const reCheckErrored = reduce(stillLatest, { type: "error", message: "network" });
  assert.equal(reCheckErrored.phase, "staged", "an error must not drop a ready update");
  assert.deepEqual(projectUpdaterState(reCheckErrored), { status: "staged", version: "2.0.0" });
}

// 4) A NEWER download replaces the staged version.
{
  const staged = reduce(
    INITIAL_UPDATER_STATE,
    { type: "update-downloaded", version: "2.0.0" },
    { type: "checking-for-update" },
    { type: "update-available", version: "2.1.0" },
    { type: "download-progress" },
    { type: "update-downloaded", version: "2.1.0" },
  );
  assert.deepEqual(projectUpdaterState(staged), { status: "staged", version: "2.1.0" });
}

// 5) Error recovery from a non-staged state: error rests in `error` (projects to
//    idle), and the next scheduled check retries cleanly from there.
{
  const errored = reduce(
    INITIAL_UPDATER_STATE,
    { type: "checking-for-update" },
    { type: "error", message: "sha512 mismatch" },
  );
  assert.equal(errored.phase, "error");
  assert.equal(errored.stagedVersion, null);
  assert.deepEqual(projectUpdaterState(errored), { status: "idle" });

  const retrying = reduce(errored, { type: "checking-for-update" });
  assert.equal(retrying.phase, "checking", "the next check retries from error");
  assert.deepEqual(projectUpdaterState(retrying), { status: "idle" });
}

// 6) update-not-available from idle stays idle.
{
  const idle = reduce(
    INITIAL_UPDATER_STATE,
    { type: "checking-for-update" },
    { type: "update-not-available" },
  );
  assert.equal(idle.phase, "idle");
  assert.deepEqual(projectUpdaterState(idle), { status: "idle" });
}

// 7) Purity: reduce never mutates its input.
{
  const frozen = Object.freeze({ phase: "idle", stagedVersion: null });
  const next = reduceUpdaterEvent(frozen, { type: "update-downloaded", version: "9.9.9" });
  assert.notEqual(next, frozen);
  assert.equal(frozen.stagedVersion, null, "input state is untouched");
}

console.log("updater-state smoke: OK");
