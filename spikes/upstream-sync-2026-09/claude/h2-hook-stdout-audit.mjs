// H2 (2026-09 sync, SL-9) — the STRICT-JSON HOOK STDOUT audit.
//
// QUESTION (brief objective 3): 2.1.248 is reported to make malformed hook stdout
// a HARD error. Sonata installs TWO hook commands on every claude spawn — the
// fire-and-forget sink (`hook-sink.js`, 8 events) and the approval broker
// (`approval-broker.js`, PermissionRequest). Every byte either can emit, on every
// path (normal, empty stdin, malformed stdin, unwritable dir, missing argv,
// timeout, reply), must be audited against whatever 2.1.258 actually does.
//
// THREE PARTS, because a static read and a live drive answer different halves:
//
//  A. CONTRACT (static, from the 2.1.258 binary). The parse function is `I5e` in
//     `bin/claude.exe`; its text is quoted verbatim in the capture. It is NOT a
//     blanket hard error: output that does not start with `{` is treated as plain
//     text, and so is a `{`-leading string that does NOT end with `}`, and so are
//     several concatenated JSON documents. The hard path is exactly:
//     `validationError` — set when the output starts with `{` AND (parses as JSON
//     but fails the hook-output schema) OR (ends with `}` and is not valid JSON
//     and is not JSON-lines). Two call sites consume it: one `throw`s, one yields
//     `hook_non_blocking_error`.
//
//  B. SONATA'S BYTES (measured). Every reachable path of the REAL dist sink and
//     broker, run as real processes over adversarial stdin, stdout captured
//     byte-exactly. Run TWICE — once under plain `node`, once under the
//     PRODUCTION interpreter shape (`ELECTRON_RUN_AS_NODE=1 <electron>`) — because
//     the audit is of the COMMAND's bytes, and an interpreter that greeted stdout
//     would be Sonata's problem too.
//
//  C. THE PREMISE (live, decisive). A real `claude -p --settings <file>` run whose
//     SessionStart hook emits one adversarial class per arm, with
//     `--output-format stream-json --verbose`, so the CLI's OWN verdict per class
//     is on the record instead of inferred from A.
//
// Scratch dirs are /private/tmp/... (never the agent scratchpad, whose path
// embeds the username): these frames become findings and the pre-push leak fence
// scans blob content.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawn, spawnSync } from "node:child_process";

const OUT_DIR = new URL(".", import.meta.url).pathname;
const APP_DIR = new URL("../../../app/", import.meta.url).pathname;
const DIST = path.join(APP_DIR, "dist");
const SINK_JS = path.join(DIST, "runtime/cli-signal/hook-sink.js");
const BROKER_JS = path.join(DIST, "runtime/cli-signal/approval-broker.js");
const ELECTRON = path.join(APP_DIR, "node_modules/electron/dist/Electron.app/Contents/MacOS/Electron");

const EXPECT_VERSION = "2.1.258";
const ROOT = "/private/tmp/sonata-sync-2026-09/hook-stdout-audit";

const HOME = os.homedir();
const USER_MUNGED = `-${HOME.replace(/\//g, "-").replace(/^-/, "")}-`;
const sanitize = (value) =>
  String(value).split(HOME).join("$HOME").split(USER_MUNGED).join("-$USER_MUNGED-");

function pinVersion(where) {
  const version = execFileSync("claude", ["--version"], { encoding: "utf8" }).trim();
  if (!version.startsWith(EXPECT_VERSION)) {
    console.log(JSON.stringify({ success: false, reason: `binary moved off ${EXPECT_VERSION} (${where})`, version }));
    process.exit(2);
  }
  return version;
}
const version = pinVersion("probe start");

fs.rmSync(ROOT, { recursive: true, force: true });
fs.mkdirSync(ROOT, { recursive: true });

// ─── A. the contract, extracted from the binary ─────────────────────────────
// Located by needle rather than offset so a re-run on a moved binary either
// finds the same function or reports that it is gone.
function extractParseContract() {
  const binary = execFileSync("bash", ["-c", 'readlink -f "$(which claude)" || which claude'], {
    encoding: "utf8",
  }).trim();
  const hay = fs.readFileSync(binary).toString("latin1");
  const start = hay.indexOf("function I5e(e){let n=e.trim();");
  if (start < 0) return { found: false, binary: sanitize(binary) };
  const text = hay.slice(start, start + 900);
  const end = text.indexOf("function wJo(");
  return { found: true, binary: sanitize(binary), source: end > 0 ? text.slice(0, end) : text };
}
const contract = extractParseContract();

