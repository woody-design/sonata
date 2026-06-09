import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const {
  ClaudeSessionNormalizer,
  CodexRolloutNormalizer,
  JsonlTailer,
  ProviderTranscript,
  claudeProjectSlug,
  locateSessionFile,
} = require("../../dist/runtime/provider-transcript/index");

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "duet-provider-transcript-"));
const failures = [];

function check(name, fn) {
  try {
    fn();
    console.log(`ok   ${name}`);
  } catch (error) {
    failures.push(name);
    console.error(`FAIL ${name}`);
    console.error(error);
  }
}

function claudeLine(record) {
  return JSON.stringify(record);
}

// --- Claude normalizer -------------------------------------------------------

check("claude: prompt turn with text, tool pairing, and duration", () => {
  const normalizer = new ClaudeSessionNormalizer({ taskId: "task-1", sourceId: "claude:s1" });
  const upserts = [];
  const lines = [
    claudeLine({ type: "mode", mode: "normal" }),
    claudeLine({
      type: "user",
      uuid: "u1",
      promptId: "p1",
      timestamp: "2026-06-09T10:00:00.000Z",
      message: { role: "user", content: "Build a report" },
    }),
    claudeLine({
      type: "assistant",
      uuid: "a1",
      promptId: "p1",
      timestamp: "2026-06-09T10:00:02.000Z",
      message: {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "Considering structure.", signature: "x" },
          { type: "text", text: "I will **start** now." },
          { type: "tool_use", id: "toolu_1", name: "Bash", input: { command: "ls -la", description: "List" } },
        ],
      },
    }),
    claudeLine({
      type: "user",
      uuid: "u2",
      promptId: "p1",
      timestamp: "2026-06-09T10:00:05.500Z",
      message: {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "file-a\nfile-b", is_error: false }],
      },
    }),
  ];
  for (const line of lines) {
    upserts.push(...normalizer.consumeLine(line));
  }

  const kinds = upserts.map((block) => block.kind);
  assert.deepEqual(kinds, ["user-message", "thinking", "assistant-text", "tool-call", "tool-call"]);

  const user = upserts[0];
  assert.equal(user.text, "Build a report");
  assert.equal(user.command, null);
  assert.equal(user.turnKey, "p1");

  const toolFinal = upserts[4];
  assert.equal(toolFinal.id, upserts[3].id);
  assert.equal(toolFinal.status, "ok");
  assert.equal(toolFinal.summary, "ls -la");
  assert.equal(toolFinal.resultPreview, "file-a\nfile-b");
  assert.equal(toolFinal.durationMs, 3500);
});

check("claude: command invocation, context injection, and sidechain are handled", () => {
  const normalizer = new ClaudeSessionNormalizer({ taskId: "task-1", sourceId: "claude:s2" });
  const upserts = [];
  const lines = [
    claudeLine({
      type: "user",
      uuid: "u1",
      timestamp: "2026-06-09T10:00:00.000Z",
      message: {
        role: "user",
        content: "<command-message>architect</command-message>\n<command-name>/architect</command-name>",
      },
    }),
    // Skill body injected as a second user record before any assistant output.
    claudeLine({
      type: "user",
      uuid: "u2",
      timestamp: "2026-06-09T10:00:00.200Z",
      message: { role: "user", content: [{ type: "text", text: "Base directory for this skill: ..." }] },
    }),
    claudeLine({
      type: "assistant",
      uuid: "a1",
      timestamp: "2026-06-09T10:00:03.000Z",
      isSidechain: true,
      message: { role: "assistant", content: [{ type: "text", text: "sidechain noise" }] },
    }),
    claudeLine({
      type: "assistant",
      uuid: "a2",
      timestamp: "2026-06-09T10:00:04.000Z",
      message: { role: "assistant", content: [{ type: "text", text: "Mode loaded." }] },
    }),
    claudeLine({
      type: "user",
      uuid: "u3",
      timestamp: "2026-06-09T10:01:00.000Z",
      message: {
        role: "user",
        content: [
          { type: "text", text: "<system-reminder>noise</system-reminder>Second question" },
        ],
      },
    }),
  ];
  for (const line of lines) {
    upserts.push(...normalizer.consumeLine(line));
  }

  assert.deepEqual(
    upserts.map((block) => block.kind),
    ["user-message", "assistant-text", "user-message"],
  );
  assert.equal(upserts[0].command, "/architect");
  assert.equal(upserts[2].text, "Second question");
  assert.notEqual(upserts[0].turnKey, upserts[2].turnKey);
});

// --- Codex normalizer --------------------------------------------------------

