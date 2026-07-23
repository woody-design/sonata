// Aggregate smoke runner (consolidation S3) — `npm run smoke`.
//
// Runs EVERY tests/smoke/*.mjs in its own child process (per-test isolation, as
// the individual `smoke:*` scripts do), fail-fast=false: one PASS/FAIL/SKIP line
// per file, a final tally, and a non-zero exit if ANY test FAILs. SKIP and a
// clean run both exit 0 — only a real failure fails the suite.
//
// DOES NOT BUILD. Composability: build first (`npm run build`, or `build:main`
// for the node-only subset), then run this. Running against stale dist is the
// caller's responsibility — the same contract every `smoke:*` script assumes
// once its `npm run build &&` prefix has run.
//
// SKIP convention (exit code 77): a test that cannot meaningfully run in this
// environment exits 77 after printing a single `SKIP: <reason>` line. The
// runner counts it SKIP (not FAIL) and surfaces the reason. Two documented
// classes self-skip today: packaged-* (no packaged app on disk) and
// midsession-codex-* (codex's boot "Update available!" gate blocks readiness).
// 77 is the conventional autotools "skipped test" code — chosen so it can never
// collide with a genuine assertion failure (exit 1) or an uncaught throw.
//
// Interpreter per test: the existing package.json `smoke:*` scripts are the
// single source of truth for HOW each file runs — some need Electron's bundled
// node (native node-pty ABI, or the `electron` module's runtime semantics),
// invoked as `ELECTRON_RUN_AS_NODE=1 electron`; the rest run under plain node.
// This runner derives each file's interpreter from those scripts, so a new test
// that follows the `smoke:*` convention is classified automatically. A smoke
// file with NO script is reported as UNMAPPED (loud drift signal) and run under
// plain node as a best effort.

import { spawn } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const APP_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SMOKE_DIR = join(APP_ROOT, "tests", "smoke");
const ELECTRON_BIN = join(APP_ROOT, "node_modules", ".bin", "electron");
const SKIP_EXIT = 77;
const PER_TEST_TIMEOUT_MS = Number(process.env.SONATA_SMOKE_TIMEOUT_MS ?? 300_000);

// Shared harness modules that live under tests/smoke/ but are NOT standalone
// tests (they export helpers other smokes import). Excluded from the run.
const HELPERS = new Set(["codex-smoke-trust.mjs"]);

/** filename → "electron" | "node", parsed from package.json `smoke:*` scripts. */
function interpreterMap() {
  const pkg = JSON.parse(readFileSync(join(APP_ROOT, "package.json"), "utf8"));
  const map = new Map();
  const re = /(ELECTRON_RUN_AS_NODE=1 electron|node) tests\/smoke\/([\w.-]+\.mjs)/g;
  for (const value of Object.values(pkg.scripts ?? {})) {
    for (const match of value.matchAll(re)) {
      map.set(match[2], match[1].startsWith("ELECTRON") ? "electron" : "node");
    }
  }
  return map;
}

function runOne(file, interpreter) {
  return new Promise((resolvePromise) => {
    const testPath = join(SMOKE_DIR, file);
    const [cmd, args, env] =
      interpreter === "electron"
        ? [ELECTRON_BIN, [testPath], { ...process.env, ELECTRON_RUN_AS_NODE: "1" }]
        : [process.execPath, [testPath], process.env];

    const child = spawn(cmd, args, { cwd: APP_ROOT, env });
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (out += d));

    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, PER_TEST_TIMEOUT_MS);

    child.on("close", (code) => {
      clearTimeout(timer);
      const skipReason = (out.match(/^SKIP:\s*(.*)$/m) ?? [])[1]?.trim();
      let status;
      if (timedOut) {
        status = "FAIL";
      } else if (code === 0) {
        status = "PASS";
      } else if (code === SKIP_EXIT) {
        status = "SKIP";
      } else {
        status = "FAIL";
      }
      resolvePromise({
        file,
        interpreter,
        status,
        code,
        timedOut,
        skipReason,
        output: out,
      });
    });
  });
}

async function main() {
  const map = interpreterMap();
  const files = readdirSync(SMOKE_DIR)
    .filter((f) => f.endsWith(".mjs") && !HELPERS.has(f))
    .sort();

  const results = [];
  const width = Math.max(...files.map((f) => f.length));
  let i = 0;
  for (const file of files) {
    i += 1;
    const mapped = map.get(file);
    const interpreter = mapped ?? "node";
    const result = await runOne(file, interpreter);
    result.unmapped = mapped === undefined;
    results.push(result);

    const counter = `[${String(i).padStart(3)}/${files.length}]`;
    const badge = result.status.padEnd(4);
    const note =
      result.status === "SKIP"
        ? `  — ${result.skipReason ?? "no reason given"}`
        : result.timedOut
          ? `  — TIMED OUT after ${PER_TEST_TIMEOUT_MS}ms`
          : result.status === "FAIL"
            ? `  — exit ${result.code}`
            : "";
    const drift = result.unmapped ? "  [UNMAPPED: no smoke:* script]" : "";
    process.stdout.write(`${counter} ${badge} ${file.padEnd(width)}${drift}${note}\n`);
  }

  const failed = results.filter((r) => r.status === "FAIL");
  const skipped = results.filter((r) => r.status === "SKIP");
  const passed = results.filter((r) => r.status === "PASS");
  const unmapped = results.filter((r) => r.unmapped);

  // Replay each failure's captured output so `npm run smoke` is self-contained.
  if (failed.length > 0) {
    process.stdout.write(`\n${"=".repeat(72)}\nFAILURE DETAIL\n${"=".repeat(72)}\n`);
    for (const f of failed) {
      process.stdout.write(`\n----- ${f.file} (exit ${f.code}${f.timedOut ? ", timed out" : ""}) -----\n`);
      process.stdout.write(`${f.output.trimEnd()}\n`);
    }
  }

  process.stdout.write(`\n${"=".repeat(72)}\nSMOKE SUMMARY\n${"=".repeat(72)}\n`);
  process.stdout.write(
    `total ${results.length}   PASS ${passed.length}   FAIL ${failed.length}   SKIP ${skipped.length}\n`,
  );
  if (skipped.length > 0) {
    process.stdout.write(`\nSKIPPED (${skipped.length}):\n`);
    for (const s of skipped) {
      process.stdout.write(`  ${s.file} — ${s.skipReason ?? "no reason given"}\n`);
    }
  }
  if (failed.length > 0) {
    process.stdout.write(`\nFAILED (${failed.length}):\n`);
    for (const f of failed) {
      process.stdout.write(`  ${f.file}${f.timedOut ? " (timed out)" : ` (exit ${f.code})`}\n`);
    }
  }
  if (unmapped.length > 0) {
    process.stdout.write(
      `\nUNMAPPED (${unmapped.length}) — add a smoke:* script so the interpreter is pinned:\n`,
    );
    for (const u of unmapped) {
      process.stdout.write(`  ${u.file}\n`);
    }
  }

  process.exit(failed.length > 0 ? 1 : 0);
}

main().catch((error) => {
  console.error("run-smoke crashed:", error);
  process.exit(2);
});
