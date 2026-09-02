import assert from "node:assert/strict";
import { createRequire } from "node:module";

/**
 * SL-17 — codex's FOURTH permission mode, `Read Only` (upstream sync 2026-09,
 * findings D6 / E1–E5).
 *
 * ONE behaviour across four layers, pinned as one fence because the value is that
 * the layers AGREE: split across the parser, the reconcile, the launch guards and
 * the label table, a change could satisfy each of them separately and still leave
 * the user reading a mode the session is not in. Woody's ruling was display
 * honesty with the drive unchanged, and "unchanged" is a claim about the OTHER
 * layers that only a joined fence can hold.
 *
 * WHAT THE SLICE ACTUALLY CLAIMS, and where each claim is checked:
 *   1. the mirror LEARNS the mode from a live turn        → §A (measured payloads)
 *   2. the badge SAYS it, in codex's own word             → §B
 *   3. Sonata never LAUNCHES or DRIVES into it            → §C
 *   4. a session in it is still fully switchable          → §D
 *
 * PROVENANCE. Every turn_context payload in §A is MEASURED, from
 * `spikes/upstream-sync-2026-09/codex/q35-read-only-mode.capture.txt` (codex
 * 0.152.1, one live session through the production TerminalHost: a control turn,
 * a turn taken after the #39873 cycle put the CLI in Read Only, and a turn after
 * a production switch drove it back out). The picker frame in §D is ADAPTED — its
 * header, three row labels, missing `(current)` and cursor position are MEASURED
 * from the same capture; the row DESCRIPTIONS are truncated, since nothing reads
 * them and the full text is already pinned verbatim in midsession-receipt.mjs.
 */
const require = createRequire(import.meta.url);
const {
  CODEX_PERMISSION_MODE_OPTIONS,
  codexPermissionModeFromTurnContext,
  isCodexOfferedPermissionMode,
  isCodexPermissionMode,
  migrateCodexPermissionMode,
} = require("../../dist/shared/types/codex-settings");
const {
  CODEX_ROW_BY_ORDER,
  CODEX_ROW_ORDER,
  asCodexPermissionMode,
  parseCodexPermissionPickerCursor,
  parseCodexPermissionReceipt,
} = require("../../dist/runtime/terminal-host/tui-parsers-codex");
const { codexPermissionModeLabel } = require("../../dist/reading-core/selectors/formatters");

const failures = [];
const check = (condition, label) => {
  if (!condition) failures.push(label);
};

// ── §A. The mirror learns Read Only from a live turn ────────────────────────
//
// MEASURED: the three consecutive `turn_context` records q35's session wrote,
// trimmed to the axes the normalizer projects (`emitTurnContext` reads
// `sandbox_policy.type` and `approval_policy` and nothing else). The reviewer and
// profile fields are carried here as evidence, NOT as inputs — the reconcile is
// deliberately blind to both.
const MEASURED_TURNS = [
  {
    turn: 1,
    what: "control — spawned ask-for-approval, cycle not yet pressed",
    sandbox: "workspace-write",
    approval: "on-request",
    reviewer: "user",
    profile: "managed",
    expect: null,
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
    expect: null,
  },
];

for (const row of MEASURED_TURNS) {
  check(
    codexPermissionModeFromTurnContext(row.sandbox, row.approval) === row.expect,
    `turn ${row.turn} (${row.what}) reconciles to ${JSON.stringify(row.expect)}`,
  );
}

// The whole point of turn 2 sitting between turns 1 and 3: `read-only` is unique
// BECAUSE the offered modes are not on that sandbox. If a future spawn table put
// an offered mode on a read-only sandbox, this reconcile would start guessing —
// so assert the premise rather than trusting it. (full-access's own projection is
// checked in codex-permission-migration.mjs; here the claim is about the sandbox
// axis being decisive.)
check(
  MEASURED_TURNS.filter((row) => row.sandbox === "read-only").length === 1 &&
    MEASURED_TURNS.every((row) => (row.sandbox === "read-only") === (row.expect === "read-only")),
  "read-only is the ONLY sandbox in the measured set that reconciles — the axis is decisive",
);

// The controller's actual write is `reconciled ?? current` (reconcileCodexTurnContext),
// so a Read Only turn must MOVE a mirror set by an earlier receipt, and the turns
// around it must LEAVE it alone rather than silently reasserting themselves.
const applyTurn = (current, row) =>
  codexPermissionModeFromTurnContext(row.sandbox, row.approval) ?? current;
let mirror = "ask-for-approval";
mirror = applyTurn(mirror, MEASURED_TURNS[0]);
check(mirror === "ask-for-approval", "the control turn leaves the spawn mirror untouched");
mirror = applyTurn(mirror, MEASURED_TURNS[1]);
check(mirror === "read-only", "the Read Only turn MOVES the mirror — the badge stops lying");
mirror = applyTurn(mirror, MEASURED_TURNS[2]);
// The turn that drove BACK out lands on the ambiguous (workspace-write,
// on-request) pair, so the rollout cannot retire the read-only mirror on its own.
// In production it does not have to — that switch was Sonata-driven, so
// `applyCodexPermissionSwitchReceipt` had already written approve-for-me off the
// picker's own receipt before this turn ever started. The residual is a purely
// NATIVE cycle out of Read Only.
//
// ORCHESTRATOR-ACCEPTED, 2026-09-02 (reviewed independently of the slice that
// introduced it). The stale badge claims LESS access than the session has — this
// codebase's safe direction — it is the same trade already accepted for a native
// downgrade out of full-access, and any menu switch corrects it (the drive works
// from Read Only, MEASURED in q35). The honest fix is the registered permission-
// mirror redesign on `thread_settings_applied`, not a guess on the one axis that
// mislabels access. This pin exists so the residual stays a DECISION with a date
// on it rather than becoming a bug someone "fixes" by widening the reconcile.
check(
  mirror === "read-only",
  "a native cycle OUT lands on the ambiguous pair → the rollout alone cannot retire the mirror",
);

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

// ── §C. Sonata never launches or drives into it ─────────────────────────────
check(
  isCodexPermissionMode("read-only") && !isCodexOfferedPermissionMode("read-only"),
  "read-only is nameable (a mirror) but not offered (a launch/drive target)",
);
check(
  !CODEX_PERMISSION_MODE_OPTIONS.includes("read-only"),
  "read-only is absent from the offered pool the settings + session menus render",
);
// The drive's own narrowing: a switch TARGET can only ever be a picker row.
check(
  asCodexPermissionMode("read-only") === null,
  "asCodexPermissionMode refuses read-only — there is no picker row to walk to",
);
for (const mode of CODEX_PERMISSION_MODE_OPTIONS) {
  check(asCodexPermissionMode(mode) === mode, `asCodexPermissionMode accepts the offered ${mode}`);
}
// The nav tables the walk indexes must stay exactly the picker's three rows: an
// entry for a mode with no row would send the cursor hunting for a row that never
// paints, which is the failure the offered typing exists to prevent.
check(
  CODEX_ROW_BY_ORDER.length === 3 &&
    Object.keys(CODEX_ROW_ORDER).length === 3 &&
    CODEX_ROW_BY_ORDER.every((mode, index) => CODEX_ROW_ORDER[mode] === index) &&
    !CODEX_ROW_BY_ORDER.includes("read-only"),
  "the nav row tables hold exactly the picker's three rows, in painted order",
);

// ── §D. A session in Read Only is still fully switchable ────────────────────
//
// ADAPTED from the MEASURED q35 frame (see the provenance note above). The two
// things that matter are both in it: the three rows carry NO `(current)` marker
// (the CLI cannot mark a row for a mode with no row), and the `›` cursor still
// sits on row 1 — which is all the choreography needs, since it navigates by
// re-reading the cursor's TEXT after every press and never from a current-mode
// anchor. Verified end to end in q35: a production
// `injectClaudeControlSwitch("codex-permission", "approve-for-me", "read-only")`
// settled, and the NEXT turn's rollout independently showed the CLI had moved.
const PICKER_IN_READ_ONLY =
  "Update Model Permissions" +
  "  › 1. Ask for approval  Codex can read and edit files in the current workspace, and run commands." +
  "  2. Approve for me    Only ask for actions detected as potentially unsafe." +
  "  3. Full Access       Codex can edit files outside this workspace and access the internet." +
  "  Press enter to confirm or esc to go back";
check(
  !PICKER_IN_READ_ONLY.includes("(current)"),
  "the fixture is the no-(current) picker a Read Only session paints",
);
check(
  parseCodexPermissionPickerCursor(PICKER_IN_READ_ONLY) === "ask-for-approval",
  "the cursor still resolves with no (current) marker — navigation has its anchor",
);
// The receipt vocabulary the confirm reads. Its role here is bounded: a native
// cycle mid-confirm resolves as "not our target" instead of being invisible.
check(
  parseCodexPermissionReceipt("• Permissions updated to Read Only") === "read-only",
  "the Read Only receipt is recognised inside a confirm window",
);
check(
  parseCodexPermissionReceipt("• Permissions updated to Read Only") !== "approve-for-me",
  "…and is NOT mistaken for the target of a switch that was driving elsewhere",
);
// Most-recent-wins, which adding a fourth label forced: a repaint replaying an old
// receipt must not outrank the one that just painted.
check(
  parseCodexPermissionReceipt(
    "• Permissions updated to Read Only  • Permissions updated to Full Access",
  ) === "full-access",
  "a stale Read Only receipt cannot outrank the confirm that painted after it",
);

if (failures.length > 0) {
  console.error(`codex-read-only-mode: ${failures.length} FAILED`);
  for (const failure of failures) console.error(`  ✗ ${failure}`);
  process.exit(1);
}
console.log("codex-read-only-mode: all checks passed");
assert.ok(true);
