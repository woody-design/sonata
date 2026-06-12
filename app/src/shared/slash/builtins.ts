import type { RuntimeProvider } from "../types/domain";
import type { SlashBehavior, SlashCommandEntry } from "../types/slash";

/**
 * Curated built-in command snapshots.
 *
 * Neither CLI exposes a machine-readable command list (verified 2026-06-12:
 * no CLI flag, config, or app-server method), so these are version-pinned
 * snapshots: Claude Code 2.1.x, Codex CLI 0.139/0.140. Staleness degrades
 * gracefully by design — an unknown typed command still forwards to the PTY
 * (after the unknown-command caution), and a missing new command only means
 * it is absent from the picker until the snapshot is refreshed.
 *
 * Listing policy (v0): list only entries whose passthrough behavior is
 * evidence-backed or panel-free. "panel" entries stay unlisted unless they
 * redirect to a duet-native menu — blind-injecting a panel command leaves an
 * invisible TUI dialog that swallows the next paste (probe s1: /model text
 * vanished into /config's search box).
 */

interface BuiltinSpec {
  name: string;
  behavior: SlashBehavior;
  description: string;
  argumentHint?: string;
  listed?: boolean;
  nativeMenu?: "model" | "permission";
}

function entries(provider: RuntimeProvider, specs: BuiltinSpec[]): SlashCommandEntry[] {
  return specs.map((spec) => ({
    invocation: `/${spec.name}`,
    name: spec.name,
    provider,
    kind: "builtin",
    behavior: spec.behavior,
    description: spec.description,
    argumentHint: spec.argumentHint ?? null,
    scope: "builtin",
    listed: spec.listed ?? false,
    nativeMenu: spec.nativeMenu ?? null,
  }));
}

const CLAUDE_BUILTINS: BuiltinSpec[] = [
  // Listed: evidence-backed or panel-free.
  {
    name: "model",
    behavior: "panel",
    description: "Model & reasoning effort — opens the Duet model menu",
    listed: true,
    nativeMenu: "model",
  },
  {
    name: "effort",
    behavior: "session",
    description: "Reasoning effort — opens the Duet model menu",
    listed: true,
    nativeMenu: "model",
  },
  {
    name: "permissions",
    behavior: "panel",
    description: "Permission mode — opens the Duet permission menu",
    listed: true,
    nativeMenu: "permission",
  },
  {
    name: "compact",
    behavior: "session",
    description: "Summarize the conversation to free up context",
    argumentHint: "[instructions]",
    listed: true,
  },
  {
    name: "status",
    behavior: "local",
    description: "Show session status — version, model, account, connectivity",
    listed: true,
  },
  {
    name: "init",
    behavior: "prompt",
    description: "Create or refresh CLAUDE.md with project instructions",
    listed: true,
  },
  {
    name: "review",
    behavior: "prompt",
    description: "Review a pull request",
    argumentHint: "[pr-number]",
    listed: true,
  },
  {
    name: "security-review",
    behavior: "prompt",
    description: "Security review of the pending changes on this branch",
    listed: true,
  },
  {
    name: "code-review",
    behavior: "prompt",
    description: "Review the current diff for bugs and cleanups",
    argumentHint: "[effort] [target]",
    listed: true,
  },
  {
    name: "simplify",
    behavior: "prompt",
    description: "Simplify and clean up the changed code",
    argumentHint: "[target]",
    listed: true,
  },
  {
    name: "btw",
    behavior: "prompt",
    description: "Ask a side question without adding it to history",
    argumentHint: "[question]",
    listed: true,
  },

  // Known but unlisted: panels and session-lifecycle commands duet does not
  // surface yet. Typed invocations forward; the modal safety net covers the
  // panel class.
  { name: "config", behavior: "panel", description: "Open the settings dialog" },
  { name: "theme", behavior: "panel", description: "Change the color theme" },
  { name: "help", behavior: "panel", description: "Show help and available commands" },
  { name: "resume", behavior: "panel", description: "Resume a previous session" },
  { name: "agents", behavior: "panel", description: "Manage subagent configurations" },
  { name: "mcp", behavior: "panel", description: "Manage MCP server connections" },
  { name: "memory", behavior: "panel", description: "Edit memory files" },
  { name: "hooks", behavior: "panel", description: "View hook configurations" },
  { name: "doctor", behavior: "panel", description: "Diagnose the installation" },
  { name: "skills", behavior: "panel", description: "List available skills" },
  { name: "export", behavior: "panel", description: "Export the conversation" },
  { name: "rewind", behavior: "panel", description: "Rewind code or conversation" },
  { name: "checkpoint", behavior: "panel", description: "Rewind code or conversation" },
  { name: "undo", behavior: "panel", description: "Rewind code or conversation" },
  { name: "release-notes", behavior: "panel", description: "View the changelog" },
  { name: "plugin", behavior: "panel", description: "Manage plugins" },
  { name: "context", behavior: "panel", description: "Visualize context usage" },
  { name: "usage", behavior: "panel", description: "Show plan usage and limits" },
  { name: "stats", behavior: "panel", description: "Show usage statistics" },
  { name: "diff", behavior: "panel", description: "View changes in this session" },
  { name: "ide", behavior: "panel", description: "Manage IDE integrations" },
  { name: "cost", behavior: "local", description: "Show session cost" },
  { name: "recap", behavior: "local", description: "Summarize this session in one line" },
  { name: "copy", behavior: "local", description: "Copy the last response" },
  { name: "tasks", behavior: "local", description: "Show background tasks" },
  { name: "bashes", behavior: "local", description: "Show background shells" },
  { name: "clear", behavior: "session", description: "Start a new conversation" },
  { name: "rename", behavior: "session", description: "Rename this session" },
  { name: "plan", behavior: "session", description: "Enter plan mode" },
  { name: "fast", behavior: "session", description: "Toggle fast mode" },
  { name: "goal", behavior: "session", description: "Set a goal to work toward" },
  { name: "add-dir", behavior: "session", description: "Add a working directory" },
  { name: "background", behavior: "session", description: "Continue as a background agent" },
  { name: "fork", behavior: "session", description: "Fork the conversation" },
  { name: "branch", behavior: "session", description: "Create a conversation branch" },
  { name: "cd", behavior: "session", description: "Change the working directory" },
  { name: "exit", behavior: "session", description: "Exit the CLI" },
  { name: "quit", behavior: "session", description: "Exit the CLI" },
  { name: "loop", behavior: "session", description: "Run a prompt on an interval" },
  { name: "schedule", behavior: "session", description: "Manage scheduled routines" },
  { name: "deep-research", behavior: "prompt", description: "Deep research with cited sources" },
  { name: "debug", behavior: "prompt", description: "Troubleshoot with debug logging" },
  { name: "run", behavior: "prompt", description: "Launch the app to verify a change" },
  { name: "verify", behavior: "prompt", description: "Verify a change by running it" },
];

