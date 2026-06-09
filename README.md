# Duet

Duet is a hosted CLI agent workspace.

It preserves native CLI-agent behavior while building a reading-first,
task-oriented desktop experience around it. It is not a terminal skin, not an
IDE, and not a new agent runtime.

## Current Phase

Status: formal walking skeleton accepted; ready for guided product walkthroughs.

Duet is no longer in isolated spike mode. The Codex runtime substrate was
proven by:

```text
spikes/electron-pty-terminalhost/
```

That runtime truth has now been lifted into a formal TypeScript Electron app in
`app/`. The current walking skeleton proves:

```text
New/Open Task
  -> native Codex PTY through TerminalHost
  -> prompt submission
  -> Run creation and reading surface
  -> native approval surfaced as Duet product controls
  -> Stop / continue
  -> changed files and artifact candidates
  -> floating Preview for report-listed artifacts
  -> floating Inspector for Run / Change / Artifact / Folder truth
  -> raw Terminal as trust/debug layer
```

The current app is not beta-quality and does not claim final UX, Home/project
browser, Git workflow, Claude parity, provider abstraction, or production
packaging.

Claude Code now has an experimental provider-locked validation path:

```text
New Claude Task
  -> native Claude Code PTY through TerminalHost
  -> provider-owned workspace trust and slash-command behavior
  -> Task / Run / Preview / Inspector surfaces remain Duet-owned
```

This is not same-Task provider switching and not full Claude parity. A Task
keeps the provider chosen when it is created.

Start here:

```text
product-thinking/2026-05-16-acceptance-checkpoint-refresh-v1.md
product-thinking/2026-05-16-woody-testing-script-v0.md
product-thinking/2026-06-09-claude-runtime-validation-v0.md
product-thinking/2026-05-15-three-surface-ux-architecture.md
product-thinking/2026-05-15-terminalhost-runtime-contract.md
product-thinking/2026-05-14-duet-mvp-product-architecture.md
```

## Local Run

From the app directory:

```bash
cd app
npm run dev
```

For a clean guided walkthrough with isolated Task data:

```bash
cd app
DUET_PROJECTS_DIR="$(mktemp -d /tmp/duet-woody-test-XXXXXX)" npm run dev
```

## Local Latest Channel

For repeated human testing, use the local latest channel instead of a packaged
app:

```bash
scripts/update-latest.sh
scripts/install-desktop-shortcuts.sh
```

This installs two Desktop shortcuts:

```text
Duet Latest.command
Update Duet Latest.command
```

`Duet Latest.command` launches the latest built app. `Update Duet Latest.command`
installs dependencies and rebuilds the app. Both use persistent dev data at:

```text
~/Library/Application Support/Duet Dev/Projects
```

Updating the app does not delete previous Task / Run / artifact records. Close
Duet before updating; live native PTY sessions are not expected to survive a
rebuild.

## Verification

Core health check:

```bash
cd app
npm run build
```

Representative walking-skeleton gate:

```bash
cd app
npm run e2e:gui-walking-skeleton
```

Provider validation gates:

```bash
cd app
npm run smoke:claude-terminalhost
npm run e2e:provider-locked-task
```

The app has additional E2E and smoke gates in `app/package.json` for Task
entry, approval, Stop/continue, Open Task, Preview, Inspector, Task tabs, Run
reading, and runtime report behavior.

## Repository Map

```text
app/
  Formal TypeScript Electron walking skeleton. Main owns runtime; renderer
  owns Main Chat, floating Preview, floating Inspector, and Terminal surfaces.

product-thinking/
  Current product architecture, runtime contracts, and phase handoffs.

decisions/
  Durable architecture decision records. Use this for decisions that should
  survive beyond one planning document.

research/
  External research, prior-art audits, and design/technical evidence.

spikes/
  Completed or active technical proofs. Spikes are material references, not
  production source.

archive/
  Superseded material that no longer participates in current reasoning.

ai-conversations/
  Historical conversation notes that may inform product direction.
```

## Working Rule

Product truth moves from research to spike to contract to app:

```text
research -> spikes -> product-thinking contracts -> app
```

Do not skip the direction of evidence. Spikes can prove material behavior, but
formal app code should encode only the resulting contract, not incidental spike
UI or temporary probe assumptions.
