// A Stop hook that clears a STALE approval flag must still release the gate
// (ask-flows S1 review 3) — on the REAL RuntimeController.
//
// `TerminalHost.completeRunFromTurnEnd` treats an approval still flagged at
// turn-end as a scrape artifact and clears it — correctly, but SILENTLY. The
// `approval:detected` the scrape emitted for that panel therefore never earns a
// decision, its SCRAPE_APPROVAL_KEY sits in DeliveryController.pendingApprovalKeys
// forever, and `canDeliver()` reads false while `isApprovalActive()` reads clean:
// a wedge invisible from the host flag alone. Every later send sits "Queued".
//
// The whole path is production wire, because none of it can be faked honestly:
//   - claude runs BROKER-ON under the controller (unconditional), so the grid
//     scrape is gated shut until a broker ask EXPIRES. That is the reachability
//     the B1 defect states, so the fence drives it: a real `ask-<id>.json`, then
//     a real `expired-<id>.json`, through the real ApprovalWatcher — which arms
//     `brokerExpiryResurfaceAt` and lets the scrape surface the native card.
//   - the Stop hook arrives as a real `hook-*.json` in the task's runtime sink,
//     read by the real HookWatcher.
//   - the panel is gone from the grid by then (the CLI repainted past it — which
//     is WHY the surviving flag is stale), while `approvalActive` is still true.
//
// What it pins:
//   1. the scraped panel sets the sentinel (the gate closes, an item is held);
//   2. the Stop hook completes the run through the stale-approval branch;
//   3. the released decision reaches all THREE consumers the controller
//      dispatches to explicitly — the delivery controller (gate reopens, the
//      held item flows), the renderer transport (the event is sent), and the
//      run-index (a decision row lands in the durable report);
//   4. cli-state does NOT regress from `turn-ended`.
//
// (4) is the reason the fix lives in the controller rather than the host. A host
// `emitEvent` would reach `CliStateModel.applyRuntimeEvent`, whose
// `approval:decision` → `busy` rule overwrites the `turn-ended` the same Stop
// hook set moments earlier — and busy STICKS, because cli-state's only other
// turn-enders are hooks and `task:ready`, neither of which a hook-stop
// completion fires. Asserting the activity here is what stops a future
// "simplification" from moving the emit back into the host.
//
// Fixture bytes: the approval panel frame is ADAPTED from
// tests/smoke/submit-approval-guard.mjs (claude file-edit panel, legacy hint
// grammar). The idle-composer and activity frames are COMPOSED — the minimum
// bytes satisfying detectIdlePrompt's ordering rule and the claude activityHints
// vocabulary. Harness shape lifted from cli-session-start-triggers.mjs; the
// control-file helper from tests/e2e/composer-send-stop.mjs.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "sonata-stop-hook-orphan-"));
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
const { projectRecordRoot, runtimeDir } = require("../../dist/main/sonata-paths");
const { approvalsDirectory } = require("../../dist/runtime/cli-signal/approval-protocol");

const promptText = "Please edit orphan-approval.txt";
const queuedText = "This send must flow once the Stop hook releases the orphan.";
// The fake stops painting the panel when this appears — the CLI repainting past
// an answered panel, which is what makes the surviving flag STALE.
const repaintMarker = path.join(workspace, "repaint-past-panel");
const askId = "orphan-ask-1";

