import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";

/**
 * The hook STDOUT contract, pinned against the REAL dist binaries (SL-9).
 *
 * WHY THIS EXISTS. Claude Code parses whatever a hook command prints. MEASURED
 * at 2.1.258 (`spikes/upstream-sync-2026-09/claude/h2-hook-stdout-audit.mjs`,
 * parts A + C — the CLI's own `hook_response` verdict per class):
 *
 *   output                                    | 2.1.258 outcome
 *   ------------------------------------------|-----------------------------
 *   ""  /  whitespace  /  no leading `{`       | success (plain text)
 *   `{`-leading, does NOT end with `}`         | success (plain text)
 *   valid JSON object                          | success (parsed)
 *   `{`-leading, ends with `}`, does NOT parse | **outcome: "error"**
 *   several JSON documents                     | **outcome: "error"**
 *
 * So the rule Sonata's hook commands must obey is not "valid JSON or empty" — it
 * is "either print nothing that looks like JSON, or print ONE complete JSON
 * object". A PARTIAL object is the failure, and the way a program emits one
 * accidentally is by exiting before its stdout drains.
 *
 * ALL FOUR COMMANDS, not two (SL-9 review M1). Sonata ships a sink and a broker
 * PER PROVIDER: the claude pair as dist scripts, the codex pair as FROZEN shim
 * sources that `ensureCodexRuntimeSettings` materializes into `<binDir>`. The
 * codex broker carried the byte-identical truncation defect, so covering only
 * the claude pair would have left a measured twin untested. This test
 * materializes the codex shims into a temp binDir (with `CODEX_HOME` isolated so
 * the profile write cannot touch the user's) and exercises the same cases.
 *
 * THREE CLAIMS, measured against every shipped command:
 *   A. each sink writes ZERO stdout bytes on every reachable path;
 *   B. each broker writes stdout ONLY when it answers, and then byte-identically
 *      to the reply file;
 *   C. a LARGE answer arrives COMPLETE. This is the regression pin: before SL-9
 *      both brokers did `process.stdout.write(d); process.exit(0)`, and on macOS
 *      a pipe write is async — a 4 MB decision was truncated at exactly 65536
 *      bytes under both interpreters. This case FAILS against the pre-fix build.
 *   D. a dead read end (EPIPE) exits 0 in silence rather than crashing.
 *
 * Runs under plain node. The production interpreter shape
 * (`ELECTRON_RUN_AS_NODE=1`) was measured identically in the probe; this smoke
 * stays node-only so it needs no Electron and can run in the node subset.
 */

const distRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../../dist");
const sinkJs = path.join(distRoot, "runtime/cli-signal/hook-sink.js");
const brokerJs = path.join(distRoot, "runtime/cli-signal/approval-broker.js");

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "sonata-hookstdout-"));

// The codex pair exists only as FROZEN shim SOURCES until a spawn-prep writes
// them. Materialize them the way production does — same function, same bytes —
// with CODEX_HOME isolated so the profile write lands in the temp dir.
process.env.CODEX_HOME = path.join(tmp, "codex-home");
const { createRequire } = await import("node:module");
const require_ = createRequire(import.meta.url);
const { ensureCodexRuntimeSettings } = require_(
  path.join(distRoot, "runtime/providers/codex/codex-runtime-settings"),
);
const codexBinDir = path.join(tmp, "codex-bin");
ensureCodexRuntimeSettings({ binDir: codexBinDir, pretrustCwd: null });
const codexSinkJs = path.join(codexBinDir, "codex-hook-sink.js");
const codexBrokerJs = path.join(codexBinDir, "codex-approval-broker.js");
for (const shim of [codexSinkJs, codexBrokerJs]) {
  assert.ok(fs.existsSync(shim), `codex shim materialized: ${path.basename(shim)}`);
}
const dir = (name) => {
  const p = path.join(tmp, name);
  fs.mkdirSync(p, { recursive: true });
  return p;
};

/** The 2.1.258 verdict for a stdout string, from the measured parse contract. */
function classify(stdout) {
  const n = stdout.trim();
  if (!n.startsWith("{")) return "plainText";
  try {
    JSON.parse(n);
    return "json";
  } catch {
    return n.endsWith("}") ? "HARD" : "plainText";
  }
}