/** The 2.1.258 verdict for a given stdout string, implemented from `I5e` above.
 *  `schemaOk` is the one term this cannot decide locally (the zod schema lives in
 *  the bundle) — part C measures it. */
function classify(stdout, { schemaOk = null } = {}) {
  const n = stdout.trim();
  if (!n.startsWith("{")) return { verdict: "plainText", why: "does not start with {" };
  let parsed = null;
  try {
    parsed = JSON.parse(n);
  } catch {
    if (!n.endsWith("}")) return { verdict: "plainText", why: "starts with { but does not end with }" };
    // `wJo` (the JSON-lines escape hatch) is APPROXIMATED here: the real one also
    // requires each line to be schema-INVALID or to validate to an EMPTY object,
    // which needs the bundle's own zod schema. Part C's `json-lines` arm measured
    // the difference — two `{"continue":true}` lines are NOT excused — so the
    // approximation is only trusted where part C corroborates it. Live wins.
    const lines = n.split("\n").filter((l) => l.trim() !== "");
    if (lines.length >= 2 && lines.every((l) => l.trim() === "{}")) {
      return { verdict: "plainText", why: "several EMPTY JSON documents (JSON lines)" };
    }
    return { verdict: "HARD", why: "starts with { and ends with } but is not valid JSON → validationError" };
  }
  if (parsed && typeof parsed === "object" && parsed.async === true) {
    return { verdict: "json(async)", why: "async envelope" };
  }
  if (schemaOk === false) return { verdict: "HARD", why: "valid JSON, fails the hook-output schema → validationError" };
  return { verdict: "json", why: "valid JSON object (schema decided live in part C)" };
}

// ─── B. every byte Sonata's two hook commands can emit ──────────────────────

const INTERPRETERS = [
  { name: "node", cmd: process.execPath, args: [], env: {} },
  // The production shape: `ELECTRON_RUN_AS_NODE=1 "${SONATA_NODE:-node}"` with
  // SONATA_NODE = the running Sonata binary (here, the dev Electron).
  { name: "electron-as-node", cmd: ELECTRON, args: [], env: { ELECTRON_RUN_AS_NODE: "1" } },
];

function runScript(interpreter, script, argv, input, { env = {}, timeoutMs = 20_000 } = {}) {
  const started = Date.now();
  // No `encoding` — spawnSync then returns raw Buffers for stdout/stderr, which
  // is what a BYTE audit needs (and lets `input` be a Buffer for the invalid-UTF-8
  // case, which an `encoding` would try to apply to the input too).
  const res = spawnSync(interpreter.cmd, [...interpreter.args, script, ...argv], {
    input,
    timeout: timeoutMs,
    env: { ...process.env, ...interpreter.env, ...env },
  });
  return {
    status: res.status,
    signal: res.signal,
    stdoutBytes: res.stdout ? res.stdout.length : 0,
    stdout: res.stdout ? res.stdout.toString("utf8") : "",
    stderr: res.stderr ? res.stderr.toString("utf8") : "",
    ms: Date.now() - started,
  };
}

/** The sink's paths. It is a WRITE-ONLY observer: the audit question is whether
 *  ANY of them can put a byte on stdout. */
