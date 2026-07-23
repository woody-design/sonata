// M1 gate assertion — inspect the SIGNED, PACKAGED Sonata.app.
//
// Unlike the other smokes this one does NOT build anything; it asserts against
// the artifact produced by `npm run package`. Run that first. Override the app
// path with SONATA_PACKAGED_APP if it lives elsewhere.
//
// It verifies the three things that make the packaged app actually work and be
// trusted by the OS:
//   1. node-pty's spawn-helper is unpacked AND still executable (the exec bit
//      must survive both packaging and re-signing — this repo has lost it
//      before);
//   2. the three external-node sink scripts are unpacked on real disk;
//   3. the .app is signed with the pinned Developer ID and runs hardened.

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const EXPECTED_IDENTITY = "Developer ID Application: Yuhui Li (NW3373QK97)";

const defaultApp = path.resolve(
  path.dirname(new URL(import.meta.url).pathname),
  "../../release/mac-arm64/Sonata.app",
);
const appPath = process.env.SONATA_PACKAGED_APP
  ? path.resolve(process.env.SONATA_PACKAGED_APP)
  : defaultApp;

// Environmental SKIP (exit 77 — the aggregate runner's SKIP convention): this
// smoke asserts against a packaged artifact it does NOT build. Absent one, it is
// not applicable rather than failing — `npm run package` produces it.
if (!fs.existsSync(appPath)) {
  console.log(`SKIP: packaged app absent — run \`npm run package\` first (${appPath})`);
  process.exit(77);
}

const unpacked = path.join(appPath, "Contents", "Resources", "app.asar.unpacked");
assert.ok(fs.existsSync(unpacked), `app.asar.unpacked exists: ${unpacked}`);

// ── 1) node-pty spawn-helper: present + executable ───────────────────────────
const spawnHelper = path.join(
  unpacked,
  "node_modules",
  "node-pty",
  "build",
  "Release",
  "spawn-helper",
);
assert.ok(fs.existsSync(spawnHelper), `spawn-helper unpacked: ${spawnHelper}`);
const helperMode = fs.statSync(spawnHelper).mode;
const helperExecutable = (helperMode & 0o111) !== 0;
assert.ok(helperExecutable, `spawn-helper retains its exec bit (mode ${(helperMode & 0o777).toString(8)})`);

const ptyNode = path.join(unpacked, "node_modules", "node-pty", "build", "Release", "pty.node");
assert.ok(fs.existsSync(ptyNode), `pty.node unpacked: ${ptyNode}`);

// ── 2) the three external-node sink scripts are unpacked ─────────────────────
const sinks = [
  path.join(unpacked, "dist", "runtime", "cli-signal", "hook-sink.js"),
  path.join(unpacked, "dist", "runtime", "cli-signal", "approval-broker.js"),
  path.join(unpacked, "dist", "runtime", "usage", "claude-statusline-sink.js"),
];
for (const sink of sinks) {
  assert.ok(fs.existsSync(sink), `sink script unpacked: ${sink}`);
}

// ── 3) signature: pinned Developer ID + hardened runtime ─────────────────────
const codesign = spawnSync("codesign", ["-dv", "--verbose=4", appPath], { encoding: "utf8" });
// codesign writes its detail to stderr.
const codesignOut = `${codesign.stdout ?? ""}${codesign.stderr ?? ""}`;
assert.equal(codesign.status, 0, `codesign -dv succeeds:\n${codesignOut}`);
assert.ok(
  codesignOut.includes(`Authority=${EXPECTED_IDENTITY}`),
  `signed with the pinned Developer ID:\n${codesignOut}`,
);
assert.ok(/flags=.*runtime/i.test(codesignOut), `hardened runtime flag set:\n${codesignOut}`);

// Deep signature verification (walks nested Mach-O binaries incl. spawn-helper).
const verify = spawnSync(
  "codesign",
  ["--verify", "--deep", "--strict", "--verbose=2", appPath],
  { encoding: "utf8" },
);
const verifyOut = `${verify.stdout ?? ""}${verify.stderr ?? ""}`;
assert.equal(verify.status, 0, `deep signature verification passes:\n${verifyOut}`);

const authorityLine = codesignOut
  .split("\n")
  .find((line) => line.startsWith("Authority="));

console.log(
  JSON.stringify(
    {
      success: true,
      appPath,
      spawnHelperMode: (helperMode & 0o777).toString(8),
      spawnHelperExecutable: helperExecutable,
      sinksUnpacked: sinks.length,
      authority: authorityLine,
      deepVerify: "pass",
    },
    null,
    2,
  ),
);
process.exitCode = 0;
