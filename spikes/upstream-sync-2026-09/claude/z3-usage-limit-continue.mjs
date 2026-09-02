// Z3 (2026-09 sync, SL-12 / decision D1) — the USAGE-LIMIT AUTO-CONTINUE
// ("Continue automatically at usage limit", default-on since 2.1.234).
//
// WHAT CANNOT BE MEASURED, STATED UP FRONT. Reaching a real claude.ai usage limit
// on demand is not reproducible — it would mean burning this account's quota to
// exhaustion to observe one banner, which is exactly the cost the brief said to
// stop and report rather than pay. So the FIRE path (armed → reset → the CLI
// submitting its own continuation) is NOT measured here by anyone, and this probe
// does not pretend otherwise. What it measures is the part that IS observable
// without a limit:
//
//   1. Is the setting ON for this account, and where does its value come from?
//      Read off the live `/config` panel's own row, not inferred from
//      `settings.json` (which does not carry the key at all — measured).
//   2. Does the machine hold any FIELD evidence of a past episode? The
//      continuation prompt is a fixed literal, so a past auto-continue would be
//      sitting in a transcript verbatim. ~/.claude/projects is mined for it.
//
// The rest of the shape — which signals fire, and what they carry — is read from
// the binary and recorded in findings.md as STATIC evidence, labelled as such.
// The two literals mined for below are the CLI's own constants:
//   L (reset fire)  "Your claude.ai usage limit has reset. Continue the task…"
//   Z (early fire)  "Your claude.ai usage is available again before the…"
//
// READ-ONLY BY CONSTRUCTION. The `/config` panel is a live settings surface:
// Left/Right cycle an enum and Enter toggles a boolean, so this arm sends ONLY
// Down (move the cursor) and Esc (leave). The user-settings guard brackets the
// run regardless — F4h's lesson is that a probe must not have to be RIGHT about
// its own write-freedom.
//
// Scratch dirs are /private/tmp/... (never the agent scratchpad, whose path
// embeds the username): these frames become findings and the pre-push leak fence
// scans blob content.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";

const OUT_DIR = new URL(".", import.meta.url).pathname;
const APP_DIR = new URL("../../../app/", import.meta.url).pathname;
const require = createRequire(APP_DIR + "package.json");
const { Terminal } = require("@xterm/headless");
const { TerminalHost, HookWatcher, claudeHooksDirectory } = require(APP_DIR + "dist/runtime");

const EXPECT_VERSION = "2.1.258";
const ROOT = "/private/tmp/sonata-sync-2026-09/usage-limit";
const COLS = 120;
const ROWS = 40;
const SETTING_ROW = "Continue automatically at usage limit";

// The CLI's own continuation constants, mined from the 2.1.258 bundle. A past
// episode on this machine would have written one of them into a transcript.
const CONTINUATION_LITERALS = [
  "Your claude.ai usage limit has reset. Continue the task you were working on",
  "Your claude.ai usage is available again before the usage-limit reset",
];
// The TUI's own episode vocabulary, for the same search.
const EPISODE_BANNERS = [
  "Usage limit available",
  "Usage limit has reset",
  "Automatic continue cancelled",
  "Automatic continue was turned off",
  "Automatic continue stopped",
  "Automatic continue did not run",
];

const HOME = os.homedir();
const USER_MUNGED = `-${HOME.replace(/\//g, "-").replace(/^-/, "")}-`;
const sanitize = (value) =>
  String(value).split(HOME).join("$HOME").split(USER_MUNGED).join("-$USER_MUNGED-");

function pinVersion(where) {
  const version = execFileSync("claude", ["--version"], { encoding: "utf8" }).trim();
  return { version, drifted: !version.startsWith(EXPECT_VERSION), where };
}
const startPin = pinVersion("probe start");
if (startPin.drifted) {
  console.log(JSON.stringify({ success: false, reason: `binary moved off ${EXPECT_VERSION} at start`, version: startPin.version }));
  process.exit(2);
}
const version = startPin.version;

// ─── user-settings guard (SL-9 F41 / F4h incident) ──────────────────────────
const CLAUDE_SETTINGS =
  process.env.SONATA_PROBE_SETTINGS_PATH || path.join(os.homedir(), ".claude", "settings.json");
