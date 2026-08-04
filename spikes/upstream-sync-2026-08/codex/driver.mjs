// Upstream-sync S1 codex probe driver.
//
// Spawns the REAL `codex` binary under node-pty with an ISOLATED CODEX_HOME,
// renders the stream through a headless xterm (so what we log is the FRAME the
// user sees, not a naive ANSI strip), and folds every frame through Sonata's own
// `cleanTerminal` + whitespace-strip so captured text can be compared against the
// production needles byte-for-byte.
//
// Usage: SCRATCH=/abs/scratch/dir node driver.mjs <steps.json> <outPrefix>
//
// The steps file carries NO absolute personal paths: `${SCRATCH}` inside `cwd` /
// `codexHome` is substituted from $SCRATCH at load, and every byte written to the
// logs goes through `sanitize()`. Both matter — the pre-push leak fence scans
// blob CONTENT, not just paths.
//
// Step verbs:
//   { waitFor: "<regex>", timeoutMs, on: "screen"|"compact" }  wait for text
//   { mark: true }                     reset the compact-scan accumulator
//   { type: "text" }                   type slowly (per-char)
//   { key: "down,down,enter" }         send named keys
//   { settleMs: n }                    sleep
//   { snap: "label" }                  log the rendered screen + compact view
//   { codepoints: "<regex>" }          log per-char codepoints of matching lines
//   { sample: { ms, everyMs, label } } burst-sample frames with timestamps
//
// NOTHING here writes to the user's real ~/.codex — CODEX_HOME is forced to the
// isolated dir named in the steps file.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
// dev/spikes/upstream-sync-2026-08/codex → dev/app (node-pty + @xterm/headless).
const APP = process.env.SONATA_APP ?? path.resolve(HERE, "../../../app");
const pty = await import(`${APP}/node_modules/node-pty/lib/index.js`).then((m) => m.default ?? m);
const { Terminal } = await import(
  `${APP}/node_modules/@xterm/headless/lib-headless/xterm-headless.mjs`
).then((m) => m.default ?? m);

const SCRATCH = process.env.SCRATCH ?? path.join(HERE, ".scratch");
const steps = JSON.parse(fs.readFileSync(process.argv[2], "utf8").split("${SCRATCH}").join(SCRATCH));
const outPrefix = process.argv[3];

// Sanitization — the pre-push leak fence scans blob content.
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// The username needs its OWN rule, and a fuzzy one. Codex 0.146 repaints by cell
// diff, so a path echoed in the stream can arrive with characters elided
// (a dropped letter mid-name, "claude501"). Whole-path replacement misses those, and the
// scratch path embeds the name with DASHES, which no /Users/<name> rule catches.
// So: mask the bare username and every single-character deletion of it.
const USER = os.userInfo().username;
const userVariants = new Set([USER]);
for (let i = 0; i < USER.length; i += 1) {
  userVariants.add(USER.slice(0, i) + USER.slice(i + 1));
}
const userRe = new RegExp([...userVariants].map(escapeRe).join("|"), "gi");

const SANITIZE = [
  [new RegExp(escapeRe(SCRATCH), "g"), "$SCRATCH"],
  [new RegExp(escapeRe(os.homedir()), "g"), "$HOME"],
  [userRe, "$USER"],
  // Belt and suspenders: ANY /Users/<name> the child prints, whatever its source.
  [/\/Users\/[A-Za-z][\w.-]*/g, "$HOME"],
  // CREDENTIAL MASKS. The isolated CODEX_HOME holds a real auth.json, so a frame
  // that ever echoed a token must not reach a log. None of these should fire —
  // they exist so that "should not" is not the only thing standing between a
  // credential and a capture file.
  [/eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]+/g, "[REDACTED-JWT]"],
  [/\bsk-[A-Za-z0-9_-]{16,}/g, "[REDACTED-KEY]"],
  [/\b(access_token|id_token|refresh_token|api_key|OPENAI_API_KEY)\b\s*[:=]\s*\S+/gi, "$1=[REDACTED]"],
];
const sanitize = (s) => SANITIZE.reduce((acc, [re, to]) => acc.replace(re, to), s);

const rawLog = `${outPrefix}.raw.log`;
const snapLog = `${outPrefix}.frames.log`;
fs.writeFileSync(rawLog, "");
fs.writeFileSync(snapLog, "");
const log = (line) => {
  const text = sanitize(String(line));
  fs.appendFileSync(snapLog, `${text}\n`);
  console.log(text);
};

// Sonata's production transforms, replicated VERBATIM from
// app/src/runtime/terminal-host/tui-parsers-common.ts — so a string captured
// here is directly comparable to what the production parsers key on.
const ANSI_RE = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07]*(?:\x07|\x1b\\)|\x1b[@-_]/g;
const CONTROL_RE = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g;
const cleanTerminal = (text) =>
  text.replace(ANSI_RE, "").replace(/\r\n/g, "\n").replace(/\r/g, "\n").replace(CONTROL_RE, "");
const compact = (raw) => cleanTerminal(raw).replace(/\s+/g, "");

const env = { ...process.env };
for (const k of Object.keys(env)) {
  if (/^(CLAUDE|AI_AGENT|ANTHROPIC)/i.test(k)) delete env[k];
}
env.CODEX_HOME = steps.codexHome;
env.TERM = "xterm-256color";

