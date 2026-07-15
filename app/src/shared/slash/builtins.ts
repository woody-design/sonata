import type { RuntimeProvider } from "../types/domain";
import type { SlashCommandEntry } from "../types/slash";

/**
 * Curated built-in command snapshots.
 *
 * Neither CLI exposes a machine-readable command list (re-verified 2026-07-14:
 * no CLI flag, config, or app-server method — `claude --help` lists only
 * process flags; `codex --help`/`codex completion` cover binary subcommands,
 * not the interactive `/` picker), so these are version-pinned snapshots:
 * Claude Code 2.1.210, Codex CLI 0.144.4 (probed live via node-pty — see
 * spikes/slash-pool-2026-07/). Staleness degrades gracefully by design — an
 * unknown typed command still forwards to the PTY (after the unknown-command
 * caution), and a missing new command only means it is absent from the picker
 * until the snapshot is refreshed.
 *
 * Curation boundary: only first-party CLI builtins are snapshotted. The user's
 * personal skills and installed plugins (which also appear in the live picker)
 * are deliberately excluded — they are per-environment, not universal.
 *
 * Claude aliases: 2.1.210 folds aliases under a canonical command in the picker
 * (`/rewind (checkpoint)`, `/usage (stats|cost)`, `/tasks (bashes)`,
 * `/exit (quit)`, `/plugin (plugins)`). Both the canonical and alias spellings
 * are still accepted, so both stay listed as known-but-unlisted.
 *
 * Every entry submits verbatim (S3, two-window contract): a command that
 * opens an interactive panel opens it in the co-visible terminal window,
 * where the user operates it natively. The registry's remaining jobs are the
 * picker (listed entries) and the unknown-command caution (known-but-unlisted
 * entries forward without the double-Enter confirm).
 *
 * Listing policy (v0 carried forward): the listed set predates S3; panels are
 * now safe to list (visible terminal) — widening the set is a follow-up, not
 * a routing concern. `/fast` (both providers) is listed as a first-class Duet
 * concept (fast/speed mode); every other new command defaults to unlisted.
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
    description: "Review a GitHub pull request",
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
    description: "Ask a quick side question without interrupting the conversation",
    argumentHint: "[question]",
    listed: true,
  },
  {
    name: "fast",
    description: "Toggle fast mode (Opus only)",
    listed: true,
  },

  // Known but unlisted: typed invocations forward verbatim; panels open in
  // the terminal window.
  { name: "config", description: "Open settings" },
  { name: "theme", description: "Change the theme" },
  { name: "help", description: "Show help and available commands" },
  { name: "resume", description: "Resume a previous conversation" },
  { name: "agents", description: "Create or manage subagents (deprecated in-CLI)" },
  { name: "mcp", description: "Manage MCP servers" },
  { name: "memory", description: "Open a memory file in your editor" },
  { name: "hooks", description: "View hook configurations for tool events" },
  { name: "doctor", description: "Health-check and fix the Claude Code setup" },
  { name: "skills", description: "List available skills" },
  { name: "export", description: "Export the conversation to a file or clipboard" },
  { name: "rewind", description: "Restore the code and/or conversation to a previous point" },
  { name: "checkpoint", description: "Restore to a previous point (alias of /rewind)" },
  { name: "undo", description: "Restore to a previous point (alias of /rewind)" },
  { name: "release-notes", description: "View release notes" },
  { name: "plugin", description: "Manage Claude Code plugins" },
  { name: "context", description: "Visualize current context usage" },
  { name: "usage", description: "Show session cost, plan usage, and activity stats" },
  { name: "stats", description: "Session cost and usage (alias of /usage)" },
  { name: "diff", description: "View uncommitted changes and per-turn diffs" },
  { name: "ide", description: "Manage IDE integrations" },
  { name: "cost", description: "Session cost and usage (alias of /usage)" },
  { name: "recap", description: "Generate a one-line session recap" },
  { name: "copy", description: "Copy the last response to the clipboard" },
  { name: "tasks", description: "View and manage background tasks" },
  { name: "bashes", description: "Background tasks (alias of /tasks)" },
  { name: "clear", description: "Start a new session with empty context" },
  { name: "rename", description: "Rename the current conversation" },
  { name: "plan", description: "Enable plan mode or view the session plan" },
  { name: "goal", description: "Set a goal Claude checks before stopping" },
  { name: "add-dir", description: "Add a new working directory" },
  { name: "background", description: "Send this session to the background" },
  { name: "fork", description: "Spawn a background agent that inherits the conversation" },
  { name: "branch", description: "Create a conversation branch at this point" },
  { name: "cd", description: "Move this session to a new working directory" },
  { name: "exit", description: "Exit the CLI" },
  { name: "quit", description: "Exit the CLI (alias of /exit)" },
  { name: "loop", description: "Run a prompt or slash command on an interval" },
  { name: "schedule", description: "Create and manage scheduled cloud agents" },
  { name: "deep-research", description: "Deep research with cited sources" },
  { name: "debug", description: "Enable debug logging for this session" },
  { name: "run", description: "Launch and drive this project's app to verify a change" },
  { name: "verify", description: "Verify a change by exercising it end-to-end" },

  // New in 2.1.210 (first-party builtins; unlisted).
  { name: "advisor", description: "Let Claude consult a stronger model at key moments" },
  { name: "artifacts", description: "Browse your published and shared artifacts" },
  { name: "chrome", description: "Open Claude in Chrome settings" },
  { name: "color", description: "Set the prompt bar color for this session" },
  { name: "desktop", description: "Continue the current session in Claude Desktop" },
  { name: "feedback", description: "Submit feedback or report a bug" },
  { name: "focus", description: "Toggle focus view" },
  { name: "install-github-app", description: "Set up Claude GitHub Actions for a repository" },
  { name: "install-slack-app", description: "Install the Claude Slack app" },
  { name: "keybindings", description: "Open your keyboard shortcuts file" },
  { name: "login", description: "Sign in with your Anthropic account" },
  { name: "logout", description: "Sign out from your Anthropic account" },
  { name: "mobile", description: "Show a QR code to download the Claude mobile app" },
  { name: "powerup", description: "Discover Claude Code features through quick lessons" },
  { name: "privacy-settings", description: "View and update your privacy settings" },
  { name: "radio", description: "Listen to Claude FM lo-fi radio" },
  { name: "reload-plugins", description: "Activate pending plugin changes in this session" },
  { name: "reload-skills", description: "Pick up skills changed on disk during this session" },
  { name: "remote-control", description: "Control this session from your phone or claude.ai/code" },
  { name: "remote-env", description: "Choose the default environment for cloud agents" },
  { name: "sandbox", description: "Configure the command sandbox" },
  { name: "scroll-speed", description: "Adjust mouse wheel scroll speed" },
  { name: "stickers", description: "Order Claude Code stickers" },
  { name: "terminal-setup", description: "Enable Option+Enter for newlines and visual bell" },
  { name: "tui", description: "Set the CLI renderer (default | fullscreen)" },
  { name: "upgrade", description: "Upgrade to Max for higher rate limits" },
  { name: "usage-credits", description: "Configure or request usage credits" },
  { name: "voice", description: "Toggle voice mode" },
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
    description: "Compact the conversation to free up context",
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
    description: "List configured MCP tools and servers",
    listed: true,
  },
  {
    name: "fast",
    description: "Toggle fast inference (1.5x speed, increased usage)",
    listed: true,
  },

  // Known but unlisted.
  { name: "review", description: "Review your current changes and find issues" },
  { name: "new", description: "Start a new session during a conversation" },
  { name: "clear", description: "Clear the screen and start a new session" },
  { name: "archive", description: "Archive this session and exit" },
  { name: "delete", description: "Permanently delete this session and exit" },
  { name: "resume", description: "Resume a saved chat" },
  { name: "fork", description: "Fork the current chat" },
  { name: "app", description: "Continue this session in Codex Desktop" },
  { name: "plan", description: "Switch to Plan mode" },
  { name: "goal", description: "Set or view the goal for a long-running task" },
  { name: "agent", description: "Switch the active agent thread" },
  { name: "subagents", description: "Switch the active agent thread" },
  { name: "side", description: "Start a side conversation in an ephemeral fork" },
  { name: "btw", description: "Start a side conversation in an ephemeral fork" },
  { name: "copy", description: "Copy the last response as markdown" },
  { name: "raw", description: "Toggle raw scrollback mode for copy-friendly selection" },
  { name: "mention", description: "Mention a file" },
  { name: "skills", description: "Use skills to improve how Codex performs tasks" },
  { name: "hooks", description: "View and manage lifecycle hooks" },
  { name: "plugins", description: "Browse plugins" },
  { name: "ps", description: "List background terminals" },
  { name: "stop", description: "Stop all background terminals" },
  { name: "experimental", description: "Toggle experimental features" },
  { name: "memories", description: "Configure memory use and generation" },
  { name: "personality", description: "Choose a communication style for Codex" },
  { name: "feedback", description: "Send logs to maintainers" },
  { name: "import", description: "Import setup and recent sessions from Claude Code" },
  { name: "keymap", description: "Remap TUI shortcuts" },
  { name: "theme", description: "Choose a syntax highlighting theme" },
  { name: "title", description: "Configure the terminal title" },
  { name: "statusline", description: "Configure which items appear in the status line" },
  { name: "pets", description: "Choose or hide the terminal pet" },
  { name: "vim", description: "Toggle Vim mode for the composer" },
  { name: "ide", description: "Include selection, open files, and IDE context" },
  { name: "rename", description: "Rename the current thread" },
  { name: "approve", description: "Approve one retry of a recent auto-review denial" },
  { name: "usage", description: "View account usage or reset a usage limit" },
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
