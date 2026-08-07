// An open AskUserQuestion form must gate delivery — on the REAL
// RuntimeController (ask-flows S3 / B4).
//
// THE DEFECT this pins. Sonata knows about the form structurally: the CLI's own
// `PreToolUse(AskUserQuestion)` hook carries the questions, `PostToolUse` the
// answers. But main SYNTHESIZES `option-prompt:detected`/`:resolved` from the
// hook sink — they are not terminal-host events, so they never pass the
// `deliveryController.handleRuntimeEvent` fan-out in handleRuntimeEvent. Every
// one of the four emitters reached `sendEvent` (the renderer's card) and
// stopped there. The delivery gate, which knows about approval panels, control
// switches and the Rewind picker, was therefore blind to the one screen owner
// Sonata detects with certainty — and claude's mid-turn write-through means a
// queued send goes out WITHOUT waiting for the turn to end, i.e. exactly while
// the model is most likely to have a question on screen. Text plus a CSI-u
// Enter, into an option form (the digit/enter-swallow class, H1).
//
// The gate's semantics on those events are fenced separately, at the
// DeliveryController, in delivery-option-prompt-gate.mjs. That file would pass
// against a controller nothing ever calls; THIS file is the one that proves the
// calls exist. It drives production wire end to end — real hook files through
// the real HookWatcher, real delivery through the real DeliveryController, a
// real PTY death — because the wiring is the whole claim.
//
// Three of the four resolution paths are exercised here, each with a queued
// item that must actually flow:
//   1. PostToolUse (answered) — the ordinary end of a question;
//   2. Stop with the form still open (`answers: null`) — the turn ended without
//      one, the CLI's own fallback;
//   3. PTY death (`answers: null`) — read with an EMPTY queue on purpose: the
//      claim there is the gate reopening, and a released item would only
//      re-fail against a dead terminal and add noise to the reading.
// The fourth (the dismiss window's local clear) shares path 2's shape exactly —
// same `resolveOptionPrompt` funnel, same null answers — and needs a 45s
// timeout to reach, so it is covered at the controller-gate level instead.
//
// Fixture provenance: the PreToolUse `tool_input` is ADAPTED from
// option-prompt-parse.mjs (the measured claude 2.1.178 shape), trimmed to one
// question; the PostToolUse `tool_response` is COMPOSED to the documented
// `{answers: {question: label}}` shape. The fake CLI's composer/echo bytes are
// COMPOSED — the minimum satisfying detectIdlePrompt's ordering rule — and the
// harness shape is lifted from stop-hook-orphan-approval.mjs.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "sonata-option-prompt-wiring-"));
// Isolate every path anything here can write — including HOME, because a claude
// spawn records project trust in `~/.claude.json`.
process.env.SONATA_DATA_DIR = path.join(tempRoot, "sonata-data");
process.env.CODEX_HOME = path.join(tempRoot, "codex-home");
process.env.HOME = path.join(tempRoot, "home");
fs.mkdirSync(process.env.HOME, { recursive: true });

const binDir = path.join(tempRoot, "bin");
fs.mkdirSync(binDir, { recursive: true });
process.env.PATH = `${binDir}${path.delimiter}${process.env.PATH ?? ""}`;

const workspace = path.join(tempRoot, "workspace");
fs.mkdirSync(workspace, { recursive: true });

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
const { runtimeDir } = require("../../dist/main/sonata-paths");

const bootText = "Open the session so the boot latch latches.";
const heldByAnswered = "This send must wait for the PostToolUse answer.";
const heldByStop = "This send must wait for the Stop that clears the form.";
// The fake exits when this appears — a PTY death with a question still open.
const exitMarker = path.join(workspace, "die-now");

const TOOL_ANSWERED = "toolu_01wireAnswered";
const TOOL_STOPPED = "toolu_01wireStopped";
const TOOL_PTY_EXIT = "toolu_01wirePtyExit";

// ADAPTED from option-prompt-parse.mjs (measured claude 2.1.178 tool_input).
const TOOL_INPUT = {
  questions: [
    {
      question: "Which fruit?",
      header: "Fruit",
      multiSelect: false,
      options: [
        { label: "Banana", description: "a tropical fruit" },
        { label: "Cherry", description: "a stone fruit" },
      ],
    },
  ],
};
// COMPOSED to the documented PostToolUse shape.
const TOOL_RESPONSE = { answers: { "Which fruit?": "Banana" } };