function sinkCases() {
  const dir = (name) => {
    const p = path.join(ROOT, "sink", name);
    fs.mkdirSync(p, { recursive: true });
    return p;
  };
  const unwritable = dir("unwritable-parent");
  const blocked = path.join(unwritable, "blocked");
  fs.writeFileSync(blocked, "not a directory"); // mkdirSync(blocked) → ENOTDIR
  const readonly = dir("readonly-parent");
  fs.chmodSync(readonly, 0o500);

  return [
    { name: "normal payload", argv: [dir("normal")], input: JSON.stringify({ hook_event_name: "Stop", session_id: "s" }) },
    { name: "empty stdin", argv: [dir("empty")], input: "" },
    { name: "whitespace-only stdin", argv: [dir("ws")], input: "   \n\t\n " },
    { name: "malformed stdin (not JSON)", argv: [dir("bad")], input: "{not json at all" },
    { name: "no argv (outputDirectory missing)", argv: [], input: JSON.stringify({ hook_event_name: "Stop" }) },
    { name: "ENOTDIR output path", argv: [blocked], input: JSON.stringify({ hook_event_name: "Stop" }) },
    { name: "EACCES output parent (mode 0500)", argv: [path.join(readonly, "hooks")], input: JSON.stringify({ hook_event_name: "Stop" }) },
    { name: "1 MB payload", argv: [dir("huge")], input: JSON.stringify({ hook_event_name: "Stop", last_assistant_message: "x".repeat(1_000_000) }) },
    { name: "invalid UTF-8 bytes in stdin", argv: [dir("binary")], input: Buffer.from([0x7b, 0x22, 0x61, 0x22, 0x3a, 0x22, 0xff, 0xfe, 0x22, 0x7d]) },
  ];
}

/** The broker's paths. `answer()` is the ONLY one that writes stdout, and what it
 *  writes is the reply file's bytes VERBATIM — so the reply writer is inside the
 *  audit boundary too (`writeApprovalReply` = `JSON.stringify(decision)`). */
function brokerCases() {
  const dir = (name) => {
    const p = path.join(ROOT, "broker", name);
    fs.mkdirSync(p, { recursive: true });
    return p;
  };
  const productionDecision = JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "PermissionRequest",
      decision: { behavior: "allow", updatedPermissions: [{ type: "addRules", rules: [{ toolName: "Bash", ruleContent: "ls *" }], behavior: "allow", destination: "session" }] },
    },
  });
  const readonly = dir("ro");
  fs.chmodSync(readonly, 0o500);
  return [
    { name: "no argv (controlDir missing)", argv: [], input: JSON.stringify({ tool_name: "Bash" }), reply: null },
    { name: "AskUserQuestion (undecided exit)", argv: [dir("askuq"), "3000"], input: JSON.stringify({ tool_name: "AskUserQuestion" }), reply: null },
    { name: "empty stdin → timeout/expire", argv: [dir("empty"), "1500"], input: "", reply: null },
    { name: "malformed stdin → timeout/expire", argv: [dir("badjson"), "1500"], input: "{nope", reply: null },
    { name: "unwritable controlDir (0500)", argv: [path.join(readonly, "approvals"), "1500"], input: JSON.stringify({ tool_name: "Bash" }), reply: null },
    { name: "timeout with no reply", argv: [dir("timeout"), "1500"], input: JSON.stringify({ tool_name: "Bash" }), reply: null },
    { name: "reply: allow (production shape)", argv: [dir("allow"), "8000"], input: JSON.stringify({ tool_name: "Bash", tool_input: { command: "ls" } }), reply: JSON.stringify({ hookSpecificOutput: { hookEventName: "PermissionRequest", decision: { behavior: "allow" } } }) },
    { name: "reply: deny (production shape)", argv: [dir("deny"), "8000"], input: JSON.stringify({ tool_name: "Bash" }), reply: JSON.stringify({ hookSpecificOutput: { hookEventName: "PermissionRequest", decision: { behavior: "deny" } } }) },
    { name: "reply: approve-always (updatedPermissions)", argv: [dir("always"), "8000"], input: JSON.stringify({ tool_name: "Bash", tool_input: { command: "ls -la" } }), reply: productionDecision },
    // The FLUSH question: `process.stdout.write(d); process.exit(0)` on a macOS
    // PIPE is an async write followed by an immediate exit. Node documents that
    // as lossy. A 4 MB reply is far past any pipe buffer, so if truncation is
    // reachable at all, it is reachable here.
    { name: "reply: 4 MB (stdout flush stress)", argv: [dir("huge"), "20000"], input: JSON.stringify({ tool_name: "Bash" }), reply: JSON.stringify({ hookSpecificOutput: { hookEventName: "PermissionRequest", decision: { behavior: "allow", note: "y".repeat(4_000_000) } } }) },
  ];
}

