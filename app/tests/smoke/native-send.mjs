// Send is send (subtraction X2): pressing Send writes the prompt to the pty at
// once, exactly as typing into the terminal, and Sonata keeps no delivery state
// of its own. The ONE hold left is the boot hold: a message sent before the CLI
// first reaches its prompt is written once, in order, when it does (orchestrator
// ruling, option B — MEASURED at claude 2.1.281: a paste + Enter written at +0 /
// +1000ms after spawn sat UNSENT in the composer, 60s, while +2000ms ran).
//
// What this pins, on a REAL pty (node-pty spawning a fake CLI that logs its
// stdin byte-for-byte), through the production entry points:
//
//   A. The write shape. A send after boot reaches the host in the same call —
//      no queue, no receipt, no item — and the CLI's stdin receives exactly the
//      MEASURED production sequence: `ESC[200~` + text + `ESC[201~`, then the
//      CSI-u Enter `ESC[13u` ~120ms later behind the write lock (not a
//      synchronous `\r`: the deferred CSI-u Enter is the measured submit, see
//      TerminalHost.submitPrompt). The paste is on the wire within one tick.
//   B. No gate. A send mid-turn, over a flagged approval panel, and over a
//      recognized Rewind panel is written at once, as a terminal Enter would be.
//      The only ordering kept is byte-level: two sends inside one ~120ms paste +
//      Enter sequence go out whole and in order, never spliced; a Stop drops a
//      send still waiting on that sequence (the stop-after-send class).
//   C. The boot hold. Sends made before the latch opens write NOTHING into the
//      booting CLI and begin no run; when the composer paints they go out once,
//      in order (resume `/compact`, then the user's message), never
//      interleaved; the hold does not survive the pty.
//   D. Attachments. Image paths paste one frame each in the MEASURED chip form
//      (`ESC[200~"<path>"ESC[201~`, double-quoted — the cross-CLI form probed
//      2026-06-26 and exercised live by native-image-attachments.mjs), then the
//      text frame, then Enter; referenced files/folders fold into the prompt
//      text VERBATIM (`composePromptWrite`).
//   E. The controller path. RuntimeController.submitPrompt, called at once after
//      createTask, lands the prompt on the fake CLI's stdin after boot, and the
//      session snapshot carries the host's session state; no `delivery:*`
//      event exists on the wire.
//
// Fixture provenance:
//   - the byte sequences Sonata writes are the production constants imported
//     from dist (BRACKETED_PASTE_*, CSI_U_ENTER) — nothing re-typed;
//   - the fake CLI's boot delay, composer frame (`❯` + `? for shortcuts`) and
//     Rewind override are COMPOSED: the minimum a real host needs to read an
//     idle composer (detectIdlePrompt's ordering rule), not a captured layout;
//   - `approvalActive = true` is COMPOSED state set directly on the host (the
//     flag the scrape sets for a painted panel), because what is under test is
//     that a send ignores it, not how it is raised;
//   - the double-quoted image-path paste is ADAPTED from the MEASURED chip form
//     (shell-quote.ts, probe 2026-06-26), asserted via the production quoter.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "sonata-native-send-"));
// Isolate every path anything here can write — including HOME, because a claude
// spawn records project trust in `~/.claude.json`.
process.env.SONATA_DATA_DIR = path.join(tempRoot, "sonata-data");
process.env.CODEX_HOME = path.join(tempRoot, "codex-home");
process.env.HOME = path.join(tempRoot, "home");
fs.mkdirSync(process.env.HOME, { recursive: true });
const binDir = path.join(tempRoot, "bin");
fs.mkdirSync(binDir, { recursive: true });
process.env.PATH = `${binDir}${path.delimiter}${process.env.PATH ?? ""}`;

const {
  BRACKETED_PASTE_END,
  BRACKETED_PASTE_START,
  CSI_U_ENTER,
  TerminalHost,
  composePromptWrite,
  shellQuotePath,
} = require("../../dist/runtime");

const failures = [];
const results = {};
async function check(name, fn) {
  try {
    await fn();
    results[name] = "ok";
  } catch (error) {
    results[name] = "FAIL";
    failures.push(`${name}: ${error instanceof Error ? error.stack : String(error)}`);
  }
}
function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function waitUntil(predicate, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) {
      return;
    }
    await delay(20);
  }
  throw new Error(`timed out waiting for ${label}`);
}

