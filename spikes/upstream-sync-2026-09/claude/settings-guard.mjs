// THE SETTINGS GUARD — the harness bracket that keeps a probe from editing the
// user's real Claude configuration.
//
// WHY THIS IS A MODULE AND NOT A COMMENT. INCIDENT F41 (2026-09-02 01:20:50,
// h1-hook-census's own `c1-census` arm): the arm drove a real `/model haiku` to
// trigger the ModelSwitch hook pair, a `/model` switch PERSISTS the new default
// into `~/.claude/settings.json`, and the spawn deliberately uses the REAL config
// dir — an isolated `CLAUDE_CONFIG_DIR` is logged out (SL-3), so there is nothing
// to isolate INTO. The arm's own restore was a second `/model opus[1m]` driven
// through the composer; the slash never landed (`on the composer before CR:
// false`) and the failure was read as missing measurement data rather than as an
// unrestored user setting. Woody's default stayed on haiku.
//
// The lesson is NOT "drive the slash harder". A restore driven through a composer
// is a best-effort UI action with a failure mode. A restore of a FILE is
// deterministic. So the bracket is: snapshot the bytes before any arm runs, write
// them back unconditionally afterwards — on success, on throw, and on SIGNAL —
// and VERIFY the bytes came back, reporting a mismatch loudly instead of trusting
// the write.
//
// PROVENANCE. The implementation was proven in `h1-hook-census.mjs` (its capture
// records `mutatedByProbe` for a run that really did mutate the file) and lifted
// here verbatim in behaviour so U1's `m1` and U3's `h4` share ONE bracket instead
// of three copies that drift. h1 itself is deliberately left untouched: its
// capture is committed evidence and the file is the provenance of that capture.
//
// TWO RULES THIS MODULE ENCODES, both load-bearing:
//   1. NEVER print the file. `~/.claude/settings.json` can carry tokens and every
//      capture is committed. The guard reports KEY-LEVEL diffs only.
//   2. The override env var (`SONATA_PROBE_SETTINGS_PATH`) exists ONLY so the
//      guard can be self-tested against a throwaway file. A production probe run
//      never sets it and therefore always protects the real one.
//
// THE SECOND FILE (D2 U5, 2026-09-03 — F70/F96). Every live-spawn arm answers the
// workspace-trust dialog for a `/private/tmp/sonata-sync-2026-09/...` cwd, and the
// CLI persists that answer as `projects[<cwd>].hasTrustDialogAccepted` in
// `~/.claude.json`. MEASURED 2026-09-03: 143 such entries from this program in a
// file of 3,617 projects. That file ALSO carries live accounting the CLI rewrites
// continuously (`lastCost`, `lastSessionId`, `lastModelUsage`, …), so a BYTE
// restore of it is unsafe — it would clobber a user's concurrent sessions. The
// bracket for it is therefore SURGICAL, not a snapshot: remember the SET of
// project keys before the run, and afterwards delete only the keys that are NEW
// since the snapshot AND live under the probe root. Nothing else is read into a
// capture, nothing else is written. Override env for self-test:
// `SONATA_PROBE_CLAUDE_JSON_PATH`.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** The file every probe in this program is protecting. */
export function userSettingsPath() {
  return (
    process.env.SONATA_PROBE_SETTINGS_PATH || path.join(os.homedir(), ".claude", "settings.json")
  );
}

/** Bytes-now, or null when there is no file to protect. */
export function snapshotUserSettings(settingsPath = userSettingsPath()) {
  try {
    return { path: settingsPath, bytes: fs.readFileSync(settingsPath, "utf8") };
  } catch {
    return null;
  }
}

/** Key-level difference between two JSON texts. Values are included because the
 *  keys this program moves (`model`, `effortLevel`) are short aliases — but the
 *  set is bounded by what actually CHANGED, so an untouched token key can never
 *  reach a capture. */
export function diffJsonKeys(beforeText, afterText) {
  try {
    const before = JSON.parse(beforeText);
    const after = JSON.parse(afterText ?? "{}");
    const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
    return [...keys]
      .filter((key) => JSON.stringify(before[key]) !== JSON.stringify(after[key]))
      .map((key) => `${key}: ${JSON.stringify(before[key])} → ${JSON.stringify(after[key])}`);
  } catch {
    return ["<unparseable; bytes differ>"];
  }
}

