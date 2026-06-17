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

check("claude: promptSource=system records (task notifications) never render as the user's prompt", () => {
  // The research-session bug: a deep-research / Workflow run injects a
  // `<task-notification>` as a `type:"user"` record with `promptSource:"system"`
  // and no `isMeta`. Mid-turn (assistant has already spoken) the legacy
  // `turnHasAssistant` fallback used to render it as a fresh user bubble,
  // attributing CLI machinery to the user's own words.
  const normalizer = new ClaudeSessionNormalizer({ taskId: "task-1", sourceId: "claude:s-sys" });
  const upserts = [];
  const lines = [
    claudeLine({
      type: "user",
      uuid: "u1",
      promptId: "p1",
      promptSource: "typed",
      timestamp: "2026-06-09T10:00:00.000Z",
      message: { role: "user", content: "Research the two cameras" },
    }),
    claudeLine({
      type: "assistant",
      uuid: "a1",
      promptId: "p1",
      timestamp: "2026-06-09T10:00:02.000Z",
      message: { role: "assistant", content: [{ type: "text", text: "Spawning research agents." }] },
    }),
    // The machinery record — string content, no isMeta, promptSource:system.
    claudeLine({
      type: "user",
      uuid: "u2",
      promptSource: "system",
      timestamp: "2026-06-09T10:00:30.000Z",
      message: {
        role: "user",
        content:
          "<task-notification>\n<task-id>ab504d018b671ce18</task-id>\n<status>completed</status>\n<summary>Agent \"Research Insta360 Luna Ultra\" came to rest</summary>\n</task-notification>",
      },
    }),
    claudeLine({
      type: "assistant",
      uuid: "a2",
      promptId: "p1",
      timestamp: "2026-06-09T10:00:32.000Z",
      message: { role: "assistant", content: [{ type: "text", text: "Here is what the research found." }] },
    }),
  ];
  for (const line of lines) {
    upserts.push(...normalizer.consumeLine(line));
  }

  assert.deepEqual(
    upserts.map((block) => block.kind),
    ["user-message", "assistant-text", "assistant-text"],
    "the task-notification produces no user bubble",
  );
  assert.equal(upserts[0].text, "Research the two cameras");
  // The post-notification assistant text folds back into the original prompt's
  // turn — the notification was mid-turn machinery, not a new question.
  assert.equal(upserts[2].turnKey, upserts[0].turnKey, "reply stays in the user's turn");
});

