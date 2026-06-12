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

check("claude: local command turn followed by typed prompt attributes reply to prompt turn", () => {
  const normalizer = new ClaudeSessionNormalizer({ taskId: "task-1", sourceId: "claude:s2b" });
  const upserts = [];
  const lines = [
    claudeLine({
      type: "user",
      uuid: "u1",
      timestamp: "2026-06-09T10:00:00.000Z",
      message: {
        role: "user",
        content: "<command-message>model</command-message>\n<command-name>/model</command-name>",
      },
    }),
    claudeLine({
      type: "user",
      uuid: "u2",
      promptId: "p-typed",
      promptSource: "typed",
      timestamp: "2026-06-09T10:00:10.000Z",
      message: { role: "user", content: "Now answer normally" },
    }),
    claudeLine({
      type: "assistant",
      uuid: "a1",
      promptId: "p-typed",
      timestamp: "2026-06-09T10:00:12.000Z",
      message: { role: "assistant", content: [{ type: "text", text: "Normal answer." }] },
    }),
  ];
  for (const line of lines) {
    upserts.push(...normalizer.consumeLine(line));
  }

  assert.deepEqual(
    upserts.map((block) => block.kind),
    ["user-message", "user-message", "assistant-text"],
  );
  assert.equal(upserts[0].command, "/model");
  assert.equal(upserts[1].text, "Now answer normally");
  assert.equal(upserts[1].turnKey, "p-typed");
  assert.equal(upserts[2].turnKey, "p-typed");
});

check("claude: local command turn followed by queued prompt attributes reply to prompt turn", () => {
  const normalizer = new ClaudeSessionNormalizer({ taskId: "task-1", sourceId: "claude:s2q" });
  const upserts = [];
  const lines = [
    claudeLine({
      type: "user",
      uuid: "u1",
      timestamp: "2026-06-09T10:00:00.000Z",
      message: {
        role: "user",
        content: "<command-message>model</command-message>\n<command-name>/model</command-name>",
      },
    }),
    claudeLine({
      type: "user",
      uuid: "u2",
      promptId: "p-queued",
      promptSource: "queued",
      timestamp: "2026-06-09T10:00:10.000Z",
      message: { role: "user", content: "Queued prompt" },
    }),
    claudeLine({
      type: "assistant",
      uuid: "a1",
      promptId: "p-queued",
      timestamp: "2026-06-09T10:00:12.000Z",
      message: { role: "assistant", content: [{ type: "text", text: "Queued answer." }] },
    }),
  ];
  for (const line of lines) {
    upserts.push(...normalizer.consumeLine(line));
  }

  assert.deepEqual(
    upserts.map((block) => block.kind),
    ["user-message", "user-message", "assistant-text"],
  );
  assert.equal(upserts[1].turnKey, "p-queued");
  assert.equal(upserts[2].turnKey, "p-queued");
});

check("claude: isMeta user records are skipped", () => {
  const normalizer = new ClaudeSessionNormalizer({ taskId: "task-1", sourceId: "claude:s2c" });
  const upserts = [];
  const lines = [
    claudeLine({
      type: "user",
      uuid: "u1",
      promptId: "p1",
      promptSource: "typed",
      timestamp: "2026-06-09T10:00:00.000Z",
      message: { role: "user", content: "Real prompt" },
    }),
    claudeLine({
      type: "user",
      uuid: "u2",
      isMeta: true,
      timestamp: "2026-06-09T10:00:00.100Z",
      message: { role: "user", content: "Injected caveat" },
    }),
    claudeLine({
      type: "assistant",
      uuid: "a1",
      promptId: "p1",
      timestamp: "2026-06-09T10:00:02.000Z",
      message: { role: "assistant", content: [{ type: "text", text: "Reply." }] },
    }),
  ];
  for (const line of lines) {
    upserts.push(...normalizer.consumeLine(line));
  }

  assert.deepEqual(
    upserts.map((block) => block.kind),
    ["user-message", "assistant-text"],
  );
  assert.equal(upserts[0].text, "Real prompt");
  assert.equal(upserts[1].turnKey, "p1");
});