/** Put the user's settings back exactly as they were, and report what changed
 *  under us and whether the restore actually took. */
export function restoreUserSettings(snapshot) {
  if (!snapshot) return { checked: false };
  let after = null;
  try {
    after = fs.readFileSync(snapshot.path, "utf8");
  } catch {
    // deleted under us — restore it anyway
  }
  const mutated = after !== snapshot.bytes;
  if (!mutated) return { checked: true, mutatedByProbe: false, restored: true };
  try {
    fs.writeFileSync(snapshot.path, snapshot.bytes, "utf8");
  } catch (error) {
    return {
      checked: true,
      mutatedByProbe: true,
      restored: false,
      error: String(error?.message ?? error),
      changedKeys: diffJsonKeys(snapshot.bytes, after),
    };
  }
  const verified = (() => {
    try {
      return fs.readFileSync(snapshot.path, "utf8") === snapshot.bytes;
    } catch {
      return false;
    }
  })();
  return {
    checked: true,
    mutatedByProbe: true,
    restored: verified,
    changedKeys: diffJsonKeys(snapshot.bytes, after),
  };
}

/** The CLI's project map file (trust answers + per-project accounting). */
export function userClaudeJsonPath() {
  return process.env.SONATA_PROBE_CLAUDE_JSON_PATH || path.join(os.homedir(), ".claude.json");
}

/** The root under which every probe in this program creates its cwds. Only keys
 *  under it are ever eligible for cleanup. */
export const DEFAULT_PROBE_ROOT = "/private/tmp/sonata-sync-2026-09/";

function readProjectKeys(claudeJsonPath) {
  try {
    const parsed = JSON.parse(fs.readFileSync(claudeJsonPath, "utf8"));
    const projects = parsed && typeof parsed.projects === "object" && parsed.projects ? parsed.projects : {};
    return { ok: true, keys: new Set(Object.keys(projects)) };
  } catch (error) {
    return { ok: false, keys: new Set(), error: String(error?.message ?? error) };
  }
}

/** The indentation the file already uses, so a rewrite does not reformat it. */
function detectIndent(text) {
  const match = /\n([ \t]+)"/.exec(text);
  return match ? match[1] : 2;
}

/** Snapshot the SET of `projects` keys (never values, never the file). */
export function snapshotProjectKeys(claudeJsonPath = userClaudeJsonPath()) {
  const read = readProjectKeys(claudeJsonPath);
  return { path: claudeJsonPath, ok: read.ok, keys: read.keys, error: read.error };
}

/**
 * Delete ONLY the project keys that are (a) absent from the snapshot and (b) under
 * `probeRoot`. Read-modify-write once; if the file's mtime/size moves between the
 * read and the write (a CLI still running), re-read and retry once, then give up
 * and report rather than clobber. Reports the removed key paths — they are probe
 * cwds under `/private/tmp`, safe for a committed capture.
 *
 * `sweepExisting: true` widens (a) to "any key under the probe root" — used ONCE,
 * deliberately, to clean the entries the program's earlier probes left before this
 * guard existed. A normal run never sets it.
 */