check("claude: Agent fan-out becomes one roster block — spawn, bridge, settle", () => {
  // The full T0 chain, all from the main stream: an `Agent` tool_use spawns a
  // running row; its tool_result carries `agentId:` (bridging tool_use id ->
  // the internal id the notification reports); the `<task-notification>`
  // (promptSource:system) settles the row to done with the CLI's duration.
  const normalizer = new ClaudeSessionNormalizer({ taskId: "task-1", sourceId: "claude:s-ag" });
  const upserts = [];
  const lines = [
    claudeLine({
      type: "user",
      uuid: "u1",
      promptId: "p1",
      promptSource: "typed",
      timestamp: "2026-06-17T10:00:00.000Z",
      message: { role: "user", content: "Research the bookshop and the logo" },
    }),
    // Two background agents spawned in one assistant turn.
    claudeLine({
      type: "assistant",
      uuid: "a1",
      promptId: "p1",
      timestamp: "2026-06-17T10:00:02.000Z",
      message: {
        role: "assistant",
        content: [
          { type: "tool_use", id: "toolu_A", name: "Agent", input: { description: "Research bookshop facts", subagent_type: "general-purpose", prompt: "…" } },
          { type: "tool_use", id: "toolu_B", name: "Agent", input: { description: "Curate logo references", subagent_type: "general-purpose", prompt: "…" } },
        ],
      },
    }),
    // Launch results — carry the internal agentId for each spawn.
    claudeLine({
      type: "user",
      uuid: "u2",
      promptId: "p1",
      timestamp: "2026-06-17T10:00:02.300Z",
      message: {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "toolu_A", content: "Async agent launched successfully.\nagentId: a3833de70ddc9449d (internal ID - do not mention)" },
          { type: "tool_result", tool_use_id: "toolu_B", content: "Async agent launched successfully.\nagentId: acb286c4569214d3c (internal ID - do not mention)" },
        ],
      },
    }),
    // First agent comes to rest — settles via task-id == agentId, duration from <usage>.
    claudeLine({
      type: "user",
      uuid: "u3",
      promptSource: "system",
      timestamp: "2026-06-17T10:04:00.000Z",
      message: {
        role: "user",
        content:
          "<task-notification>\n<task-id>a3833de70ddc9449d</task-id>\n<status>completed</status>\n<summary>Agent \"Research bookshop facts\" came to rest</summary>\n<usage><subagent_tokens>40810</subagent_tokens><tool_uses>7</tool_uses><duration_ms>284740</duration_ms></usage>\n</task-notification>",
      },
    }),
  ];
  for (const line of lines) {
    upserts.push(...normalizer.consumeLine(line));
  }

  // No generic Agent tool cards, no user bubble for the notification.
  assert.equal(upserts.filter((b) => b.kind === "tool-call").length, 0, "no raw Agent cards");
  assert.equal(
    upserts.filter((b) => b.kind === "user-message").length,
    1,
    "only the real typed prompt is a user message",
  );

  const rosters = upserts.filter((b) => b.kind === "agents");
  assert.ok(rosters.length >= 1, "the fan-out produced a roster block");
  assert.equal(new Set(rosters.map((b) => b.id)).size, 1, "one roster block per turn, upserted in place");
  assert.equal(rosters[0].seq, rosters[rosters.length - 1].seq, "stable seq keeps transcript position");

  const finalRoster = rosters[rosters.length - 1];
  assert.equal(finalRoster.turnKey, "p1", "roster lives in the spawning turn");
  assert.deepEqual(
    finalRoster.items.map((i) => [i.name, i.status, i.durationMs]),
    [
      ["Research bookshop facts", "done", 284740],
      ["Curate logo references", "running", null],
    ],
    "first agent settled with the CLI duration; second still running",
  );

  // Snapshot isolation: the spawn-time roster must not have been mutated by the
  // later settle (emitted blocks are immutable history).
  assert.equal(rosters[0].items[0].status, "running", "earlier snapshot is frozen");
});

check("claude: a Workflow launch (deep-research) becomes one coarse roster row that settles", () => {
  // The deep-research path: a `Workflow` tool fans out INSIDE its own
  // transcript dir, so the main stream sees only the launch + a single
  // completion notification keyed by the workflow Task ID. It shows as one
  // "still working" row, not its inner agents.
  const normalizer = new ClaudeSessionNormalizer({ taskId: "task-1", sourceId: "claude:s-wf" });
  const upserts = [];
  const lines = [
    claudeLine({
      type: "user",
      uuid: "u1",
      promptId: "p1",
      promptSource: "typed",
      timestamp: "2026-06-17T10:00:00.000Z",
      message: { role: "user", content: "deep research the best DJI Pocket 4 accessories" },
    }),
    claudeLine({
      type: "assistant",
      uuid: "a1",
      promptId: "p1",
      timestamp: "2026-06-17T10:00:02.000Z",
      message: {
        role: "assistant",
        content: [{ type: "tool_use", id: "toolu_W", name: "Workflow", input: { name: "deep-research", args: {} } }],
      },
    }),
    claudeLine({
      type: "user",
      uuid: "u2",
      promptId: "p1",
      timestamp: "2026-06-17T10:00:02.400Z",
      message: {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "toolu_W", content: "Workflow launched in background. Task ID: wfuyb6jib\nSummary: Deep research harness …" },
        ],
      },
    }),
    claudeLine({
      type: "user",
      uuid: "u3",
      promptSource: "system",
      timestamp: "2026-06-17T10:09:00.000Z",
      message: {
        role: "user",
        content:
          "<task-notification>\n<task-id>wfuyb6jib</task-id>\n<status>completed</status>\n<summary>Workflow \"deep-research\" came to rest</summary>\n<usage><duration_ms>540000</duration_ms></usage>\n</task-notification>",
      },
    }),
  ];
  for (const line of lines) {
    upserts.push(...normalizer.consumeLine(line));
  }

  assert.equal(upserts.filter((b) => b.kind === "tool-call").length, 0, "no raw Workflow card");
  const rosters = upserts.filter((b) => b.kind === "agents");
  assert.ok(rosters.length >= 1, "the workflow launch produced a roster row");
  const finalRoster = rosters[rosters.length - 1];
  assert.deepEqual(
    finalRoster.items.map((i) => [i.name, i.detail, i.agentType, i.status, i.durationMs]),
    [["deep-research", "Deep research harness …", "workflow", "done", 540000]],
    "one coarse workflow row, summary folded onto it, settled with the CLI duration",
  );
});

