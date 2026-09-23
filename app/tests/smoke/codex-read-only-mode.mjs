import assert from "node:assert/strict";
import { createRequire } from "node:module";

/**
 * SL-17 — codex's FOURTH permission mode, `Read Only` (upstream sync 2026-09,
 * findings D6 / E1–E5).
 *
 * ONE behaviour across three layers, pinned as one fence because the value is
 * that the layers AGREE: split across the reconcile, the launch guards and the
 * label table, a change could satisfy each of them separately and still leave
 * the user reading a mode the session is not in. Woody's ruling was display
 * honesty.
 *
 * WHAT THE SLICE ACTUALLY CLAIMS, and where each claim is checked:
 *   1. the mirror LEARNS the mode from a live turn        → §A (measured payloads)
 *   2. the badge SAYS it, in codex's own word             → §B
 *   3. Sonata never LAUNCHES into it                      → §C
 * (A fourth claim — "a session in it is still switchable from Sonata's menu" —
 * retired with the mid-session drives, Subtraction program 2026-09-23.)
 *
 * PROVENANCE. Every turn_context payload in §A is MEASURED, from
 * `spikes/upstream-sync-2026-09/codex/q35-read-only-mode.capture.txt` (codex
 * 0.152.1, one live session through the production TerminalHost: a control turn,
 * a turn taken after the #39873 cycle put the CLI in Read Only, and a turn after
 * a switch moved it back out).
 */
const require = createRequire(import.meta.url);
const {
  CODEX_PERMISSION_MODE_OPTIONS,
  codexPermissionModeFromTurnContext,
  isCodexOfferedPermissionMode,
  isCodexPermissionMode,
  migrateCodexPermissionMode,
} = require("../../dist/shared/types/codex-settings");
const { codexPermissionModeLabel } = require("../../dist/reading-core/selectors/formatters");

const failures = [];
const check = (condition, label) => {
  if (!condition) failures.push(label);
};

// ── §A. The mirror learns Read Only from a live turn ────────────────────────
//
// MEASURED: the three consecutive `turn_context` records q35's session wrote,
// trimmed to the axes the normalizer projects (`sandbox_policy.type`,
// `approval_policy`, `approvals_reviewer`). The profile field is carried as
// evidence only — the reconcile does not read it.
const MEASURED_TURNS = [
  {
    turn: 1,
    what: "control — spawned ask-for-approval, cycle not yet pressed",
    sandbox: "workspace-write",
    approval: "on-request",
    reviewer: "user",
    profile: "managed",
    expect: "ask-for-approval",
  },
  {
    turn: 2,
    what: "the CLI is in Read Only (two #39873 cycle presses)",
    sandbox: "read-only",
    approval: "on-request",
    reviewer: "user",
    profile: "managed",
    expect: "read-only",
  },
  {
    turn: 3,
    what: "after a production switch drove it to approve-for-me",
    sandbox: "workspace-write",
    approval: "on-request",
    reviewer: "auto_review",
    profile: "managed",
    expect: "approve-for-me",
  },
];

for (const row of MEASURED_TURNS) {
  check(
    codexPermissionModeFromTurnContext(row.sandbox, row.approval, row.reviewer) === row.expect,
    `turn ${row.turn} (${row.what}) reconciles to ${JSON.stringify(row.expect)}`,
  );
}

// `read-only` is unique BECAUSE the offered modes are not on that sandbox. If a
// future spawn table put an offered mode on a read-only sandbox, this reconcile
// would start guessing — so assert the premise rather than trusting it.
check(
  MEASURED_TURNS.filter((row) => row.sandbox === "read-only").length === 1 &&
    MEASURED_TURNS.every((row) => (row.sandbox === "read-only") === (row.expect === "read-only")),
  "only the read-only sandbox reads as Read Only — the sandbox axis is decisive for it",
);

// The controller's actual write is `reconciled ?? current` (reconcileCodexTurnContext),
// and the latest turn_context wins: the mirror moves INTO Read Only and back OUT.
const applyTurn = (current, row) =>
  codexPermissionModeFromTurnContext(row.sandbox, row.approval, row.reviewer) ?? current;
let mirror = "ask-for-approval";
mirror = applyTurn(mirror, MEASURED_TURNS[0]);
check(mirror === "ask-for-approval", "the control turn confirms the spawn mode");
mirror = applyTurn(mirror, MEASURED_TURNS[1]);
check(mirror === "read-only", "the Read Only turn MOVES the mirror — the badge stops lying");
mirror = applyTurn(mirror, MEASURED_TURNS[2]);
// The turn after the switch back out carries reviewer `auto_review`, so the
// rollout alone retires the Read Only mirror. The 2026-09-02 acceptance of this
// case as a residual is SUPERSEDED — see codexPermissionModeFromTurnContext.
check(mirror === "approve-for-me", "the switch OUT of Read Only reconciles from the file alone");

// ── §B. The badge says it, in codex's own word ──────────────────────────────
check(codexPermissionModeLabel("read-only") === "Read Only", "read-only labels as Read Only");
check(
  codexPermissionModeLabel("ask-for-approval") === "Ask for approval" &&
    codexPermissionModeLabel("approve-for-me") === "Approve for me" &&
    codexPermissionModeLabel("full-access") === "Full Access",
  "the three offered labels are unchanged",
);
// The chain a chip actually rides on a restart: the mirror is persisted, read back
// through the manifest migration, and labelled. The old label function's
// if-chain fell through to "Ask for approval" for anything it did not recognise,
// which is the wrong direction to be wrong in — it claims MORE access than the
// session had. Assert the round trip, not just the table.
const persisted = migrateCodexPermissionMode({
  provider: "codex",
  codexPermissionMode: "read-only",
});
check(
  persisted === "read-only" && codexPermissionModeLabel(persisted) === "Read Only",
  "a persisted Read Only session still reads Read Only after a manifest round-trip",
);

// ── §C. Sonata never launches into it ───────────────────────────────────────
check(
  isCodexPermissionMode("read-only") && !isCodexOfferedPermissionMode("read-only"),
  "read-only is nameable (a mirror) but not offered (a launch target)",
);
check(
  !CODEX_PERMISSION_MODE_OPTIONS.includes("read-only"),
  "read-only is absent from the offered pool the settings + New Chat menus render",
);

if (failures.length > 0) {
  console.error(`codex-read-only-mode: ${failures.length} FAILED`);
  for (const failure of failures) console.error(`  ✗ ${failure}`);
  process.exit(1);
}
console.log("codex-read-only-mode: all checks passed");
assert.ok(true);