export function cleanupProbeProjectKeys(snapshot, { probeRoot = DEFAULT_PROBE_ROOT, sweepExisting = false } = {}) {
  if (!snapshot || !snapshot.ok) {
    return { checked: false, reason: snapshot?.error ?? "no snapshot" };
  }
  const attempt = () => {
    let text;
    let statBefore;
    try {
      statBefore = fs.statSync(snapshot.path);
      text = fs.readFileSync(snapshot.path, "utf8");
    } catch (error) {
      return { done: true, result: { checked: true, removed: [], error: `read: ${String(error?.message ?? error)}` } };
    }
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      return { done: true, result: { checked: true, removed: [], error: "unparseable; left untouched" } };
    }
    const projects = parsed && typeof parsed.projects === "object" && parsed.projects ? parsed.projects : null;
    if (!projects) return { done: true, result: { checked: true, removed: [] } };
    const removed = Object.keys(projects).filter(
      (key) => key.startsWith(probeRoot) && (sweepExisting || !snapshot.keys.has(key)),
    );
    if (removed.length === 0) return { done: true, result: { checked: true, removed: [] } };
    for (const key of removed) delete projects[key];
    const survivors = Object.keys(projects).length;
    const out = `${JSON.stringify(parsed, null, detectIndent(text))}${text.endsWith("\n") ? "\n" : ""}`;
    // Concurrency fence: another writer between our read and our write means our
    // parsed copy is stale — do not write over it.
    let statNow;
    try {
      statNow = fs.statSync(snapshot.path);
    } catch {
      return { done: true, result: { checked: true, removed: [], error: "vanished between read and write" } };
    }
    if (statNow.mtimeMs !== statBefore.mtimeMs || statNow.size !== statBefore.size) {
      return { done: false };
    }
    fs.writeFileSync(snapshot.path, out, "utf8");
    const after = readProjectKeys(snapshot.path);
    const stillThere = removed.filter((key) => after.keys.has(key));
    return {
      done: true,
      result: {
        checked: true,
        removed,
        verified: stillThere.length === 0 && after.ok && after.keys.size === survivors,
        survivors: after.keys.size,
      },
    };
  };
  let outcome = attempt();
  if (!outcome.done) {
    outcome = attempt();
    if (!outcome.done) {
      return { checked: true, removed: [], error: "file changed under us twice; not written" };
    }
  }
  return outcome.result;
}

/**
 * The bracket, as one object. Construct it BEFORE the first spawn; call
 * `guard.restore()` from a `finally`. Signal handlers are installed immediately
 * (a Ctrl-C mid-arm must not leave the user on another model).
 *
 * Extras over the raw functions, all of which exist because a probe needs them
 * per ARM and not only at exit:
 *   - `readKey(key)` — what the file says right now, for the arm that must state
 *     the user default it is racing against (U1 axis iv).
 *   - `diffSinceSnapshot()` — the per-arm, non-restoring check: did THIS arm move
 *     the file? Recorded per arm, then the whole run is restored once at the end.
 */
