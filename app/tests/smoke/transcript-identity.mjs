// Transcript identity — ownership over inference (2026-07-03).
//
// The cross-session bleed: two fresh Claude sessions in the SAME cwd, both in
// discovery, neither having claimed a file yet. The locator's mtime fallback
// let task B adopt task A's freshest jsonl, persistTranscriptSources anchored
// the wrong identity permanently, and B's Reading column rendered A's replies.
// The Terminal never bled because PTY streams carry their identity from spawn.
//
// The fix, verified here mechanism-by-mechanism:
//   1. Fresh Claude spawns pin a session id (--session-id) and get NO mtime
//      fallback — the locator either finds the pinned file or returns null.
//   2. The hook handshake (adoptSource) binds by identity from the CLI's own
//      hook payload (session_id + transcript_path, routed per task) — it is
//      the safety net that replaced the fallback, and it also follows a
//      session id changing under a live PTY (/clear, native /resume).
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const {
  ProviderTranscript,
  claudeProjectSlug,
  locateSessionFile,
} = require("../../dist/runtime/provider-transcript/index");

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "sonata-transcript-identity-"));
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

function makeCwdWithSibling(label) {
  const projectsDir = path.join(tempRoot, `projects-${label}`);
  const cwd = path.join(tempRoot, `workspace-${label}`);
  fs.mkdirSync(cwd, { recursive: true });
  const slugDir = path.join(projectsDir, claudeProjectSlug(cwd));
  fs.mkdirSync(slugDir, { recursive: true });
  const siblingId = "aaaaaaaa-1111-2222-3333-444444444444";
  const siblingPath = path.join(slugDir, `${siblingId}.jsonl`);
  fs.writeFileSync(
    siblingPath,
    `${JSON.stringify({ type: "user", cwd, sessionId: siblingId, message: { role: "user", content: "SIBLING_REPLY" } })}\n`,
  );
  return { projectsDir, cwd, slugDir, siblingId, siblingPath };
}

// --- 1. The race, demonstrated then closed ------------------------------------

check("mechanism demo: with mtime fallback ON, a pinned fresh spawn adopts the sibling's file", () => {
  const { projectsDir, cwd, siblingPath } = makeCwdWithSibling("demo");
  // Task B is pinned to an id whose file does not exist yet (its own session
  // hasn't written a line). Fallback ON = the pre-fix behavior.
  const adopted = locateSessionFile({
    provider: "claude",
    providerCwd: cwd,
    notBefore: new Date(Date.now() - 60_000).toISOString(),
    claudeProjectsDir: projectsDir,
    expectedSessionId: "bbbbbbbb-5555-6666-7777-888888888888",
    allowMtimeFallback: true,
  });
  // This IS the bug: the sibling's transcript, adopted by the wrong task.
  assert.equal(adopted?.path, siblingPath, "fallback ON adopts the sibling — the demonstrated race");
});

check("race closed: fallback OFF returns null until the pinned file exists, then binds it exactly", () => {
  const { projectsDir, cwd, slugDir } = makeCwdWithSibling("closed");
  const pinnedId = "bbbbbbbb-5555-6666-7777-888888888888";
  const base = {
    provider: "claude",
    providerCwd: cwd,
    notBefore: new Date(Date.now() - 60_000).toISOString(),
    claudeProjectsDir: projectsDir,
    expectedSessionId: pinnedId,
    allowMtimeFallback: false,
  };

  // Sibling is the only (and freshest) file → must refuse, not guess.
  assert.equal(locateSessionFile(base), null, "no pinned file yet → null, never the sibling");

  // The pinned session writes its file — OLDER mtime than the sibling to
  // prove identity beats recency.
  const pinnedPath = path.join(slugDir, `${pinnedId}.jsonl`);
  fs.writeFileSync(
    pinnedPath,
    `${JSON.stringify({ type: "user", cwd, sessionId: pinnedId, message: { role: "user", content: "OUR_REPLY" } })}\n`,
  );
  const old = new Date(Date.now() - 30_000);
  fs.utimesSync(pinnedPath, old, old);

  assert.equal(locateSessionFile(base)?.path, pinnedPath, "pinned file binds by identity");
});

