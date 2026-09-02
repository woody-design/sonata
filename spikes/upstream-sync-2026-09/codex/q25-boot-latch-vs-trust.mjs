// Q25 (2026-09 sync, SL-6) — does the boot latch open BEFORE the trust dialog,
// and if so what does the first delivery do?
//
// WHY THIS PROBE EXISTS. q20 measured something the inventory's codex boot rows
// do not describe: under the production spawn at 0.152.0, codex paints a
// COMPOSER-SHAPED startup draft (`› Ask Codex to do anything`, `model: loading`)
// at ~147ms, and only replaces it with the directory-trust screen at ~268ms.
// Sonata's readiness scan reads that draft as an idle composer, so
// `acceptsPromptInput()` is TRUE for ~120ms before the dialog exists. The
// `bootDialogHints` guard cannot help there — the needles are not on the screen
// yet — and `DeliveryController`'s boot latch is ONE-WAY: it flips on the first
// true reading and "the scrape never re-gates delivery (send-is-send)".
//
// So the derivable claim is: a queued first prompt is delivered at latch+500ms
// (the boot-delivery grace), by which time the trust dialog owns the screen, and
// its text + Enter go into that dialog. That claim is DERIVED. This probe makes
// it MEASURED — with the production `DeliveryController` and the production
// `TerminalHost`, not a replica — because "I read the code and it looked
// dangerous" is not the evidence standard this program holds (F16).
//
// FOUR ARMS. The first two measure what a production spawn actually does; the
// last two arrange the race the first two are exposed to but did not hit.
//   pretrusted        CONTROL. Sonata's ledger entry present → no dialog. Proves
//                     the rig delivers a first prompt correctly, so a failure in
//                     another arm is attributable to the dialog, not the harness.
//   untrusted-plain   no ledger → the dialog paints, with the NATURAL pump
//                     cadence. `pump()` runs on enqueue, on every non-pty:data
//                     runtime event, and on a 500ms retry while an item is
//                     blocked — so whether the latch catches the ~120ms draft
//                     window is a RACE on pump phase, and this arm records which
//                     way it fell.
//   untrusted-forced  the same, with the race ARRANGED: a benign runtime event
//                     is fed to the delivery controller every 25ms through the
//                     draft window, which is what any hook/approval/run event
//                     landing in that window would do. The TRIGGER is arranged;
//                     the FRAME is real (the q8 precedent).
//   untrusted-forced-digit  the forced arm with a prompt containing `2`. The
//                     widget's key table (onboarding/trust_directory.rs) maps
//                     SELECT_SECOND straight to `handle_quit()` with no
//                     confirmation, so this asks whether an ordinary sentence
//                     can kill the session.
//
// SAFETY. Every arm runs in an ISOLATED CODEX_HOME under /private/tmp with a
// throwaway workspace, so a trust grant this probe provokes lands in a directory
// that is deleted afterwards and can never touch the user's own ledger. The
// RED LINE ("Sonata never answers this dialog") is what is being TESTED here,
// not waived: reproducing a violation inside a sealed sandbox is how it stops
// being a hypothesis.
import fs from "node:fs";
import path from "node:path";
import {
  CodexBoot,
  EXPECT_CODEX_VERSION,
  assertCodexVersion,
  codexVersion,
  isCodexTrustDialog,
  runtime,
  seedCodexHome,
  sanitize,
  sleep,
  writeCapture,
} from "./driver.mjs";

const { DeliveryController } = runtime;

const OUT_DIR = new URL(".", import.meta.url).pathname;
const ROOT = "/private/tmp/sonata-sync-2026-09/codex-boot-latch";
const COLS = 120;
const ROWS = 40;
const WATCH_MS = 25_000;