function runBroker(interpreter, testCase) {
  return new Promise((resolve) => {
    const child = spawn(interpreter.cmd, [...interpreter.args, BROKER_JS, ...testCase.argv], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, ...interpreter.env },
    });
    const started = Date.now();
    const stdoutChunks = [];
    let stderr = "";
    child.stdout.on("data", (d) => stdoutChunks.push(d));
    child.stderr.on("data", (d) => (stderr += d));
    let poller = null;
    if (testCase.reply !== null && testCase.argv[0]) {
      poller = setInterval(() => {
        let asks = [];
        try {
          asks = fs.readdirSync(testCase.argv[0]).filter((n) => /^ask-.+\.json$/.test(n));
        } catch {
          return;
        }
        if (asks.length === 0) return;
        clearInterval(poller);
        poller = null;
        const id = asks[0].replace(/^ask-/, "").replace(/\.json$/, "");
        const replyPath = path.join(testCase.argv[0], `reply-${id}.json`);
        // tmp+rename, exactly as `writeApprovalReply` does.
        fs.writeFileSync(`${replyPath}.tmp`, testCase.reply, "utf8");
        fs.renameSync(`${replyPath}.tmp`, replyPath);
      }, 30);
    }
    const guard = setTimeout(() => child.kill("SIGKILL"), 60_000);
    child.on("close", (status, signal) => {
      if (poller) clearInterval(poller);
      clearTimeout(guard);
      const stdout = Buffer.concat(stdoutChunks);
      resolve({
        status,
        signal,
        stdoutBytes: stdout.length,
        stdout: stdout.toString("utf8"),
        stderr,
        ms: Date.now() - started,
      });
    });
    child.stdin.end(testCase.input);
  });
}

const partB = [];
for (const interpreter of INTERPRETERS) {
  if (interpreter.name === "electron-as-node" && !fs.existsSync(ELECTRON)) {
    partB.push({ interpreter: interpreter.name, skipped: "electron binary not present" });
    continue;
  }
  for (const testCase of sinkCases()) {
    const result = runScript(interpreter, SINK_JS, testCase.argv, testCase.input);
    partB.push({
      interpreter: interpreter.name,
      command: "hook-sink.js",
      case: testCase.name,
      exit: result.status,
      signal: result.signal,
      stdoutBytes: result.stdoutBytes,
      stdout: result.stdout,
      stderrExcerpt: result.stderr.slice(0, 200),
      verdict: classify(result.stdout),
      ms: result.ms,
    });
  }
  for (const testCase of brokerCases()) {
    const result = await runBroker(interpreter, testCase);
    const replyLen = testCase.reply === null ? null : testCase.reply.length;
    partB.push({
      interpreter: interpreter.name,
      command: "approval-broker.js",
      case: testCase.name,
      exit: result.status,
      signal: result.signal,
      replyBytesWritten: replyLen,
      stdoutBytes: result.stdoutBytes,
      stdoutIsVerbatimReply: testCase.reply === null ? null : result.stdout === testCase.reply,
      stdout: result.stdout.length > 300 ? `${result.stdout.slice(0, 150)}…[${result.stdout.length} chars]…${result.stdout.slice(-60)}` : result.stdout,
      stderrExcerpt: result.stderr.slice(0, 200),
      verdict: classify(result.stdout),
      ms: result.ms,
    });
  }
}

// ─── C. the premise, live against 2.1.258 ───────────────────────────────────
// One `claude -p` run per adversarial class, each with a settings file whose
// SessionStart hook emits exactly that class on stdout. `-p` runs the same hook
// engine as the interactive session (it is the same binary and the same runner),
// and `--output-format stream-json --verbose` surfaces the CLI's own verdict.

const CLASSES = [
  { id: "empty", emit: "", why: "the sink's normal output (it never writes stdout)" },
  { id: "whitespace", emit: "  \\n ", why: "trailing newline only" },
  { id: "plain-text", emit: "hello from a hook", why: "no leading brace" },
  { id: "brace-unclosed", emit: '{"hookSpecificOutput":{"hookEventName":"SessionStart"', why: "a TRUNCATED decision — starts with { , does NOT end with }" },
  { id: "brace-closed-invalid", emit: '{"hookSpecificOutput":{"hookEventName":"SessionStart"}', why: "a truncation that happens to end with } — the predicted HARD path" },
  { id: "valid-unknown-fields", emit: '{"sonata":"observer","note":1}', why: "valid JSON, no field the schema knows" },
  { id: "valid-schema-shape", emit: '{"continue":true,"suppressOutput":true}', why: "valid JSON in the documented shape" },
  { id: "json-lines", emit: '{"continue":true}\\n{"continue":true}', why: "several JSON documents" },
];

