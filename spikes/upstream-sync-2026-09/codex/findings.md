# Upstream-sync 2026-09 — codex probe findings (target: 0.152.0; later series measured at 0.152.1 after a mid-program patch drift)

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

---

# SL-7 — codex picker / consent / receipt re-walk (D-series)

A NEW LETTER on purpose. C1–C14 are one continuous argument about codex's BOOT
(trust, latch, login, hooks review); SL-7 asks a disjoint question — what the
mid-session pickers, their consent interstitial and their receipts look like at
0.152.1 — and interleaving it into the C numbering would make both harder to
read. D1–D10 below stand alone; where they touch a C item they say so.

**Binary pin: `codex-cli 0.152.1` at the START and END of every probe, no
drift.** Same version SL-6 ended on. Probes: `q27-model-picker-walk.mjs`,
`q27b-picker-refresh-race.mjs`, `q28-model-receipt-tiers.mjs`,
`q29-permissions-consent-walk.mjs`, plus `q30-image-ab.mjs` /
`q30-image-fixture.mjs` for D9.

## D1 — DEPTH: the `/model` picker is still two levels, and the row set grew

`Select Model and Effort` → `Select Reasoning Level for <model>`. No auto-mode
level 1, no catalog reshape: the whole S4 state machine's premise holds at
0.152.1 on this account.

Level 1, MEASURED (q27), SIX rows where the 2026-08 fixture had five:

```
  Select Model and Effort
  Access legacy models by running codex -m <model_name> or in your config.toml
› 1. gpt-5.6-sol (current)  Reliable agentic workhorse for everyday tasks.
  2. gpt-5.6-terra          Balanced agentic coding model for everyday work.
  3. gpt-5.6-luna           Fast and affordable agentic coding model.
  4. gpt-5.5                Proven previous-generation model for coding and general work.
  5. gpt-5.4                Strong model for everyday coding.
  6. gpt-5.4-mini           Small, fast, and cost-efficient model for simpler coding tasks.
  Press enter to confirm or esc to go back
```

**FALSIFIED:** `tui-parsers-codex.ts` said "legacy models like gpt-5.4 are NOT
offered here, only via `codex -m`". They are rows 5 and 6 now — while the
picker's own subtitle still advertises `-m` as the way to reach them. And
`gpt-5.3-codex-spark`, a row the old fixture carried, is gone. W5 in the flesh:
the catalog is SERVER-mutable with no CLI release, so a row set is a measurement
with a date on it, never a fact about codex. The real-CLI smoke had already
learned this (its D5 rollback target became a synthetic never-served slug); the
UNIT fixture had not, and asserted `gpt-5.4` absent — a test whose premise the
server had already revoked. Both halves now agree.

Level 2, unchanged in every way the parser keys on: `Low (default)` / `Medium` /
`High (current)` / `Extra high` / `More reasoning…`, same footer. Two details
worth stamping: `(default)` marks the MODEL'S OWN default tier and MOVES with the
model (Low on sol, Medium on luna) — it is not `(current)` and never identifies
the tier to preserve; and row 5's DESCRIPTION is model-dependent (`Max and Ultra
consume…` on sol, `Max consumes…` on luna) while its LABEL is not.

## D2 — REFRESH (#41467): no observed reshuffle, measured two ways

The worry was structural, not cosmetic: `captureCodexModelLevel` snapshots
`order`/`byDigit` ONCE from the opening frame and navigates on that snapshot, so
a post-capture reshuffle would make every later arrow a blind press against a
stale map; and `advanceCodexModelNav` treats any cursor that is neither
`awaitingCursor` nor `lastCursor` as an unexpected jump and rolls back.

- **q27, warm session**: picker opened ~22s after boot and HELD for 20s with no
  key pressed. **One** distinct frame. Row set identical, highlight identical.
- **q27b, into the handshake**: this is the arm that could actually catch it. The
  easy case proves little — by 22s the app server had long answered, so a refresh
  would agree with the paint. So q27b fires `/model` + Enter at the instant
  `acceptsPromptInput()` goes true (148ms, BEFORE the box's `model:`/`directory:`
  rows stop reading `loading`) and samples at 50ms for 25s. The picker opened at
  474ms with the COMPLETE six-row set already correct, and produced **one**
  distinct open frame. The after-handshake control arm is identical.
- **Walk under a fresh open** (q27 fast-walk): four Downs at 220ms intervals from
  the moment the header hits the stream. Cursor advanced one row per press,
  captured order stable across all four.

**VERDICT: the walk-driving premise holds; the design fork named in the brief
(event-driven picker read vs walk) is NOT triggered.** Stated with its bound: a
refresh that AGREES with the paint is indistinguishable from no refresh, so this
is "no observed divergence on this account across 45s of watching and one
pre-handshake open", not "the refresh does not exist".

One channel note: `codexModelPickerLevel1Open` goes true on the STREAM before the
GRID has finished painting the rows (q27 fast-walk press 1 read a null grid
cursor). Harmless — production waits for the footer before capturing the order,
which is exactly the guard that makes this a non-event — but it is why a probe
that gates on the stream and then reads the grid needs a beat between them.

## D3 — F8 standing re-verify: all six receipt tiers, and the suffix is Ultra's alone

q28 drove every tier through the live picker in one session, reading each receipt
off THAT press's stream delta rather than the rolling tail:

| tier | receipt, verbatim | shape |
|---|---|---|
| low | `• Model changed to gpt-5.6-sol low` | bare |
| medium | `• Model changed to gpt-5.6-sol medium` | bare |
| high | `• Model changed to gpt-5.6-sol high` | bare |
| xhigh | `• Model changed to gpt-5.6-sol xhigh` | bare |
| max | `• Model changed to gpt-5.6-sol max` | bare |
| ultra | `• Model changed to gpt-5.6-sol ultra for this conversation` | **suffixed** |

All six parse. The Max line was EXTRAPOLATED in the smoke since 2026-08 ("no Max
receipt was ever taken"); it is now MEASURED, and the extrapolation was right.
The interesting half is what it got right by luck: the `for this conversation`
suffix is **Ultra's alone** — Max prints bare. The two are not one shape with a
tolerated tail, and an end-anchor "tightening" would break exactly one of them.
Provenance labels in `midsession-receipt.mjs` updated accordingly.

A model switch also parses: `• Model changed to gpt-5.6-luna medium`.

## D4 — the THIRD picker level, behind `More reasoning…`

Sonata refuses that row (D6), so nothing in the tree knew what it opens — "we
don't go there" is weaker than "we don't go there, and here is what it would
be". Driven once (q28):

```
  Advanced Reasoning
  ⚠ Consumes usage limits faster
› 1. Max    For difficult problems when quality matters more than speed · higher usage
  2. Ultra  For demanding work using multiple agents · highest usage
  Press enter to confirm or esc to go back
