// Q7b (2026-09 sync, SL-2) — the arm q7 could not reach: a LIVE approval panel.
//
// q7 measured claude 2.1.252 ignoring mouse reports at the trust dialog (which
// is painted on the NORMAL screen, with no mouse tracking on at all) and at an
// idle composer under `?1000h/?1002h/?1003h/?1006h` (zero bytes back from move,
// click, wheel, and a click on `← for agents`). The surface that matters most
// is the one neither arm reached: a tool-approval panel — a real menu, with
// rows, sitting inside the alt-screen frame while mouse tracking is on.
//
// Arm C drives claude to a Write approval, then hovers and clicks the DENY row.
// Deny is chosen deliberately: if a click can answer this panel, the probe
// learns it by REFUSING an edit in a throwaway dir — never by approving one.
// (Run 1 measured the 2.1.252 create panel's rows: `1. Yes` /
// `2. Yes, and switch to accept edits …` / `3. No` — digits intact here, unlike
// the trust screen — so the deny needle matches both wordings.) REPORT ONLY.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { Capture, Probe, KEYS, sleep } from "./driver.mjs";

const OUT_DIR = new URL(".", import.meta.url).pathname;
const EXPECT_VERSION = "2.1.252";
const ROOT = "/private/tmp/sonata-sync-2026-09/sl2-mouse-approval";

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
  path.join(OUT_DIR, "q7b-mouse-approval.capture.txt"),
  "Q7b — can a mouse click answer a LIVE claude 2.1.252 approval panel? (SL-2 audit, report-only)",
);
cap.add("claude --version", version);

const sgrClick = (col, row, b = 0) => `\x1b[<${b};${col};${row}M\x1b[<${b};${col};${row}m`;
const sgrMove = (col, row) => `\x1b[<35;${col};${row}M`;

const p = new Probe({
  cwd: workspace,
  args: ["--permission-mode", "default", "--settings", settingsPath],
});

// Boot: answer the trust dialog with the grid-verified keyboard walk (F1c).
const trust = await p.waitFor(/Quick safety check|trust this folder/i, 45_000);
if (trust) {
  for (let i = 0; i < 6; i++) {
    await sleep(500);
    p.write(KEYS.down);
    await sleep(350);
    if (/❯\s*Yes, I trust this folder/i.test(p.screen())) {
      p.write(KEYS.enter);
      break;
    }
  }
  await sleep(2000);
}
cap.add("boot — composer reached?", String(await p.waitFor(/for agents|mode on/i, 60_000)));
await sleep(2000);

// Drive a Write approval.
p.paste("Create a file named hello.txt in this folder containing the word hi. Do it now.");
await sleep(400);
p.write(KEYS.enter);
const panel = await p.waitFor(/Do you want to (create|make)|Yes, and|tell Claude what to do differently/i, 90_000);
cap.add("C — approval panel painted?", String(panel));
if (!panel) {
  cap.frame(p, "C — NO PANEL (screen at timeout)");
  cap.save();
  fs.writeFileSync(cap.path, scrub(fs.readFileSync(cap.path, "utf8")));
  p.kill();
  console.log("q7b: no panel");
  process.exit(1);
}
await sleep(1200);
cap.frame(p, "C1 — approval panel before any mouse input");
const before = p.screen();
const rawBefore = p.raw.length;
cap.add(
  "C — mouse modes still armed at the panel",
  ["?1000h", "?1002h", "?1003h", "?1006h", "?1049h"]
    .map((m) => `${m}: ${p.raw.includes(`\x1b[${m}`)}`)
    .join("\n"),
);

const lines = () => p.screen().split("\n");
const rowIndex = (re) => lines().findIndex((l) => re.test(l));
const DENY_ROW_RE = /tell Claude what to do differently|^\s*3\.\s*No\b|^\s*❯?\s*No\b/i;
const denyRow = rowIndex(DENY_ROW_RE);
const approveRow = rowIndex(/^\s*❯?\s*\d*\.?\s*Yes\b/i);
cap.add(
  "C — row geometry (0-based)",
  `approve-ish row=${approveRow} ${JSON.stringify(lines()[approveRow] ?? null)}\n` +
    `deny row=${denyRow} ${JSON.stringify(lines()[denyRow] ?? null)}`,
);

if (denyRow >= 0) {
  const col = Math.max(4, (lines()[denyRow] ?? "").search(/\S/) + 3);
  p.write(sgrMove(col, denyRow + 1));
  await sleep(700);
  const afterHover = p.screen();
  cap.add("C2 — screen changed by HOVER over the deny row?", String(afterHover !== before));

  p.write(sgrClick(col, denyRow + 1));
  await sleep(1500);
  const afterClick = p.screen();
  cap.frame(p, "C3 — approval panel after a left CLICK on the deny row");
  cap.add(
    "C — VERDICT: did the click answer or move the approval prompt?",
    [
      `screen changed by hover: ${afterHover !== before}`,
      `screen changed by click: ${afterClick !== afterHover}`,
      `cursor now on the deny row: ${afterClick.split("\n").some((l) => l.includes("❯") && DENY_ROW_RE.test(l))}`,
      `panel dismissed (answered): ${!/Do you want to create/i.test(afterClick)}`,
      `bytes emitted by the CLI across the mouse window: ${p.raw.length - rawBefore}`,
      `pty exited: ${p.exited}`,
    ].join("\n"),
  );
  cap.add("C — raw emitted during the mouse window", JSON.stringify(p.raw.slice(rawBefore)));
}

// Leave the session clean: Esc out of the panel.
p.write(KEYS.esc);
await sleep(1200);
cap.frame(p, "C4 — after Esc (panel closed by the keyboard)");
cap.add("C — hello.txt created?", String(fs.existsSync(path.join(workspace, "hello.txt"))));

cap.save();
fs.writeFileSync(cap.path, scrub(fs.readFileSync(cap.path, "utf8")));
p.kill();
console.log("q7b done");
process.exit(0);
