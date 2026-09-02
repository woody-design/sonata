// Q32 (2026-09 sync, SL-15) — is there an interrupt key that is NOT quit-capable?
//
// WHY. q31 measured Ctrl+C to be `fixed.interrupt_or_quit` in the literal sense:
// mid-turn it interrupts, at an idle EMPTY composer it QUITS the CLI outright
// (exit 0, no confirmation). SL-15 ships a structural guard — the key is written
// only while Sonata's own run pointer says a turn is live — but that guard has a
// residual it cannot close: if a `Stop` hook is ever DROPPED, Sonata believes a
// turn is live while codex sits idle, and that is precisely the moment a user
// presses stop (the UI looks wedged). One press then quits the session.
//
// 0.152.1 ships a CONFIGURABLE keymap in which `chat.interrupt_turn` is a named,
// rebindable action — scoped to `chat`, i.e. to a running turn — beside the
// unrebindable `fixed.interrupt_or_quit`. If Sonata can bind that action to a key
// of its own, the interrupt stops being state-dependent and the residual
// disappears at the root instead of being guarded around.
//
// The question is therefore in three parts, and all three have to be YES for the
// option to be worth putting in front of a decision:
//   1. does `tui.keymap.chat.interrupt_turn` load from Sonata's own PROFILE
//      (`$CODEX_HOME/sonata.config.toml`, layered by `-p sonata`)? A root-config
//      binding would mean mutating the user's own keymap for every codex session
//      they run, Sonata-launched or not — which this program does not do.
//   2. does the bound key actually interrupt a live turn (and fire `Interrupt`)?
//   3. is it INERT at an idle empty composer — the cell where Ctrl+C quits?
//
// REPORTED, NOT ADOPTED. SL-15's brief reserves an alternative interrupt channel
// for a decision rather than a unilateral adoption, so this probe measures and
// stops. Nothing here changes production.
//
// SAFETY. Isolated CODEX_HOME under /private/tmp, seeded with credentials only.
// The user's real `~/.codex` is never read for config nor written.
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import {
  CodexBoot,
  EXPECT_CODEX_VERSION,
  assertCodexVersion,
  codexVersion,
  runtime,
  seedCodexHome,
  sanitize,
  sleep,
} from "./driver.mjs";

const OUT_DIR = new URL(".", import.meta.url).pathname;
const APP_DIR = new URL("../../../app/", import.meta.url).pathname;
const require = createRequire(APP_DIR + "package.json");
const { HookWatcher, codexHooksDirectory } = runtime;

const ROOT = "/private/tmp/sonata-sync-2026-09/codex-keymap-rebind";
const CTRL_C = "\x03";
/**
 * The candidate binding, overridable per run (`KEY=alt-i BYTE=$'\\x1bi' node …`).
 *
 * The first candidate, `ctrl-b`, was REJECTED by codex — and the rejection is
 * itself a headline finding, so it is recorded here rather than quietly replaced:
 * a binding that collides with ANY default is not a warning but a hard
 * `exit(1)` at boot ("Ambiguous `tui.keymap.main` bindings: `chat.interrupt_turn`
 * shadows `editor.move_left` with the same key. … Fix the config and retry."),
 * i.e. an unlaunchable CLI. `ctrl-b` is `editor.move_left`, emacs-style, which
 * the default map has claimed all along.
 */
const REBIND_KEY = process.env.KEY ?? "alt-i";
const REBIND_BYTE = process.env.BYTE ?? "\x1bi";

assertCodexVersion("probe start");
const version = codexVersion();

/** Append the keymap override to the profile Sonata itself just wrote — the same
 *  seam h3 used for its census injection, for the same reason: anything else
 *  would be measuring a different spawn than production's. */
function installKeymapInjection() {
  const module = require(APP_DIR + "dist/runtime/providers/codex/codex-runtime-settings.js");
  const original = module.ensureCodexRuntimeSettings;
  const { codexProfilePath } = module;
  let block = null;
  module.ensureCodexRuntimeSettings = (paths) => {
    const result = original(paths);
    if (!block) return result;
    const profilePath = codexProfilePath();
    fs.appendFileSync(profilePath, block, "utf8");
    return result;
  };
  return (next) => {
    block = next;
  };
}
const setKeymapBlock = installKeymapInjection();