```

How the production predicates split on it — three negatives and one positive, and
the shape is exactly right:

| predicate | verdict | why it matters |
|---|---|---|
| `codexModelPickerLevel1Open` | false | not the model picker |
| `codexModelPickerLevel2Open` | false | no `Select Reasoning Level for …` |
| `parseCodexModelLevel2` | **empty** | `Max`/`Ultra` are not reasoning labels → an accidental entry cannot LOOK navigable and be driven blind |
| `codexModelPickerFooterVisible` | **true** | the shared footer, which is the term `rollbackCodexModelPicker` actually gates its Esc on → the stack is still SEEN |

**MEASURED depth back to a composer from that screen: THREE Escs.**
`CODEX_MODEL_MAX_ROLLBACK_ESCS` is 3. So that constant is no longer one Esc of
slack over a two-deep stack — it is the exact depth of the deepest stack codex
can build, with nothing spare. Sonata cannot build the stack itself, but a user
arrowing onto `More reasoning…` inside a picker Sonata opened can, and the
cursor-validation failure that follows lands in this rollback. Comment corrected
from "at most two levels deep" to the measured truth; the number is unchanged and
now declared as COUPLED to the measured depth.

## D5 — `/permissions`: picker unchanged; the consent unchanged; the exits still asymmetric

Picker (q29, production spawn): `Update Model Permissions` header, THREE rows
(`Ask for approval (current)` / `Approve for me` / `Full Access`), cursor `›`,
footer `Press enter to confirm or esc to go back`. Nothing the parsers key on
moved, and `CODEX_ROW_ORDER`'s 0/1/2 still matches the painted 1/2/3. Receipts
re-driven verbatim: `• Permissions updated to Ask for approval` /
`… Approve for me` / `… Full Access`.

Consent dialog: header, both rows and footer BYTE-IDENTICAL to 0.146.0. (The
explanatory paragraph between them is NOT new — it is in the 2026-08 capture and
has been pinned in `CONSENT_GRID` all along; the parser file's short comment just
never quoted it, which read as if the dialog were four lines.)

**The cell-diff still bites, character for character.** Sampled on both channels
in the same instant, twice: `codexPermissionConsentDialogOpen` reads TRUE on the
grid and FALSE on the stream, whose bytes compact to
`Enablfullaccess?…1Yes,continueanywayApplyfullacessforthiseson2.CancelGoback…`.
Note `2. Cancel` KEPT its dot while row 1 lost both its `›` and its `.` — the
whole argument in one frame: what survives is a function of what the PREVIOUS
screen held, so a stream-side regex can be widened until it matches this capture
and still be wrong at the next terminal width. The grid is not a preference.

**EXITS, each taken from its own freshly opened picker — the asymmetry the
park+relay red line is built on HOLDS:**

| exit | lands on | receipt |
|---|---|---|
| `Esc` on the consent | the idle COMPOSER (picker gone, `acceptsPromptInput` true) | none |
| `Enter` on `2. Cancel` | the STILL-OPEN `/permissions` picker (header + footer up) | none |

One new detail: the Cancel return RESETS the picker cursor to row 1 (`Ask for
approval`) rather than leaving it on the Full Access row it came from. Harmless
today — that path Escs the picker away rather than navigating it — but it is what
a future "just re-confirm the row" shortcut would trip over. Stamped in
`pressParkedConfirm`.

## D6 — #39873: the permission cycle has NO default binding, and its set is not the picker's

Two facts, and the order matters.

**SOURCE (rust-v0.152.0):** `keymap.rs` ships
`next_permission_mode: default_bindings![]` and
`previous_permission_mode: default_bindings![]`. The cycle is **unreachable
unless a user writes `tui.keymap.chat.next_permission_mode` themselves.** That is
the answer to "find the binding": there isn't one.

Getting a binding accepted took two measured rejections, each a small finding
about how hard this is to reach at all: `ctrl+g` is refused at config load
(`data did not match any variant of untagged enum KeybindingsSpec` — the accepted
separator is a HYPHEN), and `ctrl-g` is refused by the conflict validator because
it is already a default for another chat action. `ctrl-x` took.

**DRIVEN (q29 arm B, isolated `CODEX_HOME`):** three presses, three receipts —

```
• Permissions updated to Approve for me
• Permissions updated to Read Only      ← a FOURTH mode
• Permissions updated to Ask for approval
```

`chatwidget/permission_shortcuts.rs` explains it: the cycle enumerates the
`read-only` and `auto` presets × reviewer, a set that is **not** the picker's row
set. `Full Access` is excluded from the cycle; `Read Only` is excluded from the
picker.

**Exposure, bounded by measurement rather than by hope.** With the CLI sitting in
Read Only, the picker still paints its three rows with **NO `(current)` marker**
and the cursor on row 1 — so `parseCodexPermissionPickerCursor` still resolves and
a Sonata-driven switch still walks correctly. The DRIVE is unaffected; only the
MIRROR is stale, and codex's permission mirror has no hook feed anyway (the picker
receipt IS the confirmation channel — the asymmetry noted in `finishCodexPicker`).
`parseCodexPermissionReceipt` returning null for a Read Only line is therefore
CORRECT, not a hole: Sonata can only ever confirm one of the three rows.

**NOT MODELLED, deliberately.** Adding a `read-only` member to
`CodexPermissionMode` ripples through the settings list, `codexArgs`, the session
menu and the task record — a design fork, not a table edit. Same adjudication
`ultracode` got on the claude side (SL-4, F17). Registered for Woody; documented
in the parser and pinned in the smoke so the next reader who meets that line in a
capture finds the reasoning instead of assuming a dropped receipt.

## D7 — glyphs and footer: `»` is ULTRA's alone, and the effort token can read `default`

Objective 5, re-verified at 0.152.1 across the whole ladder and a model switch:

- Idle footer shape `<model> <effort> · <cwd>` holds at every tier, and across a
  model change (`gpt-5.6-luna medium · <cwd>`).
- `»` (U+00BB) paints at **Ultra only**. **Max keeps `›`** — measured, the footer
  read `gpt-5.6-sol max · <cwd>` under a `› Ask Codex to do anything` composer,
  and `»` appeared only after the Ultra confirm. `task-ready-detection`'s section
  header says "Max/Ultra"; the glyph is Ultra's. `detectIdlePromptForProvider`
  reads ready / medium on BOTH channels at Ultra.
- The MAX and ULTRA banners are ~2s ASCII-art animations that occupy the footer
  region and are gone from the settled screen — the behaviour already pinned for
  ULTRA, now observed for MAX too. They truncate the footer from the TAIL
  (`gpt-5.6-sol high · /private/tmp/sonata-syn` → `… · /private` → `gpt-5.6-s`),
  so they eat the effort token and the cwd while leaving the model slug. The
  0.152 rate-limit/usage banners (`• You have 1 usage limit reset available…`)
  sit in the TRANSCRIPT above the composer, not in the footer region, and were
  present throughout every probe without ever displacing it.
- **NEW: the effort position can read `default`.** A session with no effort
  configured paints `gpt-5.6-sol default · <cwd>` (q29 arm B). A seventh token,
  and one a list built from the `ReasoningEffort` enum could not have contained
  because it names the ABSENCE of a tier. Added to `idlePromptModelHints` —
  HONESTLY, fixing no observed failure (that footer already matched on
  `gpt[-\w.]*`, and no measured frame has `default` as the only surviving needle;
  the banner truncation eats the tail, not the head). It is added so the list's
  membership rule is stateable — "every token the effort position can display"
  rather than "the six members of the union" — because since C14 this predicate
  is load-bearing for the boot latch, and a list whose rule has drifted from its
  purpose is how a needle goes quietly missing. Pinned as a DOCUMENTATION case,
  labelled as such, not dressed up as a differential test.

## D8 — the receipt parser is first-match-wins, and only the scan reset saves it

Measured incidentally and worth stamping, because it is the codex sibling of the
claude F19 hazard. `parseCodexModelReceipt` takes the FIRST
`• Model changed to …` in its input. Across q28's eight consecutive switches, a
parse of the WHOLE session tail returned `{gpt-5.6-sol, low}` every single time —
the first receipt of the run — while the per-press delta returned the true one.

Production is safe, and for exactly one reason: `driveCodexModelNav` sets
`this.controlSwitchScan = ""` immediately before writing the confirming `\r`, so
the window a receipt is read from starts empty. That is the whole guarantee.
NOT observed, and therefore only a hazard rather than a finding: a full-transcript
redraw replaying older `• Model changed to …` lines INTO that fresh window would
settle a switch on someone else's receipt — the shape F19 MEASURED on the claude
side. Eight consecutive switches produced no such replay here (the MAX/ULTRA
banner repaints redrew the footer many times and never a receipt line).
Registered, not fixed: value-anchoring the codex needle is possible (unlike
claude's `Kept …`, this line names the target) but it is a change to a path with
no observed defect, which is the wrong trade inside this slice.

## D9 — the image failure: NOT codex, NOT the spawn shape, NOT the account — a corrupt fixture

SL-8 localized this precisely and its localization was right: delivery and
rollout recording are perfect (`{type:"local_image", path}` at full fidelity)
while the paired `response_item` fills every image slot with
`{"type":"input_text","text":"image content omitted because it could not be
processed"}`. Its conclusion — "chase the model-side shape" — pointed at a
phantom upstream defect. **The cause is Sonata's own test fixture.**

`redPngBytes()` in `native-image-attachments.mjs` was a 69-byte "1×1 red PNG"
whose IDAT chunk declares length `0x0b` (11) for a 12-byte zlib stream.
Independently verified here by walking the chunks: IDAT CRC stored `00c9fe92`
against a computed `fdd81955`, the deflate stream truncated one byte short of its
Adler-32 trailer, and IEND consequently parsing with a declared length of
4,009,754,624. `file(1)` and `sips` still call it "PNG image data, 1 x 1" — they
read IHDR and stop — which is how a hand-built fixture survives years of being
eyeballed. Setting that byte to `0x0c` yields a file of the SAME 69 bytes whose
IDAT and IEND CRCs both verify and which inflates to `00ff0000`.

Code site: `codex-rs/core/src/image_preparation.rs` —
`IMAGE_PROCESSING_ERROR_PLACEHOLDER` is the catch-all for
`ImagePreparationError::Processing(_)`, reached when `image::guess_format` /
`DynamicImage::from_decoder` reject the bytes. Not a size cap
(`MAX_PROMPT_IMAGE_INPUT_BYTES` is 1 GiB), not a mime gate, not a model-capability
gate (that path emits a different sentence). **No upstream issue to cite:
rejecting a PNG with a truncated deflate stream is correct behaviour.**

A/B, both arms identical except argv, each attaching two fixtures differing in
one byte:

| arm | fixture | rollout `response_item` image slot |
|---|---|---|
| bare (`--no-alt-screen -C <cwd>`) | corrupt | `input_text: "image content omitted…"` |
| bare | valid | **`input_image: data:image/png;base64,…` (detail=high)** |
| production (`-p sonata …`, full shape) | corrupt | `input_text: "image content omitted…"` |
| production | valid | **`input_image: data:image/png;base64,…`** |

Spawn shape: zero effect. Image bytes: total effect. A `codex exec` arm with no
Sonata at all confirms the account and model accept images (a 64×64 PNG and a
1,2,4,8,16,31,32,33-px sweep from a correct encoder all pass, including a 1×1 that
differs from the smoke fixture only in that length byte).

And it was never a 0.152 regression: of 1,568 local rollouts, exactly 100 contain
`local_image`, all of them Sonata smoke runs, and **all 100 fail** — 39 at
0.147.0, 55 at 0.152.0, 6 at 0.152.1. Zero user `input_image` successes in the
entire history.

**Two defects were adjacent and unrelated, which is why this one could hide.**
The four red codex cases were failing on the boot/transcript problems SL-6 and
SL-8 fixed; every assertion in this file reads the DELIVERY channel (receipt,
chip, `userBlock.attachments.length`), which a corrupt file travels through
perfectly. So the smoke went green on those commits WITHOUT the image ever having
been decodable.

**DISPOSITION: green, not skipped.** Fixture corrected in
`native-image-attachments.mjs`, and a structural precondition
(`assertDecodablePng`) added so the rot cannot return silently — it walks the
chunks, checks every CRC and inflates the IDAT, and A/B'd it fails on the old
literal in under a second with `IDAT CRC mismatch … its declared length of 11 is
almost certainly wrong`. Full run: **10/10 PASS**, both providers. The check is
deliberately STRUCTURAL and says so: it cannot prove the model sees pixels — only
a rollout assertion on the prepared `response_item` could, and that was measured
once, live, at 0.152.1 rather than wired in.

## D10 — what SL-7 changed in the product

Nothing behavioural in the choreography — the three named smokes
(`midsession-codex-permission`, `midsession-codex-model`, `midsession-receipt`)
PASSED against 0.152.1 **before** any edit, which is the headline: the ratatui
0.30 bump moved nothing the codex pickers' parsers key on. The changes are
therefore corrections of falsified claims, pins for newly-measured facts, and one
vocabulary addition:

1. `tui-parsers-codex.ts` — the falsified "legacy models are not offered" claim
   replaced with the measured six-row set; the level-2 `(default)` semantics and
   model-dependent row-5 description stamped; the `Advanced Reasoning` third level
   documented with all four predicate verdicts and its measured 3-Esc depth; F8
   re-stamped with the six measured tiers and the Ultra-only suffix; the `Read
   Only` fourth mode documented with its bound; the consent block re-stamped with
   the 0.152.1 cell-diff evidence and its over-claim about the paragraph removed.
2. `control-switch-engine.ts` — `CODEX_MODEL_MAX_ROLLBACK_ESCS`'s premise
   corrected (three levels, not two; the bound is exact, not slack);
   `pressParkedConfirm`'s exit asymmetry re-driven and the cursor-reset detail
   added.
3. `terminal-host.ts` — `default` added to the codex `idlePromptModelHints`, with
   an honest note that it fixes no observed failure and why it is added anyway.
4. `midsession-receipt.mjs` — the level-1 fixture replaced with the measured
   0.152.1 frame; the D5 absence case moved off `gpt-5.4` (a premise the server
   revoked) onto a synthetic never-served slug; Max provenance EXTRAPOLATED →
   MEASURED; new pins for the `Advanced Reasoning` submenu and the `Read Only`
   receipt + no-`(current)` picker.
5. `task-ready-detection.mjs` — 0.152.1 re-verification note; new pins for Max
   keeping `›` (the negative half of "Ultra-only") and the `default` footer.
6. `native-image-attachments.mjs` — fixture byte corrected + `assertDecodablePng`
   precondition (D9).

## D11 — deviation ledger (SL-7)

1. **A new D-series rather than C15+.** The brief left the call open. C1–C14 are
   one argument about boot; this is a disjoint question about mid-session
   pickers, and interleaving would have made both harder to read.
2. **Five probes, not the three the objectives imply.** q27 was split after RUN 1
   (see 3) and q27b was added because q27's refresh answer came from a WARM
   session, which is the case that cannot falsify. Recorded because a probe that
   can only confirm is worth saying so about.
3. **q27 RUN 1 is discarded, and why.** Its first `/model` Enter did not open the
   picker; `/model` stayed in the composer and the next arm typed `/model/model`,
   which reached the model as a chat line — a burned turn, on a probe explicitly
   fenced against exactly that. Cause not established. The mitigation is the
   production one (`clearComposerBeforeTypedCommand`'s Ctrl-U flood before every
   typed command, plus waiting out the app-server handshake), and every later run
   opened cleanly. The tempting story — "readiness leads the handshake by ~200ms,
   so the Enter was swallowed in that window" — is NOT supported: q27b's
   `at-ready` arm fires at 148ms, pre-handshake, and the picker opens at 474ms
   with the full row set. Recorded as an unreproduced one-off with a hypothesis
   (`• Starting MCP servers (0/4)` was live in RUN 1's frame and codex may queue
   input while it is), not as a boot-latch finding. It does NOT stress C14.
4. **The consent GRANT was taken in the isolated arm only.** Arm A (production
   spawn, real `CODEX_HOME`) never confirms Full Access — it only Escs the
   consent or answers Cancel. The grant, and therefore the third receipt string,
   comes from arm B's isolated home against a scratch cwd. The red line is about
   what SONATA may answer, not about what a probe may measure, but taking a
   real-profile full-access grant to read one string is a worse trade than
   arranging an isolated one.
5. **`idlePromptModelHints` touched, and it is C14's registered predicate.** In
   scope by objective 5 (the codex footer), and it is not SL-6's boot-latch gate —
   but it is one input to it, so it is flagged here rather than buried. The change
   is additive and the note says plainly that no measured frame needed it.
6. **The image fixture fix is scoped to this smoke.** The same corrupt literal
   lives in five e2e files
  > **REVIEW ADDENDUM (SL-7 round-1 reviewer, orchestrator-recorded):** the
  > carrier sweep searched only the RED literal, so this under-counts — a
  > SECOND corrupt PNG literal (green 1×1, same defect class: IDAT declared
  > length 11 where the structure requires 13) lives in
  > `app/tests/e2e/preview-reader.mjs:31` and
  > `app/tests/e2e/preview-reader-screenshots.mjs:14`. Seven carrier files
  > across two literals. `assertDecodablePng` would catch both (IDAT CRC /
  > offset misalignment). Chromium decodes the truncated row leniently, which
  > is why preview-reader still passes — informational, not a live failure. (`cli-start-without-prompt`, `cli-resume-without-prompt`,
   `cli-lifecycle-races`, `composer-newchat-attachment`,
   `composer-reference-attachment`). They exercise attachment PLUMBING, not
   model-side decoding, so they are unaffected — and they are outside this slice.
   Registered, not touched.
7. **No rollout `input_image` assertion was wired into the smoke**, though the
   diagnosis argues for one. It would couple this file to rollout-file location
   and add a failure mode, and the end-to-end property was measured live once.
   The structural precondition covers the specific rot; the stronger assertion is
   registered for the file's owner.
8. **A `Q29_ARM` env filter was added to q29** mid-slice so a failed arm could be
   re-run without re-driving the expensive one; a filtered run writes its own
   capture file so it cannot clobber the full one the findings cite.

## D12 — registered (not fixed here)

1. **`Read Only` is a real codex permission mode Sonata cannot name** (D6).
   Reachable only through a user-bound #39873 cycle. Drive unaffected, mirror
   stale. Modelling it is a design fork → Woody.
2. **The codex receipt needle is first-match-wins** (D8), safe today only because
   the confirm resets the scan. Value-anchoring is possible and cheap; there is no
   observed defect to justify it inside this slice.
3. **`CODEX_MODEL_MAX_ROLLBACK_ESCS` is now exactly the measured picker depth**
   (D4), not a bound with slack. Re-check it whenever the picker's shape moves.
4. **The corrupt PNG literal in five e2e files** (D11.6).
5. **A rollout `input_image` assertion for the image smoke** (D11.7) — the
   assertion whose absence let D9 hide for years.
6. **`gpt-5.3-codex-spark` left the catalog and three "legacy" models joined it**
   (D1) — a row for SL-13's inventory re-stamp, and a standing reminder that any
   model-row claim needs a date.

## D13 — evidence files

`q27-model-picker-walk.mjs` + capture · `q27b-picker-refresh-race.mjs` + capture ·
`q28-model-receipt-tiers.mjs` + capture · `q29-permissions-consent-walk.mjs` +
2 captures (full + `cycle-shortcut`) · `q30-image-ab.mjs` + capture ·
`q30-image-fixture.mjs` + capture. All under `spikes/`, which the code repo
gitignores — they need `git add -f`. Every capture is routed through
`driver.mjs`'s `sanitize()` ($HOME, the munged `-Users-<user>-` form, the bare
username, JWT/API-key/e-mail shapes).

