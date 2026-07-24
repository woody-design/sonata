/**
 * The manual "Check for Updates…" decision + dialog truth table (auto-update S3).
 * All three pieces are PURE — require the compiled dist directly (no Electron):
 *   • decideInteractiveCheck — the pre-check short-circuits (disabled / staged /
 *     in-flight) vs "run the network check".
 *   • resolveCheckOutcome    — a completed check's result → outcome.
 *   • buildUpdaterDialog     — every outcome maps to exactly one dialog spec, and
 *     only `staged` offers a restart button.
 */
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const {
  decideInteractiveCheck,
  resolveCheckOutcome,
  buildUpdaterDialog,
} = require("../../dist/main/updater/updater-interactive");

const ctx = (overrides) => ({
  gateStatus: "active",
  phase: "idle",
  stagedVersion: null,
  currentVersion: "1.2.3",
  ...overrides,
});

// ── decideInteractiveCheck: pre-check short-circuits ────────────────────────
// Every disabled gate status short-circuits to disabled(reason), no network.
for (const reason of ["disabled-internal", "disabled-location", "disabled-dev", "disabled-env"]) {
  const plan = decideInteractiveCheck(ctx({ gateStatus: reason }));
  assert.deepEqual(
    plan,
    { action: "resolve", outcome: { kind: "disabled", reason } },
    `gate ${reason} → disabled(${reason}) without a check`,
  );
}

// Staged short-circuits immediately — a manual check never re-downloads what is
// already ready.
assert.deepEqual(
  decideInteractiveCheck(ctx({ stagedVersion: "2.0.0" })),
  { action: "resolve", outcome: { kind: "staged", version: "2.0.0" } },
  "staged → staged(version), no network",
);

// A background check/download already in flight → already-downloading, no
// double-invoke of checkForUpdates.
for (const phase of ["checking", "downloading"]) {
  assert.deepEqual(
    decideInteractiveCheck(ctx({ phase })),
    { action: "resolve", outcome: { kind: "already-downloading" } },
    `phase ${phase} → already-downloading without a second check`,
  );
}

// Nothing in flight, nothing staged, gate active → run the check.
for (const phase of ["idle", "error"]) {
  assert.deepEqual(
    decideInteractiveCheck(ctx({ phase })),
    { action: "check" },
    `phase ${phase} (active, nothing staged) → run the check`,
  );
}

// A stale staged version wins even if a re-check is mid-flight (sticky staged).
assert.deepEqual(
  decideInteractiveCheck(ctx({ phase: "checking", stagedVersion: "2.0.0" })),
  { action: "resolve", outcome: { kind: "staged", version: "2.0.0" } },
  "staged beats an in-flight re-check",
);

// ── resolveCheckOutcome: completed-check results ────────────────────────────
assert.deepEqual(
  resolveCheckOutcome({ kind: "update-available", version: "2.0.0" }, "1.2.3"),
  { kind: "found-downloading", version: "2.0.0" },
  "update-available → found-downloading(version)",
);
assert.deepEqual(
  resolveCheckOutcome({ kind: "up-to-date" }, "1.2.3"),
  { kind: "up-to-date", currentVersion: "1.2.3" },
  "up-to-date → up-to-date(currentVersion)",
);
assert.deepEqual(
  resolveCheckOutcome({ kind: "failed" }, "1.2.3"),
  { kind: "check-failed" },
  "failed → check-failed",
);

// ── buildUpdaterDialog: every outcome maps to one spec ──────────────────────
const outcomes = [
  { kind: "up-to-date", currentVersion: "1.2.3" },
  { kind: "found-downloading", version: "2.0.0" },
  { kind: "already-downloading" },
  { kind: "staged", version: "2.0.0" },
  { kind: "check-failed" },
  { kind: "disabled", reason: "disabled-internal" },
  { kind: "disabled", reason: "disabled-location" },
  { kind: "disabled", reason: "disabled-dev" },
  { kind: "disabled", reason: "disabled-env" },
];
for (const outcome of outcomes) {
  const spec = buildUpdaterDialog(outcome);
  assert.ok(spec.title.length > 0, `${outcome.kind} dialog has a title`);
  assert.ok(spec.body.length > 0, `${outcome.kind} dialog has a body`);
  assert.ok(spec.buttons.length >= 1, `${outcome.kind} dialog has at least one button`);
  assert.ok(
    spec.defaultId >= 0 && spec.defaultId < spec.buttons.length,
    `${outcome.kind} defaultId in range`,
  );
  assert.ok(
    spec.cancelId >= 0 && spec.cancelId < spec.buttons.length,
    `${outcome.kind} cancelId in range`,
  );
  if (outcome.kind === "staged") {
    assert.equal(spec.restartButtonId, 0, "staged offers Restart to Update as button 0");
    assert.equal(spec.buttons[0], "Restart to Update", "staged default button label");
    assert.equal(spec.buttons[1], "Later", "staged cancel button label");
  } else {
    assert.equal(spec.restartButtonId, null, `${outcome.kind} offers no restart button`);
  }
}

// Version interpolation lands in the body copy.
assert.match(
  buildUpdaterDialog({ kind: "up-to-date", currentVersion: "1.2.3" }).body,
  /Sonata 1\.2\.3 is the latest version\./,
  "up-to-date body interpolates the current version",
);
assert.match(
  buildUpdaterDialog({ kind: "found-downloading", version: "2.0.0" }).body,
  /Sonata 2\.0\.0 is downloading in the background\./,
  "found-downloading body interpolates the version",
);
assert.match(
  buildUpdaterDialog({ kind: "staged", version: "2.0.0" }).body,
  /Sonata 2\.0\.0 is ready to install\./,
  "staged body interpolates the version",
);

// The four disabled reasons each produce distinct copy.
const disabledBodies = new Set(
  ["disabled-internal", "disabled-location", "disabled-dev", "disabled-env"].map(
    (reason) => buildUpdaterDialog({ kind: "disabled", reason }).body,
  ),
);
assert.equal(disabledBodies.size, 4, "each disabled reason has distinct body copy");

console.log(`updater-menu-check smoke: OK (${outcomes.length} outcomes, all reachable)`);