function snapshotUserSettings() {
  try { return { path: CLAUDE_SETTINGS, bytes: fs.readFileSync(CLAUDE_SETTINGS, "utf8") }; } catch { return null; }
}
function diffJsonKeys(beforeText, afterText) {
  try {
    const before = JSON.parse(beforeText);
    const after = JSON.parse(afterText ?? "{}");
    return [...new Set([...Object.keys(before), ...Object.keys(after)])]
      .filter((key) => JSON.stringify(before[key]) !== JSON.stringify(after[key]))
      .map((key) => `${key}: ${JSON.stringify(before[key])} → ${JSON.stringify(after[key])}`);
  } catch { return ["<unparseable; bytes differ>"]; }
}
function restoreUserSettings(snapshot) {
  if (!snapshot) return { checked: false };
  let after = null;
  try { after = fs.readFileSync(snapshot.path, "utf8"); } catch { /* deleted under us */ }
  if (after === snapshot.bytes) return { checked: true, mutatedByProbe: false, restored: true };
  try { fs.writeFileSync(snapshot.path, snapshot.bytes, "utf8"); }
  catch (error) { return { checked: true, mutatedByProbe: true, restored: false, error: String(error?.message ?? error) }; }
  const verified = (() => { try { return fs.readFileSync(snapshot.path, "utf8") === snapshot.bytes; } catch { return false; } })();
  return { checked: true, mutatedByProbe: true, restored: verified, changedKeys: diffJsonKeys(snapshot.bytes, after) };
}
const userSettings = snapshotUserSettings();
let settingsRestore = { checked: false };
const restoreOnce = () => {
  if (settingsRestore.checked) return settingsRestore;
  settingsRestore = restoreUserSettings(userSettings);
  if (settingsRestore.mutatedByProbe) {
    process.stderr.write(`\n[settings guard] the probe changed ~/.claude/settings.json (${(settingsRestore.changedKeys ?? []).join("; ")}) — restored: ${settingsRestore.restored}\n`);
  }
  return settingsRestore;
};
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => { restoreOnce(); process.exit(130); });
}

// ─── z3a: read the setting off the live /config panel ───────────────────────

