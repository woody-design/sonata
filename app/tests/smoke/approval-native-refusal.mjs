// The native-key fallback refuses without a panel (ask-flows S2 / B2) — on the
// REAL RuntimeController.
//
// `RuntimeController.decideApproval` answers a hook-broker ask on the reply
// channel. When the broker entry is MISSING (never existed) or already CONSUMED
// (the first click of a double-click took it), the call falls through to the
// claude native-key branch — which used to write unconditionally:
// `sendApprovalDecision("approve")` has a legacy CSI-u Enter fallback and
// `sendDeny()` writes a bare Esc with no guard. Those keys land on whatever owns
// the screen by then: stray digits/Enter into a composer, and — the documented
// harm — two Escs ≤700ms apart, which is claude's Rewind-panel opener, over a run
// that is actually continuing.
//
// The fix is a screen-ownership check: the fallback runs only while
// `isApprovalActive()` holds. A LIVE scraped card always reads true, so the
// refusal drops only writes that would land on an unowned screen. This fence
// pins both sides of that claim, in three phases on one task:
//
//   PHASE 1 — no panel anywhere. A stale/unknown approvalId AND a null
//     approvalId must each write NOTHING to the PTY and emit NO
//     `approval:decision`.
//   PHASE 2 — a live scraped panel. A deny still answers exactly as before:
//     one bare Esc on the wire, one deny/Esc decision. (Regression guard: the
//     refusal must not cost the legitimate path.)
//   PHASE 3 — the double-click itself. `sendDeny` clears `approvalActive`
//     synchronously, so the second deny arrives at an unowned screen: no second
//     Esc, no second decision. Without the guard this is the Esc PAIR.
//
// The whole path is production wire, because the reachability cannot be faked
// honestly: claude runs BROKER-ON under the controller, so the grid scrape is
// gated shut until a broker ask EXPIRES. Phase 2 therefore drives a real
// `ask-<id>.json` and a real `expired-<id>.json` through the real
// ApprovalWatcher — which arms `brokerExpiryResurfaceAt` and lets the scrape
// surface the native card the fake is painting.
//
// Fixture bytes: the approval panel frame is ADAPTED from
// tests/smoke/stop-hook-orphan-approval.mjs (itself ADAPTED from
// submit-approval-guard.mjs — claude file-edit panel, legacy hint grammar, so
// the shared detector takes the hint-fallback path and sets approvalActive). The
// idle-composer and activity frames are COMPOSED — the minimum bytes satisfying
// detectIdlePrompt's ordering rule and the claude activityHints vocabulary.
// Harness shape lifted from stop-hook-orphan-approval.mjs.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "sonata-approval-native-refusal-"));
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
const { approvalsDirectory } = require("../../dist/runtime/cli-signal/approval-protocol");

// Mirrors of the two key sequences the fallback can write, built from char codes
// so no control byte is a literal in this source file. A BARE Esc is the deny;
// every other byte Sonata writes that starts with \x1b is a CSI sequence, so the
// negative lookahead is what tells the interrupt from ordinary keys.
const BARE_ESC = "\\u001b(?![[O])";
const CSI_U_ENTER = `${String.fromCharCode(0x1b)}[13u`;

const promptText = "Please edit native-refusal.txt";
const inputLogPath = path.join(workspace, "stdin.log");
// The fake paints the native card only while this exists — so phase 1 runs over
// a genuinely panel-free screen, and phase 2 gets its card on demand.
const panelMarker = path.join(workspace, "paint-panel");
const askId = "native-refusal-ask-1";
const staleAskId = "native-refusal-stale-id";

