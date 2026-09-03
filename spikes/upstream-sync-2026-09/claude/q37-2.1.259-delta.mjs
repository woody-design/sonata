// Q37 (D2 U6, 2026-09-03) — the claude 2.1.258 → 2.1.259 delta, measured.
//
// The triage (`private/upstream/2026-09-03-claude-2.1.259-triage.md`) left two
// changelog entries that a Sonata surface cannot absorb on reading alone:
//   A. "Fixed concurrent sessions silently reverting each other's ~/.claude.json
//      changes — workspace trust no longer resets" + "Fixed repository detection
//      dropping a known repo identity after a transient git probe failure".
//      Trust lives in the same file; SL-1's dialog shape (default row `No, exit`)
//      is the boot ceremony every Sonata spawn walks. Re-measure it. No API call.
//   B. "Fixed frontmatter `model:` on custom commands and skills being ignored in
//      interactive sessions". A per-TURN model switch is a new trigger for the
//      `PostModelSwitch` hook U3 just made the model-axis settle. Measure whether
//      it fires, with what `source`/`requested_model`, and whether the statusline
//      mirror flips for the turn. Needs a real turn → gated on API health (F97).
//
// Usage: node q37-2.1.259-delta.mjs --arm A|B   (one arm per run; per-arm capture)
// Pin: 2.1.259 start+end; drift → save, exit 2. Settings guard ON (both files).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { Capture, Probe, KEYS, sleep } from "../../upstream-sync-2026-08/claude/driver.mjs";
import { createSettingsGuard } from "./settings-guard.mjs";

const EXPECT_VERSION = "2.1.259";
const ROOT = "/private/tmp/sonata-sync-2026-09/q37";
const OUT_DIR = new URL(".", import.meta.url).pathname;
const APP_DIR = new URL("../../../app/", import.meta.url).pathname;
const require = createRequire(APP_DIR + "package.json");

const HOME = os.homedir();
const USER_MUNGED = `-${HOME.replace(/\//g, "-").replace(/^-/, "")}-`;
const scrub = (v) =>
  String(v).split(HOME).join("$HOME").split(USER_MUNGED).join("-$USER_MUNGED-")
    .replace(/https:\/\/claude\.ai\/\S+/g, "https://claude.ai/<redacted>");

const arm = (process.argv.indexOf("--arm") >= 0 ? process.argv[process.argv.indexOf("--arm") + 1] : "").toUpperCase();
if (!["A", "B"].includes(arm)) {
  console.error("usage: node q37-2.1.259-delta.mjs --arm A|B");
  process.exit(64);
}

const readVersion = () => execFileSync("claude", ["--version"], { encoding: "utf8" }).trim();
const startPin = readVersion();
if (!startPin.startsWith(EXPECT_VERSION)) {
  console.log(JSON.stringify({ success: false, reason: `binary moved off ${EXPECT_VERSION} at start`, version: startPin }));
  process.exit(2);
}

const cap = new Capture(
  path.join(OUT_DIR, `q37-2.1.259-delta.arm${arm}.capture.txt`),
  `Q37 arm ${arm} — claude ${startPin} (2.1.258→2.1.259 delta)`,
);
cap.add("version at start", startPin);
const guard = createSettingsGuard();
const armDir = path.join(ROOT, `arm${arm}-${Date.now().toString(36)}`);
fs.mkdirSync(armDir, { recursive: true });
execFileSync("git", ["init", "-q"], { cwd: armDir });
cap.add("cwd", scrub(armDir));

const rowFocused = (p, re) => p.screen().split("\n").some((l) => re.test(l));