check("claude: legacy user records without promptSource keep fallback heuristic", () => {
  const normalizer = new ClaudeSessionNormalizer({ taskId: "task-1", sourceId: "claude:s2d" });
  const upserts = [];
  const lines = [
    claudeLine({
      type: "user",
      uuid: "u1",
      timestamp: "2026-06-09T10:00:00.000Z",
      message: { role: "user", content: "Legacy prompt" },
    }),
    claudeLine({
      type: "user",
      uuid: "u2",
      timestamp: "2026-06-09T10:00:00.100Z",
      message: { role: "user", content: "Legacy injected context" },
    }),
    claudeLine({
      type: "assistant",
      uuid: "a1",
      timestamp: "2026-06-09T10:00:01.000Z",
      message: { role: "assistant", content: [{ type: "text", text: "Legacy reply." }] },
    }),
    claudeLine({
      type: "user",
      uuid: "u3",
      timestamp: "2026-06-09T10:00:02.000Z",
      message: { role: "user", content: "Legacy next prompt" },
    }),
  ];
  for (const line of lines) {
    upserts.push(...normalizer.consumeLine(line));
  }

  assert.deepEqual(
    upserts.map((block) => block.kind),
    ["user-message", "assistant-text", "user-message"],
  );
  assert.equal(upserts[0].text, "Legacy prompt");
  assert.equal(upserts[2].text, "Legacy next prompt");
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

// --- Plan blocks (slice 2: TodoWrite / update_plan extraction) ---------------

check("claude: TodoWrite upserts one plan block per turn; orphan result drops", () => {
  const normalizer = new ClaudeSessionNormalizer({ taskId: "task-1", sourceId: "claude:s1" });
  const upserts = [];
  const lines = [
    claudeLine({
      type: "user",
      uuid: "u1",
      promptId: "p1",
      timestamp: "2026-06-11T10:00:00.000Z",
      message: { role: "user", content: "Plan the work" },
    }),
    claudeLine({
      type: "assistant",
      uuid: "a1",
      promptId: "p1",
      timestamp: "2026-06-11T10:00:02.000Z",
      message: {
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "toolu_todo_1",
            name: "TodoWrite",
            input: {
              todos: [
                { content: "Define Agent data model", activeForm: "Defining Agent data model", status: "in_progress" },
                { content: "Build VisionDetector", activeForm: "Building VisionDetector", status: "pending" },
              ],
            },
          },
        ],
      },
    }),
    claudeLine({
      type: "user",
      uuid: "u2",
      promptId: "p1",
      timestamp: "2026-06-11T10:00:03.000Z",
      message: {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "toolu_todo_1", content: "Todos have been modified successfully" },
        ],
      },
    }),
    claudeLine({
      type: "assistant",
      uuid: "a2",
      promptId: "p1",
      timestamp: "2026-06-11T10:00:09.000Z",
      message: {
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "toolu_todo_2",
            name: "TodoWrite",
            input: {
              todos: [
                { content: "Define Agent data model", activeForm: "Defining Agent data model", status: "completed" },
                { content: "Build VisionDetector", activeForm: "Building VisionDetector", status: "in_progress" },
              ],
            },
          },
        ],
      },
    }),
  ];
  for (const line of lines) {
    upserts.push(...normalizer.consumeLine(line));
  }

  const planUpserts = upserts.filter((block) => block.kind === "plan");
  assert.equal(planUpserts.length, 2, "both TodoWrite calls emit the plan");
  assert.equal(new Set(planUpserts.map((block) => block.id)).size, 1, "same id — upsert in place");
  assert.equal(planUpserts[0].seq, planUpserts[1].seq, "stable seq keeps transcript position");
  const final = planUpserts[1];
  assert.deepEqual(
    final.items.map((item) => item.status),
    ["completed", "in_progress"],
  );
  assert.equal(final.items[1].activeLabel, "Building VisionDetector");
  assert.equal(
    upserts.filter((block) => block.kind === "tool-call").length,
    0,
    "no raw TodoWrite tool card, and the orphan tool_result drops",
  );
});