class HostSession {
  constructor(name) {
    this.name = name;
    this.t0 = Date.now();
    this.hooks = [];
    this.events = [];
    this.notes = [];
    this.ptyExited = false;
    const runRoot = path.join(ROOT, name);
    fs.rmSync(runRoot, { recursive: true, force: true });
    this.workspace = path.join(runRoot, "ws");
    this.runtimeDir = path.join(runRoot, "runtime");
    fs.mkdirSync(this.workspace, { recursive: true });
    fs.mkdirSync(this.runtimeDir, { recursive: true });
    this.term = new Terminal({ cols: COLS, rows: ROWS, allowProposedApi: true, scrollback: 4000 });
    this.host = new TerminalHost({
      taskId: `task-z3-${name}`,
      provider: "claude",
      defaultWorkspace: this.workspace,
      eventSink: (event) => this.onHostEvent(event),
    });
    this.watcher = new HookWatcher({
      sinkDir: claudeHooksDirectory,
      pollMs: 100,
      onPayload: (payload) => this.onHookPayload(payload),
      onError: (error, filePath) => this.notes.push(`hook-watcher error ${filePath}: ${error.message}`),
    });
  }
  at() { return Date.now() - this.t0; }
  screen() {
    const b = this.term.buffer.active;
    const lines = [];
    for (let y = 0; y < this.term.rows; y++) {
      const line = b.getLine(b.viewportY + y);
      lines.push(line ? line.translateToString(true) : "");
    }
    while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
    return lines.join("\n");
  }
  onHostEvent(event) {
    if (event.type === "pty:data") { this.term.write(event.payload.data); return; }
    if (event.type === "report:updated" || event.type === "file:changed" || event.type === "run:updated") return;
    if (event.type === "pty:exit") this.ptyExited = true;
    this.events.push({ atMs: this.at(), type: event.type, kind: event.payload?.kind ?? null });
  }
  onHookPayload(payload) {
    const event = typeof payload.hook_event_name === "string" ? payload.hook_event_name : "<none>";
    this.hooks.push({ atMs: this.at(), event });
    if (event === "SessionStart") this.host.noteHookSessionStart();
  }
  async boot() {
    this.host.startTask({ cwd: this.workspace, runtimeDir: this.runtimeDir, permissionMode: "default", rows: ROWS, cols: COLS, approvalBroker: false });
    this.watcher.watchWorkspace(this.runtimeDir);
    // The EVENT path must win — `approval:detected` latches `approvalActive`, and
    // only `sendApprove()` clears it (z1's measured `ready=false at 90207ms`).
    const trustDetected = () => this.events.some((e) => e.type === "approval:detected" && e.kind === "workspace-trust");
    let trustAnswered = false;
    const eventDeadline = Date.now() + 15_000;
    while (Date.now() < eventDeadline && !this.ptyExited) {
      if (this.host.acceptsPromptInput()) break;
      if (trustDetected()) {
        trustAnswered = true;
        this.notes.push(`trust dialog answered via sendApprove at ${this.at()}ms`);
        await this.host.sendApprove().catch((error) => this.notes.push(`trust approve error: ${error?.message ?? error}`));
        break;
      }
      await delay(150);
    }
    if (!trustAnswered && !this.host.acceptsPromptInput() && !this.ptyExited) {
      const affirmFocused = () => this.screen().split("\n").some((l) => /❯\s*Yes, I trust this folder/i.test(l));
      if (/Yes, I trust this folder/i.test(this.screen())) {
        for (let i = 0; i < 6 && !affirmFocused(); i++) { await delay(500); this.host.writeRaw("\x1b[B"); await delay(350); }
        if (affirmFocused()) { this.host.writeRaw("\r"); this.notes.push(`trust dialog answered from the grid at ${this.at()}ms`); }
      }
    }
    const deadline = Date.now() + 90_000;
    let ok = false;
    while (Date.now() < deadline && !this.ptyExited) {
      if (this.host.acceptsPromptInput()) { ok = true; break; }
      await delay(200);
    }
    this.notes.push(`ready=${ok} at ${this.at()}ms`);
    await delay(2000);
    return ok;
  }
  dispose() { try { this.watcher.dispose(); this.host.dispose(); this.term.dispose(); } catch { /* best-effort */ } }
}

async function armConfigRow() {
  const session = new HostSession("z3a-config-row");
  if (!(await session.boot())) { const notes = session.notes; session.dispose(); return { scenario: "z3a-config-row", version, notes, verdict: "BOOT FAILED" }; }

  // Type the slash and submit SEPARATELY, grid-verifying the composer carries it
  // first — a bare `"/config\r"` can land while the CLI's own slash picker is
  // open, where CR selects the top fuzzy match instead of forwarding verbatim
  // (SL-10 register item).
  session.host.writeRaw("/config");
  await delay(1200);
  const slashOnComposer = session.screen().includes("/config");
  session.host.writeRaw("\r");
  const panelOpen = await (async () => {
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline) {
      if (/Auto-compact|Settings|Thinking mode/i.test(session.screen())) return true;
      await delay(250);
    }
    return false;
  })();

  // Walk DOWN only. Left/Right cycle an enum and Enter toggles a boolean, so
  // neither is ever sent; the row is read, never exercised.
  const frames = [];
  let rowLine = null;
  for (let step = 0; step < 24; step++) {
    const screen = session.screen();
    frames.push({ step, screen: sanitize(screen) });
    const hit = screen.split("\n").find((line) => line.includes(SETTING_ROW));
    if (hit && rowLine === null) rowLine = sanitize(hit);
    if (rowLine !== null && step > 2) break;
    session.host.writeRaw("\x1b[B");
    await delay(320);
  }
  // Leave the panel the way a user would.
  session.host.writeRaw("\x1b");
  await delay(1500);
  const screenAfterEsc = sanitize(session.screen().split("\n").slice(-12).join("\n"));

  const notes = session.notes;
  session.dispose();

  return {
    scenario: "z3a-config-row",
    version,
    notes,
    slashOnComposer,
    panelOpen,
    settingRowFound: rowLine !== null,
    settingRow: rowLine,
    // `settings.json` is checked too, because the interesting answer is that the
    // key is NOT there: the value is account/storage-scoped, not file-scoped, so
    // Sonata cannot read this setting off disk the way it reads `model`.
    settingsJsonHasKey: (() => {
      try { return Object.prototype.hasOwnProperty.call(JSON.parse(fs.readFileSync(CLAUDE_SETTINGS, "utf8")), "autoContinueAtUsageLimit"); }
      catch { return null; }
    })(),
    screenAfterEsc,
    frames: frames.slice(-3),
    verdict: rowLine === null
      ? `ROW NOT FOUND — "${SETTING_ROW}" did not appear in ${frames.length} /config frames (panelOpen=${panelOpen})`
      : `ROW READ — ${rowLine.trim()}`,
  };
}

