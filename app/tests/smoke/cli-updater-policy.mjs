// Codex CLI auto-update S1 — the pure policy heart.
//
// The design's load-bearing claim is that ownership of codex's boot update
// prompt is DERIVED from two persisted facts, never stored. This file is the
// proof: a table over fact literals that walks every ownership path — healthy,
// pending, handback, both reclaim routes, and each of the three states that must
// NOT hand back (UNKNOWN, staleness, a failure scoped to an older version).
//
// Zero I/O in the module under test, so zero I/O here: pid liveness and the
// clock arrive as arguments.

import assert from "node:assert/strict";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const distRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../../dist");
const {
  parseVersion,
  compareVersions,
  semverLt,
  parseCodexVersionOutput,
  classifyAttempt,
  updatePending,
  alreadyAttemptedLatest,
  sonataOwnsPrompt,
  shouldExecute,
  ATTEMPT_LIVENESS_WINDOW_MS,
} = require(path.join(distRoot, "main/cli-updater/policy"));

const results = {};

// ── Version parsing ─────────────────────────────────────────────────────────

// MEASURED — `codex --version` on this machine, 2026-08-05 (brew cask install,
// codex 0.146.0). Captured verbatim including the trailing newline.
const MEASURED_CODEX_VERSION_OUTPUT = "codex-cli 0.146.0\n";

{
  assert.equal(
    parseCodexVersionOutput(MEASURED_CODEX_VERSION_OUTPUT),
    "0.146.0",
    "MEASURED `codex --version` output parses",
  );
  // ADAPTED — the measured output with the product name changed / removed, to
  // prove the parse keys on the version token, not the `codex-cli ` prefix.
  assert.equal(parseCodexVersionOutput("0.146.0\n"), "0.146.0", "bare version parses");
  assert.equal(parseCodexVersionOutput("codex 1.2.3"), "1.2.3", "renamed product still parses");
  // COMPOSED — shapes that must NOT produce a version.
  assert.equal(parseCodexVersionOutput(""), null, "empty output → null");
  assert.equal(parseCodexVersionOutput("codex-cli 0.147"), null, "two-part version → null");
  assert.equal(parseCodexVersionOutput(null), null, "null input → null");
  results.versionOutputParse = parseCodexVersionOutput(MEASURED_CODEX_VERSION_OUTPUT);
}

{
  assert.deepEqual(parseVersion("0.146.0"), { major: 0, minor: 146, patch: 0 }, "x.y.z parses");
  assert.deepEqual(parseVersion("v1.2.3"), { major: 1, minor: 2, patch: 3 }, "v-prefix tolerated");
  // MEASURED — real tags from the dist-tags document (2026-08-05). Neither is a
  // version anything should ever be updated TO, and the strict parse is what
  // guarantees they cannot become one.
  assert.equal(parseVersion("0.147.0-alpha.10"), null, "MEASURED prerelease tag rejected");
  assert.equal(parseVersion("0.146.0-darwin-arm64"), null, "MEASURED platform tag rejected");
  assert.equal(parseVersion("0.1.2505172116"), null, "MEASURED beta tag: 10-digit patch rejected");
  assert.equal(parseVersion(""), null, "empty rejected");
  assert.equal(parseVersion("1.2"), null, "two-part rejected");

  assert.equal(compareVersions(parseVersion("0.146.0"), parseVersion("0.147.0")), -1, "minor <");
  assert.equal(compareVersions(parseVersion("1.0.0"), parseVersion("0.999.999")), 1, "major >");
  assert.equal(compareVersions(parseVersion("2.3.4"), parseVersion("2.3.4")), 0, "equal");

  assert.equal(semverLt("0.146.0", "0.147.0"), true, "older < newer");
  assert.equal(semverLt("0.147.0", "0.146.0"), false, "newer !< older");
  assert.equal(semverLt("0.146.0", "0.146.0"), false, "equal !< equal");
  // Unparseable on either side collapses to "nothing to do" — never to "update".
  assert.equal(semverLt("0.146.0", "0.147.0-alpha.10"), false, "prerelease target → no");
  assert.equal(semverLt(null, "0.147.0"), false, "no installed version → no");
  assert.equal(semverLt("0.146.0", null), false, "no latest version → no");
  results.semver = "ok";
}

// ── Attempt classification ──────────────────────────────────────────────────

const NOW = Date.parse("2026-08-05T12:00:00.000Z");
const iso = (offsetMs) => new Date(NOW + offsetMs).toISOString();

