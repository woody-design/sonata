// RC5 (2026-09 sync, SL-11) — WHY `remote-control-disconnect.mjs` times out,
// measured on the PRODUCTION object (`TerminalHost` from `dist/`), not a pty
// look-alike.
//
// WHAT IS ALREADY KNOWN going in:
//   - RC3 measured the mid-session path working at 2.1.258: a `/remote-control`
//     injection from a genuinely-OFF session connects and puts the session URL
//     into the production 2048-char raw tail within ~505ms.
//   - A hand diagnostic through TerminalHost, injecting 3s AFTER
//     `acceptsPromptInput()`, also worked (URL at +142ms).
//   - The smoke, which injects the INSTANT `acceptsPromptInput()` flips, times
//     out. Same code, same binary, same account — so the variable is WHEN.
//   - And the boot is no longer quiet: `tengu_cobalt_harbor` (the GrowthBook
//     flag claude's own resolver falls back to) is TRUE on this account, so a
//     session can auto-start RC with no `--remote-control` flag. That makes the
//     first seconds of a boot a period in which RC is MID-CONNECT — and
//     `/remote-control` is a TOGGLE.
//
// So the question is precise: does injecting into the auto-connect window turn
// RC OFF (or otherwise strand it), while the same injection a few seconds later
// connects? Three legs, one variable — the injection moment:
//   L1 immediate    — the smoke's timing, at the `acceptsPromptInput()` edge
//   L2 settled-3s   — the hand diagnostic's timing
//   L3 rc-settled   — after the boot's own RC outcome is visible (a session URL
//                     in the stream, or a quiet window with no `connecting…`)
//
// Each leg records the boot RC signals BEFORE it injects, the injection's
// RETURN VALUE (the smoke drops it on the floor — a refusal there is
// indistinguishable from a timeout), every `remote-control:state` event, and
// whether the composer still accepts input afterwards (2.1.258 can leave the RC
// PANEL open over the composer, which would strand a delivery).
//
// Runs under electron-as-node, like the smoke it explains.
// Scratch workspaces are /private/tmp/... (never the agent scratchpad, whose
// path embeds the username): this capture becomes findings and the pre-push
// leak fence scans blob content.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";

const OUT_DIR = new URL(".", import.meta.url).pathname;
const APP_DIR = new URL("../../../app/", import.meta.url).pathname;
const require = createRequire(APP_DIR + "package.json");
const { TerminalHost } = require(APP_DIR + "dist/runtime");
// A second, independent emulator fed the SAME pty stream, built to
// `TaskScreenModel`'s conventions — so every leg can answer the channel
// question directly: what the raw tail carries vs what the reconstructed screen
// carries, at the same instant, for the same bytes.
const { Terminal } = require(APP_DIR + "node_modules/@xterm/headless");

const SESSION_URL_RE = /https:\/\/claude\.(?:ai|com)\/code\/session_[A-Za-z0-9_-]+/;

const EXPECT_VERSION = "2.1.258";
const ROOT = "/private/tmp/sonata-sync-2026-09/rc-inject-timing";

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

const USER_CONFIG = path.join(HOME, ".claude.json");
function autoStartInputs() {
  const raw = JSON.parse(fs.readFileSync(USER_CONFIG, "utf8"));
  return {
    tengu_cobalt_harbor: raw.cachedGrowthBookFeatures?.tengu_cobalt_harbor ?? null,
    growthBookCachedAt: raw.cachedGrowthBookFeaturesAt
      ? new Date(raw.cachedGrowthBookFeaturesAt).toISOString()
      : null,
  };
}

const clean = (t) => t.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "").replace(/\s+/g, " ");
const delay = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitUntil(pred, ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (pred()) return true;
    await delay(150);
  }
  return false;
}