// ─── z3b: field evidence of a past episode ──────────────────────────────────

/** Mine ~/.claude/projects for the CLI's own auto-continue literals. This is the
 *  only way a real limit episode can be observed without provoking one.
 *
 *  This session's OWN project directory is excluded, and the exclusion is
 *  load-bearing rather than tidy: the first pass of this search matched, and the
 *  match was this very probe's transcript quoting the literals while they were
 *  being written down. A search whose needle the searcher has just published into
 *  the haystack measures nothing. */
function armFieldEvidence() {
  const projects = path.join(HOME, ".claude", "projects");
  const selfMarkers = [
    // The agent session that authored this probe; anything under it is this
    // investigation talking to itself, not field history.
    "c6c948b4-928a-4af1-a9aa-263965437313",
    "sonata-sync-2026-09",
  ];
  const hits = [];
  let filesScanned = 0;
  const walk = (dir) => {
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (selfMarkers.some((marker) => full.includes(marker))) continue;
      if (entry.isDirectory()) { walk(full); continue; }
      if (!entry.name.endsWith(".jsonl")) continue;
      filesScanned++;
      let text = "";
      try { text = fs.readFileSync(full, "utf8"); } catch { continue; }
      for (const needle of [...CONTINUATION_LITERALS, ...EPISODE_BANNERS]) {
        if (text.includes(needle)) hits.push({ needle, file: sanitize(full) });
      }
    }
  };
  walk(projects);
  return {
    scenario: "z3b-field-evidence",
    version,
    projectDirs: (() => { try { return fs.readdirSync(projects).length; } catch { return null; } })(),
    filesScanned,
    selfExcluded: selfMarkers,
    needles: [...CONTINUATION_LITERALS, ...EPISODE_BANNERS],
    hits,
    verdict: hits.length === 0
      ? `NO FIELD EVIDENCE — ${filesScanned} transcripts hold none of the ${CONTINUATION_LITERALS.length + EPISODE_BANNERS.length} episode literals`
      : `${hits.length} FIELD HIT(S) — a real episode is on disk`,
  };
}

const ARMS = {
  "z3a-config-row": armConfigRow,
  "z3b-field-evidence": async () => armFieldEvidence(),
};

// ─── run ────────────────────────────────────────────────────────────────────
const RESULT_DIR = path.join(ROOT, "results");
fs.mkdirSync(RESULT_DIR, { recursive: true });

if (process.argv.includes("--self-test")) {
  if (!userSettings) { console.log(JSON.stringify({ selfTest: "SKIP — no settings file at " + CLAUDE_SETTINGS })); process.exit(0); }
  const mutated = userSettings.bytes.replace(/"model":\s*"[^"]*"/, '"model": "haiku"');
  fs.writeFileSync(CLAUDE_SETTINGS, mutated, "utf8");
  const seenMutated = fs.readFileSync(CLAUDE_SETTINGS, "utf8");
  const verdict = restoreOnce();
  const finalBytes = fs.readFileSync(CLAUDE_SETTINGS, "utf8");
  console.log(JSON.stringify({ selfTest: true, settingsPath: CLAUDE_SETTINGS, mutationLanded: seenMutated !== userSettings.bytes, guard: verdict, bytesBackToOriginal: finalBytes === userSettings.bytes, pass: seenMutated !== userSettings.bytes && verdict.restored === true && finalBytes === userSettings.bytes }, null, 2));
  process.exit(0);
}

