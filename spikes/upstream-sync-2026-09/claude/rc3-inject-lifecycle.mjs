// RC3 (2026-09 sync, SL-11) — the Remote Control LIFECYCLE under Sonata's own
// injection path, at claude 2.1.258.
//
// WHY. `remote-control-disconnect.mjs` is the last standing red smoke; it fails
// at "Timed out waiting for RC connected (url)". That smoke does exactly what
// production does — `TerminalHost.injectRemoteControl()` on a session spawned
// WITHOUT `--remote-control` — so the failure is a statement about the
// mid-session path, not about the boot path (RC1 measured the boot banner still
// reaching the raw stream verbatim under `--remote-control`).
//
// Every write here is byte-identical to `injectRemoteControl`: a bracketed-paste
// `/remote-control` frame, then `\x1b[13u` (CSI-u Enter) 120ms later. Anything
// looser would measure a different path than the one that is failing.
//
// Arms:
//   A — INJECT FROM OFF. Idle composer, no flag. Does `/remote-control` connect
//       (banner + URL into the stream, as at 2.1.195), or does 2.1.25x answer
//       with a DIALOG that waits for a choice? Sampled every 500ms for 60s on
//       all three channels + the composer glyph (a dialog that eats the composer
//       is also an approval-adjacent hazard, so it is measured, not inferred).
//   B — PANEL FROM ON. Spawn `--remote-control`, wait for the connect, then
//       inject. Capture the panel's rows VERBATIM, then replay the smoke's exact
//       walk (Up, Up, Enter at its exact delays) and record where it lands.
//   C — RECONNECT. In B's session, after the disconnect, inject again: does the
//       banner + URL return to the stream (the "fresh scan window per
//       transition" assumption in setRemoteControlActive)?
//
// Read-only w.r.t. the user's claude config (scratch `--settings`, byte-compare
// at the end). Scratch dirs are /private/tmp/... (never the agent scratchpad,
// whose path embeds the username): these frames become findings and the
// pre-push leak fence scans blob content.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";

const OUT_DIR = new URL(".", import.meta.url).pathname;
const APP_DIR = new URL("../../../app/", import.meta.url).pathname;
const require = createRequire(APP_DIR + "package.json");
const {
  ensureClaudeRuntimeSettings,
  hasRemoteControlDisconnect,
  compactRemoteControlScan,
  REMOTE_CONTROL_SCAN_LIMIT,
} = require(APP_DIR + "dist/runtime");

const { Probe, Capture, KEYS, sleep } = await import("../../upstream-sync-2026-08/claude/driver.mjs");

/** The RETIRED stream reader, kept LOCAL and verbatim. SL-11 moved the link read
 *  to the grid (findRemoteControlUrlOnScreen) precisely because this function
 *  goes blind on a differential repaint — and this probe exists to measure that,
 *  so it must keep calling the broken thing, not the fixed one. Inlined rather
 *  than imported so the probe still runs after the export was removed. */
function findRemoteControlUrl(raw) {
  return (
    raw
      .replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "")
      .match(/https:\/\/claude\.(?:ai|com)\/code\/session_[A-Za-z0-9_-]+/)?.[0] ?? null
  );
}

const EXPECT_VERSION = "2.1.258";
const ROOT = "/private/tmp/sonata-sync-2026-09/rc-inject";
const COLS = 120;
const ROWS = 40;

// Verbatim from terminal-host.ts — the probe must write what production writes.
const BRACKETED_PASTE_START = "\x1b[200~";
const BRACKETED_PASTE_END = "\x1b[201~";
const CSI_U_ENTER = "\x1b[13u";

const HOME = os.homedir();
const USER_MUNGED = `-${HOME.replace(/\//g, "-").replace(/^-/, "")}-`;
const sanitize = (v) => String(v).split(HOME).join("$HOME").split(USER_MUNGED).join("-$USER_MUNGED-");
const redactSession = (v) => String(v).replace(/session_[A-Za-z0-9_-]+/g, "session_<REDACTED>");
const scrub = (v) => redactSession(sanitize(v));