// ── the four shipped commands ───────────────────────────────────────────────
// Each provider's pair is invoked the way ITS CLI invokes it: claude's take argv
// (out dir / control dir + timeout), codex's take the env binding that keeps
// their trusted command strings task-invariant (SONATA_RUNTIME_DIR, plus the
// answering marker that arms the broker at all).
const PROVIDERS = [
  {
    name: "claude",
    sink: sinkJs,
    broker: brokerJs,
    sinkArgv: (outDir) => [outDir],
    sinkEnv: () => ({}),
    brokerFor: (runtimeDir, holdMs) => {
      const controlDir = path.join(runtimeDir, "approvals");
      fs.mkdirSync(controlDir, { recursive: true });
      return { argv: [controlDir, String(holdMs)], env: {}, controlDir };
    },
  },
  {
    name: "codex",
    sink: codexSinkJs,
    broker: codexBrokerJs,
    // The codex sink derives `<runtimeDir>/hooks` itself; argv carries nothing.
    sinkArgv: () => [],
    sinkEnv: (outDir) => ({ SONATA_RUNTIME_DIR: path.dirname(outDir) }),
    brokerFor: (runtimeDir, holdMs) => {
      const controlDir = path.join(runtimeDir, "approvals");
      fs.mkdirSync(controlDir, { recursive: true });
      // Without the marker the shim exits inert (instant native card) — arming it
      // is what puts the hold-and-answer path under test at all.
      fs.writeFileSync(path.join(controlDir, "answering-enabled"), "");
      return {
        argv: [],
        env: { SONATA_RUNTIME_DIR: runtimeDir, SONATA_BROKER_HOLD_MS: String(holdMs) },
        controlDir,
      };
    },
  },
];

// ── A. every sink prints nothing, on every path ─────────────────────────────
for (const provider of PROVIDERS) {
  const notADirectory = path.join(dir(`${provider.name}-enotdir`), "blocked");
  fs.writeFileSync(notADirectory, "not a directory");
  const readOnly = dir(`${provider.name}-eacces`);
  fs.chmodSync(readOnly, 0o500);
  const out = (name) => path.join(dir(`${provider.name}-${name}`), "hooks");

  const cases = [
    ["normal payload", out("ok"), JSON.stringify({ hook_event_name: "Stop", session_id: "s" })],
    ["empty stdin", out("empty"), ""],
    ["whitespace-only stdin", out("ws"), "   \n\t\n "],
    ["malformed stdin", out("bad"), "{not json at all"],
    ["ENOTDIR output path", notADirectory, JSON.stringify({ hook_event_name: "Stop" })],
    ["EACCES output parent", path.join(readOnly, "hooks"), JSON.stringify({ hook_event_name: "Stop" })],
    ["1 MB payload", out("huge"), JSON.stringify({ hook_event_name: "Stop", last_assistant_message: "x".repeat(1_000_000) })],
    ["invalid UTF-8 stdin", out("binary"), Buffer.from([0x7b, 0x22, 0x61, 0x22, 0x3a, 0x22, 0xff, 0xfe, 0x22, 0x7d])],
  ];

  for (const [name, outDir, input] of cases) {
    // No `encoding` — raw Buffers, which is what a BYTE audit needs (and lets
    // `input` be a Buffer for the invalid-UTF-8 case).
    const result = spawnSync(process.execPath, [provider.sink, ...provider.sinkArgv(outDir)], {
      input,
      timeout: 30_000,
      env: { ...process.env, ...provider.sinkEnv(outDir) },
    });
    assert.equal(result.status, 0, `${provider.name} sink exits 0 (${name})`);
    assert.equal(
      result.stdout.length,
      0,
      `${provider.name} sink writes ZERO stdout bytes (${name}) — got ${JSON.stringify(result.stdout.toString("utf8").slice(0, 120))}`,
    );
  }

  // The unbound case is per-provider: claude's sink has no argv, codex's has no
  // SONATA_RUNTIME_DIR. Both must exit 0 in silence.
  const unbound = spawnSync(process.execPath, [provider.sink], {
    input: JSON.stringify({ hook_event_name: "Stop" }),
    timeout: 30_000,
    env: { ...process.env, SONATA_RUNTIME_DIR: "" },
  });
  assert.equal(unbound.status, 0, `${provider.name} sink exits 0 (no task binding)`);
  assert.equal(unbound.stdout.length, 0, `${provider.name} sink writes ZERO stdout bytes (no task binding)`);
}

