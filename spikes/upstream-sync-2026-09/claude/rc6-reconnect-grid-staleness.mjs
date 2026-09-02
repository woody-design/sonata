// RC6 (2026-09 sync, SL-11) — the one hazard the grid channel introduces that
// the stream channel did not have.
//
// RC5 settled the channel question: the session URL survives a differential
// repaint only on the reconstructed SCREEN, never reliably in the raw tail
// (2.1.258 elides characters already correct on the grid, so `https:` and
// `/claude.ai/…` reach the stream as two fragments and `https://` is never in
// it). Moving the URL read to the grid is therefore forced.
//
// But a grid holds a TRANSCRIPT. RC3 already measured its stale-signal edge in
// the other direction: `Remote Control disconnected.` was still on screen at
// +0ms of a session that had already RECONNECTED. If the same is true of the
// session-link row, then after disconnect → reconnect the screen can carry TWO
// link rows, and a naive `match()` — which returns the FIRST — would hand the
// user the DEAD link.
//
// This probe measures exactly that, and nothing else:
//   1. boot with `--remote-control`, read link #1 off the grid
//   2. open the panel, walk to "Disconnect this session", confirm
//   3. re-inject `/remote-control`, read the grid again
//   4. report: how many distinct links are on the screen, whether FIRST and
//      LAST disagree, and whether the reconnect even mints a new session id
//      (if the id is stable the hazard is vacuous — worth knowing rather than
//      assuming).
// Ids are compared, never printed.
//
// Scratch dirs are /private/tmp/... (never the agent scratchpad, whose path
// embeds the username): this capture becomes findings and the pre-push leak
// fence scans blob content.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";

const OUT_DIR = new URL(".", import.meta.url).pathname;
const APP_DIR = new URL("../../../app/", import.meta.url).pathname;
const require = createRequire(APP_DIR + "package.json");
const { ensureClaudeRuntimeSettings } = require(APP_DIR + "dist/runtime");
const { Probe, Capture, KEYS, sleep } = await import("../../upstream-sync-2026-08/claude/driver.mjs");

const EXPECT_VERSION = "2.1.258";
const ROOT = "/private/tmp/sonata-sync-2026-09/rc-reconnect";
const URL_RE = /https:\/\/claude\.(?:ai|com)\/code\/session_[A-Za-z0-9_-]+/g;

const HOME = os.homedir();
const USER_MUNGED = `-${HOME.replace(/\//g, "-").replace(/^-/, "")}-`;
const sanitize = (v) => String(v).split(HOME).join("$HOME").split(USER_MUNGED).join("-$USER_MUNGED-");
const scrub = (v) => sanitize(v).replace(/session_[A-Za-z0-9_-]+/g, "session_<REDACTED>");
/** Compare ids without ever writing one down. */
const idFingerprint = (url) => (url ? createHash("sha256").update(url).digest("hex").slice(0, 12) : null);

function readVersion() {
  return execFileSync("claude", ["--version"], { encoding: "utf8" }).trim();
}
const version = (() => {
  const v = readVersion();
  if (!v.startsWith(EXPECT_VERSION)) {
    console.log(JSON.stringify({ success: false, reason: `binary moved off ${EXPECT_VERSION}`, version: v }));
    process.exit(2);
  }
  return v;
})();

const BRACKETED_PASTE_START = "\x1b[200~";
const BRACKETED_PASTE_END = "\x1b[201~";
const CSI_U_ENTER = "\x1b[13u";
async function injectRemoteControl(p) {
  p.write(`${BRACKETED_PASTE_START}/remote-control${BRACKETED_PASTE_END}`);
  await sleep(120);
  p.write(CSI_U_ENTER);
}

/** Every session link the CURRENT screen renders, in top-to-bottom order —
 *  which for a transcript is oldest-to-newest. */
function screenLinks(p) {
  const found = [...p.screen().matchAll(URL_RE)].map((m) => m[0]);
  return {
    count: found.length,
    distinct: new Set(found).size,
    firstFp: idFingerprint(found[0] ?? null),
    lastFp: idFingerprint(found[found.length - 1] ?? null),
    rows: p
      .screen()
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => URL_RE.test(l) || /claude\.(ai|com)\/code\/session_/.test(l)),
  };
}

async function main() {
  fs.rmSync(ROOT, { recursive: true, force: true });
  fs.mkdirSync(ROOT, { recursive: true });
  const cwd = path.join(ROOT, "session");
  const runtimeDir = path.join(ROOT, "runtime");
  fs.mkdirSync(cwd, { recursive: true });
  fs.mkdirSync(runtimeDir, { recursive: true });
  const cap = new Capture(
    path.join(OUT_DIR, "rc6-reconnect-grid-staleness.capture.txt"),
    `RC6 — grid link staleness across disconnect → reconnect (claude ${version})`,
  );

  const args = [
    "--permission-mode",
    "default",
    "--settings",
    ensureClaudeRuntimeSettings(runtimeDir, {}),
    "--remote-control",
  ];
  const p = new Probe({ cwd, rows: 40, cols: 120, args });
  const results = { version, args: args.map(sanitize) };
  try {
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
    await p.waitFor(/claude\.(?:ai|com)\/code\/session_/, 45_000);
    await sleep(2000);
    results.connect1 = screenLinks(p);
    cap.frame(p, "1 — connected at boot");

    // Disconnect through claude's own panel (RC3's measured walk).
    await injectRemoteControl(p);
    await sleep(1600);
    cap.frame(p, "2 — RC panel open");
    p.write(KEYS.up);
    await sleep(600);
    p.write(KEYS.up);
    await sleep(600);
    cap.frame(p, "3 — 'Disconnect this session' focused");
    p.write(KEYS.enter);
    await p.waitFor(/Remote Control disconnected/, 20_000);
    await sleep(2000);
    results.afterDisconnect = screenLinks(p);
    results.disconnectLineStillOnGrid = /Remote Control disconnected/.test(p.screen());
    cap.frame(p, "4 — after disconnect");

    // Reconnect in the SAME session.
    await injectRemoteControl(p);
    await sleep(6000);
    cap.frame(p, "5 — after reconnect");
    results.connect2 = screenLinks(p);
    results.reconnectMintsNewSessionId =
      results.connect1.lastFp !== null &&
      results.connect2.lastFp !== null &&
      results.connect1.lastFp !== results.connect2.lastFp;
    // THE question: on the reconnected screen, does a first-match read differ
    // from a last-match read? `true` means "first match wins" would serve a
    // dead link and the reader must take the LAST.
    results.firstDiffersFromLastAfterReconnect =
      results.connect2.firstFp !== results.connect2.lastFp;
    results.staleDisconnectLineAfterReconnect = /Remote Control disconnected/.test(p.screen());
  } finally {
    p.kill();
    await sleep(800);
  }
  results.versionAtEnd = readVersion();
  results.versionDrift = !results.versionAtEnd.startsWith(EXPECT_VERSION);
  cap.add("verdict", scrub(JSON.stringify(results, null, 2)));
  cap.save();
  console.log(scrub(JSON.stringify(results, null, 2)));
  if (results.versionDrift) process.exitCode = 2;
}

main().catch((e) => {
  console.error(scrub(String(e?.stack ?? e)));
  process.exit(1);
});
