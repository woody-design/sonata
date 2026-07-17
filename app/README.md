# Sonata App

The formal TypeScript Electron app — Sonata's daily driver. This is the shipping
codebase (not a placeholder): a two-window reading-first workspace around native
CLI coding agents. See the repo root `README.md` for the product overview and
`ARCHITECTURE.md` in this directory for the runtime contract.

## Layout

```text
src/main/
  Electron lifecycle, IPC handlers, task/runtime orchestration, window management.

src/preload/
  Typed renderer bridge (window.sonataRuntime).

src/renderer/
  Task shell + Run reading surface (index.html), the Preview window (preview/),
  and the Terminal satellite window (terminal.html). View + flow modules under
  view/ and flows/.

src/reading-core/
  Framework-free reducer/selectors that turn provider transcripts into the
  reading surface — the high-frequency window's core, driven by events.

src/runtime/
  TerminalHost, RunIndex, provider adapters (Claude + Codex), cli-signal
  (hooks/approval broker), provider-transcript normalizers, local API server.

src/shared/
  Cross-process types, schema definitions, slash registry.

tests/smoke/   fast node checks against real runtime behavior (76 suites)
tests/e2e/     Playwright-driven Electron end-to-end runs
tests/fixtures/  recorded upstream-CLI captures (frozen goldens — never rewritten)
```

## Boundary

The spike code in `spikes/electron-pty-terminalhost/` is a reference for runtime
truth, not production UI — the runtime boundary was lifted deliberately; the
spike renderer is not product design.

## Commands

```bash
npm install
npm run build              # clean → typecheck → build main/preload/renderer
npm run rebuild:electron   # after a Node/Electron ABI bump
npm run smoke:runtime-modules
npm run e2e:gui-walking-skeleton
npm start                  # launch the built app (prefer scripts/launch-dev.sh from the workshop)
```

`npm run build` runs `tsc` for main/runtime, bundles the sandboxed preload and
the renderer with Vite. Runtime handlers are semantic IPC actions owned by the
main process.

`smoke:codex-terminalhost` and `e2e:gui-walking-skeleton` launch a nested
authenticated Codex/Claude PTY; on this machine they must run outside the CLI's
normal sandbox so the nested process can reach its local provider state. A few
live-CLI suites track upstream CLI versions and can go red when a CLI moves past
the coupling-inventory watermark — reconcile with the `upstream-sync` skill, not
by editing the tests.
