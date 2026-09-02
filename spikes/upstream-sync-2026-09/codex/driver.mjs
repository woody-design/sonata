// Upstream-sync 2026-09 CODEX driver — the shared rig for SL-6's boot/trust
// probes (q20–q23).
//
// It differs from the 2026-08 codex driver on ONE axis, and that axis is the
// slice's whole question: the 2026-08 rig spawned the `codex` binary DIRECTLY
// under node-pty, which can measure the CLI's screen but cannot measure
// SONATA'S readiness. Boot ceremony is a question about Sonata — "can a
// delivery's Enter reach an interstitial?" — and `acceptsPromptInput()` is
// where that is decided, so every arm here drives the PRODUCTION `TerminalHost`
// out of `dist/runtime` with the production `codexArgs` shape (`-p sonata`,
// `--dangerously-bypass-hook-trust`, `--no-alt-screen`, `-C`, `-s`, `-a`,
// `-c approvals_reviewer=…`) and the real hook-profile write.
//
// ISOLATION. `CODEX_HOME` has to be set on BOTH sides: the CHILD reads it to
// find its config + the `sonata` profile, and so does `codexProfilePath()`,
// which runs in THIS process when `buildArgs` writes the profile. Setting only
// the child's (via `extraEnv`) would write Sonata's profile into the user's real
// `~/.codex` and then hand the child a home that has no `sonata` profile at all.
// `withCodexHome()` sets both and restores the parent's afterwards.
//
// SANITIZATION. Captures become findings and the pre-push leak fence scans blob
// CONTENT: every logged byte goes through `sanitize()`, which masks $HOME, the
// munged `-Users-<user>-` form used by runtime dirs, the bare username, and the
// credential shapes an isolated-but-seeded auth.json could echo.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";

const APP_DIR = new URL("../../../app/", import.meta.url).pathname;
const require = createRequire(APP_DIR + "package.json");
const { Terminal } = require("@xterm/headless");

export const runtime = require(APP_DIR + "dist/runtime");
export const { TerminalHost, detectIdlePromptForProvider, isCodexTrustDialog, codexArgs } = runtime;

/**
 * The version this slice is pinned to. Every probe checks it at START and again
 * at END; an END drift RECORDS itself and still saves the capture (the SL-4
 * method note — a mid-run auto-update must not throw away a completed
 * measurement).
 *
 * DRIFT, 2026-09-01 mid-slice: the homebrew cask auto-updated **0.152.0 →
 * 0.152.1** between the measurement probes (q20–q25) and the fix-verification
 * ones (q26 and the q25 re-runs). The pin FIRED, which is what it is for. The
 * pin is re-stamped to 0.152.1 here rather than widened to a patch-series
 * prefix: widening it would trade the one mechanism that catches this for the
 * convenience of not having to say so. Which capture was taken at which version
 * is recorded per-probe (`version` at start, `endVersion` at end) and summarised
 * in findings C12.
 */
export const EXPECT_CODEX_VERSION = "0.152.1";

export function codexVersion() {
  return execFileSync("codex", ["--version"], { encoding: "utf8" }).trim();
}

export function assertCodexVersion(label) {
  const version = codexVersion();
  if (!version.includes(EXPECT_CODEX_VERSION)) {
    throw new Error(`codex binary drifted off ${EXPECT_CODEX_VERSION} at ${label}: ${version}`);
  }
  return version;
}

const HOME = os.homedir();
const USER = os.userInfo().username;
const USER_MUNGED = `-${HOME.replace(/\//g, "-").replace(/^-/, "")}-`;

const CREDENTIAL_MASKS = [
  [/eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]+/g, "[REDACTED-JWT]"],
  [/\bsk-[A-Za-z0-9_-]{16,}/g, "[REDACTED-KEY]"],
  [/\b(access_token|id_token|refresh_token|api_key|OPENAI_API_KEY)\b\s*[:=]\s*\S+/gi, "$1=[REDACTED]"],
  [/[\w.+-]+@[\w-]+\.[\w.]+/g, "[REDACTED-EMAIL]"],
];

export function sanitize(value) {
  let out = String(value)
    .split(HOME)
    .join("$HOME")
    .split(USER_MUNGED)
    .join("-$USER_MUNGED-")
    .split(USER)
    .join("$USER");
  for (const [re, to] of CREDENTIAL_MASKS) out = out.replace(re, to);
  // Belt and suspenders: any /Users/<name> the child prints, whatever its source.
  return out.replace(/\/Users\/[A-Za-z][\w.-]*/g, "$HOME");
}

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Run `body` with CODEX_HOME pointed at `codexHome` in THIS process (see the
 * isolation note above), restoring the previous value afterwards. `null` means
 * "use the real one" and is a no-op.
 */