function writeArmSettings(dir, emit) {
  const emitter = path.join(dir, "emit.js");
  // A literal emitter: no JSON encoder, so the bytes are exactly `emit`.
  fs.writeFileSync(emitter, `process.stdout.write(${JSON.stringify(emit.replace(/\\n/g, "\n"))});\n`, "utf8");
  const settingsPath = path.join(dir, "settings.json");
  fs.writeFileSync(
    settingsPath,
    JSON.stringify({
      hooks: {
        SessionStart: [{ hooks: [{ type: "command", command: `"${process.execPath}" "${emitter}"` }] }],
      },
    }),
    "utf8",
  );
  return settingsPath;
}

function runClaudeArm(arm) {
  const dir = path.join(ROOT, "live", arm.id);
  fs.mkdirSync(dir, { recursive: true });
  const settingsPath = writeArmSettings(dir, arm.emit);
  const res = spawnSync(
    "claude",
    [
      "-p",
      "Reply with exactly: OK",
      "--settings",
      settingsPath,
      "--output-format",
      "stream-json",
      "--verbose",
      "--permission-mode",
      "default",
    ],
    { cwd: dir, encoding: "utf8", timeout: 180_000, env: { ...process.env } },
  );
  const lines = (res.stdout ?? "").split("\n").filter((l) => l.trim());
  const parsed = lines.map((l) => {
    try {
      return JSON.parse(l);
    } catch {
      return { _unparsed: l.slice(0, 300) };
    }
  });
  // Every message that mentions a hook, in whatever shape the CLI streams it.
  const hookMessages = parsed.filter((m) => JSON.stringify(m).toLowerCase().includes("hook"));
  return {
    class: arm.id,
    why: arm.why,
    emitted: arm.emit,
    predicted: classify(arm.emit.replace(/\\n/g, "\n")),
    exit: res.status,
    signal: res.signal,
    streamLines: lines.length,
    hookMessages: hookMessages.map((m) => sanitize(JSON.stringify(m)).slice(0, 700)),
    stderrExcerpt: sanitize(res.stderr ?? "").slice(0, 900),
    finalResult: (() => {
      const last = parsed.filter((m) => m.type === "result").pop();
      if (!last) return null;
      return { subtype: last.subtype, is_error: last.is_error, result: typeof last.result === "string" ? last.result.slice(0, 120) : last.result };
    })(),
  };
}

const partC = [];
const liveArms = process.argv.includes("--no-live") ? [] : CLASSES;
for (const arm of liveArms) {
  process.stderr.write(`\n=== live arm ${arm.id} ===\n`);
  try {
    const result = runClaudeArm(arm);
    partC.push(result);
    process.stderr.write(`${arm.id}: exit=${result.exit} predicted=${result.predicted.verdict} hookMessages=${result.hookMessages.length}\n`);
  } catch (error) {
    partC.push({ class: arm.id, error: String(error?.stack ?? error) });
  }
}

// ─── D. the same classes on the PERMISSIONREQUEST path ──────────────────────
// Part C measures a fire-and-forget event (SessionStart), which is where the
// SINK lives. But the BROKER lives on `PermissionRequest`, and the bundle has TWO
// consumers of `validationError`: one yields a non-blocking error, the other
// `throw`s. A malformed decision is therefore not necessarily the same class of
// failure as a malformed observation — and PermissionRequest is the one place
// Sonata writes stdout at all. This arm asks a `-p` run to write a file (which
// needs permission in default mode) with the PermissionRequest hook emitting one
// class per arm, and records whether the tool ran, was denied, or the run broke.