function readVersion() {
  return execFileSync("claude", ["--version"], { encoding: "utf8" }).trim();
}
function pinVersionOrExit(where) {
  const version = readVersion();
  if (!version.startsWith(EXPECT_VERSION)) {
    console.log(JSON.stringify({ success: false, reason: `binary moved off ${EXPECT_VERSION} (${where})`, version }));
    process.exit(2);
  }
  return version;
}
const version = pinVersionOrExit("probe start");

const USER_SETTINGS = path.join(HOME, ".claude", "settings.json");
const settingsBefore = fs.readFileSync(USER_SETTINGS, "utf8");

function footerPill(p) {
  for (const row of p.attrRows()) {
    for (const mark of row.marks) {
      if (mark.chars.includes("/rc")) {
        return { y: row.y, chars: mark.chars, key: mark.key, rowText: row.text.trim() };
      }
    }
  }
  return null;
}

function rcGridRows(screen) {
  return screen
    .split("\n")
    .map((line, y) => ({ y, text: line.trim() }))
    .filter(
      (r) =>
        /remote control/i.test(r.text) ||
        /\/rc\b/.test(r.text) ||
        /claude\.(ai|com)\/code\/session_/.test(r.text) ||
        /Keep working from anywhere/i.test(r.text) ||
        /disconnect/i.test(r.text),
    );
}

/** Rows that look like a selectable menu — the `❯` cursor row plus its
 *  neighbours. A dialog Sonata does not know about is exactly what would eat an
 *  injected command, so the menu shape is recorded whether or not one is
 *  expected. */
function menuRows(screen) {
  const lines = screen.split("\n");
  const idx = lines.findIndex((l) => /❯/.test(l));
  if (idx < 0) return null;
  return lines
    .slice(Math.max(0, idx - 4), idx + 8)
    .map((l, i) => ({ y: Math.max(0, idx - 4) + i, text: l.trimEnd() }));
}

function sample(p, scan) {
  const screen = p.screen();
  return {
    rawTail: {
      url: findRemoteControlUrl(scan),
      off: hasRemoteControlDisconnect(compactRemoteControlScan(scan)),
    },
    rawAll: {
      url: findRemoteControlUrl(p.raw),
      off: hasRemoteControlDisconnect(compactRemoteControlScan(p.raw)),
    },
    grid: {
      rows: rcGridRows(screen),
      urlOnGrid: screen.match(/https:\/\/claude\.(?:ai|com)\/code\/session_[A-Za-z0-9_-]+/)?.[0] ?? null,
      offOnGrid: /Remote Control disconnected/.test(screen),
    },
    pill: footerPill(p),
  };
}

function armScan(p) {
  const state = { scan: "" };
  p.pty.onData((c) => {
    state.scan = (state.scan + c).slice(-REMOTE_CONTROL_SCAN_LIMIT);
  });
  return state;
}

/** `TerminalHost.injectRemoteControl`'s write sequence, byte for byte. */
async function injectRemoteControl(p) {
  p.write(`${BRACKETED_PASTE_START}/remote-control${BRACKETED_PASTE_END}`);
  await sleep(120);
  p.write(CSI_U_ENTER);
}

/** Sample every `everyMs` for `windowMs`, framing whenever the RC surface moves. */
async function watch(p, scan, cap, label, { windowMs, everyMs = 500 }) {
  const series = [];
  const t0 = Date.now();
  let lastKey = "";
  while (Date.now() - t0 < windowMs) {
    const s = sample(p, scan.scan);
    const atMs = Date.now() - t0;
    series.push({ atMs, ...s });
    const key = JSON.stringify([s.grid.rows.map((r) => r.text), s.pill?.key ?? null, s.grid.offOnGrid]);
    if (key !== lastKey) {
      cap.frame(p, `${label} — RC surface changed at +${atMs}ms`, { attrs: true });
      lastKey = key;
    }
    await sleep(everyMs);
  }
  cap.add(`${label} — channel series`, scrub(JSON.stringify(series, null, 2)));
  return series;
}

