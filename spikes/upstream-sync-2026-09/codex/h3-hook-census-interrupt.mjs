// H3 (2026-09 sync, SL-9) — the codex HOOK-EVENT CENSUS at 0.152.1, and the one
// event the brief names outright: `Interrupt` (0.150.0, #40511).
//
// QUESTION (brief objective 1, codex half). Sonata registers 9 sink events +
// `PermissionRequest`. 0.152.1's binary declares TWELVE (`HookEventsToml`, read
// out of the binary each run — see `declaredEvents`), so exactly two are
// unregistered: `SessionEnd` and `Interrupt`. `Interrupt` is the interesting one.
// SL-2b measured the residual completion gap on CLAUDE as "the two turns the USER
// ends fire NO hook at all"; if codex fires a real hook for a user interrupt, the
// codex half of that gap has a structural answer claude does not have — and
// that is a capability worth knowing precisely, whether or not this slice wires
// it.
//
// The payload shape is NOT guessed: codex embeds a draft-07 JSON schema per hook
// event in the binary (`interrupt.command.input`), which this probe extracts and
// then checks the MEASURED payload against. Documented AND measured, so the
// brief's "return unresolved if the shape is undocumented and unstable" exit does
// not apply — but the arm still runs the interrupt TWICE, because "stable across
// two probe runs" is the other half of that test.
//
// ARMS
//   d1-interrupt  a real mid-turn Esc under the production spawn, twice, with
//                 SessionEnd + Interrupt layered onto the profile Sonata itself
//                 just wrote. Also the census arm: whatever else fires during a
//                 normal turn is recorded here.
//   d2-teardown   `/quit` — does SessionEnd fire, and is SessionStart lazy (the
//                 SL-6 boot-latch premise) at this binary?
//
// SAFETY. Isolated CODEX_HOME under /private/tmp, seeded with credentials only,
// pre-trusted through Sonata's own ledger so no trust dialog is provoked. The
// user's real `~/.codex` is never read for config nor written at all.
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
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
const { enableCodexAnswering } = require(APP_DIR + "dist/runtime/providers/codex/codex-approvals");

const ROOT = "/private/tmp/sonata-sync-2026-09/codex-hook-census";
const COLS = 120;
const ROWS = 40;

assertCodexVersion("probe start");
const version = codexVersion();

// ─── the declared universe, read from the binary this run is pinned to ──────
function declaredEvents() {
  const binaryPath = execFileSync("bash", ["-c", 'readlink -f "$(which codex)" || which codex'], { encoding: "utf8" }).trim();
  const hay = fs.readFileSync(binaryPath).toString("latin1");
  // The serde variant table for `HookEventsToml`, emitted immediately before the
  // type name. Anchored on the type name so a renamed enum reports "not found"
  // rather than silently matching some other list.
  const at = hay.indexOf("HookEventsToml");
  if (at < 0) return null;
  const window = hay.slice(Math.max(0, at - 400), at + 400);
  const after = window.slice(window.indexOf("HookEventsToml") + "HookEventsToml".length);
  const names = after.match(/^(?:[A-Z][a-zA-Z]+)+/);
  if (!names) return null;
  // Split a run of CamelCase names ("PreToolUsePermissionRequest…") on capital
  // boundaries that begin a KNOWN prefix set — the enum is a concatenation with
  // no separators, so the split has to be anchored on the vocabulary itself.
  const VOCAB = [
    "PreToolUse", "PermissionRequest", "PostToolUse", "PreCompact", "PostCompact",
    "SessionStart", "SessionEnd", "UserPromptSubmit", "SubagentStart", "SubagentStop",
    "Stop", "Interrupt",
  ];
  const run = names[0];
  const out = [];
  let index = 0;
  while (index < run.length) {
    const next = VOCAB.find((name) => run.startsWith(name, index));
    if (!next) break;
    out.push(next);
    index += next.length;
  }
  return out.length ? out : null;
}
const DECLARED = declaredEvents();
if (!DECLARED) {
  console.log(JSON.stringify({ success: false, reason: "could not extract HookEventsToml from the codex binary" }));
  process.exit(2);
}

/** The `interrupt.command.input` schema codex embeds — the documentation half of
 *  the brief's "documented AND stable" test. */
function embeddedInterruptSchema() {
  const binaryPath = execFileSync("bash", ["-c", 'readlink -f "$(which codex)" || which codex'], { encoding: "utf8" }).trim();
  const hay = fs.readFileSync(binaryPath).toString("latin1");
  const marker = '"const": "Interrupt"';
  const at = hay.indexOf(marker);
  if (at < 0) return null;
  const start = hay.lastIndexOf('{\n  "$schema"', at);
  if (start < 0) return null;
  let depth = 0;
  for (let i = start; i < hay.length; i += 1) {
    if (hay[i] === "{") depth += 1;
    else if (hay[i] === "}") {
      depth -= 1;
      if (depth === 0) {
        try { return JSON.parse(hay.slice(start, i + 1)); } catch { return null; }
      }
    }
  }
  return null;
}
const INTERRUPT_SCHEMA = embeddedInterruptSchema();

