// Q1 (2026-09 sync) — does a configured statusLine suppress the footer keyboard
// hints at claude 2.1.252? The docs claim it hides "esc to interrupt" and the
// "? for shortcuts" fallback — a direct collision with Sonata's readiness needle
// (idlePromptModelHints) and activityHints, since Sonata injects a statusLine
// command on EVERY spawn. The 2026-08 q5 footer capture booted WITHOUT
// --settings, so it cannot answer this; field behavior at 2.1.220 (footer intact
// under production spawns) is the prior.
//
// Design: strict A/B, one variable. B = control (no settings). A = minimal
// settings carrying ONLY a statusLine command. Then A submits a trivial prompt
// so the working-state hints ("esc to interrupt") are captured too.
import fs from "node:fs";
import path from "node:path";
import { Capture, Probe, bootTrusted, KEYS, sleep } from "./driver.mjs";

const CWD = process.argv[2];
const OUT_DIR = new URL(".", import.meta.url).pathname;
fs.mkdirSync(CWD, { recursive: true });

const settingsPath = path.join(CWD, "statusline-only-settings.json");
fs.writeFileSync(
  settingsPath,
  JSON.stringify({ statusLine: { type: "command", command: "echo sonata-status-probe" } }),
);

const NEEDLES = {
  shortcuts: /\? for shortcuts/i,
  escInterrupt: /esc to interrupt/i,
  statusline: /sonata-status-probe/,
};

function footerReport(cap, p, label) {
  const lines = p.screen().split("\n");
  const hits = lines.filter((l) => /shortcuts|agents|mode|interrupt|sonata-status/i.test(l));
  cap.add(
    `${label} — footer-region lines (byte view)`,
    hits.length
      ? hits
          .map(
            (l) =>
              `${JSON.stringify(l)}\n    codepoints: ${[...l]
                .map((c) => (c.codePointAt(0) > 126 ? `U+${c.codePointAt(0).toString(16).toUpperCase()}` : c))
                .join("")}`,
          )
          .join("\n")
      : "(no matching lines)",
  );
  cap.add(
    `${label} — needle verdicts (on full screen)`,
    Object.entries(NEEDLES)
      .map(([k, re]) => `${k}: ${re.test(p.screen())}`)
      .join("\n"),
  );
}

// ---- B: control, no settings ----
{
  const cap = new Capture(
    path.join(OUT_DIR, "q1b-control-footer.capture.txt"),
    "Q1-B — claude 2.1.252 idle footer, NO --settings (control)",
  );
  cap.add("cwd", CWD.replace(process.env.HOME, "$HOME"));
  const p = await bootTrusted(CWD, cap);
  cap.frame(p, "B frame 1 — idle, ~2.5s after composer", { attrs: true });
  await sleep(4000);
  cap.frame(p, "B frame 2 — idle, ~7s", { attrs: true });
  footerReport(cap, p, "B idle");
  cap.addRaw("RAW pty stream (whole session)", p.raw);
  cap.save();
  p.kill();
}

// ---- A: statusLine-only settings ----
{
  const cap = new Capture(
    path.join(OUT_DIR, "q1a-statusline-footer.capture.txt"),
    "Q1-A — claude 2.1.252 footer WITH --settings {statusLine only}",
  );
  cap.add("cwd", CWD.replace(process.env.HOME, "$HOME"));
  cap.add("settings", fs.readFileSync(settingsPath, "utf8"));
  const p = await bootTrusted(CWD, cap, { extraArgs: ["--settings", settingsPath] });
  cap.frame(p, "A frame 1 — idle, ~2.5s after composer", { attrs: true });
  await sleep(4000);
  cap.frame(p, "A frame 2 — idle, ~7s", { attrs: true });
  footerReport(cap, p, "A idle");

  // Working-state hints: submit a trivial prompt, sample the screen while busy.
  p.paste("Reply with exactly: OK");
  await sleep(300);
  p.write(KEYS.enter);
  const sawBusy = await p.waitFor(/esc to interrupt|✢|✳|✶|✻|✽/i, 20_000);
  cap.add("A working — busy signal seen within 20s?", String(sawBusy));
  cap.frame(p, "A frame 3 — during turn (first busy sample)", { attrs: true });
  await sleep(1500);
  cap.frame(p, "A frame 4 — during turn (+1.5s)", { attrs: true });
  footerReport(cap, p, "A working");
  const rawBusyHints = {
    escInterruptInRaw: NEEDLES.escInterrupt.test(p.raw),
    shortcutsInRaw: NEEDLES.shortcuts.test(p.raw),
    statuslineInRaw: NEEDLES.statusline.test(p.raw),
  };
  await p.waitFor(/OK/, 60_000);
  await sleep(3000);
  cap.frame(p, "A frame 5 — back to idle after turn", { attrs: true });
  footerReport(cap, p, "A idle-after-turn");
  cap.add(
    "A raw-stream needle verdicts (whole session)",
    Object.entries(rawBusyHints)
      .map(([k, v]) => `${k}: ${v}`)
      .join("\n"),
  );
  cap.addRaw("RAW pty stream (whole session)", p.raw);
  cap.save();
  p.kill();
}

console.log("q1 done");
process.exit(0);
