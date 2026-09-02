// Q24 (2026-09 sync, SL-6) — cli-readiness re-verification against the CURRENT
// binaries.
//
// QUESTION: the four probe commands Sonata's readiness subsystem runs
// (`claude --version`, `claude auth status --json`, `codex --version`,
// `codex login status`) are pinned in `main/cli-readiness/probe.ts` as a MEASURED
// table dated 2026-08-05 (claude 2.1.222, codex-cli 0.146.0). Do the current
// binaries still answer in those shapes — same stream, same exit code, same
// phrasing — and does `probeCliReadiness` still classify them the way the table
// claims?
//
// WHY THE REAL CLASSIFIER AND NOT A REPLICA: the verdicts below come from the
// esbuild-bundled production module (`dist/main/cli-readiness/probe`), driven
// over the LIVE command outcomes. A replica would only prove this file agrees
// with itself (the 2026-08 method lesson).
//
// FAIL DIRECTION, checked explicitly: `unknown` is the permissive state and
// `signedOut` is the actionable one. A drift that turns a signed-IN user into
// `signedOut` sends them to a login screen they do not need — that is the
// direction this probe is looking for first.
//
// ARMS (one variable each, all in /private/tmp — never the agent scratchpad,
// whose path embeds the username, because these captures become findings):
//   claude-version      claude --version                       (real HOME)
//   claude-auth         claude auth status --json              (real HOME)
//   claude-auth-fresh   the same under a FRESH HOME            → signed out
//   codex-version       codex --version                        (real CODEX_HOME)
//   codex-login         codex login status                     (real CODEX_HOME)
//   codex-login-fresh   the same under a FRESH CODEX_HOME      → signed out
//   codex-login-broken  the same over a MALFORMED config.toml  → unknown
//
// NOTHING here writes to the user's real ~/.codex or ~/.claude: the fresh arms
// point HOME / CODEX_HOME at scratch dirs.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile, execFileSync } from "node:child_process";
import { createRequire } from "node:module";

const OUT_DIR = new URL(".", import.meta.url).pathname;
const APP_DIR = new URL("../../../app/", import.meta.url).pathname;
const require = createRequire(APP_DIR + "package.json");
const { readClaudeAuth, readCodexAuth, probeCliReadiness } = require(
  APP_DIR + "dist/main/cli-readiness/probe",
);

const EXPECT_CODEX = "0.152.0";
const ROOT = "/private/tmp/sonata-sync-2026-09/cli-readiness";

const HOME = os.homedir();
const USER = os.userInfo().username;
const USER_MUNGED = `-${HOME.replace(/\//g, "-").replace(/^-/, "")}-`;
const sanitize = (value) =>
  value.split(HOME).join("$HOME").split(USER_MUNGED).join("-$USER_MUNGED-").split(USER).join("$USER");

/**
 * Account-identity redaction, applied to a command's RAW streams at capture
 * time — deliberately BEFORE `JSON.stringify`, not after. The signed-in claude
 * document carries an e-mail, an org name and an org UUID; once the document is
 * embedded in a JSON string its quotes arrive escaped (`\"orgId\"`), and a
 * redactor written against the unescaped shape silently matches nothing. That
 * is exactly how a real org id reached a capture on the first run of this probe.
 */
const redact = (value) =>
  value
    .replace(/"email"\s*:\s*"[^"]*"/g, '"email": "[REDACTED-EMAIL]"')
    .replace(/"orgName"\s*:\s*"[^"]*"/g, '"orgName": "[REDACTED-ORG]"')
    .replace(/"orgId"\s*:\s*"[^"]*"/g, '"orgId": "[REDACTED-ORGID]"')
    .replace(/"accountUuid"\s*:\s*"[^"]*"/g, '"accountUuid": "[REDACTED-UUID]"')
    .replace(/\bsk-[A-Za-z0-9_-]{8,}/g, "[REDACTED-KEY]")
    .replace(/eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]+/g, "[REDACTED-JWT]")
    .replace(/[\w.+-]+@[\w-]+\.[\w.]+/g, "[REDACTED-EMAIL]")
    // Belt and suspenders: any bare UUID left in an auth document.
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, "[REDACTED-UUID]");

// Version pins: RECORD drift, save the capture, exit non-zero afterwards (the
// SL-4 method note — an END drift must never discard a completed measurement).
const codexVersion = execFileSync("codex", ["--version"], { encoding: "utf8" }).trim();
const claudeVersion = execFileSync("claude", ["--version"], { encoding: "utf8" }).trim();

/** Run one command and classify its outcome EXACTLY the way probe.ts's
 *  `defaultRunCliCommand` does — same decoding of execFile's error channel, so
 *  the outcome fed to the production readers is the one production would see. */
function run(command, args, env) {
  return new Promise((resolve) => {
    const startedAt = Date.now();
    execFile(command, args, { timeout: 5_000, encoding: "utf8", env }, (error, stdout, stderr) => {
      const elapsedMs = Date.now() - startedAt;
      if (!error) {
        resolve({ kind: "exit", code: 0, stdout, stderr, elapsedMs });
        return;
      }
      if (error.code === "ENOENT") {
        resolve({ kind: "absent", elapsedMs });
        return;
      }
      if (!error.killed && !error.signal && typeof error.code === "number") {
        resolve({ kind: "exit", code: error.code, stdout, stderr, elapsedMs });
        return;
      }
      resolve({ kind: "failed", elapsedMs, killed: error.killed ?? null, signal: error.signal ?? null });
    });
  });
}

