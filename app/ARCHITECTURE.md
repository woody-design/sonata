# Duet App Architecture — the Reading Window

This document describes the renderer architecture that emerged from the
2026-07 decomposition program (design record:
`product-thinking/2026-07-03-renderer-decomposition-map-v1.md`, execution
history: `…-execution-log.md`). It covers the Reading window — the main
surface. The satellite renderers (terminal, preview) are separate
vite entries with their own, smaller files.

## The one-paragraph version

The Reading window is an MVU-shaped, framework-free renderer. A single state
atom drives everything; runtime events from the main process flow through one
pure reducer that returns *render directives* — data describing which paint
path to take; view modules build DOM imperatively from state; a thin
composition root (`renderer/main.ts`) wires it all together. The pure model
(`reading-core/`) compiles without DOM types by construction, so all decision
logic unit-tests in plain node against a recorded corpus of real sessions.

## Layers

```
src/reading-core/           PURE MODEL — no DOM, no Electron (compiler-enforced:
  state.ts                  tsconfig.main has no DOM lib; a `document` reference
  runtime-reducer.ts        is a build error)
  directives.ts
  config.ts
  selectors/                pure state → derived data
  transitions/              named state mutations (policy-bearing)

src/renderer/               DOM SHELL
  main.ts                   composition root: boot, wiring, input grammar,
                            small controllers, the actions/deps bindings
  dom.ts                    shell template + `elements` registry (leaf)
  actions.ts                the behavior seam (interface + registry; leaf)
  render.ts                 paint orchestrator: render(), transcript stream,
                            performDirective
  scheduler.ts              every debounce/interval (T-numbered, see below)
  flows/                    async orchestrations (create/submit/resume/approve…)
  view/                     one module per surface family; imperative DOM
```

Import direction is machine-enforced by `smoke:import-fence` (layer rules as
data, main.ts denylist, unclaimed-module check, acyclicity over the whole
graph). The essentials:

- `reading-core` imports only itself + `shared/`.
- `view/*` may import dom/icons/popover-geometry/reading-core/shared and the
  actions **interface** — never flows, render, scheduler, main, or a sibling
  view family (cross-view composition goes through the composition root).
- `flows/` may import render, actions (types), dom, reading-core — never view
  families or the scheduler; those arrive as init-bound deps.
- `render.ts` imports every view family; nothing imports `main.ts`.
- A new module MUST claim a RULES row (or be a registered composition root) —
  the fence fails on unclaimed files.

## State

One mutable atom (`RendererState`, created by `createInitialState`) with two
regions: per-task runtime projections (`state.taskViews: TaskViewState[]` —
runs, transcript blocks, approvals, delivery, usage) and global UI state
(drafts, popovers, sidebar, settings overlay). **Mutation-in-place is
deliberate and load-bearing**: the transcript reconcile engine detects change
by reference identity (`transcriptBlocks.set` replaces changed block refs;
unchanged blocks keep theirs), captured as version numbers in a WeakMap
(`createTurnSignatureTracker`). Do not introduce immutability here.

A few truths deliberately live OUTSIDE the atom (the shell owns them):
- the composer textarea's text (DOM is the live truth; drafts park/restore on
  ownership change),