// --- 2. The hook handshake ------------------------------------------------------

await checkAsync(
  "hook handshake: adoptSource binds the CLI-named file, ignores the fresher sibling, and is idempotent",
  async () => {
    const { projectsDir, cwd, slugDir } = makeCwdWithSibling("handshake");
    // Simulates /clear drift: the spawn-pinned id never appears on disk; the
    // session actually writes under a NEW id that only hooks can name.
    const driftedId = "cccccccc-9999-aaaa-bbbb-dddddddddddd";
    const driftedPath = path.join(slugDir, `${driftedId}.jsonl`);
    fs.writeFileSync(
      driftedPath,
      [
        JSON.stringify({
          type: "user",
          uuid: "u1",
          cwd,
          timestamp: new Date().toISOString(),
          message: { role: "user", content: "Ship the fix" },
        }),
        JSON.stringify({
          type: "assistant",
          uuid: "a1",
          cwd,
          timestamp: new Date().toISOString(),
          message: { role: "assistant", content: [{ type: "text", text: "HANDSHAKE_REPLY" }] },
        }),
        "",
      ].join("\n"),
    );

    const events = [];
    const transcript = new ProviderTranscript({
      taskId: "task-ours",
      provider: "claude",
      providerCwd: cwd,
      eventSink: (event) => events.push(event),
      resolveRunId: () => null,
      locate: (options) => locateSessionFile({ ...options, claudeProjectsDir: projectsDir }),
      expectedSessionId: "eeeeeeee-0000-1111-2222-333333333333",
      allowMtimeFallback: false,
      pollMs: 50,
    });

    try {
      // Discovery alone finds nothing: the pinned id has no file and the
      // fallback is off — the sibling stays untouched.
      transcript.startDiscovery(new Date(Date.now() - 5_000).toISOString());
      await new Promise((resolve) => setTimeout(resolve, 200));
      assert.equal(transcript.sources().length, 0, "no source before the handshake");

      // First hook payload arrives (task-scoped by the hook sink) naming the
      // real session — adopt by identity.
      const hookRef = {
        sourceId: `claude:${driftedId}`,
        provider: "claude",
        format: "claude-session-jsonl",
        path: driftedPath,
        providerSessionId: driftedId,
        locatedAt: new Date().toISOString(),
      };
      transcript.adoptSource(hookRef);
      // Hooks fire per tool call — adoption must be idempotent.
      transcript.adoptSource(hookRef);
      transcript.adoptSource({ ...hookRef, sourceId: "claude:same-path-different-id" });

      await new Promise((resolve) => setTimeout(resolve, 300));

      const sources = transcript.sources();
      assert.equal(sources.length, 1, "exactly one adopted source");
      assert.equal(sources[0].providerSessionId, driftedId);

      const located = events.filter((event) => event.type === "transcript:located");
      assert.equal(located.length, 1, "one located event");
      assert.equal(located[0].payload.taskId, "task-ours");
      assert.equal(located[0].payload.source.path, driftedPath);

      const blockText = JSON.stringify(transcript.blocks());
      assert.ok(blockText.includes("HANDSHAKE_REPLY"), "our reply rendered");
      assert.ok(!blockText.includes("SIBLING_REPLY"), "the sibling's reply never bleeds in");
    } finally {
      transcript.dispose();
    }
  },
);

fs.rmSync(tempRoot, { recursive: true, force: true });

if (failures.length > 0) {
  console.error(`\n${failures.length} transcript-identity check(s) failed.`);
  process.exitCode = 1;
} else {
  console.log("\ntranscript-identity checks passed.");
}
