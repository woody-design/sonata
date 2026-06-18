# Duet

Duet is a reading-first desktop workspace around native CLI coding agents.

It runs your real `claude` / `codex` CLIs and keeps their native behavior,
but wraps them in a task-oriented, readable, trustable surface. It is not a
terminal skin, not an IDE, and not a new agent runtime.

The bet: with capable CLI agents, the bottleneck is no longer the model —
it's the surface. You need to *read* what the agent did, *trust* where it is
right now, and *step in* when it matters. A raw terminal gives you none of
those well. Duet is the layer that does.

## Status

Duet is my daily driver — I run real work through it. It's well past the
walking-skeleton stage, but still personal and early: not packaged, no
polish promises for anyone but me.

What works today:

- **Main Chat** — a reading-first transcript. Provider session JSONL
  (Claude / Codex) is normalized into provider-neutral turn cards: markdown,
  folded tool calls, plan blocks, run attribution. Tuned typography + reading
  themes (light/dark).
- **Signal layer** — busy/idle, approvals, and turn boundaries come from
  Claude Code **hooks** (structured events), not screen-scraping. Scraping
  survives only as a narrow, labeled fallback.
- **Semantic slash** — skills prepend a chip in the composer; stateful
  controls (`/model`, `/permissions`…) open native popovers; panels and
  unknown commands route to the Terminal view.
- **Read / Terminal switch** — the raw terminal is a co-equal surface, picked
  by a header switch (default Read). Both *are* Duet; the switch chooses the
  lens. You type into the terminal anytime — no take-over gesture. A single
  writer is held automatically: an in-flight automation write buffers your
  keystrokes (no interleave), and delivery pauses while you're typing or have
  an uncommitted line. Auto-surfaced on a native panel Duet can't drive.
- **Sidebar** — past sessions and projects; instant read of a dormant
  session (file I/O), lazy resume on first new message.
- **Window shell** — a macOS full-height-sidebar window (no OS titlebar
  strip; traffic lights float over the sidebar). Sidebar and reading column
  are two full-height bands toned from a per-theme depth ladder; the reading
  surface is flat with frosted scroll edges.
- **Floating Preview / Inspector** — artifacts, changed files, and
  run / change / artifact / folder truth in their own windows.
- **Settings, usage, resume** — a settings overlay, an honest usage
  indicator, and a pre-spawn resume choice for large sessions.

Provider is chosen per task at creation (Claude *or* Codex) and not switched
mid-task. This is not Claude/Codex feature parity.

## Architecture in one line

> Match each concern to the truth of its medium.

- **The runtime is the portable brain.** `main/` + `runtime/` own PTY
  orchestration, the hooks-driven signal layer, transcript normalization,
  and delivery — all UI-agnostic. The renderer is the replaceable shell.
- **Observe high-frequency, render low-frequency.** Structured signals
  update an in-memory state model; the renderer touches only what changed
  (no full rebuild on a status tick).

Start here:

```text
product-thinking/2026-06-18-terminal-surface-redesign-v0.md      # Read/Terminal switch + automatic single-writer arbitration (supersedes the "floor")
product-thinking/2026-06-18-ui-shell-redesign-v0.md             # the window shell, two-tone token ladder, scroll fade
product-thinking/2026-06-13-cli-integration-architecture-v0.md   # signals, surfaces (the take-over "floor" is superseded — see terminal-surface-redesign)
product-thinking/2026-06-09-semantic-transcript-contract-v0.md   # the reading-surface transcript channel
product-thinking/2026-06-17-dev-worktree-workflow-v0.md          # how I run + ship it (workshop vs daily driver)
```

## Running it

Day to day I keep two checkouts — a git **worktree** — so I can develop Duet
while using it, without a build ever disturbing the running app:

| Desktop shortcut | Does |
|---|---|
| `Duet Latest.command` | launch the daily driver |
| `Duet Dev.command` | launch the workshop (the dev worktree, fully isolated data) |
| `Promote Duet to Latest.command` | ship a verified change from the workshop to the daily driver |

The full model — isolation layers, the daily loop, the one rule (*never build
in the daily driver*) — is in
`product-thinking/2026-06-17-dev-worktree-workflow-v0.md`.

One-off run, no worktree:

```bash
cd app
npm run dev            # build + launch
```

Throwaway session with isolated Task data:

```bash
cd app
DUET_PROJECTS_DIR="$(mktemp -d /tmp/duet-XXXXXX)" npm run dev
```

## Verifying

```bash
cd app
npm run build                      # typecheck + build all targets
npm run e2e:gui-walking-skeleton   # representative end-to-end gate
```

More smoke and e2e gates live in `app/package.json`.

## Repository map

```text
app/               the Electron app. main/ owns the runtime; renderer/ owns
                   Main Chat, floating Preview, floating Inspector, Terminal.
product-thinking/  current architecture, runtime contracts, slice briefs + findings.
decisions/         durable architecture decision records.
research/          external research and prior-art audits.
spikes/            completed technical proofs (material reference, not source).
archive/           superseded material, kept out of current reasoning.
```

## Working rule

Truth moves one direction:

```text
research → spikes → product-thinking contracts → app
```

Spikes prove material behavior; app code encodes the resulting contract — not
incidental spike UI or temporary probe assumptions.