const paste = (text) => `${BRACKETED_PASTE_START}${text}${BRACKETED_PASTE_END}`;

/**
 * A fake CLI: logs every stdin byte, stays SILENT for `bootMs` (a CLI still
 * booting), then paints an idle composer. `exitAtMs` makes it die mid-boot.
 */
function writeFakeCli(file, logPath, { bootMs = 0, exitAtMs = null } = {}) {
  fs.writeFileSync(
    file,
    `#!/usr/bin/env node
"use strict";
const fs = require("node:fs");
process.stdin.setEncoding("utf8");
if (process.stdin.isTTY) { process.stdin.setRawMode(true); }
process.stdin.resume();
process.stdin.on("data", (data) => fs.appendFileSync(${JSON.stringify(logPath)}, data));
setTimeout(() => process.stdout.write("\\u276f \\n? for shortcuts\\n"), ${bootMs});
${exitAtMs === null ? "" : `setTimeout(() => process.exit(0), ${exitAtMs});`}
setInterval(() => {}, 1000);
`,
    { mode: 0o755 },
  );
}

let fixtureSeq = 0;
function startFakeHost({ bootMs = 0, exitAtMs = null, provider = "claude" } = {}) {
  fixtureSeq += 1;
  const dir = path.join(tempRoot, `host-${fixtureSeq}`);
  fs.mkdirSync(dir, { recursive: true });
  const logPath = path.join(dir, "stdin.log");
  const script = path.join(dir, "fake-cli.js");
  writeFakeCli(script, logPath, { bootMs, exitAtMs });
  const events = [];
  const host = new TerminalHost({
    taskId: `native-send-${fixtureSeq}`,
    provider,
    defaultWorkspace: dir,
    eventSink: (event) => {
      if (event.type !== "pty:data") {
        events.push({ ...event, at: Date.now() });
      }
    },
  });
  // Spawned through its `#!/usr/bin/env node` shebang (the system node), as the
  // fake `claude` in part E is: an Electron-as-node child under the isolated HOME
  // above does not exit on process.exit (observed while writing this smoke).
  host.startTask({ cwd: dir, command: script, args: [], rows: 24, cols: 100 });
  const log = () => (fs.existsSync(logPath) ? fs.readFileSync(logPath, "utf8") : "");
  const of = (type) => events.filter((event) => event.type === type);
  return { host, dir, log, events, of, script, logPath };
}

// ── B/E prerequisite: the write transform (pure) ────────────────────────────
await check("composePromptWrite folds a referenced file into the text VERBATIM", async () => {
  // $ and ` are exactly what shellQuotePath would backslash-escape — wrong for the
  // prompt-text channel, where nothing un-escapes (guards bug: text quoter).
  const refPath = "/Users/a/proj$1/`notes`/report.pdf";
  const write = composePromptWrite("Look at this", [
    { id: "f", path: refPath, originalName: "report.pdf", mediaType: "application/pdf", size: 1, provenance: "referenced", kind: "file" },
  ]);
  assert(write.text === `Look at this\n"${refPath}"`, `text=${JSON.stringify(write.text)}`);
  assert(!write.text.includes("\\$") && !write.text.includes("\\`"), "the text channel must not shell-escape");
  assert(write.imageAttachments.length === 0, "a file reference is text, not a chip");
});

await check("composePromptWrite: image chips, folder folds, empty refuses", async () => {
  const image = { id: "i", path: "/tmp/x/shot.png", originalName: "shot.png", mediaType: "image/png", size: 1, provenance: "referenced", kind: "image" };
  const folder = { id: "d", path: "/tmp/x/dir", originalName: "dir", mediaType: "inode/directory", size: 0, provenance: "referenced", kind: "folder" };
  const write = composePromptWrite("  Review these  ", [image, folder]);
  assert(write.text === 'Review these\n"/tmp/x/dir"', `text=${JSON.stringify(write.text)}`);
  assert(write.imageAttachments.length === 1 && write.imageAttachments[0].path === image.path, "the image stays a chip");
  const imageOnly = composePromptWrite("", [image]);
  assert(imageOnly.text === "" && imageOnly.imageAttachments.length === 1, "an image-only send is a send");
  let threw = "";
  try {
    composePromptWrite("   ", []);
  } catch (error) {
    threw = String(error.message);
  }
  assert(/empty prompt/.test(threw), `an empty send refuses (threw=${JSON.stringify(threw)})`);
});

