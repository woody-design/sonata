// Transcript contract fence — pins the FROZEN `transcript:blocks` semantics an
// external consumer (the e-ink daemon) depends on. Contract document of record:
//   Product/sonata-eink/docs/contracts-v2.md, Part A (FROZEN 2026-07-07).
// Derivation & evidence: Product/sonata-eink/docs/s1-audit-report.md (Q1, file:line).
// Program plan / invariant anchors: the 2026-07-07 S1 local-api hardening
//   plan (Slice A).
//
// This suite exists so any future refactor that silently changes these
// semantics fails loudly in CI, with a check name that points at the broken
// contract clause. Each check name reads as a contract clause (e.g. "A1.1:
// claude tool-call resolve retains id AND seq"). If a fence here goes red, the
// question is "did the contract change?", not "is the test flaky?".
//
// Five frozen invariants, each anchored to source in the plan file:
//   INV-1 (A1) upsert retains id AND seq — replace-by-id; seq is a stable
//              position, NOT a version counter (audit A1.3 correction).
//   INV-2 (A2) reset is source-scoped and fires on exactly two triggers
//              (attach full-drain, truncation/replacement); chunk 0 only.
//   INV-3 (A3) codex user-first→task_started re-keys the SAME block id; once a
//              content block lands, a later task_started opens a NEW turn.
//   INV-4 (A4) the resolveRunId anchor carries promptId === turnKey for
//              identity-keyed turns, null for synthetic `turn-N` turns.
//   INV-5 (A5) folding the emitted stream consumer-style ≡ blocks() (the
//              sessionSnapshot source); a fresh re-parse yields identical ids.

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
} = require("../../dist/runtime/provider-transcript/index");
// The REFERENCE consumer reducer — the same source-scoped reset + replace-by-id
// fold the renderer uses. INV-5's "snapshot ≡ replay" is proven against it.
const { applyTranscriptUpserts } = require("../../dist/reading-core/state");

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "sonata-transcript-contract-fence-"));
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

async function checkAsync(name, fn) {
  try {
    await fn();
    console.log(`ok   ${name}`);
  } catch (error) {
    failures.push(name);
    console.error(`FAIL ${name}`);
    console.error(error);
  }
}

const line = (record) => JSON.stringify(record);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function claudeRef(filePath, sourceId) {
  return {
    sourceId,
    provider: "claude",
    format: "claude-session-jsonl",
    path: filePath,
    providerSessionId: null,
    locatedAt: new Date().toISOString(),
  };
}

function codexRef(filePath, sourceId) {
  return {
    sourceId,
    provider: "codex",
    format: "codex-rollout-jsonl",
    path: filePath,
    providerSessionId: null,
    locatedAt: new Date().toISOString(),
  };
}

function writeFile(name, lines) {
  const filePath = path.join(tempRoot, name);
  fs.writeFileSync(filePath, lines.map((l) => (typeof l === "string" ? l : line(l))).join("\n") + "\n");
  return filePath;
}

// ===========================================================================
// INV-1 — upsert retains id AND seq (replace-by-id; seq is a POSITION, not a
// version). The load-bearing clause is the seq equality: the audit (A1.3)
// corrected the contract's "same id, higher seq" to "same id, SAME seq".
// Every mutation path spreads the prior block, so both id and seq survive.
// ===========================================================================

check("A1.1: claude tool-call resolve retains id AND seq (running → ok)", () => {
  const normalizer = new ClaudeSessionNormalizer({ taskId: "t", sourceId: "claude:a11" });
  const upserts = [];
  for (const l of [
    { type: "user", uuid: "u1", promptId: "p1", timestamp: "2026-06-09T10:00:00.000Z", message: { role: "user", content: "run it" } },
    { type: "assistant", uuid: "a1", promptId: "p1", timestamp: "2026-06-09T10:00:02.000Z", message: { role: "assistant", content: [{ type: "tool_use", id: "toolu_1", name: "Bash", input: { command: "ls -la", description: "List" } }] } },
    { type: "user", uuid: "u2", promptId: "p1", timestamp: "2026-06-09T10:00:05.500Z", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "file-a\nfile-b", is_error: false }] } },
  ]) {
    upserts.push(...normalizer.consumeLine(line(l)));
  }
  const tools = upserts.filter((b) => b.kind === "tool-call");
  assert.equal(tools.length, 2, "one running emission, one resolved");
  const [running, resolved] = tools;
  assert.equal(running.status, "running");
  assert.equal(resolved.status, "ok", "the resolve is a REAL mutation, not a no-op");
  assert.equal(resolved.id, running.id, "same block id across the upsert");
  assert.equal(resolved.seq, running.seq, "seq is a stable POSITION — NOT bumped by the resolve");
});

check("A1.2: claude plan (TodoWrite) upsert retains id AND seq across turns", () => {
  const normalizer = new ClaudeSessionNormalizer({ taskId: "t", sourceId: "claude:a12" });
  const todos = (a, b) => ({ type: "assistant", uuid: `a-${a}${b}`, promptId: "p1", timestamp: "2026-06-11T10:00:02.000Z", message: { role: "assistant", content: [{ type: "tool_use", id: `toolu_${a}`, name: "TodoWrite", input: { todos: [{ content: "One", activeForm: "Doing one", status: a }, { content: "Two", activeForm: "Doing two", status: b }] } }] } });
  const upserts = [];
  for (const l of [
    { type: "user", uuid: "u1", promptId: "p1", timestamp: "2026-06-11T10:00:00.000Z", message: { role: "user", content: "plan" } },
    todos("in_progress", "pending"),
    todos("completed", "in_progress"),
  ]) {
    upserts.push(...normalizer.consumeLine(line(l)));
  }
  const plans = upserts.filter((b) => b.kind === "plan");
  assert.equal(plans.length, 2, "both TodoWrite calls upsert the plan");
  assert.equal(new Set(plans.map((b) => b.id)).size, 1, "one plan block id per turn");
  assert.equal(plans[0].seq, plans[1].seq, "seq stable across the plan mutation");
  assert.notDeepEqual(plans[0].items.map((i) => i.status), plans[1].items.map((i) => i.status), "a REAL mutation");
});

