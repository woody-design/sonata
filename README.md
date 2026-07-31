# Sonata - use Terminal the way you use ChatGPT

Terminal is the best workspace for AI agents. It was just never
designed for the human side of the work: reading long output, editing
prompts, previewing results, managing sessions.

Sonata adds the experience layer. Your Claude Code & Codex agents run natively
in the terminal, with full capabilities on your existing
subscription. You read, write, and manage everything in a modern
interface as familiar as ChatGPT.

Free and open source · macOS · No sign-up · No telemetry · No server

Sonata is built for a new generation of coders, builders, and design
engineers — people whose work no longer centers on writing or editing
code, but on collaborating with AI: give direction, judgment, and taste.

**[▶ Watch the 3-minute demo](https://youtu.be/Bvi27v0_OkI)**

[![Watch the 3-minute demo](docs/assets/demo-cover.png)](https://youtu.be/Bvi27v0_OkI)

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

## What Sonata does

**Read.** Sonata
normalizes Claude and Codex session data into clean turn cards —
markdown, folded tool calls, plan blocks, run attribution — with tuned
typography and light/dark reading themes.

**Write.** The composer is built for expressing intent: type naturally,
attach files and images, steer work that's already in flight. Slash
commands are semantic — skills become chips, stateful controls like
`/model` and `/permissions` open native popovers instead of text menus.

**Manage.** Name your session, tag
them, filter them, organize them by project.

**Preview.** Check outcomes without opening an editor. Markdown, HTML,
images, file trees, and changed files open in floating preview windows.

The raw terminal stays one switch
away — same session, same process — and you can type into it anytime.

## What Sonata is not

- **Not a terminal skin.** The reading surface is built from structured
  session data, not from re-rendered terminal output.
- **Not an IDE.** There is deliberately no code editor inside.
- **Not a new agent runtime.** It runs your real `claude` and `codex`,
  unchanged.
- **Not another subscription.** Sonata is free and uses the Claude /
  Codex subscriptions you already have.
- **Not a cloud layer.** No account, no server, no telemetry. Sonata's
  own state lives on your machine.

## Design choices

- **Preserve the native agent.** Sonata runs the real CLIs and keeps
  their behavior, configuration, and update pace. It is an experience
  layer, not a fork.
- **No Sonata system prompt.** Sonata doesn't inject its own
  instructions into the agent. This is a product boundary, not a missing
  feature: you should get exactly the agent you'd get in the terminal.
- **Structured truth before screen scraping.** Signals come from hooks
  and session transcripts — data the CLIs deliberately expose. Reading
  the screen survives only as a narrow, labeled fallback.
- **No built-in editor; preview outcomes instead.** When you want to
  edit code or prose, your editor is better at it. What Sonata owns is
  the fast loop of *seeing what was produced*.
- **Separate windows by cognitive role.** The CLI and Preview live in
  their own windows rather than being squeezed into sidebars. Main
  window for direction and reading; CLI window for raw truth; Preview
  for results. On a large screen they sit side by side.
- **Local and inspectable.** Open source, no Sonata account, state on
  disk. Your prompts still go to Anthropic or OpenAI through the native
  CLIs — Sonata just refuses to add a new trust boundary in between.

## Caveats

Sonata is early, and shaped so far by one person's
daily use — mine. Real work runs through it every day, but the edges
show:

- Claude Code and Codex hooks / transcripts occasionally don't deliver a
  complete signal. That's why the CLI window is usually worth keeping
  open: it's the fallback and the diagnostic surface.
- Multiple windows across multiple macOS Spaces can get confusing. What
  works well: dedicate one Space to Sonata, main window and CLI window
  side by side.
- Claude and Codex are both supported, but feature parity between them
  is not promised.
- The upstream CLIs move fast. Specific gaps close, new ones open;
  expect occasional breakage right after a CLI update.
- macOS only.

If you hit one of these — or something new — please open an issue.
Knowing where it breaks for someone who isn't me is exactly what this
stage needs.

## Install

Download the latest DMG from
[Releases](https://github.com/woody-design/sonata/releases/latest),
open it, and drag Sonata to Applications. The app is signed and
notarized; macOS will run it without warnings.

You'll need:

- A Mac with Apple Silicon (arm64). Intel Macs are not supported.
- Claude Code and/or Codex CLI installed and authenticated.

## Run it locally

You'll need:

- macOS
- Node.js 22.12 or newer
- Claude Code and/or Codex CLI installed and authenticated

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

## License & trademark

Sonata's source code is licensed under the
[Apache License 2.0](LICENSE). "Sonata", the Sonata name, and the Sonata
logo are trademarks of Woody Li and are not licensed under Apache-2.0;
the license grants no permission to use them. Forks and redistributions
must use a different name and logo.