// ── A + B: a booted host — write shape, no state, no gate ───────────────────
await check("a send after boot writes paste then CSI-u Enter, at once, with no gate", async () => {
  const fx = startFakeHost();
  try {
    await waitUntil(() => fx.host.bootLatched(), 5_000, "the boot latch");
    await delay(600); // past the post-latch send grace — the hold is not in play
    const text = "Reply with exactly: ok";
    fx.host.submitPromptWhenReady(text);
    // Reached the host's write sequence in this very call: the run began and
    // prompt:submitted went out synchronously — there is no queue to sit in.
    assert(fx.of("prompt:submitted").length === 1, "prompt:submitted is emitted synchronously");
    assert(fx.host.hasActiveRun(), "the idle send began its run at write time");
    const sentAt = Date.now();
    await waitUntil(() => fx.log().includes(CSI_U_ENTER), 2_000, "the Enter");
    const log = fx.log();
    assert(log === `${paste(text)}${CSI_U_ENTER}`, `stdin=${JSON.stringify(log)}`);
    assert(Date.now() - sentAt < 1_000, "the Enter follows within the ~120ms write sequence");

    // B — mid-turn: the run above is still open (the fake never ends a turn).
    // No hold on an active run, for either provider: the CLI decides.
    const before = fx.log().length;
    fx.host.submitPromptWhenReady("mid-turn steer");
    await waitUntil(() => fx.log().length > before && fx.log().endsWith(CSI_U_ENTER), 2_000, "the mid-turn send");
    assert(fx.log().slice(before) === `${paste("mid-turn steer")}${CSI_U_ENTER}`, "mid-turn send written as-is");

    // B — a flagged native approval panel (COMPOSED flag): written at once.
    fx.host.approvalActive = true;
    const beforeApproval = fx.log().length;
    let threw = "";
    try {
      fx.host.submitPromptWhenReady("typed over an approval");
    } catch (error) {
      threw = String(error.message);
    }
    assert(threw === "", `no approval refusal (threw=${JSON.stringify(threw)})`);
    await waitUntil(() => fx.log().slice(beforeApproval).endsWith(CSI_U_ENTER), 2_000, "the send over the panel");
    fx.host.approvalActive = false;

    // B — a recognized Rewind panel (COMPOSED override): written at once.
    fx.host.isRewindPanelOpen = () => true;
    const beforeRewind = fx.log().length;
    fx.host.submitPromptWhenReady("typed over the rewind panel");
    await waitUntil(() => fx.log().slice(beforeRewind).endsWith(CSI_U_ENTER), 2_000, "the send over the rewind panel");
    assert(fx.log().slice(beforeRewind) === `${paste("typed over the rewind panel")}${CSI_U_ENTER}`, "rewind send as-is");

    const types = new Set(fx.events.map((event) => event.type));
    assert(![...types].some((type) => type.startsWith("delivery:")), `no delivery events (${[...types].join(",")})`);
  } finally {
    fx.host.dispose();
  }
});

await check("two sends inside one write sequence go out whole, in order; Stop drops the waiting one", async () => {
  const fx = startFakeHost();
  try {
    await waitUntil(() => fx.host.bootLatched(), 5_000, "the boot latch");
    await delay(600);
    fx.host.submitPromptWhenReady("first");
    fx.host.submitPromptWhenReady("second"); // lands inside first's ~120ms sequence
    await waitUntil(() => fx.log().split(CSI_U_ENTER).length === 3, 3_000, "both sends");
    assert(
      fx.log() === `${paste("first")}${CSI_U_ENTER}${paste("second")}${CSI_U_ENTER}`,
      `never spliced: ${JSON.stringify(fx.log())}`,
    );

    // A run is open now (the fake never ends one). Send, then a second send
    // that waits on the first's sequence, then Stop inside that window: the
    // stop cancels the first's unwritten bytes AND drops the waiting second.
    const before = fx.log().length;
    fx.host.submitPromptWhenReady("third");
    fx.host.submitPromptWhenReady("fourth");
    await fx.host.stopRun({ inspectDelayMs: 60_000 });
    await delay(500);
    const after = fx.log().slice(before);
    assert(!after.includes("third") && !after.includes("fourth"), `nothing trails the stop: ${JSON.stringify(after)}`);
  } finally {
    fx.host.dispose();
  }
});