// ── B/C/D. every broker prints only its answer, and prints it WHOLE ─────────
function runBroker(provider, { runtimeDir, holdMs, payload, reply, killStdout = false }) {
  return new Promise((resolve) => {
    const bound = provider.brokerFor(runtimeDir, holdMs);
    const child = spawn(process.execPath, [provider.broker, ...bound.argv], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, ...bound.env },
    });
    const chunks = [];
    let stderr = "";
    child.stdout.on("data", (d) => chunks.push(d));
    child.stdout.on("error", () => {}); // the D case destroys this stream on purpose
    child.stderr.on("data", (d) => (stderr += d));
    let poller = null;
    if (reply != null) {
      poller = setInterval(() => {
        let asks = [];
        try {
          // Complete files only: the atomic write creates `ask-<id>.json.<pid>.tmp`
          // first, which also starts with "ask-".
          asks = fs.readdirSync(bound.controlDir).filter((n) => /^ask-.+\.json$/.test(n));
        } catch {
          return;
        }
        if (asks.length === 0) return;
        clearInterval(poller);
        poller = null;
        if (killStdout) {
          // Simulate the CLI dying mid-hold: the read end goes away before the
          // answer is written, so the broker's write hits EPIPE.
          try { child.stdout.destroy(); } catch { /* best-effort */ }
        }
        const id = asks[0].replace(/^ask-/, "").replace(/\.json$/, "");
        const replyPath = path.join(bound.controlDir, `reply-${id}.json`);
        fs.writeFileSync(`${replyPath}.tmp`, reply, "utf8");
        fs.renameSync(`${replyPath}.tmp`, replyPath);
      }, 25);
    }
    child.on("close", (status) => {
      if (poller) clearInterval(poller);
      const stdout = Buffer.concat(chunks);
      resolve({ status, stdout: stdout.toString("utf8"), bytes: stdout.length, stderr, controlDir: bound.controlDir });
    });
    child.stdin.end(payload);
  });
}

const allow = JSON.stringify({
  hookSpecificOutput: { hookEventName: "PermissionRequest", decision: { behavior: "allow" } },
});