// A fake `claude`: an idle composer at boot, echoing whatever is pasted (which
// is what earns the pty-composer-echo receipt — without it a delivered item
// stays in flight and canDeliver() is false for reasons unrelated to the form).
// Exits the moment the marker file appears.
fs.writeFileSync(
  path.join(binDir, "claude"),
  `#!/usr/bin/env node
"use strict";
const fs = require("node:fs");
const COMPOSER = "\\u001b[2J\\u001b[HFake Claude ready\\n\\u276f sonnet high ~  ? for shortcuts\\n";
process.stdin.setEncoding("utf8");
if (process.stdin.isTTY) { process.stdin.setRawMode(true); }
process.stdin.resume();
process.stdout.write(COMPOSER);
process.stdin.on("data", (data) => {
  const echoed = data.replace(/\\u001b\\[[0-9;]*[A-Za-z~]/g, "").replace(/[\\u0000-\\u001f]/g, " ").trim();
  if (echoed) {
    process.stdout.write(echoed + "\\n");
  }
});
setInterval(() => {
  if (fs.existsSync(${JSON.stringify(exitMarker)})) {
    process.exit(0);
  }
}, 150);
`,
  { mode: 0o755 },
);
fs.chmodSync(path.join(binDir, "claude"), 0o755);

/** Write a hook file the way Sonata's own producer does (tmp + rename), which is
 *  the only thing the HookWatcher cares about. */
function fireHook(taskId, payload) {
  const dir = path.join(runtimeDir(taskId), "hooks");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(
    dir,
    `hook-${Date.now().toString(36)}-${process.hrtime.bigint().toString(36)}.json`,
  );
  fs.writeFileSync(`${file}.tmp`, JSON.stringify({ cwd: workspace, ...payload }), "utf8");
  fs.renameSync(`${file}.tmp`, file);
}

const askQuestion = (taskId, toolUseId) =>
  fireHook(taskId, {
    hook_event_name: "PreToolUse",
    tool_name: "AskUserQuestion",
    tool_use_id: toolUseId,
    tool_input: TOOL_INPUT,
  });

const healthy = { install: "present", auth: "signedIn" };
const readiness = {
  reprobe: () => Promise.resolve(),
  read: () => ({ claude: healthy, codex: healthy }),
};

const events = [];
const root = path.join(tempRoot, "ctl");
fs.mkdirSync(root, { recursive: true });
const controller = new RuntimeController({
  sendEvent: (event) => events.push(event),
  projectsStore: new ProjectsStore(path.join(root, "projects.json")),
  tagsStore: new TagsStore(path.join(root, "tags.json")),
  resumeSettingsStore: new ResumeSettingsStore(path.join(root, "resume.json")),
  claudeSettingsStore: new ClaudeSettingsStore(path.join(root, "claude.json")),
  codexSettingsStore: new CodexSettingsStore(path.join(root, "codex.json")),
  sonataSettingsStore: new SonataSettingsStore(path.join(root, "sonata.json")),
  cliUpdater: INERT_CODEX_SPAWN_GATE,
  cliReadiness: readiness,
});

const failures = [];
const check = (label, condition, detail) => {
  if (!condition) {
    failures.push(detail === undefined ? label : `${label} — ${detail}`);
  }
};
const of = (type) => events.filter((event) => event.type === type);
const lastDelivery = () => of("delivery:state").at(-1)?.payload ?? null;
const deliverable = () => lastDelivery()?.deliverable ?? null;
const queued = (text) =>
  (lastDelivery()?.queue ?? []).some((item) => item.text === text && item.status === "queued");
const receiptCount = () => of("delivery:receipt").length;
const resolvedFor = (toolUseId) =>
  of("option-prompt:resolved").some((event) => event.payload.toolUseId === toolUseId);

let observed = {};

