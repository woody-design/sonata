import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { LocalApiServer } = require("../../dist/main/local-api/local-api-server");
// The REAL error classes — so the test validates the real contract, not a
// message string written to fit a matcher. TaskNotLiveError is the dormant-but-
// persisted case the server must map to -32002 (distinct from -32001).
const { TaskNotFoundError, TaskNotLiveError } = require("../../dist/main/errors");

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "sonata-local-api-smoke-"));
const socketPath = path.join(tmpDir, "control.sock");

const submitted = [];
const opened = [];
const fakeTask = {
  id: "task-1",
  title: "0714-Smoke session",
  titleOrigin: "automatic",
  provider: "claude",
  status: "idle",
  providerCwd: tmpDir,
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
};
const fakeIndex = {
  projects: [],
  chats: [
    {
      task: fakeTask,
      archived: false,
      live: true,
      liveStatus: "idle",
      lastActivityAt: new Date().toISOString(),
    },
  ],
  lastUsedFolder: null,
};

// Captures the options the server threads into readSessionIndex, so the
// includeArchived pass-through (H3) is observable at the facade boundary.
let lastIndexOptions = "unset";

const server = new LocalApiServer({
  socketPath,
  appVersion: "0.0.0-smoke",
  facade: {
    readSessionIndex: (options) => {
      lastIndexOptions = options;
      return fakeIndex;
    },
    readSessionSnapshot: (taskId) => {
      // Throw the REAL class with the REAL controller message. If the
      // controller ever reverts to a plain Error, withTask's typed
      // check fails and this surfaces as -32000 — caught below.
      if (taskId !== "task-1") {
        throw new TaskNotFoundError("No persisted session matches the requested taskId.");
      }
      return { task: fakeTask, live: true, blocks: [] };
    },
    submitPrompt: (taskId, text) => {
      // The two typed errors the server must map to DISTINCT wire codes:
      // a persisted-but-dormant task (-32002) vs one that never existed
      // (-32001). Throwing the REAL classes proves withTask's mapping, not
      // a message match.
      if (taskId === "dormant-1") {
        throw new TaskNotLiveError(
          "The requested task exists but is not live; open it before submitting.",
        );
      }
      if (taskId === "ghost-1") {
        throw new TaskNotFoundError("No runtime task matches the requested taskId.");
      }
      submitted.push({ taskId, text });
    },
    openTask: (taskId) => opened.push(taskId),
  },
  log: () => {},
});

await server.start();

const socket = net.connect(socketPath);
socket.on("error", () => {}); // server may drop us on shutdown
socket.setEncoding("utf8");
let buffer = "";
const pending = [];
const notifications = [];
socket.on("data", (chunk) => {
  buffer += chunk;
  let idx;
  while ((idx = buffer.indexOf("\n")) !== -1) {
    const line = buffer.slice(0, idx);
    buffer = buffer.slice(idx + 1);
    if (!line.trim()) continue;
    const frame = JSON.parse(line);
    if (typeof frame.id === "number") {
      pending.shift()?.(frame);
    } else {
      notifications.push(frame);
    }
  }
});
await new Promise((resolve) => socket.once("connect", resolve));

let nextId = 1;
function request(method, params) {
  return new Promise((resolve) => {
    pending.push(resolve);
    socket.write(`${JSON.stringify({ id: nextId++, method, params })}\n`);
  });
}
function rawRequest(frameObject) {
  return new Promise((resolve) => {
    pending.push(resolve);
    socket.write(`${JSON.stringify(frameObject)}\n`);
  });
}

// hello
const hello = await request("hello", { protocolVersion: 1, client: "smoke" });
assert.equal(hello.result.app, "sonata");
assert.equal(hello.result.protocolVersion, 1);

// sessionIndex passes through; absent includeArchived → undefined options
// (today's call shape — the controller then applies its own default).
const index = await request("sessionIndex", {});
assert.equal(index.result.chats[0].task.id, "task-1");
assert.deepEqual(
  [index.result.chats[0].task.title, index.result.chats[0].task.titleOrigin],
  ["0714-Smoke session", "automatic"],
  "sessionIndex preserves the canonical title and ownership",
);
assert.equal(lastIndexOptions, undefined, "absent includeArchived → undefined options");

// sessionIndex with includeArchived:true reaches the facade with the flag (H3).
const archivedIndex = await request("sessionIndex", { includeArchived: true });
assert.equal(archivedIndex.result.chats[0].task.id, "task-1");
assert.deepEqual(lastIndexOptions, { includeArchived: true });

// includeArchived:false is threaded explicitly too — a companion can force the
// default without relying on the absent-param behavior.
const unarchivedIndex = await request("sessionIndex", { includeArchived: false });
assert.equal(unarchivedIndex.result.chats[0].task.id, "task-1");
assert.deepEqual(lastIndexOptions, { includeArchived: false });

const snapshot = await request("sessionSnapshot", { taskId: "task-1" });
assert.deepEqual(
  [snapshot.result.task.title, snapshot.result.task.titleOrigin],
  ["0714-Smoke session", "automatic"],
  "sessionSnapshot preserves the canonical title and ownership",
);

// A malformed includeArchived is rejected (-32602) and never reaches the facade.
lastIndexOptions = "unset";
const badFlag = await request("sessionIndex", { includeArchived: "yes" });
assert.equal(badFlag.error.code, -32602);
assert.equal(lastIndexOptions, "unset", "malformed param never reaches the facade");

