# Sonata App Architecture — the Reading Window

This document describes the renderer architecture that emerged from the
2026-07 decomposition program (design record:
`product-thinking/2026-07-03-renderer-decomposition-map-v1.md`, execution
history: `…-execution-log.md`). It covers the Reading window — the main
surface. The satellite renderers (terminal, preview) are separate
vite entries with their own, smaller files. Two subsystems beyond the reading
renderer have their own sections below: **the signal layer** (the main-process
control plane that produces the runtime events the reducer consumes) and **the
Preview window**.

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
  rename-flow.ts            core-owned async flow: the single-flight rename
                            lifecycle, driven through injected ports
                            (`RenamePorts`) so it carries no Electron knowledge
                            and unit-tests in plain node. `flows/` stays the
                            home for shell-BOUND orchestration; a flow whose
                            only outside contact is a narrow injected port lives
                            in the pure core instead.
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
  flows/                    async orchestrations (create/submit/resume/approve/
                            rename…) — shell-bound; the pure single-flight
                            rename lifecycle stays in reading-core/rename-flow.ts
                            (rename-flows.ts is its shell-bound controller)
  view/                     one module per surface family; imperative DOM
```

Import direction is machine-enforced by `smoke:import-fence` (layer rules as
data, main.ts denylist, unclaimed-module check, acyclicity over the whole
graph). The essentials:

- `reading-core` imports only itself + `shared/`.
- `view/*` may import dom/icons/popover-geometry/reading-core/shared and the
  actions **interface** — never flows, render, scheduler, main, or a sibling
  view family (cross-view composition goes through the composition root). The
  sole intra-view import allowed is `view/rename-editor`, a cross-surface
  protected-widget (icons/popover-geometry class) that both the header (via
  render.ts) and the sidebar rows/projects mount; it owns no surface of its
  own, so it is an importable view utility, not a sibling family.
- `flows/` may import render, actions (types), dom, reading-core — never view
  families or the scheduler; those arrive as init-bound deps.
- `render.ts` imports every view family; nothing imports `main.ts`.
- A new module MUST claim a RULES row (or be a registered composition root) —
  the fence fails on unclaimed files.

`view/rename-editor` earns its shared-utility status through a **protected-node
pattern**: it hands out exactly one `<input>` per editor lifetime, and repeated
renders move that node into a freshly reconciled host but never recreate it —
so caret, selection, focus, and the browser's IME composition owner survive
background paints. It is the transcript reconcile engine's identity-preservation
philosophy (below) narrowed to a single widget that two surfaces both mount.

## State

One mutable atom (`RendererState`, created by `createInitialState`) with two
regions: per-task runtime projections (`state.taskViews: TaskViewState[]` —
runs, transcript blocks, approvals, delivery, usage) and global UI state
(drafts, popovers, sidebar, settings overlay). The sidebar cluster carries the
inline-rename lifecycle (`renameEditor`, `renameRequestVersion`, `renameNotice`)
alongside its progressive-`disclosure` intent. **Mutation-in-place is
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

Delivery *to* that boundary is **interest-routed** (OBS D5): the main process
filters at the `sendEvent` seam by window kind, so the Terminal receives only
`pty:*`, the Preview window only `file:changed`, and the Reading window (plus any
unknown window, fail-open) everything else — no window pays the reducer cost of
events it does not consume.

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
delays and coalescing are behavior, not cleanup targets. T1 1 s strip clocks
(the permanent timer stays armed, but each tick idle-guards on the strip's
`hidden` class — a live-clock node exists only while the strip is visible, so
zero live runs ⇒ one DOMTokenList check, no querySelectorAll; OBS S5) ·
T2 150 ms session-index debounce · T3 160 ms transcript render debounce ·
T4 sticky-header rAF (prompt-nav) · T5/T6 usage-popover hover 150/180 ms ·
T7 1200 ms copy-reset (chrome) · T8 resizer rAF (main.ts wiring) · T9–T11
menu/rename rAFs (sidebar) · T12 post-render scroll microtask (flows) ·
T13 300 ms rename progress reveal (rename-editor) · T14/T15 rename-editor Tab
focusin-cleanup timeout-0 / initial-focus rAF · T16 rename pointer-boundary
timeout-0 (flows/rename-flows) · T17 150 ms quote-comment selection debounce /
T18 quote-comment reposition rAF (view/quote-comment) · T19 3000 ms transcript
copy-feedback reset, success and failure alike (view/transcript) · G1
slash-cache TTL · G2 IME 80 ms composition guard (main.ts).

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

Visual acceptance (screenshot evidence) lives INSIDE the owning functional
e2e behind an env flag (`SONATA_*_EVIDENCE=1` + a `-screenshots` npm alias),
captured only after the functional path has fully passed — so every screenshot
depicts a state the fence just proved correct, on app state the run already
drove (ratified 2026-07-14, `copy-to-clipboard`). Older standalone
`*-screenshots.mjs` files predate this; migrate opportunistically when
touched, don't add new ones.

The recorder that feeds the corpus is env-gated main-process instrumentation
(`SONATA_RUNTIME_EVENT_LOG=<dir>`) tapped at the `sendEvent` broadcast seam —
test/dev capture semantics, synchronous by design (lossless beats latency;
measured overhead is noise).

A sibling env-gated main-process instrument, `SONATA_PERF_LOG` (`main/perf-log.ts`,
OBS S9), streams the observation-cost tripwire evidence: a coarse 500 ms
event-loop-lag histogram summarised every ~30 s and at quit (the AD-1
"does the main loop stall under load" signal) and one line per run-index flush
carrying wall duration + serialized size (the AD-2 "is a report big/slow enough
to justify SQLite" signal). `=1` writes to stderr, `=<dir>` to a per-run file;
default off — and off means `createPerfLog` returns `null`, so the sole cost is
one boolean check (no sampler, no timer, no per-flush timing). The flush seam
lives on run-index (where the bytes already exist), never on Projection.

## The signal layer (control plane)

The event path above starts with "main process ──runtime event──▶". This is where
those events are *born*: the main-process subsystem that turns two live CLIs
(Claude, Codex) into one stream of structured signals — busy/idle, turn
boundaries, identity, usage, approvals — without either CLI losing a feature
(design record: `product-thinking/2026-07-06-codex-control-plane-plan-v0.md`).
Sonata is an experience shell over the user's *real* CLI, so the rule is additive:
observe the process, never replace or reconfigure it.

**The observation-cost constitution (OBS program, ratified 2026-07-25).** The
signal layer's founding rule — *observe, never replace* — governs correctness; a
second ratified rule governs cost. Raw signals are absorbed once at the boundary
into cheap derived state; every downstream consumption — disk persistence,
cross-process delivery, rendering — is a **bounded, clocked, interest-scoped
projection** of that state, never a reaction to an individual event. From it
follows the standing rule that joins "observe, never replace": **observation must
be near-free** — Sonata's marginal cost over the bare CLI approaches zero, so any
recurring cost that scales with a workload's *byproducts* (build outputs,
transcript length, task age, history size) rather than with user-visible work is
a bug regardless of its measured size. The disease it cured: persistence and
broadcast were per-event side effects, so a producer (a Gradle build, a spinner)
set the write and IPC rate — one incident wrote 549.78 GB in under two hours.

**The Projection primitive (`runtime/projection.ts`, OBS D1).** The
constitution's "clocked" is one small class: it owns a dirty flag and a
trailing-*fixed* debounce cadence (arm-once → fire → re-arm, so a steady mark
stream flushes every ~window and never starves — a sliding deadline would push
forever under continuous load), plus named critical-immediate triggers,
`flushNow()`, and a flush-then-`seal()` teardown after which every late straggler
mark is a no-op — the structural guard that stops a disposed record from
re-creating its own just-deleted directory. Its timer/clock is injectable, so the
cadence unit-tests deterministically (`smoke:projection`). Every bounded
persistence path in the main process flows through it; the **run-index runtime
report** (`runtime/run-index/`) is the first adopter — a build storm marks the
report dirty at its own rate, but the write and the `report:updated` broadcast
fire together at most once per window. That report is a **cache** (OBS D2), not a
source of record: derived and rebuildable, bounded (per-bucket caps + an explicit
`droppedCount` so truncation is never silent), compact JSON, best-effort
durability (routine mutations trail ~1 s; critical lifecycle events flush
immediately) — losing ≤1 s of tail on a crash is accepted.

**The hook contract is an adopted industry standard, not a Sonata invention.**
Codex GA'd a hooks system that clones Claude Code's field-for-field (envelope,
values vocabulary, `tool_name:"Bash"`). We consume that wire schema verbatim —
snake_case field names and all (`shared/types/cli-signal.ts: HookPayload`). Sonata
metadata lives *outside* the payload in an envelope
(`HookEnvelope { provider, taskId, receivedAt, payload }`), so "aligned with the
standard or not" stays greppable forever. Boundary validation is **tolerant**:
validate only the fields we consume, pass unknown fields through, never hard-fail
on additions — the two CLIs iterate, and additive drift must cost nothing. The
probes (`spikes/codex-hooks-probe`, `spikes/codex-injection-probe`) are the
regression assets that catch the NON-additive drift; re-run on CLI major bumps
(plan §7.5).

**Provider difference collapses to two true edges.** Everything else — the
watcher, the state model, the broker, the notification policy — is
provider-neutral and shared:

```
runtime/cli-signal/
  hook-sink.ts            the shim's write protocol (payload → <runtimeDir>/hooks)
  hook-watcher.ts         provider-neutral; sink-dir injected, watches both
  cli-state.ts            applyHook is standard-schema-agnostic — one model
  approval-broker.ts      provider-neutral echo (writes reply-<id>.json)
  approval-watcher.ts     provider-neutral (<runtimeDir>/approvals resolver)
  approval-protocol.ts    single-sourced ask/reply/expired/answered prefixes
runtime/cli-signal/claude-runtime-settings.ts — EDGE 1a: --settings file
                          (historically homed with the shared core; the codex
                          edge got the providers/ home — a future tidy, not a rule)
runtime/providers/codex/
  codex-runtime-settings.ts  EDGE 1b: writes ~/.codex/sonata.config.toml + shims
  codex-approvals.ts         EDGE 2b: decision JSON shape + answering marker
```

- **Edge 1 — injection** (how our hooks get registered). Claude takes a
  `--settings` file; Codex takes a `-p sonata` profile
  (`$CODEX_HOME/sonata.config.toml`, `CONFIG_PROFILE_V2`) that layers onto — never
  clobbers — the user's own config, unioning with their hooks both ways. ONE
  additive, Sonata-named file; inert unless Sonata passes `-p sonata`; the user's files
  are never edited.
- **Edge 2 — decision shape** (what JSON answers an approval). The broker echoes
  whatever Sonata writes; only the reply JSON differs per provider (Codex =
  `{hookSpecificOutput:{hookEventName:"PermissionRequest",decision:{behavior}}}`),
  and it fails **closed** (only an explicit approve-family value allows).

**Trust: one stable shim, one-time ceremony, never the bypass flag.** Codex binds
hook trust to the *exact* command-string text — change the string and that hook
is silently untrusted. So all Sonata hooks route through **stable shim paths with
task-invariant args** (`~/.sonata/bin/*.js`, path+args frozen, content refreshed
behind them); per-task binding travels via **environment** (`SONATA_RUNTIME_DIR`),
which hook processes inherit (probe-verified), never via argv. The full frozen
hook set (5 core events → sink; `PermissionRequest` → broker, `timeout=120`) is
registered up front; interim behavior is gated by runtime **marker files** the
shims check (the broker exits 0 immediately — instant native card — until the
answering marker exists), never by editing a definition. Generating the profile
is deterministic and **byte-stable** (`smoke:codex-runtime-settings` sha-pins it).

> **D4 overturned (2026-07-06).** The shim-stability design above was motivated
> by making a hook-trust grant persist — but field use proved codex does NOT
> persist hook trust for a `-p sonata` PROFILE layer (only User/SessionFlags
> layers can; compounded by a silent write bug under node-pty). So Sonata now
> passes `--dangerously-bypass-hook-trust` on every codex spawn (codex's
> documented path for automation that vets its own hooks; it does NOT un-gate
> untrusted-repo hooks). The stable shim stays (still tidy, keeps the hook
> command hash constant), but its trust-persistence motivation is moot. Research:
> `spikes/codex-hook-trust-research/`.

**Runtime binding: our hooks run on our OWN interpreter, not the host's.** Every
hook / broker / statusline command Sonata injects is a short JS shim that needs a
JS interpreter to run. Neither CLI ships one — both are self-contained native
binaries with no Node dependency — so an early build that started each command
with bare `node` had an undeclared host dependency: on a clean machine (no brew,
no Node) every hook ran to exit 127, the SessionStart handshake never fired, and
Codex transcript binding stayed blank. But Sonata already ships a JS interpreter:
Electron. So every injected command is single-sourced through one prefix
(`runtime/interpreter.ts: SONATA_INTERPRETER_PREFIX`) and takes the exact shape:

```
ELECTRON_RUN_AS_NODE=1 "${SONATA_NODE:-node}" "<script>" <args...>
```

`ELECTRON_RUN_AS_NODE=1` makes the Electron binary run as a plain Node process.
`$SONATA_NODE` is the running app binary (`process.execPath`), injected into the
CLI spawn env beside `SONATA_RUNTIME_DIR` (`runtime-controller.buildStartOptions`)
— it rides the same probe-verified inheritance channel the shims already trust,
and being env-keyed it never appears in the command TEXT, so an app path with
spaces or quotes needs no shell-quoting (the sole expansion site is double-quoted).
`ELECTRON_RUN_AS_NODE` stays **inline**, never in the spawn env — an env-level
value would poison any Electron binary the CLI's own children spawn, silently
turning them into node too. External Node dependency drops to zero; the shim
interpreter is pinned to the app's embedded Node (v24.15.0 in the packaged build)
instead of whatever the machine's PATH serves; and the command string becomes a
cross-machine constant (no absolute interpreter path — better hash stability than
the old shape). The `${SONATA_NODE:-node}` fallback covers the one case where the
env var is absent — a user manually running `codex -p sonata` OUTSIDE Sonata (the
profile persists in `~/.codex`) — degrading to exactly the old bare-`node` PATH
behavior rather than a noisy empty-string exec.

> **Architectural commitment — the Electron `RunAsNode` fuse is LOAD-BEARING.**
> `ELECTRON_RUN_AS_NODE` only works while Electron's `RunAsNode` fuse is ON. Our
> build has NO `@electron/fuses` step, so the fuse is at its default — ON — and it
> **must stay on**. Flipping it off (a common item on Electron-security hardening
> checklists) would silently kill EVERY hook, broker, and statusline command on
> the next release, with no build error and no test failure in a suite that
> doesn't run the packaged artifact — the failure surfaces only as blank
> transcripts and dead statuslines in the field. If the fuse ever must be closed
> for a security requirement, the escape hatch is to compile the shims to a
> standalone helper binary (bun/Rust/Swift) and invoke that instead — rejected for
> now because it adds a toolchain plus nested-binary signing/notarization to ship a
> runtime we already ship. Precedent for keeping it on: VS Code ships
> hardened-runtime + notarized with `run-as-node` in active use for its CLI. Probe
> that validated the packaged, signed, hardened-runtime app runs scripts under
> `ELECTRON_RUN_AS_NODE`: `spikes/hook-runtime-binding-probe` (2026-07-23).

**Liveness is the honesty valve.** With trust bypassed, hooks fire on every
spawn, so absence is the only failure signal — Sonata never guesses. The
`SessionStart` handshake doubles as the liveness check: no handshake within a
beat of spawn ⇒ the hook shim failed to fire (e.g. its interpreter isn't on
PATH), and a renderer-local banner points the user at the Terminal (a codex
task's 12s window; a late handshake clears it; `pty:exit` retires it). A codex
spawn whose profile write fails **degrades to a hookless Terminal-driven session**
(loud log + liveness banner + a needs-you notification) rather than aborting — an
accepted degrade, surfaced not silent.

**Identity by ownership, not inference.** The handshake carries `session_id` +
`transcript_path`; adoption binds the task to THAT rollout/jsonl by id, with **no
mtime/cwd fallback** for either provider — the fix for two same-cwd sessions
cross-binding. Native resume rides the same seam: the persisted
`transcript-sources` tail becomes the `resumeRef`, the spawn is `codex resume
<ref> -p sonata` / `claude --resume`, and SessionStart re-fires (`source:"resume"`
on codex) to re-confirm the *same* id — identity continues, the rollout is
re-tailed, no fork (`e2e:codex-resume-reopen`).

**One scrape net is deliberately kept.** Hooks retired codex's TUI-scrape
heuristics (busy/idle, turn-end, approval hints, PTY-key replays). The lone
survivor for both providers is the composer-quiescence `task:ready` fallback:
codex has no `StopFailure` event, so an API-failed turn would otherwise sit busy
forever. This is the honest asymmetry with Claude, not an oversight.

**Two observation channels, typed by semantics (upstream-sync 2026-08-03).**
What scraping remains reads one of two substrates, and the choice is a rule,
not a habit. **State queries** — "is this dialog on screen", "which row holds
the cursor" — read the reconstructed screen: `terminal-host/task-screen-model.ts`
is an `@xterm/headless` grid fed the same PTY bytes, and the approval detector,
the codex full-access consent predicates, and the Claude Rewind-panel predicate
all read its settled viewport. **Event detection** — "did this receipt line
appear" — reads the linear stream tail. The forcing incident: codex 0.146
repaints its consent dialog as a *cell diff* over the rows the `/permissions`
picker had occupied, so cells already holding the right character are never
retransmitted and the byte stream read `Enablfullaccess?` while the dialog was
plainly on screen — the linear stream is a transport delta, not the picture, and
a modal predicate fed from it is structurally unreliable (Claude's Ink renderer
per-line-diffs the same way: an arrow move emits one cursor row and nothing
else, the footer paints once per session). The rule is machine-enforced, not
prose: `smoke:terminal-grid-substrate` walks the source and rejects any read of
buffer rows above the viewport — a grid consumer that wants scrollback is
running a temporal query on a spatial substrate, i.e. using the wrong channel —
and all terminal geometry is minted at one clamp site
(`runtime/terminal-dimensions.ts`, a branded type every mirror demands, so
bypassing the clamp is a compile error; every fan-out leg was measured to throw
on some un-clamped input, which makes the single clamp the never-throw
mechanism itself, not a nicety on top of tolerant mirrors).

## The Preview window (satellite)

The reading surface for *files* (the Reading window reads the conversation; the
Terminal carries raw process). It rebuilt the old Preview + Inspector satellites
on a **three-truths** model (design record:
`product-thinking/2026-07-04-preview-window-redesign-map-v1.md`), each truth with
one honest owner:

- **Disk truth** — what exists and what its bytes are. Observed, never stored,
  through `main/workspace-files.ts` (`WorkspaceFiles`: the single audited
  path/symlink guard, the read + classification ladder, the `sonata-file://` image
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
ones (R4), but the per-task `fs.watch` stream excludes `.git`, `.sonata`,
`node_modules`, `__pycache__`, etc. (`shouldIgnorePath`). Those directories
render and give a correct one-shot listing on expand, but emit no `file:changed`,
so they will not *live-refresh* in place. That is intended noise control, not a
bug.
