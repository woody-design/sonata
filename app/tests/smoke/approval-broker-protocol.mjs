import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";

// Direct-spawn protocol test for the approval broker script (drawer S0):
//  A. AskUserQuestion payloads are NOT approvals — the broker exits undecided
//     immediately: no ask file, no stdout (probed on claude 2.1.212: the CLI
//     fires PermissionRequest(AskUserQuestion) alongside PreToolUse, and an
//     undecided exit leaves the native option form fully functional —
//     spikes/drawer-option-prompt-probe P1/P5).
//  B. A real tool payload surfaces ask-<id>.json, and a reply-<id>.json is
//     emitted verbatim on stdout (the decision channel) with the ask cleaned up.
//  C. The injected settings carry the S0 hold: broker argv 580_000ms inside a
//     600s hook timeout (the documented ceiling-of-record; >600 is undocumented).

const require = createRequire(import.meta.url);
const distRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../../dist");
const brokerJs = path.join(distRoot, "runtime/cli-signal/approval-broker.js");
const { ensureClaudeRuntimeSettings } = require(path.join(distRoot, "runtime/cli-signal"));

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "sonata-broker-"));

function runBroker(payload, { timeoutMs = 5_000, onAsk } = {}) {
  return new Promise((resolve, reject) => {
    const controlDir = fs.mkdtempSync(path.join(tmp, "ctl-"));
    const child = spawn("node", [brokerJs, controlDir, String(timeoutMs)], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    const watcher = onAsk
      ? setInterval(() => {
          // Complete files only — the broker's atomic write creates
          // `ask-<id>.json.<pid>.tmp` first, which also starts with "ask-"
          // (the product watcher excludes tmp suffixes the same way).
          const asks = fs.readdirSync(controlDir).filter((n) => /^ask-.+\.json$/.test(n));
          if (asks.length > 0) {
            clearInterval(watcher);
            onAsk(controlDir, asks[0]);
          }
        }, 50)
      : null;
    child.on("close", (code) => {
      if (watcher) clearInterval(watcher);
      resolve({ code, stdout, stderr, controlDir });
    });
    child.on("error", reject);
    child.stdin.end(JSON.stringify(payload));
  });
}

// ── A. AskUserQuestion → undecided immediate exit, zero protocol surface ────
{
  const started = Date.now();
  const result = await runBroker({
    hook_event_name: "PermissionRequest",
    tool_name: "AskUserQuestion",
    tool_input: { questions: [{ question: "Pick", options: [{ label: "a" }, { label: "b" }] }] },
  });
  assert.equal(result.code, 0, "AskUserQuestion: exit 0");
  assert.equal(result.stdout, "", "AskUserQuestion: NO stdout (undecided, CLI proceeds natively)");
  assert.equal(result.stderr, "", "AskUserQuestion: no stderr");
  assert.ok(Date.now() - started < 3_000, "AskUserQuestion: immediate, no hold");
  const files = fs.readdirSync(result.controlDir);
  assert.deepEqual(files, [], "AskUserQuestion: no ask/expired/answered files at all");
}

// ── B. Real tool → ask surfaces; reply is emitted verbatim; ask cleaned up ──
{
  const decision = JSON.stringify({
    hookSpecificOutput: { hookEventName: "PermissionRequest", decision: { behavior: "allow" } },
  });
  const result = await runBroker(
    { hook_event_name: "PermissionRequest", tool_name: "Bash", tool_input: { command: "ls" } },
    {
      onAsk: (dir, askName) => {
        const ask = JSON.parse(fs.readFileSync(path.join(dir, askName), "utf8"));
        assert.equal(ask.payload.tool_name, "Bash", "ask file carries the payload");
        const id = askName.replace(/^ask-/, "").replace(/\.json$/, "");
        fs.writeFileSync(path.join(dir, `reply-${id}.json`), decision);
      },
    },
  );
  assert.equal(result.code, 0, "Bash: exit 0");
  assert.equal(result.stdout, decision, "Bash: reply emitted verbatim on stdout");
  const leftover = fs.readdirSync(result.controlDir).filter((n) => n.startsWith("ask-"));
  assert.deepEqual(leftover, [], "Bash: ask cleaned up after answer");
  const answered = fs.readdirSync(result.controlDir).filter((n) => n.startsWith("answered-"));
  assert.equal(answered.length, 1, "Bash: audit answered-<id>.json written");
}

// ── C. Injected settings carry the S0 hold (580s broker / 600s hook) ────────
{
  const cwd = fs.mkdtempSync(path.join(tmp, "settings-"));
  const settingsPath = ensureClaudeRuntimeSettings(cwd);
  const settings = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
  const group = settings.hooks?.PermissionRequest?.[0];
  const entry = group?.hooks?.[0];
  assert.ok(entry?.command.includes("approval-broker.js"), "PermissionRequest → broker");
  assert.ok(entry.command.trim().endsWith(" 580000"), "broker argv holds 580_000ms");
  assert.equal(entry.timeout, 600, "hook timeout is 600 SECONDS (documented ceiling-of-record)");
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log("approval-broker-protocol: OK");