// snapshot of unknown task → taskNotFound (-32001) via the typed error
const missing = await request("sessionSnapshot", { taskId: "nope" });
assert.equal(missing.error.code, -32001);
assert.equal(missing.error.message, "No persisted session matches the requested taskId.");

// submitPrompt executes once, dedups on retry with same commandId
const first = await request("submitPrompt", {
  taskId: "task-1",
  text: "hello from the sofa",
  commandId: "cmd-1",
});
assert.equal(first.result.accepted, true);
const retry = await request("submitPrompt", {
  taskId: "task-1",
  text: "hello from the sofa",
  commandId: "cmd-1",
});
assert.equal(retry.result.deduped, true);
assert.equal(submitted.length, 1);

// empty text rejected
const empty = await request("submitPrompt", {
  taskId: "task-1",
  text: "   ",
  commandId: "cmd-2",
});
assert.equal(empty.error.code, -32602);

// submitPrompt on a dormant-but-persisted task → taskNotLive (-32002), the new
// distinct code so a companion can render "open it first" instead of "gone".
const dormant = await request("submitPrompt", {
  taskId: "dormant-1",
  text: "wake up",
  commandId: "cmd-dormant",
});
assert.equal(dormant.error.code, -32002);
assert.equal(
  dormant.error.message,
  "The requested task exists but is not live; open it before submitting.",
);

// submitPrompt on a task that never existed → taskNotFound (-32001), unchanged.
const ghost = await request("submitPrompt", {
  taskId: "ghost-1",
  text: "anyone home",
  commandId: "cmd-ghost",
});
assert.equal(ghost.error.code, -32001);

// Neither error path executed the send.
assert.equal(submitted.length, 1);

// openTask resumes
const open = await request("openTask", { taskId: "task-1", commandId: "cmd-3" });
assert.equal(open.result.accepted, true);
assert.deepEqual(opened, ["task-1"]);

// unknown method → -32601
const unknown = await request("definitelyNot", {});
assert.equal(unknown.error.code, -32601);

// request with a numeric id but a non-string method → -32600, not a hang
const malformed = await rawRequest({ id: 99, method: 42 });
assert.equal(malformed.id, 99);
assert.equal(malformed.error.code, -32600);

// events broadcast; pty:data is filtered
server.broadcastEvent({ type: "pty:data", ts: "now", payload: { taskId: "task-1", data: "secret" } });
server.broadcastEvent({ type: "task:updated", ts: "now", payload: { taskId: "task-1", task: fakeTask } });
await new Promise((resolve) => setTimeout(resolve, 100));
assert.equal(notifications.length, 1);
assert.equal(notifications[0].method, "event");
assert.equal(notifications[0].params.event.type, "task:updated");

// --- defensive paths ---

function waitForClose(sock, label) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label}: not closed in time`)), 5000);
    sock.once("close", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

// Alive-socket refusal: a second server on the same live path must reject.
const rival = new LocalApiServer({
  socketPath,
  appVersion: "0.0.0-smoke",
  facade: {
    readSessionIndex: () => fakeIndex,
    readSessionSnapshot: () => ({ task: fakeTask, live: true, blocks: [] }),
    submitPrompt: () => {},
    openTask: () => {},
  },
  log: () => {},
});
await assert.rejects(() => rival.start(), /already in use/);

// Oversized line: >1MB without a newline → server destroys the connection.
const flooder = net.connect(socketPath);
flooder.on("error", () => {}); // expected: server destroys us
await new Promise((resolve) => flooder.once("connect", resolve));
const floodClosed = waitForClose(flooder, "oversized-line");
flooder.write("x".repeat(1_100_000)); // no newline
await floodClosed;

// Slow consumer: a connection whose outbound buffer is over the cap is
// dropped on the next broadcast, while healthy ones keep receiving.
// Real OS socket buffers (macOS UDS) are too large to saturate
// deterministically, so inject fakes to exercise the exact drop branch.
let healthyGotEvent = false;
let backedUpDestroyed = false;
const healthyFake = {
  writableLength: 0,
  write: () => { healthyGotEvent = true; },
  destroy: () => {},
};
const backedUpFake = {
  writableLength: 5 * 1024 * 1024, // over the 4MB cap
  write: () => {},
  destroy: () => { backedUpDestroyed = true; },
};
server.connections.add(healthyFake);
server.connections.add(backedUpFake);
server.broadcastEvent({ type: "task:updated", ts: "now", payload: { taskId: "task-1" } });
assert.equal(backedUpDestroyed, true, "over-cap connection is destroyed");
assert.equal(healthyGotEvent, true, "healthy connection still receives");
assert.ok(!server.connections.has(backedUpFake), "over-cap connection is removed");
server.connections.delete(healthyFake);

// Stale socket takeover: stop, leave a leftover file, a fresh server binds.
socket.destroy();
server.stop();
fs.writeFileSync(socketPath, "");
const reborn = new LocalApiServer({
  socketPath,
  appVersion: "0.0.0-smoke",
  facade: {
    readSessionIndex: () => fakeIndex,
    readSessionSnapshot: () => ({ task: fakeTask, live: true, blocks: [] }),
    submitPrompt: () => {},
    openTask: () => {},
  },
  log: () => {},
});
await reborn.start();
reborn.stop();

fs.rmSync(tmpDir, { recursive: true, force: true });
console.log("local-api smoke: ok");