const CODEX_BUILTINS: BuiltinSpec[] = [
  {
    name: "model",
    behavior: "panel",
    description: "Model & reasoning effort — opens the Duet model menu",
    listed: true,
    nativeMenu: "model",
  },
  {
    name: "permissions",
    behavior: "panel",
    description: "Permissions — opens the Duet permission menu",
    listed: true,
    nativeMenu: "permission",
  },
  {
    name: "compact",
    behavior: "prompt",
    description: "Compact this thread's context",
    listed: true,
  },
  {
    name: "status",
    behavior: "local",
    description: "Show session configuration and token usage",
    listed: true,
  },
  {
    name: "diff",
    behavior: "local",
    description: "Show the git diff, including untracked files",
    listed: true,
  },
  {
    name: "init",
    behavior: "prompt",
    description: "Create an AGENTS.md with instructions for Codex",
    listed: true,
  },
  {
    name: "mcp",
    behavior: "local",
    description: "Show MCP server status",
    listed: true,
  },

  // Known but unlisted (panels, lifecycle, niche toggles).
  { name: "review", behavior: "panel", description: "Review changes against a branch" },
  { name: "new", behavior: "session", description: "Start a new thread" },
  { name: "clear", behavior: "session", description: "Clear and start a new thread" },
  { name: "archive", behavior: "session", description: "Archive this thread" },
  { name: "delete", behavior: "session", description: "Delete this thread" },
  { name: "resume", behavior: "panel", description: "Resume a previous thread" },
  { name: "fork", behavior: "session", description: "Fork this thread" },
  { name: "app", behavior: "session", description: "Hand off to Codex Desktop" },
  { name: "plan", behavior: "session", description: "Switch to plan mode" },
  { name: "goal", behavior: "panel", description: "Set a goal for Codex" },
  { name: "agent", behavior: "panel", description: "Open agent threads" },
  { name: "subagents", behavior: "panel", description: "Open agent threads" },
  { name: "side", behavior: "session", description: "Open a side conversation" },
  { name: "btw", behavior: "session", description: "Open a side conversation" },
  { name: "copy", behavior: "local", description: "Copy the last response" },
  { name: "raw", behavior: "local", description: "Toggle raw scrollback mode" },
  { name: "mention", behavior: "local", description: "Insert an @ file mention" },
  { name: "skills", behavior: "panel", description: "List available skills" },
  { name: "hooks", behavior: "local", description: "Show lifecycle hooks" },
  { name: "plugins", behavior: "local", description: "Show installed plugins" },
  { name: "ps", behavior: "local", description: "Show background terminals" },
  { name: "stop", behavior: "local", description: "Stop background terminals" },
  { name: "clean", behavior: "local", description: "Stop background terminals" },
  { name: "experimental", behavior: "panel", description: "Toggle experimental features" },
  { name: "memories", behavior: "panel", description: "Configure memories" },
  { name: "personality", behavior: "panel", description: "Choose how Codex responds" },
  { name: "feedback", behavior: "panel", description: "Send feedback about this chat" },
  { name: "import", behavior: "panel", description: "Import config from another agent" },
  { name: "keymap", behavior: "panel", description: "Remap keyboard shortcuts" },
  { name: "theme", behavior: "panel", description: "Change the syntax theme" },
  { name: "title", behavior: "panel", description: "Configure the terminal title" },
  { name: "statusline", behavior: "panel", description: "Configure the status line" },
  { name: "pets", behavior: "panel", description: "Pick a terminal pet" },
  { name: "pet", behavior: "panel", description: "Pick a terminal pet" },
  { name: "vim", behavior: "local", description: "Toggle Vim mode" },
  { name: "ide", behavior: "local", description: "Attach IDE context" },
  { name: "apps", behavior: "local", description: "Show connectors" },
  { name: "rename", behavior: "panel", description: "Rename this thread" },
  { name: "fast", behavior: "local", description: "Toggle fast inference" },
  { name: "logout", behavior: "session", description: "Log out of Codex" },
  { name: "quit", behavior: "session", description: "Exit Codex" },
  { name: "exit", behavior: "session", description: "Exit Codex" },
];

const BUILTIN_COMMANDS: Record<RuntimeProvider, SlashCommandEntry[]> = {
  claude: entries("claude", CLAUDE_BUILTINS),
  codex: entries("codex", CODEX_BUILTINS),
};

export function builtinSlashCommands(provider: RuntimeProvider): SlashCommandEntry[] {
  return BUILTIN_COMMANDS[provider];
}