class Arm {
  constructor(name, keymapBlock) {
    this.name = name;
    this.hooks = [];
    this.notes = [];
    const runRoot = path.join(ROOT, name);
    fs.rmSync(runRoot, { recursive: true, force: true });
    this.workspace = path.join(runRoot, "ws");
    this.runtimeDir = path.join(runRoot, "runtime");
    this.binDir = path.join(runRoot, "bin");
    this.codexHome = seedCodexHome(path.join(runRoot, "codex-home"));
    for (const dir of [this.workspace, this.runtimeDir, this.binDir]) fs.mkdirSync(dir, { recursive: true });
    setKeymapBlock(keymapBlock);

    this.boot = new CodexBoot({
      taskId: `task-q32-${name}`,
      cwd: this.workspace,
      runtimeDir: this.runtimeDir,
      binDir: this.binDir,
      pretrustCwd: this.workspace,
      codexHome: this.codexHome,
      rows: 40,
      cols: 120,
      approvalBroker: false,
      // codex logs its config-load verdict here; a rejected keymap key is a
      // config-load ERROR at this binary (C19: an unknown handler type is a hard
      // failure, not a skip), so the log is where a silent rejection would show.
      extraEnv: { RUST_LOG: "codex_core=info,codex_tui=info,info" },
    });
    this.watcher = new HookWatcher({
      sinkDir: codexHooksDirectory,
      pollMs: 100,
      onPayload: (payload) => {
        const event = typeof payload.hook_event_name === "string" ? payload.hook_event_name : "<none>";
        this.hooks.push({ atMs: this.boot.at(), event });
        const host = this.boot.host;
        if (event === "SessionStart") host.noteHookSessionStart();
        if (event === "UserPromptSubmit") host.beginRunFromHook(String(payload.prompt ?? ""), { promptId: null });
        if (event === "Stop" || event === "Interrupt") host.completeRunFromTurnEnd();
      },
      onError: () => {},
    });
  }

  async start() {
    await this.boot.start();
    this.watcher.watchWorkspace(this.runtimeDir);
    this.profile = fs.readFileSync(path.join(this.codexHome, "sonata.config.toml"), "utf8");
    const ready = await this.boot.waitUntil((b) => b.ready(), 90_000);
    this.notes.push(`ready=${ready !== null} at ${ready ?? "TIMEOUT"}ms`);
    return ready !== null;
  }

  async submitAndConfirm(text, { timeoutMs = 120_000 } = {}) {
    if (this.boot.ptyExited) return { ok: false, retries: 0, ptyDead: true };
    const before = this.hooks.length;
    const submitted = () => this.hooks.slice(before).some((h) => h.event === "UserPromptSubmit");
    try {
      this.boot.host.submitPrompt(text);
    } catch (error) {
      this.notes.push(`submit threw: ${error.message}`);
      return { ok: false, retries: 0, ptyDead: this.boot.ptyExited };
    }
    const deadline = Date.now() + timeoutMs;
    let retries = 0;
    while (Date.now() < deadline && !this.boot.ptyExited) {
      if (submitted()) return { ok: true, retries };
      await sleep(2000);
      if (submitted()) return { ok: true, retries };
      if (!this.boot.screen().includes(text.slice(0, 40))) continue;
      retries += 1;
      try {
        this.boot.host.writeRaw(retries % 2 === 1 ? "\r" : "\x1b[13u");
      } catch {
        break;
      }
    }
    return { ok: submitted(), retries };
  }

  async warmUp(text = "Reply with exactly: OK") {
    const before = this.hooks.length;
    const submit = await this.submitAndConfirm(text);
    if (!submit.ok) return false;
    const closed = await this.boot.waitUntil(() => this.hooks.slice(before).some((h) => h.event === "Stop"), 180_000);
    this.notes.push(`warm-up closed=${closed !== null} at ${closed ?? "TIMEOUT"}ms`);
    return closed !== null;
  }

  /** Whatever codex logged while loading config — where a rejected keymap value
   *  would surface if it does not surface on screen. */
  configLogLines() {
    const logDir = path.join(this.codexHome, "log");
    const out = [];
    let files = [];
    try {
      files = fs.readdirSync(logDir);
    } catch {
      return ["<no log dir>"];
    }
    for (const file of files) {
      let text = "";
      try {
        text = fs.readFileSync(path.join(logDir, file), "utf8");
      } catch {
        continue;
      }
      for (const line of text.split("\n")) {
        if (/keymap|keybinding|config|profile/i.test(line)) out.push(sanitize(line.trim()).slice(0, 300));
      }
    }
    return out.slice(0, 40);
  }

  finish(extra = {}) {
    const out = {
      arm: this.name,
      version,
      profileTail: sanitize(this.profile?.split("\n").slice(-8).join("\n") ?? "<unread>"),
      hookOrder: this.hooks.map((h) => `${h.event}@${h.atMs}`),
      configLog: this.configLogLines(),
      screenTail: sanitize(this.boot.screen().split("\n").slice(-14).join("\n")),
      scrollback: sanitize(this.boot.scrollback().split("\n").filter((l) => l.trim()).slice(-40).join("\n")),
      ptyExited: this.boot.ptyExited,
      exitInfo: this.boot.exitInfo,
      notes: this.notes,
      ...extra,
    };
    try {
      this.watcher.dispose();
      this.boot.dispose();
    } catch {
      /* best-effort */
    }
    return out;
  }
}

