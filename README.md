# Sonata - Skip the terminal learning curve, start building

Terminal(CLI) is where Claude Code and Codex work best. It just isn’t an ideal interface for people — reading long outputs, refining prompts, previewing results, and managing sessions.

Sonata adds the experience layer. Your Claude Code & Codex agents run natively in the terminal, with full capabilities on your existing subscription. You read, write, and manage everything in a modern interface as familiar as ChatGPT.

Free and open source · macOS · No sign-up · No telemetry · No server · Works with your subscriptions on Claude Code & Codex

Sonata is built for a new generation of coders, builders, and design engineers — people whose work no longer centers on writing or editing code, but on reading AI outputs, giving direction, managing tasks, and building 0-1 ideas.

**[▶ Watch the 3-minute demo](https://youtu.be/Bvi27v0_OkI)**

[![Watch the 3-minute demo](docs/assets/demo-cover.png)](https://youtu.be/Bvi27v0_OkI)

- [What it does](#what-it-does)
- [What it is not](#what-it-is-not)
- [Why Sonata](#why-sonata)
- [How it works](#how-it-works)
- [Design choices](#design-choices)
- [Install](#install)
- [Run it locally](#run-it-locally)
- [Why I Built This](#why-i-built-this)
- [Caveats](#caveats)
- [Feedback](#feedback)

<br>

## What it does

- **Read.** Sessions render as a clean reading surface — tuned
typography, background & themes. Navigate to any prompt in a
long session.

- **Write.** Type and edit naturally; attach files, folders, and
images. Select text from a reply and comment on it.

- **Preview.** Markdown, images, and changed files open in floating
preview windows, with the folder structure right beside them.

- **Manage.** Rename and tag your sessions. Filter by project, tag, status, or recent activity; grouping & sorting.

- **Remote Control.** One click turns on Claude's Remote Control — pick
up the session from your phone.

<br>

## What it is not

- **Not a terminal skin.** The reading surface is built from
  structured session data, not re-rendered terminal output.
- **Not a new agent runtime.** It runs your real `claude` and
  `codex`, natively.
- **Not an IDE.** There is deliberately no code editor inside.
- **Not another subscription.**
- **Not a cloud layer.**

<br>

## Why Sonata

- **Why not the official Claude / Codex apps?**<br>
The CLI is still the most complete form of both agents: often save tokens, closest to
your local environment, first to get new features... Sonata keeps it untouch and builds the human experience around it.

- **Why not Cursor or an IDE agent?**<br>
Many IDE agents’ business model is a second subscription on top of the one you already pay Anthropic or OpenAI. Sonata is free and base your existing subscription. In addition, IDE agents keep the code editor at the center, which assumes you still primarily writing code. Sonata assumes you work primarily shift to intent, reading, and judgment. 

- **Why not just use the terminal?**<br>
If the raw terminal works for you, keep using it. Sonata even build in a real
terminal(xterm.js) - same session in terminal window, you can use it anytime. However, the terminal is built around a command stream.
Long reading, natural input, session organization, and result browsing are all things it does grudgingly. 

- **Do I need another subscription?**<br>
No. Sonata is free. It runs on the Claude / Codex subscription you
already have.

- **Does Sonata change what the agent does?**<br>
No. No injected system prompt, no modified behavior. The agent in
Sonata is the same agent you'd get in the terminal.

- **Where does my data go?**<br>
Where it already goes: to Anthropic or OpenAI, through their own
CLIs. Sonata adds no account and no server in between. Its own data
lives locally in `~/.sonata`, next to `~/.claude` and `~/.codex`.

<br>

## How it works

Sonata spawns your real `claude` or `codex` in a real terminal (a PTY,
rendered by xterm.js, same as VS Code). The agent runs exactly as it
would in Terminal.app. Everything else Sonata does is observation:

- **Reading comes from transcripts.** Both CLIs write structured session
transcripts to disk - the same files that power `--resume`. Sonata
builds its reading view from those files, not by re-rendering the
terminal screen. This is also why a reply appears when the agent
finishes it instead of streaming token by token. If you want to watch
the live stream, it's right in the terminal window.

- **Status comes from hooks.** Both CLIs ship an official hooks system.
Sonata registers its hooks additively (a `--settings` file for Claude,
a separate profile for Codex) and never edits your own config. Hooks
are how Sonata knows busy from idle, where a turn ends, and when the
agent is asking for permission.

- **Where the screen is still read.** Three narrow places. The working
strip mirrors the CLI's own status line. When you switch model or
permissions from Sonata's UI, Sonata types the CLI's own slash command
into the terminal and reads the printed receipt to confirm it landed.
And one fallback marks a failed Codex turn as done (Codex has no
"turn failed" event).

The rule behind all of it: observe, never replace.

<br>

## Design choices

- **Preserve the native agent.**

- **No injected system prompt.**

- **Structured truth before screen scraping.** Signals come from
  hooks and session transcripts.

- **No built-in editor.** When you want to edit code, your editor is
  better at it.

- **Separate windows by cognitive role.** Main window for reading and
  direction, CLI window for the raw truth, Preview for results. Each
  window resizes independently — honestly, I just hate resizing an
  app's side panels back and forth, especially with multiple
  monitors. Separate windows does bring window-management challenges. I recommend giving Sonata its own macOS Space.

- **Nothing written into your project.** Sonata itself never adds
  anything to your working directory; all its bookkeeping lives in
  `~/.sonata`. 

<br>

## Install

Download the latest DMG from
[Releases](https://github.com/woody-design/sonata/releases/latest),
open it, and drag Sonata to Applications. The app is signed and
Apple-notarized.

You'll need:

- [Claude Code](https://code.claude.com/docs/en/quickstart) and/or [Codex](https://learn.chatgpt.com/docs/codex/cli) CLI installed and logged in.
- Mac with Apple Silicon (arm64). Intel Macs are not supported yet.

<br>

## Run it locally

You'll need:

- macOS
- Node.js 22.12 or newer
- Claude Code and/or Codex CLI installed and signed in

```bash
git clone https://github.com/woody-design/sonata.git
cd sonata/app
npm install
npm run dev        # build + launch
```

To try it without touching your real data, run it sandboxed:

```bash
TMP="$(mktemp -d /tmp/sonata-XXXXXX)"
SONATA_DATA_DIR="$TMP" SONATA_WORKSPACES_DIR="$TMP/workspaces" npm run dev
```

To verify a change:

```bash
npm run build                      # typecheck + build all targets
npm run e2e:gui-walking-skeleton   # representative end-to-end gate
```

More smoke and e2e gates live in `app/package.json`.

<br>

## Why I Built This

I'm a designer. I started agentic coding this February and quickly
learned the benefits of the CLI. So I spent several weeks learning the
terminal. Trust me, I really tried — I know how to use Ctrl+U to
clear a line, along with all the other tricks for editing text and
running commands. 

But in the end it still felt unintuitive, because
the terminal itself was never designed for AI coding. And it's not
just the learning curve — several features were missing: a better
reading experience, writing long prompts (draft by voice through Typeless, then edit like in a normal text field), pasting images, previewing results, organizing sessions. That was the starting point for building Sonata. 

Now it's my daily driver — even Sonata itself is developed
through Sonata.

<br>

## Caveats

Sonata is in early beta, shaped so far by a few people's daily use. It will have bugs:

- Claude Code and Codex hooks / transcripts occasionally don't
  deliver a complete signal. That's why the CLI window is usually
  worth keeping open: it's the fallback and the diagnostic surface.
- Multiple windows across multiple macOS Spaces can get confusing.
  My own setup: one Space dedicated to Sonata, main window and CLI
  window side by side, Preview only when I need it.
- Claude and Codex are both supported, but feature parity between
  them is not promised.
- The upstream CLIs move fast. Specific gaps close, new ones open;
  expect occasional breakage right after a CLI update.
- macOS only.

If you hit one of these — or something new — please [open an issue](https://github.com/woody-design/sonata/issues/new/choose).

<br>

## Feedback

- **Bug reports** — [open an issue](https://github.com/woody-design/sonata/issues/new/choose)
- **Feature requests** — [start a discussion](https://github.com/woody-design/sonata/discussions/new?category=ideas) — upvote ideas you want to see
- **Questions** — [ask in discussions](https://github.com/woody-design/sonata/discussions/new?category=q-a)

<br>

## License

[![License: Apache 2.0](https://img.shields.io/badge/License-Apache_2.0-blue.svg?style=flat-square)](LICENSE)

[Apache 2.0](LICENSE) — Designed by [Woody](https://woodydesign.io/),
[AC](https://www.anthropic.com/news/claude-fable-5-mythos-5) &
[OC](https://openai.com/index/gpt-5-6/) in NYC