let exitCode = 0;
let probe = null;
try {
  if (arm === "A") {
    // ── ARM A: trust dialog boot shape at 2.1.259 ─────────────────────────────
    probe = new Probe({ cwd: armDir, args: ["--permission-mode", "default"] });
    const trust = await probe.waitFor(/Quick safety check|trust this folder/i, 45_000);
    cap.add("trust dialog appeared?", String(trust));
    if (!trust) {
      cap.frame(probe, "no dialog — boot screen");
      cap.add("VERDICT", "NO trust dialog on a fresh git-init cwd — SHAPE DRIFT (or trust inherited); see frame");
      exitCode = 1;
    } else {
      await sleep(600); // let the dialog finish painting before reading rows
      cap.frame(probe, "trust dialog as painted", { attrs: false });
      const screen = probe.screen();
      const defaultRowIsNo = rowFocused(probe, /❯\s*No, exit/i);
      const affirmPresent = /Yes, I trust this folder/i.test(screen);
      const headline = (screen.match(/Quick safety check[^\n]*/i) || [""])[0];
      cap.add("default (❯) row is `No, exit`?", String(defaultRowIsNo));
      cap.add("affirm row `Yes, I trust this folder` present?", String(affirmPresent));
      cap.add("headline", headline);
      // The production answer choreography (driver bootTrusted / SL-1): verify-and-retry Down, then Enter.
      let landed = false;
      const attempts = [];
      for (let i = 0; i < 6 && !landed; i++) {
        await sleep(500);
        probe.write(KEYS.down);
        await sleep(350);
        landed = rowFocused(probe, /❯\s*Yes, I trust this folder/i);
        attempts.push(`down#${i + 1}: affirmFocused=${landed}`);
      }
      cap.add("affirm row focused via verify-and-retry Down?", attempts.join("\n"));
      if (landed) {
        cap.frame(probe, "affirm row focused");
        probe.write(KEYS.enter);
        const ok = await probe.waitFor(/for shortcuts|Welcome back|Try "|\? for|❯\s*$/i, 30_000);
        await sleep(2000);
        cap.add("reached composer after affirm+Enter?", String(ok));
        cap.frame(probe, "post-trust composer", { attrs: false });
        cap.add(
          "idle footer needles",
          ["\\? for shortcuts", "manual mode on|mode on", "← for agents"]
            .map((s) => `${s}: ${new RegExp(s, "i").test(probe.screen())}`)
            .join("\n"),
        );
        // Second boot in the SAME cwd: trust must now be remembered (the changelog's
        // "trust no longer resets" claim, single-session form).
        probe.write("\x04"); // Ctrl-D exits the composer
        await sleep(1500);
        if (!probe.exited) probe.kill();
        await sleep(800);
        const p2 = new Probe({ cwd: armDir, args: ["--permission-mode", "default"] });
        const trust2 = await p2.waitFor(/Quick safety check|trust this folder/i, 12_000);
        const composer2 = trust2 ? false : await p2.waitFor(/for shortcuts|Welcome back|Try "|\? for/i, 30_000);
        cap.add("second boot, same cwd: trust dialog again?", String(trust2));
        cap.add("second boot, same cwd: straight to composer?", String(composer2));
        cap.frame(p2, "second boot screen");
        p2.write("\x04");
        await sleep(1000);
        if (!p2.exited) p2.kill();
        cap.add("VERDICT", [
          `defaultRowNoExit=${defaultRowIsNo}`,
          `affirmPresent=${affirmPresent}`,
          `downLanded=${landed}`,
          `composerReached=${ok}`,
          `trustRemembered=${!trust2 && composer2}`,
        ].join("  "));
        if (!(defaultRowIsNo && affirmPresent && landed && ok && !trust2 && composer2)) exitCode = 1;
      } else {
        cap.add("VERDICT", "Down never focused the affirm row — SHAPE DRIFT");
        exitCode = 1;
      }
    }
    cap.addRaw("RAW pty stream (first boot)", probe.raw);
  } else {
    // ── ARM B: frontmatter `model:` per-turn switch → hooks + statusline mirror ──
    const { ensureClaudeRuntimeSettings, claudeHooksDirectory, claudeUsageDirectory } = require(APP_DIR + "dist/runtime");
    const runtimeDir = path.join(armDir, ".sonata-runtime");
    const settingsPath = ensureClaudeRuntimeSettings(runtimeDir, { approvalBroker: false });
    // Layer the pair on top of production's file (h4's pattern); production already
    // writes PostModelSwitch since U3 — record which were layered vs found.
    const settings = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
    const sinkCommand = settings.hooks.Stop[0].hooks[0].command;
    const layered = [], fromProduction = [];
    for (const ev of ["PreModelSwitch", "PostModelSwitch"]) {
      if (settings.hooks[ev]) fromProduction.push(ev);
      else { layered.push(ev); settings.hooks[ev] = [{ hooks: [{ type: "command", command: sinkCommand }] }]; }
    }
    fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
    cap.add("hook events: from production / layered by probe", `${fromProduction.join(",")} / ${layered.join(",")}`);
    // The project-local command with a model frontmatter.
    fs.mkdirSync(path.join(armDir, ".claude", "commands"), { recursive: true });
    fs.writeFileSync(
      path.join(armDir, ".claude", "commands", "q37-haiku.md"),
      "---\ndescription: q37 frontmatter model probe\nmodel: haiku\n---\nReply with exactly the single word Q37_FRONTMATTER_RECEIPT and nothing else.\n",
    );
    const hooksDir = claudeHooksDirectory(runtimeDir);
    const usageDir = claudeUsageDirectory(runtimeDir);
    const readHooks = () => {
      let out = [];
      try {
        for (const f of fs.readdirSync(hooksDir).filter((e) => /^hook-.+\.json$/.test(e)).sort()) {
          try {
            const payload = JSON.parse(fs.readFileSync(path.join(hooksDir, f), "utf8"));
            const stamp = /^hook-([0-9a-z]+)-/.exec(f);
            out.push({ file: f, wallMs: stamp ? Number.parseInt(stamp[1], 36) : null, payload });
          } catch { /* mid-write */ }
        }
      } catch { /* no dir yet */ }
      return out;
    };
    const readStatusline = () => {
      try {
        const files = fs.readdirSync(usageDir).filter((f) => /^claude-.*\.json$/.test(f));
        if (!files.length) return null;
        const payload = JSON.parse(fs.readFileSync(path.join(usageDir, files[0]), "utf8"));
        return { model: payload.model ?? null, effort: payload.effort ?? null };
      } catch { return null; }
    };
    const renderHook = (h) => {
      const p = h.payload;
      const keep = {};
      for (const k of ["hook_event_name", "source", "requested_model", "from_model", "to_model", "prompt", "model"]) if (k in p) keep[k] = p[k];
      return `${h.file.replace(/^(hook-[0-9a-z]+)-.*$/, "$1-…")} wall=${h.wallMs} ${scrub(JSON.stringify(keep))}`;
    };
    probe = new Probe({ cwd: armDir, args: ["--permission-mode", "default", "--model", "fable", "--settings", settingsPath] });
    const trust = await probe.waitFor(/Quick safety check|trust this folder/i, 45_000);
    if (trust) {
      let landed = false;
      for (let i = 0; i < 6 && !landed; i++) { await sleep(500); probe.write(KEYS.down); await sleep(350); landed = rowFocused(probe, /❯\s*Yes, I trust this folder/i); }
      cap.add("trust: affirm landed?", String(landed));
      if (landed) probe.write(KEYS.enter);
    }
    const ready = await probe.waitFor(/for shortcuts|Welcome back|Try "|\? for/i, 60_000);
    await sleep(3000);
    cap.add("composer reached?", String(ready));
    cap.frame(probe, "boot (session model fable)");
    cap.add("statusline mirror BEFORE", scrub(JSON.stringify(readStatusline())));
    const hooksBefore = readHooks().length;
    // Drive the command: type, grid-verify the composer holds it, CR.
    probe.write("/q37-haiku");
    let typed = false;
    for (let i = 0; i < 8 && !typed; i++) { await sleep(400); typed = /q37-haiku/.test(probe.screen()); }
    cap.add("composer holds `/q37-haiku` before CR?", String(typed));
    cap.frame(probe, "before CR");
    const tCr = Date.now();
    probe.write(KEYS.enter);
    // Watch for up to 90 s: receipt word, hooks, statusline flips.
    const mirrorTimeline = [];
    let lastMirror = JSON.stringify(readStatusline());
    let receiptSeen = false;
    const deadline = tCr + 90_000;
    while (Date.now() < deadline) {
      await sleep(250);
      const m = JSON.stringify(readStatusline());
      if (m !== lastMirror) { mirrorTimeline.push(`+${Date.now() - tCr}ms ${scrub(m)}`); lastMirror = m; }
      if (/Q37_FRONTMATTER_RECEIPT/.test(probe.screen().replace(/\/q37-haiku[^\n]*/g, ""))) { receiptSeen = true; }
      const turnDone = receiptSeen && readHooks().some((h) => h.payload.hook_event_name === "Stop");
      if (turnDone) break;
    }
    await sleep(2500);
    cap.frame(probe, "after the frontmatter-model turn");
    const hooks = readHooks();
    cap.add("hooks fired (all events, sink filename wall-clock, since CR)", hooks.slice(hooksBefore).map((h) => `${h.wallMs !== null ? "+" + (h.wallMs - tCr) + "ms" : "?"} ${renderHook(h)}`).join("\n") || "(none)");
    cap.add("model-switch hooks", hooks.filter((h) => /ModelSwitch$/.test(h.payload.hook_event_name)).map(renderHook).join("\n") || "(none)");
    cap.add("statusline mirror timeline during/after the turn", mirrorTimeline.join("\n") || "(no change)");
    cap.add("statusline mirror AFTER", scrub(JSON.stringify(readStatusline())));
    cap.add("receipt word seen on screen?", String(receiptSeen));
    cap.add("API error/overload lines on screen?", String(/API error|Overloaded|529/.test(probe.screen())));
    // Second, plain turn: does the session run on fable again?
    probe.write("Reply with exactly the single word Q37_SECOND_TURN and nothing else.");
    await sleep(800);
    const t2 = Date.now();
    probe.write(KEYS.enter);
    let second = false;
    while (Date.now() < t2 + 90_000) { await sleep(250); if (/Q37_SECOND_TURN/.test(probe.screen().replace(/Reply with exactly[^\n]*/g, ""))) { second = true; break; } }
    await sleep(2500);
    cap.add("second plain turn receipt seen?", String(second));
    cap.add("statusline mirror after second turn", scrub(JSON.stringify(readStatusline())));
    cap.add("hooks fired during second turn", readHooks().filter((h) => h.wallMs !== null && h.wallMs >= t2).map((h) => `+${h.wallMs - t2}ms ${renderHook(h)}`).join("\n") || "(none)");
    cap.frame(probe, "after second turn");
    cap.add("settings.json drift (guard, key-level)", JSON.stringify(guard.diffSinceSnapshot()));
    cap.add("VERDICT", `receipt=${receiptSeen} second=${second} modelSwitchHooks=${hooks.filter((h) => /ModelSwitch$/.test(h.payload.hook_event_name)).length} mirrorChanges=${mirrorTimeline.length}`);
    if (!receiptSeen) exitCode = 1;
    cap.addRaw("RAW pty stream", probe.raw);
  }
} catch (error) {
  cap.add("PROBE ERROR", scrub(String(error?.stack ?? error)));
  exitCode = 1;
} finally {
  try { if (probe && !probe.exited) probe.kill(); } catch { /* */ }
  await sleep(500);
  const g = guard.restore();
  cap.add("settings guard", JSON.stringify({ settings: { mutatedByProbe: g.mutatedByProbe, restored: g.restored, changedKeys: g.changedKeys ?? [] }, claudeJson: g.projectCleanup }));
  const endPin = readVersion();
  cap.add("version at end", endPin);
  if (!endPin.startsWith(EXPECT_VERSION)) { cap.add("VERSION DRIFT", `${startPin} → ${endPin}`); exitCode = 2; }
  cap.save();
  process.exit(exitCode);
}
