// Codex injection edge (control plane S2) — the profile writer + stable shims.
//
// The trust design is load-bearing: Codex binds trust to the EXACT hook command
// string, and silently skips untrusted/misconfigured hooks. So this fence pins:
//   1. the profile file is BYTE-STABLE across repeated spawn-preps (sha-equal)
//      — the sha the one-time trust ceremony is granted against;
//   2. it carries the consumed hook set (5 core events + SubagentStart/Stop →
//      sink; PermissionRequest → broker, timeout=120) in the probe-verified TOML
//      shape (PascalCase events, STRING command, `[[hooks.Event]]` / `.hooks`);
//   3. the command strings route through the STABLE shim paths (task-invariant),
//      and the shims are written and read SONATA_RUNTIME_DIR from the environment;
//   4. write-if-changed leaves an unchanged file untouched (idempotent).
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const {
  ensureCodexRuntimeSettings,
  codexProfilePath,
  CODEX_SONATA_PROFILE,
  CODEX_ANSWERING_MARKER,
  codexHooksDirectory,
  codexApprovalsDirectory,
  codexBrokerDecisionJson,
  enableCodexAnswering,
  disableCodexAnswering,
} = require("../../dist/runtime/providers/codex/index");
const { spawn } = require("node:child_process");

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "sonata-codex-settings-"));
// Isolate the profile file to a temp CODEX_HOME — NEVER touch the real ~/.codex.
process.env.CODEX_HOME = path.join(tempRoot, "codex-home");
const failures = [];

function check(name, fn) {
  try {
    fn();
    console.log(`ok   ${name}`);
  } catch (error) {
    failures.push(name);
    console.error(`FAIL ${name}`);
    console.error(error);
  }
}

const binDir = path.join(tempRoot, "bin");
const profilePath = codexProfilePath(); // resolves under our temp CODEX_HOME
const sinkShim = path.join(binDir, "codex-hook-sink.js");
const brokerShim = path.join(binDir, "codex-approval-broker.js");