// A fake `claude`: idle composer at boot; once the prompt lands it repaints an
// activity line + a file-edit panel on a 300ms tick (so the turn never reads as
// quiescent and the panel is continuously on the grid), then repaints past the
// panel to a bare composer the moment the marker appears.
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
let seen = "";
let asked = false;
let timer = null;
process.stdin.on("data", (data) => {
  seen += data;
  // Echo what was pasted, as a real composer does — that is what earns the
  // pty-composer-echo receipt, without which a delivered item stays in flight
  // and canDeliver() is false for a reason that has nothing to do with approvals.
  const echoed = data.replace(/\\u001b\\[[0-9;]*[A-Za-z~]/g, "").replace(/[\\u0000-\\u001f]/g, " ").trim();
  if (echoed) {
    process.stdout.write(echoed + "\\n");
  }
  if (!asked && seen.includes(${JSON.stringify(promptText)})) {
    asked = true;
    timer = setInterval(() => {
      if (fs.existsSync(${JSON.stringify(repaintMarker)})) {
        clearInterval(timer);
        timer = null;
        process.stdout.write(COMPOSER);
        return;
      }
      process.stdout.write("\\u001b[2J\\u001b[H");
      process.stdout.write("\\u271b Cerebrating\\u2026 (esc to interrupt)\\n");
      process.stdout.write("\\nAllow this edit?\\n");
      process.stdout.write("- orphan-approval.txt\\n");
      process.stdout.write("Enter to confirm\\n");
    }, 300);
  }
});
setInterval(() => {}, 1000);
`,
  { mode: 0o755 },
);
fs.chmodSync(path.join(binDir, "claude"), 0o755);

/** Write a control file the way Sonata's own producers do (tmp + rename), which
 *  is the only thing the watchers care about. */
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
/** Give up on an ask exactly as the real broker does: drop `expired-<id>.json`
 *  AND remove its own `ask-<id>.json` (approval-broker.ts rmSync(askPath) on the
 *  timeout path). Leaving the ask file behind makes the watcher re-surface it on
 *  the next poll — `consumeExpired` clears its seen-set entry — which would flip
 *  the delivery gate's key back from "expired" to "asked". */
const fireExpiry = (taskId, id) => {
  const dir = approvalsDirectory(runtimeDir(taskId));
  dropFile(dir, `expired-${id}.json`, { id });
  fs.rmSync(path.join(dir, `ask-${id}.json`), { force: true });
};

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
const scrapeDetections = () =>
  of("approval:detected").filter((event) => event.payload.approvalId === undefined);
const lastCliActivity = () => of("cli-state:changed").at(-1)?.payload.activity ?? null;
const lastDelivery = () => of("delivery:state").at(-1)?.payload ?? null;
const heldItems = () => (lastDelivery()?.queue ?? []).filter((item) => item.status === "queued");

let observed = {};

try {
  const created = await controller.createTask({ provider: "claude", cwd: workspace });
  const taskId = created.task.id;

  // The queue itself opens the boot latch (pump polls every 500ms while an item
  // is held), so the prompt goes in as soon as the task exists.
  controller.submitPrompt(taskId, promptText);
  await waitFor(() => of("run:started").length > 0, 20_000, "the prompt starting a run");
  const runId = of("run:started")[0].payload.id;

  // --- broker ask, then its expiry: the only way the scrape may surface ------
  fireAsk(taskId, askId, {
    payload: {
      hook_event_name: "PermissionRequest",
      tool_name: "Edit",
      tool_input: { file_path: "orphan-approval.txt" },
    },
  });
  await waitFor(
    () => of("approval:detected").some((event) => event.payload.approvalId === askId),
    15_000,
    "the broker card",
  );
  fireExpiry(taskId, askId);
  await waitFor(() => of("approval:expired").length > 0, 15_000, "the broker expiry");
  await waitFor(() => scrapeDetections().length > 0, 20_000, "the scrape resurfacing the panel");
  const detected = scrapeDetections()[0];

  // --- 1. the scraped panel holds the gate ---------------------------------
  // Read as the BOOLEAN rather than by parking an item in the queue: an item
  // released by the decision would submit immediately, and that send drives
  // cli-state busy on its own — masking the very regression assertion 4 exists
  // to catch. The queue is therefore left empty across the Stop, and the
  // operational proof (an item actually flowing) is taken afterwards, in 5.
  const gateClosed = lastDelivery()?.deliverable ?? null;
  check(
    "the scraped panel is a file-edit ask",
    detected.payload.kind === "file-edit",
    `kind=${detected.payload.kind}`,
  );
  check("canDeliver() is false under the panel", gateClosed === false);
  check(
    "cli-state is waiting-approval before the Stop",
    lastCliActivity() === "waiting-approval",
    `activity=${lastCliActivity()}`,
  );

  // --- 2. the CLI repaints past the panel; the flag survives it -------------
  fs.writeFileSync(repaintMarker, "", "utf8");
  await delay(1200); // let the repaint land and settle on the grid
  check("the panel's detection was never decided", of("approval:decision").length === 0);

  // --- 3. the Stop hook, through the real watcher ---------------------------
  fireHook(taskId, { hook_event_name: "Stop", cwd: workspace });
  await waitFor(
    () => of("cli-state:changed").some((event) => event.payload.activity === "turn-ended"),
    15_000,
    "the Stop hook reaching cli-state",
  );
  await waitFor(() => of("approval:decision").length > 0, 15_000, "the orphan release decision");
  const decision = of("approval:decision")[0];
  check("exactly one decision", of("approval:decision").length === 1, `count=${of("approval:decision").length}`);
  check(
    "decision is answered-natively / native-keys",
    decision.payload.decision === "answered-natively" && decision.payload.encodedAs === "native-keys",
    `decision=${decision.payload.decision} encodedAs=${decision.payload.encodedAs}`,
  );
  check(
    "decision carries the scraped ask's kind",
    decision.payload.previousKind === "file-edit",
    `previousKind=${decision.payload.previousKind}`,
  );
  check(
    "decision carries no approvalId (it IS the scraped panel)",
    decision.payload.approvalId === undefined,
    `approvalId=${decision.payload.approvalId}`,
  );
  check(
    "decision is attributed to the completed run",
    decision.payload.runId === runId,
    `runId=${decision.payload.runId} run=${runId}`,
  );

  // consumer A — the delivery controller: the gate reads open again. With the
  // queue empty nothing races the read, so this is the literal canDeliver().
  await waitFor(() => (lastDelivery()?.deliverable ?? null) === true, 15_000, "the gate reading open");
  const gateOpen = lastDelivery()?.deliverable ?? null;
  check("canDeliver() is true after the release", gateOpen === true);

  // consumer B — the renderer transport: the decision is in `events`, i.e. it
  // was handed to sendEvent (asserted above; this line names the consumer).
  // consumer C — the run-index: a decision row lands in the durable report.
  await waitFor(() => reportDecisionRows(taskId).length > 0, 15_000, "the run-index decision row");
  const reportDecisions = reportDecisionRows(taskId);
  check(
    "the run-index recorded exactly one decision",
    reportDecisions.length === 1,
    `rows=${reportDecisions.length}`,
  );
  check(
    "the run-index row is the same decision",
    reportDecisions[0]?.decision === "answered-natively" &&
      reportDecisions[0]?.encodedAs === "native-keys",
    JSON.stringify(reportDecisions[0]),
  );

  // --- 4. cli-state did NOT regress from turn-ended -------------------------
  // The whole reason this fix lives in the controller, and the assertion that
  // keeps a future "simplification" from moving the emit back into the host: a
  // host `emitEvent` reaches CliStateModel.applyRuntimeEvent, whose
  // `approval:decision` → `busy` rule overwrites the `turn-ended` the Stop hook
  // just set — and busy STICKS (cli-state's only other turn-enders are hooks and
  // `task:ready`, neither of which a hook-stop completion fires).
  //
  // Readable only because the queue was left EMPTY across the Stop: a released
  // send would drive cli-state busy legitimately and mask exactly this.
  await delay(800);
  const activityTrail = of("cli-state:changed").map((event) => event.payload.activity);
  check("cli-state settled at turn-ended", lastCliActivity() === "turn-ended", `activity=${lastCliActivity()}`);
  check(
    "the release emitted no cli-state change of its own",
    activityTrail.lastIndexOf("busy") < activityTrail.lastIndexOf("turn-ended"),
    JSON.stringify(activityTrail),
  );

  // --- 5. and the queue flows again -----------------------------------------
  // The operational half of consumer A, taken after the cli-state read so it
  // cannot contaminate it.
  controller.submitPrompt(taskId, queuedText);
  await waitFor(
    () => of("delivery:receipt").length >= 2,
    15_000,
    "a fresh send flowing through the reopened gate",
  );

  observed = {
    taskId,
    runId,
    detectedKind: detected.payload.kind,
    deliverableUnderPanel: gateClosed,
    decision: {
      decision: decision.payload.decision,
      encodedAs: decision.payload.encodedAs,
      previousKind: decision.payload.previousKind,
      runId: decision.payload.runId,
      approvalId: decision.payload.approvalId ?? null,
    },
    deliverableAfterRelease: gateOpen,
    runIndexDecisions: reportDecisions.map((row) => ({
      action: row.action,
      decision: row.decision,
      encodedAs: row.encodedAs,
    })),
    cliActivityTrail: activityTrail,
  };
} catch (error) {
  failures.push(`threw: ${error instanceof Error ? error.stack : String(error)}`);
} finally {
  const success = failures.length === 0;
  console.log(
    JSON.stringify(
      { ...observed, ...(success ? {} : { eventTypes: events.map((e) => e.type), lastDelivery: lastDelivery() }), failures, success },
      null,
      2,
    ),
  );
  process.exitCode = success ? 0 : 1;
  try {
    controller.dispose();
  } catch {
    // teardown against a fake pty is not the assertion
  }
  await delay(300);
  fs.rmSync(tempRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}

// Mirrors runtime-controller's module-private runtimeReportPath(projectRecordRoot(taskId)).
function reportDecisionRows(taskId) {
  const file = path.join(projectRecordRoot(taskId), "runtime-report.json");
  if (!fs.existsSync(file)) {
    return [];
  }
  let report;
  try {
    report = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return []; // mid-flush read; the caller polls
  }
  const rows = [];
  for (const run of report.runs ?? []) {
    // `approvalEvents` is the run-index's own field name (RunIndex.recordApprovalEvent).
    for (const entry of run.approvalEvents ?? []) {
      if (entry.action === "decision") {
        rows.push(entry);
      }
    }
  }
  for (const entry of report.unassignedApprovals ?? []) {
    if (entry.action === "decision") {
      rows.push(entry);
    }
  }
  return rows;
}

async function waitFor(predicate, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) {
      return true;
    }
    await delay(100);
  }
  throw new Error(`Timed out waiting for ${label}.`);
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
