// Q5 (2026-09 sync, SL-2) — can readiness CONFIDENCE be restored by adding
// footer tokens, or is the input CHANNEL the thing that broke?
//
// SL-2's premise (from F5): under production spawns only `for agents` can still
// match `idlePromptModelHints`, so the fix is multi-token redundancy. Replaying
// q1a's captured raw stream through the production detector contradicted that
// before a line was written: on the POST-TURN idle tail the forward-700 window
// after the last composer glyph is literally `"❯ "` — no footer at all, so NO
// token could match, however many we add. Hypothesis: 2.1.252's alt-screen
// differential paint (F3) emits the footer BEFORE the composer glyph and then
// homes the cursor to the composer, so the STREAM no longer preserves the
// screen's layout — while the GRID reconstructs it exactly.
//
// This probe decides it against the live binary, at three sampling moments:
//   A. boot idle              — the full-screen paint (footer expected AFTER ❯)
//   B. post-turn idle, 40s    — the differential repaint + the idle heartbeat
//   C. each permission mode   — Shift+Tab walk, footers under the statusLine
// Every sample runs BOTH channels through the SAME production function
// (`detectIdlePromptForProvider` from dist/) — the raw pty tail, and the
// rendered grid — so the comparison is apples to apples.
//
// Production shape = `--settings {statusLine only}`: Sonata injects a statusLine
// on EVERY claude spawn, and q1's A/B measured that config suppressing
// `? for shortcuts`, `esc to interrupt` and the `◐ … · /effort` line.
//
// Scratch dirs live under /private/tmp/ (NOT the agent scratchpad, whose path
// embeds the username) because this capture becomes a tracked fixture and the
// pre-push leak fence scans blob content.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { Capture, Probe, KEYS, sleep } from "./driver.mjs";

const OUT_DIR = new URL(".", import.meta.url).pathname;
const APP_DIR = new URL("../../../app/", import.meta.url).pathname;
const require = createRequire(APP_DIR + "package.json");
const { detectIdlePromptForProvider } = require(APP_DIR + "dist/runtime");
const { cleanTerminal } = require(APP_DIR + "dist/runtime/terminal-host/tui-parsers-common");

const EXPECT_VERSION = "2.1.252";
const ROOT = "/private/tmp/sonata-sync-2026-09/sl2-readiness";

const version = execFileSync("claude", ["--version"], { encoding: "utf8" }).trim();
if (!version.startsWith(EXPECT_VERSION)) {
  console.error(`binary moved off ${EXPECT_VERSION}: ${version}`);
  process.exit(2);
}

fs.rmSync(ROOT, { recursive: true, force: true });
const workspace = path.join(ROOT, "ws");
fs.mkdirSync(workspace, { recursive: true });
const settingsPath = path.join(ROOT, "statusline-only-settings.json");
fs.writeFileSync(
  settingsPath,
  JSON.stringify({ statusLine: { type: "command", command: "echo sonata-status-probe" } }),
);

// Sanitize BOTH forms of the username: the $HOME path and the munged
// `-Users-<user>-…` form an agent scratchpad path carries.
const HOME = os.homedir();
const USER = path.basename(HOME);
const scrub = (s) =>
  s
    .split(HOME)
    .join("$HOME")
    .split(`-Users-${USER}-`)
    .join("-Users-$USER-")
    .replace(/session_[A-Za-z0-9]+/g, "session_<redacted>");

const cap = new Capture(
  path.join(OUT_DIR, "q5-readiness-channel.capture.txt"),
  "Q5 — readiness CHANNEL (raw stream vs grid) under a production-shape spawn, claude 2.1.252",
);
cap.add("claude --version", version);
cap.add("settings", fs.readFileSync(settingsPath, "utf8"));
cap.add("workspace", workspace);

// The production regex today (terminal-host.ts, claude profile) — mirrored here
// so a sample can report WHICH alternation carried a medium verdict.
const TOKENS = {
  "for agents": /for agents/i,
  shortcuts: /shortcuts/i,
  effort: /effort/i,
  "model name": /opus|sonnet|haiku|fable/i,
  "effort word": /xhigh|high|medium|low/i,
  tilde: /~/,
  "mode line (glyph-anchored)": /[⏸⏵]\s*(?:accept\s*edits\s*on|manual\s*mode\s*on|plan\s*mode\s*on|auto\s*mode\s*on)/i,
};

/** The forward-700 window `detectIdlePrompt` actually tests, for either channel. */
function promptTail(text) {
  const recent = cleanTerminal(text).slice(-8000);
  const last = Math.max(recent.lastIndexOf("❯"), recent.lastIndexOf("›"), recent.lastIndexOf(">"));
  return last >= 0 ? recent.slice(last, last + 700) : "";
}