check("claude: malformed TodoWrite falls through to the generic tool-call", () => {
  const normalizer = new ClaudeSessionNormalizer({ taskId: "task-1", sourceId: "claude:s1" });
  const upserts = [];
  const lines = [
    claudeLine({
      type: "user",
      uuid: "u1",
      promptId: "p1",
      timestamp: "2026-06-11T10:00:00.000Z",
      message: { role: "user", content: "Plan the work" },
    }),
    claudeLine({
      type: "assistant",
      uuid: "a1",
      promptId: "p1",
      timestamp: "2026-06-11T10:00:02.000Z",
      message: {
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "toolu_bad",
            name: "TodoWrite",
            input: { todos: [{ content: "x", status: "weird-status" }] },
          },
        ],
      },
    }),
  ];
  for (const line of lines) {
    upserts.push(...normalizer.consumeLine(line));
  }
  assert.equal(upserts.filter((block) => block.kind === "plan").length, 0);
  const tools = upserts.filter((block) => block.kind === "tool-call");
  assert.equal(tools.length, 1, "malformed plan input stays visible as a tool call");
  assert.equal(tools[0].toolName, "TodoWrite");
});

check("codex: update_plan with stringified args and non-ASCII steps", () => {
  const normalizer = new CodexRolloutNormalizer({ taskId: "task-1", sourceId: "codex:s1" });
  const upserts = [];
  const lines = [
    JSON.stringify({
      timestamp: "2026-06-11T10:00:00.000Z",
      type: "session_meta",
      payload: { id: "sess-1", cwd: "/tmp/work", timestamp: "2026-06-11T10:00:00.000Z" },
    }),
    JSON.stringify({
      timestamp: "2026-06-11T10:00:01.000Z",
      type: "event_msg",
      payload: { type: "user_message", message: "把界面中文化" },
    }),
    JSON.stringify({
      timestamp: "2026-06-11T10:00:02.000Z",
      type: "response_item",
      payload: {
        type: "function_call",
        name: "update_plan",
        call_id: "plan-1",
        arguments: JSON.stringify({
          plan: [
            { step: "建立中文化风格准则并定位用户可见英文", status: "in_progress" },
            { step: "翻译并验证", status: "pending" },
          ],
        }),
      },
    }),
    JSON.stringify({
      timestamp: "2026-06-11T10:00:03.000Z",
      type: "response_item",
      payload: { type: "function_call_output", call_id: "plan-1", output: "Plan updated" },
    }),
    JSON.stringify({
      timestamp: "2026-06-11T10:00:09.000Z",
      type: "response_item",
      payload: {
        type: "function_call",
        name: "update_plan",
        call_id: "plan-2",
        arguments: JSON.stringify({
          plan: [
            { step: "建立中文化风格准则并定位用户可见英文", status: "completed" },
            { step: "翻译并验证", status: "in_progress" },
          ],
        }),
      },
    }),
  ];
  for (const line of lines) {
    upserts.push(...normalizer.consumeLine(line));
  }

  const planUpserts = upserts.filter((block) => block.kind === "plan");
  assert.equal(planUpserts.length, 2);
  assert.equal(new Set(planUpserts.map((block) => block.id)).size, 1, "one plan block per turn");
  const final = planUpserts[1];
  assert.equal(final.items[0].text, "建立中文化风格准则并定位用户可见英文");
  assert.deepEqual(
    final.items.map((item) => item.status),
    ["completed", "in_progress"],
  );
  assert.equal(final.items[0].activeLabel, null, "codex has no activeForm equivalent");
  assert.equal(
    upserts.filter((block) => block.kind === "tool-call").length,
    0,
    "no raw update_plan card; the orphan output drops",
  );
});