// ─── census injection: layer the unregistered events onto Sonata's own profile ─
// Codex spawns with `--dangerously-bypass-hook-trust` (D4), so appending events
// to the profile can never re-trigger the hook-trust ceremony.
function installCensusInjection() {
  const module = require(APP_DIR + "dist/runtime/providers/codex/codex-runtime-settings.js");
  const originalEnsure = module.ensureCodexRuntimeSettings;
  const { codexProfilePath } = module;
  let extra = [];
  module.ensureCodexRuntimeSettings = (paths) => {
    const result = originalEnsure(paths);
    if (extra.length === 0) return result;
    const profilePath = codexProfilePath();
    const profile = fs.readFileSync(profilePath, "utf8");
    // Reuse the sink command production itself just wrote — same shim, same
    // interpreter prefix, same env binding. Anything else would be measuring a
    // different spawn.
    const sinkMatch = /\[\[hooks\.Stop\.hooks\]\]\ntype = "command"\ncommand = '([^']+)'/.exec(profile);
    if (!sinkMatch) throw new Error("could not find the Stop sink command in the generated profile");
    const blocks = extra
      .filter((event) => !new RegExp(`\\[\\[hooks\\.${event}\\]\\]`).test(profile))
      .map((event) => `[[hooks.${event}]]\n[[hooks.${event}.hooks]]\ntype = "command"\ncommand = '${sinkMatch[1]}'\n`);
    if (blocks.length) fs.writeFileSync(profilePath, `${profile}\n${blocks.join("\n")}`, "utf8");
    return result;
  };
  let strip = [];
  const originalStrip = module.ensureCodexRuntimeSettings;
  void originalStrip;
  const wrapped = module.ensureCodexRuntimeSettings;
  module.ensureCodexRuntimeSettings = (paths) => {
    const result = wrapped(paths);
    if (strip.length === 0) return result;
    // The PRE-FIX profile: production's own bytes with the named events removed,
    // so an A/B arm measures the same spawn minus exactly one registration.
    const profilePath = codexProfilePath();
    let profile = fs.readFileSync(profilePath, "utf8");
    for (const event of strip) {
      profile = profile.replace(
        new RegExp(`\\[\\[hooks\\.${event}\\]\\]\\n\\[\\[hooks\\.${event}\\.hooks\\]\\]\\ntype = "command"\\ncommand = '[^']+'\\n`, "g"),
        "",
      );
    }
    fs.writeFileSync(profilePath, profile, "utf8");
    return result;
  };
  return (events, stripEvents = []) => { extra = events; strip = stripEvents; };
}
const setCensusEvents = installCensusInjection();

// ─── harness ────────────────────────────────────────────────────────────────

const REDACT_VALUE_KEYS = new Set(["transcript_path", "cwd", "session_id", "turn_id", "tool_use_id", "agent_id"]);
function renderPayload(payload) {
  const out = {};
  for (const [key, raw] of Object.entries(payload)) {
    if (REDACT_VALUE_KEYS.has(key)) { out[key] = typeof raw === "string" ? `<${key}:${raw.length}ch>` : raw; continue; }
    if (typeof raw === "string") { out[key] = sanitize(raw.length > 220 ? `${raw.slice(0, 220)}…[${raw.length}ch]` : raw); continue; }
    if (raw && typeof raw === "object") {
      const json = sanitize(JSON.stringify(raw));
      out[key] = json.length > 300 ? `${json.slice(0, 300)}…[${json.length}ch]` : json;
      continue;
    }
    out[key] = raw;
  }
  return out;
}

/** Validate a measured payload against the embedded draft-07 schema — only the
 *  terms the schema actually asserts (required keys, additionalProperties:false,
 *  the const). Enough to say "the shape matches what codex documents", without
 *  pulling a JSON-schema library into a spike. */
function checkAgainstSchema(payload, schema) {
  if (!schema) return { checked: false };
  const props = Object.keys(schema.properties ?? {});
  const missing = (schema.required ?? []).filter((key) => !(key in payload));
  const unexpected = schema.additionalProperties === false ? Object.keys(payload).filter((key) => !props.includes(key)) : [];
  return { checked: true, missingRequired: missing, unexpectedKeys: unexpected, matches: missing.length === 0 && unexpected.length === 0 };
}