---

# SL-9 — hooks re-verify, CODEX side (probed 2026-09-02, binary 0.152.1)

Binary pinned `codex-cli 0.152.1` at probe start and end. Probe
`h3-hook-census-interrupt.mjs` (production `TerminalHost` through `CodexBoot`,
isolated `CODEX_HOME` under `/private/tmp`, pre-trusted via Sonata's own ledger,
production run-lifecycle dispatch replayed). Capture
`h3-hook-census-interrupt.capture.txt`.

## C15 — the declared event set, and what it does NOT contain

`HookEventsToml`, read out of the binary each run (never hand-copied), declares
**twelve** events at 0.152.1:

```
PreToolUse  PermissionRequest  PostToolUse  PreCompact  PostCompact
SessionStart  SessionEnd  UserPromptSubmit  SubagentStart  SubagentStop
Stop  Interrupt
```

Sonata registered nine + `PermissionRequest`, so exactly two were unregistered:
`SessionEnd` and `Interrupt`.

**Codex declares no `PostToolUseFailure` and no `PermissionDenied` — the needles
are absent from the binary entirely.** Both SL-2b register items are therefore
CLAUDE-ONLY facts with no codex counterpart to wire: on codex a failed tool is an
ordinary `PostToolUse`, and there is no denial event of any kind. That closes
both register lines for this provider rather than leaving them open.