function sha(filePath) {
  return createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

check("profile name is the layered profile flag value", () => {
  assert.equal(CODEX_SONATA_PROFILE, "sonata");
});

check("ensure writes profile + both shims", () => {
  ensureCodexRuntimeSettings({ binDir });
  assert.ok(fs.existsSync(profilePath), "profile written");
  assert.ok(fs.existsSync(sinkShim), "sink shim written");
  assert.ok(fs.existsSync(brokerShim), "broker shim written");
});

check("profile is BYTE-STABLE across same-input spawn-preps (sha unchanged)", () => {
  // The contract widened at S1: byte-stability is now conditioned on SAME INPUTS
  // (binDir, existing-ledger state, pretrustCwd). With no pretrustCwd and an empty
  // ledger, repeated preps still converge (also proves the ledger-less profile is
  // byte-identical to the pre-ledger output — no trailing section).
  const first = sha(profilePath);
  ensureCodexRuntimeSettings({ binDir });
  ensureCodexRuntimeSettings({ binDir });
  const second = sha(profilePath);
  assert.equal(second, first, "sonata.config.toml sha drifted across same-input spawn-preps");
});

check("profile carries the consumed hook set in the probe-verified shape", () => {
  const toml = fs.readFileSync(profilePath, "utf8");
  // Run-lifecycle spine + the subagent-roster pair (S6) + the compaction pair
  // (S7). SubagentStart/Stop feed the status-strip roster (Codex subagents live
  // in their own rollouts, so the hooks are the only source). PreCompact/
  // PostCompact are registered for signal completeness (they flow to the sink);
  // Sonata does not consume them — the compaction marker is transcript-derived.
  for (const event of [
    "SessionStart",
    "UserPromptSubmit",
    "PreToolUse",
    "PostToolUse",
    "Stop",
    "SubagentStart",
    "SubagentStop",
    "PreCompact",
    "PostCompact",
  ]) {
    assert.ok(toml.includes(`[[hooks.${event}]]`), `${event} block present`);
    assert.ok(toml.includes(`[[hooks.${event}.hooks]]`), `${event}.hooks present`);
  }
  assert.ok(toml.includes("[[hooks.PermissionRequest]]"), "PermissionRequest present");
  assert.ok(toml.includes("timeout = 120"), "broker timeout frozen at 120s");
  // Unregistered: Claude-only events with no Codex equivalent.
  for (const absent of ["Notification", "StopFailure"]) {
    assert.ok(!toml.includes(`[[hooks.${absent}]]`), `${absent} must NOT be registered`);
    assert.ok(!toml.includes(`hooks.${absent}.hooks`), `${absent}.hooks must NOT be registered`);
  }
  assert.ok(toml.includes('type = "command"'), "command hook type");
});

check("commands route through the stable shim paths (task-invariant)", () => {
  const toml = fs.readFileSync(profilePath, "utf8");
  assert.ok(toml.includes(sinkShim), "sink command references the stable shim path");
  assert.ok(toml.includes(brokerShim), "broker command references the stable shim path");
  // Frozen command shape (S2 runtime binding): the Sonata interpreter prefix binds
  // the shim to Sonata's own Electron-as-node — `ELECTRON_RUN_AS_NODE=1
  // "${SONATA_NODE:-node}" "<abs path>"` — no per-task argv, no host `node`.
  const PREFIX = 'ELECTRON_RUN_AS_NODE=1 "${SONATA_NODE:-node}"';
  assert.ok(
    toml.includes(`command = '${PREFIX} "${sinkShim}"'`),
    "sink command is the interpreter-prefix + \"<shim>\"",
  );
  assert.ok(
    toml.includes(`command = '${PREFIX} "${brokerShim}"'`),
    "broker command is the interpreter-prefix + \"<shim>\"",
  );
  // The old bare-`node` shape must be GONE (undeclared host-node dependency).
  assert.ok(!toml.includes(`command = 'node "`), "no bare-`node` command survives");
});

check("shims read SONATA_RUNTIME_DIR from the env (task binding via env, not argv)", () => {
  const sink = fs.readFileSync(sinkShim, "utf8");
  const broker = fs.readFileSync(brokerShim, "utf8");
  assert.ok(sink.includes("process.env.SONATA_RUNTIME_DIR"), "sink reads SONATA_RUNTIME_DIR");
  assert.ok(broker.includes("process.env.SONATA_RUNTIME_DIR"), "broker reads SONATA_RUNTIME_DIR");
  // The sink writes into runtimeDir/hooks (same layout the HookWatcher polls).
  assert.ok(sink.includes('"hooks"'), "sink writes into the hooks/ subdir");
  // The broker gates on the answering marker, then holds-and-answers (S3).
  assert.ok(broker.includes(CODEX_ANSWERING_MARKER), "broker gates on the answering marker");
  assert.ok(broker.includes("ask-"), "broker surfaces ask-<id>.json (hold path)");
  assert.ok(broker.includes("reply"), "broker polls for the reply file");
});

check("broker CLAMPS the hold override below the hook timeout (S4 #6)", () => {
  const broker = fs.readFileSync(brokerShim, "utf8");
  // A SONATA_BROKER_HOLD_MS inherited into production above the 120s hook timeout
  // would let Codex kill the hook before the shim writes `expired` — clamp it.
  assert.ok(broker.includes("Math.min("), "holdMs is clamped with Math.min");
  // The ceiling must be < the 120s hook timeout (its interpolated ms literal).
  const m = broker.match(/Math\.min\([\s\S]*?,\s*(\d+),?\s*\)/);
  assert.ok(m, "the Math.min ceiling is a numeric literal");
  const ceilingMs = Number(m[1]);
  assert.ok(ceilingMs < 120_000, `hold ceiling ${ceilingMs}ms must be below the 120s hook timeout`);
});

check("broker cleanup is INDEPENDENT of the marker write (S4 #7)", () => {
  const broker = fs.readFileSync(brokerShim, "utf8");
  // If writeAtomic(answered/expired) throws (ENOSPC), the ask cleanup rmSync
  // must still run or the ask lingers + the card never clears. Each rmSync gets
  // its OWN try — no nesting under the marker write.
  assert.ok(
    /try\s*{\s*writeAtomic\(answeredPath[\s\S]*?}\s*catch[\s\S]*?try\s*{\s*fs\.rmSync\(askPath/.test(broker),
    "answer(): askPath rmSync is in its own try, after the writeAtomic try",
  );
  assert.ok(
    /try\s*{\s*writeAtomic\(expiredPath[\s\S]*?}\s*catch[\s\S]*?try\s*{\s*fs\.rmSync\(askPath/.test(broker),
    "expiry: askPath rmSync is in its own try, after the writeAtomic try",
  );
});

check("shim writes are idempotent (write-if-changed leaves stable bytes)", () => {
  const before = sha(sinkShim);
  ensureCodexRuntimeSettings({ binDir });
  assert.equal(sha(sinkShim), before, "sink shim sha drifted");
});

check("directory helpers derive the standard sink/approvals layout", () => {
  const rd = "/tmp/sonata/runtime/task-x";
  assert.equal(codexHooksDirectory(rd), path.join(rd, "hooks"));
  assert.equal(codexApprovalsDirectory(rd), path.join(rd, "approvals"));
});

// The frozen sink shim must actually implement the tmp+rename protocol the
// HookWatcher consumes — run it end-to-end with a fed payload.
check("sink shim writes a hook-*.json via tmp+rename when fed a payload", () => {
  const runtimeDir = path.join(tempRoot, "rt-sink-exec");
  fs.mkdirSync(runtimeDir, { recursive: true });
  const { execFileSync } = require("node:child_process");
  execFileSync("node", [sinkShim], {
    input: JSON.stringify({ hook_event_name: "SessionStart", session_id: "s1" }),
    env: { ...process.env, SONATA_RUNTIME_DIR: runtimeDir },
  });
  const hooksDir = path.join(runtimeDir, "hooks");
  const files = fs.readdirSync(hooksDir).filter((f) => /^hook-.+\.json$/.test(f));
  assert.equal(files.length, 1, "exactly one hook file written");
  const payload = JSON.parse(fs.readFileSync(path.join(hooksDir, files[0]), "utf8"));
  assert.equal(payload.session_id, "s1");
});

// The inert broker must exit 0 with NO stdout (→ Codex's native card shows
// instantly) while the answering-enabled marker is absent.
check("inert broker exits 0 with no stdout when the marker is absent", () => {
  const runtimeDir = path.join(tempRoot, "rt-broker-exec");
  fs.mkdirSync(path.join(runtimeDir, "approvals"), { recursive: true });
  const { execFileSync } = require("node:child_process");
  const out = execFileSync("node", [brokerShim], {
    input: JSON.stringify({ hook_event_name: "PermissionRequest", tool_name: "Bash" }),
    env: { ...process.env, SONATA_RUNTIME_DIR: runtimeDir },
  });
  assert.equal(out.toString(), "", "broker emitted no stdout (native card takes over)");
});

// ── S3: the decision-JSON shape + the answering-marker lifecycle ─────────────

check("codexBrokerDecisionJson emits the Codex allow/deny shape (no Always rule)", () => {
  const allow = codexBrokerDecisionJson("approve");
  assert.deepEqual(allow, {
    hookSpecificOutput: { hookEventName: "PermissionRequest", decision: { behavior: "allow" } },
  });
  const deny = codexBrokerDecisionJson("deny");
  assert.equal(deny.hookSpecificOutput.decision.behavior, "deny");
  // approve-always degrades to a one-shot allow — Codex rule support is an
  // UNVERIFIED open probe, so we never emit a guessed updatedPermissions shape.
  const always = codexBrokerDecisionJson("approve-always");
  assert.equal(always.hookSpecificOutput.decision.behavior, "allow");
  assert.ok(
    !("updatedPermissions" in always.hookSpecificOutput.decision),
    "no persistent-rule vocabulary leaks into the Codex decision",
  );
  // Fail-CLOSED: an unrecognized decision value must block, never auto-approve.
  const unknown = codexBrokerDecisionJson("answered-natively");
  assert.equal(unknown.hookSpecificOutput.decision.behavior, "deny", "unknown decision fails closed");
});

// The Codex broker shim (frozen TEXT, interpolates the protocol) and the Claude
// broker (compiled, imports it) MUST agree on the ask/reply/expired/answered
// prefixes — a desync would silently break cards (reviewer R2/C3). Assert both
// carry every shared prefix.
check("shim and Claude broker agree on the shared approval protocol prefixes", () => {
  const {
    ASK_PREFIX,
    REPLY_PREFIX,
    EXPIRED_PREFIX,
    ANSWERED_PREFIX,
  } = require("../../dist/runtime/cli-signal/approval-protocol");
  const shim = fs.readFileSync(brokerShim, "utf8");
  const claudeBroker = fs.readFileSync(
    require.resolve("../../dist/runtime/cli-signal/approval-broker.js"),
    "utf8",
  );
  for (const prefix of [ASK_PREFIX, REPLY_PREFIX, EXPIRED_PREFIX, ANSWERED_PREFIX]) {
    assert.ok(shim.includes(`"${prefix}"`), `shim carries the shared prefix ${prefix}`);
    assert.ok(claudeBroker.includes(prefix), `Claude broker carries the shared prefix ${prefix}`);
  }
  // The shim's final reply-check (the orphan-reply guard's broker side).
  assert.ok(shim.includes("readReply"), "shim has the reusable reply reader");
  assert.ok(claudeBroker.includes("readReply"), "Claude broker has the reusable reply reader");
});

check("enable/disableCodexAnswering writes and clears the marker", () => {
  const rd = path.join(tempRoot, "rt-marker");
  const markerPath = path.join(codexApprovalsDirectory(rd), CODEX_ANSWERING_MARKER);
  enableCodexAnswering(rd);
  assert.ok(fs.existsSync(markerPath), "marker present after enable");
  disableCodexAnswering(rd);
  assert.ok(!fs.existsSync(markerPath), "marker cleared after disable");
});

// The frozen broker shim must actually implement the hold-and-answer protocol
// the ApprovalWatcher consumes — drive it end-to-end as a subprocess.
function runBroker(runtimeDir, payload, holdMs) {
  return new Promise((resolve) => {
    const child = spawn("node", [brokerShim], {
      env: { ...process.env, SONATA_RUNTIME_DIR: runtimeDir, SONATA_BROKER_HOLD_MS: String(holdMs) },
    });
    let out = "";
    child.stdout.on("data", (c) => (out += c.toString()));
    child.on("close", () => resolve(out));
    child.stdin.write(JSON.stringify(payload));
    child.stdin.end();
  });
}

async function acheck(name, fn) {
  try {
    await fn();
    console.log(`ok   ${name}`);
  } catch (error) {
    failures.push(name);
    console.error(`FAIL ${name}`);
    console.error(error);
  }
}

await acheck("armed broker surfaces ask-<id>, echoes the reply, then cleans up", async () => {
  const rd = path.join(tempRoot, "rt-broker-answer");
  const approvals = codexApprovalsDirectory(rd);
  fs.mkdirSync(approvals, { recursive: true });
  enableCodexAnswering(rd);
  const brokerDone = runBroker(
    rd,
    { hook_event_name: "PermissionRequest", tool_name: "Bash", tool_input: { command: "echo hi", description: "Allow echo?" } },
    5000,
  );
  // Wait for the ask, then answer it (mirrors Sonata's ApprovalWatcher → decideApproval).
  const decisionJson = JSON.stringify(codexBrokerDecisionJson("approve"));
  let askId = null;
  for (let i = 0; i < 100 && !askId; i += 1) {
    const asks = fs.readdirSync(approvals).filter((f) => /^ask-.+\.json$/.test(f));
    if (asks.length > 0) askId = asks[0].slice("ask-".length, -".json".length);
    else await new Promise((r) => setTimeout(r, 50));
  }
  assert.ok(askId, "broker wrote ask-<id>.json while holding");
  const ask = JSON.parse(fs.readFileSync(path.join(approvals, `ask-${askId}.json`), "utf8"));
  assert.equal(ask.payload.tool_input.description, "Allow echo?", "ask carries the payload verbatim");
  // Write the reply the way writeApprovalReply does (tmp+rename).
  const replyPath = path.join(approvals, `reply-${askId}.json`);
  fs.writeFileSync(`${replyPath}.tmp`, decisionJson);
  fs.renameSync(`${replyPath}.tmp`, replyPath);
  const stdout = await brokerDone;
  assert.equal(stdout, decisionJson, "broker emitted the reply decision verbatim to stdout");
  assert.ok(fs.existsSync(path.join(approvals, `answered-${askId}.json`)), "answered audit written");
  assert.ok(!fs.existsSync(path.join(approvals, `ask-${askId}.json`)), "ask cleaned up");
  assert.ok(!fs.existsSync(replyPath), "reply consumed");
});

await acheck("armed broker times out to expired-<id> with NO stdout (native fallback)", async () => {
  const rd = path.join(tempRoot, "rt-broker-expire");
  const approvals = codexApprovalsDirectory(rd);
  fs.mkdirSync(approvals, { recursive: true });
  enableCodexAnswering(rd);
  const stdout = await runBroker(
    rd,
    { hook_event_name: "PermissionRequest", tool_name: "Bash", tool_input: { command: "echo hi" } },
    400,
  );
  assert.equal(stdout, "", "no stdout on timeout → Codex renders its native card");
  const expired = fs.readdirSync(approvals).filter((f) => /^expired-.+\.json$/.test(f));
  assert.equal(expired.length, 1, "exactly one expired marker written");
  const asks = fs.readdirSync(approvals).filter((f) => /^ask-.+\.json$/.test(f));
  assert.equal(asks.length, 0, "ask cleaned up on expiry");
});

// ── S1: the trust ledger (add / carry-forward / prune / accumulate / stable) ──
// Each case isolates to its OWN $CODEX_HOME so it never touches the real ~/.codex
// and never perturbs the shared profile the checks above assert on. The policy
// (which cwds qualify) lives in the controller; here we drive the mechanism with
// an explicit pretrustCwd and pre-seeded codex-written entries.

function freshLedgerEnv(name) {
  const home = fs.mkdtempSync(path.join(tempRoot, `ledger-${name}-`));
  process.env.CODEX_HOME = path.join(home, "codex-home");
  return { profilePath: codexProfilePath(), binDir: path.join(home, "bin") };
}

/** Simulate codex appending a trust grant the way it does live:
 *  `[projects."<abs>"]` newline `trust_level = "<level>"`. */
function appendProjectEntry(profilePath, dirPath, level = "trusted") {
  fs.appendFileSync(
    profilePath,
    `\n[projects.${JSON.stringify(dirPath)}]\ntrust_level = "${level}"\n`,
  );
}

function projectHeaders(toml) {
  return [...toml.matchAll(/^\[projects\.(.+)\]$/gm)].map((m) => JSON.parse(m[1]));
}

check("ledger: no pretrustCwd + empty existing → no [projects] section at all", () => {
  const env = freshLedgerEnv("empty");
  ensureCodexRuntimeSettings({ binDir: env.binDir });
  const toml = fs.readFileSync(env.profilePath, "utf8");
  // Byte-identical to the pre-ledger output: nothing appended after the hooks.
  assert.ok(!toml.includes("[projects."), "no projects section when nothing to trust");
  assert.ok(!toml.includes("Trust ledger"), "no ledger comment when empty");
});

check("ledger: pretrustCwd appears as a trusted [projects] entry", () => {
  const env = freshLedgerEnv("pretrust");
  const cwd = fs.mkdtempSync(path.join(tempRoot, "pretrust-cwd-"));
  ensureCodexRuntimeSettings({ binDir: env.binDir, pretrustCwd: cwd });
  const toml = fs.readFileSync(env.profilePath, "utf8");
  assert.ok(toml.includes(`[projects.${JSON.stringify(cwd)}]`), "pretrustCwd header present");
  assert.ok(toml.includes('trust_level = "trusted"'), "trust_level trusted written");
});

check("ledger: repeated same-input preps with a pretrustCwd converge (sha stable)", () => {
  const env = freshLedgerEnv("converge");
  const cwd = fs.mkdtempSync(path.join(tempRoot, "converge-cwd-"));
  ensureCodexRuntimeSettings({ binDir: env.binDir, pretrustCwd: cwd });
  const first = sha(env.profilePath);
  ensureCodexRuntimeSettings({ binDir: env.binDir, pretrustCwd: cwd });
  ensureCodexRuntimeSettings({ binDir: env.binDir, pretrustCwd: cwd });
  assert.equal(sha(env.profilePath), first, "ledger profile sha drifted across same-input preps");
});

check("ledger: a codex-written grant for an EXISTING dir survives regeneration", () => {
  const env = freshLedgerEnv("carry");
  const humanDir = fs.mkdtempSync(path.join(tempRoot, "human-grant-"));
  ensureCodexRuntimeSettings({ binDir: env.binDir });
  appendProjectEntry(env.profilePath, humanDir);
  // Regenerate with NO pretrust — the human grant (dir still exists) must carry.
  ensureCodexRuntimeSettings({ binDir: env.binDir });
  const toml = fs.readFileSync(env.profilePath, "utf8");
  assert.ok(toml.includes(`[projects.${JSON.stringify(humanDir)}]`), "human grant carried forward");
});

check("ledger: an entry for a DELETED dir prunes on regeneration", () => {
  const env = freshLedgerEnv("prune");
  const goneDir = fs.mkdtempSync(path.join(tempRoot, "gone-"));
  ensureCodexRuntimeSettings({ binDir: env.binDir });
  appendProjectEntry(env.profilePath, goneDir);
  fs.rmSync(goneDir, { recursive: true, force: true });
  ensureCodexRuntimeSettings({ binDir: env.binDir });
  const toml = fs.readFileSync(env.profilePath, "utf8");
  assert.ok(!toml.includes(goneDir), "dead-dir entry pruned");
});

check("ledger: a NON-trusted existing entry is dropped from carry-forward", () => {
  const env = freshLedgerEnv("nontrust");
  const dir = fs.mkdtempSync(path.join(tempRoot, "nontrust-"));
  ensureCodexRuntimeSettings({ binDir: env.binDir });
  appendProjectEntry(env.profilePath, dir, "untrusted");
  ensureCodexRuntimeSettings({ binDir: env.binDir });
  const toml = fs.readFileSync(env.profilePath, "utf8");
  assert.ok(!toml.includes(dir), "non-trusted entry not carried forward (preserve-only-trusted)");
});

check("ledger: entries ACCUMULATE and emit SORTED, independent of insertion order", () => {
  const env = freshLedgerEnv("accum");
  // Seed a codex-written grant that sorts AFTER the pretrustCwd we add next, so
  // file/insertion order (zzz then aaa) DIFFERS from sorted order. A regression
  // dropping `[...paths].sort()` would emit [zzz, aaa] and fail the deepEqual —
  // the previous a/b fixture couldn't catch it (insertion order == sorted order).
  const late = fs.mkdtempSync(path.join(tempRoot, "accum-zzz-"));
  const early = fs.mkdtempSync(path.join(tempRoot, "accum-aaa-"));
  ensureCodexRuntimeSettings({ binDir: env.binDir });
  appendProjectEntry(env.profilePath, late);
  ensureCodexRuntimeSettings({ binDir: env.binDir, pretrustCwd: early });
  const toml = fs.readFileSync(env.profilePath, "utf8");
  assert.ok(toml.includes(late) && toml.includes(early), "both cwds present (no last-spawn clobber)");
  assert.deepEqual(
    projectHeaders(toml),
    [early, late],
    "entries emitted in sorted order, not insertion order",
  );
});

fs.rmSync(tempRoot, { recursive: true, force: true });

if (failures.length > 0) {
  console.error(`\ncodex-runtime-settings: ${failures.length} FAILED`);
  process.exit(1);
}
console.log("\ncodex-runtime-settings smoke checks passed.");