for (const provider of PROVIDERS) {
  const rt = (name) => dir(`${provider.name}-broker-${name}`);

  // B1 — the silent paths. Each is a real broker exit that must put NOTHING on
  // the decision channel, because "no stdout" is what makes the CLI fall back to
  // its own native panel gracefully.
  const silent = [
    ["AskUserQuestion / inert", { runtimeDir: rt("askuq"), holdMs: 3000, payload: JSON.stringify({ tool_name: "AskUserQuestion" }), reply: null }],
    ["empty stdin, then timeout", { runtimeDir: rt("empty"), holdMs: 1500, payload: "", reply: null }],
    ["malformed stdin, then timeout", { runtimeDir: rt("bad"), holdMs: 1500, payload: "{nope", reply: null }],
    ["timeout with no reply", { runtimeDir: rt("timeout"), holdMs: 1500, payload: JSON.stringify({ tool_name: "Bash" }), reply: null }],
  ];
  for (const [name, spec] of silent) {
    const result = await runBroker(provider, spec);
    assert.equal(result.status, 0, `${provider.name} broker exits 0 (${name})`);
    assert.equal(result.bytes, 0, `${provider.name} broker writes NO stdout (${name}) — got ${JSON.stringify(result.stdout.slice(0, 120))}`);
    assert.equal(result.stderr, "", `${provider.name} broker writes no stderr (${name})`);
  }

  // An unbound broker (no control dir at all) must also exit 0 silently.
  {
    const child = spawnSync(process.execPath, [provider.broker], {
      input: JSON.stringify({ tool_name: "Bash" }),
      timeout: 30_000,
      env: { ...process.env, SONATA_RUNTIME_DIR: "" },
    });
    assert.equal(child.status, 0, `${provider.name} broker exits 0 (no task binding)`);
    assert.equal(child.stdout.length, 0, `${provider.name} broker writes NO stdout (no task binding)`);
  }

  // B2 — an answered ask emits the reply VERBATIM, and that reply is a single
  // complete JSON object by the CLI's own classification.
  {
    const result = await runBroker(provider, {
      runtimeDir: rt("allow"),
      holdMs: 8000,
      payload: JSON.stringify({ tool_name: "Bash", tool_input: { command: "ls" } }),
      reply: allow,
    });
    assert.equal(result.status, 0, `${provider.name} broker exits 0 after answering`);
    assert.equal(result.stdout, allow, `${provider.name} broker emits the reply verbatim`);
    assert.equal(classify(result.stdout), "json", `${provider.name}: the emitted answer is ONE complete JSON object`);
    const leftover = fs.readdirSync(result.controlDir).filter((n) => n.startsWith("ask-"));
    assert.deepEqual(leftover, [], `${provider.name}: ask cleaned up after answering`);
  }

  // C — THE REGRESSION PIN. A decision far larger than a pipe buffer must arrive
  // whole. Pre-SL-9 both brokers returned exactly 65536 bytes (`process.exit(0)`
  // raced the async pipe write) — a silently lost answer, and, had the cut landed
  // on a `}`, the CLI's hard `validationError` path.
  {
    const big = JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PermissionRequest",
        decision: { behavior: "allow", note: "y".repeat(4_000_000) },
      },
    });
    assert.ok(big.length > 1_000_000, "the stress reply is far past any pipe buffer");
    const result = await runBroker(provider, {
      runtimeDir: rt("huge"),
      holdMs: 30_000,
      payload: JSON.stringify({ tool_name: "Bash" }),
      reply: big,
    });
    assert.equal(result.status, 0, `${provider.name} broker exits 0 after a large answer`);
    assert.equal(
      result.bytes,
      big.length,
      `${provider.name}: a ${big.length}-byte decision arrives COMPLETE (got ${result.bytes}; 65536 means the stdout flush regressed)`,
    );
    assert.equal(result.stdout, big, `${provider.name}: the large answer is byte-identical to the reply`);
    assert.equal(classify(result.stdout), "json", `${provider.name}: the large answer is still ONE complete JSON object`);
  }

  // D — a DEAD READ END. The drain fix means the broker no longer exits before
  // its write completes, so a vanished reader now surfaces as an `error` event on
  // stdout. Unhandled that is a crash with stderr noise on a channel the broker
  // promises never to write to; the guard must turn it into a clean exit 0.
  {
    const result = await runBroker(provider, {
      runtimeDir: rt("epipe"),
      holdMs: 8000,
      payload: JSON.stringify({ tool_name: "Bash" }),
      reply: allow,
      killStdout: true,
    });
    assert.equal(result.status, 0, `${provider.name} broker exits 0 when the read end is gone`);
    assert.equal(result.stderr, "", `${provider.name} broker stays silent on stderr when the read end is gone — got ${JSON.stringify(result.stderr.slice(0, 200))}`);
  }
}


// E — the classifier itself is the measured contract, not a guess. These are the
// exact classes the h2 probe's live arms drove through the real CLI; if this
// table ever disagrees with the capture, the capture wins and this smoke is stale.
{
  assert.equal(classify(""), "plainText", "empty output is harmless");
  assert.equal(classify("   \n"), "plainText", "whitespace is harmless");
  assert.equal(classify("hello from a hook"), "plainText", "no leading brace is harmless");
  assert.equal(classify('{"hookSpecificOutput":{"hookEventName":"X"'), "plainText", "an unclosed truncation is harmless");
  assert.equal(classify('{"hookSpecificOutput":{"hookEventName":"X"}'), "HARD", "a truncation ending on } is the hard path");
  assert.equal(classify('{"continue":true}'), "json", "a complete object parses");
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log("hook-stdout-contract: OK");