const PR_CLASSES = [
  { id: "pr-valid-allow", emit: '{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"allow"}}}', why: "Sonata's production allow, byte-for-byte" },
  { id: "pr-valid-deny", emit: '{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"deny"}}}', why: "Sonata's production deny, byte-for-byte" },
  { id: "pr-always-rule", emit: '{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"allow","updatedPermissions":[{"type":"addRules","rules":[{"toolName":"Write"}],"behavior":"allow","destination":"session"}]}}}', why: "Sonata's approve-always shape — does updatedPermissions still validate at 2.1.258?" },
  { id: "pr-truncated-brace", emit: '{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"allow"}}', why: "the MEASURED truncation shape that ends on a } — the predicted hard path, on the decision channel" },
  { id: "pr-empty", emit: "", why: "the broker's timeout/undecided path (no stdout) → native panel" },
];

function runPermissionArm(arm) {
  const dir = path.join(ROOT, "live-pr", arm.id);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  const emitter = path.join(dir, "emit.js");
  fs.writeFileSync(emitter, `process.stdout.write(${JSON.stringify(arm.emit)});\n`, "utf8");
  const settingsPath = path.join(dir, "settings.json");
  fs.writeFileSync(
    settingsPath,
    JSON.stringify({
      hooks: {
        PermissionRequest: [{ matcher: "*", hooks: [{ type: "command", command: `"${process.execPath}" "${emitter}"`, timeout: 60 }] }],
      },
    }),
    "utf8",
  );
  const res = spawnSync(
    "claude",
    ["-p", "Create a file named hello.txt in the current directory containing the single word hi. Then reply with exactly: DONE",
     "--settings", settingsPath, "--output-format", "stream-json", "--verbose", "--permission-mode", "default"],
    { cwd: dir, encoding: "utf8", timeout: 240_000, env: { ...process.env } },
  );
  const parsed = (res.stdout ?? "").split("\n").filter((l) => l.trim()).map((l) => {
    try { return JSON.parse(l); } catch { return { _unparsed: l.slice(0, 300) }; }
  });
  const hookResponses = parsed.filter((m) => m.subtype === "hook_response" && m.hook_event === "PermissionRequest");
  const last = parsed.filter((m) => m.type === "result").pop();
  return {
    class: arm.id,
    why: arm.why,
    emitted: arm.emit,
    predicted: classify(arm.emit),
    exit: res.status,
    hookResponses: hookResponses.map((m) => ({ outcome: m.outcome, exit_code: m.exit_code, stderr: sanitize(String(m.stderr ?? "")).slice(0, 300), stdout: String(m.stdout ?? "").slice(0, 200) })),
    // The ground truth: did the tool the hook was asked about actually run?
    fileWritten: fs.existsSync(path.join(dir, "hello.txt")),
    finalResult: last ? { subtype: last.subtype, is_error: last.is_error, result: typeof last.result === "string" ? last.result.slice(0, 200) : last.result } : null,
    stderrExcerpt: sanitize(res.stderr ?? "").slice(0, 600),
  };
}

const partD = [];
const prArms = process.argv.includes("--no-live") || process.argv.includes("--no-pr") ? [] : PR_CLASSES;
for (const arm of prArms) {
  process.stderr.write(`\n=== permission arm ${arm.id} ===\n`);
  try {
    const result = runPermissionArm(arm);
    partD.push(result);
    process.stderr.write(`${arm.id}: exit=${result.exit} outcomes=${result.hookResponses.map((h) => h.outcome).join(",") || "—"} fileWritten=${result.fileWritten}\n`);
  } catch (error) {
    partD.push({ class: arm.id, error: String(error?.stack ?? error) });
  }
}

pinVersion("probe end");