class Arm {
  constructor(name, { censusEvents = [], stripEvents = [], approvalBroker = false } = {}) {
    this.name = name;
    this.hooks = [];
    this.notes = [];
    const runRoot = path.join(ROOT, name);
    fs.rmSync(runRoot, { recursive: true, force: true });
    this.workspace = path.join(runRoot, "ws");
    this.runtimeDir = path.join(runRoot, "runtime");
    this.binDir = path.join(runRoot, "bin");
    this.codexHome = seedCodexHome(path.join(runRoot, "codex-home"));
    fs.mkdirSync(this.workspace, { recursive: true });
    fs.mkdirSync(this.runtimeDir, { recursive: true });
    fs.mkdirSync(this.binDir, { recursive: true });
    setCensusEvents(censusEvents, stripEvents);

    this.boot = new CodexBoot({
      taskId: `task-h3-${name}`,
      cwd: this.workspace,
      runtimeDir: this.runtimeDir,
      binDir: this.binDir,
      // Pre-trust through Sonata's OWN ledger so no dialog is provoked; the trust
      // question is SL-6's, already settled, and a dialog here would only add noise.
      pretrustCwd: this.workspace,
      codexHome: this.codexHome,
      rows: ROWS,
      cols: COLS,
      approvalBroker,
      extraEnv: {
        // Hook-config diagnostics (objective 4): codex logs its parse verdict —
        // skipped handlers, clamped timeouts, ignored additionalContextLimit — at
        // debug/warn. An isolated home means the log file is this arm's alone.
        RUST_LOG: "codex_hooks=debug,codex_core=info,info",
      },
    });
    this.watcher = new HookWatcher({
      sinkDir: codexHooksDirectory,
      pollMs: 100,
      onPayload: (payload) => {
        const event = typeof payload.hook_event_name === "string" ? payload.hook_event_name : "<none>";
        this.hooks.push({ atMs: this.boot.at(), event, keys: Object.keys(payload).sort(), payload: renderPayload(payload), raw: payload });
        this.applyProductionDispatch(event, payload);
      },
      onError: (error, filePath) => this.notes.push(`hook-watcher error ${filePath}: ${error.message}`),
    });
  }

  /** EXACTLY the run-lifecycle edges `RuntimeController.handleHookPayload` applies
   *  for a codex task — no more, no less. Without them the host never opens a run
   *  and "did the interrupt close it?" has nothing to close. */
  applyProductionDispatch(event, payload) {
    const host = this.boot.host;
    if (event === "SessionStart") host.noteHookSessionStart();
    if (event === "UserPromptSubmit") {
      host.beginRunFromHook(typeof payload.prompt === "string" ? payload.prompt : "", {
        promptId: typeof payload.turn_id === "string" ? payload.turn_id : null,
      });
    }
    if (event === "Stop" || event === "Interrupt") host.completeRunFromTurnEnd();
  }

  activeRun() {
    const run = this.boot.host.activeRun;
    return run ? { id: run.id, status: run.status, lifecyclePhase: run.lifecyclePhase } : null;
  }

  async start() {
    await this.boot.start();
    this.watcher.watchWorkspace(this.runtimeDir);
    this.profile = fs.readFileSync(path.join(this.codexHome, "sonata.config.toml"), "utf8");
    const ready = await this.boot.waitUntil((b) => b.ready(), 90_000);
    this.notes.push(`ready=${ready !== null} at ${ready ?? "TIMEOUT"}ms`);
    return ready !== null;
  }

  /**
   * Submit a prompt and CONFIRM the CLI took it (a `UserPromptSubmit` hook).
   *
   * `TerminalHost.submitPrompt` pastes and writes ONE `CSI-u Enter` at +120ms. In
   * production the `DeliveryController` owns the retry ladder when that Enter is
   * swallowed; this probe drives the host directly, so it needs the ladder here
   * or a swallowed Enter reads as "codex ignored the prompt". MEASURED on this
   * binary: a first submission whose boot painted the `--dangerously-bypass-hook-
   * trust` warning + a usage-limit notice left the text sitting in the composer
   * with no submission at all. Probe scaffolding, declared as such: it changes
   * nothing about WHAT is measured after the turn starts.
   */
  async submitAndConfirm(text, { timeoutMs = 120_000 } = {}) {
    const before = this.hooks.length;
    const submitted = () => this.hooks.slice(before).some((h) => h.event === "UserPromptSubmit");
    this.boot.host.submitPrompt(text);
    const deadline = Date.now() + timeoutMs;
    let retries = 0;
    while (Date.now() < deadline && !this.boot.ptyExited) {
      if (submitted()) return { ok: true, retries, atMs: this.boot.at() };
      await sleep(2500);
      if (submitted()) return { ok: true, retries, atMs: this.boot.at() };
      // Only retry while the text is demonstrably still sitting in the composer —
      // a blind Enter into an unknown screen is exactly what this program forbids.
      const stillInComposer = this.boot.screen().includes(text.slice(0, 40));
      if (!stillInComposer) continue;
      retries += 1;
      this.boot.host.writeRaw(retries % 2 === 1 ? "\r" : "\x1b[13u");
      this.notes.push(`submit retry ${retries} (${retries % 2 === 1 ? "CR" : "CSI-u Enter"}) at ${this.boot.at()}ms`);
    }
    return { ok: submitted(), retries, atMs: this.boot.at() };
  }