const cols = steps.cols ?? 120;
const rows = steps.rows ?? 45;
const term = new Terminal({ cols, rows, allowProposedApi: true, scrollback: 4000 });

const child = pty.spawn(steps.cmd, steps.args ?? [], {
  name: "xterm-256color",
  cols,
  rows,
  cwd: steps.cwd,
  env,
});

let rawScan = ""; // the running PTY tail — exactly what Sonata's parsers see
child.onData((d) => {
  rawScan += d;
  fs.appendFileSync(rawLog, sanitize(d));
  term.write(d);
  if (rawScan.length > 800_000) rawScan = rawScan.slice(-400_000);
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** The rendered viewport, trailing blank lines trimmed. */
function screen() {
  const buf = term.buffer.active;
  const out = [];
  for (let y = 0; y < term.rows; y += 1) {
    const line = buf.getLine(buf.viewportY + y);
    out.push(line ? line.translateToString(true) : "");
  }
  while (out.length && !out[out.length - 1].trim()) out.pop();
  return out.join("\n");
}

/** Full scrollback — receipts that scrolled off the viewport still land here. */
function scrollback() {
  const buf = term.buffer.active;
  const out = [];
  for (let y = 0; y < buf.length; y += 1) {
    const line = buf.getLine(y);
    out.push(line ? line.translateToString(true) : "");
  }
  return out.join("\n").replace(/\n{3,}/g, "\n\n");
}

async function waitFor(re, timeoutMs = 30_000, on = "screen") {
  const rx = new RegExp(re, "i");
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const hay = on === "compact" ? compact(rawScan) : `${screen()}\n${scrollback()}`;
    if (rx.test(hay)) return true;
    await sleep(120);
  }
  return false;
}

const KEYS = {
  enter: "\r",
  esc: "\x1b",
  tab: "\t",
  "shift-tab": "\x1b[Z",
  down: "\x1b[B",
  up: "\x1b[A",
  left: "\x1b[D",
  right: "\x1b[C",
  "ctrl-c": "\x03",
  "ctrl-d": "\x04",
};

function dumpCodepoints(pattern) {
  const rx = new RegExp(pattern);
  for (const line of screen().split("\n")) {
    if (!rx.test(line)) continue;
    const cps = [...line.slice(0, 60)]
      .map(
        (ch) => `${JSON.stringify(ch)}=U+${ch.codePointAt(0).toString(16).toUpperCase().padStart(4, "0")}`,
      )
      .join(" ");
    log(`  [codepoints] ${JSON.stringify(line.slice(0, 80))}`);
    log(`  [codepoints] ${cps}`);
  }
}

function snap(label) {
  log(`\n----- SCREEN @ ${label} -----`);
  log(screen());
  log(`----- COMPACT (cleanTerminal + whitespace-strip, last 1600 chars) @ ${label} -----`);
  log(compact(rawScan).slice(-1600));
}

let stepNo = 0;
for (const step of steps.steps) {
  stepNo += 1;
  log(`\n===== STEP ${stepNo}: ${JSON.stringify(step)} =====`);
  if (step.waitFor) {
    const ok = await waitFor(step.waitFor, step.timeoutMs ?? 30_000, step.on ?? "screen");
    log(ok ? `[waitFor OK] ${step.waitFor}` : `[waitFor TIMEOUT] ${step.waitFor}`);
    if (!ok) {
      snap(`timeout-step${stepNo}`);
      // A RED-LINE guard: the next step sends a key that is only safe on the
      // screen this waitFor asserts. Blind-firing it could confirm a consent
      // dialog or burn a turn, so abort instead.
      if (step.abortOnTimeout) {
        log(`[ABORT] guard failed — refusing to send the following keys blind.`);
        child.kill();
        await sleep(200);
        process.exit(2);
      }
    }
  }
  if (step.mark) rawScan = "";
  if (step.type) {
    for (const ch of step.type) {
      child.write(ch);
      await sleep(30);
    }
  }
  if (step.key) {
    for (const k of step.key.split(",")) {
      child.write(KEYS[k.trim()] ?? k.trim());
      await sleep(step.keyGapMs ?? 180);
    }
  }
  if (step.settleMs) await sleep(step.settleMs);
  if (step.sample) {
    const { ms = 4000, everyMs = 80, label = `sample${stepNo}` } = step.sample;
    const t0 = Date.now();
    let prev = null;
    while (Date.now() - t0 < ms) {
      const s = screen();
      if (s !== prev) {
        log(`\n--- [${label}] t+${String(Date.now() - t0).padStart(5)}ms ---`);
        log(s);
        prev = s;
      }
      await sleep(everyMs);
    }
    log(`\n--- [${label}] sampling done (${ms}ms) ---`);
  }
  if (step.snap) snap(typeof step.snap === "string" ? step.snap : `step${stepNo}`);
  if (step.codepoints) {
    log(`\n----- CODEPOINTS /${step.codepoints}/ -----`);
    dumpCodepoints(step.codepoints);
  }
}

log("\n===== FULL SCROLLBACK =====");
log(scrollback());
log("\n===== DONE =====");
child.kill();
await sleep(200);
process.exit(0);
