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
export function createSettingsGuard({ settingsPath = userSettingsPath(), onRestore } = {}) {
  const snapshot = snapshotUserSettings(settingsPath);
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
    pass:
      seenMutated !== guard.snapshot.bytes &&
      outcome.restored === true &&
      finalBytes === guard.snapshot.bytes,
  };
}

// `node settings-guard.mjs --self-test` — the module is runnable on its own so
// the bracket can be proven against a throwaway file with no probe attached:
//   SONATA_PROBE_SETTINGS_PATH=/tmp/x.json node settings-guard.mjs --self-test
if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  const result = runSettingsGuardSelfTest();
  console.log(JSON.stringify(result, null, 2));
  process.exit(result.pass === false ? 1 : 0);
}