try {
  const created = await controller.createTask({ provider: "claude", cwd: workspace });
  const taskId = created.task.id;

  // --- 0. a live session with an OPEN gate, so every reading below moves ------
  // The queued item itself opens the boot latch (pump polls while it is held).
  controller.submitPrompt(taskId, bootText);
  await waitFor(() => receiptCount() >= 1, 25_000, "the first send earning its echo receipt");
  await waitFor(() => deliverable() === true, 10_000, "the gate reading open before any question");

  // --- 1. PreToolUse closes the gate; PostToolUse reopens it -----------------
  askQuestion(taskId, TOOL_ANSWERED);
  await waitFor(
    () => of("option-prompt:detected").length >= 1,
    15_000,
    "the PreToolUse hook surfacing the card",
  );
  // THE assertion: reaching the renderer is not enough — the form has to reach
  // the delivery gate. Before the fix this stayed true forever.
  const gateClosedOnDetect = await reaches(() => deliverable() === false, 10_000);
  check("the detected form CLOSES the delivery gate", gateClosedOnDetect, `deliverable=${deliverable()}`);

  controller.submitPrompt(taskId, heldByAnswered);
  await delay(1600); // several 500ms pump-retry intervals: the poll must not walk it out
  check("a send queued under the open form is HELD", queued(heldByAnswered), JSON.stringify(lastDelivery()?.queue));

  fireHook(taskId, {
    hook_event_name: "PostToolUse",
    tool_name: "AskUserQuestion",
    tool_use_id: TOOL_ANSWERED,
    tool_response: TOOL_RESPONSE,
  });
  const flowedOnAnswer = await reaches(() => receiptCount() >= 2, 20_000);
  check("the answered resolution releases the held send", flowedOnAnswer, `receipts=${receiptCount()}`);

  // --- 2. the Stop shape: the turn ended with the form still open ------------
  // `option-prompt:resolved` carries `answers: null` here. A gate that only
  // reopened on a real answer would wedge on the CLI's own fallback path.
  askQuestion(taskId, TOOL_STOPPED);
  await waitFor(
    () => of("option-prompt:detected").length >= 2,
    15_000,
    "the second PreToolUse hook",
  );
  const gateClosedAgain = await reaches(() => deliverable() === false, 10_000);
  check("the second detected form closes the gate too", gateClosedAgain, `deliverable=${deliverable()}`);

  controller.submitPrompt(taskId, heldByStop);
  await delay(1600);
  check("the second send is HELD by the open form", queued(heldByStop), JSON.stringify(lastDelivery()?.queue));

  fireHook(taskId, { hook_event_name: "Stop" });
  const flowedOnStop = await reaches(() => receiptCount() >= 3, 20_000);
  check(
    "a Stop over the open form releases the held send (answers: null)",
    flowedOnStop,
    `receipts=${receiptCount()}`,
  );
  check("the Stop really resolved that form", await reaches(() => resolvedFor(TOOL_STOPPED), 5_000));

  // --- 3. PTY death with a question still open -------------------------------
  // Queue deliberately EMPTY: the claim is that the gate reopens, and a released
  // item would only re-fail against a dead terminal. Read as the boolean.
  askQuestion(taskId, TOOL_PTY_EXIT);
  const gateClosedBeforeExit = await reaches(() => deliverable() === false, 10_000);
  check("the third detected form closes the gate", gateClosedBeforeExit, `deliverable=${deliverable()}`);

  fs.writeFileSync(exitMarker, "", "utf8");
  await waitFor(() => of("pty:exit").length > 0, 20_000, "the PTY dying");
  check("the PTY death resolved the open form", resolvedFor(TOOL_PTY_EXIT));
  const gateOpenAfterExit = await reaches(() => deliverable() === true, 10_000);
  check(
    "the PTY death also RELEASES the gate the form was holding",
    gateOpenAfterExit,
    `deliverable=${deliverable()}`,
  );

  observed = {
    taskId,
    detections: of("option-prompt:detected").map((event) => event.payload.toolUseId),
    resolutions: of("option-prompt:resolved").map((event) => ({
      toolUseId: event.payload.toolUseId,
      answered: event.payload.answers !== null,
    })),
    receipts: receiptCount(),
    deliverableTrail: of("delivery:state").map((event) => event.payload.deliverable),
  };
} catch (error) {
  failures.push(`threw: ${error instanceof Error ? error.stack : String(error)}`);
} finally {
  const success = failures.length === 0;
  console.log(
    JSON.stringify(
      {
        ...observed,
        ...(success ? {} : { eventTypes: events.map((event) => event.type), lastDelivery: lastDelivery() }),
        failures,
        success,
      },
      null,
      2,
    ),
  );
  process.exitCode = success ? 0 : 1;
  try {
    controller.dispose();
  } catch {
    // teardown against an already-dead pty is not the assertion
  }
  await delay(300);
  fs.rmSync(tempRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}

/** Poll until `predicate` holds; THROWS on timeout. For preconditions whose
 *  failure invalidates everything after them. */
async function waitFor(predicate, timeoutMs, label) {
  if (await reaches(predicate, timeoutMs)) {
    return true;
  }
  throw new Error(`Timed out waiting for ${label}.`);
}

/** Poll until `predicate` holds; reports as a boolean. For the assertions
 *  themselves, so a regression reads as a named failure rather than a stack. */
async function reaches(predicate, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (predicate()) {
      return true;
    }
    if (Date.now() >= deadline) {
      return false;
    }
    await delay(100);
  }
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
