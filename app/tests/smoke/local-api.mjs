import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { LocalApiServer } = require("../../dist/main/local-api/local-api-server");

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "duet-local-api-smoke-"));
const socketPath = path.join(tmpDir, "control.sock");

const submitted = [];
const opened = [];
const fakeIndex = {
  projects: [],
  chats: [
    {
      task: {
        id: "task-1",
        title: "Smoke session",
        provider: "claude",
        status: "idle",
        providerCwd: tmpDir,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
      archived: false,
      live: true,
      liveStatus: "idle",
      lastActivityAt: new Date().toISOString(),
    },
  ],
  lastUsedFolder: null,
};

const server = new LocalApiServer({
  socketPath,
  appVersion: "0.0.0-smoke",
  facade: {
    readSessionIndex: () => fakeIndex,
    readSessionSnapshot: (taskId) => {
      if (taskId !== "task-1") throw new Error(`task not found: ${taskId}`);
      return { task: fakeIndex.chats[0].task, live: true, blocks: [] };
    },
    submitPrompt: (taskId, text) => submitted.push({ taskId, text }),
    openTask: (taskId) => opened.push(taskId),
  },
  log: () => {},
});

await server.start();

const socket = net.connect(socketPath);
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

// hello
const hello = await request("hello", { protocolVersion: 1, client: "smoke" });
assert.equal(hello.result.app, "duet");
assert.equal(hello.result.protocolVersion, 1);

// sessionIndex passes through
const index = await request("sessionIndex", {});
assert.equal(index.result.chats[0].task.id, "task-1");

// snapshot of unknown task → taskNotFound error
const missing = await request("sessionSnapshot", { taskId: "nope" });
assert.equal(missing.error.code, -32001);

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

// openTask resumes
const open = await request("openTask", { taskId: "task-1", commandId: "cmd-3" });
assert.equal(open.result.accepted, true);
assert.deepEqual(opened, ["task-1"]);

// unknown method
const unknown = await request("definitelyNot", {});
assert.equal(unknown.error.code, -32601);

// events broadcast; pty:data is filtered
server.broadcastEvent({ type: "pty:data", ts: "now", payload: { taskId: "task-1", data: "secret" } });
server.broadcastEvent({ type: "task:updated", ts: "now", payload: { taskId: "task-1", task: fakeIndex.chats[0].task } });
await new Promise((resolve) => setTimeout(resolve, 100));
assert.equal(notifications.length, 1);
assert.equal(notifications[0].method, "event");
assert.equal(notifications[0].params.event.type, "task:updated");

// stale socket takeover: stop, leave file behind, start a second instance
socket.destroy();
server.stop();
fs.writeFileSync(socketPath, "");
const second = new LocalApiServer({
  socketPath,
  appVersion: "0.0.0-smoke",
  facade: {
    readSessionIndex: () => fakeIndex,
    readSessionSnapshot: () => ({ task: fakeIndex.chats[0].task, live: true, blocks: [] }),
    submitPrompt: () => {},
    openTask: () => {},
  },
  log: () => {},
});
await second.start();
second.stop();

fs.rmSync(tmpDir, { recursive: true, force: true });
console.log("local-api smoke: ok");
