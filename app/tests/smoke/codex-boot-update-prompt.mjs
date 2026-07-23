import assert from "node:assert/strict";
import { createRequire } from "node:module";

// Codex boot "Update available!" gate surfacing (consolidation S4, fix 4). When
// codex's boot update gate blocks composer readiness, Sonata must surface a
// passive needs-attention banner and NEVER auto-answer it (running `brew upgrade`
// or pressing keys blind is the user's call). Two levels:
//   - isCodexUpdatePrompt: the pure gate-signature detector (product-side, with
//     the S3 rider tightening the weak `releases/latest` disjunct).
//   - TerminalHost boot watchdog: update-prompt tail → one detection event, and
//     ZERO bytes written to the pty.
const require = createRequire(import.meta.url);
const { TerminalHost, isCodexUpdatePrompt } = require("../../dist/runtime");

const failures = [];

// ── isCodexUpdatePrompt: signature specificity ──────────────────────────────
await check("isCodexUpdatePrompt: strong anchors match the boot gate", () => {
  assert.equal(isCodexUpdatePrompt("Update available! 1. Update now 2. Not now"), true);
  assert.equal(isCodexUpdatePrompt("╭─ Update available! ─╮ Press enter to continue"), true);
  assert.equal(isCodexUpdatePrompt("1. Update now (runs brew upgrade --cask codex)"), true);
});

await check("isCodexUpdatePrompt: bare release-note prose does NOT masquerade as the gate", () => {
  // The weak `releases/latest` fragment alone (a URL that can appear in prose)
  // must not trip the detector — the S3 rider requires an update cue too.
  assert.equal(
    isCodexUpdatePrompt("See https://github.com/openai/codex/releases/latest for the changelog"),
    false,
    "a lone releases/latest URL is not the gate",
  );
  // With an update cue co-occurring, it counts.
  assert.equal(
    isCodexUpdatePrompt("Update: https://github.com/openai/codex/releases/latest"),
    true,
    "releases/latest + an update cue is the gate",
  );
  assert.equal(isCodexUpdatePrompt(""), false, "empty text is never the gate");
  assert.equal(isCodexUpdatePrompt("❯ ready — nothing to update here"), false);
});

// ── TerminalHost boot watchdog: surface, never auto-answer ──────────────────
function fakePty(writes) {
  return {
    pid: 0,
    write: (data) => writes.push(data),
    kill() {},
    resize() {},
    onData() {},
    onExit() {},
  };
}

function makeCodexHost(events) {
  return new TerminalHost({
    taskId: "codex-boot-update-smoke",
    provider: "codex",
    defaultWorkspace: process.cwd(),
    eventSink: (event) => events.push(event),
  });
}

await check("boot watchdog: an update-prompt tail surfaces needs-attention with NO bytes written", () => {
  const writes = [];
  const events = [];
  const host = makeCodexHost(events);
  try {
    host.ptyProcess = fakePty(writes);
    // The pty tail shows codex's boot gate; the composer never came up.
    host.rawTail = "Update available! A new version of codex is out. 1. Update now 2. Not now";
    host.checkCodexBootUpdatePrompt();

    const detected = events.filter((e) => e.type === "codex-update-prompt:detected");
    assert.equal(detected.length, 1, "exactly one codex-update-prompt:detected emitted");
    assert.equal(detected[0].payload.taskId, "codex-boot-update-smoke");
    assert.equal(writes.length, 0, "RED LINE: the watchdog writes NO keys to the pty");
  } finally {
    host.dispose();
  }
});

await check("boot watchdog: a ready composer never surfaces the banner", () => {
  const writes = [];
  const events = [];
  const host = makeCodexHost(events);
  try {
    host.ptyProcess = fakePty(writes);
    // No gate signature — a normal (if bare) tail. Even if stale update text
    // lingered, the acceptsPromptInput guard would suppress it; here there is no
    // signature at all, so nothing is surfaced.
    host.rawTail = "❯ Working on it…";
    host.checkCodexBootUpdatePrompt();
    assert.equal(
      events.filter((e) => e.type === "codex-update-prompt:detected").length,
      0,
      "no banner without the gate signature",
    );
    assert.equal(writes.length, 0, "still no bytes written");
  } finally {
    host.dispose();
  }
});

if (failures.length > 0) {
  process.exitCode = 1;
}
console.log(
  JSON.stringify({ smoke: "codex-boot-update-prompt", success: failures.length === 0 }, null, 2),
);

async function check(name, fn) {
  try {
    await fn();
    console.log(`ok   ${name}`);
  } catch (error) {
    failures.push(name);
    console.error(`FAIL ${name}`);
    console.error(error);
  }
}