const only = process.argv.slice(2).filter((arg) => !arg.startsWith("-"));
const selected = process.argv.includes("--capture-only") ? [] : only.length > 0 ? only : Object.keys(ARMS);

try {
  for (const name of selected) {
    const arm = ARMS[name];
    if (!arm) { console.error(`unknown arm: ${name}`); process.exitCode = 2; continue; }
    process.stderr.write(`\n=== ${name} ===\n`);
    let result;
    try { result = await arm(); } catch (error) { result = { scenario: name, error: String(error?.stack ?? error) }; }
    result.ranAt = new Date().toISOString();
    fs.writeFileSync(path.join(RESULT_DIR, `${name}.json`), JSON.stringify(result, null, 2));
    process.stderr.write(`${name}: ${result.verdict ?? result.error ?? "?"}\n`);
  }
} finally {
  restoreOnce();
}

const endPin = pinVersion("probe end");

const results = Object.keys(ARMS)
  .map((name) => path.join(RESULT_DIR, `${name}.json`))
  .filter((file) => fs.existsSync(file))
  .map((file) => JSON.parse(fs.readFileSync(file, "utf8")));

const configRow = results.find((r) => r.scenario === "z3a-config-row");
const field = results.find((r) => r.scenario === "z3b-field-evidence");

const capture = [
  "# Z3 — usage-limit auto-continue: what is observable WITHOUT provoking a limit (SL-12 / D1)",
  "",
  `binary: ${version}${endPin.drifted ? ` — DRIFTED to ${endPin.version} at probe end; capture SAVED, exit non-zero` : " (re-pinned at probe end)"}`,
  "",
  "SCOPE. The FIRE path (armed → reset → the CLI submitting its own continuation)",
  "is NOT measured, by anyone, here: provoking it means exhausting this account's",
  "quota. Everything below is what can be observed without paying that, plus the",
  "static shapes recorded in findings.md.",
  "",
  "## the setting, read off the live `/config` panel",
  "",
  configRow
    ? [
        `- \`/config\` reached the composer verbatim: ${configRow.slashOnComposer}`,
        `- panel opened: ${configRow.panelOpen}`,
        `- row found: **${configRow.settingRowFound}**`,
        `- row as rendered: \`${(configRow.settingRow ?? "—").trim()}\``,
        `- key present in \`~/.claude/settings.json\`: **${configRow.settingsJsonHasKey}**`,
        `- ${configRow.verdict}`,
      ].join("\n")
    : "(arm not run)",
  "",
  "## field evidence of a past episode",
  "",
  field
    ? [
        `- project dirs: ${field.projectDirs}; transcripts scanned: ${field.filesScanned}`,
        `- self-excluded (this investigation's own transcripts): ${JSON.stringify(field.selfExcluded)}`,
        `- needles: ${field.needles.length} CLI-owned literals (continuation prompts + episode banners)`,
        `- hits: ${JSON.stringify(field.hits)}`,
        `- **${field.verdict}**`,
      ].join("\n")
    : "(arm not run)",
  "",
  "## user-settings guard",
  "",
  "```json",
  JSON.stringify(settingsRestore, null, 2),
  "```",
  "",
  "## per-arm detail",
  "",
  ...results.map((result) => [`### ${result.scenario}`, "", "```json", sanitize(JSON.stringify(result, null, 2)), "```", ""].join("\n")),
].join("\n");

fs.writeFileSync(path.join(OUT_DIR, "z3-usage-limit-continue.capture.txt"), capture);
console.log(JSON.stringify({
  success: results.every((r) => !r.error) && !endPin.drifted,
  version,
  endVersion: endPin.version,
  arms: results.map((r) => ({ scenario: r.scenario, verdict: r.verdict ?? r.error ?? "?" })),
  userSettingsGuard: settingsRestore,
}, null, 2));
if (endPin.drifted) process.exit(3);

function delay(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }
