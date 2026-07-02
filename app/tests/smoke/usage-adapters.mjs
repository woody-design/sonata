import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const {
  CODEX_CONTEXT_BASELINE_TOKENS,
  parseClaudeStatuslineJson,
  parseCodexUsageLine,
  usageWindowLabel,
} = require("../../dist/runtime/usage");

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fixtureRoot = path.resolve(__dirname, "../fixtures/usage");

const [codexNormalLine, codexNullInfoLine] = fs
  .readFileSync(path.join(fixtureRoot, "codex-token-count.jsonl"), "utf8")
  .trim()
  .split("\n");

const codexNormal = parseCodexUsageLine(codexNormalLine);
assert.ok(codexNormal, "expected Codex token_count snapshot");
assert.equal(codexNormal.provider, "codex");
assert.equal(codexNormal.context.usedTokens, 18111);
assert.equal(codexNormal.context.windowTokens, 258400);
const effectiveWindow = 258400 - CODEX_CONTEXT_BASELINE_TOKENS;
const effectiveUsed = 18111 - CODEX_CONTEXT_BASELINE_TOKENS;
const expectedCodexRemaining = ((effectiveWindow - effectiveUsed) / effectiveWindow) * 100;
assert.ok(
  Math.abs(codexNormal.context.remainingPercent - expectedCodexRemaining) < 0.0001,
  "Codex context remaining should match the baseline formula",
);
assert.equal(codexNormal.limits[0]?.label, "5h");
assert.equal(codexNormal.limits[0]?.remainingPercent, 71);
assert.equal(codexNormal.limits[1]?.label, "weekly");
assert.equal(codexNormal.limits[1]?.remainingPercent, 40);

const codexNullInfo = parseCodexUsageLine(codexNullInfoLine);
assert.ok(codexNullInfo, "expected Codex rate-limit-only snapshot");
assert.equal(codexNullInfo.context, null);
assert.equal(codexNullInfo.limits[0]?.remainingPercent, 82);
assert.equal(codexNullInfo.limits[1]?.remainingPercent, 77);

const [claudeStartupLine, claudeResponseLine] = fs
  .readFileSync(path.join(fixtureRoot, "claude-statusline.jsonl"), "utf8")
  .trim()
  .split("\n");

assert.equal(
  parseClaudeStatuslineJson(claudeStartupLine),
  null,
  "Claude startup payload has no usable usage data",
);

const claudeResponse = parseClaudeStatuslineJson(claudeResponseLine, { capturedAt: 123456 });
assert.ok(claudeResponse, "expected Claude response statusline snapshot");
assert.equal(claudeResponse.providerSessionId, "32c0e524-be27-422c-82d2-047d66f9e9f7");
assert.equal(claudeResponse.snapshot.provider, "claude");
assert.equal(claudeResponse.snapshot.capturedAt, 123456);
assert.equal(claudeResponse.snapshot.context.usedTokens, 30398);
assert.equal(claudeResponse.snapshot.context.windowTokens, 1000000);
assert.equal(claudeResponse.snapshot.context.remainingPercent, 97);
assert.equal(claudeResponse.snapshot.limits[0]?.label, "5h");
assert.equal(claudeResponse.snapshot.limits[0]?.remainingPercent, 99);
assert.equal(claudeResponse.snapshot.limits[1]?.label, "weekly");
assert.equal(claudeResponse.snapshot.limits[1]?.remainingPercent, 92);

const claudeNoLimits = parseClaudeStatuslineJson(
  fs.readFileSync(path.join(fixtureRoot, "claude-statusline-no-rate-limits.json"), "utf8"),
);
assert.ok(claudeNoLimits, "expected Claude context-only snapshot");
assert.equal(claudeNoLimits.snapshot.context.remainingPercent, 97);
assert.deepEqual(claudeNoLimits.snapshot.limits, []);

assert.equal(parseCodexUsageLine("{not json"), null);
assert.equal(parseClaudeStatuslineJson("{}"), null);
assert.equal(usageWindowLabel(300), "5h");
assert.equal(usageWindowLabel(1440), "daily");
assert.equal(usageWindowLabel(10080), "weekly");
assert.equal(usageWindowLabel(43200), "monthly");

// session_name (slice 5 auto-naming): parsed when present, null when absent.
const namedLine = JSON.stringify({
  session_id: "sess-1",
  session_name: "Plan and read three files then write reflection",
  context_window: {
    used_percentage: 4,
    context_window_size: 1000000,
    current_usage: { input_tokens: 2, output_tokens: 1211, cache_creation_input_tokens: 88, cache_read_input_tokens: 34967 },
  },
});
const named = parseClaudeStatuslineJson(namedLine);
assert.ok(named, "expected named snapshot");
assert.equal(named.snapshot.sessionName, "Plan and read three files then write reflection");

const unnamedLine = JSON.stringify({
  session_id: "sess-2",
  context_window: {
    used_percentage: 4,
    context_window_size: 1000000,
    current_usage: { input_tokens: 2, output_tokens: 1211, cache_creation_input_tokens: 88, cache_read_input_tokens: 34967 },
  },
});
const unnamed = parseClaudeStatuslineJson(unnamedLine);
assert.equal(unnamed.snapshot.sessionName, null);
assert.equal(unnamed.snapshot.costUsd, null, "cost absent → null");

// costUsd (S5 usage-popover widening): parsed when present, robust to junk.
const costLine = JSON.stringify({
  session_id: "sess-3",
  cost: { total_cost_usd: 1.2345, total_duration_ms: 100 },
  context_window: {
    used_percentage: 4,
    context_window_size: 1000000,
    current_usage: { input_tokens: 2, output_tokens: 1211, cache_creation_input_tokens: 88, cache_read_input_tokens: 34967 },
  },
});
assert.equal(parseClaudeStatuslineJson(costLine).snapshot.costUsd, 1.2345);
const junkCostLine = JSON.stringify({
  session_id: "sess-4",
  cost: { total_cost_usd: "oops" },
  context_window: {
    used_percentage: 4,
    context_window_size: 1000000,
    current_usage: { input_tokens: 2, output_tokens: 1211, cache_creation_input_tokens: 88, cache_read_input_tokens: 34967 },
  },
});
assert.equal(parseClaudeStatuslineJson(junkCostLine).snapshot.costUsd, null);

// Cost is an independent signal (review P3): a payload with cost but no
// parseable context/rate-limit fields must still produce a snapshot.
const costOnlyLine = JSON.stringify({
  session_id: "sess-5",
  cost: { total_cost_usd: 0.42 },
});
const costOnly = parseClaudeStatuslineJson(costOnlyLine);
assert.ok(costOnly, "cost-only payload must not be dropped");
assert.equal(costOnly.snapshot.costUsd, 0.42);
assert.equal(costOnly.snapshot.context, null);
assert.deepEqual(costOnly.snapshot.limits, []);

console.log("usage adapter fixtures passed");