check("codex: event text, tool pairing, exit-code status, no duplication", () => {
  const normalizer = new CodexRolloutNormalizer({ taskId: "task-1", sourceId: "codex:s1" });
  const upserts = [];
  const lines = [
    JSON.stringify({
      timestamp: "2026-06-09T10:00:00.000Z",
      type: "session_meta",
      payload: { id: "sess-1", cwd: "/tmp/work", timestamp: "2026-06-09T10:00:00.000Z" },
    }),
    JSON.stringify({
      timestamp: "2026-06-09T10:00:01.000Z",
      type: "event_msg",
      payload: { type: "user_message", message: "Fix the bug" },
    }),
    JSON.stringify({
      timestamp: "2026-06-09T10:00:02.000Z",
      type: "event_msg",
      payload: { type: "agent_message", message: "Looking at the failure first.", phase: "commentary" },
    }),
    // Duplicate of the agent_message through the protocol stream: must be ignored.
    JSON.stringify({
      timestamp: "2026-06-09T10:00:02.100Z",
      type: "response_item",
      payload: {
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: "Looking at the failure first." }],
      },
    }),
    JSON.stringify({
      timestamp: "2026-06-09T10:00:03.000Z",
      type: "response_item",
      payload: {
        type: "function_call",
        name: "exec_command",
        call_id: "call-1",
        arguments: JSON.stringify({ cmd: "npm test", workdir: "/tmp/work" }),
      },
    }),
    JSON.stringify({
      timestamp: "2026-06-09T10:00:09.000Z",
      type: "response_item",
      payload: {
        type: "function_call_output",
        call_id: "call-1",
        output: "Process exited with code 1\nOutput:\n1 failing test",
      },
    }),
    JSON.stringify({
      timestamp: "2026-06-09T10:00:10.000Z",
      type: "compacted",
      payload: { message: "compacted" },
    }),
  ];
  for (const line of lines) {
    upserts.push(...normalizer.consumeLine(line));
  }

  assert.deepEqual(
    upserts.map((block) => block.kind),
    ["user-message", "assistant-text", "tool-call", "tool-call", "system-note"],
  );
  assert.equal(upserts[0].text, "Fix the bug");
  const toolFinal = upserts[3];
  assert.equal(toolFinal.status, "error");
  assert.equal(toolFinal.summary, "npm test");
  assert.equal(toolFinal.durationMs, 6000);
});

// --- Locator ------------------------------------------------------------------

check("locator: finds claude session by cwd slug and not-before time", () => {
  const projectsDir = path.join(tempRoot, "claude-projects");
  const cwd = path.join(tempRoot, "workspace-a");
  fs.mkdirSync(cwd, { recursive: true });
  const slugDir = path.join(projectsDir, claudeProjectSlug(cwd));
  fs.mkdirSync(slugDir, { recursive: true });

  const sessionPath = path.join(slugDir, "11111111-2222-3333-4444-555555555555.jsonl");
  fs.writeFileSync(
    sessionPath,
    `${JSON.stringify({ type: "user", cwd, sessionId: "11111111-2222-3333-4444-555555555555", message: { role: "user", content: "hi" } })}\n`,
  );

  const found = locateSessionFile({
    provider: "claude",
    providerCwd: cwd,
    notBefore: new Date(Date.now() - 60_000).toISOString(),
    claudeProjectsDir: projectsDir,
  });
  assert.ok(found, "expected a located session");
  assert.equal(found.path, sessionPath);
  assert.equal(found.format, "claude-session-jsonl");
  assert.equal(found.providerSessionId, "11111111-2222-3333-4444-555555555555");

  const tooOld = locateSessionFile({
    provider: "claude",
    providerCwd: cwd,
    notBefore: new Date(Date.now() + 60_000).toISOString(),
    claudeProjectsDir: projectsDir,
  });
  assert.equal(tooOld, null);
});

check("locator: finds codex rollout by session_meta cwd", () => {
  const sessionsDir = path.join(tempRoot, "codex-sessions");
  const cwd = path.join(tempRoot, "workspace-b");
  fs.mkdirSync(cwd, { recursive: true });
  const now = new Date();
  const dayDir = path.join(
    sessionsDir,
    String(now.getFullYear()),
    String(now.getMonth() + 1).padStart(2, "0"),
    String(now.getDate()).padStart(2, "0"),
  );
  fs.mkdirSync(dayDir, { recursive: true });
  const rolloutPath = path.join(dayDir, "rollout-2026-06-09T10-00-00-abc.jsonl");
  fs.writeFileSync(
    rolloutPath,
    `${JSON.stringify({
      timestamp: now.toISOString(),
      type: "session_meta",
      payload: { id: "sess-codex-1", cwd, timestamp: now.toISOString() },
    })}\n`,
  );

  const found = locateSessionFile({
    provider: "codex",
    providerCwd: cwd,
    notBefore: new Date(Date.now() - 60_000).toISOString(),
    codexSessionsDir: sessionsDir,
  });
  assert.ok(found, "expected a located rollout");
  assert.equal(found.path, rolloutPath);
  assert.equal(found.providerSessionId, "sess-codex-1");

  const otherCwd = locateSessionFile({
    provider: "codex",
    providerCwd: path.join(tempRoot, "elsewhere"),
    notBefore: new Date(Date.now() - 60_000).toISOString(),
    codexSessionsDir: sessionsDir,
  });
  assert.equal(otherCwd, null);
});