check("claude: a re-notification never clobbers a settled agent's CLI duration", () => {
  // The CLI may notify the same agent more than once. A later notification
  // WITHOUT <duration_ms> must not overwrite the authoritative first duration
  // with a wall-clock estimate, and must not re-emit a no-op block.
  const normalizer = new ClaudeSessionNormalizer({ taskId: "task-1", sourceId: "claude:s-renotify" });
  const upserts = [];
  const lines = [
    claudeLine({ type: "user", uuid: "u1", promptId: "p1", promptSource: "typed", timestamp: "2026-06-17T10:00:00.000Z", message: { role: "user", content: "Research it" } }),
    claudeLine({ type: "assistant", uuid: "a1", promptId: "p1", timestamp: "2026-06-17T10:00:01.000Z", message: { role: "assistant", content: [{ type: "tool_use", id: "toolu_A", name: "Agent", input: { description: "Research", subagent_type: "general-purpose" } }] } }),
    claudeLine({ type: "user", uuid: "u2", promptId: "p1", timestamp: "2026-06-17T10:00:01.200Z", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_A", content: "agentId: a-1 (internal)" }] } }),
    // First notification: authoritative duration.
    claudeLine({ type: "user", uuid: "u3", promptSource: "system", timestamp: "2026-06-17T10:02:00.000Z", message: { role: "user", content: "<task-notification>\n<task-id>a-1</task-id>\n<status>completed</status>\n<usage><duration_ms>119000</duration_ms></usage>\n</task-notification>" } }),
    // Re-notification much later, no duration — must NOT clobber, must NOT re-emit.
    claudeLine({ type: "user", uuid: "u4", promptSource: "system", timestamp: "2026-06-17T10:30:00.000Z", message: { role: "user", content: "<task-notification>\n<task-id>a-1</task-id>\n<status>completed</status>\n</task-notification>" } }),
  ];
  let beforeRenotify = 0;
  for (const [i, line] of lines.entries()) {
    const out = normalizer.consumeLine(line);
    if (i === 3) beforeRenotify = upserts.length + out.length;
    upserts.push(...out);
  }
  assert.equal(upserts.length, beforeRenotify, "the duplicate notification emitted no new block");
  const finalRoster = upserts.filter((b) => b.kind === "agents").pop();
  assert.equal(finalRoster.items[0].status, "done");
  assert.equal(finalRoster.items[0].durationMs, 119000, "CLI duration preserved, not recomputed to ~30min");
});

check("claude: agent rosters are isolated per turn (a later turn never inherits earlier agents)", () => {
  const normalizer = new ClaudeSessionNormalizer({ taskId: "task-1", sourceId: "claude:s-ag2" });
  const upserts = [];
  const spawn = (turnPrompt, toolId, desc, t) => [
    claudeLine({ type: "user", uuid: `u-${toolId}`, promptId: turnPrompt, promptSource: "typed", timestamp: t, message: { role: "user", content: `prompt ${turnPrompt}` } }),
    claudeLine({ type: "assistant", uuid: `a-${toolId}`, promptId: turnPrompt, timestamp: t, message: { role: "assistant", content: [{ type: "tool_use", id: toolId, name: "Agent", input: { description: desc, subagent_type: "general-purpose" } }] } }),
  ];
  const lines = [
    ...spawn("turnA", "toolu_A", "Agent in turn A", "2026-06-17T10:00:00.000Z"),
    ...spawn("turnB", "toolu_B", "Agent in turn B", "2026-06-17T10:05:00.000Z"),
  ];
  for (const line of lines) {
    upserts.push(...normalizer.consumeLine(line));
  }
  const rosters = upserts.filter((b) => b.kind === "agents");
  const turnA = rosters.filter((b) => b.turnKey === "turnA").pop();
  const turnB = rosters.filter((b) => b.turnKey === "turnB").pop();
  assert.deepEqual(turnA.items.map((i) => i.name), ["Agent in turn A"]);
  assert.deepEqual(turnB.items.map((i) => i.name), ["Agent in turn B"], "turn B's roster has only its own agent");
});

check("claude: promptSource=sdk records still render (the user's own words in SDK sessions)", () => {
  // Guard against the tempting over-fix: every prompt in a Claude-Agent-SDK
  // session is tagged `sdk`. Excluding it would erase the user from the
  // reading surface. `sdk` must keep starting turns like a real prompt.
  const normalizer = new ClaudeSessionNormalizer({ taskId: "task-1", sourceId: "claude:s-sdk" });
  const upserts = [];
  const lines = [
    claudeLine({
      type: "user",
      uuid: "u1",
      promptId: "p1",
      promptSource: "sdk",
      timestamp: "2026-06-09T10:00:00.000Z",
      message: { role: "user", content: "First SDK-driven prompt" },
    }),
    claudeLine({
      type: "assistant",
      uuid: "a1",
      promptId: "p1",
      timestamp: "2026-06-09T10:00:02.000Z",
      message: { role: "assistant", content: [{ type: "text", text: "Reply one." }] },
    }),
    claudeLine({
      type: "user",
      uuid: "u2",
      promptId: "p2",
      promptSource: "sdk",
      timestamp: "2026-06-09T10:01:00.000Z",
      message: { role: "user", content: "Second SDK-driven prompt" },
    }),
  ];
  for (const line of lines) {
    upserts.push(...normalizer.consumeLine(line));
  }

  assert.deepEqual(
    upserts.map((block) => block.kind),
    ["user-message", "assistant-text", "user-message"],
  );
  assert.equal(upserts[0].text, "First SDK-driven prompt");
  assert.equal(upserts[2].text, "Second SDK-driven prompt");
  assert.notEqual(upserts[0].turnKey, upserts[2].turnKey);
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

check("locator: identity wins over recency — resume never rebinds to a sibling session", () => {
  // The incident topology: two Claude sessions live in the SAME cwd slug, and
  // the unrelated one (a hand /resume to another conversation) is the freshest.
  const projectsDir = path.join(tempRoot, "claude-projects-rebind");
  const cwd = path.join(tempRoot, "workspace-rebind");
  fs.mkdirSync(cwd, { recursive: true });
  const slugDir = path.join(projectsDir, claudeProjectSlug(cwd));
  fs.mkdirSync(slugDir, { recursive: true });

  const ourId = "f70912a7-aaaa-bbbb-cccc-000000000001";
  const siblingId = "cffdc8a9-dddd-eeee-ffff-000000000002";
  const ours = path.join(slugDir, `${ourId}.jsonl`);
  const sibling = path.join(slugDir, `${siblingId}.jsonl`);
  const rec = (sid) =>
    `${JSON.stringify({ type: "user", cwd, sessionId: sid, message: { role: "user", content: "x" } })}\n`;
  fs.writeFileSync(ours, rec(ourId));
  fs.writeFileSync(sibling, rec(siblingId));
  // Ours is OLDER; the sibling is the freshest file — the exact trap.
  const old = new Date(Date.now() - 30_000);
  fs.utimesSync(ours, old, old);

  const base = {
    provider: "claude",
    providerCwd: cwd,
    notBefore: new Date(Date.now() - 60_000).toISOString(),
    claudeProjectsDir: projectsDir,
  };

  // Resume (strict): identity wins even though a fresher sibling exists.
  const resumed = locateSessionFile({ ...base, expectedSessionId: ourId, allowMtimeFallback: false });
  assert.equal(resumed?.providerSessionId, ourId);

  // Resume where our file is already attached (excluded) — the live incident
  // shape. Must return null, NEVER the fresher sibling.
  const noRebind = locateSessionFile({
    ...base,
    expectedSessionId: ourId,
    allowMtimeFallback: false,
    excludePaths: new Set([ours]),
  });
  assert.equal(noRebind, null, "resume must never adopt a sibling session in the same cwd");

  // Fresh discovery (no known id) keeps legacy newest-by-mtime behaviour.
  const fresh = locateSessionFile({ ...base, allowMtimeFallback: true });
  assert.equal(fresh?.providerSessionId, siblingId);

  // Fresh with a pinned id present → identity match returns the pinned one.
  const pinned = locateSessionFile({ ...base, expectedSessionId: ourId, allowMtimeFallback: true });
  assert.equal(pinned?.providerSessionId, ourId);
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
