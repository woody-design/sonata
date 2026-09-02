// A codex `Interrupt` hook that ends a turn must RELEASE every broker ask still
// pending for that task — on the REAL RuntimeController (SL-9 review round 1, B1).
//
// THE DEFECT THIS PINS. `Interrupt` completes the run through
// `TerminalHost.completeRunFromTurnEnd`, which stamps `completionSource:
// "hook-stop"` — and `isPendingTurnEnd` deliberately EXCLUDES hook-stop
// completions, on the invariant "a live holding hook blocks the turn, so a
// hook-Stop cannot coexist with a pending broker ask". That invariant belongs to
// `Stop`. It is FALSE for an interrupt, which KILLS the holding PermissionRequest
// hook — the very reason `abortPendingBrokerApprovals` exists.
//
// MEASURED at codex 0.152.1 (probe h3 arm `d4-interrupt-under-hold`): with the
// production broker holding a real ask, Ctrl+C fires `Interrupt` at +131ms, NO
// `Stop` follows, and the `ask-<id>.json` is still on disk 25s later with no
// reply and no expiry marker. Nothing will ever resolve it. Routed down the
// hook-stop path its id sits in `pendingBrokerApprovals` forever,
// `DeliveryController.pendingApprovalKeys` keeps the gate shut, and every later
// send wedges until the pty dies — invisibly, because the reducer has already
// retracted the card. Before SL-9 the ~+2s `terminal-idle-heuristic` closer
// (which IS a pending turn end) released it; the hook preempts that.
//
// WHY THE RUN IS STARTED BY HOOKS, not by `submitPrompt`. The assertion is about
// the turn-terminal release path, not about composer readiness. `SessionStart`
// opens the delivery boot latch structurally for both providers and
// `UserPromptSubmit` starts the run via `beginRunFromHook` — the same two edges
// production uses — so this test needs no idle-composer needle from the fake CLI
// and cannot rot when a TUI repaints differently.
//
// Everything load-bearing is production wire: a real `ask-<id>.json` through the
// real ApprovalWatcher, real `hook-*.json` files through the real HookWatcher,
// the real controller dispatch.
//
// Harness shape lifted from tests/smoke/stop-hook-orphan-approval.mjs.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "sonata-interrupt-pending-"));
// Isolate every path anything here can write — including HOME.
process.env.SONATA_DATA_DIR = path.join(tempRoot, "sonata-data");
process.env.CODEX_HOME = path.join(tempRoot, "codex-home");
process.env.HOME = path.join(tempRoot, "home");
fs.mkdirSync(process.env.HOME, { recursive: true });
fs.mkdirSync(process.env.CODEX_HOME, { recursive: true });

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
const { approvalsDirectory } = require("../../dist/runtime/cli-signal/approval-protocol");

const askId = "interrupt-pending-ask-1";

// A fake `codex`: prints a composer once and then idles. Deliberately inert —
// the run lifecycle in this test is driven entirely by hook files, so the fake
// only has to exist, stay alive, and not emit anything that reads as activity.
fs.writeFileSync(
  path.join(binDir, "codex"),
  `#!/usr/bin/env node
"use strict";
process.stdin.setEncoding("utf8");
if (process.stdin.isTTY) { process.stdin.setRawMode(true); }
process.stdin.resume();
const COMPOSER = "\\u001b[2J\\u001b[H\\u203a Ask Codex to do anything\\n";
process.stdout.write(COMPOSER);
// Echo what was pasted, as a real composer does — without the
// pty-composer-echo receipt a delivered item stays in flight forever and the
// queue-flow proof at the end would be measuring the fake, not the gate.
process.stdin.on("data", (data) => {
  const echoed = data.replace(/\\u001b\\[[0-9;]*[A-Za-z~]/g, "").replace(/[\\u0000-\\u001f]/g, " ").trim();
  if (echoed) { process.stdout.write(echoed + "\\n" + COMPOSER); }
});
setInterval(() => {}, 1000);
`,
  { mode: 0o755 },
);
fs.chmodSync(path.join(binDir, "codex"), 0o755);