const baseEnv = { ...process.env };

fs.rmSync(ROOT, { recursive: true, force: true });
const freshHome = path.join(ROOT, "fresh-home");
const freshCodexHome = path.join(ROOT, "fresh-codex-home");
const brokenCodexHome = path.join(ROOT, "broken-codex-home");
fs.mkdirSync(freshHome, { recursive: true });
fs.mkdirSync(freshCodexHome, { recursive: true });
fs.mkdirSync(brokenCodexHome, { recursive: true });
// The malformed-config arm reproduces the 2026-08 fixture's shape: a key with
// no value on line 1. What the CLI SAYS about it is what this probe measures.
fs.writeFileSync(path.join(brokenCodexHome, "config.toml"), "model\n");

const ARMS = [
  {
    id: "claude-version",
    argv: ["claude", ["--version"]],
    env: baseEnv,
    reader: null,
  },
  {
    id: "claude-auth",
    argv: ["claude", ["auth", "status", "--json"]],
    env: baseEnv,
    reader: "claude",
    expect: "signedIn",
  },
  {
    id: "claude-auth-fresh",
    argv: ["claude", ["auth", "status", "--json"]],
    // A fresh HOME also needs CLAUDE_CONFIG_DIR cleared, else the real config
    // home would be found anyway and the arm would measure nothing.
    env: { ...baseEnv, HOME: freshHome, CLAUDE_CONFIG_DIR: path.join(freshHome, ".claude") },
    reader: "claude",
    expect: "signedOut",
  },
  {
    id: "codex-version",
    argv: ["codex", ["--version"]],
    env: baseEnv,
    reader: null,
  },
  {
    id: "codex-login",
    argv: ["codex", ["login", "status"]],
    env: baseEnv,
    reader: "codex",
    expect: "signedIn",
  },
  {
    id: "codex-login-fresh",
    argv: ["codex", ["login", "status"]],
    env: { ...baseEnv, CODEX_HOME: freshCodexHome },
    reader: "codex",
    expect: "signedOut",
  },
  {
    id: "codex-login-broken",
    argv: ["codex", ["login", "status"]],
    env: { ...baseEnv, CODEX_HOME: brokenCodexHome },
    reader: "codex",
    expect: "unknown",
  },
];

const out = {
  probe: "q24-cli-readiness",
  claudeVersion,
  codexVersion,
  arms: {},
};

for (const arm of ARMS) {
  const [command, args] = arm.argv;
  const outcome = await run(command, args, arm.env);
  const verdict =
    outcome.kind === "exit" && arm.reader
      ? arm.reader === "claude"
        ? readClaudeAuth(outcome)
        : readCodexAuth(outcome)
      : arm.reader
        ? "unknown"
        : null;
  out.arms[arm.id] = {
    command: `${command} ${args.join(" ")}`,
    outcomeKind: outcome.kind,
    exitCode: outcome.code ?? null,
    elapsedMs: outcome.elapsedMs,
    stdout: redact(outcome.stdout ?? ""),
    stderr: redact(outcome.stderr ?? ""),
    stdoutBytes: Buffer.byteLength(outcome.stdout ?? ""),
    stderrBytes: Buffer.byteLength(outcome.stderr ?? ""),
    productionVerdict: verdict,
    expected: arm.expect ?? null,
    agrees: arm.expect ? verdict === arm.expect : null,
  };
}

// The whole-subsystem call, over the real binaries and the real environment —
// what a launch-trigger probe would learn on this machine right now.
out.probeCliReadiness = await probeCliReadiness();

const drift = [];
if (!codexVersion.includes(EXPECT_CODEX)) drift.push(`codex moved off ${EXPECT_CODEX}: ${codexVersion}`);

out.versionDrift = drift;
out.allArmsAgree = Object.values(out.arms).every((arm) => arm.agrees !== false);

const outPath = path.join(OUT_DIR, "q24-cli-readiness.capture.txt");
fs.writeFileSync(outPath, sanitize(JSON.stringify(out, null, 2)));
console.log(
  sanitize(
    JSON.stringify(
      {
        claudeVersion,
        codexVersion,
        versionDrift: drift,
        allArmsAgree: out.allArmsAgree,
        arms: Object.fromEntries(
          Object.entries(out.arms).map(([id, arm]) => [
            id,
            {
              exitCode: arm.exitCode,
              stream: arm.stdoutBytes > 0 ? (arm.stderrBytes > 0 ? "both" : "stdout") : arm.stderrBytes > 0 ? "stderr" : "none",
              stdout: arm.stdout.slice(0, 300),
              stderr: arm.stderr.slice(0, 300),
              productionVerdict: arm.productionVerdict,
              expected: arm.expected,
              agrees: arm.agrees,
              elapsedMs: arm.elapsedMs,
            },
          ]),
        ),
        probeCliReadiness: out.probeCliReadiness,
      },
      null,
      2,
    ),
  ),
);
console.log(`\nwrote ${outPath}`);
process.exit(out.allArmsAgree && drift.length === 0 ? 0 : 1);