check("claude: TaskCreate/TaskUpdate (2.1.17x) accumulate session task state", () => {
  const normalizer = new ClaudeSessionNormalizer({ taskId: "task-1", sourceId: "claude:s1" });
  const upserts = [];
  const use = (id, name, input, t) =>
    claudeLine({
      type: "assistant",
      uuid: `a-${id}`,
      promptId: "p1",
      timestamp: t,
      message: { role: "assistant", content: [{ type: "tool_use", id, name, input }] },
    });
  const res = (id, content, t) =>
    claudeLine({
      type: "user",
      uuid: `u-${id}`,
      promptId: "p1",
      timestamp: t,
      message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content }] },
    });
  const lines = [
    claudeLine({
      type: "user",
      uuid: "u1",
      promptId: "p1",
      timestamp: "2026-06-11T10:00:00.000Z",
      message: { role: "user", content: "Plan and read the files" },
    }),
    use("c1", "TaskCreate", { subject: "Read a.txt", description: "d", activeForm: "Reading a.txt" }, "2026-06-11T10:00:02.000Z"),
    res("c1", "Task #1 created successfully: Read a.txt", "2026-06-11T10:00:02.100Z"),
    use("c2", "TaskCreate", { subject: "Read b.txt", description: "d", activeForm: "Reading b.txt" }, "2026-06-11T10:00:02.200Z"),
    res("c2", "Task #2 created successfully: Read b.txt", "2026-06-11T10:00:02.300Z"),
    use("s1", "TaskUpdate", { taskId: "1", status: "in_progress" }, "2026-06-11T10:00:03.000Z"),
    res("s1", "Updated task #1 status", "2026-06-11T10:00:03.100Z"),
    use("s2", "TaskUpdate", { taskId: "1", status: "completed" }, "2026-06-11T10:00:05.000Z"),
    res("s2", "Updated task #1 status", "2026-06-11T10:00:05.100Z"),
    use("s3", "TaskUpdate", { taskId: "2", status: "in_progress" }, "2026-06-11T10:00:06.000Z"),
    res("s3", "Updated task #2 status", "2026-06-11T10:00:06.100Z"),
  ];
  for (const line of lines) {
    upserts.push(...normalizer.consumeLine(line));
  }

  const planUpserts = upserts.filter((block) => block.kind === "plan");
  assert.ok(planUpserts.length >= 5, "every create/update upserts the plan");
  assert.equal(new Set(planUpserts.map((block) => block.id)).size, 1, "one block per turn");
  const final = planUpserts[planUpserts.length - 1];
  assert.deepEqual(
    final.items.map((item) => [item.text, item.status]),
    [
      ["Read a.txt", "completed"],
      ["Read b.txt", "in_progress"],
    ],
  );
  assert.equal(final.items[1].activeLabel, "Reading b.txt");
  assert.equal(
    upserts.filter((block) => block.kind === "tool-call").length,
    0,
    "no raw task-tool cards; create applies on result, update on use",
  );
  // earlier snapshots must not be mutated by later updates (no aliasing)
  const second = planUpserts[1];
  assert.equal(second.items[0].status, "pending", "snapshot isolation holds");
});

check("claude: unparseable TaskCreate result falls back to a resolved tool call", () => {
  const normalizer = new ClaudeSessionNormalizer({ taskId: "task-1", sourceId: "claude:s1" });
  const upserts = [];
  const lines = [
    claudeLine({
      type: "user",
      uuid: "u1",
      promptId: "p1",
      timestamp: "2026-06-11T10:00:00.000Z",
      message: { role: "user", content: "Plan" },
    }),
    claudeLine({
      type: "assistant",
      uuid: "a1",
      promptId: "p1",
      timestamp: "2026-06-11T10:00:02.000Z",
      message: {
        role: "assistant",
        content: [
          { type: "tool_use", id: "cX", name: "TaskCreate", input: { subject: "Read a.txt", activeForm: "Reading a.txt" } },
        ],
      },
    }),
    claudeLine({
      type: "user",
      uuid: "u2",
      promptId: "p1",
      timestamp: "2026-06-11T10:00:02.500Z",
      message: {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "cX", content: "Something unexpected", is_error: false }],
      },
    }),
  ];
  for (const line of lines) {
    upserts.push(...normalizer.consumeLine(line));
  }
  assert.equal(upserts.filter((block) => block.kind === "plan").length, 0);
  const tools = upserts.filter((block) => block.kind === "tool-call");
  assert.equal(tools.length, 1, "buffered tool call surfaces with the result");
  assert.equal(tools[0].toolName, "TaskCreate");
  assert.equal(tools[0].status, "ok");
  assert.ok(tools[0].resultPreview.includes("Something unexpected"));
});

fs.rmSync(tempRoot, { recursive: true, force: true });

if (failures.length > 0) {
  console.error(`\n${failures.length} provider-transcript check(s) failed.`);
  process.exit(1);
}
console.log("\nprovider-transcript smoke checks passed.");
