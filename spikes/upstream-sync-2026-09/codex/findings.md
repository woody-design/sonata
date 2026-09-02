# Upstream-sync 2026-09 — codex probe findings (target: 0.152.0)

Probed 2026-09-01. `codex-cli 0.152.0`. Blob-checks ran against a shallow clone
of `openai/codex` at tag `rust-v0.152.0` (scratchpad; tag-pinned source is
ground truth per the 2026-08 method lesson — auto-changelogs over-report).

## B1 — `-s` still forces Legacy permission syntax (PASS — the highest-value line)

`codex-rs/core/src/config/mod.rs:2471-2478` (`resolve_permission_config_syntax`):
`sandbox_mode_override.is_some() → Some(PermissionConfigSyntax::Legacy)` is the
FIRST branch, ahead of the new profile-selection logic. The 0.149–0.151
permission-profile cluster did NOT put profiles over `-s`. Profiles activate
only when the session-flags layer carries `default_permissions` — Sonata never
passes it. Fence holds; keep the anchor.

## B2 — `AskForApproval` (protocol/src/protocol.rs:963-976)

- `#[default] OnRequest` — unchanged (trusted ≡ no-entry equivalence survives).
- `UnlessTrusted` ("untrusted") NOT removed despite #39630 "Retire the
  untrusted approval policy" — changelog over-report or UX-only retirement.
  NO-OP for Sonata.
- **`OnFailure` variant deleted; `on-failure` is now a serde ALIAS of
  OnRequest.** Sonata already maps on-failure → ask-for-approval and blocks it
  at the spawn seam — upstream converged to our mapping. NO-OP in behavior;
  update the comment in codex-settings.ts + this inventory row.

## B3 — `PROJECT_LOCAL_CONFIG_DENYLIST` now 12 keys (was 11)

`config/src/loader/mod.rs:75-88`: added `responses_api_metadata`. Same
enforcement site (`:1170`). `mcp_servers` still absent from the list.

## B4 — `bypass_hook_trust_for_startup_review` formula unchanged

`tui/src/lib.rs:1668`: `config.bypass_hook_trust && !is_persistent_resume`.
Surrounding startup flow reworked (startup_prefetch / startup_hooks_review) —
the bypass semantics survive; the REVIEW SCREEN plumbing changed, so the
boot-dialog probe must still re-walk its rendering.

## B5 — `include_disabled` anchor ROTTED

0 hits repo-wide at 0.152.0 (was 8 non-test `false` call sites at 0.146.1).
The project-layer gate was refactored/renamed; `disabled_reason` still exists
(230 hits) and config trust still keys on `TrustLevel::Trusted`
(loader/mod.rs:1051-1075). Re-derive the gate's new shape in the trust slice —
do NOT carry the old call-site count forward.

**C-series addendum (B5 closed):** the gate's new shape is
`ProjectTrustContext::decision_for_dir` (`config/src/loader/mod.rs:1062`), whose
verdict feeds `disabled_reason_for_decision` (`:1107`) — untrusted projects are
no longer filtered by an `include_disabled` flag but carry a `disabled_reason`
string naming the trust key that would fix them. Trust still keys on
`TrustLevel::Trusted`. See C3 for the lookup order it implements.

---

# C-series — SL-6 (boot/login ceremony, trust triggers, cli-readiness)

Probed 2026-09-01, `codex-cli 0.152.0` (pinned at the start AND end of every
probe; no drift observed in any run). Claude binary present at **2.1.258** for
the readiness half. Source claims are read from a shallow clone of
`openai/codex` at tag `rust-v0.152.0`; **every source read below is labelled as a
hypothesis and settled by a live frame**, per the 2026-08 method lesson.

Probes (all under `spikes/upstream-sync-2026-09/codex/`, driven by the shared
`driver.mjs`, which runs the PRODUCTION `TerminalHost` + production `codexArgs`
out of `dist/` rather than a bare binary — the questions here are about SONATA'S
readiness, not codex's screen):

| probe | question | capture |
|---|---|---|
| q20 | boot ceremony, 3 arms | `q20-boot-ceremony.{production,fresh-untrusted,fresh-pretrusted}.capture.txt` |
| q21 | trust-trigger matrix, 8 directory shapes | `q21-trust-triggers.capture.txt` |
| q22 | trust serialization + ledger round-trip, 2 layers | `q22-trust-serialization.capture.txt` |
| q23 | hooks-review screen + #38394, 3 arms | `q23-hooks-review.capture.txt` |
| q24 | cli-readiness, 7 live command arms | `q24-cli-readiness.capture.txt` |
| q25 | boot latch vs the trust dialog, 4 arms | `q25-boot-latch-vs-trust.*.capture.txt` |

## C1 — the production boot ceremony, MEASURED end to end

Under Sonata's own spawn (`-p sonata`, `--dangerously-bypass-hook-trust`,
`--no-alt-screen`, `-C <cwd>`, `-s workspace-write`, `-a on-request`,
`-c approvals_reviewer="user"`), a healthy boot paints **no interstitial that
requires an answer**. Timed sequence, real `TerminalHost`, real hook profile:

