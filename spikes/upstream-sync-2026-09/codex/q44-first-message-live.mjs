// Q44 (2026-09-23) — Woody's report: "Codex 新建 session 发第一条信息，有时发不过去，
// 消息直接不见了（terminal 里没有，主栏里也没有）". Reproduce the USER path in the
// real app (dev build, real codex, isolated Sonata data dirs): New Chat → Codex →
// pick folder → type → Send. N iterations. Each iteration checks three places:
// the codex rollout (file contract), the CLI window text, the reading surface.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
const APP = (process.env.SONATA_APP_DIR ? process.env.SONATA_APP_DIR.replace(/\/?$/, "/") : new URL("../../../app/", import.meta.url).pathname);
const require = createRequire(APP + "package.json");
const { _electron: electron } = require("playwright-core");
const { chooseDraftProvider, waitForWindowByUrl } = await import(APP + "tests/e2e/helpers/session.mjs");
const N = Number(process.argv[2] ?? 5);
const OUT = new URL(".", import.meta.url).pathname;
const ROOT = process.env.Q44_ROOT ?? "/private/tmp/sonata-q44-first-message";
fs.rmSync(ROOT, { recursive: true, force: true }); fs.mkdirSync(ROOT, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function rolloutsWith(text, sinceMs) {
  const hits = [];
  const d = new Date(); const day = `${d.getFullYear()}/${String(d.getMonth()+1).padStart(2,"0")}/${String(d.getDate()).padStart(2,"0")}`;
  const dir = path.join(os.homedir(), ".codex", "sessions", day);
  let files = []; try { files = fs.readdirSync(dir).map((f) => path.join(dir, f)); } catch { return hits; }
  for (const f of files) { try { if (fs.statSync(f).mtimeMs < sinceMs) continue; if (fs.readFileSync(f, "utf8").includes(text)) hits.push(path.basename(f)); } catch { /* */ } }
  return hits;
}
const results = [];
for (let i = 1; i <= N; i++) {
  const it = { i, t0: Date.now() };
  const root = path.join(ROOT, `run-${i}`); const project = path.join(root, "project");
  const kind = process.env.Q44_PROJECT_KIND ?? "git";
  it.projectKind = kind;
  if (kind === "git") { fs.mkdirSync(project, { recursive: true }); execFileSync("git", ["init", "-q"], { cwd: project }); }
  else if (kind === "plain") { fs.mkdirSync(project, { recursive: true }); }
  else if (kind === "worktree") { const bare = path.join(root, "repo.bare"); const seed = path.join(root, "seed"); fs.mkdirSync(seed, { recursive: true }); execFileSync("git", ["init", "-q", "-b", "main"], { cwd: seed }); fs.writeFileSync(path.join(seed, "a.txt"), "a\n"); execFileSync("git", ["-c", "user.email=q@q", "-c", "user.name=q", "add", "-A"], { cwd: seed }); execFileSync("git", ["-c", "user.email=q@q", "-c", "user.name=q", "commit", "-q", "-m", "seed"], { cwd: seed }); execFileSync("git", ["clone", "-q", "--bare", seed, bare]); execFileSync("git", ["-C", bare, "worktree", "add", "-q", project, "main"]); }
  else if (kind === "subdir") { const repo = path.join(root, "repo"); fs.mkdirSync(path.join(repo, "sub"), { recursive: true }); execFileSync("git", ["init", "-q"], { cwd: repo }); fs.renameSync(path.join(repo, "sub"), project); }
  fs.writeFileSync(path.join(project, "README.md"), "q44\n");
  const text = `Reply with exactly: q44-${i}-${Date.now().toString(36)}`;
  it.text = text;
  if (process.env.Q44_SEED_DATA_DIR) { fs.cpSync(process.env.Q44_SEED_DATA_DIR, path.join(root, "data"), { recursive: true }); it.seededDataDir = true; }
  if (process.env.Q44_SEED_SETTINGS_DIR) { fs.cpSync(process.env.Q44_SEED_SETTINGS_DIR, path.join(root, "settings"), { recursive: true }); it.seededSettingsDir = true; }
  if (process.env.Q44_SEED_CODEX_SETTINGS) { fs.mkdirSync(path.join(root, "settings"), { recursive: true }); fs.writeFileSync(path.join(root, "settings", "codex-settings.json"), process.env.Q44_SEED_CODEX_SETTINGS); it.seededCodexSettings = JSON.parse(process.env.Q44_SEED_CODEX_SETTINGS); }
  let app = null;
  try {
    app = await electron.launch({ cwd: APP, args: ["dist/main/main.js"], env: { ...process.env, ...(process.env.Q44_PATH_PREPEND ? { PATH: `${process.env.Q44_PATH_PREPEND}${path.delimiter}${process.env.PATH ?? ""}` } : {}), SONATA_DATA_DIR: path.join(root, "data"), SONATA_WORKSPACES_DIR: path.join(root, "workspaces"), SONATA_SETTINGS_DIR: path.join(root, "settings"), SONATA_TEST_PICK_FOLDER: project, SONATA_NOTIFICATIONS: "0" } });
    const main = await app.firstWindow(); main.setDefaultTimeout(30_000);
    const cli = await waitForWindowByUrl(app, "/terminal.html"); cli.setDefaultTimeout(30_000);
    if (!(await main.locator(".task-entry-panel").isVisible().catch(() => false))) { await main.locator("#sidebar-new-chat").click().catch(() => {}); }
    await main.locator(".task-entry-panel").waitFor({ state: "visible" });
    await chooseDraftProvider(main, "codex");
    await main.locator("#provider-chip", { hasText: "Codex" }).waitFor({ state: "visible" });
    await main.locator("#project-chip").click();
    await main.locator("#entry-choose-folder").click();
    await main.locator("#project-chip", { hasText: "project" }).waitFor({ state: "visible" });
    await sleep(300);
    await main.locator("#prompt-input").fill(text);
    it.sendDisabled = await main.locator("#send-prompt").isDisabled();
    const captured = {}; const capDir = path.join(root, "captured"); fs.mkdirSync(capDir, { recursive: true });
    const pollFiles = () => { const walk = (d) => { let es = []; try { es = fs.readdirSync(d, { withFileTypes: true }); } catch { return; } for (const e of es) { const q = path.join(d, e.name); if (e.isDirectory()) walk(q); else if (/hooks|approvals/.test(d) && !(q in captured)) { try { captured[q] = fs.readFileSync(q, "utf8"); fs.writeFileSync(path.join(capDir, `${Date.now()-it.t0}ms-${e.name}`), captured[q]); } catch { /* */ } } } }; walk(path.join(root, "data")); };
    const poller = setInterval(pollFiles, 100);
    it.bannerFirstAtMs = null; it.bannerFirstText = null;
    if (process.env.Q44_ARM_MARKER) fs.writeFileSync(process.env.Q44_ARM_MARKER, String(Math.floor(Date.now() / 1000)));
    const sentAt = Date.now();
    await main.locator("#send-prompt").click();
    it.sentAtMs = sentAt - it.t0;
    // poll 90 s
    const deadline = Date.now() + 90_000;
    it.rolloutAtMs = null; it.cliAtMs = null; it.cardAtMs = null;
    while (Date.now() < deadline) {
      if (it.rolloutAtMs === null && rolloutsWith(text, it.t0).length) it.rolloutAtMs = Date.now() - sentAt;
      if (it.cliAtMs === null) { const body = await cli.locator("body").innerText().catch(() => ""); if (body.includes(text.slice(0, 30))) it.cliAtMs = Date.now() - sentAt; }
      if (it.cardAtMs === null) { const n = await main.locator(".turn-card").count().catch(() => 0); if (n > 0) it.cardAtMs = Date.now() - sentAt; }
      if (it.bannerFirstAtMs === null) { const vis = await main.locator("#approval-banner").isVisible().catch(() => false); if (vis) { it.bannerFirstAtMs = Date.now() - sentAt; it.bannerFirstText = (await main.locator("#approval-banner").innerText().catch(() => "")).replace(/\s+/g, " ").trim(); } }
      if (it.rolloutAtMs !== null && it.cliAtMs !== null && it.cardAtMs !== null && Date.now() - sentAt > 20_000) break;
      await sleep(400);
    }
    clearInterval(poller); pollFiles(); it.capturedFiles = Object.keys(captured).map((k) => path.basename(k));
    it.sidebarSessions = await main.locator("#sidebar .session-row, .sidebar-session, [data-task-id]").count().catch(() => -1); it.taskStatus = await main.locator(".task-status, #task-status, .composer-note").first().innerText().catch(() => null);
    it.placeholder = await main.locator("#prompt-input").getAttribute("placeholder").catch(() => null);
    it.promptInputValue = await main.locator("#prompt-input").inputValue().catch(() => null);
    it.bannerText = await main.locator("#approval-banner").innerText().catch(() => null);
    it.statusText = await main.locator(".composer-status, #composer-status, .status-strip").first().innerText().catch(() => null);
    const cliBody = await cli.locator("body").innerText().catch(() => ""); it.cliTail = cliBody.split("\n").filter((l) => l.trim()).slice(-8); it.cliTrustDialog = /Trust this folder|Trust and continue|trust/i.test(cliBody); it.cliMigration = /Try new model|retires/i.test(cliBody);
    it.ok = it.rolloutAtMs !== null && it.cliAtMs !== null && it.cardAtMs !== null;
    if (!it.ok) { await main.screenshot({ path: path.join(OUT, `q44-run${i}-main.png`) }).catch(() => {}); await cli.screenshot({ path: path.join(OUT, `q44-run${i}-cli.png`) }).catch(() => {}); }
  } catch (e) { it.error = String(e?.message ?? e).slice(0, 400); }
  finally { try { await app?.close(); } catch { /* */ } }
  results.push(it);
  console.log(JSON.stringify({ i, kind: it.projectKind, trustDialog: it.cliTrustDialog, migration: it.cliMigration, ok: it.ok, bannerAt: it.bannerFirstAtMs, bannerText: it.bannerFirstText, captured: it.capturedFiles, sentAtMs: it.sentAtMs, rollout: it.rolloutAtMs, cli: it.cliAtMs, card: it.cardAtMs, placeholder: it.placeholder, inputValue: it.promptInputValue, banner: it.bannerText, error: it.error }));
  await sleep(1500);
}
fs.writeFileSync(path.join(OUT, (process.env.Q44_CAPTURE ?? "q44-first-message-live.capture.txt")), JSON.stringify({ probe: "q44", tree: execFileSync("git", ["rev-parse", "--short", "HEAD"], { cwd: APP, encoding: "utf8" }).trim(), codex: execFileSync("codex", ["--version"], { encoding: "utf8" }).trim(), results }, null, 2).replace(new RegExp(os.homedir(), "g"), "$HOME"));
console.log("PASS", results.filter((r) => r.ok).length, "/", N);