check("A1.3: claude TaskCreate/TaskUpdate plan upsert retains id AND seq", () => {
  const normalizer = new ClaudeSessionNormalizer({ taskId: "t", sourceId: "claude:a13" });
  const use = (id, name, input, t) => ({ type: "assistant", uuid: `a-${id}`, promptId: "p1", timestamp: t, message: { role: "assistant", content: [{ type: "tool_use", id, name, input }] } });
  const res = (id, content, t) => ({ type: "user", uuid: `u-${id}`, promptId: "p1", timestamp: t, message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content }] } });
  const upserts = [];
  for (const l of [
    { type: "user", uuid: "u1", promptId: "p1", timestamp: "2026-06-11T10:00:00.000Z", message: { role: "user", content: "plan and read" } },
    use("c1", "TaskCreate", { subject: "Read a", description: "d", activeForm: "Reading a" }, "2026-06-11T10:00:02.000Z"),
    res("c1", "Task #1 created successfully: Read a", "2026-06-11T10:00:02.100Z"),
    use("s1", "TaskUpdate", { taskId: "1", status: "in_progress" }, "2026-06-11T10:00:03.000Z"),
    res("s1", "Updated task #1 status", "2026-06-11T10:00:03.100Z"),
    use("s2", "TaskUpdate", { taskId: "1", status: "completed" }, "2026-06-11T10:00:05.000Z"),
    res("s2", "Updated task #1 status", "2026-06-11T10:00:05.100Z"),
  ]) {
    upserts.push(...normalizer.consumeLine(line(l)));
  }
  const plans = upserts.filter((b) => b.kind === "plan");
  assert.ok(plans.length >= 3, "each create/update upserts the plan");
  assert.equal(new Set(plans.map((b) => b.id)).size, 1, "one plan block id per turn");
  assert.equal(new Set(plans.map((b) => b.seq)).size, 1, "every upsert keeps the SAME seq");
  assert.notDeepEqual(
    plans[0].items.map((i) => [i.text, i.status]),
    plans[plans.length - 1].items.map((i) => [i.text, i.status]),
    "a REAL mutation — plan contents changed, not stale contents re-emitted under a stable id/seq",
  );
});