// A fake `claude`: idle composer at boot; once the prompt lands it repaints an
// activity line on a 300ms tick (so the turn never reads as quiescent), adding
// the file-edit panel while the marker exists. A bare Esc is the deny — it stops
// the tick and repaints past the panel, exactly as the TUI does.
fs.writeFileSync(
  path.join(binDir, "claude"),
  `#!/usr/bin/env node
"use strict";
const fs = require("node:fs");
const COMPOSER = "\\u001b[2J\\u001b[HFake Claude ready\\n\\u276f sonnet high ~  ? for shortcuts\\n";
const bareEsc = /${BARE_ESC}/;
process.stdin.setEncoding("utf8");
if (process.stdin.isTTY) { process.stdin.setRawMode(true); }
process.stdin.resume();
process.stdout.write(COMPOSER);
let seen = "";
let asked = false;
let timer = null;
process.stdin.on("data", (data) => {
  fs.appendFileSync(${JSON.stringify(inputLogPath)}, data);
  seen += data;
  if (timer && bareEsc.test(data)) {
    // The deny landed and the TUI repaints PAST the panel. Clearing the screen
    // is what makes the grid honestly panel-free afterwards.
    clearInterval(timer);
    timer = null;
    process.stdout.write(COMPOSER);
    return;
  }
  // Echo what was pasted, as a real composer does — that is what earns the
  // pty-composer-echo receipt, without which the delivered prompt stays in
  // flight and the queue never settles.
  const echoed = data.replace(/\\u001b\\[[0-9;]*[A-Za-z~]/g, "").replace(/[\\u0000-\\u001f]/g, " ").trim();
  if (echoed) {
    process.stdout.write(echoed + "\\n");
  }
  if (!asked && seen.includes(${JSON.stringify(promptText)})) {
    asked = true;
    timer = setInterval(() => {
      process.stdout.write("\\u001b[2J\\u001b[H");
      process.stdout.write("\\u271b Cerebrating\\u2026 (esc to interrupt)\\n");
      if (fs.existsSync(${JSON.stringify(panelMarker)})) {
        process.stdout.write("\\nAllow this edit?\\n");
        process.stdout.write("- native-refusal.txt\\n");
        process.stdout.write("Enter to confirm\\n");
      }
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

const fireAsk = (taskId, id, payload) =>
  dropFile(approvalsDirectory(runtimeDir(taskId)), `ask-${id}.json`, payload);
/** Give up on an ask exactly as the real broker does: drop `expired-<id>.json`
 *  AND remove its own `ask-<id>.json` (approval-broker.ts rmSync on the timeout
 *  path) — a surviving ask file re-surfaces on the watcher's next poll. */
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

// The refusal's other half is a LOG line — it is the only trace a dropped
// decision leaves, so capture it rather than let it scroll past.
const warnings = [];
const realWarn = console.warn;
console.warn = (...args) => {
  warnings.push(args.map(String).join(" "));
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
const decisions = () => of("approval:decision");
const scrapeDetections = () =>
  of("approval:detected").filter((event) => event.payload.approvalId === undefined);
const readLog = () => (fs.existsSync(inputLogPath) ? fs.readFileSync(inputLogPath, "utf8") : "");
const bareEscCount = () => (readLog().match(new RegExp(BARE_ESC, "g")) ?? []).length;
const refusalWarnings = () => warnings.filter((line) => line.includes("refusing native"));

let observed = {};

try {
  const created = await controller.createTask({ provider: "claude", cwd: workspace });
  const taskId = created.task.id;

  controller.submitPrompt(taskId, promptText);
  await waitFor(() => of("run:started").length > 0, 20_000, "the prompt starting a run");
  const runId = of("run:started")[0].payload.id;
  // The echo receipt settles the queue, so nothing is mid-delivery when the
  // byte log is read as a baseline below.
  await waitFor(
    () => (of("delivery:state").at(-1)?.payload.queue ?? []).length === 0,
    15_000,
    "the prompt's echo receipt",
  );
  // …and the send's own Enter-retry heal ladder must be spent too: a rung writes
  // a CSI-u Enter, the very byte the approve fallback would write, so a rung
  // landing inside the measurement window would read as a refusal breach
  // (MEASURED: rung 0 fires 2.5s after the delivery — 250ms past a 2s quiet
  // window). The quiet window is therefore wider than the ladder's own largest
  // gap (rungs at 2.5s and 6s ⇒ 3.5s), so it cannot resolve between two rungs.
  await waitForWireQuiet(4_000, 30_000);

  // === PHASE 1: no panel anywhere — both shapes of a missing broker entry ====
  check("no approval has been detected yet", of("approval:detected").length === 0);
  const logBeforeRefusals = readLog();
  const escsBeforeRefusals = bareEscCount();

  // (a) a STALE approvalId — the shape a double-click takes once the first
  //     click has consumed the broker entry, and a reopened session's card.
  await controller.decideApproval(taskId, "approve", staleAskId);
  // (b) approvalId null — the scrape-card shape, with no scraped card live.
  await controller.decideApproval(taskId, "deny", null);
  await delay(600); // any write would be on the wire long before this

  const refusalWindow = readLog().slice(logBeforeRefusals.length);
  check(
    "the stale-id approve wrote no native approval key",
    !refusalWindow.includes(CSI_U_ENTER),
    `window=${JSON.stringify(refusalWindow.slice(0, 120))}`,
  );
  check(
    "the null-id deny wrote NO Esc",
    bareEscCount() === escsBeforeRefusals,
    `escs=${bareEscCount()} before=${escsBeforeRefusals}`,
  );
  check(
    "the refused decisions put nothing at all on the wire",
    refusalWindow === "",
    `window=${JSON.stringify(refusalWindow.slice(0, 120))}`,
  );
  check("no approval:decision was emitted", decisions().length === 0, `count=${decisions().length}`);
  check(
    "both refusals named their dropped decision in the log",
    refusalWarnings().length === 2 &&
      refusalWarnings()[0].includes("approve") &&
      refusalWarnings()[1].includes("deny"),
    JSON.stringify(refusalWarnings()),
  );

  // === PHASE 2: a live scraped panel still answers exactly as today =========
  // Broker ask first (claude is broker-ON, so the scrape is gated shut until an
  // ask EXPIRES), with the card painted while the broker holds — as the real CLI
  // paints it.
  fs.writeFileSync(panelMarker, "", "utf8");
  fireAsk(taskId, askId, {
    payload: {
      hook_event_name: "PermissionRequest",
      tool_name: "Edit",
      tool_input: { file_path: "native-refusal.txt" },
    },
  });
  await waitFor(
    () => of("approval:detected").some((event) => event.payload.approvalId === askId),
    15_000,
    "the broker card",
  );
  fireExpiry(taskId, askId);
  await waitFor(() => of("approval:expired").length > 0, 15_000, "the broker expiry");
  await waitFor(() => scrapeDetections().length > 0, 20_000, "the scrape surfacing the panel");
  const detected = scrapeDetections()[0];
  check(
    "the scraped panel is a file-edit ask",
    detected.payload.kind === "file-edit",
    `kind=${detected.payload.kind}`,
  );

  // The expiry consumed the broker entry, so this deny takes the native
  // fallback — with a panel on screen, which is the case the guard must let
  // through untouched.
  await controller.decideApproval(taskId, "deny", null);
  await delay(300);

  const decision = decisions()[0];
  check("exactly one approval:decision", decisions().length === 1, `count=${decisions().length}`);
  check(
    "the live panel answered deny/Esc",
    decision?.payload.decision === "deny" && decision?.payload.encodedAs === "Esc",
    `decision=${decision?.payload.decision} encodedAs=${decision?.payload.encodedAs}`,
  );
  check(
    "the decision carries the scraped ask's kind",
    decision?.payload.previousKind === "file-edit",
    `previousKind=${decision?.payload.previousKind}`,
  );
  const escsAfterAnswer = bareEscCount();
  check("exactly one bare Esc on the wire", escsAfterAnswer === 1, `count=${escsAfterAnswer}`);
  check(
    "answering a live panel logged no refusal",
    refusalWarnings().length === 2,
    JSON.stringify(refusalWarnings()),
  );

  // === PHASE 3: the double-click — the second deny is refused ===============
  // `sendDeny` clears approvalActive synchronously, so the second click arrives
  // at an unowned screen. Without the guard this is the Esc PAIR ≤700ms apart.
  const logBeforeSecondClick = readLog();
  await controller.decideApproval(taskId, "deny", null);
  await delay(600);

  const secondClickWindow = readLog().slice(logBeforeSecondClick.length);
  const escsAfterSecondClick = bareEscCount();
  check(
    "the second deny wrote no second Esc",
    escsAfterSecondClick === 1,
    `count=${escsAfterSecondClick}`,
  );
  check(
    "the second deny wrote nothing at all",
    secondClickWindow === "",
    `window=${JSON.stringify(secondClickWindow.slice(0, 120))}`,
  );
  check(
    "the second deny emitted no decision",
    decisions().length === 1,
    `count=${decisions().length}`,
  );
  check(
    "the second deny was logged as a refusal",
    refusalWarnings().length === 3 && refusalWarnings()[2].includes("deny"),
    JSON.stringify(refusalWarnings()),
  );

  observed = {
    taskId,
    runId,
    detectedKind: detected.payload.kind,
    decisions: decisions().map((event) => ({
      decision: event.payload.decision,
      encodedAs: event.payload.encodedAs,
      previousKind: event.payload.previousKind,
    })),
    bareEscCount: escsAfterSecondClick,
    refusalWarnings: refusalWarnings(),
  };
} catch (error) {
  failures.push(`threw: ${error instanceof Error ? error.stack : String(error)}`);
} finally {
  console.warn = realWarn;
  const success = failures.length === 0;
  console.log(
    JSON.stringify(
      {
        ...observed,
        ...(success ? {} : { eventTypes: events.map((event) => event.type), warnings }),
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
    // teardown against a fake pty is not the assertion
  }
  await delay(300);
  fs.rmSync(tempRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}

/** Resolve once no byte has reached the PTY for `quietMs` — the baseline every
 *  "wrote nothing" assertion here is measured from. */
async function waitForWireQuiet(quietMs, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let last = readLog().length;
  let quietSince = Date.now();
  while (Date.now() < deadline) {
    await delay(100);
    const size = readLog().length;
    if (size !== last) {
      last = size;
      quietSince = Date.now();
    } else if (Date.now() - quietSince >= quietMs) {
      return true;
    }
  }
  throw new Error("Timed out waiting for the PTY wire to go quiet.");
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