| t | what paints |
|---|---|
| ~27ms | `task:started` |
| **~147ms** | the **startup DRAFT**: welcome box with `model: loading` / `directory: loading`, then `› Ask Codex to do anything` + `? for shortcuts`. **`acceptsPromptInput()` → TRUE, confidence LOW** |
| ~270ms | the draft is REPLACED. MEASURED on the untrusted arm (the trust dialog takes the screen at 268ms); on the trusted arms the next frame transition is the resolved welcome box at ~512ms, so the draft's exact end there is bounded, not timed |
| ~512ms | `Tip: …` line, `⚠ \`--dangerously-bypass-hook-trust\` is enabled…`, `• Starting MCP servers (n/4)`. Readiness dips FALSE (activity after the prompt) |
| ~1000ms | `• You have 1 usage limit reset available.`; composer + footer `gpt-5.6-sol high · <cwd>`. **ready, confidence MEDIUM** |

Candidate sweep (15 needles, sourced from the tag-pinned TUI modules) —
**NOT SEEN** on the production arm: hooks-review, login/onboarding, welcome,
update prompt, model migration, cwd prompt, unarchive prompt, external-agent
migration, full-access consent, config-load error, and the generic modal shapes.
The only match was the bypass-hook-trust warning, which is an inline banner over
a live composer, not a screen owner (`sonataReadyWhileOnScreen` n/a — stream-only
at first sighting, then painted as an ordinary line).

Composer input ARMING at the settled composer: 9/9 characters landed, first echo
in 122–124ms, **0 swallowed** (both the production and fresh-pretrusted arms).
#38641's `discard_pending_input_before_interactive_screen()` does not eat input
at a settled composer — it eats it at the moment an interactive SCREEN opens,
which is what C2 is about.

Onboarding-when-auth-missing (the 0.148 rework) is **REPRODUCED** — q26, added
in the fix round, drops the seeded `auth.json` and gets it. At 229ms a logged-out
boot paints the ASCII mark, `Welcome to Codex, OpenAI's command-line coding
agent`, and a three-row picker:

```
> 1. Sign in with ChatGPT
     Usage included with Plus, Pro, Business, and Enterprise plans
  2. Sign in with Device Code
  3. Provide your own API key
  Press enter to continue
```

