# Sonata App Architecture — the Reading Window

This document describes the renderer architecture that emerged from the
2026-07 decomposition program. It covers the Reading window — the main
surface. The satellite renderers (terminal, preview) are separate
vite entries with their own, smaller files. Three subsystems beyond the reading
renderer have their own sections below: **the signal layer** (the main-process
control plane that produces the runtime events the reducer consumes), **the CLI
updater** (the main-process subsystem that keeps the Codex CLI current), and
**the Preview window**.

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
boundaries, identity, usage, approvals — without either CLI losing a feature.
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

**Directory trust: the folder-pick gesture IS the answer (D1, 2026-08-06).** Codex
asks "do you trust the contents of this directory?" in its own TUI for any cwd its
config has never seen, and until it is answered the session does nothing — a
pre-session dialog no hook fires on and no Sonata surface can honestly narrate.
Sonata pre-answers it for **every** codex cwd by writing
`[projects."<cwd>"] trust_level = "trusted"` into its own `-p sonata` profile
(`codex-runtime-settings.ts: buildTrustLedger` is the mechanism;
`runtime-controller.codexPretrustCwd` is the single home of the policy). The
ledger is governed by regeneration: existing grants carry forward while their
directory exists, dead dirs self-prune. The user's real `~/.codex/config.toml` is
never written.

*Why unconditional* — the dialog has no third answer (`Yes, continue` /
`No, quit` exits the process), so the reachable states are {trusted, did-not-run};
pre-trust pre-answers the only viable one, and choosing the folder in Sonata's own
UI is that answer. Upstream decides the identical case the same way: codex's
app-server auto-persists `Trusted` for programmatic callers that supply a cwd plus
explicit permissions. This OVERTURNS the 2026-07-18 ruling, which kept the dialog
for user-chosen folders behind an `autoTrustProjectFolders` opt-in — a switch that
displayed OFF while the honest answer was always Yes; it was removed, not defaulted
on (D2).

*What it costs, eyes open* — at 0.146.1 trust gates **the repo's own `.codex/`
config layer**: its hooks, exec policies, skills, agent roles and MCP servers.
Sandbox and approval are NOT on that axis; Sonata pins those structurally with
`-s`/`-a`. Measured end to end (S0-b, 2026-08-06, codex 0.146.1, Sonata's exact
argv): pre-trusted, a scratch repo's own `.codex/config.toml` hooks fired
(SessionStart/UserPromptSubmit/PreToolUse) and its `.codex/rules/*.rules` exec
policy rejected a command; the same repo at `trust_level = "untrusted"` fired no
hook and applied no policy. So a repo that ships `.codex/` gets its config layer
inside Sonata exactly as it would in Terminal — which is the parity a GUI over a
CLI owes its user. The part that is *wider* than Terminal is that
`--dangerously-bypass-hook-trust` also waives the hash-review screen for those
repo hooks; that is a property of the bypass flag, orthogonal to pre-trust, and
narrowing it is a named follow-up (register F-1), not a reason to keep a dialog
whose only answer is Yes.

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

## The CLI updater (keeping Codex current)

The signal layer's rule is *observe, never replace*. This subsystem is the one
deliberate exception, and it is scoped to a single job: **Claude Code
self-updates, Codex does not.** Codex ships only a boot notifier, and inside
Sonata's pty that prompt is one nobody resolves — it competes with the session
the user actually opened — so installs go stale indefinitely. Sonata takes the
job over (`main/cli-updater/`). Claude Code gets nothing here, by explicit
decision: it already does this for itself.

**The invariant: ownership is DERIVED, never stored.** "Ownership" is the
question *who speaks to the user about updates at spawn time* — Sonata's
suppress flag, or Codex's own prompt. It is recomputed from the facts on every
spawn and lives in no field. There is deliberately no `mode` / `ownedBy` flag,
because a stored one is a second source of truth that can desynchronize from
reality; making it a property of the representation means the invariant cannot
be violated by forgetting to maintain it. The dividend is that **handback and
reclaim have no code at all**: the user updating Codex by hand makes the pending
condition false, a newer release makes a recorded failure no longer match the
current version, a healed retry advances it — each of those stops the handback
condition from holding, by itself.

