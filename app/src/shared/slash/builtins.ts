import type { RuntimeProvider } from "../types/domain";
import type { SlashCommandEntry } from "../types/slash";

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
 * Every entry submits verbatim (S3, two-window contract): a command that
 * opens an interactive panel opens it in the co-visible terminal window,
 * where the user operates it natively. The registry's remaining jobs are the
 * picker (listed entries) and the unknown-command caution (known-but-unlisted
 * entries forward without the double-Enter confirm).
 *
 * Listing policy (v0 carried forward): the listed set predates S3; panels are
 * now safe to list (visible terminal) — widening the set is a follow-up, not
 * a routing concern.
 */

interface BuiltinSpec {
  name: string;
  description: string;
  argumentHint?: string;
  listed?: boolean;
}

function entries(provider: RuntimeProvider, specs: BuiltinSpec[]): SlashCommandEntry[] {
  return specs.map((spec) => ({
    invocation: `/${spec.name}`,
    name: spec.name,
    provider,
    kind: "builtin",
    description: spec.description,
    argumentHint: spec.argumentHint ?? null,
    scope: "builtin",
    listed: spec.listed ?? false,
  }));
}

const CLAUDE_BUILTINS: BuiltinSpec[] = [
  // Listed: shown in the picker.
  {
    name: "model",
    description: "Model & reasoning effort — opens the picker in the CLI",
    listed: true,
  },
  {
    name: "effort",
    description: "Reasoning effort — opens the picker in the CLI",
    listed: true,
  },
  {
    name: "permissions",
    description: "Permission mode — opens the picker in the CLI",
    listed: true,
  },
  {
    name: "compact",
    description: "Summarize the conversation to free up context",
    argumentHint: "[instructions]",
    listed: true,
  },
  {
    name: "status",
    description: "Show session status — version, model, account, connectivity",
    listed: true,
  },
  {
    name: "init",
    description: "Create or refresh CLAUDE.md with project instructions",
    listed: true,
  },
  {
    name: "review",
    description: "Review a pull request",
    argumentHint: "[pr-number]",
    listed: true,
  },
  {
    name: "security-review",
    description: "Security review of the pending changes on this branch",
    listed: true,
  },
  {
    name: "code-review",
    description: "Review the current diff for bugs and cleanups",
    argumentHint: "[effort] [target]",
    listed: true,
  },
  {
    name: "simplify",
    description: "Simplify and clean up the changed code",
    argumentHint: "[target]",
    listed: true,
  },
  {
    name: "btw",
    description: "Ask a side question without adding it to history",
    argumentHint: "[question]",
    listed: true,
  },

  // Known but unlisted: typed invocations forward verbatim; panels open in
  // the terminal window.
  { name: "config", description: "Open the settings dialog" },
  { name: "theme", description: "Change the color theme" },
  { name: "help", description: "Show help and available commands" },
  { name: "resume", description: "Resume a previous session" },
  { name: "agents", description: "Manage subagent configurations" },
  { name: "mcp", description: "Manage MCP server connections" },
  { name: "memory", description: "Edit memory files" },
  { name: "hooks", description: "View hook configurations" },
  { name: "doctor", description: "Diagnose the installation" },
  { name: "skills", description: "List available skills" },
  { name: "export", description: "Export the conversation" },
  { name: "rewind", description: "Rewind code or conversation" },
  { name: "checkpoint", description: "Rewind code or conversation" },
  { name: "undo", description: "Rewind code or conversation" },
  { name: "release-notes", description: "View the changelog" },
  { name: "plugin", description: "Manage plugins" },
  { name: "context", description: "Visualize context usage" },
  { name: "usage", description: "Show plan usage and limits" },
  { name: "stats", description: "Show usage statistics" },
  { name: "diff", description: "View changes in this session" },
  { name: "ide", description: "Manage IDE integrations" },
  { name: "cost", description: "Show session cost" },
  { name: "recap", description: "Summarize this session in one line" },
  { name: "copy", description: "Copy the last response" },
  { name: "tasks", description: "Show background tasks" },
  { name: "bashes", description: "Show background shells" },
  { name: "clear", description: "Start a new conversation" },
  { name: "rename", description: "Rename this session" },
  { name: "plan", description: "Enter plan mode" },
  { name: "fast", description: "Toggle fast mode" },
  { name: "goal", description: "Set a goal to work toward" },
  { name: "add-dir", description: "Add a working directory" },
  { name: "background", description: "Continue as a background agent" },
  { name: "fork", description: "Fork the conversation" },
  { name: "branch", description: "Create a conversation branch" },
  { name: "cd", description: "Change the working directory" },
  { name: "exit", description: "Exit the CLI" },
  { name: "quit", description: "Exit the CLI" },
  { name: "loop", description: "Run a prompt on an interval" },
  { name: "schedule", description: "Manage scheduled routines" },
  { name: "deep-research", description: "Deep research with cited sources" },
  { name: "debug", description: "Troubleshoot with debug logging" },
  { name: "run", description: "Launch the app to verify a change" },
  { name: "verify", description: "Verify a change by running it" },
];

const CODEX_BUILTINS: BuiltinSpec[] = [
  {
    name: "model",
    description: "Model & reasoning effort — opens the picker in the CLI",
    listed: true,
  },
  {
    name: "permissions",
    description: "Permissions — opens the picker in the CLI",
    listed: true,
  },
  {
    name: "compact",
    description: "Compact this thread's context",
    listed: true,
  },
  {
    name: "status",
    description: "Show session configuration and token usage",
    listed: true,
  },
  {
    name: "diff",
    description: "Show the git diff, including untracked files",
    listed: true,
  },
  {
    name: "init",
    description: "Create an AGENTS.md with instructions for Codex",
    listed: true,
  },
  {
    name: "mcp",
    description: "Show MCP server status",
    listed: true,
  },

  // Known but unlisted.
  { name: "review", description: "Review changes against a branch" },
  { name: "new", description: "Start a new thread" },
  { name: "clear", description: "Clear and start a new thread" },
  { name: "archive", description: "Archive this thread" },
  { name: "delete", description: "Delete this thread" },
  { name: "resume", description: "Resume a previous thread" },
  { name: "fork", description: "Fork this thread" },
  { name: "app", description: "Hand off to Codex Desktop" },
  { name: "plan", description: "Switch to plan mode" },
  { name: "goal", description: "Set a goal for Codex" },
  { name: "agent", description: "Open agent threads" },
  { name: "subagents", description: "Open agent threads" },
  { name: "side", description: "Open a side conversation" },
  { name: "btw", description: "Open a side conversation" },
  { name: "copy", description: "Copy the last response" },
  { name: "raw", description: "Toggle raw scrollback mode" },
  { name: "mention", description: "Insert an @ file mention" },
  { name: "skills", description: "List available skills" },
  { name: "hooks", description: "Show lifecycle hooks" },
  { name: "plugins", description: "Show installed plugins" },
  { name: "ps", description: "Show background terminals" },
  { name: "stop", description: "Stop background terminals" },
  { name: "clean", description: "Stop background terminals" },
  { name: "experimental", description: "Toggle experimental features" },
  { name: "memories", description: "Configure memories" },
  { name: "personality", description: "Choose how Codex responds" },
  { name: "feedback", description: "Send feedback about this chat" },
  { name: "import", description: "Import config from another agent" },
  { name: "keymap", description: "Remap keyboard shortcuts" },
  { name: "theme", description: "Change the syntax theme" },
  { name: "title", description: "Configure the terminal title" },
  { name: "statusline", description: "Configure the status line" },
  { name: "pets", description: "Pick a terminal pet" },
  { name: "pet", description: "Pick a terminal pet" },
  { name: "vim", description: "Toggle Vim mode" },
  { name: "ide", description: "Attach IDE context" },
  { name: "apps", description: "Show connectors" },
  { name: "rename", description: "Rename this thread" },
  { name: "fast", description: "Toggle fast inference" },
  { name: "logout", description: "Log out of Codex" },
  { name: "quit", description: "Exit Codex" },
  { name: "exit", description: "Exit Codex" },
];

const BUILTIN_COMMANDS: Record<RuntimeProvider, SlashCommandEntry[]> = {
  claude: entries("claude", CLAUDE_BUILTINS),
  codex: entries("codex", CODEX_BUILTINS),
};

export function builtinSlashCommands(provider: RuntimeProvider): SlashCommandEntry[] {
  return BUILTIN_COMMANDS[provider];
}
