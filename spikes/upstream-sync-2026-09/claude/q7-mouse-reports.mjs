// Q7 (2026-09 sync, SL-2) — does claude 2.1.252 ACT on mouse reports?
//
// F3 measured the fullscreen boot turning on `?1000h ?1002h ?1003h ?1006h`
// (press/release + drag + ANY-MOTION, SGR encoding). Sonata's renderer terminal
// is a stock `@xterm/xterm`, whose CoreMouseService encodes every such event and
// pushes it through `coreService.triggerDataEvent` → `Terminal.onData` → the
// pty. So a click inside Sonata's Terminal pane REACHES the CLI. The open
// question this probe answers is the consequential half: does the CLI DO
// anything with it — in particular, can a click answer a waiting prompt?
//
// Two arms, both on a throwaway /private/tmp dir:
//   A. the workspace-trust dialog — the highest-stakes prompt on screen. Click
//      the affirm row. If focus moves, or the dialog is answered, mouse input
//      is a prompt-answering channel.
//   B. an idle composer — click in the transcript, wheel-scroll, move the mouse.
//      Whatever paints back is what a stray GUI mouse event does to a live
//      session.
//
// Reports are SGR (`CSI < b ; col ; row M/m`), 1-based, matching `?1006h`.
// REPORT ONLY: this probe changes nothing in Sonata.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { Capture, Probe, KEYS, sleep } from "./driver.mjs";

const OUT_DIR = new URL(".", import.meta.url).pathname;
const EXPECT_VERSION = "2.1.252";
const ROOT = "/private/tmp/sonata-sync-2026-09/sl2-mouse";

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
  path.join(OUT_DIR, "q7-mouse-reports.capture.txt"),
  "Q7 — does claude 2.1.252 act on forwarded mouse reports? (SL-2 audit, report-only)",
);
cap.add("claude --version", version);

/** SGR press+release of button `b` at 1-based (col,row). */
const sgrClick = (col, row, b = 0) => `\x1b[<${b};${col};${row}M\x1b[<${b};${col};${row}m`;
/** SGR motion with no button held (the `?1003h` any-motion class). */
const sgrMove = (col, row) => `\x1b[<35;${col};${row}M`;
/** SGR wheel-up / wheel-down. */
const sgrWheel = (col, row, up) => `\x1b[<${up ? 64 : 65};${col};${row}M`;

function rowOf(p, re) {
  const lines = p.screen().split("\n");
  const index = lines.findIndex((l) => re.test(l));
  return { index, text: index >= 0 ? lines[index] : null };
}