check("A1.4: claude agents roster spawn → settle retains id AND seq", () => {
  const normalizer = new ClaudeSessionNormalizer({ taskId: "t", sourceId: "claude:a14" });
  const upserts = [];
  for (const l of [
    { type: "user", uuid: "u1", promptId: "p1", promptSource: "typed", timestamp: "2026-06-17T10:00:00.000Z", message: { role: "user", content: "research it" } },
    { type: "assistant", uuid: "a1", promptId: "p1", timestamp: "2026-06-17T10:00:02.000Z", message: { role: "assistant", content: [{ type: "tool_use", id: "toolu_A", name: "Agent", input: { description: "Research facts", subagent_type: "general-purpose", prompt: "…" } }] } },
    { type: "user", uuid: "u2", promptId: "p1", timestamp: "2026-06-17T10:00:02.300Z", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_A", content: "Async agent launched successfully.\nagentId: a3833de70ddc9449d (internal ID - do not mention)" }] } },
    { type: "user", uuid: "u3", promptSource: "system", timestamp: "2026-06-17T10:04:00.000Z", message: { role: "user", content: "<task-notification>\n<task-id>a3833de70ddc9449d</task-id>\n<status>completed</status>\n<summary>Agent \"Research facts\" came to rest</summary>\n<usage><duration_ms>284740</duration_ms></usage>\n</task-notification>" } },
  ]) {
    upserts.push(...normalizer.consumeLine(line(l)));
  }
  const rosters = upserts.filter((b) => b.kind === "agents");
  assert.ok(rosters.length >= 2, "spawn + settle each upsert the roster");
  assert.equal(new Set(rosters.map((b) => b.id)).size, 1, "one roster block id per turn");
  assert.equal(rosters[0].seq, rosters[rosters.length - 1].seq, "seq stable across the settle");
  assert.equal(rosters[0].items[0].status, "running", "spawn snapshot: running");
  assert.equal(rosters[rosters.length - 1].items[0].status, "done", "settle: a REAL mutation to done");
});

check("A1.5: codex tool output resolve retains id AND seq (running → error)", () => {
  const normalizer = new CodexRolloutNormalizer({ taskId: "t", sourceId: "codex:a15" });
  const turnId = "019f36e2-1111-7000-8000-000000000015";
  const upserts = [];
  for (const l of [
    { timestamp: "2026-07-06T10:00:00.500Z", type: "event_msg", payload: { type: "task_started", turn_id: turnId } },
    { timestamp: "2026-07-06T10:00:01.000Z", type: "event_msg", payload: { type: "user_message", message: "fix it" } },
    { timestamp: "2026-07-06T10:00:03.000Z", type: "response_item", payload: { type: "function_call", name: "exec_command", call_id: "call-1", arguments: line({ cmd: "npm test" }) } },
    { timestamp: "2026-07-06T10:00:09.000Z", type: "response_item", payload: { type: "function_call_output", call_id: "call-1", output: "Process exited with code 1" } },
  ]) {
    upserts.push(...normalizer.consumeLine(line(l)));
  }
  const tools = upserts.filter((b) => b.kind === "tool-call");
  assert.equal(tools.length, 2, "one running emission, one resolved");
  assert.equal(tools[0].status, "running");
  assert.equal(tools[1].status, "error", "a REAL mutation off exit-code");
  assert.equal(tools[1].id, tools[0].id, "same block id across the upsert");
  assert.equal(tools[1].seq, tools[0].seq, "seq is a stable POSITION");
});

check("A1.6: codex plan (update_plan) upsert retains id AND seq", () => {
  const normalizer = new CodexRolloutNormalizer({ taskId: "t", sourceId: "codex:a16" });
  const plan = (s1, s2) => ({ type: "response_item", payload: { type: "function_call", name: "update_plan", call_id: `plan-${s1}`, arguments: line({ plan: [{ step: "one", status: s1 }, { step: "two", status: s2 }] }) } });
  const upserts = [];
  for (const l of [
    { timestamp: "2026-06-11T10:00:00.000Z", type: "event_msg", payload: { type: "task_started", turn_id: "019f0000-1616-7000-8000-000000000016" } },
    { timestamp: "2026-06-11T10:00:01.000Z", type: "event_msg", payload: { type: "user_message", message: "plan" } },
    { timestamp: "2026-06-11T10:00:02.000Z", ...plan("in_progress", "pending") },
    { timestamp: "2026-06-11T10:00:09.000Z", ...plan("completed", "in_progress") },
  ]) {
    upserts.push(...normalizer.consumeLine(line(l)));
  }
  const plans = upserts.filter((b) => b.kind === "plan");
  assert.equal(plans.length, 2, "both update_plan calls upsert");
  assert.equal(new Set(plans.map((b) => b.id)).size, 1, "one plan block id per turn");
  assert.equal(plans[0].seq, plans[1].seq, "seq stable across the plan mutation");
  assert.notDeepEqual(
    plans[0].items.map((i) => i.status),
    plans[1].items.map((i) => i.status),
    "a REAL mutation — plan statuses changed, not stale contents re-emitted under a stable id/seq",
  );
});

check("A1.7: codex abort-then-late-output supersede retains id AND seq (running → error → ok)", () => {
  const normalizer = new CodexRolloutNormalizer({ taskId: "t", sourceId: "codex:a17" });
  const turnId = "019f0000-1717-7000-8000-000000000017";
  const emissions = [];
  for (const l of [
    { timestamp: "2026-07-06T10:00:00.000Z", type: "event_msg", payload: { type: "task_started", turn_id: turnId } },
    { timestamp: "2026-07-06T10:00:01.000Z", type: "event_msg", payload: { type: "user_message", message: "run" } },
    { timestamp: "2026-07-06T10:00:02.000Z", type: "response_item", payload: { type: "function_call", name: "exec_command", call_id: "call-late", arguments: line({ cmd: "make" }) } },
    // JSONL order: call → abort (synthesizes error) → the real output lands after.
    { timestamp: "2026-07-06T10:00:05.000Z", type: "event_msg", payload: { type: "turn_aborted", reason: "interrupted", turn_id: turnId, completed_at: 0, duration_ms: 0 } },
    { timestamp: "2026-07-06T10:00:06.000Z", type: "response_item", payload: { type: "function_call_output", call_id: "call-late", output: "Process exited with code 0" } },
  ]) {
    emissions.push(...normalizer.consumeLine(line(l)));
  }
  const tools = emissions.filter((b) => b.kind === "tool-call" && b.callId === "call-late");
  assert.equal(tools.length, 3, "running, abort-synthesized error, then superseding ok");
  assert.deepEqual(tools.map((b) => b.status), ["running", "error", "ok"], "out-of-order truth wins");
  assert.equal(new Set(tools.map((b) => b.id)).size, 1, "one block id across all three states");
  assert.equal(new Set(tools.map((b) => b.seq)).size, 1, "seq is a stable POSITION through the supersede");
});

check("A1.8: codex subagent roster shares the source's seq space — no per-source collision (S6)", () => {
  // The synthesized subagent roster (fed by SubagentStart/Stop HOOKS, not the
  // rollout) shares the conversation sourceId, so its seq MUST come from the SAME
  // per-source counter the normalizer uses — else a file block and a roster block
  // collide on (sourceId, seq), breaking A1.3 (seq = per-source POSITION). Drive a
  // real rollout through ProviderTranscript, feed a subagent hook, and assert
  // every block ON THE SOURCE has a UNIQUE seq.
  const sessionId = "seq-sess";
  const sourceId = `codex:${sessionId}`;
  const turnId = "019f0000-1818-7000-8000-000000000018";
  const filePath = writeFile("a18.jsonl", [
    { timestamp: "2026-07-15T10:00:00.000Z", type: "event_msg", payload: { type: "task_started", turn_id: turnId } },
    { timestamp: "2026-07-15T10:00:01.000Z", type: "event_msg", payload: { type: "user_message", message: "delegate to a subagent", images: [], local_images: [], text_elements: [] } },
    { timestamp: "2026-07-15T10:00:02.000Z", type: "event_msg", payload: { type: "agent_message", message: "on it", phase: "commentary" } },
  ]);
  const transcript = new ProviderTranscript({
    taskId: "t", provider: "codex", providerCwd: tempRoot,
    eventSink: () => {}, resolveRunId: () => null,
  });
  transcript.attachExistingSource(codexRef(filePath, sourceId));
  // Two subagents in the SAME turn: each allocates a fresh source-seq for its
  // first block; the roster then upserts in place, keeping that seq.
  transcript.applySubagentEvent({ hook_event_name: "SubagentStart", session_id: sessionId, agent_id: "ag-1", agent_type: "default", turn_id: turnId }, "2026-07-15T10:00:03.000Z");
  transcript.applySubagentEvent({ hook_event_name: "SubagentStop", session_id: sessionId, agent_id: "ag-1", turn_id: turnId }, "2026-07-15T10:00:05.000Z");
  const blocks = transcript.blocks().filter((b) => b.sourceId === sourceId);
  transcript.dispose();
  assert.ok(blocks.some((b) => b.kind === "agents"), "the subagent roster joined the source's blocks");
  assert.ok(blocks.length >= 3, "file blocks (user, assistant) + the roster block");
  const seqs = blocks.map((b) => b.seq);
  assert.equal(
    new Set(seqs).size,
    seqs.length,
    "per-source seq is UNIQUE across normalizer + hook-synthesized blocks (A1.3)",
  );
});

// ===========================================================================
// INV-2 — reset is SOURCE-SCOPED and fires on exactly two triggers:
//   (a) first emission after attach (full drain), (b) truncation/replacement.
// In a chunked burst only chunk 0 carries reset; every event names its
// sourceId (audit A1.5). Consumer side (source-scoped drop) lives in the
// reducer suite — see reading-runtime-reducer.mjs case 11.
// ===========================================================================

check("A2.1: first emission after attach carries reset AND names its sourceId", () => {
  const filePath = writeFile("a21.jsonl", [
    { type: "user", uuid: "u1", promptId: "p1", timestamp: "2026-06-09T10:00:00.000Z", message: { role: "user", content: "hi" } },
    { type: "assistant", uuid: "a1", promptId: "p1", timestamp: "2026-06-09T10:00:02.000Z", message: { role: "assistant", content: [{ type: "text", text: "hello" }] } },
  ]);
  const events = [];
  const transcript = new ProviderTranscript({
    taskId: "t", provider: "claude", providerCwd: tempRoot,
    eventSink: (e) => events.push(e), resolveRunId: () => null,
  });
  transcript.attachExistingSource(claudeRef(filePath, "claude:a21"));
  transcript.dispose();
  const blocks = events.filter((e) => e.type === "transcript:blocks");
  assert.ok(blocks.length >= 1, "the full drain emitted at least one batch");
  assert.equal(blocks[0].payload.reset, true, "the attach full-drain carries reset:true");
  assert.equal(blocks[0].payload.sourceId, "claude:a21", "every event names its sourceId");
});

await checkAsync("A2.2: truncation/replacement re-fires reset (size < offset code path)", async () => {
  // Drive the tailer deterministically: attach+tail (first drain, reset:true),
  // then OVERWRITE the file shorter so the next poll sees size < offset →
  // onTruncated clears emittedOnce → the next batch is a full re-read reset.
  const filePath = writeFile("a22.jsonl", [
    { type: "user", uuid: "u1", promptId: "p1", timestamp: "2026-06-09T10:00:00.000Z", message: { role: "user", content: "the first, longer session content here" } },
    { type: "assistant", uuid: "a1", promptId: "p1", timestamp: "2026-06-09T10:00:02.000Z", message: { role: "assistant", content: [{ type: "text", text: "reply to the first session" }] } },
  ]);
  const events = [];
  const transcript = new ProviderTranscript({
    taskId: "t", provider: "claude", providerCwd: tempRoot,
    eventSink: (e) => events.push(e), resolveRunId: () => null, pollMs: 20,
  });
  transcript.attachExistingSource(claudeRef(filePath, "claude:a22"), { tail: true });
  const afterAttach = events.filter((e) => e.type === "transcript:blocks").length;
  assert.ok(afterAttach >= 1, "attach drained");
  // A strictly SHORTER replacement file (new session, fewer bytes).
  fs.writeFileSync(filePath, line({ type: "user", uuid: "u9", promptId: "p9", timestamp: "2026-06-09T11:00:00.000Z", message: { role: "user", content: "x" } }) + "\n");
  await sleep(120);
  transcript.dispose();
  const blocks = events.filter((e) => e.type === "transcript:blocks");
  assert.equal(blocks[0].payload.reset, true, "attach batch reset:true");
  const postTruncation = blocks.slice(afterAttach);
  assert.ok(postTruncation.length >= 1, "the truncation produced a fresh batch");
  assert.equal(postTruncation[0].payload.reset, true, "truncation re-fires reset:true");
  assert.ok(blocks.every((e) => e.payload.sourceId === "claude:a22"), "every event names its sourceId");
});

check("A2.3: chunked burst carries reset on chunk 0 ONLY (>250 upserts)", () => {
  // A single drain that produces >250 blocks chunks at EMIT_CHUNK_SIZE(250).
  const records = [];
  for (let i = 0; i < 260; i += 1) {
    records.push({ type: "assistant", uuid: `a${i}`, promptId: "p1", timestamp: "2026-06-09T10:00:02.000Z", message: { role: "assistant", content: [{ type: "text", text: `reply ${i}` }] } });
  }
  const filePath = writeFile("a23.jsonl", records);
  const events = [];
  const transcript = new ProviderTranscript({
    taskId: "t", provider: "claude", providerCwd: tempRoot,
    eventSink: (e) => events.push(e), resolveRunId: () => null,
  });
  transcript.attachExistingSource(claudeRef(filePath, "claude:a23"));
  transcript.dispose();
  const blocks = events.filter((e) => e.type === "transcript:blocks");
  assert.equal(blocks.length, 2, "260 upserts chunk into 250 + 10");
  assert.equal(blocks[0].payload.upserts.length, 250);
  assert.equal(blocks[1].payload.upserts.length, 10);
  assert.equal(blocks[0].payload.reset, true, "chunk 0 carries the reset");
  assert.equal(blocks[1].payload.reset, false, "follow-on chunks must NOT re-reset");
  assert.ok(blocks.every((e) => e.payload.sourceId === "claude:a23"), "every chunk names its sourceId");
});

// ===========================================================================
// INV-3 — codex re-key upsert. A user_message that arrives BEFORE task_started
// opens a synthetic turn; the following task_started re-emits the SAME block id
// re-keyed onto the real turn_id (no prompt/reply split). NEGATIVE: once a
// content block has landed in the turn, a later task_started opens a NEW turn.
// ===========================================================================

check("A3.1: codex user-first turn re-keys the SAME block id onto the real turn_id", () => {
  const normalizer = new CodexRolloutNormalizer({ taskId: "t", sourceId: "codex:a31" });
  const turnId = "019f0000-3131-7000-8000-000000000031";
  const emissions = [];
  for (const l of [
    // Edge ordering: user_message BEFORE task_started.
    { timestamp: "2026-06-20T10:00:00.000Z", type: "event_msg", payload: { type: "user_message", message: "do the thing" } },
    { timestamp: "2026-06-20T10:00:00.500Z", type: "event_msg", payload: { type: "task_started", turn_id: turnId } },
    { timestamp: "2026-06-20T10:00:01.000Z", type: "event_msg", payload: { type: "agent_message", message: "done", phase: "final_answer" } },
  ]) {
    emissions.push(...normalizer.consumeLine(line(l)));
  }
  const users = emissions.filter((b) => b.kind === "user-message");
  assert.equal(users.length, 2, "prompt emitted twice: synthetic, then re-keyed");
  assert.equal(new Set(users.map((b) => b.id)).size, 1, "ONE block id — re-keyed in place, not duplicated");
  assert.match(users[0].turnKey, /^turn-\d+$/, "first emission carried the synthetic key");
  assert.equal(users[1].turnKey, turnId, "re-key lands on the real turn_id");
  const reply = emissions.find((b) => b.kind === "assistant-text");
  assert.equal(reply.turnKey, turnId, "prompt and reply are ONE turn — no split");
});

check("A3.2: codex NEGATIVE — after a content block lands, a later task_started opens a NEW turn", () => {
  const normalizer = new CodexRolloutNormalizer({ taskId: "t", sourceId: "codex:a32" });
  const turnB = "019f0000-3232-7000-8000-000000000032";
  const emissions = [];
  for (const l of [
    // Synthetic user turn, THEN a reply lands (closes the reconciliation window).
    { timestamp: "2026-06-20T10:00:00.000Z", type: "event_msg", payload: { type: "user_message", message: "first prompt" } },
    { timestamp: "2026-06-20T10:00:01.000Z", type: "event_msg", payload: { type: "agent_message", message: "reply to first", phase: "final_answer" } },
    // A later task_started must NOT re-key the earlier prompt — it opens turn B.
    { timestamp: "2026-06-20T10:00:02.000Z", type: "event_msg", payload: { type: "task_started", turn_id: turnB } },
    { timestamp: "2026-06-20T10:00:03.000Z", type: "event_msg", payload: { type: "agent_message", message: "reply to second", phase: "commentary" } },
  ]) {
    emissions.push(...normalizer.consumeLine(line(l)));
  }
  const prompts = emissions.filter((b) => b.kind === "user-message");
  // The load-bearing guard: the prompt must be emitted EXACTLY ONCE. If the
  // `ensureTurn` lastUserBlock clear (codex-normalizer.ts:454-463) were removed,
  // the later task_started would ILLEGALLY re-key the first prompt onto turnB —
  // a second user-message emission the turnKey checks below would miss.
  assert.equal(prompts.length, 1, "the first prompt is emitted exactly once — never re-keyed by the later task_started");
  const firstPrompt = prompts[0];
  assert.match(firstPrompt.turnKey, /^turn-\d+$/, "the first prompt stays on its synthetic key (NOT re-keyed)");
  const replies = emissions.filter((b) => b.kind === "assistant-text");
  assert.equal(replies[0].turnKey, firstPrompt.turnKey, "the first reply belongs to the synthetic turn");
  assert.equal(replies[1].turnKey, turnB, "the second reply opens the NEW task_started turn");
  assert.notEqual(replies[0].turnKey, replies[1].turnKey, "two distinct turns — no fold");
});

// ===========================================================================
// INV-4 — the resolveRunId anchor carries promptId === turnKey for
// identity-keyed turns (claude promptId records, codex task_started turn_id),
// and null for synthetic `turn-N` turns (provider-transcript.ts:318).
// ===========================================================================

function anchorsFor({ provider, ref, filePath, records }) {
  fs.writeFileSync(filePath, records.map((r) => line(r)).join("\n") + "\n");
  const anchors = [];
  const transcript = new ProviderTranscript({
    taskId: "t", provider, providerCwd: tempRoot,
    eventSink: () => {},
    // Recorder: capture every anchor handed to resolution. Return null so the
    // turn stays unattributed and the anchor keeps being offered (harmless).
    resolveRunId: (input) => {
      anchors.push({ text: input.text, promptId: input.promptId });
      return null;
    },
  });
  transcript.attachExistingSource(ref);
  const blocks = transcript.blocks();
  transcript.dispose();
  return { anchors, blocks };
}

check("A4.1: claude identity-keyed turn — anchor promptId === turnKey", () => {
  const filePath = path.join(tempRoot, "a41.jsonl");
  const { anchors, blocks } = anchorsFor({
    provider: "claude",
    ref: claudeRef(filePath, "claude:a41"),
    filePath,
    records: [
      { type: "user", uuid: "u1", promptId: "p1", promptSource: "typed", timestamp: "2026-06-09T10:00:00.000Z", message: { role: "user", content: "identity keyed prompt" } },
      { type: "assistant", uuid: "a1", promptId: "p1", timestamp: "2026-06-09T10:00:02.000Z", message: { role: "assistant", content: [{ type: "text", text: "ok" }] } },
    ],
  });
  const user = blocks.find((b) => b.kind === "user-message");
  assert.equal(user.turnKey, "p1", "turn keyed by the CLI promptId");
  const anchor = anchors.find((a) => a.text === "identity keyed prompt");
  assert.ok(anchor, "the user-message was offered as an anchor");
  assert.equal(anchor.promptId, "p1", "anchor.promptId === turnKey for an identity-keyed turn");
  assert.equal(anchor.promptId, user.turnKey);
});

check("A4.2: codex identity-keyed turn — anchor promptId === turn_id", () => {
  const filePath = path.join(tempRoot, "a42.jsonl");
  const turnId = "019f0000-4242-7000-8000-000000000042";
  const { anchors, blocks } = anchorsFor({
    provider: "codex",
    ref: codexRef(filePath, "codex:a42"),
    filePath,
    records: [
      { timestamp: "2026-07-06T10:00:00.500Z", type: "event_msg", payload: { type: "task_started", turn_id: turnId } },
      { timestamp: "2026-07-06T10:00:01.000Z", type: "event_msg", payload: { type: "user_message", message: "codex identity prompt" } },
      { timestamp: "2026-07-06T10:00:02.000Z", type: "event_msg", payload: { type: "agent_message", message: "ok" } },
    ],
  });
  const user = blocks.find((b) => b.kind === "user-message");
  assert.equal(user.turnKey, turnId, "turn keyed by task_started turn_id");
  const anchor = anchors.find((a) => a.text === "codex identity prompt");
  assert.ok(anchor, "the user-message was offered as an anchor");
  assert.equal(anchor.promptId, turnId, "anchor.promptId === turn_id (the run↔turn bridge)");
  assert.equal(anchor.promptId, user.turnKey);
});

check("A4.3: synthetic turn-N turns anchor with promptId === null (both providers)", () => {
  // Claude legacy user record with no promptId → synthetic turn-N.
  const clFile = path.join(tempRoot, "a43-claude.jsonl");
  const cl = anchorsFor({
    provider: "claude", ref: claudeRef(clFile, "claude:a43"), filePath: clFile,
    records: [
      { type: "user", uuid: "u1", timestamp: "2026-06-09T10:00:00.000Z", message: { role: "user", content: "legacy no-promptId prompt" } },
      { type: "assistant", uuid: "a1", timestamp: "2026-06-09T10:00:02.000Z", message: { role: "assistant", content: [{ type: "text", text: "ok" }] } },
    ],
  });
  const clUser = cl.blocks.find((b) => b.kind === "user-message");
  assert.match(clUser.turnKey, /^turn-\d+$/, "claude legacy → synthetic key");
  const clAnchor = cl.anchors.find((a) => a.text === "legacy no-promptId prompt");
  assert.equal(clAnchor.promptId, null, "claude synthetic turn anchors with null promptId");

  // Codex user_message with no preceding task_started → synthetic turn-N.
  const cxFile = path.join(tempRoot, "a43-codex.jsonl");
  const cx = anchorsFor({
    provider: "codex", ref: codexRef(cxFile, "codex:a43"), filePath: cxFile,
    records: [
      { timestamp: "2026-06-11T10:00:01.000Z", type: "event_msg", payload: { type: "user_message", message: "codex no task_started" } },
      { timestamp: "2026-06-11T10:00:02.000Z", type: "event_msg", payload: { type: "agent_message", message: "ok" } },
    ],
  });
  const cxUser = cx.blocks.find((b) => b.kind === "user-message");
  assert.match(cxUser.turnKey, /^turn-\d+$/, "codex no-task_started → synthetic key");
  const cxAnchor = cx.anchors.find((a) => a.text === "codex no task_started");
  assert.equal(cxAnchor.promptId, null, "codex synthetic turn anchors with null promptId");
});

// ===========================================================================
// INV-5 — snapshot ≡ replay. (a) Folding the emitted transcript:blocks stream
// through the REFERENCE consumer reducer equals ProviderTranscript.blocks()
// (the sessionSnapshot source). (b) A fresh re-parse of the same file yields
// identical blocks (id stability across re-parse), for both providers.
// ===========================================================================

// Fold the emitted event stream the way the reference consumer does: the real
// reducer's source-scoped reset + replace-by-id + first-seen order.
function foldStream(events) {
  const view = { transcriptBlocks: new Map(), transcriptBlockOrder: [] };
  for (const event of events) {
    if (event.type !== "transcript:blocks") continue;
    applyTranscriptUpserts(view, event.payload);
  }
  return view.transcriptBlockOrder.map((id) => view.transcriptBlocks.get(id));
}

async function snapshotEquivalence({ name, provider, refFor, sourceId, filePath, initial, appendLine }) {
  await checkAsync(name, async () => {
    fs.writeFileSync(filePath, initial.map((r) => line(r)).join("\n") + "\n");
    const events = [];
    const transcript = new ProviderTranscript({
      taskId: "t", provider, providerCwd: tempRoot,
      eventSink: (e) => events.push(e), resolveRunId: () => null, pollMs: 20,
    });
    transcript.attachExistingSource(refFor(filePath, sourceId), { tail: true });
    // A second batch across a reset boundary: append the resolving line.
    fs.appendFileSync(filePath, line(appendLine) + "\n");
    await sleep(120);
    transcript.dispose();

    const blockEvents = events.filter((e) => e.type === "transcript:blocks");
    assert.ok(blockEvents.length >= 2, "the fixture produced ≥2 batches (initial + tailed)");
    const folded = foldStream(events);
    assert.deepEqual(
      folded,
      transcript.blocks(),
      "consumer-side fold of the emitted stream ≡ blocks() (the sessionSnapshot source)",
    );
  });
}

await snapshotEquivalence({
  name: "A5.1a: claude — folded event stream ≡ blocks() across attach-reset + append",
  provider: "claude",
  refFor: claudeRef,
  sourceId: "claude:a51",
  filePath: path.join(tempRoot, "a51-claude.jsonl"),
  initial: [
    { type: "user", uuid: "u1", promptId: "p1", timestamp: "2026-06-09T10:00:00.000Z", message: { role: "user", content: "run it" } },
    { type: "assistant", uuid: "a1", promptId: "p1", timestamp: "2026-06-09T10:00:02.000Z", message: { role: "assistant", content: [{ type: "tool_use", id: "toolu_1", name: "Bash", input: { command: "ls", description: "list" } }] } },
  ],
  appendLine: { type: "user", uuid: "u2", promptId: "p1", timestamp: "2026-06-09T10:00:05.000Z", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "file-a", is_error: false }] } },
});