  /** Whatever codex logged about loading our hook config (objective 4). */
  hookLogLines() {
    const logDir = path.join(this.codexHome, "log");
    let files = [];
    try { files = fs.readdirSync(logDir); } catch { return ["<no log dir>"]; }
    const out = [];
    for (const file of files) {
      let text = "";
      try { text = fs.readFileSync(path.join(logDir, file), "utf8"); } catch { continue; }
      for (const line of text.split("\n")) {
        if (/hook/i.test(line)) out.push(sanitize(`${file}: ${line.trim()}`).slice(0, 400));
      }
    }
    return out.slice(0, 80);
  }

  eventsSeen() { return [...new Set(this.hooks.map((h) => h.event))]; }

  finish(extra = {}) {
    const out = {
      arm: this.name,
      version,
      profileHookEvents: [...this.profile.matchAll(/^\[\[hooks\.([A-Za-z]+)\]\]$/gm)].map((m) => m[1]).sort(),
      hookOrder: this.hooks.map((h) => `${h.event}@${h.atMs}`),
      eventsSeen: this.eventsSeen(),
      hookLog: this.hookLogLines(),
      // codex parses Interrupt-hook stdout STRICTLY ("Interrupt hook returned
      // non-JSON stdout" / "hook returned invalid interrupt hook JSON output" are
      // both in the binary). Sonata's sink emits ZERO bytes, so before this event
      // could ever be registered in production the question is whether an EMPTY
      // stdout trips that path — which would paint an error on the user's screen
      // every interrupt. The scan is of the full scrollback, not the viewport.
      scrollbackHookNoise: [...new Set(
        this.boot.scrollback().split("\n").filter((line) => /hook/i.test(line)).map((line) => sanitize(line.trim())),
      )].slice(0, 20),
      notes: this.notes,
      screenTail: this.boot.screen().split("\n").slice(-12).join("\n"),
      ...extra,
    };
    try { this.watcher.dispose(); this.boot.dispose(); } catch { /* best-effort */ }
    return out;
  }
}

// ─── arms ───────────────────────────────────────────────────────────────────

/** d1 — a real mid-turn Esc, TWICE. The interrupt is written through
 *  `writeUserInput` (the co-visible-Terminal path a human types on), not
 *  `writeRaw`, because the question is what a USER interrupt does. */
