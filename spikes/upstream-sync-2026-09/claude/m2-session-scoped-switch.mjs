// M2 (D2 U4, 2026-09-03) — the picker-`s` session-scoped model switch, measured
// for every alias Sonata offers, plus the shapes the new drive must recognise.
//
// Design input: F15/F16 (picker rows, `s` hint), F68 (the slash form persists the
// user's default — the ONLY pollution Sonata causes), F89 (h4 arm g: `s` applies
// the switch, settings.json untouched, PostModelSwitch source:"picker",
// requested_model = alias; the cache-miss dialog is STILL raised on history).
// Woody's ruling: ONE drive path (picker + `s`), no slash fallback; effort:
// accept + register if no session-scoped affordance exists.
//
// Arms (one run, sequential; each arm is its own spawn):
//   a  every alias via picker+`s` in a `--model fable` session WITH history
//   b  `s` on a session WITHOUT history (dialog or not?)
//   c  `s` when the focused row IS the current model
//   d  Esc mid-picker (cancel shape)
//   e  `/effort` picker: rows, hint, any session-only affordance; ALSO the
//      `/model` picker's in-place `←/→ effort` + `s` (is THAT session-scoped effort?)
//   f  banner-reshaping switch (opus[1m] ↔ haiku) via picker+`s` — the F19
//      replay window, replayed through the shipped parsers
//   g  picker arming window (Down at +0ms after the picker paints)
// Pin 2.1.259 start+end. Settings guard ON (both files). Hooks read from the
// production sink dir; production --settings from dist/ (PostModelSwitch comes
// from PRODUCTION's entry since U3; PreModelSwitch layered for timing only).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { Capture, Probe, KEYS, sleep } from "../../upstream-sync-2026-08/claude/driver.mjs";
import { createSettingsGuard } from "./settings-guard.mjs";

const EXPECT_VERSION = "2.1.259";
const ROOT = "/private/tmp/sonata-sync-2026-09/session-scoped-switch";
const OUT_DIR = new URL(".", import.meta.url).pathname;
const APP_DIR = new URL("../../../app/", import.meta.url).pathname;
const require = createRequire(APP_DIR + "package.json");
const {
  ensureClaudeRuntimeSettings,
  claudeHooksDirectory,
  claudeUsageDirectory,
  parseClaudeControlReceipt,
  claudeCacheMissDialogOpen,
  claudeCacheMissCancelled,
  parseClaudeCacheMissCursor,
  CONTROL_SWITCH_SCAN_LIMIT,
} = require(APP_DIR + "dist/runtime");

const RIGHT = "\x1b[C", LEFT = "\x1b[D";
const HOME = os.homedir();
const USER_MUNGED = `-${HOME.replace(/\//g, "-").replace(/^-/, "")}-`;
const scrub = (v) =>
  String(v).split(HOME).join("$HOME").split(USER_MUNGED).join("-$USER_MUNGED-")
    .replace(/https:\/\/claude\.ai\/\S+/g, "https://claude.ai/<redacted>");
const strip = (s) => s.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "").replace(/\x1b[()][0-9A-Za-z]/g, "").replace(/\x1b[=>78]/g, "").replace(/\r/g, "");

const ARMS = (process.argv.includes("--arms") ? process.argv[process.argv.indexOf("--arms") + 1] : "a,b,c,d,e,f,g").split(",");
const readVersion = () => execFileSync("claude", ["--version"], { encoding: "utf8" }).trim();
const startPin = readVersion();
if (!startPin.startsWith(EXPECT_VERSION)) {
  console.log(JSON.stringify({ success: false, reason: `binary moved off ${EXPECT_VERSION} at start`, version: startPin }));
  process.exit(2);
}
const cap = new Capture(path.join(OUT_DIR, `m2-session-scoped-switch.${ARMS.join("")}.capture.txt`), `M2 — picker-\`s\` session-scoped switch (claude ${startPin})`);
cap.add("version at start", startPin);
cap.add("arms", ARMS.join(","));
const guard = createSettingsGuard();
const results = {};