// COMPOSED — an attempt record. The shape is the plan's, the values are
// invented; nothing here needs to be real for the classifier to be exercised.
const attempt = (overrides = {}) => ({
  forVersion: "0.147.0",
  startedAt: iso(-5_000),
  pid: 4242,
  exitCode: null,
  logFile: "/tmp/codex-update.log",
  ...overrides,
});

{
  const cases = [
    ["no record at all", null, { pidAlive: false, nowMs: NOW }, "none"],
    ["unreaped + pid alive, fresh", attempt(), { pidAlive: true, nowMs: NOW }, "running"],
    ["unreaped + pid gone", attempt(), { pidAlive: false, nowMs: NOW }, "unknown"],
    ["exit 0", attempt({ exitCode: 0 }), { pidAlive: false, nowMs: NOW }, "completed"],
    ["exit 1", attempt({ exitCode: 1 }), { pidAlive: false, nowMs: NOW }, "hard-failed"],
    ["exit 127", attempt({ exitCode: 127 }), { pidAlive: false, nowMs: NOW }, "hard-failed"],
    // pid-reuse sanity window: a live pid on a record older than the window is
    // somebody else's process, and must not hold the mutex forever.
    [
      "unreaped + pid alive but past the window",
      attempt({ startedAt: iso(-ATTEMPT_LIVENESS_WINDOW_MS - 1_000) }),
      { pidAlive: true, nowMs: NOW },
      "unknown",
    ],
    [
      "unreaped + pid alive at the window edge",
      attempt({ startedAt: iso(-ATTEMPT_LIVENESS_WINDOW_MS + 1_000) }),
      { pidAlive: true, nowMs: NOW },
      "running",
    ],
    // An untrustworthy time base is not a licence to hold the mutex.
    [
      "startedAt in the future (clock skew)",
      attempt({ startedAt: iso(60_000) }),
      { pidAlive: true, nowMs: NOW },
      "unknown",
    ],
    [
      "unparseable startedAt",
      attempt({ startedAt: "not-a-date" }),
      { pidAlive: true, nowMs: NOW },
      "unknown",
    ],
    // An exit code always wins over the probe — a reaped child is never RUNNING
    // even if its pid has been recycled.
    ["exit 0 with a recycled live pid", attempt({ exitCode: 0 }), { pidAlive: true, nowMs: NOW }, "completed"],
  ];
  for (const [label, record, probe, expected] of cases) {
    assert.equal(classifyAttempt(record, probe), expected, `classify: ${label}`);
  }
  results.classify = cases.length;
}

// ── The ownership table ─────────────────────────────────────────────────────

// COMPOSED fact literals. Versions echo the real 0.146.0 → 0.147.0 line so the
// table reads like the situation it models, but every row is invented.
const check = (installed, latest, ok = true) => ({ at: iso(-60_000), ok, installed, latest });

const ALIVE = { pidAlive: true, nowMs: NOW };
const DEAD = { pidAlive: false, nowMs: NOW };

/**
 * Each row: the whole world, and the three answers it must produce.
 *   owns          — does Sonata suppress codex's native boot prompt?
 *   tick          — does a FREQUENCY-BOUNDED cycle (60s / 12h / manual) launch
 *                   `codex update`?
 *   ptyExit       — does a CHURN-DRIVEN cycle (the last codex session closing)
 *                   launch it?
 *
 * Splitting the last two is the O1 gate: a tick fires at most ~2/day whatever
 * the user does, so it may retry freely; a pty-exit fires as often as the user
 * opens and closes sessions, so it may only launch when nothing has been tried
 * for the current latest yet. Every row is checked against both, so the gate's
 * blast radius is visible rather than asserted in one corner.
 */