async function armInterrupt() {
  const arm = new Arm("d1-interrupt", { censusEvents: ["SessionEnd", "Interrupt"] });
  if (!(await arm.start())) return arm.finish({ verdict: "BOOT FAILED" });

  // WARM-UP, and it is load-bearing. Codex's `SessionStart` is LAZY (SL-6) and
  // Sonata's boot latch holds the first delivery behind a medium-confidence gate,
  // so the FIRST prompt of a session can sit queued for a long time. The first
  // run of this arm pressed Esc into that wait and measured nothing. A completed
  // warm-up turn proves delivery works before any interrupt is timed.
  const warmSubmit = await arm.submitAndConfirm("Reply with exactly: OK");
  arm.notes.push(`warm-up submitted: ${warmSubmit.ok} (${warmSubmit.retries} Enter retries)`);
  const warmup = warmSubmit.ok ? await arm.boot.waitUntil(() => arm.hooks.some((h) => h.event === "Stop"), 180_000) : null;
  arm.notes.push(`warm-up turn closed: ${warmup !== null} at ${warmup ?? "TIMEOUT"}ms`);
  if (warmup === null) return arm.finish({ verdict: "WARM-UP FAILED — no first turn, nothing to interrupt" });
  await sleep(3000);

  // Two rounds, two REAL interrupt paths — both production, neither synthetic:
  //  human  — the user pressing Esc in the co-visible Terminal (`writeUserInput`,
  //           which carries the settle pass + the dirty-line marking).
  //  sonata — Sonata's own stop button, which writes a bare ESC (`writeRaw`).
  // Two rounds is also the brief's stability test for the payload shape.
  const ROUNDS = [
    { round: 0, via: "human Esc (writeUserInput)", send: (host) => host.writeUserInput("\x1b") },
    // The production stop button, not a hand-written byte: `stopRun` aborts
    // Sonata's own deferred writes, writes ESC, arms the swallowed-Esc retry and
    // (codex only) may follow with `/stop`. If an interrupt fires an `Interrupt`
    // hook anywhere, this is the path that has to prove it.
    { round: 1, via: "production stopRun()", send: (host) => { void host.stopRun().catch(() => {}); } },
    // The EARLY round. Rounds 0/1 wait 2.5s for the screen to prove the turn is
    // live, and both turns still ran to completion — which leaves two readings
    // apart: codex ignored the Esc, or the model had already finished generating
    // and only the RENDER was still going. This round removes the second reading
    // by pressing Esc ~0.8s after `UserPromptSubmit`, before any answer text can
    // exist. Its liveness term is the hook clock (no `Stop` yet), not the screen.
    { round: 2, via: "human Esc, 0.8s after UserPromptSubmit", earlyMs: 800, send: (host) => host.writeUserInput("\x1b") },
    // The KEY question, once three Esc paths have all failed to interrupt. 0.152.1
    // ships a configurable keymap (`TuiChatKeymap`) with `interrupt_turn` as a
    // named action — so which key that action is BOUND to is now a variable, not a
    // constant, and Sonata's stop writes ESC. This round sends Ctrl+C instead. If
    // it interrupts where ESC did not, the finding is not "Interrupt never fires";
    // it is "codex's interrupt key moved out from under Sonata's stop button".
    { round: 3, via: "Ctrl+C mid-turn", send: (host) => host.writeUserInput("\x03") },
  ];
  const rounds = [];
  for (const spec of ROUNDS) {
    const before = arm.hooks.length;
    const submit = await arm.submitAndConfirm(
      "Write out the numbers 1 to 400, one per line, with no other text. Do not use any tools.",
    );
    const started = submit.ok ? submit.atMs : null;
    // The Esc must land while the turn is GENUINELY streaming, or the arm measures
    // a completed turn — which is what the first two runs of this probe did. The
    // gate is the RUN's own liveness, not a needle on the grid: a viewport holds
    // ~40 rows, so "line 1 is on screen" scrolls away within a second of a 400-line
    // answer and reads as "never started". Two terms, both cheap and both true only
    // mid-turn: no `Stop` for this round yet, and the screen CHANGED across the
    // last second (the model is still printing).
    const stopped = () => arm.hooks.slice(before).some((h) => h.event === "Stop");
    let grew = false;
    if (started !== null) {
      const first = arm.boot.screen();
      await sleep(spec.earlyMs ?? 2500);
      grew = arm.boot.screen() !== first;
    }
    // The early round cannot use `grew` as its liveness term (there is nothing to
    // grow yet), so it uses the hook clock alone: the turn started and has not
    // stopped. Both terms are honest; they just answer at different resolutions.
    const liveAtEsc = started !== null && !stopped() && (spec.earlyMs ? true : grew);
    const escAt = arm.boot.at();
    if (started !== null) spec.send(arm.boot.host);
    arm.notes.push(`round ${spec.round} (${spec.via}): turnStarted=${started !== null} grew=${grew} stoppedAlready=${stopped()}; Esc at ${escAt}ms`);
    await sleep(25_000);
    const after = arm.hooks.slice(before).filter((h) => h.atMs > escAt);
    const interrupt = after.find((h) => h.event === "Interrupt") ?? null;
    rounds.push({
      round: spec.round,
      via: spec.via,
      turnStarted: started !== null,
      streamingWhenEscSent: liveAtEsc,
      escAtMs: escAt,
      hooksAfterEsc: after.map((h) => `${h.event}@${h.atMs}`),
      // The Esc's ground truth: did the CLI stop mid-list, or run to 400?
      reached400: /^\s*400\s*$/m.test(arm.boot.screen()),
      interrupt: interrupt ? { atMs: interrupt.atMs, msAfterEsc: interrupt.atMs - escAt, keys: interrupt.keys, payload: interrupt.payload } : null,
      interruptSchemaCheck: interrupt ? checkAgainstSchema(interrupt.raw, INTERRUPT_SCHEMA) : null,
    });
    await sleep(4000);
  }

  const fired = rounds.filter((r) => r.interrupt);
  const genuine = rounds.filter((r) => r.streamingWhenEscSent);
  const sameKeys = fired.length === 2 && JSON.stringify(fired[0].interrupt.keys) === JSON.stringify(fired[1].interrupt.keys);
  return arm.finish({
    rounds,
    interruptSchema: INTERRUPT_SCHEMA,
    declared: DECLARED,
    neverFired: DECLARED.filter((e) => !arm.eventsSeen().includes(e)),
    verdict: genuine.length === 0
      ? "UNREPRODUCED — no round sent its Esc into a genuinely streaming turn"
      : fired.length === 0
        ? `Interrupt did NOT fire in ${genuine.length} genuinely-interrupted round(s)`
        : fired.length < genuine.length
          ? `Interrupt fired in ${fired.length}/${genuine.length} genuinely-interrupted rounds — UNSTABLE`
          : sameKeys || fired.length === 1
            ? `Interrupt fires on a mid-turn Esc (+${fired.map((r) => r.interrupt.msAfterEsc).join("/")}ms), key set ${sameKeys ? "STABLE across both rounds" : "measured once"}`
            : "Interrupt fires but its key set CHANGED between rounds",
  });
}

/** d2 — teardown. Is `SessionStart` still LAZY (the SL-6 boot-latch premise), and
 *  does `SessionEnd` fire on a graceful quit? */