/** Write a control file the way Sonata's own producers do (tmp + rename). */
function dropFile(dir, name, payload) {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, name);
  fs.writeFileSync(`${file}.tmp`, JSON.stringify(payload), "utf8");
  fs.renameSync(`${file}.tmp`, file);
}

const fireHook = (taskId, payload) =>
  dropFile(
    path.join(runtimeDir(taskId), "hooks"),
    `hook-${Date.now().toString(36)}-${process.hrtime.bigint().toString(36)}.json`,
    payload,
  );
const fireAsk = (taskId, id, payload) =>
  dropFile(approvalsDirectory(runtimeDir(taskId)), `ask-${id}.json`, payload);

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
  if (!condition) failures.push(detail === undefined ? label : `${label} — ${detail}`);
};
const of = (type) => events.filter((event) => event.type === type);
const lastCliActivity = () => of("cli-state:changed").at(-1)?.payload.activity ?? null;
const lastDelivery = () => of("delivery:state").at(-1)?.payload ?? null;
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(predicate, timeoutMs, what) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (predicate()) return;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await delay(100);
  }
}

try {
  const created = await controller.createTask({ provider: "codex", cwd: workspace });
  const taskId = created.task.id;

  // --- a live turn, started the way production starts one from hooks --------
  fireHook(taskId, { hook_event_name: "SessionStart", cwd: workspace, session_id: "s-1" });
  fireHook(taskId, {
    hook_event_name: "UserPromptSubmit",
    cwd: workspace,
    session_id: "s-1",
    prompt: "run curl",
    turn_id: "turn-1",
  });
  await waitFor(() => of("run:started").length > 0, 20_000, "the UserPromptSubmit hook starting a run");
  const runId = of("run:started")[0].payload.id;
  check("the turn is busy before the interrupt", lastCliActivity() === "busy", `activity=${lastCliActivity()}`);

  // --- a real broker ask, HELD (no reply, no expiry) ------------------------
  fireAsk(taskId, askId, {
    payload: {
      hook_event_name: "PermissionRequest",
      tool_name: "shell",
      tool_input: { command: "curl -sS https://example.com" },
    },
  });
  await waitFor(
    () => of("approval:detected").some((event) => event.payload.approvalId === askId),
    15_000,
    "the broker card",
  );
  check(
    "cli-state is waiting-approval while the broker holds",
    lastCliActivity() === "waiting-approval",
    `activity=${lastCliActivity()}`,
  );
  check("the held ask has not been decided", of("approval:decision").length === 0);
  // Deliberately NOT asserting `canDeliver() === false` here. It is false, but a
  // live run makes it false too, so the boolean cannot isolate the approval key
  // at this moment and an assertion on it would pass for the wrong reason. The
  // key's release is proved operationally at the end instead, once the run is
  // closed and the approval key is the only thing that could still hold the gate.

  // --- the Interrupt hook, through the real watcher ------------------------
  // No `Stop` is fired, deliberately: codex does not send one for an interrupted
  // turn (MEASURED), so a test that fired one would be testing the Stop path.
  fireHook(taskId, {
    hook_event_name: "Interrupt",
    cwd: workspace,
    session_id: "s-1",
    turn_id: "turn-1",
    model: "gpt-5.6-sol",
    permission_mode: "default",
  });

  // THE PIN. On the hook-stop route this never arrives and the test times out
  // here — which is exactly how it fails against the pre-fix build.
  await waitFor(
    () => of("approval:decision").length > 0,
    15_000,
    "the Interrupt releasing the pending broker ask (B1: the hook-stop route never does)",
  );

  const decision = of("approval:decision")[0];
  check("exactly one decision", of("approval:decision").length === 1, `count=${of("approval:decision").length}`);
  check(
    "the decision releases THIS ask",
    decision.payload.approvalId === askId,
    `approvalId=${decision.payload.approvalId}`,
  );
  check(
    "the orphaned ask resolves as deny/Esc",
    decision.payload.decision === "deny" && decision.payload.encodedAs === "Esc",
    `decision=${decision.payload.decision} encodedAs=${decision.payload.encodedAs}`,
  );
  check(
    "the decision is attributed to the interrupted run",
    decision.payload.runId === runId,
    `runId=${decision.payload.runId} run=${runId}`,
  );

  // the run really did complete on the hook (not by some later heuristic)
  const completed = of("run:updated").filter((event) => event.payload.status === "completed");
  check("the run completed", completed.length >= 1, `completed=${completed.length}`);
  check(
    "the completion is the interrupted run",
    completed.at(-1)?.payload.id === runId,
    `id=${completed.at(-1)?.payload.id}`,
  );

  // and cli-state ends the turn rather than regressing to busy on the decision
  await delay(500);
  check(
    "cli-state settled at turn-ended",
    lastCliActivity() === "turn-ended",
    `activity=${lastCliActivity()} trail=${JSON.stringify(of("cli-state:changed").map((e) => e.payload.activity))}`,
  );

  // A SECOND interrupt for a run that is already closed must not re-fire a
  // decision — the run-id marker is read-and-delete, and this is what proves it.
  fireHook(taskId, {
    hook_event_name: "Interrupt",
    cwd: workspace,
    session_id: "s-1",
    turn_id: "turn-1",
    model: "gpt-5.6-sol",
    permission_mode: "default",
  });
  await delay(1200);
  check(
    "a second Interrupt with no live run emits no further decision",
    of("approval:decision").length === 1,
    `count=${of("approval:decision").length}`,
  );

  // --- the operational half: the gate really did reopen ---------------------
  // Taken LAST, and by sending rather than by reading a boolean. With an empty
  // queue the DeliveryController emits no fresh `delivery:state`, so
  // `lastDelivery()` is a stale pre-interrupt reading — an assertion on it would
  // be measuring nothing. A real send is unambiguous: the run is closed and the
  // CLI is idle, so a still-held approval key is the ONLY thing that could keep
  // this item queued. Pre-fix it stays queued forever; post-fix it flows.
  controller.submitPrompt(taskId, "This send must flow once the Interrupt releases the orphan.");
  await waitFor(
    () => (lastDelivery()?.queue ?? []).every((item) => item.status !== "queued"),
    15_000,
    "the held item leaving the queue (a still-held approval key would pin it)",
  );
  // The DEPARTURE is the proof, not `deliverable` — which reads false again the
  // moment an item is in flight (the gate is busy with that send). Asserting it
  // true here would be asserting the wrong thing and would fail for a healthy
  // reason; asserting the item left `queued` is precisely "no approval key pins
  // it any more".
  const finalQueue = (lastDelivery()?.queue ?? []).map((item) => item.status);
  check(
    "the send is in flight or done, never still queued",
    finalQueue.every((status) => status !== "queued"),
    `queue=${JSON.stringify(finalQueue)}`,
  );
} catch (error) {
  // A timeout here is a real failure, but an opaque one — dump the evidence a
  // reader would otherwise have to re-derive by hand.
  failures.push(String(error?.message ?? error));
  failures.push(`decisions=${JSON.stringify(of("approval:decision").map((e) => e.payload))}`);
  failures.push(`deliveryTrail=${JSON.stringify(of("delivery:state").map((e) => ({ deliverable: e.payload.deliverable, reason: e.payload.reason ?? null, queue: (e.payload.queue ?? []).map((i) => i.status) })))}`);
  failures.push(`runTrail=${JSON.stringify(of("run:updated").map((e) => `${e.payload.status}/${e.payload.completionSource ?? "-"}`))}`);
  failures.push(`cliStateTrail=${JSON.stringify(of("cli-state:changed").map((e) => e.payload.activity))}`);
} finally {
  try {
    controller.dispose();
  } catch {
    // teardown is best-effort; the verdict below still has to print
  }
}

if (failures.length > 0) {
  console.error("interrupt-hook-pending-approval FAILED:");
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}
console.log("interrupt-hook-pending-approval: OK");