await snapshotEquivalence({
  name: "A5.1b: codex — folded event stream ≡ blocks() across attach-reset + append",
  provider: "codex",
  refFor: codexRef,
  sourceId: "codex:a51",
  filePath: path.join(tempRoot, "a51-codex.jsonl"),
  initial: [
    { timestamp: "2026-07-06T10:00:00.500Z", type: "event_msg", payload: { type: "task_started", turn_id: "019f0000-5151-7000-8000-000000000051" } },
    { timestamp: "2026-07-06T10:00:01.000Z", type: "event_msg", payload: { type: "user_message", message: "run it" } },
    { timestamp: "2026-07-06T10:00:02.000Z", type: "response_item", payload: { type: "function_call", name: "exec_command", call_id: "call-1", arguments: line({ cmd: "make" }) } },
  ],
  appendLine: { timestamp: "2026-07-06T10:00:09.000Z", type: "response_item", payload: { type: "function_call_output", call_id: "call-1", output: "Process exited with code 0" } },
});

// Parse a file once, standalone, through a fresh ProviderTranscript — the
// dormant-snapshot rebuild shape (runtime-controller.ts:706-751).
function parseFile(provider, refFor, filePath, sourceId) {
  const transcript = new ProviderTranscript({
    taskId: "t", provider, providerCwd: tempRoot,
    eventSink: () => {}, resolveRunId: () => null,
  });
  transcript.attachExistingSource(refFor(filePath, sourceId));
  const blocks = transcript.blocks();
  transcript.dispose();
  return blocks;
}