async function armTeardown() {
  const arm = new Arm("d2-teardown", { censusEvents: ["SessionEnd", "Interrupt"] });
  if (!(await arm.start())) return arm.finish({ verdict: "BOOT FAILED" });

  const readyAt = arm.boot.at();
  // The lazy-SessionStart check: WAIT at an idle composer and record whether the
  // handshake has arrived before any prompt is submitted.
  await sleep(12_000);
  const sessionStartBeforePrompt = arm.hooks.some((h) => h.event === "SessionStart");

  const submit = await arm.submitAndConfirm("Reply with exactly: OK");
  arm.notes.push(`prompt submitted: ${submit.ok} (${submit.retries} Enter retries)`);
  await arm.boot.waitUntil(() => arm.hooks.some((h) => h.event === "Stop"), 180_000);
  const sessionStartAfterPrompt = arm.hooks.find((h) => h.event === "SessionStart") ?? null;
  await sleep(3000);

  const quitAt = arm.boot.at();
  arm.boot.host.writeRaw("/quit\r");
  await arm.boot.waitUntil((b) => b.ptyExited, 30_000);
  await sleep(4000);
  const sessionEnd = arm.hooks.filter((h) => h.event === "SessionEnd");

  return arm.finish({
    readyAtMs: readyAt,
    sessionStartBeforePrompt,
    sessionStartAtMs: sessionStartAfterPrompt?.atMs ?? null,
    sessionStartPayload: sessionStartAfterPrompt?.payload ?? null,
    quitAtMs: quitAt,
    sessionEnd: sessionEnd.map((h) => ({ atMs: h.atMs, keys: h.keys, payload: h.payload })),
    verdict: `SessionStart ${sessionStartBeforePrompt ? "EAGER (fires at boot)" : "LAZY (not before the first prompt)"}; SessionEnd ${sessionEnd.length ? `fires (${sessionEnd.length})` : "DID NOT FIRE"}`,
  });
}

/**
 * d3 — the A/B for THIS SLICE'S ONE INJECTION CHANGE. Two spawns of the same
 * production shape, differing only in whether `Interrupt` is registered, each
 * driven through the production run-lifecycle dispatch. The question is not "does
 * the hook fire" (d1 settled that) but "does Sonata's RUN close, and when".
 *
 *   before  the profile production writes, minus the `Interrupt` block. Nothing
 *           arrives; the run can only close by inference (`stoplessTurnEndConfirmed`,
 *           a 30s window) or not at all inside the watch.
 *   after   production as shipped. The hook arrives and closes the run.
 *
 * The interrupt is Ctrl+C, because d1 MEASURED that Esc does not interrupt codex
 * at 0.152.1 — which is its own finding and belongs to the stop button, not here.
 */
async function armInterruptAB() {
  const out = [];
  for (const phase of [
    { name: "before", strip: ["Interrupt"] },
    { name: "after", strip: [] },
  ]) {
    const arm = new Arm(`d3-${phase.name}`, { censusEvents: [], stripEvents: phase.strip });
    if (!(await arm.start())) { out.push(arm.finish({ phase: phase.name, verdict: "BOOT FAILED" })); continue; }
    const warm = await arm.submitAndConfirm("Reply with exactly: OK");
    const warmClosed = warm.ok ? await arm.boot.waitUntil(() => arm.hooks.some((h) => h.event === "Stop"), 180_000) : null;
    if (warmClosed === null) { out.push(arm.finish({ phase: phase.name, verdict: "WARM-UP FAILED" })); continue; }
    await sleep(3000);

    const before = arm.hooks.length;
    const submit = await arm.submitAndConfirm(
      "Write out the numbers 1 to 400, one per line, with no other text. Do not use any tools.",
    );
    if (!submit.ok) { out.push(arm.finish({ phase: phase.name, verdict: "PROMPT NEVER SUBMITTED" })); continue; }
    const screenBefore = arm.boot.screen();
    await sleep(2500);
    const live = arm.boot.screen() !== screenBefore && !arm.hooks.slice(before).some((h) => h.event === "Stop");
    const runBefore = arm.activeRun();
    const interruptAt = arm.boot.at();
    arm.boot.host.writeUserInput("\x03");
    arm.notes.push(`Ctrl+C at ${interruptAt}ms (live=${live}, run=${JSON.stringify(runBefore)})`);

    // 45s: past the hook's own latency by two orders of magnitude AND past
    // `stoplessTurnEndConfirmed`'s 30s window, so the BEFORE arm gets a fair
    // chance to close by inference rather than being timed out unfairly.
    const closedAt = await arm.boot.waitUntil(() => arm.activeRun() === null, 45_000, 250);
    const interruptHook = arm.hooks.slice(before).find((h) => h.event === "Interrupt") ?? null;
    out.push(arm.finish({
      phase: phase.name,
      profileHasInterrupt: arm.profile.includes("[[hooks.Interrupt]]"),
      liveAtInterrupt: live,
      runBefore,
      interruptAtMs: interruptAt,
      interruptHookAtMs: interruptHook?.atMs ?? null,
      msInterruptToHook: interruptHook ? interruptHook.atMs - interruptAt : null,
      closedAtMs: closedAt,
      msInterruptToClose: closedAt === null ? null : closedAt - interruptAt,
      runAtEnd: arm.activeRun(),
      verdict: !live
        ? "UNREPRODUCED — the Ctrl+C did not land in a live turn"
        : closedAt === null
          ? `run STILL OPEN 45s after the interrupt (Interrupt hook: ${interruptHook ? "arrived" : "never arrived"})`
          : `run closed ${closedAt - interruptAt}ms after the interrupt (Interrupt hook: ${interruptHook ? `+${interruptHook.atMs - interruptAt}ms` : "never arrived"})`,
    }));
    await sleep(2000);
  }
  return {
    arm: "d3-interrupt-ab",
    version,
    phases: out,
    eventsSeen: [...new Set(out.flatMap((p) => p.eventsSeen ?? []))],
    verdict: out.map((p) => `${p.phase}: ${p.verdict}`).join(" | "),
  };
}

