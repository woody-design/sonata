import fs from "node:fs";
import path from "node:path";
import {
  claudeStatuslineCommand,
  claudeUsageDirectory,
  shellQuote,
  writeJsonIfChanged,
} from "../usage/claude-statusline";
import type { HookEventName } from "../../shared/types/cli-signal";

/**
 * The single `--settings` file duet injects into every Claude spawn. It carries
 * BOTH the statusLine sink (usage) AND the hooks sink (signal layer). Phase 0
 * proved hooks UNION across all settings sources, so injecting our hooks here
 * does NOT clobber the user's own `~/.claude/settings.json` or project hooks —
 * we deliberately write ONLY duet's entries and let Claude merge.
 */

/** Where the hook sink drops payload files; watched by HookWatcher. */
export function claudeHooksDirectory(runtimeDir: string): string {
  return path.join(runtimeDir, "hooks");
}

// Broker (S2): how long it HOLDS the CLI waiting for Duet's card answer before
// giving up to the native panel. The hook's own timeout must exceed it so the
// CLI doesn't kill the broker mid-poll (which would look like a crash, not a
// graceful fallback).
const APPROVAL_BROKER_TIMEOUT_MS = 60_000;
const APPROVAL_HOOK_TIMEOUT_S = 120;

/**
 * Fire-and-forget hook events duet injects (the sink). UserPromptSubmit/
 * PreToolUse drive busy, Stop drives turn-end. The rest corroborate.
 * `PermissionRequest` is DELIBERATELY absent — it is owned by the approval
 * BROKER (S2), which holds the CLI and answers from the Reading card; a second
 * fire-and-forget sink on it would double-write the payload.
 */
const INJECTED_HOOK_EVENTS: HookEventName[] = [
  "SessionStart",
  "UserPromptSubmit",
  "PreToolUse",
  "PostToolUse",
  "Notification",
  "Stop",
  // Fires when a turn ends by FAILING (API error after retries) — Stop stays
  // silent then; payload carries a structured `error` (probed S6,
  // s6-diags/stopfailure-probe). Completes the run + ends cli-state busy.
  "StopFailure",
  "SubagentStop",
];

/** Events scoped by a tool/notification matcher; the rest take a bare entry. */
const MATCHER_EVENTS = new Set<HookEventName>(["PreToolUse", "PostToolUse", "Notification"]);

interface ClaudeHookCommandEntry {
  type: "command";
  command: string;
  timeout?: number;
}

interface ClaudeHookMatcherGroup {
  matcher?: string;
  hooks: ClaudeHookCommandEntry[];
}

interface ClaudeRuntimeSettings {
  statusLine: { type: "command"; command: string };
  hooks: Record<string, ClaudeHookMatcherGroup[]>;
}

function buildHooks(
  sinkCommand: string,
  brokerCommand: string | null,
): Record<string, ClaudeHookMatcherGroup[]> {
  const hooks: Record<string, ClaudeHookMatcherGroup[]> = {};
  for (const event of INJECTED_HOOK_EVENTS) {
    const entry: ClaudeHookCommandEntry = { type: "command", command: sinkCommand };
    hooks[event] = MATCHER_EVENTS.has(event)
      ? [{ matcher: "*", hooks: [entry] }]
      : [{ hooks: [entry] }];
  }
  hooks.PermissionRequest = brokerCommand
    ? // The broker holds the CLI until Duet's card answers (or times out to the
      // native panel). Its hook timeout exceeds the broker's internal poll
      // ceiling so the CLI never kills it mid-decision.
      [{ matcher: "*", hooks: [{ type: "command", command: brokerCommand, timeout: APPROVAL_HOOK_TIMEOUT_S }] }]
    : // Native-approval mode (broker off): fall back to the fire-and-forget sink
      // (drives waiting-approval) + the scrape/keys answer path, as pre-S2.
      [{ matcher: "*", hooks: [{ type: "command", command: sinkCommand }] }];
  return hooks;
}

/** Where the broker drops ask/reply/expired files; watched by ApprovalWatcher. */
export function claudeApprovalsDirectory(runtimeDir: string): string {
  return path.join(runtimeDir, "approvals");
}

/**
 * Ensure (and return the path to) duet's merged Claude `--settings` file: the
 * statusLine sink + hook sink, both pointed at subdirs of `runtimeDir`.
 *
 * `runtimeDir` is the session's Duet-owned runtime home — `~/.duet/data/runtime/
 * <taskId>` in the app (D8), so nothing Duet-owned is written into the agent's
 * working directory. All three paths the file carries are absolute; G1 verified
 * Claude fires hooks from a `--settings` file located outside the agent cwd.
 */
export function ensureClaudeRuntimeSettings(
  runtimeDir: string,
  options: { approvalBroker?: boolean } = {},
): string {
  const usageDirectory = claudeUsageDirectory(runtimeDir);
  const hooksDirectory = claudeHooksDirectory(runtimeDir);
  const approvalsDirectory = claudeApprovalsDirectory(runtimeDir);
  fs.mkdirSync(usageDirectory, { recursive: true });
  fs.mkdirSync(hooksDirectory, { recursive: true });
  fs.mkdirSync(approvalsDirectory, { recursive: true });

  const sinkCommand = `node ${shellQuote(path.join(__dirname, "hook-sink.js"))} ${shellQuote(
    hooksDirectory,
  )}`;
  // Broker on by default; native-approval mode (opt-out) routes PermissionRequest
  // back to the scrape/keys fallback.
  const brokerCommand =
    options.approvalBroker === false
      ? null
      : `node ${shellQuote(path.join(__dirname, "approval-broker.js"))} ${shellQuote(
          approvalsDirectory,
        )} ${APPROVAL_BROKER_TIMEOUT_MS}`;

  const settings: ClaudeRuntimeSettings = {
    statusLine: { type: "command", command: claudeStatuslineCommand(usageDirectory) },
    hooks: buildHooks(sinkCommand, brokerCommand),
  };

  const settingsPath = path.join(runtimeDir, "claude-runtime-settings.json");
  writeJsonIfChanged(settingsPath, settings);
  return settingsPath;
}
