import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const {
  TerminalHost,
  detectIdleComposerForProvider,
  detectIdlePromptForProvider,
} = require("../../dist/runtime");

const failures = [];

await check("Claude suggestion placeholder is an idle composer prompt", async () => {
  const hint = detectIdlePromptForProvider(claudePlaceholderTail(), "claude");

  assert.equal(hint.ready, true);
  assert.ok(hint.lastPromptIndex >= 0, "expected Claude prompt glyph to be detected");
});

await check("task-ready check self-heals without new PTY data", async () => {
  const events = [];
  const host = new TerminalHost({
    taskId: "task-ready-self-heal-smoke",
    provider: "claude",
    defaultWorkspace: process.cwd(),
    eventSink: (event) => events.push(event),
  });

  host.ptyProcess = fakePty();
  host.startedAt = Date.now() - host.profile.taskReadyMinAgeMs - 1000;
  host.lastPtyDataAt = Date.now() - host.profile.taskReadyQuietMs - 1000;
  host.taskReady = false;
  host.rawTail = "Claude Code\nStarting up without an input composer yet.\n";

  try {
    host.scheduleTaskReadyCheck();
    await delay(host.profile.taskReadyQuietMs + 250);
    assert.equal(events.some((event) => event.type === "task:ready"), false);

    host.rawTail = claudePlaceholderTail();

    await waitUntil(
      () => events.some((event) => event.type === "task:ready"),
      host.profile.taskReadyQuietMs * 2 + 1000,
      "task:ready after a not-ready sample",
    );
    assert.equal(host.isIdleComposerReady(), true);
  } finally {
    host.dispose();
  }
});

await check("Claude welcome screen still does not complete a run", async () => {
  const hint = detectIdleComposerForProvider(claudePlaceholderTail(), "claude");

  assert.equal(hint.completed, false);
});

if (failures.length > 0) {
  process.exitCode = 1;
}

function claudePlaceholderTail() {
  return [
    "Welcome to Claude Code",
    "cwd ~/Workspace/Product/duet",
    '❯ Try "fix typecheck errors"',
    "Opus 4.1 · low · ? for shortcuts",
  ].join("\n");
}

function fakePty() {
  return {
    pid: 0,
    write() {},
    kill() {},
    resize() {},
    onData() {},
    onExit() {},
  };
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitUntil(predicate, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) {
      return true;
    }
    await delay(50);
  }
  throw new Error(`Timed out waiting for ${label}`);
}

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
