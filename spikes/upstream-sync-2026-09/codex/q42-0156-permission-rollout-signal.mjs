// Q42 (2026-09-23, X1 reconcile) — after a TERMINAL-side `/permissions` switch
// (Ask for approval → Approve for me), what does the ROLLOUT carry? Sonata's
// badge must come from the file, and `codexPermissionModeFromTurnContext` reads
// only sandbox_policy + approval_policy, which are identical for those two
// modes; `approvals_reviewer` (user / auto_review) is the candidate signal.
// Arms: switch, then ONE tiny turn (luna / low) so a turn_context is written.
// Records of interest: turn_context.payload.{approval_policy,approvals_reviewer,
// sandbox_policy}, and any thread_settings_applied / settings record.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CodexBoot, codexVersion, sanitize, seedCodexHome, sleep, writeCapture } from "./driver.mjs";
const ROOT = "/private/tmp/sonata-codex-0156-perm-rollout";
const OUT_DIR = new URL(".", import.meta.url).pathname;
const CR = "\r", DOWN = "\x1b[B", ESC = "\x1b";
fs.rmSync(ROOT, { recursive: true, force: true });
const workspace = path.join(ROOT, "cwd"), runtimeDir = path.join(ROOT, "runtime");
const codexHome = seedCodexHome(path.join(ROOT, "codex-home"), { withAuth: true });
fs.mkdirSync(workspace, { recursive: true }); fs.mkdirSync(runtimeDir, { recursive: true });
const boot = new CodexBoot({ taskId: "task-q42", cwd: workspace, runtimeDir, binDir: path.join(os.homedir(), ".sonata", "bin"), pretrustCwd: workspace, codexHome, rows: 40, cols: 120, approvalBroker: true });
boot.startOptions.model = "gpt-6-luna"; boot.startOptions.reasoningEffort = "low";
const out = { probe: "q42", version: codexVersion() };
const grid = () => boot.screen().split("\n").filter((l) => l.trim());
function rolloutRecords() {
  const files = []; const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else if (p.endsWith(".jsonl")) files.push(p); } };
  try { walk(path.join(codexHome, "sessions")); } catch { return []; }
  const recs = [];
  for (const f of files) for (const l of fs.readFileSync(f, "utf8").split("\n")) { if (!l.trim()) continue; try { recs.push(JSON.parse(l)); } catch { /* */ } }
  return recs;
}
const interesting = (recs) => recs.filter((r) => /turn_context|settings|thread_settings|permission|approval/i.test(r.type ?? "") || /approvals_reviewer|approval_policy/.test(JSON.stringify(r).slice(0, 4000))).map((r) => ({ type: r.type, payloadType: r.payload?.type ?? null, approval_policy: r.payload?.approval_policy ?? null, approvals_reviewer: r.payload?.approvals_reviewer ?? null, sandbox: r.payload?.sandbox_policy?.type ?? r.payload?.sandbox_policy ?? null, keys: Object.keys(r.payload ?? {}).slice(0, 12) }));
try {
  await boot.start();
  out.readyAtMs = await boot.waitUntil((b) => b.ready(), 90_000);
  await sleep(2000);
  out.beforeSwitch = interesting(rolloutRecords());
  // /permissions → Approve for me (row 2) → Enter
  boot.host.writeRaw("\x15".repeat(40)); await sleep(200);
  boot.host.writeRaw("/permissions"); await sleep(200); boot.host.writeRaw(CR);
  await boot.waitUntil((b) => /Update Model Permissions/.test(b.screen()), 8000, 60);
  await sleep(600);
  for (let i = 0; i < 4; i++) { const cur = grid().find((l) => /^\s*›\s*\d\./.test(l)) ?? ""; if (/Approve for me/.test(cur)) break; boot.host.writeRaw(DOWN); await sleep(300); }
  out.cursorBeforeEnter = grid().find((l) => /^\s*›\s*\d\./.test(l)) ?? null;
  boot.host.writeRaw(CR); await sleep(2500);
  out.afterSwitchScreenTail = grid().slice(-4);
  out.afterSwitchRecords = interesting(rolloutRecords());
  // one tiny turn
  boot.host.writeRaw("\x15".repeat(40)); await sleep(200);
  boot.host.writeRaw("Reply with exactly: ok"); await sleep(300); boot.host.writeRaw(CR);
  await boot.waitUntil((b) => /\bok\b/.test(b.screen().split("\n").slice(-12).join("\n")) && b.ready(), 60_000, 300);
  await sleep(2500);
  out.afterTurnRecords = interesting(rolloutRecords());
  out.afterTurnScreenTail = grid().slice(-5);
} catch (e) { out.fatal = String(e?.stack ?? e); } finally { boot.dispose(); await sleep(300); }
const p = writeCapture(OUT_DIR, "q42-0156-permission-rollout-signal.capture.txt", out);
console.log(sanitize(JSON.stringify(out, null, 2))); console.log("capture: " + p);