export function createSettingsGuard({
  settingsPath = userSettingsPath(),
  claudeJsonPath = userClaudeJsonPath(),
  probeRoot = DEFAULT_PROBE_ROOT,
  onRestore,
} = {}) {
  const snapshot = snapshotUserSettings(settingsPath);
  // The second file's bracket (see the module header): a key SET, not bytes.
  const projectKeys = snapshotProjectKeys(claudeJsonPath);
  let projectCleanup = null;
  const history = [];
  let finalOutcome = null;

  /**
   * Restore NOW and say what was found. Safe to call between arms, and that is
   * the point: an arm that persists a model (a mid-session `/model` — the F41
   * vector) would otherwise leave the NEXT arm racing a user default it did not
   * choose, silently confounding the measurement it exists to make. So the
   * bracket closes per arm, not only per run.
   */
  const restoreNow = (label = "arm") => {
    const outcome = restoreUserSettings(snapshot);
    outcome.label = label;
    history.push(outcome);
    if (outcome.mutatedByProbe) {
      process.stderr.write(
        `\n[settings guard] ${label}: the probe changed ${settingsPath} (${(outcome.changedKeys ?? []).join("; ")}) — restored: ${outcome.restored}\n`,
      );
    }
    onRestore?.(outcome);
    return outcome;
  };

  /** The `finally`/signal bracket. Runs once; later calls are a no-op so a
   *  SIGINT racing the `finally` cannot double-report. */
  const restore = () => {
    if (finalOutcome) return finalOutcome;
    finalOutcome = restoreNow("final");
    if (!finalOutcome.mutatedByProbe && finalOutcome.checked) {
      process.stderr.write(
        `\n[settings guard] final: ${settingsPath} matches the snapshot (arms that mutated it: ${history.filter((h) => h.mutatedByProbe).length})\n`,
      );
    }
    // The second file, AFTER every arm's CLI has exited (this runs from the
    // caller's `finally`): delete only the project keys this run created under
    // the probe root. Never a byte restore — see the module header.
    projectCleanup = cleanupProbeProjectKeys(projectKeys, { probeRoot });
    finalOutcome.projectCleanup = projectCleanup;
    if (projectCleanup.checked) {
      process.stderr.write(
        `\n[settings guard] ~/.claude.json: removed ${projectCleanup.removed?.length ?? 0} probe project key(s) under ${probeRoot}` +
          (projectCleanup.error ? ` — ${projectCleanup.error}` : projectCleanup.verified === false ? " — VERIFY FAILED" : "") +
          "\n",
      );
    }
    return finalOutcome;
  };

  const installSignalRestore = () => {
    for (const signal of ["SIGINT", "SIGTERM"]) {
      process.on(signal, () => {
        restore();
        process.exit(130);
      });
    }
  };
  installSignalRestore();

  return {
    path: settingsPath,
    snapshot,
    /** The file's current bytes (null when it does not exist). */
    currentBytes() {
      try {
        return fs.readFileSync(settingsPath, "utf8");
      } catch {
        return null;
      }
    },
    /** One top-level key's current value — the arm's statement of what it races. */
    readKey(key) {
      try {
        return JSON.parse(fs.readFileSync(settingsPath, "utf8"))[key] ?? null;
      } catch {
        return null;
      }
    },
    /** Key-level drift versus the snapshot, WITHOUT restoring. Per-arm evidence. */
    diffSinceSnapshot() {
      if (!snapshot) return { checked: false };
      let after = null;
      try {
        after = fs.readFileSync(settingsPath, "utf8");
      } catch {
        /* deleted under us */
      }
      if (after === snapshot.bytes) return { checked: true, changed: false, changedKeys: [] };
      return { checked: true, changed: true, changedKeys: diffJsonKeys(snapshot.bytes, after) };
    },
    /**
     * DELIBERATE mutation of the protected file, for the ONE arm that has to ask
     * "which channel wins against the user's own pin?" and therefore needs a
     * chosen pin rather than whatever the file happens to say. Still inside the
     * bracket: `restore()` puts the snapshot back regardless.
     */
    setKeyForArm(key, value) {
      const parsed = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
      const before = parsed[key] ?? null;
      if (value === null) delete parsed[key];
      else parsed[key] = value;
      fs.writeFileSync(settingsPath, `${JSON.stringify(parsed, null, 2)}\n`, "utf8");
      return { key, before, after: value };
    },
    restoreNow,
    restore,
    installSignalRestore,
    /** The second file's snapshot (key SET) and the cleanup outcome once run. */
    projectKeys,
    projectCleanup() {
      return projectCleanup;
    },
    /** Every restore this run performed, in order — the run's own audit trail. */
    history() {
      return history;
    },
    outcome() {
      return finalOutcome ?? { checked: false };
    },
  };
}

/**
 * `--self-test`: exercise the bracket END TO END without spawning a CLI — mutate
 * the protected file the way a `/model` switch would, then run the restore and
 * assert the bytes came back. A guard that has never been observed working is not
 * a guard, so every probe in this program runs this before its first arm.
 */
