// Q26 (2026-09 sync, SL-6) — what a LOGGED-OUT codex boot does, and what the
// new boot-latch confidence gate does to it.
//
// TWO QUESTIONS, one spawn:
//
//  1. C1 left "onboarding appears when authentication is missing" (the 0.148
//     rework) UNREPRODUCED — every earlier arm seeded `auth.json`, so the login
//     step never had a reason to run. This arm removes the credential and
//     records what actually paints.
//
//  2. `acceptsFirstPrompt()` now requires MEDIUM confidence for codex — the
//     composer's `<model> <effort> · <cwd>` footer must have resolved. The
//     DELIBERATE consequence is that a codex spawn whose footer never resolves
//     never latches, so a queued prompt stays queued. That is claimed to be
//     honest rather than a wedge, on the grounds that such a session cannot run
//     a prompt anyway. A logged-out boot is the reachable instance of exactly
//     that, so this arm turns the claim into a measurement instead of leaving it
//     as an argument in a comment.
//
// The CONTROL is q25's `pretrusted` arm, re-run against the same build: an
// authenticated session must still latch and still deliver. A gate that holds
// the broken case by breaking the working one is not a fix.
//
// Isolated `CODEX_HOME` with NO auth.json; nothing outside /private/tmp is
// touched, and the user's real credentials are never read.
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
const ROOT = "/private/tmp/sonata-sync-2026-09/codex-unauthenticated";
const COLS = 120;
const ROWS = 40;
const WATCH_MS = 20_000;

/** Login/onboarding needles, read off `tui/src/onboarding/auth.rs` at the pinned
 *  tag. Hypotheses — the frames decide. */
const LOGIN_RE =
  /Sign in with ChatGPT|Sign in with Device Code|Use an OpenAI API key|Finish signing in via your browser|Welcome to Codex/i;

async function run() {
  fs.rmSync(ROOT, { recursive: true, force: true });
  const workspace = path.join(ROOT, "workspace");
  const runtimeDir = path.join(ROOT, "runtime");
  fs.mkdirSync(workspace, { recursive: true });
  fs.mkdirSync(runtimeDir, { recursive: true });
  // NO auth.json — this is the whole variable.
  const codexHome = seedCodexHome(path.join(ROOT, "codex-home"), { withAuth: false });

  const boot = new CodexBoot({
    taskId: "task-q26-unauth",
    cwd: workspace,
    runtimeDir,
    binDir: path.join(ROOT, "bin"),
    // Pre-trusted, so the DIRECTORY-trust screen cannot appear and confound the
    // question: the only interstitial left is the login one.
    pretrustCwd: workspace,
    codexHome,
    rows: ROWS,
    cols: COLS,
    approvalBroker: true,
  });

  const out = {
    probe: "q26-unauthenticated-latch",
    version: codexVersion(),
    workspace,
    deliveryStates: [],
    frames: [],
    loginScreenAtMs: null,
    loginFrame: null,
  };

  const delivery = new DeliveryController({
    taskId: "task-q26-unauth",
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
      };
      const previous = out.deliveryStates.at(-1);
      if (
        !previous ||
        previous.bootLatched !== row.bootLatched ||
        previous.deliverable !== row.deliverable ||
        previous.itemStatus !== row.itemStatus
      ) {
        out.deliveryStates.push(row);
      }
    },
    hasLiveTranscriptSource: () => false,
  });

  try {
    await boot.start();
    delivery.enqueue("Say hello and stop.");

    // Pump hard across the whole boot — the same arranged race q25 used. If the
    // latch can open on a logged-out boot at all, this is what finds it.
    let forcedPumps = 0;
    const timer = setInterval(() => {
      forcedPumps += 1;
      delivery.handleRuntimeEvent({
        type: "task:started",
        payload: { taskId: "task-q26-unauth" },
        ts: new Date().toISOString(),
      });
    }, 25);

    let lastFrame = null;
    const deadline = Date.now() + WATCH_MS;
    while (Date.now() < deadline) {
      const frameText = boot.screen();
      if (frameText !== lastFrame) {
        out.frames.push({
          atMs: boot.at(),
          acceptsPromptInput: boot.ready(),
          acceptsFirstPrompt: boot.host.acceptsFirstPrompt(),
          isCodexTrustDialog: isCodexTrustDialog(frameText),
          screen: frameText,
        });
        lastFrame = frameText;
      }
      if (out.loginScreenAtMs === null && LOGIN_RE.test(frameText)) {
        out.loginScreenAtMs = boot.at();
        out.loginFrame = frameText;
      }
      if (boot.ptyExited) break;
      await sleep(100);
    }
    clearInterval(timer);
    out.forcedPumps = forcedPumps;

    out.finalScreen = boot.screen();
    out.ptyExited = boot.ptyExited;
    out.exitInfo = boot.exitInfo;
    out.events = boot.events;
    out.everLatched = out.deliveryStates.some((row) => row.bootLatched);
    out.everDelivered = out.deliveryStates.some((row) => row.itemStatus === "delivering");
    out.finalItemStatus = out.deliveryStates.at(-1)?.itemStatus ?? null;
    // The two predicates side by side at the end — the whole point of the split.
    out.finalAcceptsPromptInput = boot.ready();
    out.finalAcceptsFirstPrompt = boot.host.acceptsFirstPrompt();
  } catch (error) {
    out.error = String(error?.stack ?? error?.message ?? error);
  } finally {
    delivery.dispose();
    boot.dispose();
    await sleep(300);
  }
  return out;
}

assertCodexVersion("start");
const result = await run();
const endVersion = codexVersion();
result.endVersion = endVersion;
result.versionDrift = endVersion.includes(EXPECT_CODEX_VERSION)
  ? null
  : `codex drifted off ${EXPECT_CODEX_VERSION} mid-run: ${endVersion}`;
const outPath = writeCapture(OUT_DIR, "q26-unauthenticated-latch.capture.txt", result);
console.log(
  sanitize(
    JSON.stringify(
      {
        version: result.version,
        loginScreenAtMs: result.loginScreenAtMs,
        loginFrame: result.loginFrame,
        forcedPumps: result.forcedPumps,
        deliveryStates: result.deliveryStates,
        everLatched: result.everLatched,
        everDelivered: result.everDelivered,
        finalItemStatus: result.finalItemStatus,
        finalAcceptsPromptInput: result.finalAcceptsPromptInput,
        finalAcceptsFirstPrompt: result.finalAcceptsFirstPrompt,
        finalScreen: result.finalScreen,
        ptyExited: result.ptyExited,
        error: result.error ?? null,
      },
      null,
      2,
    ),
  ),
);
console.log(`\nwrote ${outPath}`);
process.exit(result.error ? 1 : 0);