function sample(p, label) {
  const raw = p.raw;
  const grid = p.screen();
  const rawHint = detectIdlePromptForProvider(raw, "claude");
  const gridHint = detectIdlePromptForProvider(grid, "claude");
  const rawTail = promptTail(raw);
  const gridTail = promptTail(grid);
  const hits = (tail) =>
    Object.entries(TOKENS)
      .filter(([, re]) => re.test(tail))
      .map(([name]) => name)
      .join(", ") || "(none)";
  return [
    `${label}`,
    `  RAW   ready=${rawHint.ready} confidence=${rawHint.confidence} hint=${rawHint.hasModelOrCwdHint}`,
    `        promptTail=${JSON.stringify(rawTail.slice(0, 240))}`,
    `        tokens: ${hits(rawTail)}`,
    `  GRID  ready=${gridHint.ready} confidence=${gridHint.confidence} hint=${gridHint.hasModelOrCwdHint}`,
    `        promptTail=${JSON.stringify(gridTail.slice(0, 240))}`,
    `        tokens: ${hits(gridTail)}`,
  ].join("\n");
}

/** Boot with the 2.1.252 trust dialog answered by the grid-verified walk. */
async function bootProduction() {
  const p = new Probe({
    cwd: workspace,
    args: ["--permission-mode", "default", "--settings", settingsPath],
  });
  const trust = await p.waitFor(/Quick safety check|trust this folder/i, 45_000);
  if (trust) {
    const affirmFocused = () =>
      p.screen().split("\n").some((l) => /❯\s*Yes, I trust this folder/i.test(l));
    let landed = false;
    for (let i = 0; i < 6 && !landed; i++) {
      await sleep(500);
      p.write(KEYS.down);
      await sleep(350);
      landed = affirmFocused();
    }
    if (landed) {
      p.write(KEYS.enter);
      await sleep(1500);
    }
    cap.add("boot — trust dialog answered?", String(landed));
  }
  const ok = await p.waitFor(/Try "|for agents|mode on/i, 60_000);
  cap.add("boot — reached composer?", `${ok} (trustDialogSeen=${trust})`);
  await sleep(2500);
  return p;
}

const p = await bootProduction();

// ── A. boot idle — the full-screen paint ───────────────────────────────────
cap.frame(p, "A — boot idle frame");
const aSamples = [];
for (let i = 0; i < 3; i++) {
  aSamples.push(sample(p, `A${i} boot idle t+${i * 3}s`));
  await sleep(3000);
}
cap.add("A — boot idle: raw-tail vs grid verdicts", aSamples.join("\n\n"));

// ── B. post-turn idle — the differential repaint + heartbeat ────────────────
p.paste("Reply with exactly: OK");
await sleep(300);
p.write(KEYS.enter);
const busy = await p.waitFor(/esc to interrupt|✢|✳|✶|✻|✽/i, 20_000);
cap.add("B — busy seen?", String(busy));
const backToIdle = await p.waitFor(/❯\s*$/m, 60_000);
cap.add("B — composer back?", String(backToIdle));
await sleep(2000);
cap.frame(p, "B — post-turn idle frame");
const bSamples = [];
for (let i = 0; i < 14; i++) {
  bSamples.push(sample(p, `B${i} post-turn idle t+${i * 3}s`));
  await sleep(3000);
}
cap.add("B — post-turn idle over 42s: raw-tail vs grid verdicts", bSamples.join("\n\n"));

// The stream slice that a production `rawTail` would hold at this moment, and
// what the whole-session raw looks like once cleaned — the evidence for the
// paint-order claim.
cap.add("B — cleaned whole-session stream (verbatim)", JSON.stringify(cleanTerminal(p.raw)));

// ── C. the four permission modes' footers under the statusLine ─────────────
// Shift+Tab steps the native cycle: manual → accept edits → plan → auto → manual
// (auto is account-gated; whatever the account reaches is what gets captured).
const modeSamples = [];
const footerLine = () =>
  p
    .screen()
    .split("\n")
    .filter((l) => /mode on|accept edits on|for agents/i.test(l))
    .map((l) => JSON.stringify(l.trim()))
    .join(" | ") || "(no mode line on screen)";
modeSamples.push(`C0 (launch mode)  ${footerLine()}`);
for (let step = 1; step <= 4; step++) {
  p.write(KEYS.shiftTab);
  await sleep(1500);
  modeSamples.push(`C${step} (after Shift+Tab ×${step})  ${footerLine()}`);
  cap.frame(p, `C${step} — footer after Shift+Tab ×${step}`);
  cap.add(`C${step} — verdicts`, sample(p, `C${step}`));
}
cap.add("C — permission-mode footers under the statusLine", modeSamples.join("\n"));

cap.addRaw("RAW pty stream (whole session)", p.raw);
cap.save();
// Re-scrub with the stricter sanitizer (the driver's own only knows $HOME).
fs.writeFileSync(cap.path, scrub(fs.readFileSync(cap.path, "utf8")));

// The raw stream, on its own, for replay through production code (q6) and as
// the source of the tracked MEASURED fixture.
const rawPath = path.join(OUT_DIR, "q5-production-idle.raw.txt");
fs.writeFileSync(rawPath, scrub(JSON.stringify(p.raw)));
console.log(`wrote ${rawPath}`);

p.kill();
console.log("q5 done");
process.exit(0);