// --- Tailer -------------------------------------------------------------------

check("tailer: drains appended lines and carries partial lines", () => {
  const filePath = path.join(tempRoot, "tail-me.jsonl");
  fs.writeFileSync(filePath, '{"a":1}\n{"b":');
  const seen = [];
  const tailer = new JsonlTailer({ path: filePath, onLines: (lines) => seen.push(...lines) });

  tailer.drain();
  assert.deepEqual(seen, ['{"a":1}']);

  fs.appendFileSync(filePath, '2}\n{"c":3}\n');
  tailer.drain();
  assert.deepEqual(seen, ['{"a":1}', '{"b":2}', '{"c":3}']);
});

// --- ProviderTranscript end-to-end ---------------------------------------------

await (async () => {
  const name = "provider-transcript: discovery, events, and run attribution";
  try {
    const projectsDir = path.join(tempRoot, "claude-projects-e2e");
    const cwd = path.join(tempRoot, "workspace-e2e");
    fs.mkdirSync(cwd, { recursive: true });
    const slugDir = path.join(projectsDir, claudeProjectSlug(cwd));
    fs.mkdirSync(slugDir, { recursive: true });

    const events = [];
    const transcript = new ProviderTranscript({
      taskId: "task-e2e",
      provider: "claude",
      providerCwd: cwd,
      eventSink: (event) => events.push(event),
      resolveRunId: (input) => (input.text === "Build a report" ? "run-42" : null),
      locate: (options) =>
        locateSessionFile({ ...options, claudeProjectsDir: projectsDir }),
      pollMs: 50,
    });

    transcript.startDiscovery(new Date(Date.now() - 5_000).toISOString());

    // Session file appears after the PTY started, as in real launches.
    await new Promise((resolve) => setTimeout(resolve, 120));
    const sessionPath = path.join(slugDir, "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee.jsonl");
    fs.writeFileSync(
      sessionPath,
      [
        JSON.stringify({
          type: "user",
          uuid: "u1",
          cwd,
          timestamp: new Date().toISOString(),
          message: { role: "user", content: "Build a report" },
        }),
        JSON.stringify({
          type: "assistant",
          uuid: "a1",
          cwd,
          timestamp: new Date().toISOString(),
          message: { role: "assistant", content: [{ type: "text", text: "Starting now." }] },
        }),
        "",
      ].join("\n"),
    );

    await new Promise((resolve) => setTimeout(resolve, 2_200));

    fs.appendFileSync(
      sessionPath,
      `${JSON.stringify({
        type: "assistant",
        uuid: "a2",
        cwd,
        timestamp: new Date().toISOString(),
        message: { role: "assistant", content: [{ type: "text", text: "Done." }] },
      })}\n`,
    );
    await new Promise((resolve) => setTimeout(resolve, 300));
    transcript.dispose();

    const located = events.filter((event) => event.type === "transcript:located");
    assert.equal(located.length, 1);
    assert.equal(located[0].payload.source.path, sessionPath);

    const blocks = transcript.blocks();
    assert.deepEqual(
      blocks.map((block) => block.kind),
      ["user-message", "assistant-text", "assistant-text"],
    );
    assert.equal(blocks[0].runId, "run-42");
    assert.equal(blocks[1].runId, "run-42", "assistant block inherits the turn run");
    assert.equal(blocks[2].runId, "run-42", "tailed block also inherits the turn run");

    const blockEvents = events.filter((event) => event.type === "transcript:blocks");
    assert.ok(blockEvents.length >= 2, "expected initial drain plus tailed update");
    assert.equal(blockEvents[0].payload.reset, true);
    console.log(`ok   ${name}`);
  } catch (error) {
    failures.push(name);
    console.error(`FAIL ${name}`);
    console.error(error);
  }
})();

fs.rmSync(tempRoot, { recursive: true, force: true });

if (failures.length > 0) {
  console.error(`\n${failures.length} provider-transcript check(s) failed.`);
  process.exit(1);
}
console.log("\nprovider-transcript smoke checks passed.");
