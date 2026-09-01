// Q2 (2026-09 sync) — trust-dialog answer choreography at 2.1.252.
// q1 measured: the dialog boots with ❯ on "No, exit", and a Down sent
// immediately after the dialog's needle appears does NOT move the cursor
// (screen byte-identical 400ms later). Hypothesis: an input-debounce window
// after dialog paint (the 2.1.25x "stray keypress answers unread modal" fix
// class). This probe measures WHEN a Down starts registering and what the
// full affirm sequence needs.
import fs from "node:fs";
import path from "node:path";
import { Capture, Probe, KEYS, sleep } from "../../upstream-sync-2026-08/claude/driver.mjs";

const CWD = process.argv[2]; // use a FRESH dir so the dialog appears
const OUT_DIR = new URL(".", import.meta.url).pathname;
fs.mkdirSync(CWD, { recursive: true });

const cap = new Capture(
  path.join(OUT_DIR, "q2-trust-answer.capture.txt"),
  "Q2 — claude 2.1.252 trust dialog answer choreography",
);
cap.add("cwd", CWD.replace(process.env.HOME, "$HOME"));

const p = new Probe({ cwd: CWD, args: ["--permission-mode", "default"] });
const trust = await p.waitFor(/Quick safety check|trust this folder/i, 45_000);
cap.add("trust dialog appeared?", String(trust));
if (!trust) {
  cap.save();
  p.kill();
  process.exit(1);
}

const affirmFocused = () =>
  p
    .screen()
    .split("\n")
    .some((l) => /❯\s*Yes, I trust this folder/i.test(l));

// Send Down at increasing delays after dialog detection; record when it lands.
const attempts = [];
let landedAtMs = null;
const t0 = Date.now();
for (const waitMs of [500, 1000, 1500, 2000, 3000, 4000]) {
  const target = t0 + waitMs;
  const gap = target - Date.now();
  if (gap > 0) await sleep(gap);
  p.write(KEYS.down);
  await sleep(350);
  const focused = affirmFocused();
  attempts.push(`Down at +${waitMs}ms (sent t+${Date.now() - t0 - 350}ms): affirmFocused=${focused}`);
  if (focused) {
    landedAtMs = waitMs;
    break;
  }
}
cap.add("Down attempts", attempts.join("\n"));
cap.frame(p, "after Down attempts", { attrs: false });

if (!affirmFocused()) {
  // Fallback channels: Tab, then Up (wrap), then j.
  for (const [name, key] of [["tab", KEYS.tab], ["up", KEYS.up], ["j", "j"]]) {
    p.write(key);
    await sleep(400);
    cap.add(`fallback ${name}: affirmFocused?`, String(affirmFocused()));
    if (affirmFocused()) break;
  }
  cap.frame(p, "after fallbacks", { attrs: false });
}

if (affirmFocused()) {
  p.write(KEYS.enter);
  const ok = await p.waitFor(/for shortcuts|Welcome back|Try "|\? for/i, 30_000);
  await sleep(2000);
  cap.add("reached composer after affirm+Enter?", String(ok));
  cap.frame(p, "post-trust screen", { attrs: true });
  // Bonus: idle footer needles for the statusline question's CONTROL arm.
  cap.add(
    "idle footer needles (control, no --settings)",
    ["\\? for shortcuts", "esc to interrupt", "manual mode|mode on"]
      .map((s) => `${s}: ${new RegExp(s, "i").test(p.screen())}`)
      .join("\n"),
  );
} else {
  cap.add("VERDICT", "no channel moved the cursor — dialog may require different input entirely");
}
cap.add("summary", `debounce landedAt=${landedAtMs === null ? "never-via-down-sweep" : `${landedAtMs}ms`}; exited=${p.exited}`);
cap.addRaw("RAW pty stream (whole session)", p.raw);
cap.save();
p.kill();
process.exit(0);