export async function withCodexHome(codexHome, body) {
  if (!codexHome) return body();
  const previous = process.env.CODEX_HOME;
  process.env.CODEX_HOME = codexHome;
  try {
    return await body();
  } finally {
    if (previous === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = previous;
  }
}

/**
 * Seed an isolated CODEX_HOME from the user's real one, copying ONLY what a
 * boot needs to reach a composer: the credentials. The user's `config.toml` is
 * deliberately NOT copied — it carries their own `[projects.*]` trust ledger,
 * which is the exact variable a trust-trigger arm is trying to control. Returns
 * the seeded dir.
 */
export function seedCodexHome(target, { withAuth = true } = {}) {
  fs.rmSync(target, { recursive: true, force: true });
  fs.mkdirSync(target, { recursive: true });
  if (withAuth) {
    const real = process.env.CODEX_HOME?.trim() || path.join(HOME, ".codex");
    for (const name of ["auth.json"]) {
      const source = path.join(real, name);
      if (fs.existsSync(source)) fs.copyFileSync(source, path.join(target, name));
    }
  }
  return target;
}

/**
 * One codex spawn through the production TerminalHost, with an xterm mirror of
 * the stream so a probe can ask STATE questions of the rendered grid (D-1) and
 * EVENT questions of the raw tail.
 */
export class CodexBoot {
  constructor({
    taskId,
    cwd,
    runtimeDir,
    binDir,
    pretrustCwd = null,
    codexHome = null,
    codexPermissionMode = "ask-for-approval",
    rows = 40,
    cols = 120,
    approvalBroker = true,
    extraEnv = {},
    suppressUpdatePrompt = false,
  }) {
    this.cwd = cwd;
    this.codexHome = codexHome;
    this.rows = rows;
    this.cols = cols;
    this.term = new Terminal({ cols, rows, allowProposedApi: true, scrollback: 4000 });
    this.raw = "";
    this.events = [];
    this.ptyExited = false;
    this.exitInfo = null;
    this.t0 = Date.now();
    this.spawnedArgs = null;
    this.startOptions = {
      taskId,
      cwd,
      runtimeDir,
      codexHookPaths: { binDir, pretrustCwd },
      codexPermissionMode,
      codexSuppressUpdatePrompt: suppressUpdatePrompt,
      approvalBroker,
      rows,
      cols,
      extraEnv: {
        SONATA_RUNTIME_DIR: runtimeDir,
        SONATA_NODE: process.execPath,
        ...(codexHome ? { CODEX_HOME: codexHome } : {}),
        ...extraEnv,
      },
    };
    this.host = new TerminalHost({
      taskId,
      provider: "codex",
      defaultWorkspace: cwd,
      eventSink: (event) => {
        if (event.type === "pty:data") {
          this.raw += event.payload.data;
          this.term.write(event.payload.data);
          return;
        }
        if (event.type === "report:updated") return;
        if (event.type === "pty:exit") {
          this.ptyExited = true;
          this.exitInfo = event.payload;
        }
        this.events.push({ atMs: this.at(), type: event.type, payload: compactPayload(event) });
      },
    });
  }

  at() {
    return Date.now() - this.t0;
  }

  /** Spawn. Wrapped in `withCodexHome` so the profile write in `buildArgs`
   *  lands in the SAME home the child will read. */
  async start() {
    this.t0 = Date.now();
    return withCodexHome(this.codexHome, () => {
      const started = this.host.startTask(this.startOptions);
      this.spawnedArgs = started?.args ?? null;
      return started;
    });
  }

  /** The rendered viewport, trailing blank lines trimmed — the channel a STATE
   *  question belongs on. */
  screen() {
    const buffer = this.term.buffer.active;
    const lines = [];
    for (let y = 0; y < this.term.rows; y += 1) {
      const line = buffer.getLine(buffer.viewportY + y);
      lines.push(line ? line.translateToString(true) : "");
    }
    while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
    return lines.join("\n");
  }

  /** Full scrollback — for anything that scrolled off under `--no-alt-screen`. */
  scrollback() {
    const buffer = this.term.buffer.active;
    const lines = [];
    for (let y = 0; y < buffer.length; y += 1) {
      const line = buffer.getLine(y);
      lines.push(line ? line.translateToString(true) : "");
    }
    return lines.join("\n").replace(/\n{3,}/g, "\n\n");
  }

  ready() {
    return this.host.acceptsPromptInput();
  }

  /** Poll `predicate(this)` until it holds or the budget runs out. Returns the
   *  elapsed ms on success and `null` on timeout — never throws, so a probe can
   *  RECORD a timeout as a measurement instead of dying on it. */
  async waitUntil(predicate, timeoutMs = 60_000, everyMs = 120) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (this.ptyExited) return predicate(this) ? this.at() : null;
      if (predicate(this)) return this.at();
      await sleep(everyMs);
    }
    return null;
  }

  dispose() {
    try {
      this.host.dispose();
    } catch {
      // teardown is best-effort; a probe must still write its capture
    }
  }
}

function compactPayload(event) {
  const payload = event.payload ?? {};
  const keep = {};
  for (const key of [
    "kind",
    "decision",
    "encodedAs",
    "previousKind",
    "reason",
    "exitCode",
    "signal",
    "sonataInitiated",
    "source",
    "confidence",
  ]) {
    if (payload[key] !== undefined) keep[key] = payload[key];
  }
  return keep;
}

/** `cleanTerminal` + whitespace-strip, replicated from
 *  `tui-parsers-common.ts` — the form the codex `bootDialogHints` needles and
 *  `isCodexTrustDialog` are matched against, so a string captured here is
 *  directly comparable to a production needle. */
const ANSI_RE = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07]*(?:\x07|\x1b\\)|\x1b[@-_]/g;
const CONTROL_RE = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g;
export const cleanTerminal = (text) =>
  text.replace(ANSI_RE, "").replace(/\r\n/g, "\n").replace(/\r/g, "\n").replace(CONTROL_RE, "");
export const compact = (text) => cleanTerminal(text).replace(/\s+/g, "");

export function writeCapture(outDir, name, payload) {
  const outPath = path.join(outDir, name);
  fs.writeFileSync(outPath, sanitize(JSON.stringify(payload, null, 2)));
  return outPath;
}