/**
 * d4 — THE B1 PREMISE. Review round 1 found that routing `Interrupt` through
 * `completeRunFromTurnEnd()` stamps `completionSource: "hook-stop"`, which
 * `isPendingTurnEnd` deliberately EXCLUDES on the invariant "a live holding hook
 * blocks the turn, so a hook-Stop completion cannot coexist with a pending broker
 * ask". That invariant is `Stop`'s, and it is FALSE for an interrupt: an
 * interrupt KILLS the holding PermissionRequest hook — which is the exact
 * reasoning `abortPendingBrokerApprovals`'s own header gives for existing.
 *
 * The unmeasured half is whether codex fires `Interrupt` AT ALL while a hook is
 * holding the turn. If it does, the wedge is live; if it does not, the wedge is
 * unreachable today but a future codex could arm it silently. Either way the
 * code has to be made safe — this arm only decides how urgent it is.
 *
 * Broker ON + the answering marker armed = production's real approval channel,
 * held open deliberately: the arm surfaces the ask and then answers NOTHING, so
 * the broker is genuinely blocking inside the hook when the Ctrl+C lands.
 */
async function armInterruptUnderHold() {
  const arm = new Arm("d4-interrupt-under-hold", { censusEvents: [], approvalBroker: true });
  // Production arms answering in `watchHooks`; the probe drives the host directly,
  // so it must arm the marker itself or the shim exits inert (instant native card).
  enableCodexAnswering(arm.runtimeDir);
  if (!(await arm.start())) return arm.finish({ verdict: "BOOT FAILED" });

  const approvalsDir = path.join(arm.runtimeDir, "approvals");
  const listApprovals = () => {
    try { return fs.readdirSync(approvalsDir).sort(); } catch { return []; }
  };

  const warm = await arm.submitAndConfirm("Reply with exactly: OK");
  const warmClosed = warm.ok ? await arm.boot.waitUntil(() => arm.hooks.some((h) => h.event === "Stop"), 180_000) : null;
  arm.notes.push(`warm-up closed: ${warmClosed !== null}`);
  if (warmClosed === null) return arm.finish({ verdict: "WARM-UP FAILED" });
  await sleep(2000);

  // The escalation trigger has to be something the SANDBOX cannot satisfy, or
  // codex just runs it and no PermissionRequest is ever raised. First attempt
  // wrote to a path under /private/tmp and codex ran it unattended — MEASURED:
  // codex's WorkspaceWrite sandbox treats /tmp as writable
  // (`exclude_slash_tmp: false`, `exclude_tmpdir_env_var: false` in its own
  // turn log), so a tmp write is not an escalation.
  //
  // NETWORK is: the same log shows `network_access: false`, so any command
  // needing the network must escalate. It also has ZERO filesystem effect, which
  // matters for a command this arm deliberately never approves.
  const before = arm.hooks.length;
  const submit = await arm.submitAndConfirm(
    "Run exactly this shell command and nothing else: curl -sS https://example.com",
  );
  if (!submit.ok) return arm.finish({ verdict: "PROMPT NEVER SUBMITTED" });

  // The state under test: the broker is HOLDING (ask file on disk, no reply).
  const askAppeared = await arm.boot.waitUntil(
    () => listApprovals().some((n) => /^ask-.+\.json$/.test(n)),
    120_000,
    200,
  );
  const approvalsAtHold = listApprovals();
  arm.notes.push(`ask surfaced: ${askAppeared !== null} at ${askAppeared ?? "TIMEOUT"}ms — ${JSON.stringify(approvalsAtHold)}`);
  if (askAppeared === null) {
    return arm.finish({
      approvalsAtHold,
      verdict: "UNREPRODUCED — no PermissionRequest hold was established, so the premise is untested",
    });
  }

  await sleep(1500);
  const runBefore = arm.activeRun();
  const interruptAt = arm.boot.at();
  arm.boot.host.writeUserInput("\x03");
  arm.notes.push(`Ctrl+C into a LIVE broker hold at ${interruptAt}ms`);

  await sleep(25_000);
  const after = arm.hooks.slice(before).filter((h) => h.atMs > interruptAt);
  const interrupt = after.find((h) => h.event === "Interrupt") ?? null;
  const stop = after.find((h) => h.event === "Stop") ?? null;

  return arm.finish({
    approvalsAtHold,
    approvalsAfterInterrupt: listApprovals(),
    runBefore,
    interruptAtMs: interruptAt,
    hooksAfterInterrupt: after.map((h) => `${h.event}@${h.atMs}`),
    interrupt: interrupt ? { atMs: interrupt.atMs, msAfterInterrupt: interrupt.atMs - interruptAt, keys: interrupt.keys } : null,
    stopAfterInterrupt: stop ? { atMs: stop.atMs, msAfterInterrupt: stop.atMs - interruptAt } : null,
    // The wedge's ingredient: an ask that is still PENDING (never replied, never
    // expired) at the moment the turn-terminal signal lands.
    askStillPendingAtInterrupt: approvalsAtHold.some((n) => /^ask-/.test(n)),
    verdict: interrupt
      ? `Interrupt FIRES under a broker hold (+${interrupt.atMs - interruptAt}ms)${stop ? " and Stop also fired" : ", no Stop"} — the B1 wedge is REACHABLE`
      : stop
        ? "no Interrupt under a hold; the turn ended with Stop — B1 unreachable via this path today"
        : "neither Interrupt nor Stop fired after the interrupt — recorded, not explained",
  });
}