export function runSettingsGuardSelfTest(guard = createSettingsGuard()) {
  if (!guard.snapshot) {
    return { selfTest: "SKIP — no settings file at " + guard.path, pass: null };
  }
  // Second-file self-test (D2 U5): simulate the CLI adding one probe-root trust
  // entry AND touching a foreign project's accounting after the snapshot. The
  // cleanup must remove exactly the probe-root key and leave every other value
  // intact. Runs only against the override path — never seeds the real file.
  const claudeJsonSelfTest = (() => {
    const overridePath = process.env.SONATA_PROBE_CLAUDE_JSON_PATH;
    if (!overridePath) return { skipped: "SONATA_PROBE_CLAUDE_JSON_PATH not set" };
    const seed = {
      numStartups: 7,
      projects: {
        "/Users/someone/real-project": { allowedTools: [], hasTrustDialogAccepted: true, lastCost: 1.25 },
        [DEFAULT_PROBE_ROOT + "older-arm"]: { hasTrustDialogAccepted: true },
      },
      oauthAccount: { emailAddress: "x@example.com" },
    };
    fs.writeFileSync(overridePath, `${JSON.stringify(seed, null, 2)}\n`, "utf8");
    const snap = snapshotProjectKeys(overridePath);
    const during = JSON.parse(fs.readFileSync(overridePath, "utf8"));
    during.projects[DEFAULT_PROBE_ROOT + "self-test-arm"] = { hasTrustDialogAccepted: true };
    during.projects["/Users/someone/real-project"].lastCost = 2.5;
    during.projects["/Users/someone/real-project"].lastSessionId = "abc";
    fs.writeFileSync(overridePath, `${JSON.stringify(during, null, 2)}\n`, "utf8");
    const cleanup = cleanupProbeProjectKeys(snap);
    const after = JSON.parse(fs.readFileSync(overridePath, "utf8"));
    const pass =
      cleanup.removed?.length === 1 &&
      cleanup.removed[0] === DEFAULT_PROBE_ROOT + "self-test-arm" &&
      after.projects[DEFAULT_PROBE_ROOT + "older-arm"] !== undefined &&
      after.projects["/Users/someone/real-project"].lastCost === 2.5 &&
      after.projects["/Users/someone/real-project"].lastSessionId === "abc" &&
      after.numStartups === 7 &&
      after.oauthAccount.emailAddress === "x@example.com" &&
      cleanup.verified === true;
    const sweep = cleanupProbeProjectKeys(snapshotProjectKeys(overridePath), { sweepExisting: true });
    const afterSweep = JSON.parse(fs.readFileSync(overridePath, "utf8"));
    const sweepPass =
      sweep.removed?.length === 1 &&
      sweep.removed[0] === DEFAULT_PROBE_ROOT + "older-arm" &&
      Object.keys(afterSweep.projects).length === 1 &&
      afterSweep.projects["/Users/someone/real-project"].lastCost === 2.5;
    return { cleanup, sweep, pass: pass && sweepPass };
  })();
  const mutated = guard.snapshot.bytes.replace(/"model":\s*"[^"]*"/, '"model": "haiku"');
  const mutationIsDistinct = mutated !== guard.snapshot.bytes;
  fs.writeFileSync(
    guard.path,
    // If the file carried no `model` key the replace was a no-op; append a
    // marker key instead, so the self-test always has something to restore.
    mutationIsDistinct ? mutated : guard.snapshot.bytes.replace(/\}\s*$/, ',"sonataProbeGuardCanary":1}'),
    "utf8",
  );
  const seenMutated = guard.currentBytes();
  const outcome = guard.restore();
  const finalBytes = guard.currentBytes();
  return {
    selfTest: true,
    settingsPath: guard.path,
    mutationLanded: seenMutated !== guard.snapshot.bytes,
    guard: outcome,
    bytesBackToOriginal: finalBytes === guard.snapshot.bytes,
    claudeJsonSelfTest,
    pass:
      seenMutated !== guard.snapshot.bytes &&
      outcome.restored === true &&
      finalBytes === guard.snapshot.bytes &&
      (claudeJsonSelfTest.pass === undefined || claudeJsonSelfTest.pass === true),
  };
}

// `node settings-guard.mjs --self-test` — the module is runnable on its own so
// the bracket can be proven against a throwaway file with no probe attached:
//   SONATA_PROBE_SETTINGS_PATH=/tmp/x.json SONATA_PROBE_CLAUDE_JSON_PATH=/tmp/y.json \\
//     node settings-guard.mjs --self-test
// `--sweep-probe-root` (one-off): remove EVERY project key under the probe root
// from the real ~/.claude.json — the cleanup for entries left before this guard
// existed. Prints the removed paths. Run only when no claude is running.
if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  if (process.argv.includes("--sweep-probe-root")) {
    const snap = snapshotProjectKeys();
    const before = snap.keys.size;
    const result = cleanupProbeProjectKeys(snap, { sweepExisting: true });
    console.log(JSON.stringify({ path: snap.path.replace(os.homedir(), "$HOME"), projectsBefore: before, ...result }, null, 2));
    process.exit(result.error ? 1 : 0);
  }
  const result = runSettingsGuardSelfTest();
  console.log(JSON.stringify(result, null, 2));
  process.exit(result.pass === false ? 1 : 0);
}