// ── C: the boot hold ────────────────────────────────────────────────────────
await check("sends before the prompt are held, then written once, in order, not interleaved", async () => {
  const fx = startFakeHost({ bootMs: 900 });
  try {
    // A resumed summary session's shape: `/compact` first, the user's own next.
    fx.host.submitPromptWhenReady("/compact");
    fx.host.submitPromptWhenReady("the user's first message");
    await delay(400);
    assert(fx.log() === "", `nothing is written into a booting CLI (stdin=${JSON.stringify(fx.log())})`);
    assert(fx.of("run:started").length === 0, "no run begins while the message is held");
    assert(fx.host.bootLatched() === false, "the latch is still shut");
    const lastState = fx.of("session:state").at(-1)?.payload;
    assert(lastState && lastState.bootLatched === false, "session:state reports the boot");

    await waitUntil(() => fx.log().split(CSI_U_ENTER).length === 3, 5_000, "both held messages");
    const log = fx.log();
    assert(
      log === `${paste("/compact")}${CSI_U_ENTER}${paste("the user's first message")}${CSI_U_ENTER}`,
      `held messages go out in order, each paste+Enter whole: ${JSON.stringify(log)}`,
    );
    const latchedAt = fx.of("session:state").find((event) => event.payload.bootLatched)?.at ?? null;
    const firstRunAt = fx.of("run:started")[0]?.at ?? null;
    assert(latchedAt !== null && firstRunAt !== null && firstRunAt >= latchedAt, "the run begins at write time, after the latch");

    // After the latch the hold is gone for good: a send is written at once.
    const before = fx.log().length;
    fx.host.submitPromptWhenReady("later");
    await waitUntil(() => fx.log().slice(before).endsWith(CSI_U_ENTER), 2_000, "the post-latch send");
  } finally {
    fx.host.dispose();
  }
});

await check("the boot hold dies with the pty — a relaunch sends nothing on its own", async () => {
  const fx = startFakeHost({ bootMs: 60_000, exitAtMs: 300 });
  try {
    fx.host.submitPromptWhenReady("held for a CLI that never booted");
    await waitUntil(() => fx.of("pty:exit").length === 1, 5_000, "the pty exit");
    assert(fx.host.bootLatched() === false, "the dead pty never latched");
    // Relaunch on the same host with a CLI that boots at once.
    writeFakeCli(fx.script, fx.logPath, { bootMs: 0 });
    fx.host.startTask({ cwd: fx.dir, command: fx.script, args: [], rows: 24, cols: 100 });
    await waitUntil(() => fx.host.bootLatched(), 5_000, "the relaunch's latch");
    await delay(900); // past the send grace, where a surviving hold would flush
    assert(fx.log() === "", `the relaunch received nothing (stdin=${JSON.stringify(fx.log())})`);
  } finally {
    fx.host.dispose();
  }
});

// ── D: attachments keep the measured path form ─────────────────────────────
await check("an image send pastes each path in the measured chip form, then text, then Enter", async () => {
  const fx = startFakeHost();
  try {
    await waitUntil(() => fx.host.bootLatched(), 5_000, "the boot latch");
    await delay(600);
    const imageA = path.join(fx.dir, "with space", "a'b.png");
    const imageB = path.join(fx.dir, "plain.png");
    const refFile = path.join(fx.dir, "notes.txt");
    const write = composePromptWrite("Describe these", [
      { id: "a", path: imageA, originalName: "a'b.png", mediaType: "image/png", size: 1, provenance: "referenced", kind: "image" },
      { id: "b", path: imageB, originalName: "plain.png", mediaType: "image/png", size: 1, provenance: "referenced", kind: "image" },
      { id: "c", path: refFile, originalName: "notes.txt", mediaType: "text/plain", size: 1, provenance: "referenced", kind: "file" },
    ]);
    fx.host.submitPromptWhenReady(write.text, {
      attachments: write.imageAttachments.map((attachment) => ({ path: attachment.path })),
    });
    // The fake renders no chips, so the effect poll runs to its bounded
    // fallback (~1.5s) before the Enter — the failure direction that is slower,
    // never earlier.
    await waitUntil(() => fx.log().endsWith(CSI_U_ENTER), 5_000, "the attachment send's Enter");
    const expected =
      paste(shellQuotePath(imageA)) +
      paste(shellQuotePath(imageB)) +
      paste(`Describe these\n"${refFile}"`) +
      CSI_U_ENTER;
    assert(fx.log() === expected, `stdin=${JSON.stringify(fx.log())}`);
    assert(shellQuotePath(imageA) === `"${imageA}"`, "the chip form is the plain double-quoted path here");
  } finally {
    fx.host.dispose();
  }
});