const ARMS = {
  "d1-interrupt": armInterrupt,
  "d2-teardown": armTeardown,
  "d3-interrupt-ab": armInterruptAB,
  "d4-interrupt-under-hold": armInterruptUnderHold,
};

// ─── run ────────────────────────────────────────────────────────────────────
const RESULT_DIR = path.join(ROOT, "results");
fs.mkdirSync(RESULT_DIR, { recursive: true });

const only = process.argv.slice(2).filter((a) => !a.startsWith("-"));
const selected = process.argv.includes("--capture-only") ? [] : only.length ? only : Object.keys(ARMS);

for (const name of selected) {
  const arm = ARMS[name];
  if (!arm) { console.error(`unknown arm: ${name}`); process.exitCode = 2; continue; }
  process.stderr.write(`\n=== ${name} ===\n`);
  let result;
  try { result = await arm(); } catch (error) { result = { arm: name, error: String(error?.stack ?? error) }; }
  result.ranAt = new Date().toISOString();
  fs.writeFileSync(path.join(RESULT_DIR, `${name}.json`), JSON.stringify(result, null, 2));
  process.stderr.write(`${name}: ${result.verdict ?? result.error ?? "?"}\n`);
}

assertCodexVersion("probe end");

const results = Object.keys(ARMS)
  .map((name) => path.join(RESULT_DIR, `${name}.json`))
  .filter((file) => fs.existsSync(file))
  .map((file) => JSON.parse(fs.readFileSync(file, "utf8")));

const seen = new Set(results.flatMap((r) => r.eventsSeen ?? []));
const capture = [
  "# H3 — codex hook-event CENSUS + `Interrupt` (SL-9)",
  "",
  `binary: ${version} (pinned ${EXPECT_CODEX_VERSION}, re-pinned at probe end)`,
  "spawn: production TerminalHost from dist/, `codex -p sonata`, isolated CODEX_HOME, pre-trusted ledger",
  `declared events in this binary (${DECLARED.length}, HookEventsToml): ${DECLARED.join(", ")}`,
  "",
  "## which declared events fired",
  "",
  "| event | in Sonata's profile? | fired in this probe? |",
  "|---|---|---|",
  ...DECLARED.map((event) => {
    const inProfile = results.some((r) => (r.profileHookEvents ?? []).includes(event));
    return `| ${event} | ${inProfile ? "yes" : "no"} | ${seen.has(event) ? "**yes**" : "no"} |`;
  }),
  "",
  "## the embedded `interrupt.command.input` schema (documentation half)",
  "",
  "```json",
  INTERRUPT_SCHEMA ? JSON.stringify(INTERRUPT_SCHEMA, null, 2) : "<not found in the binary>",
  "```",
  "",
  "## per-arm detail",
  "",
  ...results.map((r) => [`### ${r.arm}`, "", "```json", sanitize(JSON.stringify(r, null, 2)), "```", ""].join("\n")),
].join("\n");

fs.writeFileSync(path.join(OUT_DIR, "h3-hook-census-interrupt.capture.txt"), capture);
console.log(JSON.stringify({
  success: results.every((r) => !r.error),
  version,
  declared: DECLARED,
  interruptSchemaFound: Boolean(INTERRUPT_SCHEMA),
  arms: results.map((r) => ({ arm: r.arm, verdict: r.verdict ?? r.error ?? "?", eventsSeen: r.eventsSeen })),
}, null, 2));
