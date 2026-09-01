// Layer-2a verification — the persist chain end-to-end against a fake
// claude CLI speaking the 2.1.176 panel grammar:
//   v2 panel with a "don't ask again" option → detector offers
//   approve-always → sendApproveAlways() answers with digit 2 → the CLI
//   (not Sonata) writes .claude/settings.local.json → the receipt watcher
//   observes the write → approval:persisted carries the EXACT rule → the
//   runtime report holds the full forensic trail (detected → decision →
//   persisted).

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { RunIndex, TerminalHost, isRunIndexEvent } = require("../../dist/runtime");

const taskId = "task-approval-persist-receipt-smoke";
const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "sonata-approval-persist-receipt-smoke-"));
const scriptPath = path.join(workspace, "fake-claude-persist-cli.mjs");
const reportPath = path.join(workspace, ".sonata", "runtime-report.json");
const settingsPath = path.join(workspace, ".claude", "settings.local.json");

fs.writeFileSync(
  scriptPath,
  `
import fs from "node:fs";
import path from "node:path";
if (process.stdin.isTTY) {
  process.stdin.setRawMode(true);
}
process.stdin.resume();
let promptSubmitted = false;
let approvalShown = false;

function showApproval() {
  approvalShown = true;
  process.stdout.write("\\nThinking with fake Claude\\n");
  process.stdout.write(" Bash command\\n\\n");
  process.stdout.write("md5 -q /tmp/data.txt\\n");
  process.stdout.write("Compute md5 hash of probe data file\\n\\n");
  process.stdout.write("This command requires approval\\n");
  process.stdout.write("Do you want to proceed?\\n\\n");
  process.stdout.write("\\u276F1.Yes\\n\\n");
  process.stdout.write("2.Yes, and don't ask again for: md5 *\\n\\n");
  process.stdout.write("3.No\\n\\n");
  process.stdout.write("Esc to cancel \\u00B7 Tab to amend \\u00B7 ctrl+e to explain\\n");
}

process.stdout.write("Fake Claude ready\\n\\u276F opus xhigh ~\\n");

let pasteSeen = false;
process.stdin.on("data", (data) => {
  const text = data.toString("utf8");
  if (!promptSubmitted) {
    // Production submits paste and Enter as separate writes (+120ms).
    if (text.includes("\\x1b[200~")) {
      pasteSeen = true;
    }
    if (pasteSeen && text.includes("\\x1b[13u")) {
      promptSubmitted = true;
      setTimeout(showApproval, 50);
    }
    return;
  }
  if (!approvalShown) {
    return;
  }
  if (text === "2") {
    // The CLI owns the write — Sonata only observes it.
    const dir = path.join(process.cwd(), ".claude");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, "settings.local.json"),
      JSON.stringify({ permissions: { allow: ["Bash(md5 *)"] } }, null, 2),
    );
    process.stdout.write("Thinking with fake Claude\\n");
    process.stdout.write("sonata-fake-md5-hash\\n");
    process.stdout.write("Persist approval accepted.\\n\\u276F opus xhigh ~\\n");
  }
});
`,
  "utf8",
);

const events = [];
const runIndex = new RunIndex({ taskId, reportPath });
const host = new TerminalHost({
  taskId,
  provider: "claude",
  defaultWorkspace: workspace,
  eventSink: (event) => {
    if (event.type === "pty:data" || event.type === "report:updated") {
      return;
    }
    events.push(event);
    // Mirror the controller's consume boundary (OBS S6): file:changed LEFT the
    // run-index allowlist, so only real RunIndex events cross into consume.
    if (isRunIndexEvent(event)) {
      runIndex.consume(event);
    }
  },
  completionQuietMs: 600,
});

try {
  host.startTask({
    approvalBroker: false, // S2: drives the scrape/keys fallback (broker verified in s2b-e2e-verify)
    cwd: workspace,
    command: process.execPath,
    args: [scriptPath],
    approval: "never",
    rows: 24,
    cols: 110,
  });

  host.submitPrompt("Trigger a fake Claude persistent command approval.");
  await waitUntil(
    () => {
      const detected = events.find(
        (event) => event.type === "approval:detected" && event.payload.kind === "command",
      );
      return Boolean(
        detected?.payload.choices?.some((choice) => choice.decision === "approve-always"),
      );
    },
    5000,
    "command approval offering approve-always",
  );

  await host.sendApproveAlways();
  await waitUntil(
    () =>
      events.some(
        (event) =>
          event.type === "approval:decision" &&
          event.payload.decision === "approve-always" &&
          event.payload.encodedAs === "digit 2",
      ),
    5000,
    "approve-always decision event",
  );
  await waitUntil(() => fs.existsSync(settingsPath), 5000, "CLI-written settings.local.json");
  await waitUntil(
    () =>
      events.some(
        (event) =>
          event.type === "approval:persisted" &&
          event.payload.rulesAdded.includes("Bash(md5 *)") &&
          event.payload.file === path.join(".claude", "settings.local.json"),
      ),
    10_000,
    "approval:persisted receipt",
  );

  const run = runIndex.read().runs.at(-1) ?? null;
  const approvalEvents = run?.approvalEvents ?? [];
  const success =
    approvalEvents.some(
      (event) =>
        event.action === "detected" &&
        event.kind === "command" &&
        event.choices?.some((choice) => choice.decision === "approve-always"),
    ) &&
    approvalEvents.some(
      (event) => event.action === "decision" && event.decision === "approve-always",
    ) &&
    approvalEvents.some(
      (event) => event.action === "persisted" && event.rulesAdded?.includes("Bash(md5 *)"),
    );

  console.log(
    JSON.stringify(
      {
        workspace,
        approvalEvents,
        settingsWritten: fs.existsSync(settingsPath),
        success,
      },
      null,
      2,
    ),
  );
  process.exitCode = success ? 0 : 1;
} finally {
  host.dispose();
  fs.rmSync(workspace, { recursive: true, force: true });
}

async function waitUntil(predicate, timeoutMs, label) {
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
