import fs from "node:fs";
import path from "node:path";
import {
  claudeStatuslineCommand,
  claudeUsageDirectory,
  shellQuote,
  writeJsonIfChanged,
} from "../usage/claude-statusline";
import type { ClaudeHookEventName } from "../../shared/types/cli-signal";

/**
 * The single `--settings` file duet injects into every Claude spawn. It carries
 * BOTH the statusLine sink (usage) AND the hooks sink (signal layer). Phase 0
 * proved hooks UNION across all settings sources, so injecting our hooks here
 * does NOT clobber the user's own `~/.claude/settings.json` or project hooks —
 * we deliberately write ONLY duet's entries and let Claude merge.
 */

/** Where the hook sink drops payload files; watched by ClaudeHookWatcher. */
export function claudeHooksDirectory(runtimeDir: string): string {
  return path.join(runtimeDir, "hooks");
}

/**
 * Hook events duet injects. UserPromptSubmit/PreToolUse drive busy, Stop drives
 * turn-end, PermissionRequest drives waiting-approval (names the tool). The rest
 * corroborate. (Notification is injected for forward-compat though it did not
 * fire on 2.1.177 — harmless.)
 */
const INJECTED_HOOK_EVENTS: ClaudeHookEventName[] = [
  "SessionStart",
  "UserPromptSubmit",
  "PreToolUse",
  "PostToolUse",
  "PermissionRequest",
  "Notification",
  "Stop",
  "SubagentStop",
];

/** Events scoped by a tool/notification matcher; the rest take a bare entry. */
const MATCHER_EVENTS = new Set<ClaudeHookEventName>([
  "PreToolUse",
  "PostToolUse",
  "PermissionRequest",
  "Notification",
]);

interface ClaudeHookCommandEntry {
  type: "command";
  command: string;
}

interface ClaudeHookMatcherGroup {
  matcher?: string;
  hooks: ClaudeHookCommandEntry[];
}

interface ClaudeRuntimeSettings {
  statusLine: { type: "command"; command: string };
  hooks: Record<string, ClaudeHookMatcherGroup[]>;
}

function buildHooks(command: string): Record<string, ClaudeHookMatcherGroup[]> {
  const hooks: Record<string, ClaudeHookMatcherGroup[]> = {};
  for (const event of INJECTED_HOOK_EVENTS) {
    const entry: ClaudeHookCommandEntry = { type: "command", command };
    hooks[event] = MATCHER_EVENTS.has(event)
      ? [{ matcher: "*", hooks: [entry] }]
      : [{ hooks: [entry] }];
  }
  return hooks;
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
export function ensureClaudeRuntimeSettings(runtimeDir: string): string {
  const usageDirectory = claudeUsageDirectory(runtimeDir);
  const hooksDirectory = claudeHooksDirectory(runtimeDir);
  fs.mkdirSync(usageDirectory, { recursive: true });
  fs.mkdirSync(hooksDirectory, { recursive: true });

  const hookCommand = `node ${shellQuote(path.join(__dirname, "hook-sink.js"))} ${shellQuote(
    hooksDirectory,
  )}`;

  const settings: ClaudeRuntimeSettings = {
    statusLine: { type: "command", command: claudeStatuslineCommand(usageDirectory) },
    hooks: buildHooks(hookCommand),
  };

  const settingsPath = path.join(runtimeDir, "claude-runtime-settings.json");
  writeJsonIfChanged(settingsPath, settings);
  return settingsPath;
}