function verdict(series) {
  const first = (pred) => series.find(pred) ?? null;
  const fGrid = first((s) => s.grid.urlOnGrid);
  const fTail = first((s) => s.rawTail.url);
  const fAll = first((s) => s.rawAll.url);
  const fOffTail = first((s) => s.rawTail.off);
  const fOffGrid = first((s) => s.grid.offOnGrid);
  return {
    urlOnGridAtMs: fGrid?.atMs ?? null,
    productionRawTailUrlAtMs: fTail?.atMs ?? null,
    unboundedRawUrlAtMs: fAll?.atMs ?? null,
    productionRawTailOffAtMs: fOffTail?.atMs ?? null,
    offOnGridAtMs: fOffGrid?.atMs ?? null,
    distinctGridRows: [...new Set(series.flatMap((s) => s.grid.rows.map((r) => r.text)))],
    distinctPills: [...new Set(series.map((s) => JSON.stringify(s.pill)))].map((v) => JSON.parse(v)),
  };
}

async function boot(label, extraArgs) {
  const cwd = path.join(ROOT, label);
  const runtimeDir = path.join(ROOT, `${label}-runtime`);
  fs.mkdirSync(cwd, { recursive: true });
  fs.mkdirSync(runtimeDir, { recursive: true });
  const args = [
    "--permission-mode",
    "default",
    "--settings",
    ensureClaudeRuntimeSettings(runtimeDir, {}),
    ...extraArgs,
  ];
  const p = new Probe({ cwd, rows: ROWS, cols: COLS, args });
  const scan = armScan(p);
  const trust = await p.waitFor(/Quick safety check|trust this folder/i, 45_000);
  if (trust) {
    for (let i = 0; i < 6; i++) {
      await sleep(500);
      p.write(KEYS.down);
      await sleep(350);
      if (p.screen().split("\n").some((l) => /❯\s*Yes, I trust this folder/i.test(l))) break;
    }
    p.write(KEYS.enter);
    await sleep(1500);
  }
  const ready = await p.waitFor(/for shortcuts|Welcome back|Try "|⏵|⏸/i, 60_000);
  await sleep(2500);
  return { p, scan, ready, args, trust };
}

async function armA(cap, results) {
  const { p, scan, ready, args } = await boot("a-inject-from-off", []);
  try {
    cap.frame(p, "A — idle composer before injection (no --remote-control)", { attrs: true });
    const before = sample(p, scan.scan);
    // Production's window is reset on every state transition; reset here so the
    // measurement is "what does THIS injection put in the window".
    scan.scan = "";
    await injectRemoteControl(p);
    const series = await watch(p, scan, cap, "A", { windowMs: 60_000 });
    cap.frame(p, "A — final screen, 60s after injection", { attrs: true });
    results.a = {
      ready,
      args: args.map(sanitize),
      before: { pill: before.pill, gridRows: before.grid.rows },
      ...verdict(series),
      // Did claude answer with something that WAITS for a choice? The `❯` cursor
      // outside the composer row is the tell.
      menuAfterInject: menuRows(p.screen()),
      composerPresent: /^❯\s*$/m.test(p.screen()) || /❯\s/.test(p.screen()),
    };
    cap.add("A — verdict", scrub(JSON.stringify(results.a, null, 2)));
    const idx = p.raw.search(/claude\.(?:ai|com)\/code\/session_/);
    cap.add(
      "A — RAW around first session link",
      idx >= 0 ? scrub(JSON.stringify(p.raw.slice(Math.max(0, idx - 1500), idx + 700))) : "(none in stream)",
    );
    // The verbatim tail after injection — the material a stream needle would be
    // written against, whatever it turns out to say.
    cap.add("A — RAW tail (last 6000 chars)", scrub(JSON.stringify(p.raw.slice(-6000))));
  } finally {
    p.kill();
    await sleep(900);
  }
}

async function armBC(cap, results) {
  const { p, scan, ready, args } = await boot("b-panel-from-on", ["--remote-control"]);
  try {
    cap.frame(p, "B — boot with --remote-control", { attrs: true });
    const connected = await p.waitFor(/claude\.(?:ai|com)\/code\/session_/, 45_000);
    cap.add("B — connected at boot?", String(connected));
    cap.frame(p, "B — connected (banner + pill)", { attrs: true });
    const bootConnect = sample(p, scan.scan);
    cap.add("B — boot connect channels", scrub(JSON.stringify(bootConnect, null, 2)));

    // --- open claude's own panel, exactly as manageRemoteControl does ---
    scan.scan = "";
    await injectRemoteControl(p);
    await sleep(1400); // the smoke's own settle
    cap.frame(p, "B — 1400ms after injecting /remote-control (the smoke's decision point)", { attrs: true });
    const panel = {
      menuRows: menuRows(p.screen()),
      screen: p.screen(),
    };
    cap.add("B — panel rows verbatim", scrub(panel.screen));

    // --- replay the smoke's walk EXACTLY: Up, Up, Enter ---
    p.write(KEYS.up);
    await sleep(600);
    cap.frame(p, "B — after Up #1", { attrs: true });
    const afterUp1 = menuRows(p.screen());
    p.write(KEYS.up);
    await sleep(600);
    cap.frame(p, "B — after Up #2 (the smoke commits here)", { attrs: true });
    const afterUp2 = menuRows(p.screen());
    p.write("\r");
    const series = await watch(p, scan, cap, "B-after-enter", { windowMs: 30_000 });
    cap.frame(p, "B — 30s after Enter", { attrs: true });
    results.b = {
      ready,
      args: args.map(sanitize),
      connectedAtBoot: connected,
      bootRawTailUrl: bootConnect.rawTail.url,
      panelMenuRows: panel.menuRows,
      afterUp1,
      afterUp2,
      ...verdict(series),
    };
    cap.add("B — verdict", scrub(JSON.stringify(results.b, null, 2)));
    cap.add("B — RAW tail after Enter (last 6000 chars)", scrub(JSON.stringify(p.raw.slice(-6000))));

    // --- C: reconnect in the SAME session ---
    await sleep(1500);
    scan.scan = "";
    await injectRemoteControl(p);
    const cSeries = await watch(p, scan, cap, "C", { windowMs: 45_000 });
    cap.frame(p, "C — 45s after re-injecting /remote-control", { attrs: true });
    results.c = { ...verdict(cSeries), menuAfterInject: menuRows(p.screen()) };
    cap.add("C — verdict", scrub(JSON.stringify(results.c, null, 2)));
    cap.add("C — RAW tail (last 6000 chars)", scrub(JSON.stringify(p.raw.slice(-6000))));
  } finally {
    p.kill();
    await sleep(900);
  }
}

async function main() {
  fs.rmSync(ROOT, { recursive: true, force: true });
  fs.mkdirSync(ROOT, { recursive: true });
  const cap = new Capture(
    path.join(OUT_DIR, "rc3-inject-lifecycle.capture.txt"),
    `RC3 — RC lifecycle through Sonata's own injection path (claude ${version})`,
  );
  const results = { version, scanLimit: REMOTE_CONTROL_SCAN_LIMIT };
  await armA(cap, results);
  await armBC(cap, results);
  results.userSettingsUnchanged = fs.readFileSync(USER_SETTINGS, "utf8") === settingsBefore;
  const endVersion = readVersion();
  results.versionAtEnd = endVersion;
  results.versionDrift = !endVersion.startsWith(EXPECT_VERSION);
  cap.add("fence", scrub(JSON.stringify(results, null, 2)));
  cap.save();
  console.log(scrub(JSON.stringify(results, null, 2)));
  if (results.versionDrift) process.exitCode = 2;
}

main().catch((e) => {
  console.error(scrub(String(e?.stack ?? e)));
  process.exit(1);
});