Two things follow, and the second is the load-bearing one. Its cursor row is
`> 1. …` and `>` IS in codex's `composerPromptGlyphs` — so this screen has the
same shape hazard as the trust dialog and the hooks-review screen. It is
ALREADY COVERED: its footer is `Press enter to continue`, a shipped
`bootDialogHints` needle, and it paints after the cursor row. MEASURED,
`acceptsPromptInput()` reads false for the whole 20s watch. Third boot screen,
third one the vocabulary holds. The
credential-refresh progress strings (#41239) likewise never painted; grep of the
pinned source finds no user-visible "refreshing" string on the login path
(`tracing::info!("Refreshing token")` is a log line, not a frame).

## C2 — INCIDENT: the 0.148+ startup draft opens Sonata's boot latch before the trust dialog exists

**This is the headline, and it is a reproduction, not a derivation.**

`DeliveryController.pump()` latches `bootLatched` the first time
`acceptsPromptInput()` is true, and the latch is one-way — "after that the scrape
never re-gates delivery (send-is-send)". At 0.152.0 codex paints a
composer-shaped startup draft at ~147ms and only replaces it with the
directory-trust screen at ~270ms. So there is a **~120ms window in which Sonata
reads an idle composer that is not one**, and `bootDialogHints` cannot help: the
dialog's needles are not on screen yet.

MEASURED consequences (q25, production `TerminalHost` + production
`DeliveryController`, isolated `CODEX_HOME`, untrusted cwd, a prompt queued at
spawn exactly as a task created with an initial prompt does):

- **`untrusted-plain` (natural pump cadence)** — the latch did NOT open early:
  pumps landed at ~27ms and then on the 500ms retry chain, missing the window.
  The item stayed `queued` for the full 25s watch with the dialog up. **The guard
  held.**
- **`pretrusted` (control)** — latch at 528ms, delivery at 1031ms, prompt reached
  the composer, model answered `Hello!`. The rig delivers correctly.
- **`untrusted-forced`** — one benign runtime event fed to the controller every
  25ms across the draft window (`task:started`, which falls through every branch
  of `handleRuntimeEvent` and does nothing but pump — so the ONLY variable is
  pump phase). Latch at **158ms**. Delivery at **1030ms** with
  `dialogOnScreenAtDelivery: true`. Outcome:
  - `run:started` + `prompt:submitted` emitted — **Sonata believes it submitted**;
  - the CLI advanced past the trust screen to a normal composer — **the Enter
    answered `› 1. Yes, continue` and granted directory trust**;
  - the composer shows only the placeholder — **the prompt text was discarded**;
  - `task:ready` at 3759ms with no turn ever having run.
- **`untrusted-forced-digit`** — same, with `2` in the prompt text. The CLI did
  NOT quit. The widget's `SELECT_SECOND → handle_quit()` is unreachable from a
  pasted prompt because `TrustDirectoryWidget` overrides no `handle_paste`, so
  bracketed-paste content is dropped wholesale and only the separate Enter
  reaches `handle_key_event`. **Severity is bounded to "trust granted + prompt
  lost", not "session killed".** (Hypothesis retired by measurement.)

This is the 2026-07-17 incident class, alive again at 0.152.0 by a different
route: not a vocabulary gap (C4 shows the vocabulary is fine) but a paint-ORDER
change upstream. Reachability in the field is a race on pump phase, and the
window is narrow — but the pump fires on every non-`pty:data` runtime event, so
any hook/approval/run event landing in [147, 268]ms opens it.

**FIXED (orchestrator ruling, file fence lifted — see C12).** Both directions
shipped, belt and braces:

(a) the DELIVERY boot latch now calls `TerminalHost.acceptsFirstPrompt()` instead
of `acceptsPromptInput()`. They differ only for codex and only before the latch,
and the extra term is `confidence === "medium"` — `hasModelOrCwdHint`, i.e. the
composer's `<model> <effort> · <cwd>` footer has resolved. The general readiness
predicate is deliberately UNCHANGED; only the irreversible decision got stricter,
which is the whole justification: latching disarms every later readiness check.

(b) `isCodexTrustDialogOpen()` — the codex sibling of `isFullscreenOfferOpen`,
reading the grid — is ranked inside `acceptsPromptInput()` as a second,
independent reason the same latch stays shut, keyed on the dialog's own identity
rather than on a footer having resolved.

REJECTED, and the first write-up of this finding got the reason wrong. It claimed
no needle could discriminate because every post-glyph string is "equally present
at a REAL idle composer". The captures contradict that: `? for shortcuts` is
draft-TRANSIENT (present in the ≤270ms frames of all three boot arms, absent from
every resolved composer), so by last-index ranking it WOULD discriminate. The
sound reasons are two others. It is not reliably MATCHABLE on the channel the
guard reads — the string reached the reconstructed grid but not the pty tail
contiguously in 2 of 3 arms (cell-diff repaint). And it is an accident where the
confidence term is a fact: "which footer string does this build print while
loading" is upstream trivia that moves every release, while "has the CLI told us
which model and cwd it is running" is the same semantic property the medium/low
split already encodes throughout `terminal-host.ts`.

**Verified as an A/B PAIR on disk, both at 0.152.1, same probe and same arranged
race.** The original 0.152.0 pre-fix capture was overwritten by the post-fix
re-run, so it was REGENERATED honestly — the confidence term reverted in-tree,
rebuilt, re-run, restored — rather than described from memory:

| capture | build | latch | delivery | dialog |
|---|---|---|---|---|
| `…untrusted-forced.PRE-FIX.capture.txt` | term reverted | **161ms** | **1028ms**, `dialogOnScreenAtDelivery: true` | answered; prompt discarded |
| `…untrusted-forced.capture.txt` | shipped | **never** | `deliveredAtMs: null` | **still unanswered** |

The PRE-FIX run kept the GRID BELT in place, which settles which leg carries the
fix: **with only the belt, the incident still reproduced.** `canDeliver()` never
consults `acceptsPromptInput()`, so once the latch is open nothing re-gates the
write — the belt can only stop a latch from opening, never rescue one that has.
The confidence term is the fix; the belt is a belt. The `untrusted-plain` and
`untrusted-forced-digit` arms likewise never latch on the shipped build.

**Control green; the cost is 0–500ms and VARIES.** The `pretrusted` arm was run
twice post-fix and did not agree with itself, which is the honest headline:

| run | latch | delivery | outcome |
|---|---|---|---|
| pre-fix | 528ms | 1031ms | prompt delivered, model answered |
| post-fix #1 | **526ms** | **1028ms** | prompt delivered, model answered |
| post-fix #2 | **1030ms** | **1531ms** | prompt delivered, model answered |

Both post-fix runs deliver correctly; they differ by exactly one pump interval.
The cause is a race, not noise: codex's footer resolves around ~512ms (C1) and
the natural pump cadence lands at ~526ms, so whether the footer has resolved by
that pump decides whether the latch opens then or 500ms later. So the review's
estimate (~528ms → ~1000ms) is right SOME of the time, and the first post-fix run
alone would have supported the opposite claim — an n=1 reading this write-up
initially made and is correcting here. The bound is what matters: the gate costs
the first prompt AT MOST one pump interval, and in no run does it cost a
delivery.

## C3 — trust-trigger matrix: #36960 wins, #36935 is not observable, #39616 is real

Source hypothesis (`config/src/loader/mod.rs`): `should_show_trust_screen` is
`config.active_project.trust_level.is_none()` (`tui/src/lib.rs:1919`), and
`decision_for_dir` (`:1062`) looks trust up in **three passes, in order** — the
cwd's own normalized keys, then the PROJECT ROOT's, then the REPO ROOT's, where
repo root comes from `git-utils/src/trust.rs::resolve_root_git_project_for_trust`.
For a linked worktree that resolver walks to the MAIN checkout and re-validates
the relationship from both ends (registered checkout ≡ this checkout, the
worktree's `commondir` ≡ the common dir, and the main checkout's own `.git` ≡
that same common dir); any failed leg returns `None` and no inheritance happens.

MEASURED (q21 — 8 shapes, each with its own fresh `CODEX_HOME`, ledger seeded
through Sonata's own `buildTrustLedger` carry-forward, `pretrustCwd` null in
every row so the seeded ledger is the only variable):

| shape | ledger holds | dialog? | at |
|---|---|---|---|
| plain non-git dir | — | **YES** | 229ms |
| git repo root | — | **YES** | 207ms |
| git repo SUBDIR | — | **YES** (+ git-root note) | 208ms |
| bare repo + `gitdir:` pointer + linked worktree (**Sonata's own container shape**), cwd = worktree | — | **YES** (+ git-root note naming the CONTAINER) | 206ms |
| the same container, **container root** trusted | container | **NO** | ready 207ms |
| the same container **minus the container's `.git` pointer file**, container root trusted | container | **YES** | 205ms |
| git repo subdir, **repo root** trusted | repo root | **NO** | ready 204ms |
| plain dir, **the cwd itself** trusted (Sonata's policy) | cwd | **NO** | ready 206ms |

Readings:

- **#36935 "trust undecided local projects automatically" is NOT observable**
  under Sonata's spawn shape at 0.152.0. Every undecided shape raised the dialog.
  The two same-release changes reconciled in favour of #36960.
- **#39616 is real and is now measured**, not inferred: the fifth and sixth rows
  differ ONLY by the presence of the container's `.git` pointer file, and that
  single file flips inheritance on and off. Sonata's own container has it, so a
  worktree there inherits the container's trust — but a container that ever loses
  or never had that pointer silently stops inheriting.
- **Sonata's unconditional pre-trust policy (D1, 2026-08-06) is UNAFFECTED.** It
  writes the exact cwd, which is the FIRST lookup pass — no project-root or
  repo-root resolution is involved, so none of the worktree validation can reach
  it. **The policy door named in the brief is NOT triggered.**
- The git-root note ("Trusting will apply to the repository root: …") fires for
  BOTH the plain subdir and the worktree, and for the worktree it names the
  CONTAINER, not the worktree. A human answering that dialog in a Sonata-shaped
  repo therefore grants trust one level wider than the folder they opened —
  worth knowing, unchanged behaviour, not Sonata's to alter.

## C4 — `bootDialogHints` re-walked against LIVE frames: vocabulary CORRECT, no row-order flip

The first draft of this walk was wrong in a way worth recording: it matched each
needle against a whitespace-STRIPPED haystack, which reports every needle alive
and proves nothing. Production builds the haystack as
`cleanTerminal(rawTail).slice(-8000).toLowerCase()` — cleaned and lowercased but
NOT stripped — and matches each hint together with `compactText(hint)` (which
removes every non-alphanumeric) against that one string. The walk below uses
production's window, snapshotted at the instant the dialog owned the grid.

| needle | production window @ dialog | note |
|---|---|---|
| `press enter to continue` | **MATCH** | |
| `yes, continue` | **MATCH** | |
| `yes,continue` | no | its twin `yescontinue` also no |
| `no, quit` | no | its twin `noquit` also no |
| `no,quit` | **MATCH** | the stream renders `2.No,quit` — space elided, comma kept |

Three of five fire, and the two that do not are each covered by a sibling. The
comma-tight spellings are **load bearing, not belt-and-braces**: `compactText`
strips punctuation too, so `"no, quit"` yields `"noquit"`, and the paint stream
emits `"no,quit"` — which neither the literal nor its automatic twin matches.
Only the explicit spelling does. (The row's own comment claimed this from
0.144.x; it is now measured at 0.152.0.)

`detectIdlePrompt` on that window: `ready: false`, `promptAfterApproval: false` —
the needles outrank the option-row `›`. `isCodexTrustDialog(grid)` = true, and
`codex-trust-dialog:detected` fired at 4029ms (the coalesced settled-grid scan
cadence). **The guard works while the dialog is on screen.** What it cannot do is
un-latch (C2).

**ROW ORDER / DEFAULT ROW: unchanged, and codex did NOT repeat claude's flip.**
Live frame at 0.152.0:

```
› 1. Yes, continue
  2. No, quit
```

cursor on row 1 (the AFFIRM row) — `onboarding_screen.rs:165` sets
`highlighted = TrustDirectorySelection::Trust`, and the rendered frame agrees. So
the claude 2.1.252 hazard (a blind Enter DECLINING and killing the session) has
no codex analogue: a blind Enter here ACCEPTS. That is the worse failure for
consent and the better one for liveness, which is exactly what C2 measured.
Sonata still never answers it — the RED LINE is unchanged.

Wording is byte-identical to 0.146.1 (`trust_directory.rs` re-read at the pinned
tag): question line, both option labels, and the `Press enter to continue`
footer.

## C5 — the hooks-review screen: a REAL guard gap, closed in this slice

B4's formula survives: `bypass_hook_trust_for_startup_review =
config.bypass_hook_trust && !is_persistent_resume` (`tui/src/lib.rs:1668`) and
`review_is_needed = !bypass_hook_trust && review_needed_count > 0`
(`startup_hooks_review.rs:265`). MEASURED (q23, one flag as the only variable):

- **production argv** → no review screen, no trust dialog, composer at 205ms.
- **the same argv minus `--dangerously-bypass-hook-trust`** → at 612ms:

```
  Hooks need review
  10 hooks are new or changed.
  Hooks can run outside the sandbox after you trust them.

› 1. Review hooks
  2. Trust all and continue
  3. Continue without trusting (hooks won't run)

  Press enter to confirm or esc to go back
```

Row 1's cursor is the composer glyph, and **NONE of the five shipped
`bootDialogHints` appear anywhere on that screen or in the stream**. Sonata's own
`detectIdlePromptForProvider` returned **`ready: true`** on it. A delivery there
would paste and press Enter into `› 1. Review hooks`.

Reachability: Sonata always passes the bypass flag (gated on `profile` in
`codexArgs`), so the happy path never sees this. The DEGRADED path does: a
profile-write failure drops both `-p sonata` and the bypass flag, and a user with
their own untrusted hooks then boots straight into it.

**FIXED in this slice** (in the codex profile rows, which is where it belongs —
unlike C2): `"trust all and continue"` and `"continue without trusting"` added to
`bootDialogHints`. Both rows paint AFTER row 1's cursor, so the ordering the
guard depends on holds. The stream collapses them to `Trustallandcontinue` /
`Continuewithouttrusting`, which is exactly what `detectIdlePrompt`'s automatic
`compactText` twin of each plain spelling matches — verified by running the
production parser over the captured bytes before and after (`ready: true` →
`ready: false`), with the real idle composer unchanged (`ready: true`, medium).
The title line "Hooks need review" is deliberately NOT a needle: it paints BEFORE
the cursor row and would be inert.

## C6 — #38394 cannot fire on Sonata's hooks (source + live)

`Hooks::new` bails with `failed to load required managed hooks` when
`engine.required_load_errors()` is non-empty (`hooks/src/registry.rs:70-88`).
That vector is populated **only** by `append_managed_requirement_handlers`
(`hooks/src/engine/discovery.rs:205-241`), whose source is
`config_layer_stack.requirements().managed_hooks` — the MANAGED REQUIREMENTS
layer. Sonata's `-p sonata` file is an ordinary config layer, so its hooks can
never carry `HookRequirement::Required`.

Live negative (q23 `broken-shim`): production argv with **both shim files
deleted** — Sonata's worst realistic hook failure — still reached a composer at
205ms, with `failed to load required managed hooks` absent from the entire
stream. **NO-OP for Sonata. Not an incident.**

## C7 — trust serialization unchanged; the LAYER it lands in has moved

od -c verified in both layers (q22). Codex appends exactly:

```
\n[projects."<abs path>"]\ntrust_level = "trusted"\n
```

— leading newline, TOML basic-string key, the bare two-line form. Unchanged from
0.146. `buildTrustLedger`'s carry-forward round-trips those exact bytes in both
arms, and the block is byte-identical to `projectTrustBlock`'s own output.

**NEW, and it changes the inventory's codex trust rows:** *where* the grant is
written depends on the config layer.

- bare `codex` → `$CODEX_HOME/config.toml` (the 2026-08 measurement).
- **`codex -p sonata` → NO `config.toml` is written at all; the block is appended
  to `sonata.config.toml`** — the file Sonata regenerates on every spawn-prep.

So the "human grants are sacred" carry-forward clause is no longer a courtesy
toward a file someone else owns: **it is the only thing standing between a user's
dialog answer and silent erasure by the next spawn's `writeIfChanged`.** Pinned
in `tests/smoke/codex-runtime-settings.mjs` as a full loop (grant arrives in
Sonata's file → next prep regenerates → grant survives → third prep is
byte-stable), and documented at `buildTrustLedger`.

Registered, not fixed: the regeneration is a read-modify-write over a file a
second writer also appends to, so a grant codex writes between the read and the
rename is lost. Window = one profile regeneration; cost = one extra dialog, never
a wrong trust decision.

Live suppression check (q20 `fresh-pretrusted` vs `fresh-untrusted`, same cwd,
same everything, ledger the only difference): the pre-trust entry in the
PROFILE layer suppresses the dialog at 0.152.0. Objective 3 clean.

## C8 — cli-readiness re-verified at the CURRENT binaries

q24 runs the four probe commands live and feeds the outcomes to the PRODUCTION
readers out of `dist/`. All seven arms agree with the pinned table; the whole
subsystem call returns `claude present/signedIn, codex present/signedIn`.

| arm | exit | stream | verdict | elapsed |
|---|---|---|---|---|
| `claude --version` (2.1.258) | 0 | stdout | — | 8ms |
| `claude auth status --json`, signed in | 0 | stdout | signedIn | 114ms |
| the same, fresh HOME | 1 | stdout | signedOut | 104ms |
| `codex --version` (0.152.0) | 0 | stdout | — | 8ms |
| `codex login status`, signed in | 0 | **stderr** | signedIn | 13ms |
| the same, fresh CODEX_HOME | 1 | **stderr** | signedOut | 12ms |
| the same, malformed config.toml | 1 | **stderr** | **unknown** | 10ms |

Two shape drifts, neither behavioural:

- the claude auth document GREW two fields since the 2.1.222 pin —
  `analyticsDisabled` and `projectsDirectory`. The reader takes only `loggedIn`,
  so nothing changes; the fixtures are re-pinned to the measured 2.1.258 shape
  and the 2.1.222 shape is KEPT as a second case, so "reads `loggedIn` and
  nothing else" is tested across versions rather than asserted in a comment.
- `codex login status` has **seven** signed-in sentences at 0.152.0, one per auth
  mode (`cli/src/login.rs`), all beginning `Logged in`. This account is a ChatGPT
  login, so only that one was observable; the other six are pinned in the smoke
  as SOURCE-DERIVED, not promoted to MEASURED.

FAIL-DIRECTION check (the one the brief asked for first): **no phrase change can
make a signed-in user read `signedOut`.** The negative test is anchored at
line-start and checked negative-first, the seven positives all match the same
prefix, and the two non-answers on that code path (`Error loading configuration:
…`, `Error checking login status: …`) match neither prefix and land on `unknown`,
the permissive state. `cli-readiness-signed-out.mjs` now drives the codex half
live as well, including the malformed-config arm.

Method note: a fresh `HOME` alone is enough to get a signed-out answer out of
claude — `CLAUDE_CONFIG_DIR` does not also have to be redirected (measured both
ways). The comment claiming otherwise was corrected.

## C12 — fix round (orchestrator ruling; file fence lifted)

Reviewer verdict on the measurement round: 0 blocking, 2 minor, both taken.
Ruling on C2: ship BOTH directions. Fence extended to
`app/src/runtime/delivery-controller.ts` and the `acceptsPromptInput()` region of
`terminal-host.ts`.

### The two review minors

1. **The C2 pin's rejection reason was wrong** and is restated in C2 and in the
   test's own comment. `? for shortcuts` IS draft-transient (verified
   independently before accepting the note: present in the ≤270ms frames of all
   three boot arms, absent from every resolved composer), so a needle WOULD have
   discriminated. One correction to the note itself: on the channel the guard
   actually reads it would have discriminated *unreliably* — the string reached
   the reconstructed grid but not the pty tail contiguously in **2 of 3** arms
   (cell-diff repaint; production 0 occurrences, fresh-pretrusted 0, untrusted 1).
   So there are two reasons, and the reviewer's — a needle on a transient loading
   footer is upstream trivia, where the confidence term is a semantic fact — is
   the one that decides it.
2. **`brokenConfig` asserted only the auth axis**, which `probeProvider`'s
   install short-circuit also yields. `assert.equal(brokenConfig.install,
   "present", …)` added ahead of it, so the arm provably exercises the phrase
   reader rather than the short-circuit.

### One judgement call inside the ruling, declared

The ruling said to rank `isCodexTrustDialogOpen()` in `acceptsPromptInput()` with
`isFullscreenOfferOpen` as the placement precedent. It is ranked there — but
**BELOW the SessionStart hook short-circuit, not above it**, which is where the
precedent stops transferring. The fullscreen offer paints strictly before
SessionStart could fire, so ranking it above the hook is free. This dialog's
CELLS can OUTLIVE the answer: codex runs `--no-alt-screen`, so an answered dialog
scrolls up rather than vanishing with a buffer swap. Ranked above the hook, that
lingering grid would read NOT-READY for a session the CLI has already declared
started — a false hold on a live session, and a regression in
`checkCodexTrustDialogCleared`'s leg 2. Ranked below, the pre-answer case (no
hook possible) is guarded and the post-answer case clears normally. The
consequence for leg 2 is documented at the predicate, at the clearing method, and
in the smoke: the leg is now reachable via the hook rather than via the scrape,
which is the path it was written for.

### Blast radius the fence-lift exposed, and how it was handled

Adding a method to the interface `DeliveryController` consumes broke **9 stub
hosts across 8 smokes** (`acceptsFirstPrompt is not a function`). Fixed by
completing the stubs, NOT by making the product duck-type its own collaborator:
a `typeof host.acceptsFirstPrompt === "function"` fallback would have silently
skipped the new gate the day the real host lost the method. Each stub mirrors the
real semantics (`acceptsFirstPrompt` = its `acceptsPromptInput`), which is
faithful for claude and for every host whose readiness the test is varying. Two
further files matched the sweep and were verified to need nothing — they drive
REAL hosts (`native-image-attachments`, `stop-over-approval`).

### BINARY DRIFT, mid-slice: 0.152.0 → 0.152.1

The homebrew cask auto-updated between the measurement probes and the fix
verification. **The version pin fired**, which is what it is for (SL-4 method
note). Handling: re-stamped to 0.152.1 rather than widened to a patch-series
prefix — widening would trade the one mechanism that catches this for the
convenience of not having to say so.

Before trusting any fix verification, the load-bearing ceremony facts were
RE-MEASURED at 0.152.1 (q20 `fresh-untrusted`) and are byte-identical:

| fact | 0.152.0 | 0.152.1 |
|---|---|---|
| startup draft, first ready | 147ms, `ready:true` / LOW | 144ms, `ready:true` / LOW |
| verdict while the dialog owns the screen | `ready:false` | `ready:false` |
| option rows / cursor row | `› 1. Yes, continue` / `2. No, quit` | identical |
| needle walk (3 of 5 fire) | continue / yes, continue / no,quit | identical |

So the fix targets a live problem at the current binary. Which capture was taken
at which version is recorded per-probe: **q20–q25 (first pass), q21–q24 = 0.152.0;
q20 re-run, q25 re-runs, q26 = 0.152.1.**

## C13 — q26: the logged-out boot, and the chosen consequence MEASURED

Added in the fix round to settle two things at once (capture
`q26-unauthenticated-latch.capture.txt`, 0.152.1, isolated `CODEX_HOME` with no
`auth.json`, cwd pre-trusted so the directory-trust screen cannot confound it):

- **C1's UNREPRODUCED login onboarding is now REPRODUCED** — see C1 for the frame.
  Its cursor row is `> 1. Sign in with ChatGPT` and `>` is a codex composer glyph,
  so it carries the same shape hazard as the other two boot screens; it is
  already covered, because its footer is `Press enter to continue`, a shipped
  needle painting after the cursor row. `acceptsPromptInput()` false for the whole
  20s watch.
- **The chosen consequence, measured**: 757 forced pumps across the whole boot,
  `bootLatched` never true, the queued prompt still `queued` at the end, both
  `acceptsPromptInput()` and `acceptsFirstPrompt()` false. A logged-out session
  holds the prompt instead of pasting it into a login screen that will never run
  it, and the hold is VISIBLE (`bootLatched` is the "still starting" display bit).

**Attribution, stated precisely rather than conflated:** in this arm the latch is
held by the *needle* guard inside `acceptsPromptInput()`, not by the new
confidence term — the login screen's footer is already a needle. So q26 measures
the field-reachable INSTANCE of the consequence; the confidence-term PATH itself
(a composer whose footer never resolves, e.g. offline with valid auth, where no
needle fires) is pinned at the unit level in
`tests/smoke/task-ready-detection.mjs` ("a codex composer whose footer never
resolves never latches"), which also pins that the SessionStart hook still
outranks the footer requirement.

## C14 — REGISTER (SL-13): `idlePromptModelHints` is now load-bearing for a red line

Not a code change — a register entry, because the next person to edit that regex
needs to know what leans on it.

`acceptsFirstPrompt()`'s codex term is `confidence === "medium"`, and confidence
is computed as `profile.idlePromptModelHints.test(promptTail)` where
`promptTail = recent.slice(lastAnyPrompt, lastAnyPrompt + 700)` — the 700
characters AFTER the last composer glyph. The codex regex is deliberately loose:

```
/gpt[-\w.]*|xhigh|high|medium|low|max|ultra|~/i
```

Before SL-6 that looseness was cheap — it only moved a completion verdict between
LOW and MEDIUM. It is now the discriminator on a RED-LINE path: it decides
whether the delivery boot latch opens, and therefore whether a first prompt can
reach a consent dialog.

Why it holds today, MEASURED across all three q20 boot arms: codex paints its
boot notices (the `Tip:` line, the bypass-hook-trust warning, the usage-limit
notice) ABOVE the composer glyph, and only the footer `<model> <effort> · <cwd>`
below it. So the 700-character window after the glyph contains the footer and
essentially nothing else, and "medium" is structurally "the footer resolved" —
which is exactly the property the gate wants. The draft's window contains
`Ask Codex to do anything` / `? for shortcuts` and matches nothing.

The two ways that could rot, both worth a glance at SL-13:
- a bare `low`/`high`/`max`/`ultra`/`~` in a boot notice that upstream moves
  BELOW the glyph would satisfy the regex without a resolved footer, re-opening
  the draft window. `~` is the widest of these (a single tilde anywhere in the
  700-char tail).
- a model family whose slug is not `gpt*` and whose effort word is none of the
  listed ones would make a legitimately-resolved footer read LOW, holding the
  latch on a healthy session — the honest-but-mute direction, but a wedge.
A tighter positive anchor (the footer's `·` separator plus a cwd, say) would be
the principled hardening; it is NOT taken here because it is a change to a shared
provider row with its own measurement burden, and nothing measured is failing.

## C9 — what SL-6 changed in the product

- `terminal-host.ts`, codex profile `bootDialogHints` — two needles added
  (`"trust all and continue"`, `"continue without trusting"`), the whole comment
  rewritten around the measured window shape and the measured collapse forms.
  A/B'd on real bytes: with the fix reverted in-tree and rebuilt, the new
  `task-ready-detection` case FAILS; restored, it passes and the trust-dialog and
  real-composer verdicts are unchanged.
- `codex-runtime-settings.ts`, `buildTrustLedger` — documentation only. Records
  the measured LAYER change (C7) and the read-modify-write race it implies.
- `cli-readiness/probe.ts` — MEASURED tables re-stamped at 2.1.258 / 0.152.0,
  the seven codex auth sentences documented, the `CLAUDE_CONFIG_DIR` claim
  corrected. No behaviour change; the readers were already right.
- smokes — `cli-readiness-probe` fixtures re-pinned (and the 2.1.222 document
  KEPT as a version-spanning case); `cli-readiness-signed-out` extended to drive
  the codex CLI live, including the malformed-config fail-direction arm, with
  per-provider in-band skips and a whole-file 77 only when neither section ran;
  `codex-runtime-settings` gains the profile-layer grant loop;
  `task-ready-detection` gains the three C4/C5/C2 cases.

Added in the FIX round (fence lifted — C12):

- `terminal-host.ts` — `acceptsFirstPrompt()` (the boot-latch question, codex
  additionally requiring MEDIUM confidence) and `isCodexTrustDialogOpen()` (the
  grid screen-owner belt), the latter ranked inside `acceptsPromptInput()` below
  the hook short-circuit. `checkCodexTrustDialogCleared`'s two-leg comment
  updated to the narrowed truth.
- `delivery-controller.ts` — the boot latch calls `acceptsFirstPrompt()`. One
  line, plus the reasoning for why an irreversible decision asks a stricter
  question than a reversible one.
- 9 delivery stub hosts across 8 smokes completed with the new predicate.
- `task-ready-detection.mjs` — the MEASURED-GAP case converted into four
  fixed-behaviour assertions (draft still reads ready at LOW; the latch refuses
  the draft and accepts the resolved composer; the never-resolving footer
  consequence plus the hook short-circuit; the trust-dialog belt over a tail that
  would otherwise latch).
- `codex-trust-dialog.mjs` — leg 2 re-based on the SessionStart hook, with the
  new pre-hook grid behaviour asserted explicitly.

**Still deliberately NOT changed:** `DeliveryController.canDeliver()`. It is now
in fence, and it was considered: a post-latch screen-owner gate there would be
the codex sibling of the Rewind panel's treatment. It is not built because there
is nothing measured for it to catch — the trust dialog is strictly PRE-latch, and
with the latch now refusing both the draft and the dialog, a gate behind it would
be scaffolding rather than safety. `isFullscreenOfferOpen`'s own comment makes
exactly this argument for exactly this reason; if a future sync moves an
interstitial of this class PAST the latch, that is when it earns the fuller
treatment.

## C10 — deviation ledger (SL-6)

1. **Added q25**, a probe the brief did not name. Objective 1 asked for input
   arming "the way SL-1 measured the claude trust dialog's"; measuring it at the
   settled composer (0 swallowed) would have been a true and useless answer,
   because q20 had just shown readiness opening 850ms earlier on a screen that is
   not a composer. q25 measures the question that actually matters.
2. **q25 reproduces a RED-LINE violation in a sandbox.** Sonata answered a trust
   dialog. That is the behaviour under test, in an isolated `CODEX_HOME` with a
   throwaway cwd, and it is the only way "the boot latch is exposed" stops being
   a code-reading. The standing rule (Sonata never answers this dialog in
   production) is unchanged and unweakened.
3. **q22 answers the trust dialog directly under node-pty**, not through
   `TerminalHost` — deliberately, so the artifact cannot be read as Sonata
   answering it. The Enter is grid-verified (affirm row highlighted) with an
   abort path if the default row ever moves.
4. **q20's production arm regenerates the user's REAL `sonata.config.toml`**
   (that is what a production spawn does) and RESTORES it byte-for-byte
   afterwards, so the probe's scratch cwd cannot linger in their ledger.
5. **First q20 needle walk was wrong and was redone.** It matched needles against
   a whitespace-stripped haystack, which reports every needle alive. Production's
   haystack is not stripped. The corrected walk is the one reported; the bug is
   written into the probe's own comment so it cannot be reintroduced.
6. **First q24 run leaked a real org UUID into a capture.** The redactor ran
   AFTER `JSON.stringify`, where the document's quotes arrive escaped, so it
   matched nothing. Redaction moved to capture time and the capture regenerated;
   the reason is in the probe's comment.
7. **First q22 capture was 21MB** because it dumped every file in the codex home
   — including 0.152.0's sqlite stores, which hold session content. Narrowed to
   the two TOML files (the rest listed by name and size) and regenerated: 24KB.
8. **The full-suite number is a SHARED-TREE number.** SL-8's uncommitted work
   (`codex-normalizer.ts`, `provider-transcript.mjs`, `usage-adapters.mjs`,
   a usage fixture) was in the tree for that run. Every smoke this slice touches
   was additionally run standalone.
9. **Plan file NOT edited** (the brief reserves that for the orchestrator this
   round), so the slice's status is reported rather than written.

Fix round:

10. **The grid predicate is ranked BELOW the hook short-circuit**, not above it
    as the fullscreen-offer precedent would suggest. Reason and evidence in C12;
    the short version is that an answered codex dialog's cells outlive the answer
    under `--no-alt-screen`, so ranking above the hook would create a false hold
    on a live session.
11. **`canDeliver()` deliberately left alone** although it is now in fence — see
    C9 for why a post-latch gate would be scaffolding here.
12. **q26 added**, unnamed in the work package: the ruling asked me to "PIN the
    deliberate consequence"; pinning a consequence I had only argued for would
    have been an assertion, so it is measured. It also closed C1's UNREPRODUCED
    login-onboarding item as a side effect.
13. **Stub hosts completed rather than the product made tolerant.** A
    `typeof host.acceptsFirstPrompt === "function"` fallback in
    `delivery-controller.ts` would have made every smoke pass immediately and
    silently skipped the new gate the day the real host lost the method.
14. **Binary drifted 0.152.0 → 0.152.1 mid-slice.** Re-stamped, and the
    load-bearing ceremony facts re-measured before any fix verification was
    trusted (C12). Captures are dual-version and say which is which.
15. **An n=1 timing claim was made and then retracted.** The first post-fix
    control run latched at 526ms and this write-up concluded the gate "costs this
    path nothing". A second run latched at 1030ms. Both deliver; the difference
    is one pump interval and a race against the footer resolving. The claim is
    now stated as a BOUND over both runs (C2) rather than as a reading of the
    convenient one.
16. **dist was rebuilt mid-suite** (comment-only version stamps) during the final
    `npm run smoke`. Comments cannot change behaviour and the result matched the
    pre-fix run exactly, but the exposed families were additionally re-run
    foreground against the FINAL dist, and the decisive q25 arms re-run against
    it too — rather than resting on a suite that read a moving artifact.
17. **A code comment cited an artifact that disproved it.** Two comments named
    `…untrusted-forced.capture.txt` as the incident reproduction after the
    post-fix re-run had overwritten that file with the opposite outcome — the
    one artifact a maintainer would open before deciding whether the medium term
    may be relaxed. Fixed by REGENERATING a real pre-fix capture (revert in-tree,
    rebuild, run, restore) rather than by softening the prose, and both comments
    now name the A/B pair and say which half is which.
18. **The leg-2 rationale rested on a false premise about SessionStart.** It
    claimed the hook "cannot fire until onboarding completes" and therefore
    reaches leg 2 on schedule. Codex fires SessionStart LAZILY (first
    UserPromptSubmit — the fact is documented in runtime-controller's
    `watchHooks`), and that submit needs the very latch being guarded, so at boot
    the hook path is unreachable and leg 1 is the only operative leg. Verified at
    the source before rewriting, and the check turned up a second fact: the latch
    NEVER re-arms (`noteSessionBoundary` only refreshes the grace), so
    `acceptsFirstPrompt` runs only at initial boot and its `hookSessionStarted`
    term is INERT for codex today. Kept as a declared forward-guard rather than
    deleted, and labelled inert so nobody reads it as load-bearing.

## C11 — evidence files

`driver.mjs` · `q20-boot-ceremony.mjs` + 3 captures · `q21-trust-triggers.mjs` +
capture · `q22-trust-serialization.mjs` + capture · `q23-hooks-review.mjs` +
capture · `q24-cli-readiness.mjs` + capture · `q25-boot-latch-vs-trust.mjs` +
4 post-fix captures and one regenerated `…untrusted-forced.PRE-FIX.capture.txt` · `q26-unauthenticated-latch.mjs` + capture. All under `spikes/`, which the code repo gitignores — they need
`git add -f`. Every capture is sanitized ($HOME, the munged `-Users-<user>-`
form, the bare username, JWT/API-key/e-mail shapes) and re-scanned clean.
