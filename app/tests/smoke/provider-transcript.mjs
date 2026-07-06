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
const { userPromptDisplay } = require("../../dist/reading-core/selectors/turns");

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

check("claude: image prompt attributes to its raw-text run through the real chain (2026-07-05)", () => {
  // The seam the image double-card bug lived in: the normalizer emits a
  // user-message whose text carries the CLI's `[Image #N]` prefix, but the run
  // Duet's idle-send path created stored the RAW typed text with no promptId.
  // resolveRunForTurn must attribute the one to the other — pre-fix it returned
  // null (raw !== decorated) and the run rendered as a second husk card.
  const { RunIndex, resolveRunForTurn } = require("../../dist/runtime");
  const dir = fs.mkdtempSync(path.join(tempRoot, "img-chain-"));
  const runIndex = new RunIndex({ taskId: "t", reportPath: path.join(dir, "report.json") });
  runIndex.consume({
    type: "run:started",
    payload: {
      taskId: "t",
      id: "run-img",
      kind: "prompt",
      prompt: "我刚做完一系列重构 Preview 的工作", // raw typed text — no [Image #N]
      promptId: null, // the typed-prompt back-stamp had nothing to stamp yet
      title: "img",
      status: "active",
      lifecyclePhase: "active",
      startedAt: "2026-07-05T11:20:15.324Z",
      endedAt: null,
      elapsedMs: null,
      completionSource: null,
      completionConfidence: null,
    },
    ts: "2026-07-05T11:20:15.324Z",
  });

  const normalizer = new ClaudeSessionNormalizer({ taskId: "t", sourceId: "s" });
  const blocks = normalizer.consumeLine(
    claudeLine({
      type: "user",
      uuid: "u1",
      promptId: "a837862a",
      promptSource: "typed",
      timestamp: "2026-07-05T11:20:15.679Z",
      message: {
        role: "user",
        content: [
          { type: "text", text: "[Image #1] [Image #2] [Image #3]我刚做完一系列重构 Preview 的工作" },
          { type: "image", source: { type: "base64", media_type: "image/png", data: "AAAA" } },
        ],
      },
    }),
  );
  const user = blocks.find((block) => block.kind === "user-message");
  assert.ok(user, "normalizer emitted the user-message block");
  assert.equal(user.attachments.length, 1, "image attachment carried onto the block");

  // Reproduce the anchor ProviderTranscript.attributeRun builds from the block,
  // then resolve through the REAL matcher.
  const promptId = /^turn-\d+$/.test(user.turnKey) ? null : user.turnKey;
  const runId = resolveRunForTurn(runIndex, {
    text: user.text,
    command: user.command,
    tsMs: Date.parse(user.ts),
    promptId,
    assigned: new Set(),
  });
  assert.equal(runId, "run-img", "image turn attributes to its raw-text run (no husk)");

  runIndex.dispose?.();
  fs.rmSync(dir, { recursive: true, force: true });
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
    ["user-message", "assistant-text", "system-note", "assistant-text"],
    "the task-notification produces a muted note, never a user bubble",
  );
  assert.equal(upserts[0].text, "Research the two cameras");
  // The notification IS a turn boundary at the API level — the CLI begins a
  // fresh assistant turn from it. The reply lands in a CONTINUATION turn
  // (with the note naming what came back), not the original prompt's turn:
  // piling successive replies into one card was the Loop-Engineering reading
  // bug (S5 follow-up, 2026-07-02).
  assert.equal(upserts[2].text, 'Agent "Research Insta360 Luna Ultra" came to rest');
  assert.notEqual(upserts[2].turnKey, upserts[0].turnKey, "continuation turn opens");
  assert.equal(upserts[3].turnKey, upserts[2].turnKey, "reply lands in the continuation turn");
  assert.ok(
    upserts[2].sourcePrompt?.includes("<task-notification>"),
    "the note carries the verbatim injected prompt for run attribution",
  );
});