/** One leg: a fresh TerminalHost claude session, injected at `moment`. */
async function runLeg(label, moment) {
  const workspace = path.join(ROOT, label);
  fs.mkdirSync(workspace, { recursive: true });
  let raw = "";
  let trustSeen = false;
  const rcStates = [];
  const term = new Terminal({ cols: 120, rows: 36, allowProposedApi: true, scrollback: 80 });
  const viewportText = () => {
    const b = term.buffer.active;
    const rows = [];
    for (let y = 0; y < term.rows; y++) {
      const line = b.getLine(b.viewportY + y);
      rows.push(line ? line.translateToString(true) : "");
    }
    return rows.join("\n");
  };
  const host = new TerminalHost({
    taskId: `task-rc5-${label}`,
    provider: "claude",
    defaultWorkspace: workspace,
    eventSink: (event) => {
      if (event.type === "pty:data") {
        raw = `${raw}${event.payload.data}`.slice(-400 * 1024);
        term.write(event.payload.data);
        return;
      }
      if (event.type === "approval:detected" && event.payload.kind === "workspace-trust") {
        trustSeen = true;
        void host.sendApprove().catch((e) => console.error("sendApprove failed:", e));
      }
      if (event.type === "remote-control:state") {
        rcStates.push({
          active: event.payload.active,
          url: event.payload.url,
          atMs: Date.now() - T0.value,
        });
      }
    },
  });
  const T0 = { value: Date.now() };
  const out = { leg: label, autoStartInputs: autoStartInputs() };
  try {
    host.startTask({ cwd: workspace, permissionMode: "default", rows: 36, cols: 120 });
    out.reachedInput = await waitUntil(() => trustSeen || host.acceptsPromptInput(), 120_000);
    out.acceptsInput = await waitUntil(() => host.acceptsPromptInput(), 120_000);

    // Wait per the leg's moment.
    if (moment === "settled-3s") {
      await delay(3000);
    } else if (moment === "rc-settled") {
      // Either the boot's own RC connect lands (URL in the stream), or 15s pass
      // with no connect — either way the boot's RC outcome is no longer moving.
      await waitUntil(() => /claude\.(?:ai|com)\/code\/session_/.test(raw), 15_000);
      await delay(1500);
    }

    // What the boot itself did, BEFORE this leg touches anything. `connecting…`
    // in the stream is the auto-start attempt; a session URL is its success.
    const bootRaw = raw;
    out.boot = {
      sawConnectingPill: /connecting…/.test(clean(bootRaw)),
      sawSessionUrl: /claude\.(?:ai|com)\/code\/session_/.test(bootRaw),
      trustDialogSeen: trustSeen,
      rcStatesBeforeInject: rcStates.length,
      atMs: Date.now() - T0.value,
    };

    const beforeLen = raw.length;
    const injectAtMs = Date.now() - T0.value;
    // The smoke DROPS this value; a refusal here is the difference between "the
    // surface moved" and "we never asked".
    out.injectResult = host.injectRemoteControl();
    out.injectAtMs = injectAtMs;

    // The smoke's own budget for the URL is 45s; watch the whole of it — and
    // watch the GRID in parallel. `urlArrived` is what production's STREAM
    // detector produced; `gridUrlAtMs` is what the same bytes look like once
    // reconstructed. A leg where those two disagree is the whole finding.
    let gridUrlAtMs = null;
    let gridUrl = null;
    out.urlArrived = await waitUntil(() => {
      if (gridUrlAtMs === null) {
        const hit = viewportText().match(SESSION_URL_RE)?.[0];
        if (hit) {
          gridUrl = hit;
          gridUrlAtMs = Date.now() - T0.value - injectAtMs;
        }
      }
      return rcStates.some((s) => s.active && s.url);
    }, 45_000);
    if (gridUrlAtMs === null) {
      const hit = viewportText().match(SESSION_URL_RE)?.[0];
      if (hit) {
        gridUrl = hit;
        gridUrlAtMs = Date.now() - T0.value - injectAtMs;
      }
    }
    out.gridUrlFoundAfterInjectMs = gridUrlAtMs;
    out.gridUrl = gridUrl;
    out.gridRowsWithUrl = viewportText()
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => /claude\.(ai|com)\/code/.test(l));
    await delay(2000);
    out.rcStates = rcStates;
    out.acceptsInputAfterInject = host.acceptsPromptInput();
    const after = raw.slice(beforeLen);
    out.afterInjectCleaned = clean(after).slice(0, 3000);
    out.afterInjectSignals = {
      panelOpened: /Disconnect this session/.test(clean(after)),
      sawIsActiveBanner: /remote-control is active/.test(clean(after)),
      sawPanelAvailableLine: /This\s*session\s*is\s*available\s*in\s*the\s*Claude\s*mobile\s*app/.test(clean(after)),
      sawDisconnectLine: /Remote Control disconnected/.test(clean(after)),
      sawUrl: /claude\.(?:ai|com)\/code\/session_/.test(after),
    };
    out.rawTailAfter = after.slice(-3500);
    out.finalScreen = viewportText();
  } finally {
    host.dispose();
    await delay(1200);
  }
  return out;
}

async function main() {
  fs.rmSync(ROOT, { recursive: true, force: true });
  fs.mkdirSync(ROOT, { recursive: true });
  const results = { version, legs: [] };
  for (const [label, moment] of [
    ["immediate", "immediate"],
    ["settled-3s", "settled-3s"],
    ["rc-settled", "rc-settled"],
  ]) {
    results.legs.push(await runLeg(label, moment));
  }
  const endVersion = readVersion();
  results.versionAtEnd = endVersion;
  results.versionDrift = !endVersion.startsWith(EXPECT_VERSION);

  const body = scrub(JSON.stringify(results, null, 2));
  fs.writeFileSync(
    path.join(OUT_DIR, "rc5-inject-timing.capture.txt"),
    `# RC5 — injection-moment A/B through TerminalHost (claude ${version})\n` +
      `# captured ${new Date().toISOString()}\n\n${body}\n`,
  );
  console.log(body);
  if (results.versionDrift) process.exitCode = 2;
}

main().catch((e) => {
  console.error(scrub(String(e?.stack ?? e)));
  process.exit(1);
});