// A5.1c: snapshot ≡ replay across a TRUNCATION-REPLACEMENT (contract A1.5
// trigger b). This is the case A2.2 only checked at the flag level: the reset
// event tells consumers to DROP the source, so blocks() (the sessionSnapshot
// source) must actually drop the stale blocks too. Pre-fix, consumeLines only
// upserted and the normalizer kept accumulating — blocks() retained stale
// content the stream had reset away, and codex re-read ids shifted.
async function truncationEquivalence({ name, provider, refFor, sourceId, first, replacement, checkFreshParse }) {
  await checkAsync(name, async () => {
    const filePath = path.join(tempRoot, `${sourceId.replace(/[:]/g, "-")}-trunc.jsonl`);
    fs.writeFileSync(filePath, first.map((r) => line(r)).join("\n") + "\n");
    const events = [];
    const transcript = new ProviderTranscript({
      taskId: "t", provider, providerCwd: tempRoot,
      eventSink: (e) => events.push(e), resolveRunId: () => null, pollMs: 20,
    });
    transcript.attachExistingSource(refFor(filePath, sourceId), { tail: true });
    const afterAttach = events.filter((e) => e.type === "transcript:blocks").length;
    // A DIFFERENT, strictly SHORTER replacement — size < offset triggers it.
    fs.writeFileSync(filePath, replacement.map((r) => line(r)).join("\n") + "\n");
    await sleep(120);
    transcript.dispose();

    const blockEvents = events.filter((e) => e.type === "transcript:blocks");
    assert.ok(blockEvents.length > afterAttach, "the truncation produced a fresh batch");
    assert.equal(blockEvents[afterAttach].payload.reset, true, "the post-truncation batch carries reset:true");

    // The core INV-5 assertion: fold the WHOLE stream consumer-style (the reset
    // drops the source) and it must equal blocks() — stale blocks gone from both.
    assert.deepEqual(
      foldStream(events),
      transcript.blocks(),
      "consumer fold ≡ blocks() across truncation-replacement (stale blocks dropped from the snapshot source)",
    );
    // blocks() reflects ONLY the replacement content, in replacement-parse order.
    const fresh = parseFile(provider, refFor, filePath, sourceId);
    if (checkFreshParse) {
      // Codex ids are parse-order deterministic — a fresh normalizer after the
      // truncation must mint the SAME ids as a standalone parse of the
      // replacement (proves the normalizer was rebuilt, not left accumulating).
      assert.deepEqual(
        transcript.blocks(),
        fresh,
        "post-truncation blocks() ≡ a fresh parse of the replacement (ids/seq stable — normalizer rebuilt)",
      );
    } else {
      // Claude ids are uuid-derived, so assert the id SET matches (order/runId
      // parity is already covered by the fold≡blocks() check above).
      assert.deepEqual(
        transcript.blocks().map((b) => b.id).sort(),
        fresh.map((b) => b.id).sort(),
        "post-truncation blocks() carry exactly the replacement's block ids — no stale ids linger",
      );
    }
  });
}

