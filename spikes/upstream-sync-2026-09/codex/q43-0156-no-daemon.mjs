// Q43 (2026-09-23, Subtraction X3) — does codex 0.156.1 accept `--no-daemon`
// on Sonata's production spawn, and does the boot look the same with it?
//
// `codexArgs` now emits `--no-daemon` unconditionally (beside `--no-alt-screen`).
// The flag is MEASURED present in `codex --help` and `codex resume --help` at
// 0.156.1; this probe is the live half: one boot per spawn shape through the
// PRODUCTION TerminalHost out of `app/dist/runtime` (rebuilt from the X3 tree).
//
//   A — hooked production shape (`codexHookPaths` → `-p sonata` +
//       `--dangerously-bypass-hook-trust`), pretrusted, gpt-6-astra / high.
//   B — degraded HOOKLESS shape (no `codexHookPaths` → no `-p`, no bypass), the
//       spawn the flag matters most for. Trust is seeded in the isolated
//       `config.toml` instead, so the boot reaches the composer.
//   C — CONTROL: arm A's exact argv MINUS `--no-daemon`, same home + cwd (the
//       profile A wrote is reused). The footer / warning count of A vs C is the
//       "changed footer?" answer.
//
// Per arm: argv, `acceptsPromptInput()` + ms to ready, pty alive, any error /
// usage line on grid or stream, the idle footer (`<Model> <effort> · <cwd>` +
// the `⚠ N warning(s)` tail), and whether the embedded-mode warning
// (`Running without the shared background server …`) painted. Zero prompts are
// sent. Daemon state is recorded first (`codex app-server daemon version`,
// read-only: it only connects to the control socket).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { CodexBoot, codexVersion, sanitize, seedCodexHome, sleep, writeCapture } from "./driver.mjs";

const EXPECT = "0.156.1";
const OUT_DIR = new URL(".", import.meta.url).pathname;
const ROOT = "/private/tmp/sonata-codex-0156-no-daemon";
const v = codexVersion();
if (!v.includes(EXPECT)) {
  console.log("wrong version " + v);
  process.exit(2);
}
fs.rmSync(ROOT, { recursive: true, force: true });
const out = { probe: "q43-no-daemon", version: v, arms: {} };

try {
  out.daemonBefore = execFileSync("codex", ["app-server", "daemon", "version"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 20_000,
  }).trim();
} catch (error) {
  out.daemonBefore = String(error?.stderr ?? error?.message ?? error).trim().split("\n")[0];
}

const ERROR_RE = /\berror\b|unexpected argument|unrecognized|Usage: codex|invalid value/i;
const grid = (b) => b.screen().split("\n").filter((l) => l.trim());
const cleanStream = (b) =>
  b.raw.replace(/\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07]*(?:\x07|\x1b\\)|\x1b[@-_]/g, "");

function armDirs(label) {
  const armRoot = path.join(ROOT, label);
  const workspace = path.join(armRoot, "cwd");
  const runtimeDir = path.join(armRoot, "runtime");
  fs.mkdirSync(workspace, { recursive: true });
  fs.mkdirSync(runtimeDir, { recursive: true });
  fs.writeFileSync(path.join(workspace, "README.md"), `${label}\n`);
  return { armRoot, workspace, runtimeDir };
}

async function measure(boot, arm) {
  arm.readyAtMs = await boot.waitUntil((b) => b.ready(), 60_000, 100);
  // Let the footer + any late warning line settle before reading.
  await sleep(2500);
  arm.ready = boot.ready();
  arm.ptyExited = boot.ptyExited;
  arm.exitInfo = boot.exitInfo;
  const lines = grid(boot);
  arm.grid = lines;
  arm.footer = lines.filter((l) => /·/.test(l) && /(high|medium|low|xhigh|default)\b/i.test(l)).slice(-1)[0] ?? null;
  arm.warningTail = (lines.join("\n").match(/⚠\s*\d+\s*warnings?[^\n]*/g) ?? []).slice(-1)[0] ?? null;
  arm.errorLinesGrid = lines.filter((l) => ERROR_RE.test(l));
  arm.errorLinesStream = cleanStream(boot)
    .split("\n")
    .filter((l) => ERROR_RE.test(l))
    .slice(0, 10);
  arm.embeddedWarning = /Running without the shared background server/i.test(cleanStream(boot));
  arm.events = boot.events.slice(-8);
}

