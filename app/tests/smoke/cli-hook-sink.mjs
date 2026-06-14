import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";

// Direct requires (no node-pty via the runtime barrel).
const require = createRequire(import.meta.url);
const distRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../../dist");
const { ensureClaudeRuntimeSettings, claudeHooksDirectory, ClaudeHookWatcher } = require(
  path.join(distRoot, "runtime/cli-signal"),
);
const { CliStateModel } = require(path.join(distRoot, "runtime/cli-signal/cli-state"));
const hookSinkJs = path.join(distRoot, "runtime/cli-signal/hook-sink.js");

const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "duet-hooksink-"));

// ── 1) Merge-safe settings injection ────────────────────────────────────────
// duet writes ONLY its own statusLine + hooks into the --settings file; it never
// reads or embeds the user's hooks. Phase 0 proved Claude UNIONs hooks across
// all settings sources live (user + project + --settings all fired), so writing
// duet-only entries here cannot clobber the user's hooks — the non-clobber is a
// property of NOT managing them, plus Claude's union. Here we assert the shape.
const settingsPath = ensureClaudeRuntimeSettings(cwd);
const settings = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
assert.ok(settings.statusLine?.command, "statusLine coexists in the injected file");
assert.ok(settings.statusLine.command.includes("claude-statusline-sink.js"), "statusLine → usage sink");
for (const event of ["UserPromptSubmit", "PreToolUse", "PermissionRequest", "Stop"]) {
  const groups = settings.hooks?.[event];
  assert.ok(Array.isArray(groups) && groups.length === 1, `${event} has exactly one duet group`);
  const cmds = groups.flatMap((g) => g.hooks.map((h) => h.command));
  assert.equal(cmds.length, 1, `${event} injects exactly one duet command (no user clobber)`);
  assert.ok(cmds[0].includes("hook-sink.js"), `${event} → duet hook sink`);
}

// ── 2) Sink → watcher → CliState roundtrip ──────────────────────────────────
const hooksDir = claudeHooksDirectory(cwd);

// Simulate the CLI invoking the hook command for each event (payload on stdin).
function fireHook(payload) {
  const res = spawnSync("node", [hookSinkJs, hooksDir], {
    input: JSON.stringify(payload),
    encoding: "utf8",
  });
  assert.equal(res.status, 0, `hook sink exits 0 (${payload.hook_event_name})`);
}

const session_id = "smoke-session";
fireHook({ hook_event_name: "UserPromptSubmit", session_id });
fireHook({ hook_event_name: "PreToolUse", session_id, tool_name: "Bash", tool_input: { command: "ls" } });
fireHook({ hook_event_name: "PermissionRequest", session_id, tool_name: "Bash" });
fireHook({ hook_event_name: "Stop", session_id, last_assistant_message: "done" });

// Each invocation wrote exactly one file.
const written = fs.readdirSync(hooksDir).filter((f) => /^hook-.+\.json$/.test(f));
assert.equal(written.length, 4, "one file per hook invocation");

// The watcher consumes them in order, feeds CliState, and deletes them.
const observed = [];
const model = new CliStateModel((s) => observed.push(s.activity));
let lastWorkspace = null;
const watcher = new ClaudeHookWatcher({
  pollMs: 20,
  onPayload: (payload, workspace) => {
    lastWorkspace = workspace;
    model.applyHook(payload);
  },
});
watcher.watchWorkspace(cwd);

await new Promise((r) => setTimeout(r, 300));
watcher.dispose();

assert.equal(path.resolve(lastWorkspace), path.resolve(cwd), "watcher reports the workspace for routing");
assert.equal(model.current().activity, "turn-ended", "Stop hook ended the turn");
// busy (UserPromptSubmit) → busy with tool=Bash (PreToolUse changes the tool field)
// → waiting-approval (PermissionRequest) → turn-ended (Stop).
assert.deepEqual(observed, ["busy", "busy", "waiting-approval", "turn-ended"], "transitions in order");

const remaining = fs.readdirSync(hooksDir).filter((f) => /^hook-.+\.json$/.test(f));
assert.equal(remaining.length, 0, "watcher deletes consumed files (queue, not log)");

console.log("cli-hook-sink smoke: OK");