await truncationEquivalence({
  name: "A5.1c: claude — snapshot ≡ replay across a truncation-replacement (stale blocks dropped)",
  provider: "claude",
  refFor: claudeRef,
  sourceId: "claude:a51c",
  first: [
    { type: "user", uuid: "u1", promptId: "p1", timestamp: "2026-06-09T10:00:00.000Z", message: { role: "user", content: "the first, longer session that will be replaced" } },
    { type: "assistant", uuid: "a1", promptId: "p1", timestamp: "2026-06-09T10:00:02.000Z", message: { role: "assistant", content: [{ type: "text", text: "reply to the first session" }] } },
  ],
  replacement: [
    { type: "user", uuid: "u9", promptId: "p9", timestamp: "2026-06-09T11:00:00.000Z", message: { role: "user", content: "new short" } },
  ],
});

await truncationEquivalence({
  name: "A5.1c: codex — snapshot ≡ replay across a truncation-replacement (ids stable, normalizer rebuilt)",
  provider: "codex",
  refFor: codexRef,
  sourceId: "codex:a51c",
  checkFreshParse: true,
  first: [
    { timestamp: "2026-07-06T10:00:00.500Z", type: "event_msg", payload: { type: "task_started", turn_id: "019f0000-51c0-7000-8000-0000000051c0" } },
    { timestamp: "2026-07-06T10:00:01.000Z", type: "event_msg", payload: { type: "user_message", message: "the first codex session to be replaced" } },
    { timestamp: "2026-07-06T10:00:02.000Z", type: "event_msg", payload: { type: "agent_message", message: "reply to the first" } },
  ],
  replacement: [
    { timestamp: "2026-07-06T11:00:00.000Z", type: "event_msg", payload: { type: "task_started", turn_id: "019f0000-51c9-7000-8000-0000000051c9" } },
    { timestamp: "2026-07-06T11:00:01.000Z", type: "event_msg", payload: { type: "user_message", message: "new" } },
  ],
});