// ─── session helper ──────────────────────────────────────────────────────────
class Session {
  constructor(name, { model = "fable", extraArgs = [] } = {}) {
    this.name = name;
    this.dir = path.join(ROOT, `${name}-${Date.now().toString(36)}`);
    fs.mkdirSync(this.dir, { recursive: true });
    execFileSync("git", ["init", "-q"], { cwd: this.dir });
    this.runtimeDir = path.join(this.dir, ".sonata-runtime");
    this.settingsPath = ensureClaudeRuntimeSettings(this.runtimeDir, { approvalBroker: false });
    const settings = JSON.parse(fs.readFileSync(this.settingsPath, "utf8"));
    const sink = settings.hooks.Stop[0].hooks[0].command;
    this.layered = []; this.fromProduction = [];
    for (const ev of ["PreModelSwitch", "PostModelSwitch"]) {
      if (settings.hooks[ev]) this.fromProduction.push(ev);
      else { this.layered.push(ev); settings.hooks[ev] = [{ hooks: [{ type: "command", command: sink }] }]; }
    }
    fs.writeFileSync(this.settingsPath, JSON.stringify(settings, null, 2));
    this.hooksDir = claudeHooksDirectory(this.runtimeDir);
    this.usageDir = claudeUsageDirectory(this.runtimeDir);
    this.seen = new Set();
    this.hooks = [];
    this.probe = new Probe({ cwd: this.dir, args: ["--permission-mode", "default", "--model", model, "--settings", this.settingsPath, ...extraArgs] });
    this.t0 = Date.now();
  }
  at() { return Date.now() - this.t0; }
  screen() { return this.probe.screen(); }
  lines() { return this.screen().split("\n"); }
  write(s) { this.probe.write(s); }
  rawTail(limit = CONTROL_SWITCH_SCAN_LIMIT) { return this.probe.raw.slice(-limit); }
  pollHooks() {
    let entries = [];
    try { entries = fs.readdirSync(this.hooksDir).filter((e) => /^hook-.+\.json$/.test(e)).sort(); } catch { return; }
    for (const f of entries) {
      if (this.seen.has(f)) continue;
      let payload;
      try { payload = JSON.parse(fs.readFileSync(path.join(this.hooksDir, f), "utf8")); } catch { continue; }
      this.seen.add(f);
      const stamp = /^hook-([0-9a-z]+)-/.exec(f);
      this.hooks.push({ wall: stamp ? Number.parseInt(stamp[1], 36) : Date.now(), event: payload.hook_event_name, payload });
    }
  }
  hooksSince(wallMs) { this.pollHooks(); return this.hooks.filter((h) => h.wall >= wallMs); }
  statusline() {
    try {
      const f = fs.readdirSync(this.usageDir).find((x) => /^claude-.*\.json$/.test(x));
      if (!f) return null;
      const p = JSON.parse(fs.readFileSync(path.join(this.usageDir, f), "utf8"));
      return { id: p.model?.id ?? null, display: p.model?.display_name ?? null, effort: p.effort?.level ?? null };
    } catch { return null; }
  }
  async boot() {
    const trust = await this.probe.waitFor(/Quick safety check|trust this folder/i, 45_000);
    if (trust) {
      let landed = false;
      for (let i = 0; i < 6 && !landed; i++) { await sleep(500); this.write(KEYS.down); await sleep(350); landed = this.lines().some((l) => /❯\s*Yes, I trust this folder/i.test(l)); }
      if (landed) this.write(KEYS.enter);
    }
    const ready = await this.probe.waitFor(/for shortcuts|Welcome back|Try "|\? for/i, 60_000);
    await sleep(2500);
    return { trust, ready, statusline: this.statusline() };
  }
  async typeAndVerify(text, re) {
    this.write(text);
    for (let i = 0; i < 10; i++) { await sleep(300); if (re.test(this.screen())) return true; }
    return false;
  }
  async turn(prompt, timeoutMs = 90_000) {
    const ok = await this.typeAndVerify(prompt, new RegExp(prompt.slice(0, 20).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    const t = Date.now();
    this.write(KEYS.enter);
    while (Date.now() < t + timeoutMs) { await sleep(300); if (this.hooksSince(t).some((h) => h.event === "Stop")) break; }
    await sleep(1500);
    return { typed: ok, stopSeen: this.hooksSince(t).some((h) => h.event === "Stop"), apiError: /API error|Overloaded|529/.test(this.screen()) };
  }
  // ── picker ──
  pickerOpen() { const s = this.screen(); return /Select model/.test(s) && /to use this session only/.test(s); }
  effortPickerOpen() { const s = this.screen(); return /effort/i.test(s) && /Esc to cancel/i.test(s) && !/Select model/.test(s); }
  rows() {
    const out = [];
    for (const raw of this.lines()) {
      const m = /^\s*(❯)?\s*(\d)\.\s+(.+)$/.exec(raw);
      if (!m) continue;
      const rest = m[3];
      // label = text before the ✔ or before a run of 2+ spaces
      const label = rest.split(/\s✔|\s{2,}/)[0].trim();
      out.push({ digit: Number(m[2]), label, current: /✔/.test(rest), focused: m[1] === "❯", text: rest.replace(/\s+/g, " ").trim() });
    }
    return out;
  }
  focused() { return this.rows().find((r) => r.focused) ?? null; }
  hintLine() { return this.lines().find((l) => /Esc to cancel/i.test(l))?.trim() ?? null; }
  effortLine() { return this.lines().find((l) => /effort.*←\/→|←\/→.*effort/i.test(l))?.trim() ?? null; }
  async openPicker(slash = "/model") {
    const typed = await this.typeAndVerify(slash, new RegExp(slash.replace("/", "\\/")));
    const t = Date.now();
    this.write(KEYS.enter);
    let open = false;
    for (let i = 0; i < 40; i++) { await sleep(150); open = slash === "/model" ? this.pickerOpen() : this.effortPickerOpen(); if (open) break; }
    return { typed, open, openMs: Date.now() - t, cr: t };
  }
  async walkTo(label, maxSteps = 8) {
    const path_ = [];
    for (let i = 0; i <= maxSteps; i++) {
      const f = this.focused();
      path_.push(f ? f.label : null);
      if (f && f.label === label) return { landed: true, steps: i, path: path_ };
      if (i === maxSteps) break;
      this.write(KEYS.down);
      await sleep(400);
    }
    return { landed: false, steps: maxSteps, path: path_ };
  }
  dialogOnGrid() { return claudeCacheMissDialogOpen(this.screen()); }
  async answerDialogRow(row, timeoutMs = 6000) {
    const t = Date.now();
    while (Date.now() < t + timeoutMs) {
      const cursor = parseClaudeCacheMissCursor(this.screen());
      if (cursor === row) { this.write(KEYS.enter); return { answered: true, atMs: Date.now() - t }; }
      if (cursor === null) { await sleep(250); continue; }
      this.write(cursor < row ? KEYS.down : KEYS.up);
      await sleep(400);
    }
    return { answered: false };
  }
  receiptsSince(rawLenBefore) {
    const text = strip(this.probe.raw.slice(rawLenBefore));
    const set = [...text.matchAll(/Set model to [^\n]*?(?:for this session only|for new sessions|\(default\)[^\n]*)/g)].map((m) => m[0].trim());
    const kept = [...text.matchAll(/Kept model as [^\n]*/g)].map((m) => m[0].trim());
    const eff = [...text.matchAll(/(?:Set effort level to|Kept effort level as|Effort level set to)[^\n]*/g)].map((m) => m[0].trim());
    return { set: [...new Set(set)], kept: [...new Set(kept)], effort: [...new Set(eff)] };
  }
  async close() { try { this.write("\x04"); await sleep(1200); if (!this.probe.exited) this.probe.kill(); } catch {} await sleep(400); }
}

const fmtHooks = (hooks, t) => hooks.map((h) => `+${h.wall - t}ms ${h.event}${/ModelSwitch$/.test(h.event) ? ` requested_model=${JSON.stringify(h.payload.requested_model)} to_model=${JSON.stringify(h.payload.to_model)} source=${JSON.stringify(h.payload.source)}` : ""}`).join("\n") || "(none)";

/** The core measurement: picker → walk to `label` → key (`s`/Enter/Esc) → dialog? → record. */
async function switchVia(session, { label, key = "s", answer = 1, tag }) {
  const before = { statusline: session.statusline(), rawLen: session.probe.raw.length, settings: guard.diffSinceSnapshot() };
  const open = await session.openPicker("/model");
  const frame = session.screen();
  const rows = session.rows();
  const hint = session.hintLine();
  const effortLine = session.effortLine();
  if (!open.open) { cap.frame(session.probe, `${tag} — picker did NOT open`); return { tag, open, error: "picker did not open" }; }
  const walk = label === null ? { landed: true, steps: 0, path: [session.focused()?.label ?? null] } : await session.walkTo(label);
  const focusedRow = session.focused();
  cap.frame(session.probe, `${tag} — picker before key (target ${label ?? "(focused)"}: landed=${walk.landed})`);
  if (!walk.landed) { session.write(KEYS.esc); await sleep(800); return { tag, open, rows, hint, walk, error: "target row not found; Esc'd" }; }
  const tKey = Date.now();
  const rawAtKey = session.probe.raw.length;
  session.write(key);
  // wait for: dialog on grid, or a Post hook, or a receipt, or 12s
  let dialogAtMs = null, postAtMs = null;
  const deadline = tKey + 12_000;
  while (Date.now() < deadline) {
    await sleep(120);
    if (dialogAtMs === null && session.dialogOnGrid()) dialogAtMs = Date.now() - tKey;
    const post = session.hooksSince(tKey).find((h) => h.event === "PostModelSwitch");
    if (post) { postAtMs = post.wall - tKey; break; }
    if (dialogAtMs !== null) break;
    if (key === KEYS.esc && Date.now() > tKey + 2500) break;
  }
  let dialog = null;
  if (dialogAtMs !== null) {
    cap.frame(session.probe, `${tag} — cache-miss dialog (+${dialogAtMs}ms)`);
    const cursor = parseClaudeCacheMissCursor(session.screen());
    const ans = answer === "esc" ? (session.write(KEYS.esc), { answered: true, esc: true }) : await session.answerDialogRow(answer);
    const tAns = Date.now();
    let post = null;
    while (Date.now() < tAns + 15_000) { await sleep(150); post = session.hooksSince(tKey).find((h) => h.event === "PostModelSwitch"); if (post) break; if (answer !== 1 && Date.now() > tAns + 3000) break; }
    dialog = { atMs: dialogAtMs, cursorWhenOpened: cursor, ...ans, postAfterAnswerMs: post ? post.wall - tAns : null, stillOpenOnGrid: session.dialogOnGrid(), pickerOpenAfterAnswer: session.pickerOpen() };
    if (answer !== 1 && session.pickerOpen()) {
      // MEASURED (d/s-then-dialog-esc): Esc/No on the dialog returns to the PICKER, still open.
      cap.frame(session.probe, `${tag} — picker still open after dialog ${answer === "esc" ? "Esc" : "No"}; sending Esc`);
      session.write(KEYS.esc); await sleep(800);
      dialog.pickerClosedBySecondEsc = !session.pickerOpen();
    }
  }
  await sleep(2500);
  const hooks = session.hooksSince(tKey);
  const receipts = session.receiptsSince(rawAtKey);
  const after = { statusline: session.statusline(), settings: guard.diffSinceSnapshot() };
  cap.frame(session.probe, `${tag} — after`);
  // the shipped parsers over the post-key stream window (the F19 question)
  const window = session.probe.raw.slice(rawAtKey).slice(-CONTROL_SWITCH_SCAN_LIMIT);
  const parsers = { pickerStillOpen: session.pickerOpen(), dialogOnGrid: session.dialogOnGrid(), receiptVerdictModel: label ? parseClaudeControlReceipt(window, "model", aliasFor(label) ?? "") : null, cancelledNeedle: claudeCacheMissCancelled(window, "model"), dialogOpenOnStream: claudeCacheMissDialogOpen(window) };
  return { tag, open, rowsAtOpen: rows, hint, effortLine, walk, focusedRow, key: key === KEYS.esc ? "Esc" : key === KEYS.enter ? "Enter" : key, dialog, hooks: fmtHooks(hooks, tKey), post: hooks.find((h) => h.event === "PostModelSwitch")?.payload ?? null, receipts, before, after, parsers };
}
const LABEL_BY_ALIAS = { "opus[1m]": "Opus (1M context)", opus: "Opus", sonnet: "Sonnet", haiku: "Haiku", fable: "Fable" };
const aliasFor = (label) => Object.entries(LABEL_BY_ALIAS).find(([, l]) => l === label)?.[0] ?? null;
const summarize = (r) => r.error ? `ERROR ${r.error}` : `key=${r.key} focused=${JSON.stringify(r.focusedRow?.label)} dialog=${r.dialog ? `+${r.dialog.atMs}ms cursor=${r.dialog.cursorWhenOpened} answered=${r.dialog.answered} postAfterAnswer=${r.dialog.postAfterAnswerMs}ms` : "none"} post.requested_model=${JSON.stringify(r.post?.requested_model)} post.source=${JSON.stringify(r.post?.source)} to_model=${JSON.stringify(r.post?.to_model)} receipts.set=${JSON.stringify(r.receipts.set)} kept=${JSON.stringify(r.receipts.kept)} statusline=${r.before.statusline?.id}→${r.after.statusline?.id} settingsChanged=${r.after.settings.changed} parsers=${JSON.stringify(r.parsers)}`;

const WARMUP = "In one short sentence, say what a terminal emulator does. Do not use any tools.";
let exitCode = 0;
try {
  cap.add("MODEL_OPTIONS claude (Sonata offers)", "fable, opus[1m], opus, sonnet, haiku, (null=Default)");
  if (ARMS.includes("a")) {
    const s = new Session("a-aliases", { model: "fable" });
    const boot = await s.boot(); cap.add("a — boot", JSON.stringify(boot));
    cap.add("a — hook events from production / layered", `${s.fromProduction.join(",")} / ${s.layered.join(",")}`);
    const warm = await s.turn(WARMUP); cap.add("a — warm-up turn", JSON.stringify(warm));
    results.a = [];
    for (const alias of ["opus[1m]", "opus", "sonnet", "haiku", "fable"]) {
      const r = await switchVia(s, { label: LABEL_BY_ALIAS[alias], key: "s", answer: 1, tag: `a/${alias}` });
      results.a.push({ alias, ...r });
      cap.add(`a/${alias} — rows at open`, r.rowsAtOpen ? r.rowsAtOpen.map((x) => `${x.focused ? "❯" : " "} ${x.digit}. ${x.label}${x.current ? " ✔" : ""} | ${x.text}`).join("\n") : "(n/a)");
      cap.add(`a/${alias} — hint`, `${r.hint}\n${r.effortLine ?? ""}`);
      cap.add(`a/${alias} — hooks since key`, r.hooks ?? "(n/a)");
      cap.add(`a/${alias} — summary`, summarize(r));
      if (r.error) { /* continue with next alias */ }
    }
    await s.close();
  }
  if (ARMS.includes("b")) {
    const s = new Session("b-fresh", { model: "fable" });
    cap.add("b — boot", JSON.stringify(await s.boot()));
    const r = await switchVia(s, { label: "Haiku", key: "s", answer: 1, tag: "b/fresh-haiku" });
    results.b = r; cap.add("b — hooks", r.hooks ?? "(n/a)"); cap.add("b — summary", summarize(r));
    await s.close();
  }
  if (ARMS.includes("c")) {
    const s = new Session("c-current", { model: "fable" });
    cap.add("c — boot", JSON.stringify(await s.boot()));
    cap.add("c — warm-up", JSON.stringify(await s.turn(WARMUP)));
    const r = await switchVia(s, { label: "Fable", key: "s", answer: 1, tag: "c/s-on-current" });
    results.c = r; cap.add("c — hooks", r.hooks ?? "(n/a)"); cap.add("c — summary", summarize(r));
    await s.close();
  }
  if (ARMS.includes("d")) {
    const s = new Session("d-esc", { model: "fable" });
    cap.add("d — boot", JSON.stringify(await s.boot()));
    cap.add("d — warm-up", JSON.stringify(await s.turn(WARMUP)));
    const r1 = await switchVia(s, { label: "Haiku", key: KEYS.esc, tag: "d/esc-on-row" });
    results.d = { escOnRow: r1 };
    cap.add("d/esc-on-row — hooks", r1.hooks ?? "(n/a)"); cap.add("d/esc-on-row — summary", summarize(r1));
    // Esc on the DIALOG (s → dialog → Esc), and No row
    const r2 = await switchVia(s, { label: "Haiku", key: "s", answer: "esc", tag: "d/s-then-dialog-esc" });
    results.d.dialogEsc = r2; cap.add("d/s-then-dialog-esc — hooks", r2.hooks ?? "(n/a)"); cap.add("d/s-then-dialog-esc — summary", summarize(r2));
    const r3 = await switchVia(s, { label: "Haiku", key: "s", answer: 2, tag: "d/s-then-dialog-no" });
    results.d.dialogNo = r3; cap.add("d/s-then-dialog-no — hooks", r3.hooks ?? "(n/a)"); cap.add("d/s-then-dialog-no — summary", summarize(r3));
    await s.close();
  }
  if (ARMS.includes("e")) {
    const s = new Session("e-effort", { model: "fable" });
    cap.add("e — boot", JSON.stringify(await s.boot()));
    cap.add("e — warm-up", JSON.stringify(await s.turn(WARMUP)));
    // e1: bare /effort
    const o = await s.openPicker("/effort");
    cap.frame(s.probe, `e1 — after bare /effort (open=${o.open}, +${o.openMs}ms)`);
    const e1 = { open: o, rows: s.rows(), hint: s.hintLine(), screenHasS: /\bs to /.test(s.screen()) };
    cap.add("e1 — /effort picker rows + hint", `${e1.rows.map((x) => `${x.focused ? "❯" : " "} ${x.digit}. ${x.text}`).join("\n")}\nhint: ${e1.hint}\n's to' present: ${e1.screenHasS}`);
    if (o.open) {
      // The /effort picker is a SLIDER (←/→), not rows. Its footer reads
      // `←/→ to adjust · Enter to confirm · s for this session only · Esc to cancel`.
      const raw0 = s.probe.raw.length; const t = Date.now(); const st0 = s.statusline();
      const sliderBefore = s.lines().find((l) => /▲/.test(l))?.trim() ?? null;
      s.write(RIGHT); await sleep(500);
      const sliderAfter = s.lines().find((l) => /▲/.test(l))?.trim() ?? null;
      cap.frame(s.probe, "e1 — after → (one step up)");
      s.write("s");
      let dialogAt = null; const dl = Date.now() + 8000;
      while (Date.now() < dl) { await sleep(120); if (s.dialogOnGrid()) { dialogAt = Date.now() - t; break; } if (!s.effortPickerOpen() && Date.now() > t + 1500) break; }
      let ans = null; if (dialogAt !== null) { cap.frame(s.probe, "e1 — dialog after s"); ans = await s.answerDialogRow(1); await sleep(3000); }
      await sleep(2500);
      cap.frame(s.probe, "e1 — after `s` (→ then s)");
      e1.afterS = { sliderBefore, sliderAfter, dialogAt, ans, receipts: s.receiptsSince(raw0), hooks: fmtHooks(s.hooksSince(t), t), statusline: `${st0?.effort}→${s.statusline()?.effort}`, settings: guard.diffSinceSnapshot(), pickerStillOpen: s.effortPickerOpen(), dialog: s.dialogOnGrid() };
      cap.add("e1 — after → then `s`", JSON.stringify(e1.afterS));
      if (s.effortPickerOpen() || s.dialogOnGrid()) { s.write(KEYS.esc); await sleep(800); }
      if (s.effortPickerOpen()) { s.write(KEYS.esc); await sleep(800); }
      // and Enter (the persisting form) for the contrast row — measure what it writes
      const o3 = await s.openPicker("/effort");
      if (o3.open) {
        const raw2 = s.probe.raw.length; const t3 = Date.now(); const st2 = s.statusline();
        s.write(LEFT); await sleep(500); s.write(KEYS.enter);
        let dialogAt3 = null; const dl3 = Date.now() + 8000;
        while (Date.now() < dl3) { await sleep(120); if (s.dialogOnGrid()) { dialogAt3 = Date.now() - t3; break; } if (!s.effortPickerOpen() && Date.now() > t3 + 1500) break; }
        if (dialogAt3 !== null) { await s.answerDialogRow(1); await sleep(3000); }
        await sleep(2500);
        cap.frame(s.probe, "e1b — after ← then Enter (persisting form)");
        e1.afterEnter = { dialogAt: dialogAt3, receipts: s.receiptsSince(raw2), hooks: fmtHooks(s.hooksSince(t3), t3), statusline: `${st2?.effort}→${s.statusline()?.effort}`, settings: guard.diffSinceSnapshot() };
        cap.add("e1b — after ← then Enter", JSON.stringify(e1.afterEnter));
        guard.restoreNow("e1b");
      }
    } else {
      // not a picker: maybe a receipt (usage text). record and clear the line
      e1.receipts = s.receiptsSince(0);
      s.write(KEYS.esc); await sleep(500);
    }
    results.e1 = e1;
    // e2: /model picker in-place effort ←/→ then s
    const o2 = await s.openPicker("/model");
    const st1 = s.statusline(); const raw1 = s.probe.raw.length; const t2 = Date.now();
    const effortBefore = s.effortLine();
    s.write(RIGHT); await sleep(600);
    const effortAfterArrow = s.effortLine();
    cap.frame(s.probe, `e2 — /model picker after → (effort line: ${effortBefore} → ${effortAfterArrow})`);
    s.write("s");
    let dialogAt = null; const dl = Date.now() + 8000;
    while (Date.now() < dl) { await sleep(120); if (s.dialogOnGrid()) { dialogAt = Date.now() - t2; break; } if (s.hooksSince(t2).some((h) => h.event === "PostModelSwitch")) break; }
    let ans = null; if (dialogAt !== null) { cap.frame(s.probe, "e2 — dialog"); ans = await s.answerDialogRow(1); await sleep(3000); }
    await sleep(2000);
    results.e2 = { open: o2, effortBefore, effortAfterArrow, dialogAt, ans, receipts: s.receiptsSince(raw1), hooks: fmtHooks(s.hooksSince(t2), t2), statusline: `${st1?.id}/${st1?.effort}→${s.statusline()?.id}/${s.statusline()?.effort}`, settings: guard.diffSinceSnapshot() };
    cap.frame(s.probe, "e2 — after"); cap.add("e2 — /model picker →(effort) then `s`", JSON.stringify(results.e2, null, 1));
    await s.close();
  }
  if (ARMS.includes("f")) {
    const s = new Session("f-repaint", { model: "opus[1m]" });
    cap.add("f — boot", JSON.stringify(await s.boot()));
    cap.add("f — warm-up", JSON.stringify(await s.turn(WARMUP)));
    const r1 = await switchVia(s, { label: "Haiku", key: "s", answer: 1, tag: "f/opus1m→haiku" });
    const r2 = await switchVia(s, { label: "Opus (1M context)", key: "s", answer: 1, tag: "f/haiku→opus1m" });
    results.f = { leg1: r1, leg2: r2 };
    cap.add("f/leg1 — hooks", r1.hooks ?? "(n/a)"); cap.add("f/leg1 — summary", summarize(r1));
    cap.add("f/leg2 — hooks", r2.hooks ?? "(n/a)"); cap.add("f/leg2 — summary", summarize(r2));
    // the F19 question: does the post-key window carry REPLAYED older receipts?
    const win = strip(s.probe.raw.slice(-CONTROL_SWITCH_SCAN_LIMIT));
    cap.add("f — last 4096-char window: model receipts visible", JSON.stringify({ setCount: (win.match(/Set model to/g) || []).length, keptCount: (win.match(/Kept model as/g) || []).length, snippets: [...win.matchAll(/(Set model to|Kept model as)[^\n]{0,60}/g)].map((m) => m[0]) }));
    await s.close();
  }
  if (ARMS.includes("g")) {
    const s = new Session("g-arming", { model: "fable" });
    cap.add("g — boot", JSON.stringify(await s.boot()));
    const typed = await s.typeAndVerify("/model", /\/model/);
    s.write(KEYS.enter);
    // Down at +0ms after the picker's first paint
    let openAt = null; const t = Date.now();
    while (Date.now() < t + 8000) { if (s.pickerOpen()) { openAt = Date.now() - t; break; } await sleep(10); }
    const f0 = s.focused()?.label ?? null;
    s.write(KEYS.down);
    await sleep(500);
    const f1 = s.focused()?.label ?? null;
    s.write(KEYS.down); await sleep(60); s.write(KEYS.down); await sleep(500);
    const f3 = s.focused()?.label ?? null;
    cap.frame(s.probe, "g — after Down@+0ms, then two Downs 60ms apart");
    results.g = { typed, openAt, focusedAtOpen: f0, afterDownAt0ms: f1, afterTwoMoreDowns60ms: f3, moved: f0 !== f1 };
    cap.add("g — arming window", JSON.stringify(results.g));
    s.write(KEYS.esc); await sleep(800);
    await s.close();
  }
} catch (error) {
  cap.add("PROBE ERROR", scrub(String(error?.stack ?? error)));
  exitCode = 1;
} finally {
  const g = guard.restore();
  cap.add("settings guard", JSON.stringify({ settings: { mutatedByProbe: g.mutatedByProbe, restored: g.restored, changedKeys: g.changedKeys ?? [] }, claudeJson: g.projectCleanup }));
  const endPin = readVersion();
  cap.add("version at end", endPin);
  if (!endPin.startsWith(EXPECT_VERSION)) { cap.add("VERSION DRIFT", `${startPin} → ${endPin}`); exitCode = 2; }
  fs.writeFileSync(path.join(ROOT, `m2-results.${ARMS.join("")}.json`), scrub(JSON.stringify(results, null, 2)));
  cap.save();
  process.exit(exitCode);
}
