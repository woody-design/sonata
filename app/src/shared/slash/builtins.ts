import type { RuntimeProvider } from "../types/domain";
import type { SlashCommandEntry } from "../types/slash";

/**
 * Curated built-in command snapshots.
 *
 * Neither CLI exposes a machine-readable command list (re-verified 2026-07-14:
 * no CLI flag, config, or app-server method — `claude --help` lists only
 * process flags; `codex --help`/`codex completion` cover binary subcommands,
 * not the interactive `/` picker), so these are version-pinned snapshots:
 * **Claude Code 2.1.258, Codex CLI 0.152.1**, both walked live on 2026-09-02
 * (spikes/upstream-sync-2026-09/{claude/s1,s2,s4, codex/s3}).
 *
 * STALENESS IS NO LONGER SYMMETRIC. Submit still never consults this registry
 * at all (S3, 2026-07-27: verbatim, always), so a MISSING command only means it
 * is absent from Sonata's picker until the snapshot is refreshed — typing it
 * still forwards to the PTY untouched. But claude 2.1.236 removed the fuzzy
 * match on submit, and s2 measured the consequence directly: a name the CLI
 * does not know now answers `Unknown command: /x` instead of near-matching to
 * its successor. So a WRONG entry — a name upstream renamed or dropped — is a
 * dead row in the picker, not a forgiving one. Removals and renames are the
 * load-bearing half of a refresh; additions are the cosmetic half.
 *
 * HOW THE POOLS WERE MEASURED. Three independent channels per provider, kept
 * separate so convergence means something: a growth-stopped Down-walk of the
 * bare `/` picker, an a–z/0–9 prefix sweep with each prefix walked to
 * exhaustion, and full-name probes for every hypothesis and every name this
 * file already carried (presence in a scrolling read cannot assert ABSENCE).
 * On the claude side a fourth channel — `/help`'s "Browse default commands"
 * tab, which is neither ranked nor clipped — returned the same 104 names as the
 * picker walks, name for name, in both directions.
 *
 * Curation boundary: only first-party CLI builtins are snapshotted. The user's
 * personal skills and installed plugins (which also appear in the live picker)
 * are deliberately excluded — they are per-environment, not universal. The
 * claude walk subtracted them by their on-disk evidence and their namespaced
 * `plugin:command` spelling. Whether the 27 unfamiliar names this refresh adds
 * (`/dataviz`, `/design`, `/claude-in-chrome`, …) are commands or bundled
 * SKILLS matters for that boundary, and `/skills` is the CLI's own answer: it
 * reports 11 skills on the probe account, every one `user` or `plugin` scope
 * and none shipped with the binary. On that accounting they are commands, and
 * they are carried here the way `/run`, `/verify` and `/deep-research` already
 * were. The codex `/` picker needs no subtraction at all: codex skills are
 * `$name` mentions, not slash commands (probe s3, 2026-07), which is why
 * `skills-discovery.ts` gives them a `$` invocation.
 *
 * Claude aliases: 2.1.210 folds aliases under a canonical command, and the
 * picker paints the fold as `/canonical (alias)` when the alias is what matched
 * the query. The full measured set at 2.1.258 is 26 spellings over 21 canonical
 * commands, and s2 submitted the seven this file already carried — every one is
 * still ACCEPTED (`/quit` exits, `/checkpoint` and `/undo` open Rewind,
 * `/stats` and `/cost` open usage, `/bashes` opens Background, `/plugins` opens
 * the plugin browser), against a control that could not exist and was rejected.
 * All 26 are carried below as known-but-unlisted entries — the same treatment
 * the original seven had — so the record is complete rather than partial.
 *
 * `/review` is the one entry whose STATUS changed: it is now an alias of
 * `/code-review` (measured — submitting it starts a `code-review` run), and its
 * old copy described a GitHub-PR reviewer that no longer matches the argument
 * grammar. It moves from the listed set to the alias group, where every other
 * alias already lives; `/code-review` was already listed, so the picker loses
 * nothing.
 *
 * Known-but-unlisted, deliberately: `/artifact-design` answers an exact-name
 * query with a real row but appears in NEITHER picker walk NOR `/help`'s
 * default-command list. Upstream hides it from every browse surface, so Sonata
 * does not re-surface it.
 *
 * Every entry submits verbatim (S3, two-window contract): a command that
 * opens an interactive panel opens it in the co-visible terminal window,
 * where the user operates it natively. The registry's ONE remaining job is
 * the picker — since the submit guard retired (2026-07-27) nothing else reads
 * it, and `listed` is the only field that changes behavior. Known-but-unlisted
 * entries are kept as an honest record of what the CLI accepts, not because
 * anything consults them. They are not free, though, and this refresh widened
 * the cost: `listSlashCommands` DROPS a disk-discovered skill whose name
 * collides with a builtin, so every name added here is a name a personal skill
 * can no longer occupy in Sonata's picker. Short alias spellings (`/new`,
 * `/name`, `/app`, `/share`, `/settings`) are the plausible collisions. Which
 * side the CLI itself resolves such a collision to is UNMEASURED — the probe
 * account had no colliding skill — so this is a known, bounded cost of keeping
 * the record complete, not a claim that Sonata is mirroring upstream here.
 *
 * Listing policy (v0 carried forward): the listed set predates S3; panels are
 * now safe to list (visible terminal) — widening the set is a follow-up, not
 * a routing concern. `/fast` (both providers) is listed as a first-class Sonata
 * concept (fast/speed mode); every other new command defaults to unlisted.
 *
 * Descriptions are Sonata's own short paraphrases, not the CLI's strings. Two
 * reasons they are not copied: several CLI descriptions are STATE-dependent and
 * would freeze a moment ("◯ sandbox disabled", "3 free left ·", "Disconnect
 * Remote Control"), and codex's own copy uses vocabulary Sonata does not
 * ("chat", "chats" — see the ui-vocabulary-corpus fence). A description is
 * rewritten here only when the command's MEANING moved, never to re-paraphrase.
 *
 * The unlisted set is ALPHABETICAL. It used to be grouped by the release that
 * introduced each entry, which was readable at 40 entries and is not at 119:
 * the maintenance operation on this file is diffing a sorted snapshot against a
 * sorted fresh walk, and vintage grouping actively obstructs it.
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

  // Known but unlisted: kept out of the picker to hold the noise down. Typing
  // one forwards verbatim like any other text; panels open in the terminal
  // window. Alphabetical — canonical commands and the folded alias spellings
  // interleaved, each alias naming the command it resolves to.
  { name: "add-dir", description: "Add a new working directory" },
  { name: "advisor", description: "Let Claude consult a stronger model at key moments" },
  // 2.1.25x relabelled this from "deprecated" to "(removed)": the picker still
  // offers the row, and it now points at the on-disk directory instead.
  { name: "agents", description: "Subagents — removed in-CLI; edit .claude/agents/ instead" },
  { name: "allowed-tools", description: "Manage tool permission rules (alias of /permissions)" },
  { name: "android", description: "Show a QR code for the mobile app (alias of /mobile)" },
  { name: "app", description: "Continue this session in Claude Desktop (alias of /desktop)" },
  { name: "artifact-capabilities", description: "Runtime capabilities a published Artifact page can be granted" },
  { name: "artifact-diagramming", description: "Diagramming guidance for Artifacts" },
  { name: "artifacts", description: "Browse your published and shared artifacts" },
  { name: "auto-mode-setup", description: "Teach auto mode about your environment" },
  { name: "autocompact", description: "Set how full the context gets before auto-summarizing" },
  { name: "autofix-pr", description: "Monitor and autofix issues on the current PR" },
  { name: "background", description: "Send this session to the background" },
  { name: "bashes", description: "Background tasks (alias of /tasks)" },
  { name: "batch", description: "Plan a large change, then run it across parallel worktree agents" },
  { name: "bg", description: "Send this session to the background (alias of /background)" },
  { name: "branch", description: "Create a conversation branch at this point" },
  { name: "bug", description: "Report a bug or share your conversation" },
  { name: "cd", description: "Move this session to a new working directory" },
  { name: "checkpoint", description: "Restore to a previous point (alias of /rewind)" },
  { name: "checkup", description: "Health-check the Claude Code setup (alias of /doctor)" },
  { name: "chrome", description: "Open Claude in Chrome settings" },
  { name: "claude-api", description: "Reference for the Claude API and Anthropic SDK" },
  { name: "claude-in-chrome", description: "Drive your Chrome browser to read and interact with web pages" },
  { name: "clear", description: "Start a new session with empty context" },
  { name: "color", description: "Set the prompt bar color for this session" },
  { name: "config", description: "Open settings" },
  { name: "context", description: "Visualize current context usage" },
  { name: "continue", description: "Resume a previous conversation (alias of /resume)" },
  { name: "copy", description: "Copy the last response to the clipboard" },
  { name: "cost", description: "Session cost and usage (alias of /usage)" },
  { name: "dataviz", description: "Guidance for building charts and data visualizations" },
  { name: "debug", description: "Enable debug logging for this session" },
  { name: "deep-research", description: "Deep research with cited sources" },
  { name: "design", description: "Grant or revoke Claude agent access to your Design projects" },
  { name: "design-login", description: "Authorize design-system access for /design-sync" },
  { name: "design-sync", description: "Push a React design system to claude.ai/design" },
  { name: "desktop", description: "Continue the current session in Claude Desktop" },
  { name: "diff", description: "View uncommitted changes and per-turn diffs" },
  { name: "doctor", description: "Health-check and fix the Claude Code setup" },
  { name: "exit", description: "Exit the CLI" },
  { name: "export", description: "Export the conversation to a file or clipboard" },
  { name: "feedback", description: "Submit feedback or report a bug" },
  { name: "fewer-permission-prompts", description: "Propose an allowlist for the read-only calls you approve most" },
  { name: "focus", description: "Toggle focus view" },
  // 2.1.212: /fork now copies into a background session; the in-session
  // subagent it used to launch moved to /subtask (picker text probed live,
  // spikes/slash-pool-2026-07/targeted-212.mjs).
  { name: "fork", description: "Copy this conversation into a new background session and keep working here" },
  { name: "goal", description: "Set a goal Claude checks before stopping" },
  { name: "help", description: "Show help and available commands" },
  { name: "hooks", description: "View hook configurations for tool events" },
  { name: "ide", description: "Manage IDE integrations" },
  { name: "import", description: "Import config from another AI coding agent" },
  { name: "insights", description: "Generate a report analyzing your Claude Code sessions" },
  { name: "install-github-app", description: "Set up Claude GitHub Actions for a repository" },
  { name: "install-slack-app", description: "Install the Claude Slack app" },
  { name: "ios", description: "Show a QR code for the mobile app (alias of /mobile)" },
  { name: "keybindings", description: "Open your keyboard shortcuts file" },
  { name: "list-agents", description: "List subagents, teammates, and other sessions you can message" },
  { name: "login", description: "Sign in with your Anthropic account" },
  { name: "logout", description: "Sign out from your Anthropic account" },
  { name: "loop", description: "Run a prompt or slash command on an interval" },
  { name: "marketplace", description: "Manage Claude Code plugins (alias of /plugin)" },
  { name: "mcp", description: "Manage MCP servers" },
  { name: "memory", description: "Edit CLAUDE.md files and memory settings" },
  { name: "mobile", description: "Show a QR code to download the Claude mobile app" },
  { name: "name", description: "Rename the current conversation (alias of /rename)" },
  { name: "new", description: "Start a session with empty context (alias of /clear)" },
  { name: "passes", description: "Share a free week of Claude Code and earn usage credits" },
  { name: "peers", description: "List sessions you can message (alias of /list-agents)" },
  { name: "plan", description: "Enable plan mode or view the session plan" },
  { name: "plugin", description: "Manage Claude Code plugins" },
  { name: "plugins", description: "Manage Claude Code plugins (alias of /plugin)" },
  { name: "powerup", description: "Discover Claude Code features through quick lessons" },
  { name: "privacy-settings", description: "View and update your privacy settings" },
  { name: "proactive", description: "Run a prompt on an interval (alias of /loop)" },
  { name: "quit", description: "Exit the CLI (alias of /exit)" },
  { name: "radio", description: "Listen to Claude FM lo-fi radio" },
  { name: "rc", description: "Remote Control (alias of /remote-control)" },
  { name: "recap", description: "Generate a one-line session recap" },
  { name: "release-notes", description: "View release notes" },
  { name: "reload-plugins", description: "Activate pending plugin changes in this session" },
  { name: "reload-skills", description: "Pick up skills changed on disk during this session" },
  { name: "remote-control", description: "Control this session from your phone or claude.ai/code" },
  { name: "remote-env", description: "Choose the default environment for cloud agents" },
  { name: "rename", description: "Rename the current conversation" },
  { name: "reset", description: "Start a session with empty context (alias of /clear)" },
  { name: "resume", description: "Resume a previous conversation" },
  { name: "review", description: "Review the current diff for bugs and cleanups (alias of /code-review)" },
  { name: "rewind", description: "Restore the code and/or conversation to a previous point" },
  { name: "routines", description: "Scheduled cloud agents (alias of /schedule)" },
  { name: "run", description: "Launch and drive this project's app to verify a change" },
  { name: "run-skill-generator", description: "Author or improve this project's run-<unit> skill" },
  { name: "sandbox", description: "Configure the command sandbox" },
  { name: "schedule", description: "Create and manage scheduled cloud agents" },
  { name: "scroll-speed", description: "Adjust mouse wheel scroll speed" },
  { name: "settings", description: "Open settings (alias of /config)" },
  { name: "share", description: "Report a bug or share your conversation (alias of /bug)" },
  { name: "skills", description: "List available skills" },
  { name: "stats", description: "Session cost and usage (alias of /usage)" },
  { name: "statusline", description: "Set up the Claude Code status line" },
  { name: "stickers", description: "Order Claude Code stickers" },
  { name: "subtask", description: "Send a subagent off with your full context; its result comes back here" },
  { name: "tasks", description: "View and manage background tasks" },
  { name: "team-onboarding", description: "Write a teammate onboarding guide from your usage" },
  { name: "teleport", description: "Send this session to the cloud, or resume one from claude.ai" },
  // 2.1.25x moved this binding from Option+Enter to Shift+Enter.
  { name: "terminal-setup", description: "Install the Shift+Enter key binding for newlines" },
  { name: "theme", description: "Change the theme" },
  { name: "tp", description: "Send this session to the cloud (alias of /teleport)" },
  { name: "tui", description: "Set the CLI renderer (default | fullscreen)" },
  { name: "ultrareview", description: "Start a cloud agent that finds and verifies bugs in your branch" },
  { name: "undo", description: "Restore to a previous point (alias of /rewind)" },
  { name: "update-config", description: "Configure the Claude Code harness via settings.json" },
  { name: "upgrade", description: "Upgrade to Max for higher rate limits" },
  { name: "usage", description: "Show session cost, plan usage, and activity stats" },
  { name: "usage-credits", description: "Configure or request usage credits" },
  { name: "verify", description: "Verify a change by exercising it end-to-end" },
  { name: "voice", description: "Toggle voice mode" },
  { name: "web-setup", description: "Set up Claude Code on the web with your GitHub account" },
  { name: "workflow-authoring", description: "Reference for writing a Workflow tool script" },
  { name: "workflows", description: "Browse running and completed workflows" },
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

  // Known but unlisted, alphabetical. Codex does NOT fold aliases the way claude
  // does — where two spellings exist it paints a row for each (`/quit` beside
  // `/exit`, `/btw` beside `/side`), so they are carried here as the picker
  // presents them, with matching descriptions.
  // 0.152: the agent-thread switcher is `/agents` (plural) and `/agent` is gone
  // — measured, and it is a strict prefix of the survivor, so a picker that
  // still knew it would have offered it.
  { name: "agents", description: "View and switch between all active agent sessions" },
  { name: "app", description: "Continue this session in Codex Desktop" },
  { name: "approve", description: "Approve one retry of a recent auto-review denial" },
  { name: "archive", description: "Archive this session and exit" },
  { name: "btw", description: "Start a side conversation in an ephemeral fork" },
  { name: "cd", description: "Change the current working directory" },
  { name: "clear", description: "Clear the screen and start a new session" },
  // 0.152: no longer a one-shot markdown copy — it opens a picker over the
  // response, its code blocks, and quoted spans.
  { name: "copy", description: "Copy the last response, a code block, or a quote" },
  { name: "delete", description: "Permanently delete this session and exit" },
  { name: "exit", description: "Exit Codex" },
  { name: "experimental", description: "Toggle experimental features" },
  { name: "export", description: "Export the conversation as markdown" },
  { name: "feedback", description: "Send logs to maintainers" },
  { name: "fork", description: "Fork the current chat" },
  { name: "goal", description: "Set or view the goal for a long-running task" },
  { name: "hooks", description: "View and manage lifecycle hooks" },
  { name: "ide", description: "Include selection, open files, and IDE context" },
  { name: "import", description: "Import setup and recent sessions from Claude Code" },
  { name: "keymap", description: "Remap TUI shortcuts" },
  { name: "logout", description: "Log out of Codex" },
  { name: "memories", description: "Configure memory use and generation" },
  { name: "mention", description: "Mention a file" },
  { name: "new", description: "Start a new session during a conversation" },
  { name: "personality", description: "Choose a communication style for Codex" },
  { name: "pets", description: "Choose or hide the terminal pet" },
  { name: "plan", description: "Switch to Plan mode" },
  { name: "plugins", description: "Browse plugins" },
  { name: "ps", description: "List background terminals" },
  { name: "pwd", description: "Show the current working directory" },
  { name: "quit", description: "Exit Codex" },
  { name: "raw", description: "Toggle raw scrollback mode for copy-friendly selection" },
  { name: "recap", description: "Summarize the conversation so far" },
  { name: "rename", description: "Rename the current thread" },
  { name: "resume", description: "Resume a saved chat" },
  { name: "review", description: "Review your current changes and find issues" },
  { name: "side", description: "Start a side conversation in an ephemeral fork" },
  { name: "skills", description: "Use skills to improve how Codex performs tasks" },
  { name: "statusline", description: "Configure which items appear in the status line" },
  { name: "stop", description: "Stop all background terminals" },
  { name: "subagents", description: "Switch between this session's subagents" },
  { name: "theme", description: "Choose a syntax highlighting theme" },
  { name: "title", description: "Configure the terminal title" },
  // 0.152 reads the other way round: a reset is something you SPEND, not
  // something you perform ("You have 1 usage limit reset available. Run /usage
  // to use one." — measured on the boot banner).
  { name: "usage", description: "View account usage or use a usage-limit reset" },
  { name: "vim", description: "Toggle Vim mode for the composer" },
];

const BUILTIN_COMMANDS: Record<RuntimeProvider, SlashCommandEntry[]> = {
  claude: entries("claude", CLAUDE_BUILTINS),
  codex: entries("codex", CODEX_BUILTINS),
};

export function builtinSlashCommands(provider: RuntimeProvider): SlashCommandEntry[] {
  return BUILTIN_COMMANDS[provider];
}