- the terminal-window open flag (the toggle button's `aria-pressed`),
- IME composition guards and the matchMedia dark-mode mirror,
- live elapsed clocks (`data-started-at`, ticked in place by T1).

Core state holds **plain data + opaque handles it never inspects** — e.g.
`ComposerAttachment.file` is `unknown` in the core type; only shell code
narrows it back to `File`. DOM rects become plain `AnchorRect` snapshots at
the capture site.

## The event path (the heart)

```
main process ──runtime event──▶ reduceRuntimeEvent(state, event, clock)
                                   │  mutates state (verbatim policy)
                                   ▼
                              Directive[]  (ordered; render + effect families)
                                   │
                         performDirective, 1:1, in order
                                   ▼
        full render() · sidebar-only · strip-in-place · usage-in-place ·
        transcript-debounced · session-index-debounced · report-refresh · none
```

The render-path choice IS the product's feel: a usage tick must never full-
render (it would wipe a text selection), a tool-only cli-state change must not
rebuild the sidebar (it would restart the spinner animation), the ~3 Hz
working-status relay patches one strip region in place. These policies are
**data returned by the reducer**, and `smoke:reading-runtime-reducer` replays
the pinned corpus of real recorded sessions (`tests/fixtures/runtime-events/`)
against a differential oracle + final-state goldens + hand-written adversarial
cases on every run. Goldens regenerate only via `WRITE_REDUCER_GOLDENS=1` and
a reviewed diff; `smoke:corpus-lint` keeps both fixture trees free of
account/environment data (captures are raw — pin only through
`scripts/sanitize-runtime-corpus.mjs`).

User interactions do not go through the reducer: handlers call **transitions**
(named, policy-bearing state mutations in `reading-core/transitions/`) or
perform grammar-level assignments directly, then invoke the right render path.
*A mutation earns a named transition when it carries policy — guards,
displacement rules, multi-field invariants; bare event-handler assignments are
grammar.*

## Seams (how layers talk without cycles)

- **Reads**: view/flow modules take the atom by init-binding
  (`initXxxView(state)` / `initXxxFlows(state)`) — reads are a module's job,
  never disguised as actions. Shell-satellite truths arrive the same way
  (`resolvedReadingMode`, `isComposerComposing`).
- **Behaviors**: `actions.ts` — a typed registry bound once at boot. Flat,
  family-prefixed, one action per handler; implementations are the verbatim
  handler bodies living in the composition root.
- **Composition**: cross-view needs (the transcript's no-task empty state
  showing the entry panel) are init-bound deps provided by main.ts.
- **Upward calls** (render→scheduler, scheduler→flows, flows→shell-views) are
  init-bound deps too — one mechanism everywhere.

Historical note: an `invalidate.ts` indirection seam existed while `render()`
still lived inside main.ts (importing it from flows would have cycled). When
D4a made render.ts a real module the cycle rationale vanished and the seam was
retired — the layering matured past its scaffolding.

## Scheduling (T-numbers)

All timing lives in `scheduler.ts` or verbatim inside its owning module —
delays and coalescing are behavior, not cleanup targets. T1 1 s strip clocks ·
T2 150 ms session-index debounce · T3 160 ms transcript render debounce ·
T4 sticky-header rAF (prompt-nav) · T5/T6 usage-popover hover 150/180 ms ·
T7 1200 ms copy-reset (chrome) · T8 resizer rAF (main.ts wiring) · T9–T11
menu/rename rAFs (sidebar) · T12 post-render scroll microtask (flows) ·
G1 slash-cache TTL · G2 IME 80 ms composition guard (main.ts).

## Boot order (load-bearing)

state atom → shell template (`initDom`) → `elements` registry → seam/view/flow
bindings → icon + pref hydration + listener grammar → runtime subscriptions →
async hydrates (Claude defaults BEFORE the session index makes dormant
sessions clickable) → first `render()`. Bindings reference hoisted function
declarations, so binding-before-definition is safe; never move initialization
into import-time side effects of modules.

## Testing

Two fence families, zero test frameworks:
- **smokes** (`tests/smoke/*.mjs`, plain node against `dist/`): the pure-core
  fixture suites, the corpus-replay crown fence, `import-fence`,
  `corpus-lint`, `reading-core-purity`.
- **e2es** (`tests/e2e/*.mjs`, Playwright driving the built app): the outer
  behavior fences. `transcript-selection` guards the reconcile engine's
  selection survival; CSS classes, ids, and `data-*` attributes are test API —
  treat renames as breaking changes.

The recorder that feeds the corpus is env-gated main-process instrumentation
(`DUET_RUNTIME_EVENT_LOG=<dir>`) tapped at the `sendEvent` broadcast seam —
test/dev capture semantics, synchronous by design (lossless beats latency;
measured overhead is noise).

## The Preview window (satellite)

The reading surface for *files* (the Reading window reads the conversation; the
Terminal carries raw process). It rebuilt the old Preview + Inspector satellites
on a **three-truths** model (design record:
`product-thinking/2026-07-04-preview-window-redesign-map-v1.md`), each truth with
one honest owner:

- **Disk truth** — what exists and what its bytes are. Observed, never stored,
  through `main/workspace-files.ts` (`WorkspaceFiles`: the single audited
  path/symlink guard, the read + classification ladder, the `duet-file://` image
  protocol, and Finder/Cursor external-open).
- **Session truth** — the ordered tab claims, active path, per-path scroll, and
  panel-open flag. Owned by main and durable in `main/preview-sessions.ts`
  (`PreviewSessions`); close/archive keep a task's claims, only delete forgets
  them (§6.1 task reading memory).
- **View truth** — the dirty set, tree expansion, loaded-children cache, and
  filter text. Owned by the renderer (`renderer/preview/` — `main.ts` root +
  `tabs`/`toolbar`/`tree`/`reader`/`state`), never persisted, never across IPC.

Every feature is one operation — *reconcile a claim against disk truth* — so
tombstone, dirty dot, live morph, restore, and resurrection are five renderings
of one mechanism. The window binds one task and follows the Reading window's
active task. Deliberately smaller than the Reading window: no reducer, no corpus
replay (its event rate is human-writing-pace, not an event firehose).

**Freshness caveat (do not "fix"):** the tree shows every entry including hidden
ones (R4), but the per-task `fs.watch` stream excludes `.git`, `.duet`,
`node_modules`, `__pycache__`, etc. (`shouldIgnorePath`). Those directories
render and give a correct one-shot listing on expand, but emit no `file:changed`,
so they will not *live-refresh* in place. That is intended noise control, not a
bug.