// ── E: the controller path, end to end ─────────────────────────────────────
await check("RuntimeController.submitPrompt right after createTask lands after boot", async () => {
  const { RuntimeController } = require("../../dist/main/runtime-controller");
  const { INERT_CODEX_SPAWN_GATE } = require("../../dist/main/cli-updater/cli-updater");
  const { ProjectsStore } = require("../../dist/main/projects-store");
  const { TagsStore } = require("../../dist/main/tags-store");
  const {
    ResumeSettingsStore,
    ClaudeSettingsStore,
    CodexSettingsStore,
    SonataSettingsStore,
  } = require("../../dist/main/settings-store");
  const workspace = path.join(tempRoot, "controller-workspace");
  fs.mkdirSync(workspace, { recursive: true });
  const logPath = path.join(tempRoot, "controller-stdin.log");
  // The production argv goes to this fake `claude`, which ignores it.
  writeFakeCli(path.join(binDir, "claude"), logPath, { bootMs: 700 });
  const root = path.join(tempRoot, "ctl");
  fs.mkdirSync(root, { recursive: true });
  const events = [];
  const healthy = { install: "present", auth: "signedIn" };
  const controller = new RuntimeController({
    sendEvent: (event) => events.push(event),
    projectsStore: new ProjectsStore(path.join(root, "projects.json")),
    tagsStore: new TagsStore(path.join(root, "tags.json")),
    resumeSettingsStore: new ResumeSettingsStore(path.join(root, "resume.json")),
    claudeSettingsStore: new ClaudeSettingsStore(path.join(root, "claude.json")),
    codexSettingsStore: new CodexSettingsStore(path.join(root, "codex.json")),
    sonataSettingsStore: new SonataSettingsStore(path.join(root, "sonata.json")),
    cliUpdater: INERT_CODEX_SPAWN_GATE,
    cliReadiness: { reprobe: () => Promise.resolve(), read: () => ({ claude: healthy, codex: healthy }) },
  });
  const log = () => (fs.existsSync(logPath) ? fs.readFileSync(logPath, "utf8") : "");
  try {
    const created = await controller.createTask({ provider: "claude", cwd: workspace });
    const taskId = created.task.id;
    const refFile = path.join(workspace, "ref.txt");
    fs.writeFileSync(refFile, "x");
    // New Chat's shape: the first message follows the spawn at once.
    controller.submitPrompt(taskId, "first message", [
      { id: "r", path: refFile, originalName: "ref.txt", mediaType: "text/plain", size: 1, provenance: "referenced", kind: "file" },
    ]);
    await delay(300);
    assert(log() === "", "nothing reaches the booting CLI");
    await waitUntil(() => log().endsWith(CSI_U_ENTER), 8_000, "the held first message");
    assert(log() === `${paste(`first message\n"${refFile}"`)}${CSI_U_ENTER}`, `stdin=${JSON.stringify(log())}`);
    const snapshot = controller.readSessionSnapshot(taskId);
    assert(snapshot.sessionState?.bootLatched === true, "the snapshot carries the host's session state");
    assert(snapshot.sessionState?.activeRun === true, "…including the run the send began");
    assert(!("delivery" in snapshot), "the snapshot has no delivery field");
    assert(
      events.every((event) => !String(event.type).startsWith("delivery:")),
      "no delivery events reach the renderer",
    );
    assert(
      events.some((event) => event.type === "session:state" && event.payload.bootLatched === true),
      "session:state reaches the renderer when the latch opens",
    );
  } finally {
    controller.dispose();
  }
});

console.log(JSON.stringify({ results, failures }, null, 2));
fs.rmSync(tempRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
if (failures.length > 0) {
  process.exit(1);
}
console.log("native-send: OK");
process.exit(0);