## C16 — `Interrupt` fires, and the payload matches codex's own embedded schema

Codex embeds a draft-07 JSON schema per hook event in the binary. The
`interrupt.command.input` schema requires exactly seven keys and forbids extras
(`additionalProperties: false`): `cwd`, `hook_event_name`, `model`,
`permission_mode`, `session_id`, `transcript_path`, `turn_id`.

MEASURED payload from a live interrupt, checked field-for-field against that
schema: **zero missing required keys, zero unexpected keys.** So the brief's
"return unresolved if the shape is undocumented AND unstable" exit does not
apply — it is documented by the vendor's own embedded schema and it matches.

Timing: the hook landed **+141ms** after the interrupt, and **no `Stop` ever
followed for that turn**. `Interrupt` REPLACES `Stop`, exactly as `StopFailure`
does on claude.

Codex parses Interrupt-hook stdout strictly (*"Interrupt hook returned non-JSON
stdout"*, *"hook returned invalid interrupt hook JSON output"* are both in the
binary). Sonata's sink writes ZERO bytes, and a live interrupt with the sink
registered on the event painted **no hook warning anywhere in the scrollback** —
checked before registering it, because an error line per interrupt would have
made this a regression rather than a fix.

## C17 — the interrupt key MOVED, and Sonata's stop button no longer stops codex

This is the loud one, and it is not a hooks finding — it belongs to the stop
encoding in `terminal-host.ts`, which SL-9's boundary excludes. Flagged, not
fixed.

Four rounds against a live 400-line turn, each verified live at the moment the
key was sent (the screen still growing, no `Stop` yet):