const ARMS = {
  pretrusted: {
    why: "CONTROL — ledger present, no dialog; the first prompt must reach the composer",
    pretrust: true,
    prompt: "Say hello and stop.",
  },
  "untrusted-plain": {
    why: "no ledger, NATURAL pump cadence — records which way the latch race fell",
    pretrust: false,
    prompt: "Say hello and stop.",
  },
  "untrusted-forced": {
    why: "no ledger, pump forced through the draft window — what any boot-time runtime event would do",
    pretrust: false,
    prompt: "Say hello and stop.",
    forcePumpThroughDraftWindow: true,
  },
  "untrusted-forced-digit": {
    why: "the forced arm with a `2` in the prompt — the widget maps SELECT_SECOND to handle_quit() with no confirmation",
    pretrust: false,
    prompt: "Summarize the 2 files here.",
    forcePumpThroughDraftWindow: true,
  },
};

/** The window q20 measured between the startup draft's composer and the trust
 *  screen replacing it: ready went true at 148ms and false at 268ms. Pumping
 *  across it (plus margin on both sides) is the arranged race. */
const DRAFT_WINDOW_MS = 500;
const FORCED_PUMP_EVERY_MS = 25;

async function run(armName) {
  const spec = ARMS[armName];
  const runRoot = path.join(ROOT, armName);
  fs.rmSync(runRoot, { recursive: true, force: true });
  const workspace = path.join(runRoot, "workspace");
  const runtimeDir = path.join(runRoot, "runtime");
  fs.mkdirSync(workspace, { recursive: true });
  fs.mkdirSync(runtimeDir, { recursive: true });
  fs.writeFileSync(path.join(workspace, "README.md"), "probe workspace\n");

  const codexHome = seedCodexHome(path.join(runRoot, "codex-home"));

  const boot = new CodexBoot({
    taskId: `task-q25-${armName}`,
    cwd: workspace,
    runtimeDir,
    binDir: path.join(runRoot, "bin"),
    pretrustCwd: spec.pretrust ? workspace : null,
    codexHome,
    rows: ROWS,
    cols: COLS,
    approvalBroker: true,
  });

  const out = {
    arm: armName,
    why: spec.why,
    version: codexVersion(),
    prompt: spec.prompt,
    pretrustCwd: spec.pretrust ? workspace : null,
    deliveryStates: [],
    frames: [],
    timeline: [],
    screenAtDelivery: null,
    dialogEverOnScreen: false,
    dialogOnScreenAtDelivery: null,
  };

  const delivery = new DeliveryController({
    taskId: `task-q25-${armName}`,
    provider: "codex",
    terminalHost: boot.host,
    eventSink: (event) => {
      if (event.type !== "delivery:state") return;
      const item = event.payload.queue?.[0] ?? null;
      const row = {
        atMs: boot.at(),
        bootLatched: event.payload.bootLatched,
        deliverable: event.payload.deliverable,
        itemStatus: item?.status ?? null,
        failureReason: item?.failureReason ?? null,
      };
      const previous = out.deliveryStates.at(-1);
      if (
        !previous ||
        previous.bootLatched !== row.bootLatched ||
        previous.deliverable !== row.deliverable ||
        previous.itemStatus !== row.itemStatus ||
        previous.failureReason !== row.failureReason
      ) {
        out.deliveryStates.push(row);
        // The instant the item leaves the queue is the instant that matters:
        // freeze the screen it was written into.
        if (row.itemStatus === "delivering" && out.screenAtDelivery === null) {
          out.screenAtDelivery = boot.screen();
          out.dialogOnScreenAtDelivery = isCodexTrustDialog(out.screenAtDelivery);
          out.deliveredAtMs = row.atMs;
        }
      }
    },
    hasLiveTranscriptSource: () => false,
    // Production defaults everywhere — the grace and the retry ladder ARE the
    // mechanism under test, so nothing here is shortened.
  });

  try {
    await boot.start();
    // The prompt is queued at spawn, which is what a task created with an
    // initial prompt does.
    delivery.enqueue(spec.prompt);

    // The arranged race. `task:started` is chosen because it is a real event
    // the production controller forwards verbatim, carries no delivery-gate
    // side effect (see DeliveryController.handleRuntimeEvent — it falls through
    // every branch), and therefore does nothing but pump. That isolates the
    // variable to pump PHASE.
    let forcedPumps = 0;
    if (spec.forcePumpThroughDraftWindow) {
      const forcedUntil = Date.now() + DRAFT_WINDOW_MS;
      const timer = setInterval(() => {
        if (Date.now() > forcedUntil) {
          clearInterval(timer);
          return;
        }
        forcedPumps += 1;
        delivery.handleRuntimeEvent({
          type: "task:started",
          payload: { taskId: `task-q25-${armName}` },
          ts: new Date().toISOString(),
        });
      }, FORCED_PUMP_EVERY_MS);
    }

    let lastFrame = null;
    const deadline = Date.now() + WATCH_MS;
    while (Date.now() < deadline) {
      const frameText = boot.screen();
      if (isCodexTrustDialog(frameText)) out.dialogEverOnScreen = true;
      if (frameText !== lastFrame) {
        out.frames.push({
          atMs: boot.at(),
          acceptsPromptInput: boot.ready(),
          isCodexTrustDialog: isCodexTrustDialog(frameText),
          screen: frameText,
        });
        lastFrame = frameText;
      }
      if (boot.ptyExited) {
        out.timeline.push({ atMs: boot.at(), what: "pty:exit", info: boot.exitInfo });
        break;
      }
      await sleep(100);
    }

    out.forcedPumps = forcedPumps;
    out.finalScreen = boot.screen();
    out.ptyExited = boot.ptyExited;
    out.exitInfo = boot.exitInfo;
    out.events = boot.events;
    // Did the grant land on disk? The dialog's "Yes, continue" writes a
    // `[projects."<cwd>"]` block into the config of the home it is running in —
    // the most durable evidence that an Enter was answered by something.
    const configPath = path.join(codexHome, "config.toml");
    out.codexConfigAfter = fs.existsSync(configPath)
      ? fs.readFileSync(configPath, "utf8")
      : null;
    out.trustGrantedByThisRun =
      out.codexConfigAfter !== null && out.codexConfigAfter.includes(workspace);
  } catch (error) {
    out.error = String(error?.stack ?? error?.message ?? error);
  } finally {
    delivery.dispose();
    boot.dispose();
    await sleep(300);
  }

  return out;
}