// A — hooked production shape.
const A = armDirs("A");
const homeA = seedCodexHome(path.join(A.armRoot, "codex-home"), { withAuth: true });
{
  const arm = { arm: "A-hooked-production" };
  const boot = new CodexBoot({
    taskId: "task-q43-A",
    cwd: A.workspace,
    runtimeDir: A.runtimeDir,
    binDir: path.join(os.homedir(), ".sonata", "bin"),
    pretrustCwd: A.workspace,
    codexHome: homeA,
    rows: 40,
    cols: 120,
    approvalBroker: true,
  });
  boot.startOptions.model = "gpt-6-astra";
  boot.startOptions.reasoningEffort = "high";
  try {
    await boot.start();
    arm.args = boot.spawnedArgs;
    arm.hasNoDaemon = Array.isArray(arm.args) && arm.args.includes("--no-daemon");
    await measure(boot, arm);
  } catch (error) {
    arm.fatal = String(error?.stack ?? error);
  } finally {
    boot.dispose();
    await sleep(500);
  }
  out.arms.A = arm;
}

// B — degraded hookless shape (no codexHookPaths). Trust seeded in config.toml.
{
  const arm = { arm: "B-hookless" };
  const B = armDirs("B");
  const homeB = seedCodexHome(path.join(B.armRoot, "codex-home"), { withAuth: true });
  fs.writeFileSync(
    path.join(homeB, "config.toml"),
    `[projects."${B.workspace}"]\ntrust_level = "trusted"\n`,
  );
  const boot = new CodexBoot({
    taskId: "task-q43-B",
    cwd: B.workspace,
    runtimeDir: B.runtimeDir,
    binDir: path.join(os.homedir(), ".sonata", "bin"),
    codexHome: homeB,
    rows: 40,
    cols: 120,
    approvalBroker: false,
  });
  delete boot.startOptions.codexHookPaths;
  boot.startOptions.model = "gpt-6-astra";
  boot.startOptions.reasoningEffort = "high";
  try {
    await boot.start();
    arm.args = boot.spawnedArgs;
    arm.hasNoDaemon = Array.isArray(arm.args) && arm.args.includes("--no-daemon");
    arm.hasProfile = Array.isArray(arm.args) && arm.args.includes("-p");
    await measure(boot, arm);
  } catch (error) {
    arm.fatal = String(error?.stack ?? error);
  } finally {
    boot.dispose();
    await sleep(500);
  }
  out.arms.B = arm;
}

// C — control: A's argv minus `--no-daemon`, same home + cwd.
{
  const arm = { arm: "C-control-without-flag" };
  const argsA = out.arms.A.args;
  if (!Array.isArray(argsA)) {
    arm.skipped = "arm A produced no argv";
  } else {
    const C = { runtimeDir: path.join(ROOT, "C", "runtime") };
    fs.mkdirSync(C.runtimeDir, { recursive: true });
    const boot = new CodexBoot({
      taskId: "task-q43-C",
      cwd: A.workspace,
      runtimeDir: C.runtimeDir,
      binDir: path.join(os.homedir(), ".sonata", "bin"),
      pretrustCwd: A.workspace,
      codexHome: homeA,
      rows: 40,
      cols: 120,
      approvalBroker: true,
    });
    boot.startOptions.args = argsA.filter((token) => token !== "--no-daemon");
    try {
      await boot.start();
      arm.args = boot.spawnedArgs ?? boot.startOptions.args;
      arm.hasNoDaemon = arm.args.includes("--no-daemon");
      await measure(boot, arm);
    } catch (error) {
      arm.fatal = String(error?.stack ?? error);
    } finally {
      boot.dispose();
      await sleep(500);
    }
  }
  out.arms.C = arm;
}

// Verdict inputs — the footer with the cwd masked, so A and C compare on shape.
const footerShape = (arm) =>
  arm?.footer ? arm.footer.replace(/\/\S+/g, "<cwd>").replace(/\s+/g, " ").trim() : null;
out.verdict = {
  A_accepts_flag: Boolean(out.arms.A.hasNoDaemon && out.arms.A.ready && !out.arms.A.ptyExited),
  B_accepts_flag: Boolean(out.arms.B.hasNoDaemon && out.arms.B.ready && !out.arms.B.ptyExited),
  errorLines: {
    A: (out.arms.A.errorLinesGrid ?? []).length + (out.arms.A.errorLinesStream ?? []).length,
    B: (out.arms.B.errorLinesGrid ?? []).length + (out.arms.B.errorLinesStream ?? []).length,
    C: (out.arms.C.errorLinesGrid ?? []).length + (out.arms.C.errorLinesStream ?? []).length,
  },
  footerShape: { A: footerShape(out.arms.A), B: footerShape(out.arms.B), C: footerShape(out.arms.C) },
  footerA_equals_control: footerShape(out.arms.A) === footerShape(out.arms.C),
  embeddedWarning: {
    A: out.arms.A.embeddedWarning,
    B: out.arms.B.embeddedWarning,
    C: out.arms.C.embeddedWarning,
  },
};
out.endVersion = codexVersion();
const p = writeCapture(OUT_DIR, "q43-0156-no-daemon.capture.txt", out);
console.log(sanitize(JSON.stringify(out.verdict, null, 2)));
console.log("capture: " + sanitize(p));