| round | how the interrupt was sent | turn interrupted? | `Interrupt` hook |
|---|---|---|---|
| 0 | human Esc — `host.writeUserInput("\x1b")` | **no**, ran to completion | none |
| 1 | **production `host.stopRun()`** (Sonata's stop button) | **no**, ran to completion | none |
| 2 | human Esc, ~3s after `UserPromptSubmit` | **no**, ran to completion | none |
| 3 | **Ctrl+C** — `host.writeUserInput("\x03")` | **YES** — `■ Conversation interrupted` | **fired, +141ms** |

Rounds 0–2 each closed with an ordinary `Stop`, i.e. the model finished the turn
the user tried to stop.

The mechanism is visible in the binary: 0.152.1 ships a **configurable keymap**
(`TuiChatKeymap`) in which `interrupt_turn` is a named, rebindable action, and Esc
at the composer is now bound to backtrack-edit (*"When the composer is empty,
press Esc to step back and edit your last message"*, and the TUI's own
`esc again to edit previous message` hint appeared in an earlier arm). Sonata's
stop writes a bare `ESC` (`terminal-host.ts`, `stopRun` → `writeRaw(ESC)`).

Consequence, MEASURED: **a user pressing Sonata's stop button on a codex session
at 0.152.1 does not stop the turn.** The `/stop` follow-up `inspectSlashStop`
sends is conditional (background-terminal hint / command-approval run), so the
common case is an Esc that does nothing. Not probed further: whether the binding
is user-configurable back to Esc, and what Ctrl+C does to the pty wrapper vs the
TUI in Sonata's spawn shape. → a terminal-host slice, urgently.

## C18 — what SL-9 changed, and the A/B that keeps the claim honest

`Interrupt` joins codex's `SINK_EVENTS` and routes to the SAME consumer `Stop`
has (`TerminalHost.completeRunFromTurnEnd`, plus `CliStateModel` → `turn-ended`).
Named consumer, existing need — no new surface.

The A/B (arm `d3`, two spawns of the identical production shape differing only in
whether the `Interrupt` block is in the profile, both driven through the
production run-lifecycle dispatch, both interrupted with Ctrl+C mid-turn):

| | `Interrupt` in profile | hook | run closed |
|---|---|---|---|
| before | no | never arrived | **+2019ms** |
| after | yes | **+141ms** | **+253ms** |

**The BEFORE arm was NOT wedged.** It closed at +2s on the terminal-idle
heuristic — codex paints "Conversation interrupted" and returns to a composer,
and the scrape reads that. This falsifies the pre-probe expectation (carried into
this slice's first draft comments, since corrected) that an interrupted codex run
would sit `active` until `stoplessTurnEndConfirmed` inferred the ending ~32.5s
later.

So the honest claim is smaller than the one the wiring was proposed on: the gain
is **channel and confidence, not a rescued wedge** — a turn ending Sonata was
INFERRING from a repaint is now READ from the event that states it, off the
scrape leg SL-2b measured to be a coin flip on repaint order (F12), and onto the
event channel D-1 says an event question belongs on. Taken on those grounds, and
the code comments say exactly this.

## C19 — Sonata's injected hook config parses cleanly at 0.152.1 (brief objective 4)

`HookHandlerConfig` is an internally-tagged enum on `type`. MEASURED vocabulary
(by feeding codex a bad tag and reading its refusal):

```
Error loading config.toml: unknown variant `mcp`,
expected one of `command`, `mcp_tool`, `prompt`, `agent`
```

— i.e. an unknown handler type is a **hard config-load failure**, not a skip.
The four variants and their measured status:

| variant | fields (from the binary's struct tables) | status at 0.152.1 |
|---|---|---|
| `command` | `command`, `commandWindows`, `timeout`, `async`, `statusMessage`, `additionalContextLimit` | supported — Sonata uses this |
| `mcp_tool` | `server`, `tool`, `input`, `timeout`, `statusMessage` | supported, but `server`/`tool` must be non-empty |
| `prompt` | `prompt` | **parsed then SKIPPED** — *"prompt hooks are not supported yet"* |
| `agent` | `agent` | **parsed then SKIPPED** — *"agent hooks are not supported yet"* |

Driving a deliberately-broken profile produced these warnings **on the CLI's own
stderr / in the TUI stream**, not in the log DB:

```
warning: skipping MCP tool hook in …/sonata.config.toml: server and tool must not be empty
warning: skipping prompt hook in …/sonata.config.toml: prompt hooks are not supported yet
warning: ignoring additionalContextLimit for Stop hook in …: this event cannot emit additionalContext
```

Worth knowing on its own: a malformed Sonata hook config would print warning
lines **into the user's CLI pane**, not into a log nobody reads.

Sonata's REAL generated profile (all 12 event blocks, `type = "command"`,
`timeout = 120` on the broker) run through the same path: **zero warnings, zero
errors.** And the `timeout` clamp the binary can emit (*"clamping … hook timeout
to …s"*) did NOT fire — not at Sonata's 120, and not even at a deliberate
`timeout = 999999`. The broker's 100s hold ceiling is therefore safe at 0.152.1.

What the new variants would OFFER (report-only, per the brief): `async: true` on
a `command` hook would let the sink return immediately instead of holding the
turn — Sonata's sink already exits in milliseconds, so there is nothing to buy.
`mcp_tool` would let a hook call an MCP tool instead of a subprocess, which would
replace Sonata's shim + interpreter-prefix machinery with an MCP server Sonata
would have to run and keep alive — strictly more moving parts for the same
file-drop. Neither is worth a slice today; both are recorded so the question is
not re-opened blind.

`additionalContextLimit` (brief objective 5, codex half): the key exists as a
`command`-handler field, Sonata sets it nowhere, and codex warns when it is set
on an event that cannot emit `additionalContext`. Nothing to do.

## C20 — codex `SessionStart` is still LAZY (SL-6's premise HOLDS)

The brief asked for a flag if the census contradicted this. It does not.
MEASURED at 0.152.1: readiness at 250ms, then **twelve seconds at an idle
composer with NO `SessionStart` hook**; the handshake arrived at 12699ms, at the
moment the first prompt was submitted. SL-6's boot-latch ranking rests on this
and is unaffected. Payload: `{session_id, transcript_path, cwd, hook_event_name,
model:"gpt-5.6-sol", permission_mode:"default", source:"startup"}` — note codex
DOES carry `permission_mode` on `SessionStart` where claude 2.1.258 no longer
does (claude F34).

## C21 — codex `SessionEnd` remains UNPROBED (honest gap)

The teardown arm's `/quit` never left the composer (its Enter was swallowed, the
same first-submission behaviour C22 describes), so the pty never exited and no
`SessionEnd` could fire. This is UNREPRODUCED, **not** measured-absent. codex
`SessionEnd` stays a documented, unregistered capability; the claude half is
measured (SL-2b, `reason: "prompt_input_exit"`).

## C22 — probe-method note: the first codex submission needs an Enter retry

Recorded because it cost three probe runs. `TerminalHost.submitPrompt` pastes and
writes ONE `CSI-u Enter` at +120ms; in production the `DeliveryController` owns
the retry ladder when that Enter is swallowed. A probe driving the host directly
has no ladder, and at 0.152.1 the first submission of a session — whose boot
painted the `--dangerously-bypass-hook-trust` warning and a usage-limit notice —
**left the text sitting in the composer with no submission at all**, indefinitely
(180s watched). `h3`'s `submitAndConfirm` adds a grid-verified retry (only while
the text is demonstrably still in the composer, never a blind Enter) and every
arm now reports how many retries it needed; one CR retry was needed on every
first submission and zero thereafter.

Whether the production ladder covers this cleanly is not something this probe
measured — it is a delivery question, and the observation is filed rather than
chased.

## C23 — the codex broker shim carries the claude broker's stdout-flush defect

Claude-side F37 measured `process.stdout.write(decision); process.exit(0)`
truncating a large decision at exactly 65536 bytes on macOS. `BROKER_SHIM_SOURCE`
in `codex-runtime-settings.ts` has the byte-identical shape:

```js
function answer(decision) {
  … cleanup …
  process.stdout.write(decision);
  process.exit(0);
}
```

**FIXED in review round 1 (M1).** The fence was extended to the
`BROKER_SHIM_SOURCE` region for that round, so the twin no longer diverges.
The mirrored change is exactly what was prescribed here:

- `answer()` → `process.exitCode = 0; process.stdout.write(decision);` (drop the
  `process.exit(0)`), and `return` after each of the two `answer(...)` call sites
  (the reply branch and the deadline's late-reply branch), or the deadline branch
  will write `expired-<id>.json` over an answer codex is about to receive;
- a `process.stdout.on("error", () => process.exit(0))` guard at the top, so a
  dead read end cannot become stderr noise.

Reachability on codex is even LOWER than on claude — `codexBrokerDecisionJson`
emits a fixed ~90-byte object with no `updatedPermissions` — so this was a
correctness-parity item, not an incident. It is now pinned like its twin:
`hook-stdout-contract.mjs` MATERIALIZES both codex shims through the production
`ensureCodexRuntimeSettings` (isolated `CODEX_HOME`) and runs the same cases
against all FOUR shipped commands. A/B against the pre-fix shim:

```
AssertionError: codex: a 4000102-byte decision arrives COMPLETE
  (got 65536; 65536 means the stdout flush regressed)
```

— the codex shim truncated at the identical 65536 bytes, and passes after.

## C24 — evidence files

`h3-hook-census-interrupt.mjs` (arms d1–d4; d4 is the B1 premise) +
`h3-hook-census-interrupt.capture.txt`, under
`spikes/` (gitignored by the code repo — needs `git add -f`). Captures are routed
through `driver.mjs`'s `sanitize()` (`$HOME` and the munged `-Users-<user>-`
form). Probe cwds and the isolated `CODEX_HOME`s are under
`/private/tmp/sonata-sync-2026-09/`.

## C25 — B1: `Interrupt` fires WHILE a broker hook is holding, and that broke the release path

Review round 1 caught a defect this slice introduced. Recorded in full because
the wrong half of it was an UNMEASURED premise I shipped on.

**The defect.** `Interrupt` completes the run through
`TerminalHost.completeRunFromTurnEnd`, which stamps `completionSource:
"hook-stop"`. `RuntimeController`'s `isPendingTurnEnd` deliberately EXCLUDES
hook-stop completions, on the invariant *"a live holding hook blocks the turn, so
a hook-Stop completion cannot coexist with a pending broker ask"*. That invariant
is `Stop`'s and it is TRUE for `Stop`. It is FALSE for an interrupt, which KILLS
the holding PermissionRequest hook — which is the exact reasoning
`abortPendingBrokerApprovals`'s own header gives for why that function exists.

**MEASURED** (probe `h3` arm `d4-interrupt-under-hold`, production broker armed
with the answering marker, a real held ask):

```
ask surfaced        16624ms   ["answering-enabled","ask-mtjqaxcp-…json"]
Ctrl+C              18126ms   (ask still pending, never replied, never expired)
Interrupt hook      18257ms   (+131ms)
Stop                never
approvals dir 25s later:  ["answering-enabled","ask-mtjqaxcp-…json"]   ← still there
```

The broker process died with the turn. Nothing will ever write that ask a reply
or an expiry marker. Left on the hook-stop route its id sits in
`pendingBrokerApprovals` forever, `DeliveryController.pendingApprovalKeys` keeps
the gate shut, and every later send wedges until the pty dies — INVISIBLY, since
the reducer has already retracted the card. **Pre-SL-9 the ~+2s
`terminal-idle-heuristic` closer (which IS a pending turn end) released it; the
hook preempted that release permanently.** So the slice turned a 2-second
inference into a permanent hold, in exactly the case it never probed.

Method note worth keeping: the FIRST attempt at this arm did not reproduce the
hold at all. It tried to escalate by writing outside the workspace, to a path
under `/private/tmp` — and codex ran it unattended, because its own turn log
shows `WorkspaceWrite { exclude_slash_tmp: false, exclude_tmpdir_env_var: false }`,
i.e. **/tmp is inside the sandbox**. NETWORK is the reliable escalation
(`network_access: false`) and has no filesystem effect, which matters for a
command the arm deliberately never approves.

**The fix, and why it is not the shape the reviewer preferred.** The honest shape
is a distinct `completionSource: "hook-interrupt"` added to `isPendingTurnEnd`;
that needs `CompletionSource` (shared/types/domain.ts) and
`TerminalHost.completeRunFromTurnEnd`, and terminal-host.ts is held by a
concurrent slice and fenced out of SL-9. Shipped instead: an
`interruptDrivenRunIds` set on the controller, added before the completion call
and READ-AND-DELETED at the gate, so the gate's release list stays SINGLE-SOURCED
(the property that matters — a fourth release added to that block is picked up by
interrupts for free). Keyed by run identity, not by timing, so it does not depend
on `emitEvent` being synchronous. **Registered follow-up: whoever owns
terminal-host next should replace it with the typed source and delete the map.**

Ripple checked: `isExpiredTurnEnd` is `isPendingTurnEnd || (completed &&
hook-stop)`, and an interrupt-driven completion already satisfied its second arm,
so widening the first changes nothing there. The option-prompt release in the
same block now also runs for interrupts — a no-op today (`pendingOptionPrompt` is
claude-only) and correct if codex ever grows one.

**Pinned** by `tests/smoke/interrupt-hook-pending-approval.mjs` on the REAL
controller (real ApprovalWatcher, real HookWatcher, real dispatch). A/B:

```
pre-fix   FAILED: timed out waiting for the Interrupt releasing the pending broker ask
          decisions=[]   runTrail=["completed/hook-stop"]
post-fix  interrupt-hook-pending-approval: OK
```

Two assertions in that test were rewritten after they passed for the wrong
reason, which is worth recording: `canDeliver() === false` while the ask is held
is ALSO false because the run is live, so it isolates nothing; and
`deliverable === true` after the release never arrives, because with an empty
queue no fresh `delivery:state` is emitted at all. The release is proved instead
by a real send LEAVING the queue once the run is closed — at which point a
still-held approval key is the only thing that could have pinned it.

---

# SL-15 — codex stop repair + typed interrupt completion

## C26 — PREMISE CORRECTION to C17: Esc's interrupt is PHASE-dependent, not dead

C17 measured three Esc paths leaving a live codex turn to run to completion and
concluded "the interrupt key MOVED to Ctrl+C". SL-15's first end-to-end probe
(q33 v1) ran an Esc leg as an expected-inert CONTROL — and the control
interrupted, `Interrupt` hook at +128ms. Two measurements of the same binary
disagreeing means one of them is answering a different question, so the arm was
stopped and the question was re-asked properly.

The one variable that differs is HOW FAR INTO THE TURN the key landed, read off
the two captures rather than guessed:

| capture | UserPromptSubmit | key at | into the turn | outcome |
|---|---|---|---|---|
| h3 round 0 (human Esc) | 8655 | 13400 | +4.7s | `Stop`, reached 400 |
| h3 round 1 (`stopRun()`) | 42670 | 47407 | +4.7s | `Stop`, reached 400 |
| h3 round 2 (human Esc) | 76681 | 79716 | +3.0s | `Stop`, reached 400 |
| q33 v1 draft (raw Esc) | 6416 | 8409 | +2.0s | **`Interrupt` +128ms** |

Both probes gated on "the screen is still growing", and that gate cannot tell the
phases apart: codex's `• Working (2s • esc to interrupt)` row TICKS ITS TIMER
once a second, so the screen grows during the model's thinking phase exactly as
it does mid-stream. **The gate was measuring the clock, not the model.**

`q34-esc-vs-ctrlc-phase` re-asks it with the phase judged from the count's own
output — a screen line that is a bare number — and re-verified at the instant of
the press. Two keys × two phases, each cell its own spawn, each cell run twice:

| | before the model emits anything | once tokens are streaming |
|---|---|---|
| **Esc** | interrupts (+138ms, +141ms) | **NOTHING** — the turn runs on to its own `Stop`, 2/2 |
| **Ctrl+C** | interrupts (+127ms, +144ms) | interrupts (+118ms, +151ms) |

So C17's cell was measured correctly three times and generalised one step too
far. The narrower claim does not soften the consequence — output arriving is
exactly WHY a stop gets pressed, so the failing cell is the user-facing one — and
it sharpens the fix: **Ctrl+C is the only key that interrupts in every phase of a
live turn.**

Kept as a standing warning: codex's own footer reads `esc to interrupt`
throughout both phases. That string is in Sonata's codex `activityHints` as
fence-only ordering vocabulary and is still measured present; it is NOT evidence
about the binding, and the profile now says so where it sits.

## C27 — q31: the Ctrl+C state map, and the cell that makes this a guard

Before wiring a key whose action the binary literally names
`fixed.interrupt_or_quit`, every state Sonata's stop can reach was measured. The
trust-flip lesson (SL-1: a dialog's default row moved and Sonata's approve began
EXITING the CLI) is this exact shape.

| state at the press | what Ctrl+C does |
|---|---|
| live turn (either phase) | interrupts; `Interrupt` +115…151ms; no `Stop`; composer left EMPTY — the prompt is NOT restored, unlike an Esc interrupt |
| live turn, native approval panel up | DENIES the request (`✗ You canceled the request to run curl …`) **and** interrupts (`Interrupt` +120ms) |
| `/model` picker open | closes the picker; no quit (picker presence confirmed on the stream at press time) |
| idle composer holding a draft | clears the draft |
| **idle composer, EMPTY** | **QUITS THE CLI — `exit 0`, one press, no confirmation** |

The binary carries a `" again to quit"` footer fragment and a
`fixed.interrupt_or_quit` action name, which together suggested a
press-again-to-confirm step. **There is none at this binary.** The probe's first
draft carried four more arms built on that assumption — a fast Ctrl+C pair, a
pair at the measured arming window, a "does typing disarm it" arm, and an "arm the
quit at idle, then run a turn, then interrupt" trap — and all four collapsed the
moment s2 measured the single press quitting outright. They are recorded in the
probe header rather than deleted silently: "we looked for a confirmation step and
there is none" is the finding.

An empty composer is not an exotic state. It is what an interrupt itself leaves
behind (s1: a second Ctrl+C 2.5s after the interrupt quit, 3/3 runs) and what
clearing a draft leaves behind (s3: draft cleared, second press quit). **On codex
a stop's key and its resend are not two tries at the same thing — they are two
different actions.**

## C28 — the guard is the run pointer, and the screen is falsified as a belt

Twice over, which is why the guard has exactly one term.

**Empirically.** Sampled through genuinely live turns, the PRODUCTION idle-prompt
detector (`detectIdlePromptForProvider`, the predicate `acceptsPromptInput`
falls through to) read `ready:true` in **12/20, 12/20 and 14/20** samples across
three runs — the codex counterpart of F12's coin flip on claude. A "refuse the
interrupt if the screen looks idle" belt would refuse the majority of real
interrupts and re-open C17.

**Architecturally.** The scrape that DOES track codex's working row
(`StatusRegionTracker`, `CODEX_STATUS_PATTERN = /esc to interrupt/i`) is contract
§3.1 fence #1 — display-only, permanent citizen, nothing derives state from it.

And `acceptsPromptInput()` is not an independent second signal either: it returns
false whenever `activeRun` is set, so it restates the run pointer rather than
standing beside it.

**Residual, and it is bigger than the first draft of this section said.** That
draft framed it as a fault case ("if a `Stop` hook is ever DROPPED"). Review
corrected it, and the correction is right: the pointer trails codex by the length
of the turn-end hook round trip, so the window opens after **every codex turn**.

```
model emits its last token; codex repaints an idle EMPTY composer   <-- hazard opens
  -> the Stop shim writes hook-*.json          ~110-170ms   (latency measured on
                                                             this channel for
                                                             Interrupt: +106/+115/
                                                             +120/+141/+170ms)
  -> HookWatcher's next tick                   0-250ms      (production runs the
                                                             250ms default; no
                                                             override at the
                                                             construction site)
  -> dispatch closes the run                                (SL-9 end-to-end:
                                                             hook +141ms, run
                                                             closed +253ms)
                                                            <-- hazard closes
```

**~250-400ms, once per turn end** — and a click as the last token lands is
exactly the click a user makes. A dropped `Stop` widens the same window to
`stoplessTurnEndConfirmed`; that is the tail of this distribution, not the whole
of it.

Two things that are NOT part of the hazard, checked rather than assumed:

- **The renderer's stop button.** The run report rides a 1000ms trailing debounce,
  so the button outlives the pointer — and a click in that tail reads an
  already-closed pointer and writes Esc. It fails safe.
- **A live turn's own quiet stretches.** The pointer is live and codex is
  genuinely mid-turn; Ctrl+C interrupts. Correct in both phases (q34).

**A recency belt was considered and REJECTED on existing evidence.** "Only send
Ctrl+C if printable output landed within the last N ms" would close most of this
window. It would also refuse exactly the interrupt a user most wants: a codex turn
can be printable-silent for minutes while the model works — SL-2b's F13b measured
that directly, and it is why the quiescence judge had to be restated on raw
timestamps. Refusing a stalled turn's stop is the failure this slice exists to
fix; buying a fraction of a second against it is a bad trade. Not shipped, and
not rejected on a guess either: if anyone wants it, it needs its own measurement
of how long a live codex turn stays silent in the field.

The root fix retires the window rather than guarding it — see C29.

## C29 — REGISTERED, MEASURED, NOT ADOPTED: an interrupt key that cannot quit

0.152.1 ships a configurable keymap. Beside the unrebindable
`fixed.interrupt_or_quit` sits **`chat.interrupt_turn`** — a named action scoped
to `chat`, i.e. to a running turn. `q32-keymap-interrupt-rebind` asked the three
questions that decide whether it is a real option:

1. **Does it load from SONATA'S OWN profile?** YES. `[tui.keymap.chat]
   interrupt_turn = "…"` appended to `$CODEX_HOME/sonata.config.toml` (layered by
   `-p sonata`) is honored. A root-config binding would have meant mutating the
   user's own keymap for every codex session they run, Sonata-launched or not —
   which this program does not do. It does not come to that.
2. **Does the bound key interrupt?** YES — bound to `alt-i`, `Interrupt` at +121ms.
3. **Is it inert at an idle empty composer?** YES — screen unchanged, no quit.
   Ctrl+C still quits there on the same session, so the rebind ADDS a key rather
   than disarming the fixed chord.

**The hazard that comes with it, and it is sharp.** A binding that collides with
any default is not a warning — it is a hard `exit(1)` at boot, i.e. an
unlaunchable CLI:

```
Error: Invalid `tui.keymap` configuration: Ambiguous `tui.keymap.main` bindings:
`chat.interrupt_turn` shadows `editor.move_left` with the same key.
Fix the config and retry.
```

That was the first candidate, `ctrl-b` (emacs `editor.move_left`). So adopting
this means owning a key whose collision surface is upstream's default map and can
change under us on any release — the failure mode being "codex will not start".

**The trade, with the numbers on both sides.**

- Do nothing: a **~250-400ms quit window at every codex turn end** (C28), whose
  failure is `exit 0` with no confirmation — the session is gone, and the user's
  own last action caused it. Plus a longer tail on a dropped `Stop`.
- Adopt the rebind: that window disappears entirely (the bound key is inert at an
  idle composer, measured). The new failure is a **boot failure** — a binding that
  collides with an upstream default makes codex refuse to start until the profile
  is fixed — on a collision surface upstream owns and can change on any release.

The second failure is louder, earlier, and recoverable (it happens at spawn, says
exactly what is wrong, and Sonata writes the profile so it can stop writing it);
the first is silent, mid-session, and destroys work. That is an argument, not a
decision: adopting it means Sonata takes ongoing responsibility for a key staying
un-collided across codex releases, which is a standing maintenance cost this
program should choose deliberately.

Reported, not adopted: SL-15's brief reserves an alternative interrupt channel for
a decision — Woody's call, not the slice's. If it IS taken, the collision surface
wants a spawn-time check (codex exits 1 with the offending action named, so the
failure is detectable and attributable) rather than a hand-picked key trusted
forever.

## C30 — what SL-15 changed in the product

**1. `TerminalHost.stopInterruptKey()` — the key is chosen per stop.** Claude is
Esc and byte-identical. Codex writes Ctrl+C when `activeRun` is non-null and in a
live status (`active` / `waiting-for-approval` / `resumed-after-approval`), and
Esc otherwise — the byte that path already wrote in that state, unchanged rather
than re-decided on an unmeasured basis.

**2. The one-shot stop resend is not armed behind a Ctrl+C.** Two independent
reasons, either sufficient. It would be UNSAFE: the resend's only guard is a
PreToolUse hook after the stop — it cannot gate on the run pointer, because
`stopRun` has already closed the run (its own guard reads `!this.activeRun`), so
a blind resend of a quit-capable key has nothing structural behind it. And there
is nothing to recover: Ctrl+C interrupted in 3/3 measured presses, and the codex
Esc it would otherwise resend is measured inert against a streaming turn.

**3. `encodedAs` tells the truth.** `StopInterruptEncoding = "Esc" | "Ctrl+C"`
(a subset of `ApprovalDecisionEncoding` by construction, since a stop key landing
on a native panel denies it and the same value travels on `approval:decision`).
It rides `run:stop-requested`, the durable `RuntimeStopReport`, the run's
`statusReason`, and the run outcome the reader renders — which now READS the key
instead of hard-coding "Stopped by Esc".

**4. The typed turn-end source.** `CompletionSource` gains `"hook-interrupt"`;
`completeRunFromTurnEnd({ ending: "interrupt" })` stamps it;
`RuntimeController.isPendingTurnEnd` reads it off the event; SL-9's
`interruptDrivenRunIds` side channel and all of its bookkeeping are DELETED. SL-9
registered exactly this follow-up. `isExpiredTurnEnd` needed no change (it is
`isPendingTurnEnd || hook-stop`, and the first disjunct widened). The two named
consumers were checked: `gui-walking-skeleton.mjs:52` matches
`hook-stop|terminal-idle-heuristic` on a claude walking skeleton that produces no
interrupt, and `reading-turns.mjs:392` only asserts that `completionSource`
participates in the turn signature. `transcript.ts` and
`reading-core/selectors/runs.ts` each branch on `terminal-idle-heuristic` alone.

## C31 — verification

**q33, live codex 0.152.1 through the production `TerminalHost`.**

- `v1` — production `stopRun()` on a turn verifiably STREAMING (5.4s in, the
  count at 19 and climbing): `Interrupt` at **+115ms**, the count **froze at
  20/900**, `■ Conversation interrupted`, pty ALIVE, `run:stop-requested` carrying
  `encodedAs: "Ctrl+C"`, run closed `stopped` / `native-control` /
  `"Ctrl+C interrupt sent"`. The A/B is q34's own streaming cell — the same key
  at the same phase, twice, not interrupting — rather than an in-turn control leg
  whose phase is uncontrolled (that draft is what produced C26).
- `v2` — a human Ctrl+C in the co-visible Terminal: `Interrupt` at +170ms, no
  `Stop`, run closed with `completionSource: "hook-interrupt"` and
  `statusReason: "interrupt hook (turn interrupted)"`.
- `v3` — the stop pressed at an IDLE composer, the cell where one Ctrl+C quits:
  pty ALIVE after an empty-composer stop; a typed draft still on the line after a
  stop with a draft (`DRAFTKEEP` before and after); the session still answers
  (`STILL_ALIVE` in the scrollback).
- `v4` — **C25 itself, re-run through the fix.** The PRODUCTION broker holding a
  real ask (`ask-mtjtaup6-…json` on disk, answering marker armed, network
  escalation so the sandbox cannot satisfy it), interrupted mid-hold:

  ```
  ask surfaced         19595ms   ["answering-enabled","ask-mtjtaup6-…json"]
  Ctrl+C               (hold live, ask never replied)
  Interrupt hook       +106ms    Stop: never
  approvals dir 20s later:  ["answering-enabled","ask-mtjtaup6-…json"]   ← still there
  run closed:          completionSource "hook-interrupt"
                       statusReason "interrupt hook (turn interrupted)"
  ```

  Both halves matter, and the second is what makes the first mean anything: the
  ask is STILL orphaned (no `reply-`, no `expired-` sibling) — upstream behaviour
  is unchanged, the wedge ingredient is real — and the run now closes carrying the
  value `isPendingTurnEnd` reads, instead of the `hook-stop` that the predicate
  deliberately excludes.

**Why v1 cannot assert `hook-interrupt`, and why the chain is closed.** A
Sonata-initiated stop closes the run LOCALLY inside `stopRun`
(`finishActiveRun("stopped", …)`, `native-control` — the honest source, since
Sonata ended it); the `Interrupt` hook lands ~130ms later on a closed run and is a
no-op by design. `hook-interrupt` is the shape of an interrupt Sonata did NOT
initiate — v2, and under a live broker hold, v4. The release ITSELF lives in
`RuntimeController` and is pinned on the REAL controller (real ApprovalWatcher,
real HookWatcher, real dispatch) by
`tests/smoke/interrupt-hook-pending-approval.mjs` — SL-9's pin, which passes
UNCHANGED across this slice because it pins behaviour, not mechanism. Live CLI in
the exact wedge state → typed event (v4); typed event → release (that smoke).

**e2e `stop-continue` — the only LIVE-CLI stop fence, and a review BLOCKER.** It
drives codex, stops a turn whose shell command is provably running, and waited on
the rendered outcome note `"Stopped by Esc"`. That string is now `"Stopped by
Ctrl+C"` (`stopRun` → `run:stop-requested.encodedAs` → run-index `stopEvents` →
`runOutcome`), so the fixture would have burned its 240s locator timeout. Locator
updated with a header note recording that the KEY is part of the fence, not
incidental copy — this is the live half of the byte pin in
`codex-stop-interrupt-key.mjs`. RUN FOREGROUND, `success: true`, and its durable
report carries the whole chain:

```
commandAliveBeforeStop  true          commandStopped  true      endFileSeen  false
stoppedRunStatus  "stopped"           completionSource "native-control" / high
stopEvents[0]  action "interrupt"  phase "interrupt"  encodedAs "Ctrl+C"
stopEvents[1]  "Ctrl+C sent immediately; /stop inspection is running in the background"
stopEvents[2]  slashStopSent true   "background terminal hint detected…"
composerRefilledWithStoppedPrompt  true      runCount 2 (recovery turn created)
```

The running `python3 … time.sleep(120)` was actually killed and its end-flag never
written — so the stop reached the process, not just the screen.

**Tests.** `npm run smoke` — **146 / 146 PASS / 0 FAIL / 0 SKIP** (the SL-4
baseline's two reds are both green since SL-7/SL-11). New:
`tests/smoke/codex-stop-interrupt-key.mjs`, 14 checks, A/B'd — with only the key
choice reverted in-tree and rebuilt, **6** of them FAIL and all 14 pass after:

```
not ok - codex + a LIVE turn: the stop writes Ctrl+C, and records that it did
not ok - codex + a live turn: the one-shot resend is NOT armed behind a Ctrl+C
not ok - codex + a run in "active": the stop writes Ctrl+C
not ok - codex + a run in "waiting-for-approval": the stop writes Ctrl+C
not ok - codex + a run in "resumed-after-approval": the stop writes Ctrl+C
not ok - codex + a live turn under an approval panel: the deny is recorded as Ctrl+C
```

Recorded as a method note because the first report said FIVE: that count was read
off a `tail`-truncated run whose top line — the first failure — had scrolled off.
Re-run with `grep -c "^not ok"` rather than by eye. A claimed artifact that is not
read in full is not a verified artifact. Extended:
`stop-hook-completion.mjs` (the `hook-interrupt` stamp and the unchanged
default), `reading-composer-selectors.mjs` (the outcome copy reads the recorded
key; the pre-field fallback and a retry row are pinned too).

## C32 — evidence files

- `q31-ctrlc-state-map.mjs` + `.capture.txt` + `q31-shards/` (per-arm shards and
  `s1.history.jsonl`, an append-only record added after a re-run overwrote the
  run that held the interesting reading).
- `q32-keymap-interrupt-rebind.mjs` + `.capture.txt`.
- `q33-stop-fix-live.mjs` + `.capture.txt` + `q33-shards/`.
- `q34-esc-vs-ctrlc-phase.mjs` + `.capture.txt` + `q34-shards/`.

## C33 — deviation ledger (SL-15)

Decisions the brief did not specify.

1. **`CTRL_C` is defined in terminal-host.ts, not beside `ESC`/`KILL_LINE` in
   `tui-parsers-common.ts`.** Those are inert primitives any module may reach for;
   this byte is not safe to write without `stopInterruptKey`'s state check. The
   byte and the reason it is dangerous should not be separable.
2. **`completeRunFromTurnEnd(failure?)` became
   `completeRunFromTurnEnd(options?: { errorExcerpt?; ending? })`.** `ending` is a
   closed two-member union rather than a raw `CompletionSource`: this method may
   only ever stamp a hook-driven ending. Every existing call site type-checks
   unchanged.
3. **`settleApprovalAsEscDeny` → `settleApprovalAsStopKeyDeny(runId, encodedAs)`.**
   The old name would have been false for half its calls. The deny bookkeeping
   itself is unchanged and was re-measured for the new key (q31 s8).
4. **Files touched outside the declared set, and why.**
   `shared/types/events.ts` + `shared/schemas/runtime-report.ts`: `encodedAs` was
   the literal type `"Esc"`, so recording a Ctrl+C stop was not merely mislabelled
   but untypeable. `reading-core/selectors/runs.ts`: `runOutcome` hard-coded
   "Stopped by Esc" and would have misreported every codex stop in the durable
   record. `shared/types/cli-signal.ts`: comment-only — it carried C17's
   over-general Esc claim, which C26 falsified; leaving a measured-false claim in
   place is worse than the edit. `spikes/.../driver.mjs`: the probe event
   projection was widened additively (run id/status/completionSource) so q33 could
   assert on the completion source.
5. **The stop's `cliInputMaybeDirty` flag stays unconditional** even though a
   codex Ctrl+C interrupt leaves the composer empty (q31 s1). Its other producer
   is the canceled text write, which is key-independent; the cost when wrong is a
   kill-line flood into an empty composer — the designed harmless no-op.
6. **q31's arm set was cut from nine to five mid-probe**, and the four dropped
   arms are recorded in the probe header with the measurement that collapsed them
   (C27).
7. **NOT taken: the `chat.interrupt_turn` rebind** (C29) — measured, hazard
   included, left as a decision.
8. **NOT taken: a printable-output recency belt on the Ctrl+C choice.** It would
   close most of C28's per-turn window, and it would refuse the interrupt of a
   silently-working turn — the exact failure this slice fixes (SL-2b F13b). A
   timing heuristic is not shippable here without its own measurement, and the
   existing measurements argue against it rather than for it. Recorded so it is
   not re-proposed as an obvious win.
9. **The residual was RESIZED in review, not discovered then.** The first draft of
   C28 called it a dropped-hook fault case; it is a per-turn latency window. The
   sizing is now derived from the production poll interval and this program's own
   measured hook latencies rather than from a description.

## C34 — out of scope, noticed

- **A codex stop at an idle composer still writes Esc, which is `fixed.backtrack`
  ("step back and edit your last message").** Unchanged by this slice by design —
  it is the byte that path already wrote, and re-deciding it would be an
  unmeasured second change. q33 v3 measured it as harmless in both idle cases
  (empty composer survived; a typed draft survived intact), but "harmless" is not
  the same as "right": there is nothing to interrupt in that state, and writing
  nothing at all may be the better answer. Needs its own measurement, not a guess.
- **`acceptsPromptInput()` reads `true` for ~60% of samples during a live codex
  turn** at the raw-tail detector underneath it (C28). Nothing in this slice
  depends on it — the run pointer short-circuits it — but it is the same coin-flip
  class F12 registered on claude, now measured on codex, and any future
  screen-derived liveness claim should start from that number.