/**
 * ONE spawn, three questions in the only order that keeps them all answerable:
 * config-load first (a refusal ends everything), then the bound key on a LIVE
 * turn, then the bound key at an IDLE empty composer — the cell where Ctrl+C
 * quits, and therefore the cell the whole option exists for. The Ctrl+C control
 * runs last because it is the one press expected to kill the session.
 */
async function armRebind() {
  const keymapBlock = `\n[tui.keymap.chat]\ninterrupt_turn = "${REBIND_KEY}"\n`;
  const arm = new Arm(`k1-rebind-${REBIND_KEY}`, keymapBlock);
  const booted = await arm.start();
  const profileCarriesBlock = /interrupt_turn\s*=/.test(arm.profile ?? "");
  if (!booted || arm.boot.ptyExited) {
    return arm.finish({
      profileCarriesBlock,
      verdict: "BOOT FAILED — a profile-layer keymap override may be a hard config-load failure",
    });
  }
  if (!(await arm.warmUp()))
    return arm.finish({
      profileCarriesBlock,
      verdict: arm.boot.ptyExited ? "PTY DIED AFTER BOOT — see screenTail/configLog" : "WARM-UP FAILED",
    });

  // Q2 — does the bound key interrupt a live turn?
  const before = arm.hooks.length;
  const submit = await arm.submitAndConfirm("Count from 1 to 900, one number per line, nothing else.");
  if (!submit.ok) return arm.finish({ profileCarriesBlock, verdict: "SUBMIT FAILED" });
  await arm.boot.waitUntil(() => arm.hooks.slice(before).some((h) => h.event === "UserPromptSubmit"), 60_000);
  let grew = false;
  for (let i = 0; i < 40 && !grew; i += 1) {
    const first = arm.boot.screen();
    await sleep(250);
    grew = arm.boot.screen() !== first;
  }
  const pressedAt = arm.boot.at();
  arm.boot.host.writeRaw(REBIND_BYTE);
  await sleep(3000);
  const interruptHook = arm.hooks.slice(before).find((h) => h.event === "Interrupt" && h.atMs > pressedAt) ?? null;
  const boundKeyInterrupted = Boolean(interruptHook) || /interrupted/i.test(arm.boot.screen());

  // Q3 — is the bound key inert at an idle EMPTY composer?
  await arm.boot.waitUntil((b) => b.ready(), 30_000);
  await sleep(1500);
  const idleBefore = arm.boot.screen();
  arm.boot.host.writeRaw(REBIND_BYTE);
  await sleep(2500);
  const boundKeyQuitAtIdle = arm.boot.ptyExited;
  const idleScreenChanged = arm.boot.ptyExited ? null : arm.boot.screen() !== idleBefore;

  // The control: on the SAME session with the rebind in place, does Ctrl+C still
  // quit at idle? A rebind that also DISARMED the fixed chord would be a
  // different (and larger) claim, so it is measured rather than assumed.
  let ctrlCStillQuits = null;
  if (!arm.boot.ptyExited) {
    arm.boot.host.writeRaw(CTRL_C);
    await arm.boot.waitUntil((b) => b.ptyExited, 6000, 100);
    ctrlCStillQuits = arm.boot.ptyExited;
  }

  return arm.finish({
    profileCarriesBlock,
    boundKey: REBIND_KEY,
    interruptHookAtMs: interruptHook ? interruptHook.atMs - pressedAt : null,
    boundKeyInterrupted,
    boundKeyQuitAtIdle,
    idleScreenChanged,
    ctrlCStillQuits,
    verdict: boundKeyInterrupted
      ? boundKeyQuitAtIdle
        ? `${REBIND_KEY} interrupts a turn BUT also quits at idle — no better than Ctrl+C`
        : `${REBIND_KEY} interrupts a live turn and is INERT at an idle composer`
      : `${REBIND_KEY} did NOT interrupt — the profile-layer binding did not take`,
  });
}

const result = await armRebind();
let endVersion = null;
let versionDrift = null;
try {
  endVersion = codexVersion();
  if (!endVersion.includes(EXPECT_CODEX_VERSION)) versionDrift = `drifted to ${endVersion}`;
} catch (error) {
  versionDrift = `version check failed: ${error.message}`;
}

const outPath = path.join(OUT_DIR, "q32-keymap-interrupt-rebind.capture.txt");
fs.writeFileSync(
  outPath,
  sanitize(
    JSON.stringify(
      {
        probe: "q32-keymap-interrupt-rebind",
        question:
          "Can Sonata bind codex's rebindable `chat.interrupt_turn` from its OWN profile, and is that key free of Ctrl+C's quit semantics?",
        version,
        candidateKey: REBIND_KEY,
        endVersion,
        versionDrift,
        result,
      },
      null,
      2,
    ),
  ),
);
console.log(JSON.stringify({ success: true, outPath, versionDrift, verdict: result.verdict }, null, 2));