function reparseBlocks({ provider, refFor, sourceId, records }) {
  const filePath = path.join(tempRoot, `reparse-${sourceId.replace(/[:]/g, "-")}.jsonl`);
  fs.writeFileSync(filePath, records.map((r) => line(r)).join("\n") + "\n");
  const parseOnce = (sid) => {
    const t = new ProviderTranscript({
      taskId: "t", provider, providerCwd: tempRoot,
      eventSink: () => {}, resolveRunId: () => null,
    });
    t.attachExistingSource(refFor(filePath, sid));
    const blocks = t.blocks();
    t.dispose();
    return blocks;
  };
  // Same sourceId both times — a dormant snapshot rebuild re-parses the same
  // file through the same normalizer (runtime-controller.ts:706-751), so ids
  // must be byte-identical between the two parses.
  return [parseOnce(sourceId), parseOnce(sourceId)];
}

check("A5.2a: claude — a fresh re-parse yields identical blocks (id stability)", () => {
  const [first, second] = reparseBlocks({
    provider: "claude", refFor: claudeRef, sourceId: "claude:a52",
    records: [
      { type: "user", uuid: "u1", promptId: "p1", timestamp: "2026-06-09T10:00:00.000Z", message: { role: "user", content: "run" } },
      { type: "assistant", uuid: "a1", promptId: "p1", timestamp: "2026-06-09T10:00:02.000Z", message: { role: "assistant", content: [{ type: "text", text: "reply" }, { type: "tool_use", id: "toolu_1", name: "Bash", input: { command: "ls" } }] } },
      { type: "user", uuid: "u2", promptId: "p1", timestamp: "2026-06-09T10:00:05.000Z", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "out" }] } },
    ],
  });
  assert.ok(first.length >= 3, "re-parse produced blocks");
  assert.deepEqual(second, first, "re-parse is identical — ids stable across snapshot rebuilds");
});