function summarize(out) {
  return {
    arm: out.arm,
    why: out.why,
    version: out.version,
    prompt: out.prompt,
    pretrustCwd: out.pretrustCwd,
    dialogEverOnScreen: out.dialogEverOnScreen,
    forcedPumps: out.forcedPumps ?? 0,
    deliveryStates: out.deliveryStates,
    deliveredAtMs: out.deliveredAtMs ?? null,
    dialogOnScreenAtDelivery: out.dialogOnScreenAtDelivery,
    screenAtDelivery: out.screenAtDelivery,
    ptyExited: out.ptyExited,
    exitInfo: out.exitInfo,
    trustGrantedByThisRun: out.trustGrantedByThisRun,
    finalScreen: out.finalScreen,
    error: out.error ?? null,
  };
}

const arm = process.argv[2] ?? "pretrusted";
if (!ARMS[arm]) {
  console.error(`unknown arm ${arm}; expected one of ${Object.keys(ARMS).join(", ")}`);
  process.exit(64);
}
assertCodexVersion("start");
const result = await run(arm);
const endVersion = codexVersion();
result.endVersion = endVersion;
result.versionDrift = endVersion.includes(EXPECT_CODEX_VERSION)
  ? null
  : `codex drifted off ${EXPECT_CODEX_VERSION} mid-run: ${endVersion}`;
const outPath = writeCapture(OUT_DIR, `q25-boot-latch-vs-trust.${arm}.capture.txt`, result);
console.log(sanitize(JSON.stringify(summarize(result), null, 2)));
console.log(`\nwrote ${outPath}`);
process.exit(result.error || result.versionDrift ? 1 : 0);