check("claude: a /loop wakeup (promptSource=system + isMeta) opens its own turn", () => {
  // The 调研Codex bug (2026-07-03): a ScheduleWakeup prompt arrives as
  // promptSource:"system" AND isMeta:true — the isMeta skip ate the record,
  // no turn opened, the reply attributed to the PREVIOUS turn, and the
  // wakeup's run rendered as a terminal-approximation husk with a "You"
  // bubble of machine text. System provenance must outrank the isMeta skip.
  const normalizer = new ClaudeSessionNormalizer({ taskId: "task-1", sourceId: "claude:s-wake" });
  const upserts = [];
  const wakeupText = "检查第二个 Codex Mac app 调研 agent (aab922afa61b905ba) 是否完成，完成则汇总两个 agent 结论";
  const lines = [
    claudeLine({
      type: "user",
      uuid: "u1",
      promptId: "p1",
      promptSource: "typed",
      timestamp: "2026-07-03T10:00:00.000Z",
      message: { role: "user", content: "派出两个 research agent" },
    }),
    claudeLine({
      type: "assistant",
      uuid: "a1",
      promptId: "p1",
      timestamp: "2026-07-03T10:00:02.000Z",
      message: { role: "assistant", content: [{ type: "text", text: "已安排定时检查。" }] },
    }),
    // The wakeup — verbatim shape from the live session: system source,
    // isMeta true, its own promptId.
    claudeLine({
      type: "user",
      uuid: "u2",
      promptId: "p2",
      promptSource: "system",
      isMeta: true,
      timestamp: "2026-07-03T10:05:00.000Z",
      message: { role: "user", content: wakeupText },
    }),
    claudeLine({
      type: "assistant",
      uuid: "a2",
      timestamp: "2026-07-03T10:05:02.000Z",
      message: { role: "assistant", content: [{ type: "text", text: "第二个 agent 已经完成。" }] },
    }),
    // A non-system isMeta record must KEEP the skip (caveat class).
    claudeLine({
      type: "user",
      uuid: "u3",
      isMeta: true,
      timestamp: "2026-07-03T10:05:03.000Z",
      message: { role: "user", content: "Caveat: local command output below." },
    }),
  ];
  for (const line of lines) {
    upserts.push(...normalizer.consumeLine(line));
  }

  assert.deepEqual(
    upserts.map((block) => block.kind),
    ["user-message", "assistant-text", "system-note", "assistant-text"],
    "wakeup = machinery note (never a You bubble); caveat record still skipped",
  );
  assert.equal(upserts[2].turnKey, "p2", "the wakeup opens its own turn, keyed by promptId");
  assert.equal(upserts[2].text, `Automated prompt: ${wakeupText}`);
  assert.equal(upserts[2].sourcePrompt, wakeupText, "sourcePrompt bridges to the wakeup's run");
  assert.equal(upserts[3].turnKey, "p2", "the reply lands in the wakeup's turn, not the previous one");
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

check("claude: a QUEUED task-notification settles the roster (busy main loop)", () => {
  // The other delivery path (Woody's 630-minute ghosts, 2026-07-03): a
  // background agent that finishes while the main loop is BUSY rides the
  // CLI's message queue — the notification lands as a `queue-operation`
  // (enqueue) plus an `attachment{type:"queued_command"}` record, NEVER as
  // the promptSource:"system" user record of the idle path. Record shapes
  // below are verbatim from the live session transcript (paths redacted).
  const normalizer = new ClaudeSessionNormalizer({ taskId: "task-1", sourceId: "claude:s-qn" });
  const upserts = [];
  const notificationXml = [
    "<task-notification>",
    "<task-id>ae243b1806f681d9d</task-id>",
    "<tool-use-id>toolu_A</tool-use-id>",
    "<output-file>/tmp/tasks/ae243b1806f681d9d.output</output-file>",
    "<status>completed</status>",
    '<summary>Agent "Audit activityHints usage split" finished</summary>',
    "<result>Audit complete…</result>",
    "</task-notification>",
  ].join("\n");
  const lines = [
    claudeLine({
      type: "user",
      uuid: "u1",
      promptId: "p1",
      promptSource: "typed",
      timestamp: "2026-07-02T23:44:00.000Z",
      message: { role: "user", content: "Audit the consumer surfaces" },
    }),
    claudeLine({
      type: "assistant",
      uuid: "a1",
      promptId: "p1",
      timestamp: "2026-07-02T23:44:02.000Z",
      message: {
        role: "assistant",
        content: [
          { type: "tool_use", id: "toolu_A", name: "Agent", input: { description: "Audit activityHints usage split", subagent_type: "Explore", prompt: "…" } },
          { type: "tool_use", id: "toolu_B", name: "Agent", input: { description: "Audit dead-code candidates", subagent_type: "Explore", prompt: "…" } },
        ],
      },
    }),
    claudeLine({
      type: "user",
      uuid: "u2",
      promptId: "p1",
      timestamp: "2026-07-02T23:44:02.300Z",
      message: {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "toolu_A", content: "Async agent launched successfully.\nagentId: ae243b1806f681d9d (internal ID - do not mention)" },
          { type: "tool_result", tool_use_id: "toolu_B", content: "Async agent launched successfully.\nagentId: aa45da2ae3d0f3c0a (internal ID - do not mention)" },
        ],
      },
    }),
    // The queued delivery: enqueue op + the queued_command attachment carry
    // the SAME notification — settling must be idempotent across the pair.
    claudeLine({
      type: "queue-operation",
      operation: "enqueue",
      timestamp: "2026-07-02T23:46:28.908Z",
      content: notificationXml,
    }),
    claudeLine({
      type: "attachment",
      uuid: "att1",
      isSidechain: false,
      timestamp: "2026-07-02T23:46:28.908Z",
      attachment: { type: "queued_command", commandMode: "prompt", prompt: notificationXml, timestamp: "2026-07-02T23:46:28.908Z" },
    }),
    // A normal queued user message must produce nothing.
    claudeLine({
      type: "queue-operation",
      operation: "enqueue",
      timestamp: "2026-07-02T23:47:00.000Z",
      content: "please also check the tests",
    }),
  ];
  for (const line of lines) {
    upserts.push(...normalizer.consumeLine(line));
  }

  const rosters = upserts.filter((b) => b.kind === "agents");
  assert.ok(rosters.length >= 2, "spawn + settle each produced a roster upsert");
  const finalRoster = rosters[rosters.length - 1];
  assert.deepEqual(
    finalRoster.items.map((i) => [i.name, i.status]),
    [
      ["Audit activityHints usage split", "done"],
      ["Audit dead-code candidates", "running"],
    ],
    "the queued notification settled its agent; the sibling stays running",
  );
  const settledItem = finalRoster.items[0];
  assert.ok(
    typeof settledItem.durationMs === "number" && settledItem.durationMs > 0,
    "duration computed from spawn→notification when the CLI reports none",
  );
  // Idempotence: the attachment duplicate of the same notification and the
  // plain queued message add NO further roster churn.
  const settleUpserts = rosters.filter((b) => b.items.some((i) => i.status === "done"));
  assert.equal(settleUpserts.length, 1, "settle emitted exactly once across both record shapes");
  assert.equal(
    upserts.filter((b) => b.kind === "user-message").length,
    1,
    "queued records never render as user bubbles",
  );
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
  let renotifyOut = [];
  for (const [i, line] of lines.entries()) {
    const out = normalizer.consumeLine(line);
    if (i === 4) renotifyOut = out;
    upserts.push(...out);
  }
  // The re-notification opens its own continuation turn (one muted note) but
  // must NOT re-upsert the roster — settled state stays untouched.
  assert.deepEqual(
    renotifyOut.map((b) => b.kind),
    ["system-note"],
    "the duplicate notification emits only its continuation note",
  );
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

check("codex: event text, tool pairing, exit-code status, no duplication (0.142.5)", () => {
  const normalizer = new CodexRolloutNormalizer({ taskId: "task-1", sourceId: "codex:s1" });
  const upserts = [];
  const turnId = "019f36e2-1111-7000-8000-000000000001";
  const lines = [
    JSON.stringify({
      timestamp: "2026-07-06T10:00:00.000Z",
      type: "session_meta",
      payload: { id: "sess-1", cwd: "/tmp/work", timestamp: "2026-07-06T10:00:00.000Z" },
    }),
    // 0.142.5: task_started opens the turn and carries the real turn_id, and it
    // precedes the user_message that adopts it.
    JSON.stringify({
      timestamp: "2026-07-06T10:00:00.500Z",
      type: "event_msg",
      payload: {
        type: "task_started",
        turn_id: turnId,
        model_context_window: 272000,
        collaboration_mode_kind: "solo",
      },
    }),
    JSON.stringify({
      timestamp: "2026-07-06T10:00:01.000Z",
      type: "event_msg",
      payload: {
        type: "user_message",
        message: "Fix the bug",
        images: [],
        local_images: [],
        text_elements: [],
      },
    }),
    JSON.stringify({
      timestamp: "2026-07-06T10:00:02.000Z",
      type: "event_msg",
      payload: {
        type: "agent_message",
        message: "Looking at the failure first.",
        phase: "commentary",
        memory_citation: null,
      },
    }),
    // Duplicate of the agent_message through the protocol stream: must be ignored.
    JSON.stringify({
      timestamp: "2026-07-06T10:00:02.100Z",
      type: "response_item",
      payload: {
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: "Looking at the failure first." }],
      },
    }),
    JSON.stringify({
      timestamp: "2026-07-06T10:00:03.000Z",
      type: "response_item",
      payload: {
        type: "function_call",
        name: "exec_command",
        call_id: "call-1",
        arguments: JSON.stringify({
          cmd: "npm test",
          workdir: "/tmp/work",
          justification: "run the suite",
          sandbox_permissions: [],
        }),
      },
    }),
    JSON.stringify({
      timestamp: "2026-07-06T10:00:09.000Z",
      type: "response_item",
      payload: {
        type: "function_call_output",
        call_id: "call-1",
        output: "Wall time: 6 seconds\nProcess exited with code 1\nOutput:\n1 failing test",
      },
    }),
    JSON.stringify({
      timestamp: "2026-07-06T10:00:10.000Z",
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
  // The turn is keyed by the rollout's real turn_id (the run↔turn bridge), not
  // a synthesized `turn-N` — every block in the turn shares it.
  assert.equal(upserts[0].turnKey, turnId, "user-message keyed by task_started turn_id");
  assert.equal(upserts[1].turnKey, turnId, "assistant-text shares the turn_id");
  assert.equal(upserts[2].turnKey, turnId, "tool-call shares the turn_id");
  const toolFinal = upserts[3];
  assert.equal(toolFinal.status, "error");
  assert.equal(toolFinal.summary, "npm test");
  assert.equal(toolFinal.durationMs, 6000);
});

// --- Codex usage → display wiring (S6) ---------------------------------------
// The usage PARSER (parseCodexTokenCountPayload) is fenced in usage-adapters;
// this fence guards the LINK the display path actually depends on — the codex
// normalizer firing onUsageSnapshot when it consumes a rollout `token_count`
// event. Without this, the parser could be perfect and the composer's usage
// chip would still stay dark for codex ("verify the effect, not the artifact").
check("codex: token_count event fires onUsageSnapshot (display-path wiring)", () => {
  const snapshots = [];
  const normalizer = new CodexRolloutNormalizer({
    taskId: "task-1",
    sourceId: "codex:s1",
    onUsageSnapshot: (snapshot) => snapshots.push(snapshot),
  });
  const blocks = normalizer.consumeLine(
    JSON.stringify({
      timestamp: "2026-07-06T10:00:00.000Z",
      type: "event_msg",
      payload: {
        type: "token_count",
        info: {
          last_token_usage: { total_tokens: 18111 },
          model_context_window: 258400,
        },
        rate_limits: {
          primary: { used_percent: 29, window_minutes: 300, resets_at: 1781138289 },
          secondary: { used_percent: 60, window_minutes: 10080, resets_at: 1781175155 },
        },
      },
    }),
  );
  // A token_count line is usage-only; it emits no transcript block.
  assert.equal(blocks.length, 0, "token_count is not a transcript block");
  assert.equal(snapshots.length, 1, "onUsageSnapshot fired exactly once");
  const snapshot = snapshots[0];
  assert.equal(snapshot.provider, "codex");
  assert.equal(snapshot.context.usedTokens, 18111);
  assert.equal(snapshot.context.windowTokens, 258400);
  assert.equal(snapshot.limits[0]?.label, "5h");
  assert.equal(snapshot.limits[0]?.remainingPercent, 71);
  assert.equal(snapshot.limits[1]?.label, "weekly");
});

// --- Codex image prompts join the [Image #N] reading rule (S6, S5 carry C1) ---
// Real codex (0.137–0.142) decorates an attached image as an `[Image #N]`
// placeholder at the head of `user_message.message`, with the file in
// `local_images`. The normalizer keeps the marker verbatim in the block text
// (stripping is a DISPLAY concern) and lifts local_images into attachments; the
// reading-layer userPromptDisplay then reads THROUGH the marker exactly as it
// does for Claude — one provider-neutral rule, no renderer work needed.
check("codex: user_message [Image #N] joins the reading display rule", () => {
  const normalizer = new CodexRolloutNormalizer({ taskId: "task-1", sourceId: "codex:s1" });
  const turnId = "019f36e2-2222-7000-8000-000000000002";
  const imagePath = "/tmp/work/screenshots/blue square.png";
  const blocks = [];
  for (const line of [
    JSON.stringify({
      timestamp: "2026-07-06T10:00:00.000Z",
      type: "event_msg",
      payload: { type: "task_started", turn_id: turnId },
    }),
    JSON.stringify({
      timestamp: "2026-07-06T10:00:01.000Z",
      type: "event_msg",
      payload: {
        type: "user_message",
        message: "[Image #1] Describe the attached image.",
        images: [],
        local_images: [imagePath],
        text_elements: [{ byte_range: { start: 0, end: 10 }, placeholder: "[Image #1]" }],
      },
    }),
  ]) {
    blocks.push(...normalizer.consumeLine(line));
  }
  const userBlock = blocks.find((block) => block.kind === "user-message");
  assert.ok(userBlock, "codex user_message emitted a user-message block");
  // The normalizer preserves the CLI decoration verbatim — display strips it.
  assert.ok(userBlock.text.includes("[Image #1]"), "marker kept verbatim in block text");
  assert.equal(userBlock.attachments.length, 1, "local_images became one attachment");
  assert.equal(userBlock.attachments[0].kind, "image");
  assert.equal(userBlock.attachments[0].path, imagePath);

  // The reading rule joins: markers lift out ONLY because a real attachment
  // exists, and the count chip reflects it.
  const display = userPromptDisplay(userBlock, "");
  assert.equal(display.imageCount, 1, "attachment count drives the chip");
  assert.equal(display.text, "Describe the attached image.", "marker lifted from display text");
  assert.ok(!display.text.includes("[Image #1]"), "no raw marker leaks into the bubble");
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

check("locator: codex null id + fallback OFF returns null — NO recency cross-bind (S2 review #1)", () => {
  // The same-cwd corruption codex is exposed to: it cannot pin a session id up
  // front, so it passes expectedSessionId=null + allowMtimeFallback=false and
  // relies wholly on the SessionStart hook. Two sibling rollouts in one cwd must
  // NOT let the locator cross-bind by recency — the flag must be authoritative
  // even with a null id (the pre-fix bug only honored it inside `if(id)`).
  const sessionsDir = path.join(tempRoot, "codex-null-id-fallback");
  const cwd = path.join(tempRoot, "workspace-null-id");
  fs.mkdirSync(cwd, { recursive: true });
  const now = new Date();
  const dayDir = path.join(
    sessionsDir,
    String(now.getFullYear()),
    String(now.getMonth() + 1).padStart(2, "0"),
    String(now.getDate()).padStart(2, "0"),
  );
  fs.mkdirSync(dayDir, { recursive: true });
  for (const id of ["sib-A", "sib-B"]) {
    fs.writeFileSync(
      path.join(dayDir, `rollout-2026-07-06T10-00-00-${id}.jsonl`),
      `${JSON.stringify({ timestamp: now.toISOString(), type: "session_meta", payload: { id, cwd, timestamp: now.toISOString() } })}\n`,
    );
  }
  const base = {
    provider: "codex",
    providerCwd: cwd,
    notBefore: new Date(Date.now() - 60_000).toISOString(),
    codexSessionsDir: sessionsDir,
  };
  // Fallback OFF + no id → null (wait for the handshake), never a recency guess.
  assert.equal(
    locateSessionFile({ ...base, allowMtimeFallback: false }),
    null,
    "codex fresh (null id) must NOT mtime-adopt when fallback is disabled",
  );
  // Fallback ON + no id keeps legacy discovery (a sibling is returned).
  assert.ok(
    locateSessionFile({ ...base, allowMtimeFallback: true }),
    "fallback ON still discovers by recency",
  );
  // Fallback OFF + exact id → binds that exact rollout.
  assert.equal(
    locateSessionFile({ ...base, expectedSessionId: "sib-B", allowMtimeFallback: false })
      ?.providerSessionId,
    "sib-B",
  );
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

// Codex adoption self-heal (S2 review #2): only SessionStart reaches adoption
// for codex, so a rollout that TRAILS the handshake would be lost forever
// without discovery binding by the CLI-declared id. setExpectedSessionId points
// discovery at it; the poll adopts by identity once the file lands — no mtime.
await (async () => {
  const name = "provider-transcript: codex setExpectedSessionId self-heals when the rollout trails";
  try {
    const sessionsDir = path.join(tempRoot, "codex-selfheal-sessions");
    const cwd = path.join(tempRoot, "workspace-selfheal");
    fs.mkdirSync(cwd, { recursive: true });
    const now = new Date();
    const dayDir = path.join(
      sessionsDir,
      String(now.getFullYear()),
      String(now.getMonth() + 1).padStart(2, "0"),
      String(now.getDate()).padStart(2, "0"),
    );
    fs.mkdirSync(dayDir, { recursive: true });

    const events = [];
    const transcript = new ProviderTranscript({
      taskId: "task-codex-selfheal",
      provider: "codex",
      providerCwd: cwd,
      eventSink: (event) => events.push(event),
      resolveRunId: () => null,
      // Codex fresh: no pinned id, no mtime fallback — hooks are the identity.
      expectedSessionId: null,
      allowMtimeFallback: false,
      locate: (options) => locateSessionFile({ ...options, codexSessionsDir: sessionsDir }),
      pollMs: 50,
    });

    // Discovery polls every 1.5s (DISCOVERY_INTERVAL_MS); the immediate first
    // pass finds nothing (no id + fallback off).
    transcript.startDiscovery(new Date(Date.now() - 5_000).toISOString());
    await new Promise((resolve) => setTimeout(resolve, 150));
    assert.equal(
      events.filter((e) => e.type === "transcript:located").length,
      0,
      "no id + fallback off must not adopt anything yet",
    );

    // SessionStart arrived with an id, but the rollout has not landed — the
    // controller calls setExpectedSessionId, then the file appears a beat later.
    transcript.setExpectedSessionId("sess-heal-1");
    fs.writeFileSync(
      path.join(dayDir, "rollout-2026-07-06T11-00-00-sess-heal-1.jsonl"),
      `${JSON.stringify({ timestamp: now.toISOString(), type: "session_meta", payload: { id: "sess-heal-1", cwd, timestamp: now.toISOString() } })}\n`,
    );
    // Wait past the next discovery poll (>1.5s) so it binds by identity.
    await new Promise((resolve) => setTimeout(resolve, 1_900));
    transcript.dispose();

    const located = events.filter((e) => e.type === "transcript:located");
    assert.equal(located.length, 1, "discovery bound the rollout once it landed");
    assert.equal(located[0].payload.source.providerSessionId, "sess-heal-1");
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

check("codex: task_started splits non-user-initiated turns (B1) — no fold into predecessor", () => {
  const normalizer = new CodexRolloutNormalizer({ taskId: "task-1", sourceId: "codex:s1" });
  const turnA = "019f0000-aaaa-7000-8000-00000000000a";
  const turnB = "019f0000-bbbb-7000-8000-00000000000b";
  const upserts = [];
  const lines = [
    // Turn A: a normal user-initiated turn.
    JSON.stringify({ timestamp: "2026-07-06T10:00:00.000Z", type: "event_msg", payload: { type: "task_started", turn_id: turnA } }),
    JSON.stringify({ timestamp: "2026-07-06T10:00:01.000Z", type: "event_msg", payload: { type: "user_message", message: "первый" } }),
    JSON.stringify({ timestamp: "2026-07-06T10:00:02.000Z", type: "event_msg", payload: { type: "agent_message", message: "reply A", phase: "final_answer" } }),
    // Turn B: NO user_message (a review/compaction continuation). Pre-fix this
    // agent_message would fold into turn A; now it gets its own turn_id group.
    JSON.stringify({ timestamp: "2026-07-06T10:00:03.000Z", type: "event_msg", payload: { type: "task_started", turn_id: turnB } }),
    JSON.stringify({ timestamp: "2026-07-06T10:00:04.000Z", type: "event_msg", payload: { type: "agent_message", message: "reply B", phase: "commentary" } }),
  ];
  for (const line of lines) {
    upserts.push(...normalizer.consumeLine(line));
  }
  const replyA = upserts.find((b) => b.kind === "assistant-text" && b.markdown === "reply A");
  const replyB = upserts.find((b) => b.kind === "assistant-text" && b.markdown === "reply B");
  assert.equal(replyA.turnKey, turnA);
  assert.equal(replyB.turnKey, turnB, "orphan (no user_message) turn is NOT merged into turn A");
  assert.notEqual(replyA.turnKey, replyB.turnKey);
});

check("codex: user_message without a preceding task_started falls back to synthetic turn-N", () => {
  const normalizer = new CodexRolloutNormalizer({ taskId: "task-1", sourceId: "codex:s1" });
  const upserts = [];
  const lines = [
    JSON.stringify({ timestamp: "2026-06-11T10:00:01.000Z", type: "event_msg", payload: { type: "user_message", message: "no task_started here" } }),
    JSON.stringify({ timestamp: "2026-06-11T10:00:02.000Z", type: "event_msg", payload: { type: "agent_message", message: "ok" } }),
  ];
  for (const line of lines) {
    upserts.push(...normalizer.consumeLine(line));
  }
  const user = upserts.find((b) => b.kind === "user-message");
  // The synthetic key is what provider-transcript reads as "no promptId" (the
  // /^turn-\d+$/ guard), so runs stay text/time-matchable exactly as before.
  assert.match(user.turnKey, /^turn-\d+$/, "no turn_id → synthetic fallback key");
});

check("codex: turn_aborted settles the stuck tool call and notes the stopped turn (A4)", () => {
  const normalizer = new CodexRolloutNormalizer({ taskId: "task-1", sourceId: "codex:s1" });
  const turnId = "019f0000-cccc-7000-8000-00000000000c";
  const upserts = [];
  const lines = [
    JSON.stringify({ timestamp: "2026-07-06T10:00:00.000Z", type: "event_msg", payload: { type: "task_started", turn_id: turnId } }),
    JSON.stringify({ timestamp: "2026-07-06T10:00:01.000Z", type: "event_msg", payload: { type: "user_message", message: "run the long thing" } }),
    JSON.stringify({
      timestamp: "2026-07-06T10:00:02.000Z",
      type: "response_item",
      payload: { type: "function_call", name: "exec_command", call_id: "call-x", arguments: JSON.stringify({ cmd: "sleep 999" }) },
    }),
    // Esc mid-tool: no function_call_output ever arrives; abort instead.
    JSON.stringify({
      timestamp: "2026-07-06T10:00:05.000Z",
      type: "event_msg",
      payload: { type: "turn_aborted", reason: "interrupted", turn_id: turnId, completed_at: 0, duration_ms: 0 },
    }),
  ];
  for (const line of lines) {
    upserts.push(...normalizer.consumeLine(line));
  }
  const running = upserts.filter((b) => b.kind === "tool-call" && b.status === "running");
  const runningStillPending = running.filter(
    (b) => !upserts.some((later) => later.id === b.id && later.status !== "running"),
  );
  assert.equal(runningStillPending.length, 0, "no tool call left running forever");
  const settled = upserts.filter((b) => b.kind === "tool-call" && b.callId === "call-x").pop();
  assert.equal(settled.status, "error");
  assert.equal(settled.durationMs, 3000);
  const note = upserts.filter((b) => b.kind === "system-note").pop();
  assert.ok(note.text.toLowerCase().includes("stopped"), "stopped outcome note present");
  assert.equal(note.turnKey, turnId, "note attributed to the aborted turn");
});

check("codex: thread_rolled_back names the rollback (A3)", () => {
  const normalizer = new CodexRolloutNormalizer({ taskId: "task-1", sourceId: "codex:s1" });
  const turnId = "019f0000-dddd-7000-8000-00000000000d";
  const upserts = [];
  const lines = [
    JSON.stringify({ timestamp: "2026-07-05T10:00:00.000Z", type: "event_msg", payload: { type: "task_started", turn_id: turnId } }),
    JSON.stringify({ timestamp: "2026-07-05T10:00:01.000Z", type: "event_msg", payload: { type: "user_message", message: "do X" } }),
    JSON.stringify({ timestamp: "2026-07-05T10:00:02.000Z", type: "event_msg", payload: { type: "thread_rolled_back", num_turns: 1 } }),
  ];
  for (const line of lines) {
    upserts.push(...normalizer.consumeLine(line));
  }
  const note = upserts.filter((b) => b.kind === "system-note").pop();
  assert.ok(note.text.toLowerCase().includes("rolled back"));
  assert.ok(note.text.includes("1"), "num_turns surfaced");
});

check("codex: exited_review_mode renders /review findings as the reply (A1)", () => {
  const normalizer = new CodexRolloutNormalizer({ taskId: "task-1", sourceId: "codex:s1" });
  const turnId = "019f0000-eeee-7000-8000-00000000000e";
  const upserts = [];
  const lines = [
    JSON.stringify({ timestamp: "2026-07-06T10:00:00.000Z", type: "event_msg", payload: { type: "task_started", turn_id: turnId } }),
    JSON.stringify({ timestamp: "2026-07-06T10:00:01.000Z", type: "event_msg", payload: { type: "user_message", message: "/review" } }),
    JSON.stringify({
      timestamp: "2026-07-06T10:00:02.000Z",
      type: "event_msg",
      payload: { type: "entered_review_mode", target: { type: "uncommitted" }, user_facing_hint: "reviewing" },
    }),
    JSON.stringify({
      timestamp: "2026-07-06T10:00:20.000Z",
      type: "event_msg",
      payload: {
        type: "exited_review_mode",
        review_output: {
          findings: [
            {
              title: "Off-by-one in loop bound",
              body: "The loop iterates one element past the end.",
              confidence_score: 0.8,
              priority: 1,
              code_location: { absolute_file_path: "/tmp/work/loop.ts", line_range: { start: 10, end: 12 } },
            },
          ],
          overall_confidence_score: 0.8,
          overall_correctness: "patch is incorrect",
          overall_explanation: "One real bug found.",
        },
      },
    }),
  ];
  for (const line of lines) {
    upserts.push(...normalizer.consumeLine(line));
  }
  const started = upserts.find((b) => b.kind === "system-note" && b.text.toLowerCase().includes("review started"));
  assert.ok(started, "entered_review_mode → started note");
  const review = upserts.find((b) => b.kind === "assistant-text" && b.markdown.includes("Off-by-one"));
  assert.ok(review, "findings render as an assistant-text reply, not dropped");
  assert.ok(review.markdown.includes("patch is incorrect"), "overall verdict included");
  assert.ok(review.markdown.includes("/tmp/work/loop.ts:10-12"), "code location included");
  assert.equal(review.turnKey, turnId, "review reply keyed to the /review turn");
});

check("codex: reasoning summary renders when present, silent when empty (A2 provider-knob)", () => {
  const normalizer = new CodexRolloutNormalizer({ taskId: "task-1", sourceId: "codex:s1" });
  const upserts = [];
  const lines = [
    JSON.stringify({ timestamp: "2026-07-06T10:00:00.000Z", type: "event_msg", payload: { type: "task_started", turn_id: "019f0000-ffff-7000-8000-00000000000f" } }),
    JSON.stringify({ timestamp: "2026-07-06T10:00:01.000Z", type: "event_msg", payload: { type: "user_message", message: "think" } }),
    // Encrypted-only (real corpus default): summary empty → no thinking block.
    JSON.stringify({
      timestamp: "2026-07-06T10:00:02.000Z",
      type: "response_item",
      payload: { type: "reasoning", id: "r1", summary: [], encrypted_content: "…" },
    }),
    // With model_reasoning_summary=detailed the summary carries summary_text
    // (verified live via a headless `codex exec` probe): the existing path lights up.
    JSON.stringify({
      timestamp: "2026-07-06T10:00:03.000Z",
      type: "response_item",
      payload: { type: "reasoning", id: "r2", summary: [{ type: "summary_text", text: "First, factor the number." }], encrypted_content: "…" },
    }),
  ];
  for (const line of lines) {
    upserts.push(...normalizer.consumeLine(line));
  }
  const thinking = upserts.filter((b) => b.kind === "thinking");
  assert.equal(thinking.length, 1, "empty summary stays silent; summary_text renders");
  assert.equal(thinking[0].text, "First, factor the number.");
});

check("codex: abort-only rollout keys the stopped note to its own turn_id (review fix 1)", () => {
  // Aborted before task_started was ever written: the note must key to
  // payload.turn_id so it can match the run the hook stamped with the same id.
  const normalizer = new CodexRolloutNormalizer({ taskId: "task-1", sourceId: "codex:s1" });
  const turnId = "019f0000-a0a0-7000-8000-0000000000a0";
  const upserts = [];
  const lines = [
    JSON.stringify({ timestamp: "2026-06-25T10:00:00.000Z", type: "event_msg", payload: { type: "user_message", message: "start something" } }),
    JSON.stringify({ timestamp: "2026-06-25T10:00:05.000Z", type: "event_msg", payload: { type: "turn_aborted", reason: "interrupted", turn_id: turnId, completed_at: 0, duration_ms: 0 } }),
  ];
  for (const line of lines) {
    upserts.push(...normalizer.consumeLine(line));
  }
  const note = upserts.filter((b) => b.kind === "system-note").pop();
  assert.equal(note.turnKey, turnId, "note anchored to the abort's turn_id, not a synthetic key");
  assert.match(turnId, /^019f/, "the anchor is the real UUID the hook also carries");
});

check("codex: late task_started reconciles a user-first turn — no prompt/reply split (review fix 2)", () => {
  const normalizer = new CodexRolloutNormalizer({ taskId: "task-1", sourceId: "codex:s1" });
  const turnId = "019f0000-b0b0-7000-8000-0000000000b0";
  const upserts = [];
  const lines = [
    // Edge ordering: user_message BEFORE task_started.
    JSON.stringify({ timestamp: "2026-06-20T10:00:00.000Z", type: "event_msg", payload: { type: "user_message", message: "do the thing" } }),
    JSON.stringify({ timestamp: "2026-06-20T10:00:00.500Z", type: "event_msg", payload: { type: "task_started", turn_id: turnId } }),
    JSON.stringify({ timestamp: "2026-06-20T10:00:01.000Z", type: "event_msg", payload: { type: "agent_message", message: "done", phase: "final_answer" } }),
  ];
  for (const line of lines) {
    upserts.push(...normalizer.consumeLine(line));
  }
  const user = upserts.filter((b) => b.kind === "user-message").pop();
  const reply = upserts.find((b) => b.kind === "assistant-text");
  assert.equal(user.turnKey, turnId, "prompt re-keyed onto the real turn_id");
  assert.equal(reply.turnKey, turnId, "reply shares the turn_id");
  assert.equal(user.turnKey, reply.turnKey, "prompt and reply are ONE turn, not split");
  // The prompt is UPSERTED (emitted twice: initial synthetic key, then re-keyed
  // onto the real turn_id) — one stable block id, not a duplicate prompt.
  const userIds = new Set(upserts.filter((b) => b.kind === "user-message").map((b) => b.id));
  assert.equal(userIds.size, 1, "one prompt block id, re-keyed in place");
});

check("codex: abort settles only the aborted turn's tools, not an earlier orphan (review fix 3)", () => {
  const normalizer = new CodexRolloutNormalizer({ taskId: "task-1", sourceId: "codex:s1" });
  const turnA = "019f0000-c0c0-7000-8000-0000000000c1";
  const turnB = "019f0000-c0c0-7000-8000-0000000000c2";
  const upserts = [];
  const lines = [
    // Turn A leaves an orphan tool with no output (never settled).
    JSON.stringify({ timestamp: "2026-07-06T10:00:00.000Z", type: "event_msg", payload: { type: "task_started", turn_id: turnA } }),
    JSON.stringify({ timestamp: "2026-07-06T10:00:01.000Z", type: "event_msg", payload: { type: "user_message", message: "turn A" } }),
    JSON.stringify({ timestamp: "2026-07-06T10:00:02.000Z", type: "response_item", payload: { type: "function_call", name: "exec_command", call_id: "orphan-A", arguments: JSON.stringify({ cmd: "sleep 1" }) } }),
    // Turn B starts, runs a tool, then aborts.
    JSON.stringify({ timestamp: "2026-07-06T10:00:10.000Z", type: "event_msg", payload: { type: "task_started", turn_id: turnB } }),
    JSON.stringify({ timestamp: "2026-07-06T10:00:11.000Z", type: "event_msg", payload: { type: "user_message", message: "turn B" } }),
    JSON.stringify({ timestamp: "2026-07-06T10:00:12.000Z", type: "response_item", payload: { type: "function_call", name: "exec_command", call_id: "live-B", arguments: JSON.stringify({ cmd: "sleep 999" }) } }),
    JSON.stringify({ timestamp: "2026-07-06T10:00:15.000Z", type: "event_msg", payload: { type: "turn_aborted", reason: "interrupted", turn_id: turnB, completed_at: 0, duration_ms: 0 } }),
  ];
  for (const line of lines) {
    upserts.push(...normalizer.consumeLine(line));
  }
  const orphanSettled = upserts.some((b) => b.kind === "tool-call" && b.callId === "orphan-A" && b.status === "error");
  assert.equal(orphanSettled, false, "turn A's orphan must NOT get a spurious stopped error from turn B's abort");
  const bSettled = upserts.filter((b) => b.kind === "tool-call" && b.callId === "live-B").pop();
  assert.equal(bSettled.status, "error", "the aborted turn's own tool IS settled");
  assert.equal(bSettled.turnKey, turnB);
});

check("codex: a late function_call_output after abort supersedes the synthesized error (review fix 4)", () => {
  const normalizer = new CodexRolloutNormalizer({ taskId: "task-1", sourceId: "codex:s1" });
  const turnId = "019f0000-d0d0-7000-8000-0000000000d0";
  const upserts = [];
  const lines = [
    JSON.stringify({ timestamp: "2026-07-06T10:00:00.000Z", type: "event_msg", payload: { type: "task_started", turn_id: turnId } }),
    JSON.stringify({ timestamp: "2026-07-06T10:00:01.000Z", type: "event_msg", payload: { type: "user_message", message: "run" } }),
    JSON.stringify({ timestamp: "2026-07-06T10:00:02.000Z", type: "response_item", payload: { type: "function_call", name: "exec_command", call_id: "call-late", arguments: JSON.stringify({ cmd: "make" }) } }),
    // JSONL order: call → abort → the real output lands afterward.
    JSON.stringify({ timestamp: "2026-07-06T10:00:05.000Z", type: "event_msg", payload: { type: "turn_aborted", reason: "interrupted", turn_id: turnId, completed_at: 0, duration_ms: 0 } }),
    JSON.stringify({ timestamp: "2026-07-06T10:00:06.000Z", type: "response_item", payload: { type: "function_call_output", call_id: "call-late", output: "Wall time: 4 seconds\nProcess exited with code 0" } }),
  ];
  for (const line of lines) {
    upserts.push(...normalizer.consumeLine(line));
  }
  const settled = upserts.filter((b) => b.kind === "tool-call" && b.callId === "call-late").pop();
  assert.equal(settled.status, "ok", "the real success output supersedes the abort's synthesized error");
  assert.ok(!/Stopped before/.test(settled.resultPreview ?? ""), "final preview is the real output, not the abort placeholder");
});

check("codex: a second user_message inside one task_started turn joins it (review fix 5)", () => {
  const normalizer = new CodexRolloutNormalizer({ taskId: "task-1", sourceId: "codex:s1" });
  const turnId = "019f0000-e0e0-7000-8000-0000000000e0";
  const upserts = [];
  const lines = [
    JSON.stringify({ timestamp: "2026-07-06T10:00:00.000Z", type: "event_msg", payload: { type: "task_started", turn_id: turnId } }),
    JSON.stringify({ timestamp: "2026-07-06T10:00:01.000Z", type: "event_msg", payload: { type: "user_message", message: "first" } }),
    JSON.stringify({ timestamp: "2026-07-06T10:00:02.000Z", type: "event_msg", payload: { type: "user_message", message: "second" } }),
  ];
  for (const line of lines) {
    upserts.push(...normalizer.consumeLine(line));
  }
  const users = upserts.filter((b) => b.kind === "user-message");
  assert.equal(users.length, 2);
  assert.equal(users[0].turnKey, turnId);
  assert.equal(users[1].turnKey, turnId, "second prompt joins the turn — no unanchorable synthetic fork");
});

check("codex: review finding with an unbalanced ``` fence is contained (review fix 8)", () => {
  const normalizer = new CodexRolloutNormalizer({ taskId: "task-1", sourceId: "codex:s1" });
  const upserts = [];
  const lines = [
    JSON.stringify({ timestamp: "2026-07-06T10:00:00.000Z", type: "event_msg", payload: { type: "task_started", turn_id: "019f0000-f0f0-7000-8000-0000000000f0" } }),
    JSON.stringify({ timestamp: "2026-07-06T10:00:01.000Z", type: "event_msg", payload: { type: "user_message", message: "/review" } }),
    JSON.stringify({
      timestamp: "2026-07-06T10:00:20.000Z",
      type: "event_msg",
      payload: {
        type: "exited_review_mode",
        review_output: {
          findings: [
            { title: "Bad fence", body: "Here is code:\n```js\nconst x = 1;", confidence_score: 0.5, priority: 1, code_location: { absolute_file_path: "/tmp/a.ts", line_range: { start: 1, end: 1 } } },
            { title: "Second finding", body: "This must NOT be swallowed into the code block above.", confidence_score: 0.9, priority: 0, code_location: { absolute_file_path: "/tmp/b.ts", line_range: { start: 2, end: 2 } } },
          ],
          overall_correctness: "incorrect",
          overall_explanation: "two findings",
        },
      },
    }),
  ];
  for (const line of lines) {
    upserts.push(...normalizer.consumeLine(line));
  }
  const review = upserts.find((b) => b.kind === "assistant-text");
  const fenceCount = (review.markdown.match(/```/g) ?? []).length;
  assert.equal(fenceCount % 2, 0, "fences are balanced — later findings not swallowed");
  assert.ok(review.markdown.includes("Second finding"), "the second finding survives as its own heading");
});

check("codex: rollback note reads payload.num_turns by name (review fix 9)", () => {
  const normalizer = new CodexRolloutNormalizer({ taskId: "task-1", sourceId: "codex:s1" });
  const upserts = [];
  const lines = [
    JSON.stringify({ timestamp: "2026-07-05T10:00:00.000Z", type: "event_msg", payload: { type: "task_started", turn_id: "019f0000-9090-7000-8000-000000000090" } }),
    JSON.stringify({ timestamp: "2026-07-05T10:00:01.000Z", type: "event_msg", payload: { type: "user_message", message: "x" } }),
    // The real 0.142.5 field is `num_turns`; a rename would fall back to the
    // generic note and this assertion would catch it.
    JSON.stringify({ timestamp: "2026-07-05T10:00:02.000Z", type: "event_msg", payload: { type: "thread_rolled_back", num_turns: 3 } }),
  ];
  for (const line of lines) {
    upserts.push(...normalizer.consumeLine(line));
  }
  const note = upserts.filter((b) => b.kind === "system-note").pop();
  assert.ok(note.text.includes("3"), "the exact num_turns count renders");
  assert.ok(/turns were undone/.test(note.text), "plural form for >1");
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
