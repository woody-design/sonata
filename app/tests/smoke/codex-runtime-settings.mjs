// Codex injection edge (control plane S2) — the profile writer + stable shims.
//
// The trust design is load-bearing: Codex binds trust to the EXACT hook command
// string, and silently skips untrusted/misconfigured hooks. So this fence pins:
//   1. the profile file is BYTE-STABLE across repeated spawn-preps (sha-equal)
//      — the sha the one-time trust ceremony is granted against;
//   2. it carries the FINAL frozen hook set (5 core events → sink;
//      PermissionRequest → broker, timeout=120) in the probe-verified TOML shape
//      (PascalCase events, STRING command, `[[hooks.Event]]` / `.hooks`);
//   3. the command strings route through the STABLE shim paths (task-invariant),
//      and the shims are written and read DUET_RUNTIME_DIR from the environment;
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
  CODEX_DUET_PROFILE,
  codexHooksDirectory,
  codexApprovalsDirectory,
} = require("../../dist/runtime/providers/codex/index");

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "duet-codex-settings-"));
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
  assert.equal(CODEX_DUET_PROFILE, "duet");
});

check("ensure writes profile + both shims", () => {
  ensureCodexRuntimeSettings({ binDir });
  assert.ok(fs.existsSync(profilePath), "profile written");
  assert.ok(fs.existsSync(sinkShim), "sink shim written");
  assert.ok(fs.existsSync(brokerShim), "broker shim written");
});

check("profile is BYTE-STABLE across two spawn-preps (sha unchanged)", () => {
  const first = sha(profilePath);
  ensureCodexRuntimeSettings({ binDir });
  ensureCodexRuntimeSettings({ binDir });
  const second = sha(profilePath);
  assert.equal(second, first, "duet.config.toml sha drifted across spawn-preps");
});

check("profile carries the FINAL frozen hook set in the probe-verified shape", () => {
  const toml = fs.readFileSync(profilePath, "utf8");
  for (const event of ["SessionStart", "UserPromptSubmit", "PreToolUse", "PostToolUse", "Stop"]) {
    assert.ok(toml.includes(`[[hooks.${event}]]`), `${event} block present`);
    assert.ok(toml.includes(`[[hooks.${event}.hooks]]`), `${event}.hooks present`);
  }
  assert.ok(toml.includes("[[hooks.PermissionRequest]]"), "PermissionRequest present");
  assert.ok(toml.includes("timeout = 120"), "broker timeout frozen at 120s");
  // Codex-only set: NO Claude-only events registered (no consumer, no claim).
  for (const absent of ["Notification", "StopFailure", "SubagentStop"]) {
    assert.ok(!toml.includes(`[[hooks.${absent}]]`), `${absent} must NOT be registered`);
    assert.ok(!toml.includes(`hooks.${absent}.hooks`), `${absent}.hooks must NOT be registered`);
  }
  assert.ok(toml.includes('type = "command"'), "command hook type");
});

check("commands route through the stable shim paths (task-invariant)", () => {
  const toml = fs.readFileSync(profilePath, "utf8");
  assert.ok(toml.includes(sinkShim), "sink command references the stable shim path");
  assert.ok(toml.includes(brokerShim), "broker command references the stable shim path");
  // Frozen command shape: `node "<abs path>"`, no per-task argv.
  assert.ok(toml.includes(`command = 'node "${sinkShim}"'`), "sink command is `node \"<shim>\"`");
  assert.ok(
    toml.includes(`command = 'node "${brokerShim}"'`),
    "broker command is `node \"<shim>\"`",
  );
});

check("shims read DUET_RUNTIME_DIR from the env (task binding via env, not argv)", () => {
  const sink = fs.readFileSync(sinkShim, "utf8");
  const broker = fs.readFileSync(brokerShim, "utf8");
  assert.ok(sink.includes("process.env.DUET_RUNTIME_DIR"), "sink reads DUET_RUNTIME_DIR");
  assert.ok(broker.includes("process.env.DUET_RUNTIME_DIR"), "broker reads DUET_RUNTIME_DIR");
  // The sink writes into runtimeDir/hooks (same layout the HookWatcher polls).
  assert.ok(sink.includes('"hooks"'), "sink writes into the hooks/ subdir");
  // The broker is inert in S2 — checks the answering marker, no hold/stdout.
  assert.ok(broker.includes("answering-enabled"), "broker gates on the S3 marker");
});

check("shim writes are idempotent (write-if-changed leaves stable bytes)", () => {
  const before = sha(sinkShim);
  ensureCodexRuntimeSettings({ binDir });
  assert.equal(sha(sinkShim), before, "sink shim sha drifted");
});

check("directory helpers derive the standard sink/approvals layout", () => {
  const rd = "/tmp/duet/runtime/task-x";
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
    env: { ...process.env, DUET_RUNTIME_DIR: runtimeDir },
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
    env: { ...process.env, DUET_RUNTIME_DIR: runtimeDir },
  });
  assert.equal(out.toString(), "", "broker emitted no stdout (native card takes over)");
});

fs.rmSync(tempRoot, { recursive: true, force: true });

if (failures.length > 0) {
  console.error(`\ncodex-runtime-settings: ${failures.length} FAILED`);
  process.exit(1);
}
console.log("\ncodex-runtime-settings smoke checks passed.");