**The facts file is the only persisted state** — one small JSON document
(`cli-updater/state.ts`, alongside its nine `JsonSettingsStore` siblings):

```
lastCheck   { at, ok, installed, latest }
lastAttempt { forVersion, startedAt, pid, exitCode, logFile }
```

That single `lastAttempt` row is simultaneously three things. It is the
**three-state outcome**: a null `exitCode` with a live pid is RUNNING, a null
one with a dead pid is UNKNOWN (the app died mid-update — *not* a failure), a
non-zero code is a hard failure, and `0` means the command ran, not that it
worked (`codex update` exits 0 with a success banner even when Homebrew declines
the upgrade, so the exit code is a failure signal only; the truth is the next
check's version comparison). It is the **cross-restart lock**: a relaunch that
finds a live pid adopts it, holds the spawn mutex, and releases the instant that
pid stops answering — with a `startedAt` sanity window so a recycled pid cannot
hold the mutex forever. And it is the **failure's scope**: a hard failure counts
only against the `forVersion` it names.

**One cycle, three triggers, all decisions pure.** `runCycle(reason)` is the
single orchestration point — reconcile → check → policy → maybe execute →
persist — re-entrant-guarded so concurrent callers join the in-flight cycle
rather than starting a second. The triggers (60s post-launch, every 12h, the
last Codex session ending) carry **zero logic**; they only say "now may be a
good time". Every condition is evaluated inside the cycle by `policy.ts`, which
is pure to the point of taking pid-liveness and the clock as arguments, so the
entire ownership truth table unit-tests over fact literals
(`smoke:cli-updater-policy`). The check itself reads `codex --version`
through the *same* login-shell PATH resolution the pty spawn uses — a
mismatch there would report one Codex's version while the user's sessions ran
another — and npm's dist-tags over a plain bounded fetch.

**Updates require zero live Codex sessions.** Codex re-execs itself through arg0
symlinks to `current_exe()` (its `apply_patch` path is the hot one), so swapping
the binary underneath a live session either dangles those symlinks or silently
mixes versions. The gate is absolute, and a spawn that arrives while an update
is genuinely running waits on a **bounded** mutex and then proceeds anyway: an
unbounded await would let one wedged package manager block every session the
user tries to start, and a visible retryable boot failure is a better failure
than a New Chat button that does nothing. The update itself is spawned
**detached and unref'd** so it outlives app quit — killing npm or Homebrew
mid-write can corrupt a global install — which is what makes orphan adoption
above a real requirement rather than a theoretical one. Its output goes to a
per-attempt file under the logs dir, kept to a bounded window (keep-last-20,
pruned after the child is already running so housekeeping can never cost an
update): a diagnostic that grows for the life of the install is the same
byproduct-scaled cost the observation constitution rules out.

**Retries are gated by trigger kind, not by a clock.** Homebrew's cask index
lags npm, so an attempt routinely exits 0 without the version moving and the
update stays pending. The scheduled ticks retry freely (their frequency is
Sonata's own, ~2/day plus one per launch); the session-close trigger, whose
frequency is the *user's*, executes only when nothing has been attempted for the
current version yet. The existing `forVersion` vs `latest` comparison already
carries "we have tried this one", so this needs no wall-clock constant and no
new persisted field — a deliberate refusal, since time-horizon mechanisms were
rejected wholesale for this subsystem.

**The fallback is the status quo ante, not a new surface.** When ownership is
handed back — which happens only while a pending update has demonstrably
hard-failed *at the current version* — Sonata simply stops passing
`-c check_for_update_on_startup=false`, and Codex's own boot prompt returns,
backed by the existing `codex-update-prompt` watchdog banner. Staleness alone
never hands back, and neither does UNKNOWN: an app that died mid-update tells us
nothing about whether Codex can be updated. There is no toast, no changelog, no
version display; success is silent, and the one user-facing control is
`keepCodexUpToDate` in Codex settings (default on — the status quo it replaces
is a prompt already going unanswered). Everything else about this subsystem is
invisible when it works, which is the point.

## CLI readiness (before a session exists)

The subsystem above keeps an installed Codex current. This one answers the
question that comes *before* that: **is there a CLI to run at all, and is it
signed in?** Sonata neither ships nor manages the CLIs, so today a missing or
signed-out one produced an infinite silent hang — the boot latch never opened and
the composer said "Starting Claude…" forever. `main/cli-readiness/` replaces that
with an observation the UI can be honest about, at two mount points: before a
session exists (the New Chat card) and inside one that could not start (the
attention banner — see "The same fact inside an existing conversation" below).

**Two axes, three states, and the third one is the design.** Install is
`present | absent | unknown`; auth is `signedIn | signedOut | unknown`
(`shared/types/cli-readiness.ts` — the only shape that crosses IPC). **`unknown`
is PERMISSIVE and must never be folded into the actionable states.** The pty
spawn is the final truth; a silent false negative (we say nothing, the spawn
works) costs far less than a false alarm (we claim the CLI is missing while the
user's own terminal runs it fine). So every failure mode of the probe — timeout,
unrecognized output, a subcommand a future CLI dropped, a config file it cannot
load — lands on `unknown`, and exactly two facts are actionable: `absent` and
`signedOut`. The one distinction the CLI updater's checker deliberately flattens
is the one this module must keep: ENOENT (`absent`, Sonata has something to
offer) is not "we could not tell".

**Structured commands only — never TUI scraping** (the rule the signal layer's
scars wrote). Four commands, two per provider: a `--version` whose *exit status*
alone decides the install axis (the string is never parsed — only `absent` is
actionable, so "something answered `--version`" is exactly the claim `present`
makes), and one auth query whose output is read by a provider-specific pure
function. `claude auth status --json` is JSON-parsed for `loggedIn`, **never read
from the exit code**: MEASURED, a signed-out answer is a well-formed document
delivered on exit 1, so the code alone would classify the CLI's clearest possible
answer as a failure. `codex login status` prints a sentence on *stderr*, matched
line-anchored and negative-first — a bare "contains 'logged in'" test would read
"could not determine whether you are logged in" as healthy, which is the
expensive direction of the mistake. Every MEASURED shape is registered in the
upstream coupling inventory.

**Probes run through the SAME login-shell PATH resolution as the pty spawn**
(`cli-readiness/cli-env.ts`). This is load-bearing rather than tidy: a
Finder-launched `.app` inherits launchd's minimal PATH, so a naive
`execFile("claude", …)` reports `absent` on machines whose sessions run that CLI
daily — the Anthropic Desktop #42350 detect/run mismatch, reproduced. The cache
that makes it cheap also gets an explicit bust (`resetLoginShellPathCache`),
because an installer that edits the user's shell profile makes the captured PATH
stale at exactly the moment a post-install re-probe reads it.

**Event-driven, zero timers, zero persistence.** Readiness does not drift on its
own — it changes when a person changes it — so a clock would spend two
subprocesses per tick re-learning the same fact. Three triggers, all landing on
one `probe(reason)` that also owns every condition: the main window's
`did-finish-load` (after first paint, because the login-shell capture is
synchronous), a main-window **focus while some fact is actionable** (once nothing
is, focus costs *nothing*), and a programmatic `reprobe({bustPathCache})` for the
install/login flows. The facts live in the controller and nowhere else — nothing
on disk to invalidate, migrate, or contradict, and a cached fact read at next
launch would be a claim about a machine nobody has looked at yet. The renderer
pulls once (`cli-readiness:read`) and subscribes (`cli-readiness:changed`), and
the push fires **only on a deep-compare change**, so a re-probe that learns
nothing is silent. The IPC has no write side, by policy: Sonata never installs or
logs in on the user's behalf — those run visibly in the CLI window, and their
effect arrives back here as a changed fact.

**What a new chat opens on: last-used, not a default.** The first consumer of
those facts is not UI at all — it is the New Chat draft's provider. There is no
"default provider" setting (removed with the picker): the draft preselects the
provider the **last session actually started on**, a record the main process
writes at that moment (`SonataSettingsStore.noteProviderUsed`, from `createTask`
— the `noteFolderUsed` twin, in the same method, for the same reason). Nothing
else writes it: not opening or switching a draft, and not reopening an old chat,
whose provider is a property of the record rather than a choice. So
`sonata-settings.json` is the one settings file with a **read side and no write
side across IPC** (the stores with no IPC surface at all — `local-api-settings`,
`window-state`, `projects`, … — are a different category) — a renderer path
would be a second authority over a fact main already owns the instant it becomes
true.

With no record yet, the seed reads whatever readiness facts have LANDED for a
tiebreak: if exactly one provider could serve a session, open on it; otherwise
Claude. **On a cold launch that is normally nothing.** The boot seed waits on four
synchronous IPC reads and fires in single-digit milliseconds, while the probe
starts at `did-finish-load` and pays the login-shell capture plus four
subprocesses first — so the FIRST draft of a fresh install seeds Claude, and the
tiebreak governs the new chats after that. This is a deliberate ordering, not an
oversight: blocking the draft on a subprocess would trade a non-blocking boot for
a guess, and re-seeding the draft when facts arrive is what D6 forbids. The
honest state is visible instead — S2's card names the fact, and the composer's
provider switcher is one click away.

Both fallbacks are recomputed at every seeding moment and **never written** — a
persisted guess is a sticky wrong answer, and only a real session start earns the
record. An arriving fact therefore changes what the NEXT new chat seeds from and
never switches an open draft underneath the user.

The `codex --version` overlap with the CLI updater is known and **deliberately
not merged**: that subsystem's semantic is version policy, this one's is
readiness. Merging is a phase-2 question, and `cli-env.ts` is the generalized
form its `codex-env.ts` would collapse into.

### The readiness card, and how recovery happens

The probe is the READ half. The card and the setup run are the other two:
*say the fact*, then *hand the fix to the CLI itself*.

**The card is decided as data, not drawn as a state machine.**
`reading-core/selectors/cli-readiness-card.ts` maps (draft provider × facts × live
setup run) to a card model or null, and the view only paints it — so the whole
presence matrix is fenced row by row, including the rows that must show
*nothing*, which no screenshot can check. That file is also the **one home of the
copy**: the S4 banner imports its sentences and labels rather than respelling them
(D10 — one fact, two mounts), so a copy ruling moves both surfaces at once and the
two can never disagree about one machine. D8 v2 (2026-08-06) exercised exactly
that: one edit there re-worded both. Three rules carry it: `unknown` shows
nothing (the permissive rule again); a **healthy provider shows nothing whatever a
run did**, so a failed install for a CLI that is nonetheless present cannot put a
"didn't finish" card over a working machine; and the card is about the DRAFT's
provider, never a suggestion to change it.

**It occupies the New Chat composer slot and nothing else moves.** Not a banner
(that family is task-keyed, mid-task attention; this is pre-task readiness), and
not a gate: the sidebar, history, and settings stay reachable throughout. It sits
*above* the composer card rather than replacing it, which is forced rather than
chosen — the draft's provider switcher lives on that card, and the card's whole
posture is "here is the fact about the CLI you picked; switch if you like". What
it does take away is SEND: `#composer` carries `.cli-readiness-active`, checked in
the submit handler exactly as `.drawer-active` is, because a prompt sent into a
provider that cannot boot is the silent queue this program exists to remove — and
the button alone would not cover Enter, which reaches submit through
`requestSubmit()`. Typing stays enabled: writing the prompt while an installer
runs is reasonable, and send re-arms itself when the re-probe turns green.

**A setup run is one visible command, and it is a sibling of terminal-host rather
than a change to it** (`main/cli-readiness/setup-run.ts`). Two kinds — the
vendor's official install command, or the provider's own login command
(`claude auth login` / `codex login`; since the login-run redesign 2026-08-19 —
the bare CLI's first-run wizard survives only for a Claude whose
`hasCompletedOnboarding` flag is unset, because `auth login` completes the login
but not the wizard). Both commands exit when their ceremony ends, so the run
settles like an install does, and the login run is admitted only over a
re-probe-confirmed `signedOut` (`codex login` revokes the existing credential
before its flow begins, so `unknown` fails CLOSED at this one gate — the
subsystem's sole deliberate inversion of permissive-unknown). Hosted in a real
pty whose grid the CLI window shows and whose keystrokes it forwards, so a sudo
prompt or a pasted authorization code is answerable. `TerminalHost` was the wrong home for it on three counts, two of them
hard: it parses provider TUIs (an installer is not one, and a **login screen is
the one surface Sonata is forbidden to read**), and it belongs to a Task (every
install attempt would leave a phantom session in the sidebar). So the run is
app-global, task-free, and unpersisted; the CLI window gains a second grid that
outranks the task grid while it lives.

**Success is decided by re-probing, never by reading the command's output.** After
an install pty exits, `reprobe({ bustPathCache: true })` runs — the bust is a
correctness requirement, not a nicety, because both installers edit the user's
shell profile. A non-zero exit **or** a still-`absent` re-probe is the failure
state; a script that prints "Success!" and installs nothing is therefore caught,
and one that prints nothing while working is not doubted. A `start` run has no
failure shape at all: Sonata cannot tell "closed without signing in" from a normal
exit, so it says nothing and lets the re-probed facts speak.

**Quitting mid-install interrupts the installer, and that is accepted.** The pty is
not detached and Sonata holds its master, so the child stops when the app's process
does (MEASURED). The CLI updater's detach-and-unref executor is the real fix and is
deliberately heavier than this surface warrants: both vendor installers are
re-runnable, and a half-written install simply reads `absent` to the next launch's
probe — which is the card that offers to install it again. The recovery is retry,
the same path a failed install already takes. (`dispose()` still kills nothing, and
that matters for the case that IS survivable: on macOS, closing every window does
not end the process.)

One MEASURED trap is worth naming, because it is invisible and it undoes the work
`cli-env.ts` exists for: the install command runs through `$SHELL -c` and **must
not** use `-lc`. A login shell on macOS sources `/etc/profile` → `path_helper`,
which REPLACES `PATH` — discarding the merged login-shell PATH and re-creating the
#42350 detect/run mismatch inside the install itself. `-c` loses nothing, since
the env handed to the pty already carries that PATH.

### The same fact inside an existing conversation

The card only guards the moment *before* a session exists. A conversation already
in the sidebar can meet the identical wall — the CLI was uninstalled, or the user
signed out — and there the failure is the original wound in its purest form: the
composer pins "Claude is starting…" and the prompt waits for a boot that is never
coming. So the fact gets a **second mount point**, in the task-keyed attention
banner family, with the *same* sentences and the *same* actions (the copy lives
once, in the card's selector, and the banner imports it).

**An observation triggers it; a probe decides it.** Two observations, both in
`RuntimeController`, because both are lifecycle facts nothing else can see:

- the PTY died **before the boot latch ever opened** — a missing binary fails
  `execvp` inside the pty, so the process is gone in milliseconds;
- the PTY is alive but `acceptsPromptInput()` is still false when the **boot
  observation window** elapses (10s, against a MEASURED 1–3s boot) — the shape of
  a CLI parked on its own first-run screen. Unless a run is in flight, in which case
  the same `false` means the opposite (a turn owns the screen) and the session has
  plainly started.

Neither observation is allowed to name a cause. Each one re-probes and reports what
the PROBE says, so a session that failed for any other reason — a crash, a bad
flag, a boot dialog Sonata does not recognize — produces **no event, no banner, and
exactly today's behaviour**. There is deliberately no generic error UI for a
failure Sonata cannot name; `unknown` stays permissive here too.

Two details of that pair are easy to get backwards. The window reads
`acceptsPromptInput()` and *not* the delivery boot latch, because the latch flips
inside the delivery pump and therefore stays shut on a session nobody has sent
anything to — keying on it would diagnose every "Start CLI" that opens a session
without a prompt. The pre-latch-exit trigger has the opposite constraint: the
process is gone, so there is nothing left to scrape, and the latch is the one
DURABLE record that a prompt was once reached. Its imprecision runs the harmless
way — a healthy session nobody sent to, then quit, costs one probe that finds
nothing and says nothing.

**Never offer to start a second copy of a CLI that is already waiting for input.**
The recovery is the vendor's install command, or the CLI itself — except in two
states, where the banner degrades to the family's ordinary "Open CLI →" pointer: a
setup command for that provider is already running, or the diagnosis is `signedOut`
on a session whose own PTY is still LIVE. The second is the one with teeth, and it is
worth spelling out because the first implementation got it wrong: a live signed-out
diagnosis comes from the observation window, which means *this task's own CLI is up
and parked on its first-run screen* — the very login the copy asks for, in the very
window the copy points at. A "Start" button there spawns an INDEPENDENT pty whose
grid hides the task's own, and finishing the login in that copy is the worst outcome
available: the machine facts go green, the banner retires on them, and this session's
PTY stays parked forever with its prompt held — the eternal pin, rebuilt by its own
cure. Finishing it in the task's own PTY instead genuinely heals (the CLI paints its
composer, `acceptsPromptInput()` turns true, the pump latches, the queued prompt goes
out). A DEAD pty keeps the button: there is nothing to point at, so a fresh spawn is
the only door.

**Two surfaces, two questions, two predicates.** The BANNER speaks about the
MACHINE — `diagnosis AND live facts AND this provider`
(`selectors/cli-readiness-banner.ts`) — so it retires the moment the machine is
fixed. The COMPOSER speaks about THIS SESSION, and keys on `cliSessionStartStalled`:
the diagnosis stands AND (the machine is still broken OR this session's PTY is still
live). Conflating them is how the pin came back, because a login finished anywhere
else turns the facts green without moving a parked PTY an inch — and dropping the
machine term instead would leave "can't start yet" over a dormant conversation whose
provider an install just fixed. The register both read is cleared when the task
reaches a prompt (its boot latch opening) or starts a fresh session: *a session that
got to a prompt is not a session that failed to start*, which is also what retires a
diagnosis that was true-but-wrong about a session — the `ANTHROPIC_API_KEY` case,
where `auth status` reports signed out while the CLI works fine. The diagnosis lives
in the state atom rather than in the banner module, unusually for this family,
precisely because two surfaces read it; the DISMISSAL is a third, banner-local flag,
for the same honesty reason: closing a notice must not send the composer back to
promising a boot.

**Send is NOT closed here, and the asymmetry with the card is deliberate.** A New
Chat send CREATES a session, so sending onto a dead provider manufactures a
conversation that can never boot. An existing chat's send goes into a conversation
that already exists, and both failure shapes leave it honest: with the CLI absent
the pty is gone, so the send is a resume the user may well want to retry; with it
signed out the pty is alive and the delivery queue holds the prompt until the boot
latch opens — which is what finishing the login **in that session's own PTY** does.

## The Preview window (satellite)

The reading surface for *files* (the Reading window reads the conversation; the
Terminal carries raw process). It rebuilt the old Preview + Inspector satellites
on a **three-truths** model, each truth with one honest owner:

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