// ─── capture ────────────────────────────────────────────────────────────────
const capture = [
  "# H2 — claude hook STDOUT strict-JSON audit (SL-9)",
  "",
  `binary: ${version} (re-pinned at probe end)`,
  `sink:   ${sanitize(SINK_JS)}`,
  `broker: ${sanitize(BROKER_JS)}`,
  "",
  "## A — the parse contract at 2.1.258, verbatim from the binary",
  "",
  contract.found
    ? ["```js", contract.source, "```", "", "Reading it: `t(...)` is a debug log, not a failure. `validationError` is the ONLY",
       "hard signal — set on (a) valid JSON that fails the hook-output schema, or (b)",
       "`{`-leading text that ends with `}`, is not valid JSON, and is not JSON-lines.",
       "Everything else degrades to `{plainText}` with a debug line."].join("\n")
    : `PARSE CONTRACT NOT FOUND in ${contract.binary} — the needle moved; re-derive before trusting part B's classifier.`,
  "",
  "## B — every byte Sonata's two hook commands can emit",
  "",
  "| interpreter | command | case | exit | stdout bytes | verdict |",
  "|---|---|---|---|---|---|",
  ...partB.map((r) =>
    r.skipped
      ? `| ${r.interpreter} | — | SKIPPED: ${r.skipped} | | | |`
      : `| ${r.interpreter} | ${r.command} | ${r.case} | ${r.exit ?? `signal ${r.signal}`} | ${r.stdoutBytes} | ${r.verdict.verdict} |`,
  ),
  "",
  "### part B detail",
  "",
  "```json",
  sanitize(JSON.stringify(partB, null, 2)),
  "```",
  "",
  "## C — what 2.1.258 actually does with each class (LIVE, `claude -p`)",
  "",
  "| class | emitted | predicted (from A) | CLI exit | hook messages in the stream |",
  "|---|---|---|---|---|",
  ...partC.map((r) =>
    r.error
      ? `| ${r.class} | | | ERROR | ${r.error.slice(0, 120)} |`
      : `| ${r.class} | \`${r.emitted.replace(/\|/g, "\\|") || "(empty)"}\` | ${r.predicted.verdict} | ${r.exit} | ${r.hookMessages.length} |`,
  ),
  "",
  "### part C detail",
  "",
  "```json",
  sanitize(JSON.stringify(partC, null, 2)),
  "```",
  "",
  "## D — the same classes on the PermissionRequest channel (where the broker lives)",
  "",
  "UNREPRODUCED, and left in the capture as a negative-method record rather than",
  "deleted: `claude -p` does NOT run PermissionRequest hooks. Every arm — the",
  "valid `allow` included — shows zero `hook_response` messages for the event and",
  "no file written, i.e. the hook never fired and print mode denied the tool on",
  "its own. So NOTHING about the decision channel can be read off this table; the",
  "`predicted` column is the static classifier's opinion, not a measurement. The",
  "decision channel is measured instead by `h1-hook-census.mjs` arm",
  "`c2-approval-decision`, which drives a real interactive session through the",
  "PRODUCTION broker and checks the ground truth (did the file get written).",
  "",
  "| class | predicted | CLI exit | hook outcome(s) | tool actually ran? | final |",
  "|---|---|---|---|---|---|",
  ...partD.map((r) =>
    r.error
      ? `| ${r.class} | | ERROR | | | ${r.error.slice(0, 120)} |`
      : `| ${r.class} | ${r.predicted.verdict} | ${r.exit} | ${r.hookResponses.map((h) => h.outcome).join(", ") || "—"} | ${r.fileWritten ? "YES" : "no"} | ${r.finalResult?.subtype ?? "?"}${r.finalResult?.is_error ? " (is_error)" : ""} |`,
  ),
  "",
  "### part D detail",
  "",
  "```json",
  sanitize(JSON.stringify(partD, null, 2)),
  "```",
  "",
].join("\n");

fs.writeFileSync(path.join(OUT_DIR, "h2-hook-stdout-audit.capture.txt"), capture);

const sonataViolations = partB.filter((r) => !r.skipped && r.verdict.verdict === "HARD");
console.log(
  JSON.stringify(
    {
      success: true,
      version,
      contractFound: contract.found,
      sonataStdoutViolations: sonataViolations.length,
      sonataCasesWithAnyStdout: partB.filter((r) => !r.skipped && r.stdoutBytes > 0).map((r) => `${r.command}: ${r.case} (${r.stdoutBytes}B)`),
      brokerTruncations: partB.filter((r) => r.command === "approval-broker.js" && r.stdoutIsVerbatimReply === false).map((r) => `${r.interpreter}: ${r.case}`),
      live: partC.map((r) => ({ class: r.class, predicted: r.predicted?.verdict, exit: r.exit, hookMessages: r.hookMessages?.length })),
      permissionChannel: partD.map((r) => ({ class: r.class, predicted: r.predicted?.verdict, exit: r.exit, outcomes: r.hookResponses?.map((h) => h.outcome), fileWritten: r.fileWritten, final: r.finalResult?.subtype })),
    },
    null,
    2,
  ),
);