const TABLE = [
  {
    name: "healthy: nothing newer",
    setting: true,
    facts: { lastCheck: check("0.147.0", "0.147.0"), lastAttempt: null },
    probe: DEAD,
    ptys: 0,
    owns: true,
    tick: false,
    ptyExit: false,
  },
  {
    name: "pending, idle: own the prompt and update",
    setting: true,
    facts: { lastCheck: check("0.146.0", "0.147.0"), lastAttempt: null },
    probe: DEAD,
    ptys: 0,
    owns: true,
    tick: true,
    ptyExit: true,
  },
  {
    name: "pending but a codex session is live: never swap the binary (G1)",
    setting: true,
    facts: { lastCheck: check("0.146.0", "0.147.0"), lastAttempt: null },
    probe: DEAD,
    ptys: 1,
    owns: true,
    tick: false,
    ptyExit: false,
  },
  {
    name: "an update is already running: the mutex holds",
    setting: true,
    facts: { lastCheck: check("0.146.0", "0.147.0"), lastAttempt: attempt() },
    probe: ALIVE,
    ptys: 0,
    owns: true,
    tick: false,
    ptyExit: false,
  },
  {
    name: "HANDBACK: hard failure against the pending latest",
    setting: true,
    facts: {
      lastCheck: check("0.146.0", "0.147.0"),
      lastAttempt: attempt({ forVersion: "0.147.0", exitCode: 1 }),
    },
    probe: DEAD,
    ptys: 0,
    owns: false,
    // Retrying while handed back is exactly how ownership is re-earned.
    tick: true,
    // O1: an attempt already exists for this latest, so session churn
    //     must not launch another one — only the scheduled ticks retry.

    ptyExit: false,
  },
  {
    name: "RECLAIM by new version: the failure is scoped to an older latest",
    setting: true,
    facts: {
      lastCheck: check("0.146.0", "0.148.0"),
      lastAttempt: attempt({ forVersion: "0.147.0", exitCode: 1 }),
    },
    probe: DEAD,
    ptys: 0,
    owns: true,
    tick: true,
    ptyExit: true,
  },
  {
    name: "RECLAIM by manual update: the user updated, so nothing is pending",
    setting: true,
    facts: {
      lastCheck: check("0.147.0", "0.147.0"),
      lastAttempt: attempt({ forVersion: "0.147.0", exitCode: 1 }),
    },
    probe: DEAD,
    ptys: 0,
    owns: true,
    tick: false,
    ptyExit: false,
  },
  {
    name: "RECLAIM by a healed retry: the version advanced past the failure",
    setting: true,
    facts: {
      lastCheck: check("0.148.0", "0.148.0"),
      lastAttempt: attempt({ forVersion: "0.148.0", exitCode: 0 }),
    },
    probe: DEAD,
    ptys: 0,
    owns: true,
    tick: false,
    ptyExit: false,
  },
  {
    name: "UNKNOWN never hands back: a died-mid-update app proves nothing",
    setting: true,
    facts: {
      lastCheck: check("0.146.0", "0.147.0"),
      lastAttempt: attempt({ forVersion: "0.147.0", exitCode: null }),
    },
    probe: DEAD,
    ptys: 0,
    owns: true,
    tick: true,
    // O1: an attempt already exists for this latest, so session churn
    //     must not launch another one — only the scheduled ticks retry.

    ptyExit: false,
  },
  {
    name: "staleness never hands back: pending for a week, no failure (D6)",
    setting: true,
    facts: {
      lastCheck: {
        at: iso(-7 * 24 * 60 * 60 * 1000),
        ok: true,
        installed: "0.146.0",
        latest: "0.147.0",
      },
      lastAttempt: null,
    },
    probe: DEAD,
    ptys: 0,
    owns: true,
    tick: true,
    ptyExit: true,
  },
  {
    name: "exit 0 but still stale (brew-cask lag, G3): retry, do not hand back",
    setting: true,
    facts: {
      lastCheck: check("0.146.0", "0.147.0"),
      lastAttempt: attempt({ forVersion: "0.147.0", exitCode: 0 }),
    },
    probe: DEAD,
    ptys: 0,
    owns: true,
    tick: true,
    // O1: an attempt already exists for this latest, so session churn
    //     must not launch another one — only the scheduled ticks retry.

    ptyExit: false,
  },
  {
    name: "setting off: Sonata is not in this conversation at all",
    setting: false,
    facts: { lastCheck: check("0.146.0", "0.147.0"), lastAttempt: null },
    probe: DEAD,
    ptys: 0,
    owns: false,
    tick: false,
    ptyExit: false,
  },
  {
    name: "setting off with a pending update and a live pty",
    setting: false,
    facts: { lastCheck: check("0.146.0", "0.147.0"), lastAttempt: attempt() },
    probe: ALIVE,
    ptys: 2,
    owns: false,
    tick: false,
    ptyExit: false,
  },
  {
    name: "check failed (registry unreachable): no facts, no action",
    setting: true,
    facts: { lastCheck: check(null, null, false), lastAttempt: null },
    probe: DEAD,
    ptys: 0,
    owns: true,
    tick: false,
    ptyExit: false,
  },
  {
    name: "codex not installed: clean no-op",
    setting: true,
    facts: { lastCheck: check(null, "0.147.0", false), lastAttempt: null },
    probe: DEAD,
    ptys: 0,
    owns: true,
    tick: false,
    ptyExit: false,
  },
  {
    name: "never checked",
    setting: true,
    facts: { lastCheck: null, lastAttempt: null },
    probe: DEAD,
    ptys: 0,
    owns: true,
    tick: false,
    ptyExit: false,
  },
  {
    name: "a hard failure with no check yet cannot hand back",
    setting: true,
    facts: { lastCheck: null, lastAttempt: attempt({ exitCode: 1 }) },
    probe: DEAD,
    ptys: 0,
    owns: true,
    tick: false,
    ptyExit: false,
  },
];

{
  const table = {};
  // The three frequency-bounded triggers must be indistinguishable from each
  // other: only pty-exit is a different KIND of trigger.
  const TICK_REASONS = ["first-check", "interval", "manual"];
  for (const row of TABLE) {
    const attemptState = classifyAttempt(row.facts.lastAttempt, row.probe);
    const input = { setting: row.setting, facts: row.facts, attemptState };
    const owns = sonataOwnsPrompt(input);
    assert.equal(owns, row.owns, `owns — ${row.name}`);

    for (const reason of TICK_REASONS) {
      assert.equal(
        shouldExecute({ ...input, livePtyCount: row.ptys, reason }),
        row.tick,
        `execute(${reason}) — ${row.name}`,
      );
    }
    const ptyExit = shouldExecute({ ...input, livePtyCount: row.ptys, reason: "pty-exit" });
    assert.equal(ptyExit, row.ptyExit, `execute(pty-exit) — ${row.name}`);

    table[row.name] = { attemptState, owns, tick: row.tick, ptyExit };
  }
  results.ownershipRows = TABLE.length;
  results.o1GatedRows = TABLE.filter((row) => row.tick !== row.ptyExit).map((row) => row.name);
  results.table = table;
}

// The O1 gate, stated directly rather than only through the table.
{
  const latest = check("0.146.0", "0.147.0");
  const base = { setting: true, attemptState: "completed", livePtyCount: 0 };

  // No attempt at all → every trigger may launch.
  const untried = { lastCheck: latest, lastAttempt: null };
  assert.equal(alreadyAttemptedLatest(untried), false, "no attempt → not yet tried");
  assert.equal(shouldExecute({ ...base, facts: untried, reason: "pty-exit" }), true, "churn may open the first attempt");

  // An attempt for THIS latest, exited 0 but the version never moved (brew-cask
  // lag — the routine case). This is exactly what O1 exists for: the user can
  // close ten sessions in an afternoon and must not launch ten brew runs.
  const tried = {
    lastCheck: latest,
    lastAttempt: attempt({ forVersion: "0.147.0", exitCode: 0 }),
  };
  assert.equal(alreadyAttemptedLatest(tried), true, "attempt matches the current latest");
  assert.equal(shouldExecute({ ...base, facts: tried, reason: "pty-exit" }), false, "churn does not retry");
  assert.equal(shouldExecute({ ...base, facts: tried, reason: "interval" }), true, "the 12h tick does");
  assert.equal(shouldExecute({ ...base, facts: tried, reason: "first-check" }), true, "and so does launch");

  // A newer release lands: the attempt no longer matches, so churn gets a fresh
  // chance — the same emergent reclaim the ownership predicate uses.
  const superseded = {
    lastCheck: check("0.146.0", "0.148.0"),
    lastAttempt: attempt({ forVersion: "0.147.0", exitCode: 0 }),
  };
  assert.equal(alreadyAttemptedLatest(superseded), false, "an older forVersion is not this latest");
  assert.equal(
    shouldExecute({ ...base, facts: superseded, reason: "pty-exit" }),
    true,
    "a new version reopens the churn trigger",
  );

  // The gate never OVERRIDES the other conditions — it only ever subtracts.
  assert.equal(
    shouldExecute({ ...base, facts: untried, reason: "pty-exit", livePtyCount: 1 }),
    false,
    "a live codex session still blocks, whatever the trigger",
  );
  assert.equal(
    shouldExecute({ ...base, facts: untried, reason: "pty-exit", setting: false }),
    false,
    "the setting still blocks, whatever the trigger",
  );
  assert.equal(
    shouldExecute({ ...base, facts: untried, reason: "pty-exit", attemptState: "running" }),
    false,
    "the mutex still blocks, whatever the trigger",
  );
  results.o1Gate = "churn tries once per version; ticks retry";
}

// updatePending on its own, since both predicates lean on it.
{
  assert.equal(updatePending({ lastCheck: check("0.146.0", "0.147.0"), lastAttempt: null }), true);
  assert.equal(updatePending({ lastCheck: check("0.147.0", "0.147.0"), lastAttempt: null }), false);
  assert.equal(
    updatePending({ lastCheck: check("0.146.0", "0.147.0", false), lastAttempt: null }),
    false,
    "ok=false is never pending",
  );
  assert.equal(updatePending({ lastCheck: null, lastAttempt: null }), false);
  results.updatePending = "ok";
}

console.log(JSON.stringify({ success: true, results }, null, 2));
process.exitCode = 0;