// ── Arm A: the trust dialog ────────────────────────────────────────────────
{
  const p = new Probe({
    cwd: workspace,
    args: ["--permission-mode", "default", "--settings", settingsPath],
  });
  const sawDialog = await p.waitFor(/Quick safety check|trust this folder/i, 45_000);
  cap.add("A — trust dialog painted?", String(sawDialog));
  const modes = ["?1000h", "?1002h", "?1003h", "?1006h", "?1049h"].map(
    (m) => `${m}: ${p.raw.includes(`\x1b[${m}`)}`,
  );
  cap.add("A — mouse/alt-screen modes requested by the CLI", modes.join("\n"));

  // Past the input-arming window measured in F1b (a key at +0ms is swallowed).
  await sleep(1200);
  const before = p.screen();
  cap.frame(p, "A1 — dialog before any mouse input");

  const affirm = rowOf(p, /Yes, I trust this folder/i);
  const decline = rowOf(p, /No, exit/i);
  cap.add(
    "A — row geometry (0-based screen rows)",
    `affirm row=${affirm.index} ${JSON.stringify(affirm.text)}\n` +
      `decline row=${decline.index} ${JSON.stringify(decline.text)}`,
  );

  // Hover first (any-motion is ON, so a GUI that merely moves the pointer over
  // the row already sends this), then a left click ON the affirm row's label.
  const col = Math.max(4, (affirm.text ?? "").indexOf("Yes") + 1);
  p.write(sgrMove(col, affirm.index + 1));
  await sleep(700);
  const afterHover = p.screen();
  cap.add("A2 — screen changed by HOVER over the affirm row?", String(afterHover !== before));

  p.write(sgrClick(col, affirm.index + 1));
  await sleep(1200);
  const afterClick = p.screen();
  cap.frame(p, "A3 — dialog after a left CLICK on the affirm row");
  const focusedAffirm = /❯\s*Yes, I trust this folder/i.test(afterClick);
  const dialogGone = !/Quick safety check|trust this folder/i.test(afterClick);
  cap.add(
    "A — VERDICT: did the click answer or move the prompt?",
    [
      `screen changed by click: ${afterClick !== afterHover}`,
      `cursor moved to the affirm row: ${focusedAffirm}`,
      `dialog dismissed (answered): ${dialogGone}`,
      `pty exited: ${p.exited} ${JSON.stringify(p.exitInfo)}`,
    ].join("\n"),
  );

  // What did the CLI emit in response, if anything?
  cap.add("A — raw emitted during the mouse window", JSON.stringify(p.raw.slice(-600)));

  // Leave the dir trusted for arm B — answer with the keyboard walk.
  if (!dialogGone && !p.exited) {
    for (let i = 0; i < 6; i++) {
      await sleep(400);
      p.write(KEYS.down);
      await sleep(300);
      if (/❯\s*Yes, I trust this folder/i.test(p.screen())) {
        p.write(KEYS.enter);
        break;
      }
    }
    await sleep(2000);
  }
  cap.add("A — composer reached after the keyboard answer?", String(/for agents|mode on/i.test(p.screen())));
  p.kill();
  await sleep(500);
}

// ── Arm B: an idle composer ────────────────────────────────────────────────
{
  const p = new Probe({
    cwd: workspace,
    args: ["--permission-mode", "default", "--settings", settingsPath],
  });
  const ok = await p.waitFor(/for agents|mode on/i, 60_000);
  cap.add("B — composer reached (dir already trusted)?", String(ok));
  await sleep(2500);
  cap.frame(p, "B1 — idle composer before any mouse input");
  const before = p.screen();
  const rawBefore = p.raw.length;

  p.write(sgrMove(40, 10));
  await sleep(400);
  const afterMove = p.screen();

  p.write(sgrClick(40, 10));
  await sleep(600);
  const afterClick = p.screen();

  p.write(sgrWheel(40, 10, true));
  await sleep(400);
  p.write(sgrWheel(40, 10, false));
  await sleep(600);
  const afterWheel = p.screen();

  // Right-click, and a click on the footer's `← for agents` affordance — the
  // two spots where "a click did something" would matter most.
  const agents = rowOf(p, /for agents/i);
  if (agents.index >= 0) {
    const col = Math.max(4, (agents.text ?? "").indexOf("for agents") + 1);
    p.write(sgrClick(col, agents.index + 1));
    await sleep(900);
  }
  const afterAgentsClick = p.screen();

  cap.frame(p, "B2 — idle composer after move + click + wheel + agents-click");
  cap.add(
    "B — VERDICT: what did mouse input change?",
    [
      `screen changed by MOVE: ${afterMove !== before}`,
      `screen changed by CLICK: ${afterClick !== afterMove}`,
      `screen changed by WHEEL: ${afterWheel !== afterClick}`,
      `screen changed by CLICK on "← for agents": ${afterAgentsClick !== afterWheel}`,
      `bytes emitted by the CLI across the whole mouse window: ${p.raw.length - rawBefore}`,
    ].join("\n"),
  );
  cap.add("B — raw emitted during the mouse window", JSON.stringify(p.raw.slice(rawBefore)));
  p.kill();
}

cap.save();
fs.writeFileSync(cap.path, scrub(fs.readFileSync(cap.path, "utf8")));
console.log("q7 done");
process.exit(0);