check("A5.2b: codex — a fresh re-parse yields identical blocks (id stability)", () => {
  const [first, second] = reparseBlocks({
    provider: "codex", refFor: codexRef, sourceId: "codex:a52",
    records: [
      { timestamp: "2026-07-06T10:00:00.500Z", type: "event_msg", payload: { type: "task_started", turn_id: "019f0000-5252-7000-8000-000000000052" } },
      { timestamp: "2026-07-06T10:00:01.000Z", type: "event_msg", payload: { type: "user_message", message: "run" } },
      { timestamp: "2026-07-06T10:00:02.000Z", type: "event_msg", payload: { type: "agent_message", message: "reply" } },
      { timestamp: "2026-07-06T10:00:03.000Z", type: "response_item", payload: { type: "function_call", name: "exec_command", call_id: "call-1", arguments: line({ cmd: "make" }) } },
      { timestamp: "2026-07-06T10:00:09.000Z", type: "response_item", payload: { type: "function_call_output", call_id: "call-1", output: "Process exited with code 0" } },
    ],
  });
  assert.ok(first.length >= 3, "re-parse produced blocks");
  assert.deepEqual(second, first, "re-parse is identical — codex parse-order ids stable");
});

fs.rmSync(tempRoot, { recursive: true, force: true });

if (failures.length > 0) {
  console.error(`\n${failures.length} transcript-contract-fence check(s) failed.`);
  process.exit(1);
}
console.log("\ntranscript-contract-fence smoke checks passed.");
