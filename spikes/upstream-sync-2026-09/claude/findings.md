# Upstream-sync 2026-09 — claude probe findings (target: 2.1.252)

Probed 2026-09-01. Binary pinned at session start AND re-read after Woody's
restart: `2.1.252 (Claude Code)`. Harness: thin fork of the 2026-08 canonical
driver (`driver.mjs` here re-exports it; ONE override, see F1).

## F1 — workspace-trust dialog DEFAULT ROW FLIPPED (MUST-FIX, high severity)

Measured (q1 first run, control session, no `--settings`):

```
 Accessing workspace:
 <cwd>
 Quick safety check: Is this a project you created or one you trust? …
 Claude Code'll be able to read, edit, and execute files here.
 Security guide
 ❯ No, exit
   Yes, I trust this folder
 Enter to confirm · Esc to cancel
```

- At 2.1.220 the affirm row was the default — the 2026-08 `bootTrusted` answered
  with a bare Enter and reached the composer. At 2.1.252 the cursor boots on
  **"No, exit"**: the same Enter now DECLINES trust and exits the CLI.
- Production blast radius: `claudePanelOptionKeys` (terminal-host.ts) maps the
  trust panel's approve action to plain `\r` — a user tapping Approve on
  Sonata's trust card now kills the session instead of granting trust.
- Wording/hints: `CLAUDE_WORKSPACE_TRUST_APPROVAL_HINTS` already matches the
  2.1.252 wording (code is ahead of the inventory stamp). Options carry NO
  digits — arrow+Enter is the only answer channel, so the fix must drive Down
  and grid-verify `❯ Yes, I trust this folder` before confirming.
- Open sub-question for the fix slice: is the row order conditional (fresh dir
  vs. previously-seen, worktree vs. plain dir)? Probe both before hardcoding.

## F2 — `claude auth status --json` at 2.1.252 (PASS, re-stamp)

```
{"loggedIn":true,"authMethod":"claude.ai","apiProvider":"firstParty",…,
 "projectsDirectory":"$HOME/.claude/projects",…,"subscriptionType":"max"}
exit=0
```

- `loggedIn` field intact on stdout; exit 0 signed-in. Probe surface unchanged.
- Micro-UNLOCK noted: `projectsDirectory` is a structured transcript-root
  source (session-locator currently hardcodes `~/.claude/projects`).

## F1b — trust-dialog answer choreography (q2, MEASURED)

- An input-ARMING window follows the dialog paint: a Down written immediately
  after the needle appears is swallowed (screen byte-identical 400ms later); a
  Down at **+500ms registers** (first attempt of the sweep — the window closed
  somewhere in (0, 500]ms). After the dialog paints, the CLI queries the
  terminal (`CSI >0q`, DA1) — arming may ride the response round-trip.
- Affirm sequence that works: wait, Down, grid-verify `❯ Yes, I trust this
  folder`, Enter → composer reached. Production fix shape:
  **verify-and-retry loop**, never a fixed delay.

## F1c — trust dialog: variant matrix + what production's keys ACTUALLY do (q3, SL-1)

Probe `q3-trust-variants.mjs` (capture `q3-trust-variants.capture.txt`), binary
re-pinned `2.1.252` at probe start. Scratch dirs under
`/private/tmp/sonata-sync-2026-09/` — NOT the agent scratchpad, whose path
embeds the username, so the captured grid frames are publishable verbatim (they
become tracked test fixtures; the pre-push fence scans blob content).

**(a) Row order / default row is NOT conditional.** Every variant that painted a
dialog painted the SAME one:

| variant | dialog? | default row | rows (screen order) | granted by the grid-verified walk |
|---|---|---|---|---|
| plain fresh dir | yes | `No, exit` | `❯decline`, `affirm` | yes |
| fresh `git init` repo | yes | `No, exit` | `❯decline`, `affirm` | yes |
| linked git WORKTREE | yes | `No, exit` | `❯decline`, `affirm` | yes |
| dir DECLINED on a previous launch | yes | `No, exit` | `❯decline`, `affirm` | yes |
| child dir of a dir trusted this run | **no dialog** | — | — | — |

So the fix does not need per-variant branching. It still reads DIRECTION from
the grid, because the row order is exactly what moved between 2.1.176 (affirm
FIRST, digit-addressed) and 2.1.252 — the thing that changed once can change
again. Bonus: trust is inherited by SUBDIRECTORIES (no dialog for a child of a
trusted dir), and declining is not remembered (the same dir re-asks).

**(b) Both of Sonata's approve encodings KILL the session at 2.1.252.**

- Bare `\r` (what `claudePanelOptionKeys` mapped trust-approve to): answered the
  default row → `exited=true exitCode=1`.
- `CSI-u Enter` `\x1b[13u`: sent 800ms after paint (past the arming window) →
  screen byte-identical, `exited=true exitCode=1`. **The in-code comment "CSI-u
  Enter bounces off the trust screen" is now STALE** — it is honoured, and it
  declines.
- Digits are INERT: `1` pressed on the live dialog (after a Down proved input
  was armed) left the screen byte-identical and moved nothing.

**(c) The premise correction that mattered.** SL-1's brief assumed production
took the v2 path and wrote `\r`. It did not: the 2.1.252 rows lost their
`1.`/`2.` digits, so `parseClaudeApprovalPanel` returned **null** and the panel
fell through to the LEGACY hint path, whose generic approve is `CSI-u Enter`.
Same user-visible outcome (Approve kills the session), different code path — so
the fix had to restore the structured parse as well as replace the answer.

**(d) The fix, exercised against the real binary** (`q4-trust-fix-live.mjs`,
capture `q4-trust-fix-live.capture.txt`): a real `TerminalHost` from `dist/`
spawning real `claude` with Sonata's own args → `approval:detected` carries
`approve:grid-verified Arrow + CR` → `sendApprove()` resolves → trust granted,
`ptyExited=false`, composer reached. The two grid frames it captured are the
MEASURED fixtures `app/tests/fixtures/approval-panels/trust-2.1.252.txt` and
`…-affirm-focused.txt`.

RE-RUN 2026-09-01 (SL-1 review, minor #1): the first two runs listened for
`pty:exited`, which the runtime never emits — the event is `pty:exit`
(terminal-host.ts), so the capture's `ptyExited=false` was vacuous. Listener
corrected and the probe re-run against the live binary; `ptyExited=false` is now
observed rather than assumed, and `success=true` still holds.

The re-runs also caught the arming window in production shape: the walk resolved
in **354ms** on one run (one press: the affirm row focused on the first retry)
and **706ms** on another (the first Down swallowed, the second landed). Same
code, same dialog, different arming outcome — which is the measured reason the
answer is verify-and-retry and not a fixed `ArrowDown + CR`.

## F3 — 2.1.252 boots into the FULLSCREEN renderer (alternate screen) — substrate change

Raw stream (q2): `CSI ?1049h` + `CSI 2J` immediately after the trust grant,
then mouse tracking `?1000h ?1002h ?1003h ?1006h` (any-motion included) and
OSC 0 title `✳ Claude Code`. No offer dialog was shown — fullscreen is simply
ON for this account at 2.1.252.

- The idle needles still render inside the alt-screen frame (grid reconstruction
  sees them — explains why field dogfooding didn't collapse):
  `⏸ manual mode on · ? for shortcuts · ← for agents` byte-identical to
  2.1.220, and `◐ medium · /effort` above the composer. Boot header:
  "Opus 5 with medium effort · Claude Max".
- Consequences to audit in slices: alt screen has NO scrollback (SCROLLBACK_ROWS
  reasoning shifts); ANY-MOTION mouse tracking is on (a GUI forwarding mouse
  motion/clicks can answer prompts — upstream fixed two such bugs in-range);
  repaint cadence differs (welcome mascot animates via full-frame repaints).

## F4 — Remote Control AUTO-CONNECTED at boot (was KNOWN BROKEN at 2.1.212–220)

Boot banner prints the session URL (`https://claude.ai/code/session_…` inside
"Keep working from anywhere … run /remote-control"), footer right edge carries
an `/rc connecting…` → green `/rc` pill. So: (a) RC works again on this
account — the #78309-era breakage is gone in the field; (b) the detection
surface Sonata had (`REMOTE_CONTROL_URL_RE` on a URL line) is superseded by a
banner + pill form. Re-derive the RC surface in its slice.

## F5 — statusLine config SUPPRESSES the readiness/activity needles (q1 A/B, CONFIRMED)

Strict A/B at 2.1.252, one variable (`--settings {statusLine only}`):

- **B (control)**: `? for shortcuts` true; `◐ medium · /effort` renders (F3).
- **A (statusLine)**: `sonata-status-probe` renders in the footer block (shares
  a row with the `/rc` pill); `? for shortcuts` **absent at idle, during a real
  busy turn, after it — and absent from the entire raw stream**;
  `esc to interrupt` **absent from the raw stream through a live turn**
  (busy confirmed via spinner glyphs); the `◐ medium · /effort` status line
  is ALSO suppressed. What remains: `⏸ manual mode on · ← for agents`.

Production consequences (Sonata injects statusLine on EVERY spawn):

- The inventory's P1 claim ("the `shortcuts` footer token is the live readiness
  signal") is FALSIFIED for production spawns at 2.1.252 — readiness currently
  survives on the `for agents` token alone (one alternation of
  `idlePromptModelHints`), and S2's "second independent match" (`/effort` line)
  is dead too. ONE reword of the agents affordance kills readiness silently —
  and 2.1.232 already churned that footer region (`/tasks` hint, `← N done`).
- Claude activity detection survives via spinner glyphs only; the
  `esc to interrupt` needle is dead under production spawns.
- DESIGN QUESTION (slice): Sonata authors the statusline content — the
  suppressor can become the replacement. A Sonata-authored, machine-readable
  beacon rendered at a fixed footer position turns the readiness scrape from
  "upstream's rewordable copy" into "Sonata's own protocol". Evaluate against
  hook-based readiness before committing.

## F5b — the readiness gap is the CHANNEL, not the tokens (q5, SL-2, DECISIVE)

F5's own conclusion ("readiness survives on the `for agents` token alone") is
too generous. Probe `q5-readiness-channel.mjs` (capture
`q5-readiness-channel.capture.txt`) put BOTH channels — the raw pty tail and the
reconstructed grid — through the SAME production function
(`detectIdlePromptForProvider` from `dist/`) at three sampling moments of one
production-shape session (`--permission-mode default --settings {statusLine}`).

| moment | RAW tail | GRID |
|---|---|---|
| boot idle (×3 samples) | ready, **medium** (`for agents` + mode line) | ready, **medium** |
| post-turn idle, 14 samples over 42s | ready, **low**, `hasModelOrCwdHint=false` | ready, **medium**, every sample |
| each of the 4 permission modes | — | ready, **medium** |

The post-turn raw `promptTail` is literally `"❯ "` (later `"❯ \nPlugin updated:
…"`). Not a wording problem — **there is no footer in the window at all**, so no
token, however many are added, can match. Cause: 2.1.252 paints inside the
ALTERNATE SCREEN (F3) and repaints DIFFERENTIALLY. The boot paint is
top-to-bottom, so the footer lands after the composer glyph in the stream (hence
boot idle reads medium); every later repaint emits the changed regions and then
homes the cursor to the composer, emitting a trailing `❯` with nothing after it.
The stream stopped preserving the screen's layout. The grid — which is what
`TaskScreenModel` already reconstructs — preserves it exactly.

So `detectIdlePrompt` is scraping a STATE ("is the idle footer on screen") off an
EVENT channel, which is precisely the channel-misuse D-1 names. Consequence
TODAY: with the SessionStart handshake alive, `checkCompletionHeuristic` may only
close a claude PROMPT run at MEDIUM confidence — that backstop (for the
silent-tool-stop gap, anthropics/claude-code#29881) is dead under production
spawns; the Stop hook is the only closer. Slash runs and hook-less sessions are
unaffected. `ready` itself is unharmed throughout (the composer glyph is last),
so delivery and the boot latch are fine.

THREE candidate fixes, now a real choice for the design session — the beacon is
no longer the only alternative:
1. **Grid-sourced confidence** — feed the `hasModelOrCwdHint` leg from
   `screenModel.viewportText()` while the ordering rule stays on the stream
   (D-1's own split). Cheapest; claude-only asymmetry (codex spawns
   `--no-alt-screen`, so its stream is unaffected); re-arms a medium path with a
   documented field-misfire history, so it needs its own judgement.
2. **Statusline beacon** — Sonata authors the suppressor, so it can author the
   signal. Still a scrape, still on the broken channel unless combined with (1).
3. **Hook-based readiness** — no scrape at all.

Registered, NOT taken. SL-2 landed only what is correct under all three: the
mode-line redundancy (it pays off in the grid channel, costs nothing in the
stream one), the retirement of the falsified in-code comment, and a smoke that
pins the gap so it cannot be forgotten.

## F6 — production idle footer, all four permission modes (q5 section C, MEASURED)

Shift+Tab walk under the statusLine spawn; all four reachable on this account:

```
⏸ manual mode on · ← for agents
⏵⏵ accept edits on (shift+tab to cycle) · ← for agents
⏸ plan mode on (shift+tab to cycle) · ← for agents
⏵⏵ auto mode on (shift+tab to cycle) · ← for agents
```

Every mode carries BOTH a glyph-anchored mode line and the agents affordance, so
readiness redundancy across the two is complete — the mode line is never absent
in any mode. (Also re-confirms the S2 cycle order and that `auto` is live on this
account.) These four lines are the MEASURED fixture the SL-2 smoke pins.

## F3b — fullscreen substrate audit (SL-2 objective 3)

**(a) `TaskScreenModel` reconstructs the alt-screen frame correctly at 2.1.252 —
verified against PRODUCTION code, not the spike driver.** The real pty stream of
a production-shape session (boot → trust walk → a live turn → post-turn idle;
`CSI ?1049h` present) replayed through `dist/runtime/terminal-host/task-screen-model`
yields a viewport carrying the composer row, the turn transcript
(`✻ Churned for 1s · done`) and the full production footer, with `? for
shortcuts` / `esc to interrupt` correctly absent. `buffer.active` follows the
alt-screen switch as its doc claims. Pinned as a smoke (`task-ready-detection`,
"TaskScreenModel reconstructs the 2.1.252 alt-screen idle frame") against the
tracked fixture `app/tests/fixtures/claude-idle/production-idle-2.1.252.raw.json`.
No substrate work needed.

**(b) MOUSE — Sonata forwards mouse events to the pty, and at 2.1.252 a click
ANSWERS an approval panel. INCIDENT-CLASS, report-only per the brief.**

Forwarding path (code, not inference):
- `app/src/renderer/terminal.ts:266` builds a stock `@xterm/xterm` Terminal for
  every task pane; nothing disables mouse handling.
- `app/src/renderer/terminal.ts:301-302` — `term.onData(...)` / `term.onBinary(...)`
  → `forwardUserInput(taskId, data)` → the pty. These are the ONLY user-input
  taps, and mouse reports arrive on them.
- `@xterm/xterm@6.0.0` `src/common/services/CoreMouseService.ts:324-331` —
  `triggerMouseEvent` encodes the report and calls
  `_coreService.triggerDataEvent(report, true)` (or `triggerBinaryEvent` for the
  DEFAULT encoding), i.e. the same channel as typing.
- `src/browser/CoreBrowserTerminal.ts:727-800` binds `mousemove`/`mouseup`/
  `wheel`/`mousedrag` from `coreMouseService.onProtocolChange` and always binds
  `mousedown`, so whatever tracking mode the CLI requests is what gets sent.

What the CLI does with them, MEASURED (`q7-mouse-reports.capture.txt`,
`q7b-mouse-approval.capture.txt`):

| surface | mouse tracking on? | hover | click |
|---|---|---|---|
| workspace-trust dialog | **no** (`?1000h`/`?1006h`/`?1049h` all absent — the trust screen paints on the NORMAL screen) | screen byte-identical | screen byte-identical, dialog not answered, no exit |
| idle composer (alt screen, `?1000h ?1002h ?1003h ?1006h` on) | yes | byte-identical | byte-identical; wheel and a click on `← for agents` too — **0 bytes** emitted by the CLI across the whole window |
| **live Write-approval panel** | yes | **moves the `❯` cursor to the hovered row** | **ANSWERS it** — `⎿ User rejected write to hello.txt`, panel dismissed, turn closed |

So: mouse input is inert at the composer and at the trust screen, and is a full
answering channel on an approval panel. A stray click in Sonata's Terminal pane
while a panel waits approves or denies a tool call; with `?1003h` (ANY-MOTION)
on, merely moving the pointer across the pane re-targets the selected row, which
is also the row a subsequent Enter would confirm. Sonata's own answer paths are
not currently defeated by this (the trust walk runs on a screen with no mouse
tracking at all, and panel option keys are absolute digits — 2.1.252's approval
rows still carry `1.`/`2.`/`3.`, unlike the trust rows), but the co-visible
Terminal is a live, mouse-answerable approval surface today.

NOT FIXED HERE — the brief scopes mouse to report-only and calls an actively
answering channel an incident, not a slice.

---

# SL-3 — claude BOOT-CEREMONY sweep (probed 2026-09-01, binary 2.1.257)

Binary re-pinned at probe start and again at the end: `2.1.257 (Claude Code)`
(the auto-update from 2.1.252 landed at 14:57, before this slice began; the
bundle's own `VERSION:"2.1.257"` string agrees). Probes `q8-boot-ceremony.mjs`,
`q9-fullscreen-offer-input.mjs`, `q10-image-smoke-claude-boot.mjs`. All three
drive a REAL `TerminalHost` from `dist/` with Sonata's own spawn args, because
the question is about SONATA's readiness, not the CLI's screen —
`acceptsPromptInput()` short-circuits on the SessionStart hook, which a bare
spike spawn never delivers, so a bare-spawn sweep could not see the interesting
failure at all.

## F7 — the measured boot catalog: ONE guardable interstitial, and it is not the trust dialog

Three arms, one variable (the config dir). Arm A is the field. Arms B/C copy
`~/.claude.json` + `settings.json` into a scratch `CLAUDE_CONFIG_DIR`
(`ptyEnvironment` strips every `CLAUDE_CODE_*` but deliberately KEEPS
`CLAUDE_CONFIG_DIR`) and re-arm one-time bookkeeping there. The real `~/.claude`
is never written.

| interstitial | appears? | screen side | input behaviour | guard action |
|---|---|---|---|---|
| workspace-trust dialog | **YES**, every fresh cwd, `t≈330ms` | NORMAL (before `?1049h`) | armed ≤500ms after paint; digits INERT; Enter answers the focused row | already handled (SL-1 walk); no new guard |
| **fullscreen-renderer offer** | **YES** when the account has not answered it (arm B, `t≈940ms`) | NORMAL — the alt-screen switch NEVER happens while it is open | printable keys DISCARDED (not buffered); **digits answer IMMEDIATELY, no Enter**; Enter answers the focused row | **NEW GUARD** — `claudeFullscreenOfferOpen` (F8) |
| release-notes / "Updated to latest" banner | **YES** (arm C, in the welcome block) | ALT screen, above a live composer | none — it is a banner, not a modal; `ready` true at 937ms | measured NO-OP; pinned as a negative in the smoke |
| "Fable 5.1 … Switch anytime with /model" tip | YES (arm B, same block) | NORMAL | none — a notice line | measured NO-OP |
| `Plugin updated: <name> · Run /reload-plugins` | YES, but MID-SESSION (q5 post-turn tail, SL-2) — not at boot | ALT | none — prints AFTER the composer `❯`, so it cannot invert the ordering rule | measured NO-OP |
| auto-mode default offer | **NOT SEEN** (arms A/B/C) | — | — | UNREPRODUCED — see the fidelity limit below; NOT guard-eligible |
| managed-settings approval prompt | **NOT SEEN** | — | — | measured NO-OP with a mechanism (below) |
| "Update installed · Restart to apply" | **NOT SEEN** in 90s past ready, ×3 arms | — | — | UNREPRODUCED (needs an update to land mid-run); NOT guard-eligible |
| usage-credits / Fable first-use prompt | **NOT SEEN** | — | — | UNREPRODUCED + account-gated; NOT guard-eligible |
| plugin-recommendation modal, API-spend notice, LSP suggestion | **NOT SEEN** | — | — | UNREPRODUCED; the plugin modal is command-triggered, not boot |
| login ceremony | **NOT SEEN** — and arms B/C are LOGGED OUT, so this is a real negative: a logged-out 2.1.257 boots straight to a working composer with a `Not logged in · Run /login` footer, no modal | ALT | — | out of scope (SL-x login) |

The production ceremony, MEASURED end to end (arm A,
`q8-boot-ceremony.production.capture.txt`): `task:started` 26ms → trust dialog
paints 336ms (NORMAL screen) → SL-1 walk answers 843ms → `?1049h` **1310ms** →
composer + `acceptsPromptInput()` true **1399ms** → `/rc` pill goes green 2161ms
→ the `◐ medium · /effort` line is erased when the statusline render lands
11459ms → **nothing changes for the remaining 90s**. So F3's "boots into the
alternate screen AFTER the trust grant" holds byte-for-byte at 2.1.257, and the
alt-screen switch is a reliable "the ceremony is over" marker.

**Composer input ARMING: there is none.** SL-1 measured a ≤500ms arming window
on the trust dialog (a Down at +0ms swallowed). The composer has no counterpart
— 9 characters written one at a time all echoed, first one within the 120ms
sampling floor, zero swallowed, in both arm A and arm C. Sonata's
`bootDeliveryGraceMs` is not load-bearing for claude at 2.1.257.

**Why the managed-settings prompt is a NO-OP here, with a mechanism rather than
an absence.** It needs a policy file, and this machine has neither
`/Library/Application Support/ClaudeCode/` nor `/etc/claude-code/`. It also
cannot be introduced through Sonata's spawn: the CLI reads an explicit path from
`CLAUDE_CODE_MANAGED_SETTINGS_PATH`, and `ptyEnvironment` deletes every
`CLAUDE_CODE_*` variable before spawning. A managed org COULD still deliver one
remotely — untestable on a personal Max account, so this is scoped to "not for
this account, on this machine", not "impossible".

**FIDELITY LIMIT of arms B/C — they are LOGGED OUT, and it is measured, not
assumed.** Credentials live in the macOS Keychain keyed to the DEFAULT config
dir: `CLAUDE_CONFIG_DIR=<copy> claude auth status --json` returns
`{"loggedIn":false,"authMethod":"none"}`, and the boot header duly reads
`API Usage Billing` instead of `Claude Max`. Client-side interstitials (the
renderer offer, the release-notes banner) are unaffected and their frames are
real. Anything ACCOUNT-GATED is NOT validly measured there — so the auto-mode
offer's and the credits prompt's NOT-SEEN in arms B/C is **not evidence of
absence**. Copying a live OAuth token to /private/tmp to close that gap was
considered and REJECTED: writing a credential to disk for a probe is not a
trade this slice should make, and UNREPRODUCED is the honest verdict.

**Why the renderer offer does not reproduce in arm A** (grep/config evidence,
hypothesis-grade): `~/.claude.json` has `fullscreenUpsellSeenCount: 3` and the
bundle's gate is `(fullscreenUpsellSeenCount ?? 0) >= l1e` with `l1e=3`, and
`~/.claude/settings.json` already records the taken answer as `tui: "fullscreen"`.
Arm B zeroes the counter and deletes that key; the offer paints. It is exhausted
for THIS account on THIS machine — not for a Sonata user whose claude has not
answered it yet, which is the population the guard is for.

## F8 — the fullscreen-renderer offer is a RED LINE: a delivery there destroys the prompt

The frame (MEASURED, `q9-fullscreen-offer-input.capture.txt` case B; the
tracked fixture `app/tests/fixtures/claude-boot/fullscreen-offer-2.1.257.txt`):

```
  Try the new fullscreen renderer?

  · Flicker-free output — fixes the flashing you see during long responses
  · Mouse support — click to move your cursor or expand results
  · Selected text auto-copies to your clipboard

  ❯ 1. Yes, try it
    2. Not now

  Enter to confirm · Esc to cancel
```

**(a) What a Sonata delivery does here** (case C — bracketed paste + submit CR,
byte-identical to what `DeliveryController` writes at an open boot latch):

- the paste is **DISCARDED** — screen byte-identical, the payload never appears;
- the CR answers the **focused** row, `1. Yes, try it`;
- the CLI switches renderer and **re-execs IN PLACE**: same pid (51619), argv
  rewritten `claude --permission-mode default --settings <p>` →
  `…/bin/claude.exe --settings <p> --permission-mode default`;
- the user's prompt is **GONE** — no text, no receipt, no error.

This is the codex silent-Yes lineage (2026-07-17 field hit) on the claude side,
with an unrequested configuration change on top.

**CHANGELOG HYPOTHESIS FALSIFIED**: "accepting restarts the process and DROPS
spawn flags". Both `--settings` and `--permission-mode` SURVIVED the re-exec
(reordered). The lost PROMPT is the harm, not lost flags.

**(b) It does NOT capture input invisibly** (case B). A printable `x` at the
offer leaves the screen byte-identical AND does not resurface in the composer
after the offer is answered. So a guard is SUFFICIENT — this screen does not
force the policy question the brief reserved for Woody. (The managed-settings
prompt, which the changelog describes that way, never appeared; if it ever does,
that question is still open.)

**(c) The digits are LIVE here — the opposite of the trust dialog.** `2` alone
answered "Not now" with no Enter (measured: 300ms later the composer was already
up, on the classic renderer). At the trust dialog a digit is inert. Two boot
modals in the same ceremony, opposite input grammars — which is precisely why
Sonata reads the grid instead of assuming a key.

**(d) Readiness held BEFORE this slice — incidentally, and that is the problem.**
`acceptsPromptInput()` reads false on the offer today because its footer is
spelled `Enter to confirm · Esc to cancel`, and both halves are already in
claude's needle list (`CLAUDE_WORKSPACE_TRUST_APPROVAL_HINTS` and
`CLAUDE_PANEL_END_MARKERS`), so `detectIdlePrompt`'s ordering rule finds an
"approval" after the `❯`. Nothing about that is a promise: tool panels ALREADY
dropped `Enter to confirm` once, at 2.1.17x, which is why those end markers
exist at all. Strip the footer from the measured frame and the scrape reads
`ready: true` on a modal whose Enter re-execs the CLI — pinned as a discriminating
case in `tests/smoke/claude-boot-interstitial.mjs`.

**(e) Why the guard is NOT `bootDialogHints`.** Codex's boot guard works by
ORDERING inside `detectIdlePrompt`: a needle only holds readiness when it paints
AFTER the composer glyph. Here the offer's identity paints BEFORE its `❯`;
everything after the cursor row is `2. Not now` (too generic to admit — it would
let assistant prose forge a hold) and the shared footer (already in the list
twice). The vocabulary structurally cannot carry this screen. The guard is
therefore a grid screen-owner predicate, `claudeFullscreenOfferOpen` →
`TerminalHost.isFullscreenOfferOpen()`, ranked with `isRewindPanelOpen()` ABOVE
the SessionStart short-circuit, recognizing the question AND the affirm row on
one frame (digit-agnostic, since 2.1.252 stripped the digits off the trust rows).

Ranked above the hook even though the offer is measured painting BEFORE
SessionStart (no hook arrived in 60s of it standing open): that ordering is
upstream's, not ours.

## F9 — `native-image-attachments.mjs`: the SL-1 residue claim was WRONG, and why nobody could see it

SL-1's commit recorded this file as failing because it "never answers the new
trust dialog — SL-3". **FALSIFIED, MEASURED** (`q10-image-smoke-claude-boot.mjs`,
which mirrors the smoke's `startHost("claude", …)` byte for byte): the smoke's
own `approval:detected` listener fires, `sendApprove()` runs SL-1's grid-verified
walk (`approval:decision decision=approve` at 1034ms), and the host reaches
`acceptsPromptInput()` at **1790ms**. The trust dialog has been answered here
since SL-1 landed.

What actually blocked the claude cases: the file ran **codex first** and printed
NOTHING until both providers finished. Codex's half at 0.152.0 fails slowly
(real model turns against 180s receipt waits), so the aggregate runner's
300s SIGKILL landed before claude ran at all — and because the file's only
output was a final JSON blob, the kill left an empty output block. The wrong
diagnosis was an inference from that silence, not a measurement.

Fixed by making the file stop hiding its own evidence: claude first, every case
error-isolated (a throw is a failed case, not a cancelled suite), and each
verdict printed as it lands. Codex's cases are untouched and still fail. With
that, **all five claude cases PASS** against 2.1.257.

## F8b — the guard hardened after review round 1 (forgery → one-way wedge)

Review round 1 found the first cut of `claudeFullscreenOfferOpen` too weak, and
the reasoning that had justified it was wrong in a way worth recording.

**The mistake.** The first cut was a co-occurrence of two substrings matched
anywhere in the compacted viewport (`trythenewfullscreenrenderer?` +
`yes,tryit`). I had assessed a false positive as low-consequence on the grounds
that the guard is pre-latch and prose cannot exist before the first prompt. That
argument does not survive **resumed sessions**: claude ≥2.1.186 repaints
transcript HISTORY at boot — which is the documented reason
`acceptsPromptInput()` has a hook short-circuit in the first place — so a
session that once displayed this screen (or a findings file quoting it, or a
paste) brings its exact wording back onto the grid before the latch opens. And
because the guard is ranked ABOVE that short-circuit, the hook can no longer
override it: `DeliveryController.bootLatched` is ONE-WAY, so a forged match
wedges the queue at "Queued" over a static screen for the life of the session,
with nothing left to clear it. That is a worse failure than the one the guard
prevents.

**The fix, and why it is not "more needles".** Three conditions now:

1. the QUESTION, line-scoped and anchored (`^trythenewfullscreenrenderer\?$`);
2. the AFFIRM ROW, line-scoped and anchored (`^❯?\d*\.?yes,tryit$`, still
   digit-agnostic);
3. **no permission mode line anywhere on the frame** — reusing
   `CLAUDE_MODE_LINE_ON_SCREEN_RE`.

(3) is the one that does the work, and it is structural rather than statistical.
The real offer paints BEFORE the session starts: no composer, and no permission
mode to display — MEASURED absent in every captured offer frame, and impossible
by construction. Every forgery in the class has a LIVE COMPOSER under it, and F6
measured that claude's composer footer carries a glyph-anchored mode line in ALL
FOUR modes, never absent. So the negative separates "the offer owns the screen"
from "the offer's words are on a screen the composer owns" — which is exactly
the question being asked.

**REJECTED — the reviewer's other suggested direction, a third BODY needle from
the feature bullets (`Flicker-free output` / `Mouse support`).** It points the
wrong way on the failure axis: every additional REQUIRED needle makes the guard
fire LESS, so one reworded marketing bullet fails it OPEN onto the modal whose
Enter destroys the prompt — the harmful direction, and bullets are the likeliest
copy to churn. It also does not close the forgery it was chosen for, since a
repaint or a paste of the frame carries the bullets too. Condition 3 costs
nothing on that axis (the real frame cannot have a mode line) and closes the
whole class rather than lowering its probability.

All three new negatives DISCRIMINATE: reverting to the two-substring signature
and rebuilding fails exactly `prose QUOTING the question inline`, `a RESUMED
SESSION repainting the offer verbatim`, and `the mode-line negative holds in
EVERY permission mode`. Signature restored; 19/19 green.

KNOWN BOUNDARY (accepted, documented in code): the anchored question line
assumes the offer's line does not wrap — true for any viewport ≳34 columns. Below
that the guard reads closed, the same viewport-too-narrow boundary
`isCodexTrustDialog` already documents.

## F9b — the image smoke's failure path leaked a pty and a timer

Also review round 1. The per-case isolation added in F9 turned a `startHost`
throw (readiness timeout, or a CLI that exited) into a failed case and kept
going — but `startHost` had no failure-path cleanup, so the live pty and the
`ProviderTranscript` discovery `setInterval` (not `unref`'d; only `dispose()`
clears it) survived the throw. The file would print its report and then hang
instead of exiting. Latent before the isolation change; load-bearing after it.

Fixed by disposing host/transcript/delivery on the failure path and rethrowing,
rather than ending the file with an explicit `process.exit` — an explicit exit
would have masked the next leak of this class as well as this one.

---

# SL-2b — claude HOOK COVERAGE for turn completion (probed 2026-09-01, binary 2.1.257)

Binary pinned `2.1.257 (Claude Code)` at every probe start AND at every probe
end (the probe aborts on drift). Probe `q11-hook-coverage.mjs`, capture
`q11-hook-coverage.capture.txt`. Eight arms, each its own real session driven
through a REAL `TerminalHost` from `dist/` with Sonata's own spawn args, plus the
production `HookWatcher` and the four completion-path dispatch edges
`RuntimeController.handleHookPayload` applies (`SessionStart` →
`noteHookSessionStart`, `UserPromptSubmit` → `beginRunFromHook`, `Stop` /
`StopFailure` → `completeRunFromTurnEnd`). Without that plumbing the gate under
test (`heuristicMayClose`) is never in its production shape at all, which is why
a bare-spawn sweep could not have answered this.

Deviation from production, deliberate and bounded: every arm spawns
`approvalBroker:false` (native-approval mode), because broker-ON suppresses the
grid approval scrape outright (`nativeApprovalSurfaceSuppressed`) and the probe
needs it to answer the trust dialog and to see the deny panel. The completion
path under test is broker-independent.

## F10 — the coverage matrix (MEASURED, decisive)

| # | scenario | hooks observed | turn actually over? | run closed? |
|---|---|---|---|---|
| s1 | normal turn end | SessionStart, UserPromptSubmit, **Stop**, (Notification `idle_prompt` at +60s) | yes | yes — `hook-stop` / high, 1.9s |
| s2 | turn whose TOOL failed (Read on a missing path) | +PreToolUse, **PostToolUseFailure**, Stop, SubagentStop | yes | yes — `hook-stop` / high |
| s7 | 91-second FOREGROUND tool call | +PermissionRequest, PostToolUse, **Stop** | yes, after 91s | yes — `hook-stop` / high, and **never closed early** |
| s5 | CLI self-exit (`/exit`) | Stop, then **SessionEnd** (`reason:"prompt_input_exit"`) | yes | yes — `hook-stop` |
| s4 | pty SIGKILLed mid-turn | none after the kill (a dead process fires nothing) | n/a | yes — Sonata's own `pty-exit` / high |
| **s3** | **user Esc mid-turn** (co-visible Terminal) | **NONE** | **yes** (`⎿ Interrupted · What should Claude do instead?`) | **NO — `active` for the full 108s watch** |
| **s6** | **user DENIES a tool** on the CLI's native panel | PreToolUse, PermissionRequest, then **nothing** | **yes** (`⎿ User rejected write…`, `✻ Crunched for 2s · done`) | yes, but **by luck** — `terminal-idle-heuristic` / medium |

So: **`Stop` covers every turn that ends by the model finishing, tool error
included, and a 91-second tool call does not fool anything.** The residual gap is
exactly the two ways a turn ends WITHOUT the model finishing it — a user
interrupt and a user denial. Both are ordinary, daily user actions.

## F11 — the gap is not closable by wiring another hook (three measured negatives)

2.1.257's bundle declares 33 hook events (`var Hh=[…]`, extracted from
`bin/claude.exe`); Sonata injects 8 + `PermissionRequest`. The probe INJECTED the
three completion-relevant unwired ones into the settings file the production
writer had just written (never overriding a production entry, same sink command,
same spawn shape) and measured them:

- **`SessionEnd` DOES fire** under our `--settings` injection — `reason:
  "prompt_input_exit"` on `/exit`, ~300ms before the pty dies. Its reason enum in
  the bundle is `clear|resume|logout|prompt_input_exit|other`, i.e. it is a
  SESSION teardown event, not a turn event. It cannot close a turn. (It answers
  the standing "known, not wired" question in `cli-signal.ts` for claude: the
  event is real and reachable; it is simply not this slice's signal.)
- **`PostToolUseFailure` fires INSTEAD of `PostToolUse`** when a tool errors (s2:
  `PreToolUse(Read)` → `PostToolUseFailure(Read)` with `error: "File does not
  exist…"`, no `PostToolUse`). Consequence for the code as it stands:
  `recordToolChangesFromHook` never sees a FAILED tool — which is correct (a
  failed tool changed nothing), so this is documentation, not a bug. Registered
  for SL-9.
- **`PermissionDenied` does NOT fire** for a native-UI denial (s6: injected, and
  absent). Whatever it is for, it is not the user pressing "No" on the panel.

And the one that looked most promising:

- **`Notification(idle_prompt)` DOES fire at 2.1.257** — `message: "Claude is
  waiting for your input"`, twice measured at Stop+60.2s and Stop+60.1s. This
  **falsifies the Phase-0 note** carried in `cli-signal.ts` ("`Notification(idle_
  prompt|permission_prompt)` does NOT fire" — true at 2.1.177). The bundle's
  default `messageIdleNotifThresholdMs` is 60000, which matches. It is ALREADY in
  `INJECTED_HOOK_EVENTS`, so it costs nothing to receive.
  **But it is not a backstop**: it is anchored on the same turn-end that `Stop`
  is. In the 100 seconds following the Esc (s3) and following the deny (s6) it
  NEVER arrived. A signal that only fires when Stop fired adds zero coverage.

## F12 — the medium-confidence gate is a COIN FLIP at 2.1.257, and the grid cannot replace it

F5b concluded the medium gate was simply DEAD under production spawns. Half
right. It is dead when the alt-screen differential repaint leaves the post-turn
promptTail as a bare `"❯ "` (s1, s3 — `confidence=low`), and ALIVE when the
repaint happens to re-emit the footer after the composer glyph (s6, after a deny
— `confidence=medium`, which is the only reason that arm closed at all, 3.5s in).
Nothing about the turn distinguishes the two. Repaint order does.

F5b's candidate fix #1 — "feed the `hasModelOrCwdHint` leg from the grid" — is
**FALSIFIED by s7**. Over 18 samples spanning a genuinely live 91-second
foreground tool call:

```
   run=active  stream=F/low  grid=T/medium  runRawComp=F/low  gridComp=T/medium   ×18
```

The idle footer (`⏸ manual mode on · ← for agents`) is PERMANENT CHROME at
2.1.257 — on screen while busy exactly as at idle. So a grid-fed confidence leg
would read `medium` throughout a live turn: not a stricter gate, a VACUOUS one.
Worse, a grid-fed `detectIdleComposer` reads `completed=true` throughout (the
composer is the bottom row of any frame, so "prompt after activity" is trivially
true on a grid — the ordering rule is a STREAM rule and means nothing on a
screen). Either grid swap would have re-armed the premature-completion class.

The leg that actually works is the one on the run's OWN bytes: `runRawComp` read
`completed=false` for all 91 seconds of the live turn, and `completed=true`
immediately after the Esc. That is an EVENT question on the EVENT channel, and it
is doing the real work.

## F13 — what shipped: the Stop-less turn-end backstop

`stoplessTurnEndConfirmed` (terminal-host.ts) — claude-only, hooks-alive,
prompt-runs-only, ADDED beside the untouched medium gate. The brief's first
branch ("where the matrix shows coverage, RETIRE the medium backstop") turned out
to have no target: the medium arm never fires for a turn the hooks cover — those
close on `Stop` at HIGH confidence in ~2s and never reach the heuristic's closing
branch at all. Every measured medium close was itself a STOP-LESS ending (s6,
3.5s). So the medium arm lives entirely INSIDE the gap, where retiring it removes
coverage rather than a lie — and it is the safer of the two arms (the stream
reached medium in 0 of 18 samples of a live turn). Kept, unchanged, and the
second arm added beneath it.

The new arm carries three terms, each on the channel that can answer it:

1. EVENT (stream, the existing `idleVerdict`) — did THIS RUN's bytes go activity
   → composer? The term F12 shows carries the weight.
2. STATE (grid) — is a real composer on screen right now with NOTHING owning it?
   `detectIdlePrompt` reads a panel frame as not-ready (its end markers outrank
   the row cursor), so this is the term that refuses to call an approval/option
   panel "done". Deliberately the grid's READY, never its CONFIDENCE — F12.
3. TIME — has 1+2 held continuously for 30s? An order of magnitude past the one
   documented misfire shape (a post-submit stall with a ≥1.75s printable-quiet
   window on a live run, claude 2.1.211, 5 field misfires), and past Sonata's 20s
   liveness rung, so a run reaching the window has already surfaced honestly as
   "still working" first.

Verified LIVE, before and after, on the same gap (arms s3 and s8, identical but
for the `dist/` they ran against):

```
s3 (before)  Esc at  9.0s → run `active` at every one of 56 judge passes, 108s watch
s8 (after)   Esc at  9.6s → run completed at +32.5s   (re-run against the FINAL
             build after the data-fresh reset landed: +32.5s again)
             statusReason "sustained idle composer (Stop-less turn end)"
             completionSource terminal-idle-heuristic, confidence low
```

s1 re-run against the fixed build still closes on the hook at 1.9s
(`hook-stop`/high) — the covered path never reaches the window.

RESIDUAL RISK, stated rather than hidden. The arm admits a close on the ABSENCE
of liveness evidence, not on positive proof the turn ended — so the 2.1.211
field-misfire shape (a post-submit stall reading composer-after-activity at LOW
confidence) becomes closable IF that stall stays printable-SILENT for 30
continuous seconds. Two things bound it:

- every printable chunk re-schedules the completion judge, so output arriving
  faster than `completionQuietMs` means the judge never runs and the window
  cannot even begin (pinned in `stop-hook-completion.mjs`);
- a live claude turn at 2.1.257 renders an ANIMATED spinner with a running
  elapsed/token counter — measured repainting ~every second across the whole
  91-second tool call (s7) — so a printable-silent live turn is structurally hard
  to produce. This is the load-bearing assumption and it rests on ONE measured
  live-turn arm; it is stated in the code, and the cost is pinned as a TEST
  ("SL-2b trade-off: the field-stall frame IS closable once the window elapses")
  rather than left as a surprise.

REGISTERED REFINEMENT, deliberately not built. If that risk ever materialises,
the fix is to require POSITIVE turn-end evidence on the grid instead of absence
of liveness. 2.1.257 paints one at every ending, MEASURED under the production
statusLine spawn:

| ending | marker painted |
|---|---|
| model finished (s1/s2/s5/s7) | `✻ <verb> for Ns · done <time>` |
| tool denied (s6) | `⎿  User rejected write to hello.txt` + `✻ Crunched for 2s · done` |
| user Esc (s3) | `⎿  Interrupted · What should Claude do instead?` |

Not built now because it is upstream COPY, and the right time to spend fragility
is on evidence, not speculation. Its failure mode is the safe one: a reword stops
the close (reverting to today's wedge), it cannot manufacture one.

## F13b — review round 1: the TIME term was measuring the wrong thing (BLOCKING, fixed)

The first version of `stoplessTurnEndConfirmed` had ONE time term — "a judge pass
read the run idle, and that was >= 30s ago" — and it did not mean what it said.

MECHANISM (verified in the code, not inferred). Every printable chunk does two
things in `handlePtyData`: stamps `lastPrintablePtyDataAt`, and calls
`scheduleCompletionCheck`, which CLEARS the timer and re-arms at
`now + completionQuietMs`. So the completion judge can only ever fire at or after
`lastPrintablePtyDataAt + completionQuietMs`. Two consequences:

1. The `data-fresh` guard is false at every fire instant, so the "fresh printable
   output resets the window" branch I had added there was DEAD CODE wearing a
   safety comment.
2. Far worse: during dense output NO judge pass runs at all, so nothing on the
   run side observes the output. `sustainedIdleVerdict.since` therefore survived
   an arbitrarily long live stretch, and the term measured WALL-CLOCK SINCE
   ARMING rather than continuous idleness.

Exposure beyond the trade-off I had pinned — three shapes, all live turns:
(A) an early post-submit stall arms the window, the turn then streams for a
minute, and the next >=1.8s pause closes it; (B) the judge's approval guard-exit
returns BEFORE any bookkeeping, so an entire approval episode is invisible to the
window — arm early, panel up two minutes, approve, tool runs, first quiet moment
closes mid-turn; (C) an Esc-with-queued-message repaint against an armed window.
The harm chain is unattenuated: `task:ready` fires regardless of LOW confidence,
so queued delivery lands into a live turn.

FIX — both halves, because they answer different questions:

- TIME (a), the load-bearing one: `now - lastPrintablePtyDataAt >= confirmMs` —
  the STREAM itself must have been printable-silent for the whole window. Stated
  on raw timestamps and on nothing else, so no future change to how the judge is
  scheduled can defeat it. It also covers shape (B) with no approval-specific
  code, because a panel PAINTS and its paint is printable.
- TIME (b), unchanged in spirit but now honest: `since` restarts whenever
  `lastPrintablePtyDataAt > since`, so a field named `sustainedIdleVerdict`
  actually means sustained.

The dead data-fresh reset was REMOVED and replaced by a note recording why a
reset cannot live there, so it is not re-added by someone reading the old comment.

REGRESSION COVERAGE — the review's point was that the existing tests proved the
window cannot BEGIN under output, never that it RESTARTS. Two new checks in
`stop-hook-completion.mjs`, both verified to FAIL against the pre-fix code and
pass after (the fix was reverted in-tree, rebuilt, and re-run to prove it):

| check | pre-fix | post-fix |
|---|---|---|
| a window armed before a live stream cannot close on the first pause after it | FAIL | ok |
| an aged run-side window cannot close while the STREAM is still noisy | FAIL | ok |
| SL-2b trade-off pin (field-stall frame IS closable after the window) | ok | ok |

The first construction I wrote for the behavioural check PASSED against the
pre-fix code — the margins made it a coin flip. Rebuilt around the actual
mechanism: the streaming stretch must be DENSER than `completionQuietMs`, because
the silence of the judge (not the output) is what froze the clock.

LIVE RE-VERIFICATION against the rebuilt dist — the new silence term could have
delayed or prevented the close it exists to allow, so it was re-measured, not
argued:

```
s8  CLOSED 32519ms after Esc — sustained idle composer (Stop-less turn end) / low
    (three consecutive runs: 32532 / 32509 / 32519ms)
s1  completed at 6327ms — stop hook (turn ended) / hook-stop / high
    idle Notification again at +60.1s
```

That the post-Esc stream satisfies a 30s printable-SILENCE requirement is itself
new evidence for F13's load-bearing premise: an ended turn stops painting, a live
one does not.

## F14 — statusLine sink: the EMPTY footer row is BY DESIGN (SL-3 register item, closed)

SL-3 (q8) observed Sonata's injected statusLine row rendering EMPTY in production
boot frames and registered it as unverified. Verified: `claude-statusline-sink.ts`
reads the payload on stdin, writes it to `<runtimeDir>/usage/claude-<session>.json`
via tmp+rename, and **writes nothing to stdout**. Claude renders whatever the
statusLine command prints, so an empty stdout renders an empty row. Sonata uses
the statusLine hook purely as a USAGE PAYLOAD SOURCE, never to paint.

No usage-parsing bug: the 2.1.257 payload captured live in this probe's own
runtime dir carries every field `usage-adapters.ts` reads —
`context_window.{used_percentage,context_window_size,current_usage.*}`,
`cost.total_cost_usd`, `rate_limits.{five_hour,seven_day}.{used_percentage,resets_at}`,
`model.display_name`. No code change. (Side note for the parked statusline-beacon
idea: the row IS Sonata's to author — but F12 is the reason a beacon would not
have helped here, since the footer's PRESENCE is not evidence of idleness.)

---

# SL-4 — claude `/model` PICKER, switch RECEIPTS, per-model EFFORT (probed 2026-09-01, binary 2.1.258)

Binary pinned at every probe start AND end. **The binary MOVED mid-slice**:
q12/q13 were first run at `2.1.257`, and the auto-updater landed `2.1.258` during
q14's first run. Everything below is the RE-RUN at `2.1.258`; the 2.1.257 pass is
mentioned only where the two agree (they agree everywhere they overlap — the
picker frame is identical row-for-row).

Probes: `q12-model-picker.mjs` (picker walk, READ-ONLY — every visit ends in Esc),
`q13-switch-receipts.mjs` (receipts + per-model effort), `q14-receipt-window.mjs`
(the production receipt-window replay), `q15-fast-mode-1m.mjs` (fast mode on the
1M Opus), `q16-effort-levels.mjs` (the effort tier set). Captures alongside each.

**User-state fence.** `/model x` rewrites the user's GLOBAL default model, and
there is no isolated-config alternative (SL-3 measured that a non-default
`CLAUDE_CONFIG_DIR` boots LOGGED OUT — Keychain creds are keyed to the default
dir, and a logged-out CLI has no model list). Every mutating probe therefore
snapshots `~/.claude/settings.json` up front and restores its bytes after the pty
is dead; q12/q15 assert it never changed at all. All four report the round trip.
`~/.claude.json` is deliberately NOT restored — a probe's own trust grant and the
startup counters legitimately live there.

## F15 — the live `/model` picker at 2.1.258 (q12, MEASURED, read-only)

Five rows, this account, identical at every height and at both binaries:

```
   Select model
   Switch between Claude models. Your pick becomes the default for new sessions. For other/previous model names,
   specify with --model.

     1. Default (recommended)  Opus 5 with 1M context · Best for everyday, complex tasks
   ❯ 2. Opus (1M context) ✔    Opus 5 with 1M context · Best for everyday, complex tasks
     3. Fable                  Fable 5.1 · Most capable for your hardest and longest-running tasks
     4. Sonnet                 Sonnet 5 · Efficient for routine tasks
     5. Haiku                  Haiku 4.5 · Fastest for quick answers

   ◐ Medium effort ←/→ to adjust

   Enter to set as default · s to use this session only · Esc to cancel
```

- **Footer keys CONFIRMED unchanged**: `Enter` = switch + save as default,
  `s` = session only, `Esc` = cancel.
- **Marker semantics.** TWO independent marks, and the changelog's "highlight
  moved to the newest model only" is about the SECOND, not the first:
  `✔` + green `rgb(78,186,101)` on the row LABEL marks the **current** model;
  a terracotta `rgb(215,119,87)` on the DESCRIPTION's model name (`Fable 5.1`)
  marks the **newest** — no other row's description is coloured. The `❯` cursor
  is separate again and carries the focus.
- **No Ultracode row.** Ultracode exists at 2.1.258, but as an EFFORT TIER
  (F17), not a model.
- **`◐ Medium effort ←/→ to adjust`** is part of the picker: effort is adjustable
  in place with the horizontal arrows.
- Esc leaves a transcript receipt: `⎿ Kept model as Opus 5 (1M context)` — the
  same string `claudeCacheMissCancelled` keys on, now also produced by a plain
  picker cancel. Harmless (it can only be read while a switch is pending), but
  recorded so a future reader does not assume the phrase is dialog-exclusive.

### Height clipping and the arrow-walk (the SL-4 objective-1 question)

| pty rows | rows shown | overflow marker | walk reached |
|---|---|---|---|
| 40 | all 5 | — | 5/5, wraps |
| 36 (Sonata's `DEFAULT_ROWS`) | all 5 | — | 5/5, wraps |
| 24 | 3 (`↓ 3. Fable` last) | `… +2 models` | 5/5, wraps |
| 16 | 2 | `… +3 models` | 5/5, wraps |

So the picker IS height-clipped and scrollable, with an explicit `… +N models`
marker — and **the clipping never hides a row from a Down-walk**: at 16 rows,
where only two are visible, the walk still visits all five and wraps back to the
first. Nothing Sonata's UI offers becomes unreachable.

**No arming window on this surface.** Three Downs sent at 300ms / 60ms / 0ms
spacing all land exactly three rows down (`Opus (1M context)` → `Haiku`), picker
still open. Unlike the trust dialog (SL-1's F1b), the picker swallows nothing —
so `OPTION_PROMPT_KEY_DELAY_MS`-style pacing is not needed here and cannot
overshoot. (Sonata does not drive this picker at all — claude model/effort
switching is the ARG form. The measurement exists so that the option stays open
and so the UI's rows are known-reachable.)

## F16 — the switch receipts at 2.1.258 (q13, MEASURED)

Alias → what the CLI printed and what the statusline mirror then reported:

| `/model <alias>` | receipt | `model.display_name` | `model.id` |
|---|---|---|---|
| `sonnet` | `⎿ Set model to Sonnet 5 and saved as your default for new sessions` | Sonnet 5 | claude-sonnet-5 |
| `opus` | `⎿ Set model to Opus 5 and saved as your default for new sessions` | Opus 5 | claude-opus-5 |
| `opus[1m]` | `⎿ Set model to Opus 5 (1M context) and saved as your default for new sessions` | Opus 5 (1M context) | claude-opus-5[1m] |
| `fable` | `⎿ Set model to Fable 5.1 and saved as your default for new sessions` | **Fable 5.1** | claude-fable-5-1 |
| `haiku` | `⎿ Set model to Haiku 4.5 and saved as your default for new sessions` | Haiku 4.5 | claude-haiku-4-5-20251001 |
| `bogus-model-xyz` | `⎿ Model 'bogus-model-xyz' not found` | (unchanged) | — |

Picker-form receipts (both NEW shapes, both still carrying `Set model to`):
- Enter on `Default (recommended)` → `⎿ Set model to Opus 5 (1M context) (default) and saved as your default for new sessions`, and `settings.json`'s `model` key is **REMOVED** (the row clears the pin).
- `s` on a row → `⎿ Set model to Opus 5 (1M context) for this session only` — no default tail at all.

**Two Sonata couplings were WRONG before this slice**, both in the LABELS, which
`sessionModelValue()` uses to map the live `display_name` back to an alias:
- `Fable 5` should be **`Fable 5.1`**;
- `opus[1m]` / **`Opus 5 (1M context)` was missing entirely** — and it is this
  account's default and the picker's only Opus row, so while a session ran on it
  the session menu marked NO current model (the label matched nothing and the
  code fell back to the spawn model).

**The `[1m]` alias round-trips through the slash form** — `/model opus[1m]` is
accepted verbatim and yields `claude-opus-5[1m]`.

**Cache-miss confirm dialog: ALIVE at 2.1.258, and q13 alone would have said
otherwise.** q13's arm D — one real turn whose whole content was `ok`, then
`/model opus` — applied DIRECTLY with a clean receipt and
`claudeCacheMissDialogOpen` false. The `midsession-switch` real-CLI e2e, run on
the same binary an hour later, raised the dialog on its FIRST switch with the
verbatim `Yes, switch to <model>` / `No, go back` rows and relayed it through the
drawer, exactly as the S7 parser expects. The difference is the size of the
history being re-read: a one-token turn is evidently not worth warning about.
Recorded as a method lesson as much as a fact — "I probed it once and it did not
appear" is not evidence a dialog is gone, and had q13 been the only witness this
slice could have argued for retiring a live RED-LINE relay. The S7 parked relay
is untouched and its recognizer still matches the live rows.

## F17 — the effort tier set, and the models that have no effort axis (q16, MEASURED)

All five tiers Sonata offers work and are mirrored back:

| `/effort <tier>` | receipt | banner | mirror |
|---|---|---|---|
| low / medium / high / xhigh | `⎿ Set effort level to <t> (saved as your default for new sessions): <description>` | `Sonnet 5 with <t> effort` | `<t>` |
| max | `⎿ Set effort level to max (this session only): …` | `… with max effort` | `max` |
| **ultracode** | `⎿ Set effort level to ultracode (this session only): xhigh + dynamic workflow orchestration` | `… with **xhigh** effort` | **`xhigh`** |
| **auto** | `⎿ Effort level set to auto` (a DIFFERENT shape) | effort segment **absent** | the resolved level (`high`) |
| bogus | `⎿ Invalid argument: bogus-tier. Valid options are: low, medium, high, xhigh, max, ultracode, auto` | unchanged | unchanged |

Three consequences:
1. **A `/effort` FAILURE receipt exists.** The parser's standing comment said one
   was unreachable "because its levels come from a curated list" — that argument
   only ever covered the values Sonata sends, and the receipt is real. Before this
   slice an unrecognised tier sat pending for the full timeout instead of failing.
2. **`ultracode` is not menu-able**: it reports back as `xhigh`, so a staged menu
   comparing staged-vs-mirror would be permanently dirty. **`auto` is not
   menu-able**: its receipt shape is unrecognised AND its value is per-turn.
3. **Haiku has NO effort axis at all.** `--effort xhigh`/`--effort high` at LAUNCH
   are accepted silently, the banner prints `Haiku 4.5 · Claude Max` with no
   effort segment, and the statusline payload omits `effort` entirely. `/effort
   high` mid-session on Haiku still prints a success receipt — so "the CLI
   accepted it" is not evidence the model has the axis.

## F18 — native fast mode DOES apply to `opus[1m]` (q15, MEASURED, with a negative control)

Fast mode has no flag and prints no receipt (it rides in the injected `--settings`
as `fastMode: true`), so the four arms are compared on the boot frame:

| arm | `--model` | fastMode | boot frame says |
|---|---|---|---|
| F1 | `opus` | yes | `Fast mode requires usage credits · /usage-credits to turn them on` |
| F2 | `opus[1m]` | yes | **the same line** |
| F3 | `opus[1m]` | no | (no such line) |
| F4 | `haiku` | yes | (no such line — silently ignored) |

F1 ≡ F2, F3 is the baseline, F4 is what "ignored" looks like. So `opus[1m]`
accepts the injection exactly as plain Opus does and belongs in
`CLAUDE_FAST_MODELS`. Incidentally measured: this account cannot ACTIVATE fast
mode (no usage credits) — an entitlement, not a model gate, and identical on the
model already in the set. It also retires the old comment's admission that the
non-Opus behaviour was unverified: it is a silent no-op.

## F19 — the receipt window mis-fires on a repainting transcript (q13/q14, DECISIVE — this is what shipped)

Since 2.1.252 claude renders in the alternate screen, and **a switch that
reshapes the banner forces a FULL TRANSCRIPT REDRAW** — so every receipt the
session ever printed re-enters the pty stream, inside the window
`detectControlSwitchReceipt` opened for the CURRENT switch.

MEASURED at production's exact arming point (one pty write for the command, arm,
`\r` 120ms later, rolling 4096-char window, ONE chunk at a time, first verdict
wins — q13 arm B4): **`/model haiku` SUCCEEDED** — its own receipt printed and
the mirror moved to `Haiku 4.5` — **and the engine emitted `failed`**, because
the redraw carried this session's earlier `Model 'bogus-model-xyz' not found`
into the window. Sonata would have told the user Claude rejected a model it had
just accepted. The verbatim window is pinned as
`tests/fixtures/claude-midsession/stale-failure-repaint-2.1.258.txt`.

WHY q14's first ladder looked clean, and why that mattered. q14 ran nine
production-armed switches after the same poison and every one was correct — the
redraw simply did not fire on those transitions. The hazard is therefore
INTERMITTENT and transition-dependent (Haiku's banner loses its effort segment,
which reshapes the layout), which is exactly why "we ran it nine times and it was
fine" is not evidence of soundness here. q14's second ladder (`early` arming, the
same session) reproduces it deterministically: 2 of 3 switches read `failed` at
12–16ms, before the command was even submitted.

**Shipped**: the FAILURE needles are anchored on the value the pending switch
asked for (`Model '<value>' not found`, `Invalid argument: <value>.`), and the
value is escaped for regex — `opus[1m]` is a real alias whose brackets would
otherwise be a character class. Both call sites pass `pending.value`. Verified
A/B: the new pins FAIL against the pre-fix build (the fix reverted in-tree,
rebuilt, re-run) and pass after.

**RESIDUAL, pinned honestly rather than hidden** (q13 arm B5, fixture
`stale-success-repaint-2.1.258.txt`): a repaint of an older `Set model to …` can
still settle a switch a beat early — measured settling on chunk 3, on a window
whose only success line was a repaint. The success needle CANNOT be anchored the
same way: the receipt names the model's DISPLAY name, not the alias, so anchoring
it would mean trusting the very label table this sync had to correct, and it
would fail CLOSED into needs-attention on every upstream rename — worse than what
it fixes. The harm is also of the opposite kind: the switch does complete, the
statusline mirror (not this scrape) is the state SSOT, and the early settle only
releases the pending affordance sooner. The structural fix is to confirm a switch
against the MIRROR rather than the stream (D-1: "did the model change" is a STATE
query) — a redesign of the choreography, registered rather than taken here.

## F20 — per-model effort memory: FALSIFIED at the mirror (q13 ladder B)

The changelog's 2.1.251 "per-model effort" does not show up as per-model memory
in anything Sonata reads. The decisive step is B2:

| step | action | mirror `display_name` / `effort` |
|---|---|---|
| A1/A2 | `/model sonnet`, `/effort low` | Sonnet 5 / low |
| A4–A7 | `/model opus`, `opus[1m]`, `fable`, `haiku` | …, Haiku 4.5 / **null** |
| B1 | `/effort high` (while on haiku) | Haiku 4.5 / null |
| **B2** | `/model sonnet` | Sonnet 5 / **high** |
| B3 | `/effort low` | Sonnet 5 / low |
| B4 | `/model haiku` | Haiku 4.5 / **null** |
| B5 | `/model sonnet` | Sonnet 5 / low |

B2 is the falsification: sonnet's own last-set effort was `low` (A2), yet
switching back to sonnet reported `high` — the level set while on HAIKU. Effort
therefore CARRIES ACROSS a model switch; it is not remembered per model. The
`null`s at Haiku are F17's no-effort-axis fact, not a memory.

**Sonata's mirror is NOT stale.** The statusline payload follows every switch on
the next tick, on both axes, in both directions — no code change needed. The one
imperfection is a consequence of F17, not of staleness: on Haiku the payload
carries no effort, `sessionEffortValue` falls back to `task.reasoningEffort`, and
the menu marks a level the model does not have. Registered (below), not fixed:
making the effort axis genuinely OPTIONAL is a `ReasoningEffort | null` change
running through draft seeding, `claudeArgs`, the task record and three menus, and
`reasoningEffortForModel`'s "clamp to xhigh" fallback has no meaning for a model
with no tiers at all. Measured functional harm today: none (the CLI ignores
`--effort` on Haiku either way).

Also recorded: `settings.json`'s `effortLevel` did NOT move for any `/effort`
command even though the receipts say "saved as your default for new sessions",
and no per-model effort key appeared in `~/.claude.json` (its only effort keys
stayed `unpinOpus47/48LaunchEffort`, `unpinFable5LaunchEffort`). Where the CLI
persists the effort default at 2.1.258 is unlocated — noted, not chased.

## F21 — the `midsession-switch` real-CLI e2e: PRE-EXISTING RED, UNAFFECTED by the fix

The e2e that owns this surface does not pass in this environment, before OR after
the change. It was A/B'd rather than assumed. **The first write-up of this
finding claimed the fix IMPROVED it. That claim was wrong and is retracted here**
— it is recorded rather than deleted, because the reasoning error is the useful
part.

| build | how far it got |
|---|---|
| **PRE-FIX** (HEAD sources, e2e's old label list) | fails at line 250 — a `control-switch` attention banner was visible although `chipText` already read `Sonnet 5 Low` |
| **POST-FIX** | fails at line 278 — the Reasoning section did not mark `Low` as current inside its 20s poll |

WHY THE "IMPROVED" READING WAS WRONG. I saw a needs-attention banner on the
pre-fix run, saw that both legs had applied, and read it as F19's false-`failed`
reaching a live session. The code says otherwise, in two places:

- a `failed` verdict **never raises that banner**. `runtime-reducer.ts` sets
  `view.controlSwitch = null` on `phase === "failed"` and reports a one-line
  composer status; `banners.ts` gates the `control-switch` attention banner
  strictly on `phase === "needs-attention"`, which only the TIMEOUT paths emit.
  So the pre-fix banner was a timeout, and no change to the failure needle could
  have removed it.
- and the needle could not have fired at all: **this e2e never injects an invalid
  alias**, so no `Model '<x>' not found` line exists anywhere in its stream. Old
  and new needles therefore return IDENTICAL verdicts for every window it
  produces. The fix is inert in this test by construction.

The two runs' different stopping points are the test's own instability, not a
behavioural delta. The lesson is the one this slice kept re-learning: a plausible
causal story that fits the observation is not evidence — the reducer and the
banner selector were three greps away, and they falsified it.

GROUND TRUTH ON EVERY RUN, read straight out of the live session's statusline
payload while the test was still up: `{"model":{"id":"claude-sonnet-5"},
"effort":{"level":"low"}}` — **both staged legs applied CLI-side, on both builds.**
The choreography works against 2.1.258; what is unresolved is the e2e's final UI
poll (a plausible mechanism, NOT verified — and after the above, "plausible" is
worth exactly nothing until someone checks it: the chip is disabled while the
second leg is still pending, so the poll's `chip.click()` may not be able to
reopen the menu, and it reads an empty label until it gives up).

Environment note, which is why this was not chased further: **two of the four
post-fix runs WEDGED** — 13+ minutes with an empty log and no assertion reached,
killed by hand — while the session's own state showed the full flow had run. The
test is unstable here independently of the change, so more repetitions would not
have produced a cleaner answer. Registered for whoever owns this e2e; not fixed
in SL-4, where fixing it would mean editing a test's polling logic on a guess.

The label-list edits this slice made to the e2e stand: they are the same measured
rename as everywhere else, and they mask nothing (the test fails well past them).

## F22 — REGISTERED: `claudeCacheMissCancelled` is the cancel-axis sibling of the success-needle residual

Not fixed here; recorded so it is triaged rather than rediscovered.

`claudeCacheMissCancelled` matches a bare `Keptmodelas` / `Kepteffortlevelas`
with **no value anchor and no recency rule**, and it is consumed while the relay
is PARKED on the cache-miss dialog (`onParkedConfirmData`). Three measured facts
now intersect on it:

1. F15 — a plain `/model` picker **Esc** emits `⎿ Kept model as <name>`. The
   phrase is no longer exclusive to the cache-miss dialog.
2. F19 — the alternate-screen redraw replays whole transcripts through the
   4096-byte window, and the window is a SLICE: it can carry an old `Kept …` line
   without the later `Set model to …` line that would otherwise shadow it.
3. The park RESETS `controlSwitchScan` (review F2's snapshot design), so a
   post-park window is exactly the fresh slice this needs.

Consequence if it fires: Sonata reports the switch settled-as-cancelled — "kept
the current model" — and `settleParkedCancel` drops the staged effort leg, while
the CLI's dialog is still open and unanswered. That is the same class as the
success-needle residual, on the cancel axis, and one step worse in that it also
discards queued work.

Anchoring is NOT free here, which is why it is registered rather than patched
alongside the failure needles: the `Kept …` line names the model that was KEPT —
the one being switched AWAY from — not the pending target, so the value the
engine holds is the wrong one to anchor on, and Sonata does not reliably know the
outgoing display name (that is the label table again). A recency rule is likewise
not obviously sound against a slice boundary. The mirror-based confirmation
registered for F19 covers this class too, which is the argument for doing that
once rather than three needles separately.

---

# SL-5 — Claude permission-mode drive re-verify (claude 2.1.258)

Probes: `q17-permission-cycle.mjs` (arms A cycle walk / B pacing / C spawn
determinism / D occlusion), `q18-permission-drive-mirror.mjs` (E off-cycle
origins / F production drive / G the mirror under an undriven flip),
`q19-stale-origin-drive.mjs` (the pre/post A/B fixture). Binary pinned 2.1.258 at
the start and end of every run — **no drift this slice** (the first slice in this
program where the binary held still).

## F23 — the Shift+Tab cycle is UNCHANGED at 2.1.258 (q17 arm A, MEASURED)

Twelve consecutive presses from a `--permission-mode default` spawn, reading the
grid row, its glyph codepoints and the production parser's verdict after every
one:

```
default → acceptEdits → plan → auto → default → …   (three full laps, no drift)
```

- **Four members, no fifth.** Both `plan` and `auto` are present on this account.
- **`bypassPermissions` never appeared.** The SL-5 brief named an in-cycle
  bypass as a design-fork trigger; it is not in the cycle, so there is no fork.
  Sonata cannot step into it unattended.
- **0 unparsed steps, 0 landings rejected** by the production
  `expectedPermissionLandings` validator across all 12 transitions. The
  `CLAUDE_PERMISSION_CYCLE` table's 2.1.214 stamp was stale; its CONTENT was not.
- Per-step latency **25–28ms** press→mode-line (n=12), against a
  `PERMISSION_STEP_RECEIPT_TIMEOUT_MS` of 1500. Two orders of margin.
- Verbatim rows, and note the asymmetry — `default` alone has no cycle hint:

```
⏸ manual mode on · ← for agents                                U+23F8
⏵⏵ accept edits on (shift+tab to cycle) · ← for agents         U+23F5 U+23F5
⏸ plan mode on (shift+tab to cycle) · ← for agents             U+23F8
⏵⏵ auto mode on (shift+tab to cycle) · ← for agents            U+23F5 U+23F5
```

## F24 — a FIFTH mode line exists that no table carried: `dontAsk` (q17 arm C / q18 arm E, MEASURED)

`--permission-mode dontAsk` boots to a working composer whose footer reads

```
⏵⏵ don't ask on (shift+tab to cycle) · ← for agents      (ASCII apostrophe U+0027)
```

and `parseClaudePermissionModeLine` returned **null** on it, as did
`CLAUDE_MODE_LINE_ON_SCREEN_RE`. `dontAsk` is not a menu option — but it is a
`ClaudePermissionMode`, `claudeArgs` maps it to `--permission-mode dontAsk`, and
`parseCreateTaskRequest` accepts it, so a task created through the local API
spawns straight into it. Three consumers went blind on such a session at once,
because they share one table:

1. the S2 step parser (could not read the session's mode);
2. SL-2a's readiness footer redundancy leg;
3. **`claudeFullscreenOfferOpen` condition 3** — "a composer is on screen ⇒ this
   is not the boot offer", the structural discriminator SL-3 added. It failed
   OPEN for the whole life of a `dontAsk` session.

FIXED by extending the shared phrase table by one entry (the brief's sanctioned
"EXTEND, never reshape"), which closes all three — the argument for the table
being shared, demonstrated.

**Off-cycle behaviour, measured (q18 arm E, 8 presses):** the single press taken
from a `dontAsk` composer landed on `default`, and the seven presses after it ran
the ordinary four-mode loop, **never returning to `dontAsk`**.

Be precise about what each half of that is worth, because review round 1 was
right that the first write-up blurred them:

- The `dontAsk → default` transition was observed **n=1**. The seven later
  presses corroborate the CYCLE, not that transition.
- "`dontAsk` is never a landing" is the strong claim, and it holds across all
  eight presses. That is what the return-home early stop keys on
  (`isClaudePermissionCycleMode`), and it is the claim that needed to be robust.

So `expectedPermissionLandings("dontAsk")` **keeps its blanket exemption** — see
F30's ledger note for the reasoning. The successor is recorded in the parser's
doc as knowledge, not encoded as a rule.

## F25 — `--permission-mode bypassPermissions` never reaches a composer (q18 arm E, MEASURED)

The spawn parks on an unanswered consent screen and stays there — 8 Shift+Tabs
changed nothing, no mode line ever painted:

```
  WARNING: Claude Code running in Bypass Permissions mode
  … By proceeding, you accept all responsibility …
  ❯ No, exit
    Yes, I accept
  Enter to confirm · Esc to cancel
```

Two consequences. (a) `bypassPermissions` keeps its blanket landing exemption
honestly — its successor is not merely unmeasured, it is UNMEASURABLE from
Sonata. (b) A `bypassPermissions` task created via the local API would hang on a
boot interstitial nothing recognises. That is an SL-3-class boot-ceremony gap,
outside SL-5's boundary — **registered, not fixed**. Note the row order matches
the trust dialog's post-2.1.252 shape (`❯ No, exit` first), so a blind Enter
would decline, not accept.

## F26 — spawn determinism holds; this account's own default is now `auto` (q17 arm C, MEASURED)

| spawn | boot mode | flag won? |
|---|---|---|
| **no `--permission-mode` flag** | **`auto`** | (control) |
| `--permission-mode default` | `default` | yes |
| `--permission-mode acceptEdits` | `acceptEdits` | yes |
| `--permission-mode plan` | `plan` | yes |
| `--permission-mode auto` | `auto` | yes |
| `--permission-mode dontAsk` | `dontAsk` | yes |

The 8/14 server-side rollout **did** land on this account — an unflagged claude
boots into `auto`. Sonata always passes the flag and the flag still wins in every
mode, so Sonata's spawn is deterministic and **no code change is needed**. Worth
keeping: this is exactly the drift a future sync would otherwise discover as a
mystery, and the control arm is what makes "the flag wins" a measurement rather
than an assumption.

## F27 — pacing: one press = one mode down to 40ms; only same-tick writes coalesce (q17 arm B, MEASURED)

Three presses from `default`, varying the spacing:

| spacing | landed | advanced |
|---|---|---|
| 300ms | `auto` | 3 ✓ |
| 120ms | `auto` | 3 ✓ |
| 40ms | `auto` | 3 ✓ |
| **0ms** (three writes, same tick) | **`acceptEdits`** | **1 ✗** |

Upstream's fast-key fixes in the 2.1.22x–2.1.25x range do not affect Sonata: the
engine writes ONE `\x1b[Z` and waits for that step's receipt before the next, so
it can never produce the same-tick burst that coalesces. NO-OP, with a mechanism
— which is the useful form, because it says *why* it is a no-op and what would
break it (any future "press N times at once" optimisation).

## F28 — occlusion: the Ctrl-C hint replaces the mode line on the GRID, not in the STREAM (q17 arm D, MEASURED)

The 2.1.248 changelog hazard is real and its shape is specific. One Ctrl-C at an
idle composer replaces the footer's mode-line row with
`Press Ctrl-C again to exit` for ~1–2s (measured back at +2.0s, still absent at
+400ms), the composer `❯` still present:

| channel | before | +400ms | +2.0s |
|---|---|---|---|
| grid mode-line row | present | **absent** | present |
| `CLAUDE_MODE_LINE_ON_SCREEN_RE` (grid) | true | **false** | true |
| `parseClaudePermissionModeLine` (raw tail) | `default` | `default` | `default` |

The STREAM channel is untouched, because the parser reads a cumulative tail that
still holds the last mode line. So the S2 **step receipt is not at risk** — the
raced case (Shift+Tab, then Ctrl-C 60ms later, inside the step's receipt window)
still parsed the correct landing `acceptEdits`.

Two real consequences, both handled:

1. **SL-2a readiness** loses its mode-line redundancy leg for that window. It
   does not lose readiness: the same occluded frame still carries `medium` and
   `/effort` for `idlePromptModelHints`. The redundancy did its job — this is the
   first field evidence that the SL-2a leg was worth building as redundancy
   rather than as the needle.
2. **`claudeFullscreenOfferOpen` condition 3** fails OPEN for that window, and
   F6's "the composer footer carries a mode line, never absent" is thereby
   **falsified as an absolute**. The guard survives because both POSITIVE needles
   must still match and an idle composer under a Ctrl-C hint has neither. Comment
   corrected in place rather than left standing.
3. The engine's ORIGIN read (F30) can return null here — which is why it falls
   back to the caller's `from` instead of guessing.

## F29 — the permission mirror does not follow an undriven flip (q18 arm G, MEASURED — DECISIVE)

Objective 3's question, answered on the production `HookWatcher` +
`applyHookPermissionMode` path. The reproducible stand-in for every flip Sonata
did not perform (a user's own Shift+Tab in the Terminal pane; a server-side
`disableAutoMode`; a Remote-Control change from a phone) is a `writeUserInput`
Shift+Tab — from the mirror's point of view all of them are identical: nobody
told it.

- `SessionStart` carries **`permission_mode: null`** — the mirror is not seeded
  from the hook at all (the task record's spawn value covers boot, so this is
  not itself a bug, but it means the FIRST hook to move the mirror is the first
  turn's).
- After the flip the grid read `acceptEdits` and the mirror still read
  `default`. **65 seconds of watching produced ZERO hooks** — not even the
  `Notification(idle_prompt)` SL-2b found at 60s.
- The correction arrived only with the next turn: `UserPromptSubmit`, 304ms
  after submit, carrying `permission_mode: acceptEdits`.

So the staleness window is **"until the user's next turn" — unbounded**, and a
user who flips natively and then reaches for Sonata's access chip is inside it by
construction.

**Server-side `disableAutoMode` and a Remote-Control mode change from another
device: UNREPRODUCED.** Neither is triggerable from this harness. They are not
separate risks though — they are the same undriven-flip shape measured above,
and any of them would land in exactly this window.

## F30 — what a stale `from` cost, and what shipped (q19, MEASURED A/B on the live CLI)

`renderer/main.ts:508` passes `view.task.permissionMode` — the F29 mirror — as
the switch's `from`, and `writePermissionStep` seeds `pressedFrom` from it. So
the landing validator is anchored on a mode the CLI may have left minutes ago.
Measured on the real engine + real CLI, mirror says `default` / CLI is in
`acceptEdits`:

| arm | pre-fix | post-fix |
|---|---|---|
| **h1** target `plan`, stale `from` | **needs-attention**, **7 mode changes**, final `default` | **settled**, **1 change**, final `plan` |
| **h2** target `plan`, TRUE `from` (control) | settled, 1 change, `plan` | settled, 1 change, `plan` |
| **h3** target `acceptEdits` — the mode it is ALREADY in | **needs-attention**, **7 mode changes**, final `default` | **settled**, **0 changes**, stays `acceptEdits` |

The seven-press walk is not noise, it is the state machine working as written:
press 1 lands `plan`, which is not `default`'s successor → fail loud →
return-home re-anchors on the SAME stale `default` → presses 2–3 fail the same
way (press 3 lands on `default` itself and burns the full 1500ms window as a
"stale pre-press repaint") → from press 4 the anchor finally tracks reality and
the walk runs the cycle until `default` comes round. `observedModes` came back as
all four modes, which is the tell. h3 is the sharpest: **asking for the mode you
are already in moved the session off it.**

SHIPPED — the origin comes off the SCREEN, not off the mirror:

- `TerminalHost.screenPermissionMode()` — a synchronous grid read (sibling of
  `isRewindPanelOpen`, same staleness argument) parsing the footer with the
  SAME shared parser. Grid, not stream, and here that is required rather than
  preferred: the pty tail is cumulative and "last match wins" cannot tell the
  current footer from a scrolled-past one.
- `startPermissionSwitch` uses it, falling back to the caller's `from` when the
  screen cannot answer (F28's occlusion window; no screen model) — so the
  degradation is exactly the old behaviour, never worse.
- `beginPermissionReturn` stops instead of walking toward an origin the cycle
  **cannot reach** (F24: `dontAsk` is never a landing; F25: `bypassPermissions`
  has no composer). Walking the 12-step return cap there is a blind-press ladder
  that provably cannot arrive.
- `expectedPermissionLandings("dontAsk")` **deliberately NOT tightened** — see
  the review note below; both off-cycle origins keep the blanket exemption, now
  each for a stated reason rather than by default.

This does **not** move the permission SSOT (contract §2). The mirror is still the
hook payload; a settled switch still writes nothing to `task.permissionMode`. The
screen read decides only where the choreography starts pressing — a receipt-side
question, which is the mode line's job.

## F31 — REGISTERED: a settled permission switch still leaves the chip stale until the next turn

Not fixed here; it is the F29 mirror lag seen from the other end. After a
successful drive the CLI is in the target mode and Sonata's access chip still
shows the old one, because `control-switch:state settled` deliberately does not
write `task.permissionMode` — the hook payload does, on the next turn. Today that
is bounded and honest (the pending affordance clears, the CLI's own footer is
visible in the Terminal pane, and one turn corrects it).

It is the same shape as F19's "confirm a mid-session switch against the MIRROR,
not the stream" register item, with the axes reversed: model/effort has a fast
state mirror (the statusline payload) and a noisy receipt; permission has a clean
receipt and a mirror that only ticks on turns. Both point at the same unlock —
`PostModelSwitch` / a state-query confirmation channel (D2) — which is where this
belongs, not in a table edit.

## F32 — the offered-mode sets already agree with the measured cycle (NO CHANGE, with the reasoning)

Objective 4 asked whether Sonata's offered modes still match reality. They do,
and the reasons are worth stating so they are not re-litigated:

- `CLAUDE_DEFAULT_PERMISSION_MODE_OPTIONS` (Settings, new-session default) =
  `default / acceptEdits / auto`. All three are measured cycle members and all
  three were measured to spawn deterministically under the flag (F26). `plan` is
  excluded by an unchanged product judgement (a momentary mode is an odd standing
  default), not by a capability claim, so the measurement does not touch it.
- `PERMISSION_MENU_BASE` (the live session's access chip) =
  `default / acceptEdits / plan / auto` — exactly the measured cycle, in order.
  `bypassPermissions` stays observation-gated, and F23 now shows it is not merely
  a policy choice: it is **not reachable by stepping at all**, so offering it to
  a session that did not spawn into it would be a dead step by construction.

**`dontAsk` is deliberately NOT added to either set, and the new table entry does
not change that.** SL-5 taught the PARSER to read a `dontAsk` session; it did not
make `dontAsk` reachable. q18 arm E measured that no Shift+Tab press ever lands
on it, so a menu entry for it would be precisely the dead step D4 forbids — the
drive would seek the whole cycle, never find it, and return home with
needs-attention. Reading a mode and offering a mode are different questions; this
slice answered only the first.


## F30b — review round 1: the `dontAsk` successor was an n=1 tightening, reverted

Round 1 (0 blocking, 4 minor) found the first cut of F30 encoding
`expectedPermissionLandings("dontAsk") = {default}` off a **single** observation
while the comment claimed "enters the cycle at `default` every time". Two things
were wrong: the prose overclaimed the sample, and the rule itself was a bad trade.

The asymmetry decides it. A one-member expectation that is RIGHT buys nothing —
the stale-repaint filter (`landed === from`) already rejects the only thing a
first press from `dontAsk` could plausibly misread. A one-member expectation that
upstream later makes WRONG converts a drive that would have worked into a
guaranteed failure. And SL-5 **compounds** that in the same slice: because
`beginPermissionReturn` now stops dead for a non-cycle origin instead of walking,
the rejection resolves on press 1 with no recovery path. Bounded and loud, yes —
but bounded-and-loud is the right contract for a transition we have MODELLED, not
for one we have SAMPLED once.

REVERTED to the blanket exemption. The measurement is preserved as knowledge in
the parser's doc (with its n stated), and a smoke pins the blanket so the choice
reads as a decision rather than a gap. A second independent observation of the
transition would change the calculus; one would not.

What SURVIVES from the same probe is the stronger claim, and it is the one the
code actually leans on: `dontAsk` is never a LANDING (0 of 8 presses), so it is
unreachable as a return-home destination. That is `isClaudePermissionCycleMode`,
and it is unaffected.

## F28b — review round 1: the occlusion window opens the surface, it does not merely widen it

The first cut of the corrected condition-3 comment said the Ctrl-C window "widens
the forgery surface without opening it". Round 1 pointed out that this is
contradicted by the slice's own new test, which asserts
`claudeFullscreenOfferOpen(OFFER_FRAME + composer + occludedFooter) === true`.
For the RESUMED-REPAINT class the discriminator is the only thing between that
screen and a true verdict, so during the window the surface is genuinely OPEN.

Prose rewritten to the honest mitigation, which is about the SHAPE of the
consequence rather than its absence:

1. the guard's only effect is a readiness HOLD — recognition writes nothing to
   the pty (RED LINE), so a false hold costs latency, never an action;
2. it is not a latch of its own: `acceptsPromptInput()` re-evaluates per call and
   the delivery pump re-polls ~every 500ms, so the hold lifts on the first poll
   after the hint clears — **bounded by the hint's ~1–2s lifetime, not by the
   session's**. The one-way BOOT latch is what would have made a false hold
   permanent, and this hold expires before it can be what keeps that latch shut;
3. post-latch it costs nothing at all — the guard feeds readiness only, and
   readiness stops gating delivery once the latch opens.

The test case is now explicitly framed as pinning a KNOWN FALSE POSITIVE as
expected behaviour, with a header saying a failure there means the boundary
IMPROVED (delete the assertion) rather than that something regressed, and a third
assertion proving the hold is transient on the same host.

## F4b — the RC surface at 2.1.258: the OLD needles were RIGHT about the words and WRONG about the channel (rc3/rc5, DECISIVE — this is what shipped)

F4 read the 2.1.252 sighting as "the banner + `/rc` pill replace the old URL-line
form", and the slice was scoped to re-derive needles for a new surface. The
re-measurement says the WORDS never moved. What moved is which channel carries
them.

**The vocabulary, MEASURED verbatim at 2.1.258 (rc1/rc3/rc5/rc6):**

```
  /remote-control is active · Continue here, on your phone, or at        ← --remote-control boot banner
  https://claude.ai/code/session_…                                          (and re-connect)

   Remote Control                                                       ← the native panel, which
   This session is available in the Claude mobile app and at …             `/remote-control` now opens
     Disconnect this session
     Show QR code  Scan with your phone to open this session
   ❯ Continue
   Enter to select · Esc to continue

  ⎿  Remote Control disconnected.                                       ← the OFF receipt, unchanged
```

`REMOTE_CONTROL_URL_RE` matches all three link forms; `RemoteControldisconnected`
matches the receipt. Neither string needed re-deriving.

**What the `/rc` pill actually is.** Not a state readout. The pill's TEXT is
`/rc` whether RC is on or off — measured side by side in rc2's four legs, where
three never connected and all four rendered the identical footer row. Only its
COLOUR moves (`rgb(255,193,7)` while connecting → `rgb(78,186,101)` connected),
and `TaskScreenModel.viewportText()` is text-only by construction. So there is no
grid STATE needle for RC to build, and none was built. The brief's D-1 guess
("the pill is persistent footer STATE → grid") does not survive contact: the pill
carries no state a grid consumer can read.

**Where the two signals belong, measured rather than reasoned:**

| signal | kind | channel | why the other channel fails |
|---|---|---|---|
| session link | one-shot VALUE | **grid** | the stream never carries it whole (F4c) |
| `Remote Control disconnected.` | one-shot EVENT | **stream** | the grid keeps showing it after a reconnect (rc6: `staleDisconnectLineAfterReconnect: true`, on a session that had already reconnected) |

That is the shipped split. Note it is not the naive reading of D-1 in either
direction — "value → grid, event → stream" is what the measurements force, and
the reason is the same in both rows: the grid CONVERGES (so it assembles a value
and forgets nothing), the stream is CUMULATIVE-then-differential (so it preserves
an event's moment and mangles a value).

## F4c — WHY the link stopped arriving: the differential repaint elides characters already on screen (rc5, DECISIVE)

The verbatim bytes, from a `/remote-control` injected at the composer edge:

```
at https:\x1b[69G/claude.ai/code/session_….
```

Escapes stripped, the stream reads `at https:/claude.ai/…` — **one slash**. The
second `/` is never sent, because the cell already held it. This is the same
alternate-screen differential repaint F5b found for the footer, one level
sharper: F5b's footer was ABSENT from the stream; here the text is present and
CORRUPT, in a way no regex can repair, because the missing bytes were never
transmitted. Compacting whitespace — the trick that makes the OFF needle
position-proof — cannot help: the characters are absent, not spaced.

It is also intermittent, which is why this read as "sometimes broken" rather than
"broken". Same session, same command, three injection moments (rc5, N=2 runs):

| injected | STREAM (`findRemoteControlUrl`) | GRID |
|---|---|---|
| at the `acceptsPromptInput()` edge | **never, through 45s** | +761ms |
| +3s | +141ms | +152ms |
| after the boot's RC settled (+17s) | +140ms | +152ms |

The grid answered in all six leg-runs. The stream answered only when nothing else
was repainting the same rows — i.e. the corruption is a COLLISION between the
panel paint and the boot's own RC connect, so it reproduces exactly at the moment
production injects and disappears a second later. `remote-control-disconnect.mjs`
injects at that edge; a hand run three seconds later passed. That is the whole
mystery of the last red smoke.

**Shipped**: `findRemoteControlUrl(raw)` is retired for
`findRemoteControlUrlOnScreen(screenText)`, read off `screenModel`, ANCHORED to
claude's own sentence (F4c-b). `hasRemoteControlDisconnect` is unchanged and
stays on the stream.

**A second defect, found only because the fix was verified rather than reasoned
about**: the first cut read the grid SYNCHRONOUSLY, on the precedent of
`screenPermissionMode`. It failed identically. `@xterm`'s WriteBuffer can defer
the parse past the synchronous return, so the read saw the PRE-write grid — and
because the alt-screen goes quiet the instant the panel is painted, no later
batch ever arrives to re-read on. Measured: the host reported no link 30s later
while an independent grid fed the same bytes had it at +2.3s. The distinction the
precedent hid is PULL vs PUSH: `screenPermissionMode` is asked at an arbitrary
moment and a stale answer self-corrects on the next ask; this is triggered by the
one batch that paints the value and has no next ask. It now reads inside
`screenModel.whenSettled`, like `clearApprovalIfAnsweredNatively`.

## F4c-b — the grid read WIDENED the false-positive surface; the fix is a context anchor (SL-11 review round 1, taken)

The first cut of F4c claimed "the channel moved, that exposure did not". Review
falsified it, and the reasoning is worth keeping because it is a general property
of moving a needle from a stream to a grid:

- the retired stream scan was **fenced by construction** — `remoteControlScan` is
  cleared on every transition, so it could only ever see bytes that arrived AFTER
  activation. A link printed earlier in the session was structurally unreachable.
- a **whole-viewport read has no such fence**: it sees everything on screen at the
  instant RC turns on. And the value **latches** (captured once, held for the
  connection), so a single wrong read never self-corrects — the popover's
  copy-link button would serve a foreign session for the whole time RC is on.

Neither ordering rule rescues it, which is the part that makes the anchor
necessary rather than merely tidy: the panel paints LOW (rows 33–39 of 40), so a
model-quoted or user-pasted `claude.ai/code/session_…` in the transcript sits
ABOVE it and beats first-match; the composer sits BELOW it, so a pasted link
there beats last-match. Position carries no signal. **Context does.**

Shipped: the link must be preceded by one of claude's own two sentences, both
grepped verbatim out of every SL-11 capture (they are the complete link-bearing
vocabulary at 2.1.258, not a sample):

```
This session is available in the Claude mobile app and at <LINK>      (panel, same line)
… Continue here, on your phone, or at
  <LINK>                                                              (banner, next line)
```

`\s+` between anchor and link spans both. A/B against the pre-anchor reader on
the same inputs: 3 of the 4 new fences flip (`bare link` null vs foreign,
`foreign ABOVE the panel`, `foreign above the banner`); the fourth (`foreign
BELOW the panel`) agrees, which is precisely the case that proves last-match was
not an alternative.

Residual, PINNED as an expected-value assertion rather than hidden: a model that
reproduces one of those sentences verbatim and follows it with a link is
indistinguishable from claude printing it. Far narrower than a bare URL. The
failure direction is also now the safe one — an upstream reword leaves the
popover showing "Connecting…" while RC works (visible, recoverable) instead of
confidently handing over the wrong link.

UNMEASURED, registered: at narrow terminal widths the panel's link line could
WRAP, and a link split across grid rows matches no channel. All SL-11 captures
are 120 cols. Pre-existing for any grid reader; would need a width-sweep probe.

## F4d — `/remote-control` is no longer idempotent: the second injection dismisses the panel and types into the composer (rc3/diag, MEASURED)

At 2.1.195 the command connected, and a second invocation opened the panel — the
behaviour `manageRemoteControl` and the disconnect smoke were both written
against. At 2.1.258, MEASURED:

- from OFF: **connects AND opens the panel in one move** (rc3 arm A, rc5 all
  legs — `❯ Continue` focused, panel still up 60s later);
- from that open panel, a second injection **closes it** and leaves
  `/remote-control` sitting in the composer. Every keystroke after that goes to a
  composer, not a menu — measured step by step: `❯ Continue` → (inject) → `❯` →
  four Ups → `❯ /remote-control` → Enter → the panel opens again.

So the old smoke's `inject, inject, Up, Up, Enter` was walking a composer. Fixed
by injecting ONCE and verifying the panel on a real grid before pressing
anything (the same verify-and-retry discipline as the SL-1 trust walk).

**Production consequence, REGISTERED not taken** (outside this slice's file set):
`enableRemoteControl` leaves claude's RC panel open over the composer and does
NOT switch the user to the terminal view (only `manageRemoteControl` does), so
the modal is invisible in Sonata. `acceptsPromptInput()` returns TRUE with the
panel up (measured, rc5, all legs) — the panel is not an approval and nothing
gates on it — so a prompt delivery in that window would be typed into the RC
panel. Two candidate fixes, both outside SL-11: gate readiness on the panel (a
readiness-surface change, SL-9's neighbourhood), or have `enableRemoteControl`
follow `manageRemoteControl` into the terminal view (a renderer change).

## F4e — RC AUTO-STARTS on Sonata's production spawn, and Sonata's setting cannot see it (rc2/rc5, objective 4, REPORT-ONLY)

Woody's `defaultRemoteControl: false` is implemented as "do not pass
`--remote-control`". MEASURED at 2.1.258: that is not what decides it.

**Six for six**, every `TerminalHost` boot in rc5 (two runs × three legs), with no
`--remote-control` anywhere, printed `/rc connecting…` and turned the pill green.
Sonata's production spawn is phone-reachable while its own setting says OFF.

The resolver, read verbatim out of the 2.1.258 binary and consistent with every
measurement:

```
remoteControlAtStartup:
  project/local settings === false           → false      (repo scope can only DISABLE;
                                                           a repo-scoped `true` is logged
                                                           and ignored — "set it at user
                                                           scope (/config)")
  else policySettings | flagSettings | userSettings       (first that defines it)
  else legacy global config
  else the DEFAULT:  remote env            → false
                     persistent remote sess→ true
                     org policy `remote_control_at_startup`
                     else GrowthBook `tengu_cobalt_harbor`   (ships false)
```

On this account `tengu_cobalt_harbor` is **true**, no `remoteControlAtStartup`
exists at any scope, and `disableRemoteControl` is a MANAGED-settings (org
policy) key that a `--settings` file cannot reach. So RC auto-start here is
decided by a server-side flag, cached in `~/.claude.json` and refreshed
asynchronously — which is why F4 saw it at 2.1.252, rc1/rc2 did not an hour
later, and rc5 saw it again after a cache refresh. **The switch moved twice
during this slice with no local action.**

What Sonata's spawn CAN and CANNOT control at 2.1.25x:

- **CAN**: turn RC ON for a session (`--remote-control`) — measured, connects at
  +0–2ms with the link in reach of both channels.
- **CANNOT, today**: turn it OFF. Not passing the flag is not a decision; it
  merely declines to override a default that is already ON.
- **COULD**: `--settings` is the `flagSettings` source, which the resolver
  accepts (unlike project/local scope, which may only disable). A
  `remoteControlAtStartup` key in the file `ensureClaudeRuntimeSettings` already
  writes on every spawn is the lever that would make the setting mean what it
  says, in both directions. `rc4-atstartup-scope.mjs` measures whether that
  reading holds on the live binary.

Not taken here: the setting's semantics are Woody's design (objective 4 is
REPORT-ONLY). What is taken is that the gap is now measured rather than assumed,
and the mechanism is named rather than guessed at.

There is a second-order consequence worth stating plainly, because it is the one
that costs correctness rather than policy: when RC auto-starts, Sonata's
`remoteControlActive` is FALSE, so `detectRemoteControlState` returns early and
Sonata is blind to a session that is live on the user's phone — the header button
reads OFF, and a CLI-side disconnect goes unnoticed. The "activation is OUR
signal" invariant, which exists to stop a foreign link flipping RC on, is exactly
what makes this blind spot. Also measured: an auto-started boot prints NO session
link into the stream at all (`boot.sawSessionUrl: false`, 6/6), so even an
unconditionally-armed stream detector would have had nothing to read — another
reason the channel had to move to the grid before this could ever be closed.

## F4f — the grid channel's own hazard, measured and found absent (rc6)

A grid holds a transcript, so moving the link read there raises a question the
stream never had: after disconnect → reconnect, can the screen show a DEAD link
above the live one? A reconnect does mint a new session id (measured, ids
compared by fingerprint), so a stale row would be a real wrong answer.

MEASURED: it does not happen. The disconnect redraw clears **every** link row
from the grid (`afterDisconnect.count: 0`), and while the boot banner and the
open panel are both visible they carry the SAME id. One link on screen, ever. So
`findRemoteControlUrlOnScreen` takes the first match with no ordering rule —
there is nothing for one to disambiguate, and inventing one would be a guard
against a case the measurement says is not there.

The same probe re-confirmed the other direction: `Remote Control disconnected.`
was still on the grid AFTER the reconnect had succeeded. That is the fact that
keeps the OFF needle on the stream.

## F4g — CLOSED (review round 1, taken): corpus-lint could not see the escape-split session link

`corpus-lint.mjs` forbade `https://claude.ai/<not REDACTED>`. The 2.1.258 repaint
splits that literal across a cursor move, so a fixture carrying a REAL session
link in its measured form (`https:\x1b[69G/claude.ai/code/session_…`) passed the
fence — defeating the stated reason the new tree was fenced at all.

Note the trap in the obvious fix: **stripping escapes does not close it.** The
repaint ELIDES the second slash (it was already on the grid), so the stripped
text reads `https:/claude.ai/…` and a rule keyed on `https://` still misses. The
scheme is not recoverable, so the rule must not depend on it. Three changes:

1. a new **scheme-independent** rule — `claude\.(?:ai|com)/code/session_(?!REDACTED)…`
   — matching the identifying payload (host + id) with no `https://` at all;
2. every rule now scans the **escape-stripped** copy as well as the raw text, so a
   marker split mid-word by a cursor move (`/Users/\x1b[12Gwoody/…`) is caught for
   the other four marker classes too;
3. the existing url rule widened `claude\.ai` → `claude\.(?:ai|com)` (Sonata's own
   regex accepts `.com`, and the unit smoke pins a `.com` variant).

This makes a fixture's synthetic id distinguishable from a live one BY THE FENCE
rather than by the author remembering, so the pinned window's id was re-seeded to
`session_REDACTEDprobeFixture0001` (same length, so the absolute-column paint
still lays out inside 120 cols).

Discrimination check, run: planting a fixture containing
`at https:\x1b[69G/claude.ai/code/session_01RealLookingIdAbc123` fails the fence
on the new rule and passes again once removed (`DISCRIMINATES: true`); the 63
existing pinned files stay clean.

## F4j — REGISTERED (measured premise, inferred trigger): the OFF channel is staleness-DELAYED, not staleness-free

F4b puts the disconnect receipt on the stream because the GRID keeps showing it
after a reconnect. That is right, and it is not the whole story: the stale row is
still sitting in the CURRENT frame, so anything that makes claude re-emit that
region — a scroll as output pushes it up, a SIGWINCH repaint — puts the receipt
back into the STREAM, where `hasRemoteControlDisconnect` cannot tell a repaint of
history from a live event. Consequence: a live, reconnected session reported OFF,
and the header button goes stale in the direction Woody's 2026-06-28 bug was
about.

The rolling 2048-char window and the per-transition reset bound the exposure but
do not remove it — a repaint that carries the row is a fresh arrival in a fresh
window. This is the same class as F19's stale-receipt repaint on the model axis,
which suggests the general shape: **no needle read off a repainting alternate
screen can distinguish an event from its own echo without a recency anchor.**

PREMISE MEASURED (rc6: `staleDisconnectLineAfterReconnect: true`); TRIGGER
INFERRED — not reproduced. Falsification recipe for whoever takes it: connect,
disconnect via the panel, reconnect, then push enough output to scroll the
receipt row through the viewport, and watch for a spurious
`remote-control:state {active:false}`. Not taken here: it is a choreography
redesign (confirm against a recency-anchored or structured source), not a needle
change, and SL-11's brief is the surface.

## F4h — INCIDENT (cross-slice, not caused by this slice): `~/.claude/settings.json` `model` was rewritten mid-slice

At 01:20 local, while SL-11's rc3 was running, the user's `~/.claude/settings.json`
`"model"` changed from `"opus[1m]"` (the value read at slice start, and this
account's daily-driver default) to `"haiku"`. rc3's own fence caught it
(`userSettingsUnchanged: false`).

Not this slice: no SL-11 probe writes settings, none sends `/model`, and no
capture from rc1/rc2/rc3 contains the string `haiku` anywhere — every probe frame
shows `Opus 5 (1M context)`. SL-9 and SL-10 were running concurrently in the same
tree. Left in place rather than restored, because a sibling slice may be mid-A/B
on it and a blind restore would corrupt that measurement; flagged for the
orchestrator instead. If no sibling claims it, `"model": "opus[1m]"` is the value
to put back.

## F4i — the lever WORKS: `remoteControlAtStartup: false` in Sonata's own `--settings` file suppresses auto-start (rc7, MEASURED, N=2, objective 4 — REPORT-ONLY)

F4e established that RC auto-start is decided somewhere Sonata does not look. rc7
asks whether Sonata's spawn can reach the switch, with the one A/B that matters:
the settings file `ensureClaudeRuntimeSettings` already writes on every spawn,
with and without the key, plus an environment control.

Three legs, spawned identically apart from the named variable, run twice
(2026-09-02, claude 2.1.258, `tengu_cobalt_harbor` true throughout):

| leg | env | `remoteControlAtStartup` | auto-started? |
|---|---|---|---|
| A | production (`ptyEnvironment`) | absent | **yes** (run 1 and 2) |
| B | production | **`false`** | **no** (run 1 and 2) |
| C | 2026-08 driver's scrubbed env | absent | **yes** (run 1 and 2) |

6/6 consistent. Two conclusions, one of which corrects a hypothesis this slice
was carrying:

1. **The lever exists and is in Sonata's hands.** A `false` in the `--settings`
   file — the `flagSettings` source, which the resolver accepts where repo-scoped
   settings may only disable — stops the auto-start dead: no `/rc connecting…`,
   no green pill, in a 45s window, sitting between two legs that auto-started
   minutes either side of it. And it is SAFE with respect to the opt-in path:
   rc4 leg 3 measured `remoteControlAtStartup: false` + `--remote-control`
   connecting at +0ms, so writing `false` would disable the AUTO-start without
   disabling the setting Woody's UI actually offers.
2. **The environment hypothesis is FALSIFIED.** Leg C strips exactly what the
   2026-08 driver strips and auto-started anyway, so the `Probe`-never /
   `TerminalHost`-always split that rc2/rc4/rc5 showed is NOT about
   `AI_AGENT`/`CLAUDE_PID`/`CLAUDE_*`. What is left is TIME: rc4's legs (05:55)
   did not auto-start and rc7's identically-scrubbed leg C (~06:05) did, same
   binary, same account, same cached flag value, no local change in between. So
   **RC auto-start flaps on a timescale of minutes from Sonata's point of view**,
   which is the strongest argument for taking a local lever rather than relying
   on observed behaviour.

What is NOT measured: whether `remoteControlAtStartup: true` in that file can
ENABLE auto-start. rc4's leg 2 tried and read "no", but it ran inside one of the
non-auto-starting windows, so it cannot separate "the source is not accepted for
enabling" from "nothing was auto-starting then". Leg B proves the source is READ;
the enabling direction stays open, and would need re-running against a window
where the default is off. It is also the direction Sonata has no use for — it
already has `--remote-control` for that.

Nothing changed. `defaultRemoteControl`'s semantics are Woody's design; this is
the measured fact a decision would rest on: **today the setting means "do not ask
for RC", and one key in a file Sonata already writes would let it mean "RC off".**

---

# SL-9 — hooks re-verify, CLAUDE side (probed 2026-09-02, binary 2.1.258)

Binary pinned `2.1.258 (Claude Code)` at every probe start and end. Two probes:
`h1-hook-census.mjs` (production `TerminalHost` from `dist/`, production settings
writer, production `HookWatcher`, with the remaining declared events layered onto
the file production had just written) and `h2-hook-stdout-audit.mjs` (the real
dist sink + broker over adversarial stdin, plus live `claude -p` arms whose
SessionStart / PermissionRequest hook emits one adversarial class each).

Captures: `h1-hook-census.capture.txt`, `h2-hook-stdout-audit.capture.txt`.

## F33 — the hook-event census at 2.1.258 (MEASURED)

The binary declares **33** events. Registering all 32 non-broker-owned ones on
Sonata's own sink and driving one ordinary turn (a tool call that fails) plus a
`/model` switch, **eleven fired**:

| event | injected in production? | first-payload keys |
|---|---|---|
| `SessionStart` | yes | cwd, hook_event_name, **model**, **scratchpad_dir**, session_id, source, transcript_path |
| `InstructionsLoaded` | no | + **file_path, memory_type, load_reason** |
| `UserPromptSubmit` | yes | + permission_mode, prompt, prompt_id |
| `PreToolUse` | yes | + **effort**, tool_input, tool_name, tool_use_id |
| `PostToolUseFailure` | **no** | + **error, is_interrupt, duration_ms** |
| `PostToolBatch` | **no** | + **tool_calls[]** (each with its `tool_response`) |
| `MessageDisplay` | no | + **delta, index, final, message_id, turn_id** |
| `Stop` | yes | + stop_hook_active, last_assistant_message, **background_tasks**, **session_crons** |
| `SubagentStop` | yes | + agent_id, agent_type, agent_transcript_path |
| `PreModelSwitch` | no | see F35 |
| `PostModelSwitch` | no | see F35 |

The 22 that did not fire: `PostToolUse` (see below), `Notification`,
`UserPromptExpansion`, `SessionEnd`, `StopFailure`, `SubagentStart`,
`PreCompact`, `PostCompact`, `PermissionRequest`, `PermissionDenied`, `Setup`,
`TeammateIdle`, `TaskCreated`, `TaskCompleted`, `Elicitation`,
`ElicitationResult`, `ConfigChange`, `WorktreeCreate`, `WorktreeRemove`,
`CwdChanged`, `FileChanged`, `DirectoryAdded`.

Two of those absences are ARM DESIGN, not evidence, and are labelled so rather
than quietly counted:

- **`PostToolUse`** did not fire in the census arm because its only tool call
  FAILED (`PostToolUseFailure` replaces it — SL-2b's F11, re-confirmed at
  2.1.258). The approval arm below ran a SUCCEEDING `Write` and `PostToolUse`
  fired normally. It is alive; the census arm simply never gave it a chance.
- **`Notification(idle_prompt)`** fires 60s after a turn end (SL-2b, 2.1.257).
  The census arm kept typing `/model` commands after its turn, so the idle clock
  restarted and the 60s window closed roughly when the arm did. This is NOT
  counter-evidence to SL-2b; it is an arm that could not have seen it.

`SessionEnd`, `PermissionDenied` and the rest were probed by SL-2b at 2.1.257 or
are simply untriggered here.

## F34 — `SessionStart` payload growth, and an SL-5 register correction

`SessionStart` at 2.1.258 carries `{session_id, transcript_path, cwd,
scratchpad_dir, hook_event_name, source:"startup", model:"claude-opus-5[1m]"}`.

- **NEW: `model`** on `SessionStart` — and in fact on every event; the CLI now
  stamps the active model into the envelope.
- **NEW: `scratchpad_dir`** — a per-session scratch path, on every event.
- **NO staleness / re-cache fields** appeared. The brief anticipated some; none
  exist in the measured payload.
- **CORRECTION to SL-5's F29**: that register item records `SessionStart` as
  carrying `permission_mode: null`. At 2.1.258 the key is **absent entirely**.
  The consequence is unchanged (`applyHookPermissionMode` reads it defensively,
  and the first hook to move the permission mirror is still the first TURN's),
  but the register's shape is wrong and SL-13 should re-stamp it.

Also new and worth more than a line: **`effort: {"level":"medium"}` now rides the
tool and `Stop` payloads**. The register item "the claude effort axis is OPTIONAL
and Sonata models it as mandatory" (SL-4, F17/F20) is blocked on where a truthful
current-effort value comes from; the hook channel now carries one per turn, which
is a cheaper answer than the statusline payload. Recorded for that item's owner,
not acted on.

## F35 — `PreModelSwitch` / `PostModelSwitch` fire under production injection (MEASURED)

Both fire, with an identical and rich key set:

```
from_model                 "claude-opus-5[1m]"            (the canonical id)
to_model                   "claude-haiku-4-5-20251001"
requested_model            "haiku"                        (the alias typed)
source                     "command"
context_tokens             46502
prompt_cache_warm          true
cache_ttl                  "1h"
estimated_cache_write_usd  0.093
pricing                    "catalog"
```

`Pre` landed at +0ms of the `/model haiku` submission, `Post` **9.3 seconds
later** — the switch is not instantaneous and the pair brackets it.

Two measured wrinkles for whoever takes the `PostModelSwitch` unlock (D2):

1. **`PreModelSwitch` fired TWICE for one switch**, 103ms apart, byte-identical
   payloads. A consumer must be idempotent.
2. The second switch this arm attempted (`/model opus[1m]`) never reached the
   composer — grid-verified false before its CR — so only ONE pair is on the
   record. The duplicate-`Pre` observation is from a single switch and has not
   been reproduced.

DELIBERATELY NOT WIRED. This is the registered unlock's evidence (F19/F22:
"confirm a mid-session switch against the MIRROR, not the stream"), and D2 puts
the unlock in its own slice. The union documents the events; the injection list
does not take them.

## F36 — the strict-JSON stdout premise, corrected and pinned

The brief carried "2.1.248 makes malformed hook stdout a HARD error". Measured at
2.1.258, that is **half true, and the half matters**.

The parse function (`I5e`, quoted verbatim in the h2 capture) classifies:

| output | verdict |
|---|---|
| `""` / whitespace / anything not starting with `{` | plain text — benign |
| `{`-leading that does NOT end with `}` | plain text — benign |
| a valid JSON object | parsed |
| `{`-leading, ends with `}`, does NOT parse | **`validationError`** |
| several JSON documents | **`validationError`** |

`validationError` has two consumers in the bundle: one yields a
`hook_non_blocking_error`, the other **`throw`s**. So it is a hard error on one
path and a loud non-blocking one on the other.

LIVE, eight classes through `claude -p --output-format stream-json --verbose`,
one per run, each emitted by a `SessionStart` hook. The CLI's own `hook_response`
message is the verdict:

| class emitted | `outcome` | session |
|---|---|---|
| `""` | success | ok |
| `"  \n "` | success | ok |
| `hello from a hook` | success | ok |
| `{"hookSpecificOutput":{"hookEventName":"SessionStart"` | success | ok |
| `{"hookSpecificOutput":{"hookEventName":"SessionStart"}` | **error** | ok |
| `{"sonata":"observer","note":1}` | success | ok |
| `{"continue":true,"suppressOutput":true}` | success | ok |
| `{"continue":true}\n{"continue":true}` | **error** | ok |

Both error arms carried the CLI's own message — *"Hook output looks like a JSON
object but is not valid JSON — JSON Parse error… Emit the payload with a JSON
encoder"* — and, on a fire-and-forget event, **the session still succeeded**
(exit 0, result `OK`). So on the observation channel the failure is visible and
non-fatal; the `throw` site belongs to the decision channel.

One prediction of the static read was WRONG and the live arm caught it: the
JSON-lines escape hatch (`wJo`) also requires each line to be schema-invalid or
to validate to an EMPTY object, so two `{"continue":true}` lines are **not**
excused. The classifier in the probe was corrected to match, and the live arm is
recorded as the authority.

## F37 — Sonata's own hook stdout: audited, one real defect found

Every reachable path of the REAL dist scripts, run as real processes, under BOTH
plain node and the production `ELECTRON_RUN_AS_NODE=1` shape:

- **`hook-sink.js` writes ZERO stdout bytes on all nine paths** — normal payload,
  empty stdin, whitespace-only stdin, malformed stdin, missing argv, ENOTDIR
  target, EACCES parent, a 1 MB payload, invalid UTF-8. Immune by construction.
  Neither interpreter greets stdout either.
- **`approval-broker.js` writes stdout on exactly one path** (`answer()`), and
  writes the reply file's bytes verbatim. All six silent paths — missing argv,
  `AskUserQuestion`, empty stdin, malformed stdin, unwritable control dir,
  timeout — measured at zero bytes, which is what makes the native-panel fallback
  graceful.

**THE DEFECT.** `process.stdout.write(decision); process.exit(0)` on macOS is an
async pipe write followed by an immediate exit. A 4 MB decision was **truncated
at exactly 65536 bytes — one pipe buffer — under both interpreters.** A
truncation that lands mid-string is silently discarded as plain text and the
user's answer is simply LOST; a truncation that happens to land on a `}` is
2.1.258's hard `validationError` path.

Reachability today is LOW and stated as such: production decisions are 91–229
bytes (`allow`, `deny`, `approve-always` with `updatedPermissions`, all measured).
But `updatedPermissions` is an unbounded list, the failure is silent, and the fix
does not touch the protocol — so it was taken rather than registered.

FIXED in `approval-broker.ts`: `answer()` sets `process.exitCode = 0` and lets the
pending write drain (the poll interval is already cleared and stdin has ended, so
nothing else holds the loop), both call sites `return`, and a `stdout` `error`
handler exits 0 so a dead read end can never turn into stderr noise on a channel
the broker promises never to write. Pinned by
`app/tests/smoke/hook-stdout-contract.mjs`, whose 4 MB case was A/B-verified:
**FAILS `65536 !== 4000102` against the pre-fix dist, passes after.**

The EPIPE guard is the one path the drain fix CREATES (review round 1, M3): with
the process no longer exiting before its write completes, a vanished reader now
surfaces as an `error` event on stdout instead of being outrun. The smoke covers
it directly — destroy the child's stdout mid-hold, then answer, and assert exit 0
with empty stderr, for both brokers.

**THE TWIN — fixed in review round 1 (M1).** The codex broker shim
(`BROKER_SHIM_SOURCE` in `codex-runtime-settings.ts`) carried the byte-identical
`process.stdout.write(decision); process.exit(0)` shape. It was out of SL-9's
original file boundary and recorded as a follow-up; the fence was extended for
the review round and the fix is mirrored. `hook-stdout-contract.mjs` now
MATERIALIZES both codex shims through the production writer and runs every case
against all FOUR shipped commands — the codex broker A/B'd at the identical
65536-byte truncation. Details: codex findings C23.

## F38 — `updatedPermissions` still validates at 2.1.258 (MEASURED end-to-end)

The other half of "is our stdout valid" is whether the CONSUMER accepts it, which
only a real approval can answer. A production spawn with the **real broker**
(`approvalBroker: true`), answering a `Write` permission request with Sonata's
own `approve-always` JSON:

```json
{"hookSpecificOutput":{"hookEventName":"PermissionRequest",
  "decision":{"behavior":"allow","updatedPermissions":[
    {"type":"addRules","rules":[{"toolName":"Write"}],
     "behavior":"allow","destination":"session"}]}}}
```

Ground truth is the FILE: `hello.txt` was written with contents `hi`, one
`answered-<id>.json` audit marker, `PostToolUse` fired, the turn closed on `Stop`.
**No schema drift.** (Method note: with the broker ON, production suppresses the
native approval scrape, so `approval:detected` never arrives and `sendApprove`
has nothing to answer — the arm has to walk the trust dialog off the grid itself.
The first run of this arm timed out at the trust screen for exactly that reason.)

## F39 — `additionalContext` is structurally unreachable for Sonata

Brief objective 5. Measured, three ways:

1. `grep -rn additionalContext app/src app/tests` → **zero hits**.
2. The sink writes zero stdout bytes on every path (F37), so it cannot emit any
   hook-output field at all.
3. The broker's only stdout is `hookSpecificOutput.decision`; neither
   `brokerDecisionJson` nor `codexBrokerDecisionJson` has an `additionalContext`
   key.

So the per-hook `additionalContext` budget cannot bind on anything Sonata emits.
Incidentally: **`additionalContextLimit` does not exist in the claude 2.1.258
binary at all** (needle absent) — only `hookSpecificOutput.additionalContext`, the
output field. The config key by that name is CODEX's (see the codex findings).
No action.

## F41 — INCIDENT (owned): this probe changed the user's real default model

**Cause: mine.** `h1-hook-census.mjs` arm `c1-census`. Not SL-11.

The ModelSwitch pair has exactly one trigger, a real `/model` switch, and a
`/model` switch PERSISTS the new default into `~/.claude/settings.json`. The arm
drove `/model haiku` against the **REAL** config dir and left it there.

**Correlation, to the second:**

| | local time |
|---|---|
| arm `c1-census` t0 (derived: ranAt 05:21:58.543Z − last hook offset − trailing sleeps) | 01:20:28 |
| `PreModelSwitch` @12319ms / @12422ms | ~01:20:41 |
| `PostModelSwitch` @21581ms | **~01:20:50** |
| `~/.claude/settings.json` mtime | **01:20:50** |

**Real home, not isolated** — `grep CLAUDE_CONFIG_DIR h1-hook-census.mjs` → no
matches, and the arm's own payloads name the real dir:
`InstructionsLoaded.file_path = $HOME/.claude/CLAUDE.md`,
`SubagentStop.agent_transcript_path = $HOME/.claude/projects/…`. The isolation
was deliberate — an isolated `CLAUDE_CONFIG_DIR` is logged out (SL-3) and the
census is about production behaviour — but the hazard that comes with it was not
handled. `h2` never switched a model (`grep -c "/model"` → 0) and is not involved.

**Was it bracketed? NO — and the near-miss is the real lesson.** SL-4's probes
snapshot/restore; mine did not. The arm *did* attempt a UI restore
(`await session.sendSlash("/model opus[1m]")`) and that restore **silently
failed** — its own note reads `slash "/model opus[1m]" on the composer before CR:
false`. I recorded that failure in the findings as *missing measurement data*
("only ONE pair is on the record") and never asked the second question: the
switch-back that did not land was also a user setting left unrestored. Evidence
of a failed restore was sitting in my own capture, correctly transcribed, and
read only for what it cost the measurement.

**Restored** (2026-09-02 02:26:59 local):

```
before  sha256 418da051…f952e4  size 586  mtime 01:20:50   "model": "haiku"
after   sha256 c46f0ab0…335a87  size 589  mtime 02:26:59   "model": "opus[1m]"
diff    exactly one line: -  "model": "haiku",  +  "model": "opus[1m]",
```

`effortLevel` was already `"medium"` and was NOT touched (the census measured
`effort:{"level":"medium"}` live during the same arm, so it never moved —
consistent with SL-4's F20, which found the effort default does not persist here).
Nothing else in the file differs. Pre-incident value corroborated independently by
the arm's own `SessionStart` payload 24s before the switch:
`model: "claude-opus-5[1m]"`.

**Fixed in the probe, not just apologised for.** `h1` now snapshots
`~/.claude/settings.json` before any arm and writes the bytes back in a `finally`
(and on `SIGINT`/`SIGTERM`), then VERIFIES the bytes match and prints a loud
`[settings guard]` line naming the changed keys. The slash switch-back is
demoted in the code to "a second pair for the record", explicitly not the restore
— a restore driven through a composer has a failure mode, a restore of a file
does not. The guard is exercised end to end by `--self-test`
(`SONATA_PROBE_SETTINGS_PATH` points it at a throwaway copy), which reproduces
this exact mutation and reverses it:

```
[settings guard] the probe changed ~/.claude/settings.json (model: "opus[1m]" → "haiku") — restored: true
{ "mutationLanded": true, "guard": { "mutatedByProbe": true, "restored": true,
  "changedKeys": ["model: \"opus[1m]\" → \"haiku\""] },
  "bytesBackToOriginal": true, "pass": true }
```

**For the program, not just this probe:** any arm that drives `/model`, `/effort`
or a picker against the real config dir mutates the user's durable settings.
SL-4 knew this and bracketed; the knowledge lived in a report rather than in the
harness, so the next probe re-learned it the expensive way. The bracket belongs in
the canonical `driver.mjs` at SL-13, not re-implemented per probe.

## F40 — evidence files

`h1-hook-census.mjs` (carries the F41 settings guard; `--self-test` exercises
it) + `h1-hook-census.capture.txt` ·
`h2-hook-stdout-audit.mjs` + `h2-hook-stdout-audit.capture.txt`. Both sanitize
`$HOME` and the munged `-Users-<user>-` form; probe cwds are under
`/private/tmp/sonata-sync-2026-09/`. `spikes/` is gitignored by the code repo —
these need `git add -f`.

**BUILD PROVENANCE, stated because the worktree was shared.** These probes drive
`app/dist/`, and the SL-9 sibling was editing the same tree throughout. What is
established: all three captures were written at 03:16:55, 03:35:52 and 03:38:31,
and `dist/` was rebuilt at **03:40:14** — *after* the last of them — so no capture
here contains output from that build. The build in use was the one observed at
02:46, whose modified files were `runtime-controller.ts`, `approval-broker.ts`,
`cli-state.ts`, `hook-sink.ts`, `codex-runtime-settings.ts` and `cli-signal.ts`;
of the four modules these probes actually construct (`TerminalHost`,
`HookWatcher`, `claude-runtime-settings`, `hook-sink`) only `hook-sink.ts` was
among them, and its diff was COMMENT-ONLY — a doc block, 12 insertions, zero
behavioural lines. `terminal-host.ts` was NOT modified at that point (it is now).

What is NOT established, and is recorded rather than smoothed over: `dist/` mtime
was sampled twice, not continuously, so an intermediate rebuild between 02:46 and
03:40 cannot be excluded retroactively. The one continuity check available is
that z2a re-measured SL-2b's shipped stopless closer at **Esc+32532ms**, matching
that slice's committed figure (32532/32509/32519) exactly — consistent with an
unchanged terminal-host, though not proof of one. Any re-run of these probes
should re-state its own build provenance rather than inherit this one.

---

# SL-12 — spontaneous resumption (decision D1)

Probed 2026-09-02, binary pinned `2.1.258 (Claude Code)` at the start AND end of
every run (no drift). Probes: `z1-background-wake.mjs`, `z2-esc-resume-scope.mjs`,
`z3-usage-limit-continue.mjs`. Woody's D1 ruling is **model revival, do not
suppress it**, so this slice is a MEASUREMENT slice: it establishes the signal
shapes and ships no model. No production file was changed (see F47's closing
note for why none of the measured shapes was a trivial fit).

Evidence labels used below: **MEASURED** = observed in a run recorded in a
capture; **STATIC** = read out of the 2.1.258 bundle; **UNREPRODUCED** = looked
for and not produced.

## F42 — shape (a) REPRODUCES ON DEMAND, and the closing `Stop` already announces it (MEASURED)

SL-2b's field sighting is now a repeatable measurement. A turn that backgrounds a
shell and then ends is revived by the shell's completion, with no user and no
Sonata write:

| run | `Stop.background_tasks` at turn end | woke | UPS after Stop | wake `Stop` after first |
|---|---|---|---|---|
| z1a r1 | `[{shell, running}]` | yes | +68899ms | +70729ms |
| z1a r2 | `[{shell, running}]` | yes | +69011ms | +70537ms |
| z1a r3 | `[{shell, running}]` | yes | +68961ms | +70688ms |
| z1a r4 | `[{shell, running}]` | yes | +68547ms | +71490ms |
| z1b (foreground control) | `[]` | **no** | — | — |

The wake tracks the shell's own duration (a 70s sleep → ~69s), not a timer of the
CLI's own, and the foreground control neither carries a background task nor wakes
in 150s.

**The finding that matters is not that it wakes — it is that the CLI SAYS SO IN
ADVANCE.** `Stop` carries two fields Sonata does not read:

```json
"background_tasks": [
  { "id": "b9jgkbotw", "type": "shell", "status": "running",
    "description": "Sleep 70 then echo", "command": "sleep 70; echo BGDONE" }
],
"session_crons": []
```

and the binary's own schema states the intent verbatim (STATIC):

> `background_tasks` — "In-flight background work (running/pending + backgrounded)
> registered in this session. **Lets hooks distinguish 'session is done' from
> 'session is paused waiting for background work to wake it'.** Empty array when
> nothing is in flight."
> `session_crons` — "Session-scoped cron tasks (CronCreate, ScheduleWakeup,
> /loop) that will wake this session later. Empty array when none are scheduled."

The discriminator is clean in both directions in the SAME arm: the closing `Stop`
reads `[{…, "status":"running"}]` and the post-wake `Stop` reads `[]`. So the
question "is this turn end final?" is ANSWERED on the payload Sonata already
receives, at the moment it already acts — no new event, no scrape, no timer.

`SubagentStop` carries both fields too (MEASURED, same keys).

## F43 — the wake is NOT reliably ANNOUNCED: 1 of 9 revivals fired no `UserPromptSubmit` (MEASURED)

Across 9 completed z1a watches, 8 revivals arrived as `UserPromptSubmit` → turn →
`Stop`. One did not: the CLI ran the revived turn and closed it with a `Stop` carrying
`last_assistant_message: "The background command completed (exit 0)."`, and no
`UserPromptSubmit` hook reached the watcher at all. Its hook order:

```
SessionStart@638, UserPromptSubmit@3384, PreToolUse@6122, PostToolUse@6223,
Stop@7334, SubagentStop@8862, Notification@67444, Stop@77814,
SubagentStop@79342, Notification@137869
```

That run's transcript, read back from `~/.claude/projects`, shows the injected
turn was there and was ordinary:

```
user      | promptSource: typed   | Use the Bash tool with run_in_background …
assistant |                       | STARTED
user      | promptSource: system  | <task-notification> <task-id>byls6yhty …
assistant |                       | The background command completed (exit 0).
```

So the CLI **did** inject the turn; the hook is what went missing. Two candidate
causes are EXCLUDED by measurement: a filename collision in the sink (names are
`Date.now()`-base36 + `hrtime.bigint()` + pid, collision-free by construction) and
a watcher read error (`onError` recorded nothing that run). Whether the CLI
skipped the hook or the sink failed silently (it swallows every error by design)
is **UNRESOLVED** — it did not recur in 7 subsequent runs.

**Consequence for the modeling slice: a revival detector keyed on the wake is
keyed on a channel with a measured miss.** A detector keyed on the CLOSING `Stop`
(F42) has no such gap — the field is on the payload that already arrives, before
the wake exists. Predict the revival; do not detect it.

## F44 — `UserPromptSubmit.source` is specified and NOT EMITTED at 2.1.258 (STATIC + MEASURED)

The binary's schema declares exactly the discriminator this slice went looking
for (STATIC, verbatim):

```
source: enum(["user","sdk","system","loop_wakeup","schedule_wakeup","poll_event"]).optional()
  "Who authored/injected the prompt: `user` = submitted from the interactive
   composer, `sdk` = non-interactive entrypoint (`-p` / Agent SDK),
   `loop_wakeup` = dynamic /loop wakeup, `schedule_wakeup` = scheduled-task fire
   (CronCreate/routine), `system` = other machine-injected turns (peer/channel
   messages, task notifications, auto-continuation), `poll_event` = …
   Payloads may omit it while the field rolls out."
```

MEASURED at 2.1.258: **the field is absent.** Every `UserPromptSubmit` observed in
this slice — human-submitted and self-submitted alike — carried exactly

```
cwd, hook_event_name, permission_mode, prompt, prompt_id, scratchpad_dir,
session_id, transcript_path
```

with no `source` key. The schema's own "payloads may omit it while the field rolls
out" is the CLI describing this state.

Two things follow. First, **Sonata cannot key on `source` today**, and when it
does arrive it must treat ABSENCE as unknown, never as `user` — the enum's roll-out
clause makes the missing case indistinguishable from a human submit. Second, the
value that will identify every revival shape in this dossier is the same one:
`system` covers "task notifications" (F42) and "auto-continuation" (F46) in one
label, which is upstream saying these are one family.

The discriminator that DOES exist today is the prompt TEXT (`<task-notification>`)
and the transcript's own `promptSource: "system"` — and Sonata already recognizes
the former by prefix (`terminal-host.ts:2431`, run title "(background task
returned)"), which is why the wake gets a name but not a different lifecycle.

## F45 — shape (b): user Esc is EXEMPT from auto-resume, and the exemption is STRONGER than the hypothesis (MEASURED)

Woody's D1 hypothesis — "user Esc is exempt; the CLI needs Esc to stick too" — is
**CONFIRMED**, and the measurement bounds it more tightly than the hypothesis did.

**z2a, live Esc through the production `TerminalHost`.** A streaming turn was
Esc'd and then nothing was written for 180s:

- hooks in the whole window after the Esc: **`[]`** (SL-2b's "Esc fires no hook"
  re-confirmed at 2.1.258). Note what is missing besides a resume: no
  `Notification(idle_prompt)` either, across the full 180s — where the z1 runs
  saw one 60s after every ordinary `Stop`. That corroborates SL-2b's reading that
  the idle notification is anchored to a turn END and never follows a Stop-less
  ending, now with a 3× longer window than that slice used
- bytes painted after the Esc: 512, all of it the interrupt's own repaint
- transcript after the window: ends at `[Request interrupted by user]`, nothing
  after it; no resume prompt anywhere
- Sonata closed the run at **Esc+32532ms** via SL-2b's `stoplessTurnEndConfirmed`
  — matching that slice's measured 32.5s exactly, on a live re-run

**z2b / z2c, the restore contrast.** A session was driven to a genuine
user-interrupted transcript (1 × `[Request interrupted by user]`, verified before
each restore), killed, and reopened with `claude --continue` — twice, differing in
one variable:

| | z2b `--continue` | z2c `--continue` + `CLAUDE_CODE_RESUME_INTERRUPTED_TURN=1` |
|---|---|---|
| interruption markers restored | 1 | 1 |
| the restore actually restored the history | true | true |
| unprompted activity in 90s | none | none |
| bytes painted after boot | 0 | 0 |
| **auto-resumed** | **false** | **false** |

So it is not merely that Sonata never sets the flag: **forcing the crash-respawn
flag onto a user-interrupted transcript still produces no resume.** The exemption
is in what the CLI is willing to resume, not only in who sets the variable.

`z2d` is the control that makes z2c's negative readable at all: macOS refuses to
show another process's environment (`ps eww` returns the command line and no
`KEY=value` pairs, MEASURED), so the override's arrival was demonstrated instead —
a `/bin/sh` spawned through the identical `EnvProbe` path with the identical
overrides echoed `SEEN:[1]`. This proves delivery to a child of that spawn; it
cannot prove the CLI read the variable, so z2c's claim stays scoped to "set on the
spawn", which is the only lever anything outside the CLI has.

**Why the CLI behaves this way (STATIC, the map that z2 was built to test).**
`CLAUDE_CODE_RESUME_INTERRUPTED_TURN` is not a user setting and not a default. It
is set by the CLI on ITS OWN child at exactly two sites — the cloud-runner session
spawner when the worker epoch is > 1, and the background-session PTY manager on a
retry attempt (`this.attempt > 1`) — and it travels in `lme`, the `CLAUDE_BG_*`
family the CLI scrubs out of what it spawns. It is read in one place, only while
restoring a transcript into a fresh process, under a debug line that names the
case: `[sessionRestore] Auto-resuming interrupted turn for bg crash-respawn`.

**Consequence: shape (b) is not a risk on Sonata's path and needs no model.** The
brief's premise that interrupted-turn auto-resume is "default on" is CORRECTED: it
is default-on *for background/cloud crash respawn*, which is not a shape Sonata's
interactive pty spawn can enter. D1's "only act if user-Esc turns out covered" is
answered: it is not covered.

## F46 — usage-limit auto-continue: ON for this account, and UNREPRODUCIBLE by design

**The setting (MEASURED).** Read off the live `/config` panel through the
production spawn, Down-and-Esc only (Left/Right cycle enums and Enter toggles, so
neither was ever sent):

```
     Continue automatically at usage limit      true
```

**It is ON for the daily driver's account.** And it is not a file setting: the key
`autoContinueAtUsageLimit` is **absent from `~/.claude/settings.json`** (MEASURED),
because the value is account/storage-scoped — `/config`'s `onChange` awaits a
remote write and can return an error, and the read falls back to
`autoContinueKeyPresence === "absent"`, i.e. **default TRUE when unset** (STATIC).
So Sonata cannot learn this setting's state from disk the way it reads `model`.

**Field evidence: NONE.** 981 transcripts across 811 project directories hold none
of the 8 episode literals (the two continuation prompts and six banner strings),
with this investigation's own transcripts excluded — an exclusion that is
load-bearing rather than tidy, since the first pass matched only this probe
quoting the literals while writing them down. So: no past episode on this machine
to mine, and the class is **dogfooding-watch only** until one occurs.

**The fire path is NOT MEASURED, by anyone, here.** Provoking it means exhausting
the account's quota to observe one banner. Per the brief's stop-and-report rule
that cost was not paid. What follows is STATIC, from the 2.1.258 bundle.

The episode is a three-phase state machine (`phase: "idle" | "armed" | "stale"`):

- **arm** — on a rejected quota with a `resetsAt`, either from the dialog or
  automatically (`origin: "auto"`) when the reset is inside a 24h horizon.
- **fire** — at `resetsAt + jitter`, jitter uniform in **30–90s**; on a re-arm add
  a 60s then 300s backoff, capped at **2 consecutive re-arms**. Firing calls one
  function, and this is the whole revival:

  ```js
  QS({ mode: "prompt", value: L, uuid: n,
       origin: { kind: "auto-continuation" }, isMeta: true,
       skipSlashCommands: true, … })
  ```

  where `L` and the early-fire variant `Z` are fixed literals:

  - `L` — "Your claude.ai usage limit has reset. Continue the task you were
    working on when the limit was reached; do not repeat work that is already
    complete."
  - `Z` — "Your claude.ai usage is available again before the usage-limit reset.
    Continue the task you were working on when the limit was reached; do not
    repeat work that is already complete."

- **stale** — if the machine slept through the reset, it does NOT fire; it paints
  "Usage limit has reset · press enter to continue" and waits for the user.

**Every phase transition also emits an OS notification through `Ov`, which is the
same dispatcher `idle_prompt` uses** — and `idle_prompt` is MEASURED reaching
Sonata's `Notification` hook this slice (F42's runs, `notification_type:
"idle_prompt"` at Stop+60s). The `Notification` hook's schema is
`{hook_event_name, message, title?, notification_type}`, and the notification-type
enum includes three quota members (STATIC):

```
quota_auto_resume_fired, quota_auto_resume_stale, quota_auto_resume_disabled
```

with messages "Usage limit available — Claude is continuing your task",
"Usage limit reset — press enter to continue", and the disabled/stopped family.

**So the usage-limit revival is already on Sonata's wire.** `Notification` is in
production's injected hook set (h1 MEASURED: `Notification, PermissionRequest,
PostToolUse, PreToolUse, SessionStart, Stop, StopFailure, SubagentStop,
UserPromptSubmit`), and `cli-state.ts:85-92` already reads `notification_type` —
it branches on `permission_prompt` and `idle_prompt` and falls through on
everything else. The three quota values would arrive today and be dropped. This
is the cheapest signal in the dossier: **no injection change, no new channel, one
unhandled enum**. It is STATIC-only until an episode occurs, which is precisely
why it belongs in the modeling slice's design rather than in a patch now.

Two smaller measured facts for SL-13's inventory:

- **`/rate-limit-options` is not in the enumerated slash pool.** The CLI's own
  banners tell the user to run it ("Automatic continue cancelled ·
  /rate-limit-options to re-arm"), but SL-10's two enumerations (s1 pool, s4 help)
  contain zero occurrences, so it is conditional/hidden — registered only while an
  episode is live. Sonata's slash registry therefore cannot offer it, correctly.
  `/usage-credits`, which the same banners reference, IS in both the CLI pool and
  `app/src/shared/slash/builtins.ts:307`.
- An armed episode is wired INTO the idle-notification machine
  (`hasArmedQuotaAutoResume` is passed to the idle-notif state object, STATIC), so
  the idle channel's behaviour during an episode is not the same as its behaviour
  outside one. Relevant to SL-2b's `stoplessTurnEndConfirmed`, which consumes the
  run-raw idle verdict.

## F47 — THE DOSSIER: where Sonata's model lies today (design input for the modeling slice)

One table per measured shape: the signal, the consumer it maps to, and the lie.
Consumer locations are from a read-only survey of `app/src` at this commit;
line numbers were re-verified after the survey and are stated for the tree as
measured — the SL-9 sibling is editing `runtime-controller.ts` in the same
worktree, so prefer the symbol names over the line numbers if they disagree.

### Shape (a) — background-task revival · MEASURED, REPRODUCIBLE, LIVE TODAY

| | |
|---|---|
| **Signal to key on** | `Stop.background_tasks` non-empty (and `session_crons` non-empty for the `/loop`/cron sibling) — present on the payload Sonata ALREADY receives, at the moment it already acts |
| **Consumer** | the completion latch: `runtime-controller.ts:2770` → `terminalHost.completeRunFromTurnEnd()` (`terminal-host.ts:4359`) |
| **Why it lies** | `completeRunFromTurnEnd()` **is handed no part of the `Stop` payload** — the controller calls it bare (`runtime-controller.ts:2770`). It finishes the run `"completed"` with `completionSource:"hook-stop"`, `completionConfidence:"high"` while the same payload says a shell is still running and will wake the session. The card reads done, at the highest confidence the system has, and then the transcript grows. |
| **Second lie** | `NotificationPolicy.onCliState` (`notification-policy.ts:110-140`) fires `{kind:"complete"}` on the turn end, then the revival re-enters `busy` and **re-arms** it, so a single user request produces a second "task complete" notification 30s+ later |
| **Third lie** | `beginRunFromHook` (`terminal-host.ts:2376`) never reopens a finished run: past its 5s text-identity echo window it mints a **brand-new run** (`run:started`, MEASURED at +69s in all four z1a runs), indistinguishable in the run index from a human typing in the pane |
| **Partial credit** | Sonata already special-cases the prompt text `<task-notification>` (`terminal-host.ts:2380`) and gives the run the title "(background task returned)". So the revival is NAMED but not MODELLED — same lifecycle, same notification, same completion story |
| **The honest fix's shape** | `Stop` needs to stop meaning one thing. A turn end with in-flight background work is not `completed`; it is a state the run model does not currently have. That is a lifecycle change, not a field read — which is why it is the modeling slice and not this one |

### Shape (b) — interrupted-turn auto-resume · NOT A RISK

Measured exempt in all three arms (F45). No consumer, no model, no change.
Worth one inventory line so it is not re-raised: the mechanism is bg/cloud
crash-respawn, and Sonata's interactive pty spawn cannot enter it.

### Shape (c) — usage-limit auto-continue · STATIC ONLY, SETTING ON, UNOBSERVED

| | |
|---|---|
| **Signal to key on** | `Notification.notification_type ∈ {quota_auto_resume_fired, quota_auto_resume_stale, quota_auto_resume_disabled}` — already injected, already parsed, currently dropped |
| **Consumer** | `cli-state.ts:85-92`, the only reader of `notification_type`; it knows `permission_prompt` and `idle_prompt` and falls through on the rest. `applyHookToTask` has no `Notification` branch at all, so a Notification never reaches the run state machine |
| **Why it would lie** | `_fired` means a turn is starting with no user input — the same third lie as shape (a) (a new run, a re-armed notification). `_stale` is the opposite failure and the more user-hostile one: the CLI is **waiting for the user to press Enter** and nothing in Sonata says so, so the task sits silently parked. `_disabled`/cancelled means the task will NOT resume — the user's mental model is "it will pick up at the reset", and nothing corrects it |
| **Timing to design against** | fire is `resetsAt + 30–90s` jitter, re-arm backoff 60s then 300s, hard cap 2 re-arms, 24h horizon (STATIC) |
| **Blocked on** | an actual episode. No field precedent on this machine (981 transcripts). Dogfooding-watch: the two continuation literals in F46 are exact and greppable |

### The cross-cutting one

**`UserPromptSubmit` is the wrong place to hang any of this.** It is the channel
with the measured miss (F43, 1/8), its `source` discriminator is specified but not
emitted (F44), and when `source` does ship, absence must read as unknown rather
than `user`. Both revival families are better served by the signals that are
already complete: `Stop.background_tasks` for shape (a), `Notification.
notification_type` for shape (c).

**Why no production code changed in this slice.** The brief allowed a change only
where a measured shape fits an existing consumer trivially. The best candidate is
F42's `background_tasks`, and it is not trivial: `completeRunFromTurnEnd()` is handed
no part of the `Stop` payload, the controller passes none, and the useful behaviour is a run
lifecycle that can express "ended, but expected to wake" — which the run model,
the notification policy and the run index would all have to agree on. Wiring the
field without that state would only move the lie. Reported, not built.

## F48 — evidence files

`z1-background-wake.mjs` + `z1-background-wake.capture.txt` (4 wake runs + the
foreground control) · `z2-esc-resume-scope.mjs` + `z2-esc-resume-scope.capture.txt`
(live Esc, the `--continue` contrast pair, the env-plumbing control) ·
`z3-usage-limit-continue.mjs` + `z3-usage-limit-continue.capture.txt` (the live
`/config` row, the field-evidence sweep). All three carry the F41 user-settings
guard (snapshot + unconditional restore + signal handlers + `--self-test`); every
run reported `mutatedByProbe: false`, and `~/.claude/settings.json` was verified
unchanged after the slice (`model: opus[1m]`, 10 keys). Captures sanitize `$HOME`
and the munged `-Users-<user>-` form; probe cwds are under
`/private/tmp/sonata-sync-2026-09/`. `spikes/` is gitignored by the code repo —
these need `git add -f`.

**BUILD PROVENANCE, stated because the worktree was shared.** These probes drive
`app/dist/`, and the SL-9 sibling was editing the same tree throughout. What is
established: all three captures were written at 03:16:55, 03:35:52 and 03:38:31,
and `dist/` was rebuilt at **03:40:14** — *after* the last of them — so no capture
here contains output from that build. The build in use was the one observed at
02:46, whose modified files were `runtime-controller.ts`, `approval-broker.ts`,
`cli-state.ts`, `hook-sink.ts`, `codex-runtime-settings.ts` and `cli-signal.ts`;
of the four modules these probes actually construct (`TerminalHost`,
`HookWatcher`, `claude-runtime-settings`, `hook-sink`) only `hook-sink.ts` was
among them, and its diff was COMMENT-ONLY — a doc block, 12 insertions, zero
behavioural lines. `terminal-host.ts` was NOT modified at that point (it is now).

What is NOT established, and is recorded rather than smoothed over: `dist/` mtime
was sampled twice, not continuously, so an intermediate rebuild between 02:46 and
03:40 cannot be excluded retroactively. The one continuity check available is
that z2a re-measured SL-2b's shipped stopless closer at **Esc+32532ms**, matching
that slice's committed figure (32532/32509/32519) exactly — consistent with an
unchanged terminal-host, though not proof of one. Any re-run of these probes
should re-state its own build provenance rather than inherit this one.

# SL-16 — revival modeling: "ended, expecting wake" (built 2026-09-02, binary 2.1.258)

The modeling slice F47 was the design input for. SL-12 measured the signal and
shipped nothing; this ships the model and verifies it LIVE (probe `z4`).

## F49 — the emitted `background_tasks` array is ALREADY the pause (STATIC, decisive for the design)

The one static read this slice needed, and it removed a design question rather
than adding one. `Stop`'s array is built by a filter that runs BEFORE emission
(2.1.258 bundle, verbatim):

```js
function tm(e){
  if(e.status!=="running" && e.status!=="pending") return false;
  if("isBackgrounded" in e && e.isBackgrounded===false) return false;
  return true;
}
```

So every entry that reaches a hook is, by the vendor's own definition, in-flight
backgrounded work. Sonata therefore does NOT re-filter on `status`: re-deriving a filter it can read would be
second-guessing upstream with a copy that can drift. The `type` values are mapped
through the bundle's own label table (`local_bash→shell`, `local_agent→subagent`,
`local_workflow→workflow`, `monitor_mcp`/`monitor_ws→monitor`,
`mcp_task→MCP task`, `in_process_teammate→teammate`, `dream`,
`auto_mode_scan→auto-mode scan`, `remote_agent→cloud session`) — recorded
verbatim on the run, because "waiting on WHAT" is the durable diagnostic and an
unrecognised future kind must survive rather than be flattened.

**CORRECTED BY F56 (review B1):** this finding's first write-up concluded
"non-empty IS the pause declaration", and that inference was WRONG — the same
schema sentence says the array is registered *in this session*, so it is session
state and a long-lived task sits in it forever. Membership is a vendor fact;
the PAUSE is a per-turn question the array alone cannot answer. See F56.

`session_crons` is built beside it (`{id, schedule, recurring, prompt}`) and is
**deliberately NOT a pause.** The vendor's two descriptions differ exactly where
it matters: background work leaves the session "PAUSED waiting … to wake it",
a cron merely "will wake this session later". A standing schedule is not a paused
turn — a session with a daily cron is DONE for today, and folding it in would
suppress the completion notification of every turn that session ever runs.

## F50 — what shipped, and why `RunStatus` was NOT widened

Woody's intent was a card that is honest — "ended, but expected to wake", neither
"done" nor "still working". The obvious reading of F47's "a state the run model
does not currently have" is a new `RunStatus` member. **Rejected on a survey of
its consumers**, and the survey is the finding: there is no exhaustive `switch`
on `RunStatus` anywhere in the tree. Every consumer is an if-chain or a hardcoded
string array with a silent default, so a new member compiles clean and does the
WRONG thing in seven places at once — `taskStatusFromRunStatus` → `idle`,
`isPendingTurnEnd` → broker approvals and option prompts never released,
`status-region-tracker`'s terminal-status array → the liveness clock runs
forever, both `completionSourceForStatus`/`completionConfidenceForStatus`
fallbacks, `runTone` → an unstyled class, `runOutcome` → "Claude is working" on an
ended run — plus two allowlist guards that would silently drop work.

And none of those seven wants a different answer than `completed` already gives.
The turn DID end: the model stopped, the composer came back, the user can type.
So SHIPPED is a SECOND AXIS beside the status — `PendingWake {tasks:[{id,kind}]}`,
optional, stamped only by a turn end that left NEW work behind (the ids are what
make that diffable — F56):

- `status` stays `completed`, `completionSource` stays `hook-stop`, and
  `completionConfidence` stays **`high`**. Demoting the confidence was considered
  and rejected: that axis answers "how sure are we the turn ended?", and the Stop
  hook is exactly as authoritative as it ever was. Answering a different question
  on it would corrupt a well-defined axis.
- A new `CompletionSource` member was also rejected — the source names WHICH hook
  ended the turn, and it was `Stop`. Orthogonal axes stay orthogonal.
- Additive in-place widening at v1 (the tree's established practice, and the only
  safe one: a version bump DISCARDS every user's run history — `readExistingReport`
  returns a fresh report on any mismatch, with no migration path).

## F51 — the notification: held, not cancelled, and it is the approval rule again

Before: one request produced TWO "task complete" pings (F47, measured 4/4) — one
at the pause, false, and one ~70s later at the real end. Options weighed: ping at
the pause with a background-work flavour (still two), ping only at the pause, or
hold. **HELD**, because a notification's job is "your turn", and at the pause
nothing is being asked of the user and the work they asked for is not finished.

The shape it took is the one the policy already had: re-entering `busy` from
`waiting-approval` deliberately does NOT reset the turn clock, because "a turn
with an approval is a long turn". A turn with a background wake is a long turn,
same principle, same code. So the arc stays ARMED across the pause and the clock
keeps running from the ORIGINAL submit — which is right, because the whole paused
stretch is time the user was away. One arc, one ping, at whichever turn end is
genuinely final.

Two scopes had to be kept APART, and merging them would have cost the user a
notification: the ARC is held, but the TURN is not. `notifiedAsks` is turn-scoped
by its own contract, so the wake clears it — an approval raised after the wake is
a new question, even when its fingerprint matches one from before the pause.

**RESIDUAL — and the FIRST write-up's bound was self-cancelling, corrected in
F56.** It claimed "a later turn end on that task still fires", which is only true
if the background task VANISHED — i.e. exactly not the never-wakes case the bound
was supposed to cover. With F56's growth scoping the residual is genuinely
bounded and much smaller: only the ONE turn that launched never-returning work
loses its ping; every later turn in that session pings normally, because none of
them opened anything. A dead PTY drops the arc.

## F52 — attribution, and the F43 gap resized rather than closed

`revivalOf: RunId` on the revived run — the run model finally agreeing with the
"(background task returned)" title the reading surface has shown since
2026-07-02. Two terms, and the conjunction is load-bearing (A/B'd: dropping the
prompt term fails its pin): the `<task-notification>` prefix proves the turn is
machine-injected — the ONLY discriminator that exists at 2.1.258, since F44's
`source` is specified and unemitted — and an awaited wake proves there was
something to return from. A prompt the USER types during a pause satisfies only
one and correctly gets an ordinary run.

NO EXPIRY on the awaited pointer: the wake tracks the background job's own
duration (z1: a 70s sleep → ~69s), so any timeout would be a guess that silently
unlinks the honest long cases. It is cleared only by evidence — the revival
consuming it, a later turn end reporting `background_tasks: []`, or a fresh spawn.

**F43 (1 of 9 wakes fires no `UserPromptSubmit`) is HANDLED where it can be and
REGISTERED where it cannot.** What it gives: the revived turn's own `Stop` carries
an EMPTY array, which is positive evidence on the same field and the same channel
— no wake detection, no heuristic. Sonata uses it twice: the held ping fires
(the cli-state change comparison had to learn `pendingWake`, or `turn-ended` →
`turn-ended` deduped it away and the ping was lost forever — A/B'd), and the
awaited pointer settles so a LATER task-notification is not back-attributed to a
wake that already happened (which is why the settle sits ABOVE
`completeRunFromTurnEnd`'s no-active-run guard — A/B'd). **What stays open**: that
revival mints no run, so it gets no card and no `revivalOf`, and the paused run's
card keeps saying "waiting on background work" after the wake has come and gone.
A `resolvedAt` stamp was designed and NOT built: it rewrites settled history to
repair a card, in the 1-in-9 shape only, and the brief's instruction was to
attribute what Stop gives and register the rest.

## F53 — the Stop-less arm and the quota sibling: two deliberate non-changes

**Esc'd-then-waking is honest by construction, and pinned.** A claude Esc fires no
hook at all (F45), so the SL-2b stopless closer runs on no payload and CLAIMS
NOTHING — no `pendingWake`, no armed pointer. A later wake therefore gets an
honest unlinked run rather than an invented connection, and that arc produces two
notifications because Sonata has two independent pieces of evidence and no
grounds to join them. The quiescence constants are untouched.

**`SubagentStop` is a documented no-op** (SL-16 objective 4, decided on evidence).
It carries the same two fields — MEASURED, z1's SubagentStop 1.5s after the parent
`Stop` named the SAME running shell — so wiring it would restate one fact twice,
and would state it at a moment when it is FALSE: a SubagentStop normally lands
mid-turn, while the session is working, and "paused waiting for background work"
is not true of a live turn. The pause belongs to the main turn's ending.

**Quota auto-resume: REGISTERED, not forced.** The brief allowed folding it in if
it were a natural fit. It is not, and the reason is F47's own cross-cutting
finding: `background_tasks` announces the PAUSE on the payload that already
arrives, while `quota_auto_resume_fired` announces the WAKE. Hanging the pause off
the wake would infer backwards from the exact channel F43 disqualified. The quota
episode's arm phase has NO measured signal on Sonata's wire at all, and `_stale`
("waiting for the user to press enter") is a `needs-you`, a different notification
kind. It needs its own design, on an episode nobody has yet observed.

## F54 — z4: the model verified LIVE end to end (MEASURED, PASS 5/5)

The smokes construct payloads by hand, so they cannot prove a real payload's
nested array survives the production hook sink and watcher. `z4` closes that loop:
real CLI → production sink → production `HookWatcher` → `readBackgroundWork` →
`TerminalHost` → `CliStateModel` → `NotificationPolicy`, with the dispatch edges
copied from what `applyHookToTask` ships today.

```
SessionStart@1556  UserPromptSubmit@4409  PreToolUse@6644  PostToolUse@6747
Stop@7863  SubagentStop@9488  Notification@68015  UserPromptSubmit@76829
Stop@78557  SubagentStop@80088
```

| claim | result |
|---|---|
| C1 the LIVE closing `Stop` reads `pending` | **PASS** — `[{id, type:"shell", status:"running", …}]` |
| C2 run closes `completed`/`hook-stop`/`high` WITH `pendingWake` | **PASS** — `{taskCount:1, kinds:["shell"]}`, statusReason `stop hook (turn ended, background work pending)` |
| C3 no `complete` notification at the pause | **PASS** — 0 decisions at Stop, where the old model fired one |
| C4 the wake's run names the paused run | **PASS** — `revivalOf: run-…-1`, title `(background task returned)` |
| C5 exactly ONE `complete`, after the pause | **PASS** — one, at 78557ms |

Wake at **+70694ms**; the post-wake `Stop` carried `background_tasks: []`, so the
same field answered `pending` and `none` in one run. Note `Notification@68015` —
the 60s `idle_prompt` — passed through the pause without cancelling it, which is
the live counterpart of the keep-on-omit rule.

Binary pinned `2.1.258` at start AND end (no drift). Settings guard ran with
`mutatedByProbe: false`, and its `--self-test` was exercised first
(`detected: true, restored: true, bytesMatch: true`).

## F55 — evidence files

`z4-revival-modeling-live.mjs` + `z4-revival-modeling-live.capture.txt` (one live
arm, five claims). `spikes/` is gitignored by the code repo — these need
`git add -f` (done). Unit fence: `app/tests/smoke/background-wake-modeling.mjs`
(23 checks across the reader, cli-state, the run lifecycle, the notification
policy and the card copy). Five separate A/Bs were run, each reverting ONE line
and rebuilding, to prove the new pins fail against the pre-fix behaviour: the
cli-state change comparison, the keep-on-omit rule, the notification hold, the
pre-guard settle placement, and the two-term revival guard. A sixth A/B corrected
an OVERCLAIM rather than confirming one — the `unstated`-is-not-`none` arm turns
out to have no live consumer that depends on it today (every current caller is
insensitive), so its comment now says so and calls itself a contract for the next
consumer rather than a live fix.

# SL-16 review round 1 (2026-09-02) — 1 BLOCKING, 1 minor, 1 pre-existing; all taken

## F56 — BLOCKING, TAKEN: `background_tasks` is SESSION state, so non-emptiness is not a pause

**The bug, and it was a REGRESSION rather than a missed improvement.** The first
cut held the completion notification, stamped the card, and armed the revival
pointer on `background_tasks` being non-empty. But the vendor's own sentence —
quoted in F49 and then under-read — says the array is "registered **in this
session**". A long-lived task (a dev server, a watcher, a `tail -f`) is
`status:"running"` for the rest of the session, so EVERY later turn end carries
it. Consequence: every completion ping for the rest of that session silently
swallowed (pre-slice, those turns pinged), and every later card stamped. Two
corroborations were available and unused: the same array rides `SubagentStop`
mid-turn, and the CLI's own footer counts it as a standing session fact.

**MEASURED LIVE (z4b, this round).** Two turns, one `sleep 600` backgrounded in
turn 1:

| | `Stop` payload | `opened` |
|---|---|---|
| turn 1 @7531ms | `pending` — `[{bjtfron51, shell}]` | `{tasks:[{bjtfron51,shell}]}` |
| turn 2 @11792ms | **`pending` — the SAME task, still there** | **`null`** |

Turn 2's raw claim is what makes the arm decisive: the array had NOT emptied, so
this is the exact shape that would have swallowed the ping. One `complete` fired
(turn 2's), one card stamped (turn 1's).

**THE FIX: the pause is a question about identity over time, so it needs memory.**
`BackgroundWorkTracker` (one per task runtime, alongside `cliState`) holds the
ids in flight as of the last turn end and answers two things per ending:

- `opened` — tasks whose ids were NOT already known. Only this may hold a
  notification, stamp a card, or arm the revival pointer.
- `returned` — a previously-known id is gone, i.e. some awaited work finished.

`PendingWake` therefore carries `tasks:[{id,kind}]` rather than a count: the ids
are the diff, and the count was the part that could not answer the question.

**SECONDARY, also taken.** The first cut held the turn CLOCK across a pause
(suppressing the `busy` reset), so a 3s prompt typed during a pause was measured
from the paused arc's original start and pinged "finished" at a user sitting
right there. Fixed by splitting the clocks rather than by another carve-out:
`turnStartedAt` always restarts (the busy branch is now byte-identical to
pre-slice), and `wakeArcStartedAt` separately remembers the unfinished request.
A turn end picks the arc's clock only when it RESOLVES the arc. This is strictly
simpler than what it replaced — the wake needs no special case at all, and the
`notifiedAsks` carve-out the first cut had to add by hand disappeared with it.

**A THIRD BUG, found by the mandatory new fence rather than by reasoning.** With
the clocks split, the disarm block still cleared `wakeArcStartedAt` on EVERY turn
end — so a user's interleaved turn consumed the arc and the eventual wake, having
lost it, measured its own ~2s turn and fired nothing. The arc now survives turn
ends that neither open nor resolve it. This is exactly the failure the reviewer
predicted the missing fence would hide: the host-layer version of this scenario
already existed and asserted only `revivalOf`, which is why the notification side
went unexamined twice.

## F57 — MINOR, TAKEN: the `StopFailure` drift, fixed structurally rather than patched

The reviewer found `runtime-controller` stamping the run record on a `StopFailure`
while `cli-state`'s own `StopFailure` branch read no payload — so that ending
emitted no pause and the double-fire this slice removes was still live on it. The
one-line fix would have been another `readBackgroundWork` call in that branch.

Taken structurally instead, because the drift was a CLASS: the tracker is
advanced ONCE in `applyHookToTask` and the same `TurnEndWake` is handed to
cli-state and to the run record, so there is no longer a second derivation to
keep in sync. cli-state gained one `endTurn` path that all three main-turn
endings (`Stop` / `StopFailure` / `Interrupt`) route through. The slice's
"these cannot drift apart" comment was FALSE when written; it is now true by
construction. `StopFailure`'s `background_tasks` presence stays UNMEASURED, which
is why both arms are pinned — field present and field absent — so the fix holds
whichever way upstream turns out to behave.

## F58 — PRE-EXISTING, TAKEN: the sidebar dot was the last surface still saying "finished"

`runtime-reducer`'s `completedUnseen` ("Finished while you were away") lit at the
pause, contradicting the card on the same run. It is one condition consulting the
same fact on the same event, so it was taken under this slice's one-honest-arc
intent rather than registered. The wake's own run lights it when the work
actually returns.

## F59 — COPY: Woody's ruling, and why the form is load-bearing

The card string is **`Waiting on background work…`** (Woody, 2026-09-02) —
replacing the first cut's "Ended, waiting on background work". Preserved
verbatim: no `Ended,` prefix, and the trailing character is a single `…` (U+2026),
not three periods. Pinned as Woody-approved wording in `ui-vocabulary-corpus`
alongside the update-pill literals, and A/B'd — swapping `…` for `...` fails the
fence.

The form is coherent with F56 rather than merely shorter: now that the state is
scoped to the turn that actually GREW the pending set, this is the one run still
owed something, and the ellipsis carries "owed, not finished" without the card
claiming either "done" or "working". Dropping `Ended,` also removes the tension
F58 fixed from the other side.

## F60 — verification after the review round

`npm run build` clean; smoke **147/147 PASS / 0 FAIL / 0 SKIP**, the SL-16 fence
grown from 23 to **33 checks** (the tracker's own arms, both `StopFailure` arms,
the dev-server regression, the short-human-turn floor case, the interleaved-turn
arc end-to-end through `NotificationPolicy`, and the sidebar dot).

Three NEW A/Bs this round, each reverting one line and rebuilding:

| reverted | fails |
|---|---|
| growth → non-emptiness (the B1 bug) | 5 checks, incl. the dev-server arm |
| arc cleared on every turn end | the two interleaved-turn arcs |
| `…` → `...` | the vocabulary pin |

**LIVE re-run (z4, both arms), PASS 10/10.** The mechanism changed materially — a
new stateful component now sits in the live chain — so the unit arcs could not
carry it: only a real session can show that the CLI's task `id` is stable across
two `Stop`s (it is: `bjtfron51` in both z4b turns) and that the array genuinely
does not empty between turns. z4a re-confirms the revival arc unchanged (wake at
+71009ms, `revivalOf` set, zero pings at the pause, exactly one after);
z4b is the B1 regression, reproduced and fixed, against the real binary. Binary
pinned `2.1.258` at start AND end; settings guard `mutatedByProbe: false` with
its `--self-test` exercised first.

---

# SL-18 — the claude fullscreen-offer BANNER, verified live (built 2026-09-02, binary 2.1.258)

## F61 — q36: the banner's two TIMING claims, measured end to end (PASS ×2)

SL-3 (F7/F8) established the guard: `claudeFullscreenOfferOpen` →
`isFullscreenOfferOpen()` inside `acceptsPromptInput()`, holding the boot latch on
the fullscreen-renderer offer because a delivery there DESTROYS the prompt. SL-18
adds the surface that says so — a passive "answer it in the CLI window" banner,
the claude sibling of codex's trust-dialog banner.

The smoke pins the surface on MEASURED frames. What a fixture structurally cannot
pin is the two TIMING claims the banner rests on:

1. the one-shot 4s watchdog lands INSIDE a real offer window — not before the
   offer paints, and not after a healthy boot has already reached its composer;
2. the repaint that ANSWERS the offer actually reaches the coalesced settled-grid
   scan (`scheduleApprovalScan`, 120ms cadence) that the clearing pass rides.

**Probe** `q36-fullscreen-offer-banner-live.mjs` — a real `TerminalHost` from
`dist/` with Sonata's production spawn shape, the one-time offer re-armed in a
scratch `CLAUDE_CONFIG_DIR` exactly as q8 arm B does (counter zeroed, the recorded
`tui` answer dropped; the real `~/.claude` is read, never written). Run TWICE, on
the same binary, to establish the numbers are not a one-off.

| moment | run 1 | run 2 (the surviving capture) |
|---|---|---|
| Sonata's SL-1 trust walk writes (Down, Enter) | 332 / 684ms | 332 / 683ms |
| offer owns the grid (`isFullscreenOfferOpen()`) | 839ms | **837ms** |
| `acceptsPromptInput()` at that instant | false | **false** — the SL-3 hold |
| `claude-fullscreen-offer:detected` | 4029ms | **4028ms** |
| the HUMAN's Down reaches the pty (`writeUserInput`) | 4101ms | **4073ms** |
| the HUMAN's Enter reaches the pty | 4504ms | **4474ms** |
| `claude-fullscreen-offer:cleared` | 4652ms | **4620ms** |
| **answering Enter → cleared** | **148ms** | **146ms** |

Claim 1 holds with margin in both directions: the watchdog fires ~3.2s after the
offer paints, and a HEALTHY boot reaches its composer at 1399ms (F7), so t+4s is
past the one and well inside the other.

Claim 2 holds tightly, and the number is the interesting one: **146/148ms from the
answering Enter to the event**, against an `APPROVAL_SCAN_CADENCE_MS` of 120ms.
The banner retires on the very next scan tick after the repaint — the ride-along
is not merely wired, it is prompt.

**The RED LINE held LIVE, not only on fixtures.** The probe wraps
`ptyProcess.write` and records every byte with a timestamp, whoever writes it.
Between the offer owning the grid and the human's own keystrokes, **nothing**
reached the pty. Sonata's only writes were the SL-1 workspace-trust walk at
332/683ms — a different screen, before the offer existed — and the teardown EOT
at 4677ms. `noSonataWriteWhileOfferOpen: true` in both runs.

**The answer path is the DECLINE row** (`Down` then `Enter` → `2. Not now`),
delivered through `writeUserInput` — the host method the CLI window's xterm
`onData` calls for a keystroke, i.e. the user's own channel, never a Sonata write
path. The decline row was chosen over the affirm row deliberately: the affirm row
re-execs the CLI in place (F8 case C), which would confound the very timing this
probe exists to read. The affirm and Esc paths are therefore NOT banner-measured
here; nothing depends on them, because the clearing pass is keyed on the offer's
ABSENCE rather than on how it left.

**FIDELITY LIMIT, inherited from q8 arm B and restated rather than glossed**: the
re-armed config boots LOGGED OUT (credentials live in the macOS Keychain keyed to
the DEFAULT config dir), so the header reads `API Usage Billing`. The renderer
offer is a CLIENT-SIDE choice and is unaffected — which is exactly why this arm is
valid for THIS question and would not be for an account-gated one.

**VERSION DRIFT, recorded not hidden**: the tracked fixtures are 2.1.257; this ran
at **2.1.258**. The offer frame is byte-shape identical across the move (the
capture's `offerFrame` carries the same question line, the same three feature
bullets, the same two rows and the same `Enter to confirm · Esc to cancel`
footer), so the signature needed no re-pinning.

**The capture file is a SINGLE file the probe overwrites per run**
(`q36-fullscreen-offer-banner-live.capture.txt`, gitignored with every other
capture, D6) and it currently holds RUN 2. That is why both runs' numbers are
recorded in the table above: this findings entry is the durable citation, and the
tracked comments in `terminal-host.ts`, `events.ts` and
`tests/smoke/claude-boot-interstitial.mjs` quote the surviving run's figures and
point here.

---

# SL-19 — the RC startup lever, WIRED and verified live (built 2026-09-02, binary 2.1.258)

## F62 — rc8: the shipped lever through the production spawn (PASS ×2, 8/8 verdicts both runs)

rc7 measured the lever on a hand-spawned pty with a hand-merged settings file.
SL-19 wires it into `ensureClaudeRuntimeSettings` (OFF intent writes
`remoteControlAtStartup: false`; ON intent omits the key and passes
`--remote-control`), and rc8 drives the whole thing through the PRODUCTION
`TerminalHost` — production `buildArgs`, production settings writer, production
`remote-control:state` / `findRemoteControlUrlOnScreen` as the oracle.

**THE FLAP PROBLEM, and the bracket that survives it.** Auto-start resolves to a
server-side GrowthBook default that moved twice during SL-11 with no local action
(F4e), so "the OFF arm did not auto-start" is worthless alone. rc8 SANDWICHES the
suppression arm between two PRE-FIX control arms — the identical production spawn
with the new key stripped back out of the file it just wrote — and refuses to
claim a pass unless BOTH controls auto-started (`bracketValid`). The control's
argv is asserted equal to the production OFF-intent argv modulo the `--settings`
path, so "pre-fix shape" is measured, not asserted by comment.

Both runs, `tengu_cobalt_harbor` **true** on all eight arms, claude 2.1.258
pinned at start and end:

| arm | shape | `connecting…` | `/rc` pill | run |
|---|---|---|---|---|
| c-control-pre | pre-fix (key stripped) | +0ms | +1003ms | 1 |
| **a-off-intent** | **production, key written** | **never** | **never** | **1** |
| b-on-intent | production + `--remote-control` | +0ms | +500ms | 1 |
| d-control-post | pre-fix (key stripped) | +0ms | +1004ms | 1 |
| c-control-pre | pre-fix | +0ms | +1001ms | 2 |
| **a-off-intent** | **production** | **never** | **never** | **2** |
| b-on-intent | production + flag | +0ms | +502ms | 2 |
| d-control-post | pre-fix | +0ms | +502ms | 2 |

Each OFF arm was watched 30s; every positive auto-start in the program has
attempted at +0ms (rc7 4/4, rc8 6/6), so the window is far past generous.

**THE `/rc` PILL IS A GENUINE TELL, not chrome** (worth recording, because F12
established the opposite for the idle footer). It is absent for the whole 30s
boot window of a suppressed session and appears the moment RC connects — in the
OFF arm it showed up only AFTER the mid-session injection. rc7's needle
(`/\/rc\b/`) was unanchored and matched its own workspace path (`…/rc-lever/…`)
instead; rc8 anchors on the pill terminating its row, which the measured footer
shape (`<statusline output>   /rc`, q5) puts it at.

**THE RED LINE HOLDS, MEASURED not assumed.** Under the suppressed OFF-intent
spawn the production `injectRemoteControl()` returned `ok`, and the production
`remote-control:state` carried the session link at **+605ms (run 1) / +679ms
(run 2)** after the injection, with the link independently on the grid and
`acceptsPromptInput()` still true afterwards. A startup default is not a
capability switch; the key that WOULD take the capability away
(`disableRemoteControl`) is managed-settings-only and unreachable from a
`--settings` file (F4e).

**THE ON PATH, in the shape nobody had run.** rc4 leg 3 measured flag-over-`false`;
SL-19 ships flag-over-NOTHING. Both runs: key absent from the written file,
`--remote-control` last in argv, RC connected — `remote-control:state` armed at
+20ms and the link at +1917ms (run 1) / +502ms grid (run 2). The ON path
deliberately does not write `true`: it is unmeasured in the enabling direction
(F4i), superfluous next to a flag measured to connect at +0ms, and Sonata has no
use for it.

**BYTE-STABILITY** asserted per shape inside the probe as well as in the smoke:
re-running the production writer with the same options reproduced identical bytes
and did not touch the file (`writeJsonIfChanged` never churns), both shapes, both
runs.

Settings guard clean (`mutatedByProbe: false`) on both runs, self-test run first.
Captures: `rc8-startup-lever-live.run1.capture.txt`, `…run2.capture.txt` —
run-numbered like rc7, because the background this measures against flaps and a
replicate is evidence in its own right.

# D2 U1 — default-model launch channel (probed 2026-09-02, binary 2.1.258)

Probe `m1-default-model-channel.mjs` → `m1-default-model-channel.capture.txt`.
**35 legs on record, one fresh spawn each** (45 spawns in total: ten runs were
superseded — legs re-run after the harness gained a field or an arm was
restructured — and the record keeps the later run), every one through the
production `TerminalHost` from `dist/`
with production argv, production `--settings`, production statusline sink; model
read off TWO independent channels per leg (the boot banner on the reconstructed
grid AND the `model.display_name`/`model.id` the CLI's own statusline payload
carries) and, where the SOURCE was the question, off the `/model` picker's
attribution row. Version pinned `2.1.258` at start and end, no drift.

The user's real `~/.claude/settings.json` was the hazard, not an input: the
bracket is now a shared module (`settings-guard.mjs`, lifted from h1 after F41)
and it closes **per arm**, not per run. **53 brackets are merged in the capture;
23 found the file moved; all 23 restored and byte-verified** — 18 distinct legs,
of which 16 moved it because the PROBE deliberately set or removed a control pin
for that leg and 3 because the CLI itself persisted a mid-session `/model` (F68);
one leg, `f2`, is in both groups. Final state `model: "fable"`, byte-identical to
the snapshot.

**VERDICT: NO-OP.** No product change. The incumbent `--model` flag wins on all
five decision axes and outranks every alternative channel; the pollution the
slice went looking for is not on the launch path at all. Details in F69.

## F63 — S3 FALSIFIED: NO launch channel writes the user's durable default (MEASURED)

The slice's first question was whether `--model <alias>` — the flag Sonata passes
on every claude spawn — persists into `~/.claude/settings.json`. It does not, and
neither does any other launch channel tested:

Counting only the **32 legs that launched and did nothing else** (the three that
drove a mid-session `/model` are F68's, not this finding's — a leg that switches
mid-session is no longer measuring its launch channel). A leg carrying two
channels is counted under the one that WON:

| channel | legs | `settings.json` changed after the session exits |
|---|---|---|
| `--model <alias>` | a, c, h3, j-am-haiku-flag-sonnet, k, n | **no**, 6/6 |
| `ANTHROPIC_DEFAULT_MODEL` | b, d×5, e×2, h1 | **no**, 9/9 |
| `ANTHROPIC_MODEL` | i×2, j×6, m-am-fable-vs-haiku-pin | **no**, 9/9 |
| `--settings` `model` key | g, h2, m×5 | **no**, 7/7 |
| nothing at all (baseline) | d0 | **no**, 1/1 |

MEASURED (`m1-default-model-channel.capture.txt`, the per-leg table's
`settings.json changed` column; each cell is a key-level diff of the file bytes
taken TWICE, once while the session was live and once after the pty exited, so a
flush-on-exit could not hide). Every leg that moved the file is a leg that drove
`/model` — three of them, all in F68, none of them a launch channel.

So the premise the slice was built to test is dead, and with it the "Sonata is
polluting the user's default at launch" hypothesis. The launch path was never the
polluter.

## F64 — the incumbent `--model` flag wins on all five axes, and outranks every rival (MEASURED)

| axis | evidence |
|---|---|
| (i) selects the model at boot | `--model haiku` under a user pin of `fable` → banner row `Haiku 4.5 · Claude Max` (Haiku carries no effort segment — F70), statusline `claude-haiku-4-5-20251001` (arm a, replicated byte-for-byte at arm h3) |
| (ii) leaves `settings.json` untouched | F63 (which owns the per-channel counts; they are not restated here) |
| (iii) accepts every `MODEL_OPTIONS` alias | **5/5, all MEASURED on the LAUNCH FLAG specifically**: `haiku` (a, h3), `sonnet` (c, k, j-am-haiku-flag-sonnet), `fable` (n — against a control pin of `haiku`, because this account's own pin is `fable` and the reading would otherwise be unattributable), `opus` and `opus[1m]` (F18/q15, whose four arms are `--model` spawns). **NOT** F16/q13 or s2: q13 measured the mid-session SLASH channel — a different code path, and the one F68 shows is the polluter — and s2 is a slash-command-NAME probe with nothing to say about model aliases. The earlier draft of this row cited both; the citation was wrong and `n` was run to close the one cell (`fable`) that then had no measurement on this channel at all |
| (iv) outranks the user's own pin | arm a / h3: file says `fable`, session runs Haiku. The picker confirms it structurally — `❯ 5. Haiku ✔` with the `Default (recommended)` row NOT marked |
| (v) does not disturb `fastMode` | F18 (q15) at this binary, unchanged |

**And it beats all three rivals head to head**, each measured as its own leg with
the two channels deliberately disagreeing:

| leg | flag says | rival says | session ran |
|---|---|---|---|
| c-env-haiku-flag-sonnet | `sonnet` | `ANTHROPIC_DEFAULT_MODEL=haiku` | **Sonnet 5** |
| j-am-haiku-flag-sonnet | `sonnet` | `ANTHROPIC_MODEL=haiku` | **Sonnet 5** |
| k-settings-haiku-flag-sonnet | `sonnet` | `--settings` `model: haiku` | **Sonnet 5** |

The flag is the top of the ladder for every channel Sonata could reach.

## F65 — `ANTHROPIC_DEFAULT_MODEL` LOSES to the user's pin, and silently drops `haiku` (MEASURED — this closes S2 and kills the plan's named candidate)

Two independent failures, either one disqualifying.

**It loses to `~/.claude/settings.json`'s `model`.** With the user's real pin
(`fable`) in place, `ANTHROPIC_DEFAULT_MODEL=haiku` and `=opus[1m]` both produced
a `Fable 5.1` session — banner and statusline agreeing, `claude-fable-5-1` (arms
b, h1, e1). That is the exact correctness failure the plan feared for the FLAG,
found instead in the channel the plan proposed to replace it with.

**It drops `haiku` outright.** With the pin REMOVED (a guard-bracketed control
leg, because under a pin every reading is the pin and the sweep answers nothing),
the alias sweep separates cleanly against a measured baseline:

| leg | `ANTHROPIC_DEFAULT_MODEL` | statusline id | picker attribution row |
|---|---|---|---|
| d0-nopin-baseline | (unset) | `claude-opus-5[1m]` | n/a — the picker was not opened on this leg |
| d-nopin-env-fable | `fable` | `claude-fable-5-1` | `❯ 1. Default (recommended) ✔  Fable 5.1 · Set by ANTHROPIC_DEFAULT_MODEL` |
| d-nopin-env-opus-1m- | `opus[1m]` | `claude-opus-5[1m]` | `… ✔  Opus 5 · Set by ANTHROPIC_DEFAULT_MODEL` |
| d-nopin-env-opus | `opus` | `claude-opus-5` | `… ✔  Opus 5 · Set by ANTHROPIC_DEFAULT_MODEL` |
| d-nopin-env-sonnet | `sonnet` | `claude-sonnet-5` | `… ✔  Sonnet 5 · Set by ANTHROPIC_DEFAULT_MODEL` |
| **d-nopin-env-haiku** | `haiku` | **`claude-opus-5[1m]`** | **none — row 1 reads `Opus 5 with 1M context · Best for everyday, complex tasks`, i.e. the tier default** |

`haiku` is not merely overridden, it is REFUSED: on the `d-nopin-env-haiku` leg
the attribution row is absent altogether and row 1 reads the plain tier
description (`Opus 5 with 1M context · Best for everyday, complex tasks`), so the
resolver never adopted the value and fell through to the tier default — the same
id `d0` reaches with nothing set at all. Four of Sonata's five aliases work, the fifth does not — axis (iii) fails.

**S2 is CONFIRMED live.** The static hypothesis was that the picker renders
`" · Set by ANTHROPIC_DEFAULT_MODEL"` when the model came from env. It does,
verbatim, on the `Default (recommended)` row. Recorded as a MEASURED footprint,
not a static one. Two reading notes for whoever uses it next:
- the attribution row is row 1 (`Default (recommended)`), NOT the model's own row
  — an env-selected session marks `✔` on row 1 and leaves rows 2–5 unmarked,
  which is a DIFFERENT picker shape from a flag-selected session (arm a marks
  `❯ 5. Haiku ✔`);
- the row's description **abbreviates**: `opus[1m]` renders as `Opus 5`, not
  `Opus 5 (1M context)`, while the statusline for the same leg says
  `claude-opus-5[1m]`. The attribution row is evidence of the SOURCE, never of
  the exact model — read the id.

STATIC corroboration, not load-bearing (`grep -a` over the 2.1.258 bundle): the
2.1.236 changelog entry reads "Added `ANTHROPIC_DEFAULT_MODEL` environment
variable: sets the model new sessions start on, while a `/model` pick still
overrides it and persists across restarts (unlike `ANTHROPIC_MODEL`)" — i.e.
losing to a persisted `/model` pick is the DOCUMENTED design, not a bug. The
resolver ladder `Cj()`/`lL()` places the env read (`rie()`) behind a chain of
guards any one of which returns null; which guard rejects `haiku` was not
determined and does not need to be — the behaviour is measured.

## F66 — `ANTHROPIC_MODEL` is the STRONG env channel, and still loses to the flag (MEASURED)

Because `ANTHROPIC_DEFAULT_MODEL` failed, the slice's fact ("the measured better
channel") required measuring the sibling variable the changelog contrasts by name.
It is materially stronger — every leg run against the user's REAL pin of `fable`:

| leg | `ANTHROPIC_MODEL` | statusline id | picker |
|---|---|---|---|
| j-am-fable | `fable` | `claude-fable-5-1` | — |
| m-am-fable-vs-haiku-pin | `fable` (pin control-set to `haiku`) | `claude-fable-5-1` | — |
| j-am-opus-1m- | `opus[1m]` | `claude-opus-5[1m]` | — |
| j-am-opus | `opus` | `claude-opus-5` | — |
| j-am-sonnet | `sonnet` | `claude-sonnet-5` | — |
| j-am-haiku / i1 | `haiku` | `claude-haiku-4-5-20251001` | `❯ 5. Haiku ✔`, no attribution row |

**5/5 aliases including `haiku`; outranks the user's pin; leaves `settings.json`
untouched; `fastMode` intact** (`j-am-opus1m-fast` → the F18 needle
`Fast mode requires usage credits · /usage-credits to turn them on` present on the
boot frame, against the same-alias no-fastMode control `j-am-opus-1m-` where it is
absent). The `m-am-fable-vs-haiku-pin` leg exists so the `fable` cell is not an
artefact of this account's pin also being `fable`: with the pin control-set to
`haiku`, `ANTHROPIC_MODEL=fable` still produced Fable.

It renders NO attribution row — from the picker it is indistinguishable from a
flag-selected session — and it does **not** lock the picker: all five rows are
present and navigable.

**But it loses to `--model`** (`j-am-haiku-flag-sonnet` → Sonnet 5), and it does
not stop `/model` from persisting (F68). So it buys nothing the flag does not
already provide, at the cost of moving a shipped, tested channel onto an
undocumented-for-this-purpose env var. Recorded as the strongest ALTERNATIVE on
file, adopted nowhere.

## F67 — the `--settings` `model` key: a real third channel, also strictly below the flag (MEASURED)

Written by wrapping the PRODUCTION writer (`ensureClaudeRuntimeSettings` from
`dist/`) and adding one key to the file it had just written — so the arm measures
production's file plus the channel, never a hand-built substitute.

- **(i)+(iii)** all five aliases: `haiku` (g, h2), and `fable` / `opus[1m]` /
  `opus` / `sonnet` (m legs, run against a control pin of `haiku` so no reading
  can be explained by the pin) — statusline id correct on 5/5.
- **(ii)** `settings.json` untouched, 8/8 (F63).
- **(iv)** outranks the user's pin: g/h2 (pin `fable` → Haiku 4.5) and the four m
  legs (pin `haiku` → each leg's own alias).
- **(v)** `fastMode` intact: `m-settings-opus1m-fast` carries the F18 needle with
  `model: "opus[1m]"` and `fastMode: true` in the same injected file.
- **loses to `--model`**: `k-settings-haiku-flag-sonnet` → Sonnet 5.

This is the one alternative that ties the flag on all five axes. It ties; it does
not win; and it converts an explicit, greppable argv token into a key inside a
JSON file, which is a legibility loss for no measured gain.

## F68 — REGISTER: the polluter is the mid-session `/model` drive, and no channel disarms it (MEASURED 3/3)

The plan's fork asked whether an env channel makes `/model` stop writing the
user's default ("if env makes `/model` non-persisting, that IS the pollution fix
and U1 takes it"). It does not — under either env variable, and with or without a
user pin:

| leg | channel in effect at boot | drive | receipt | `settings.json` |
|---|---|---|---|---|
| f1-env-haiku-then-slash-sonnet | none (`ANTHROPIC_DEFAULT_MODEL=haiku` inert, F65) → user pin `fable` | `/model sonnet` | `⎿  Set model to Sonnet 5 and saved as your default for new sessions` | **`model: "fable" → "sonnet"`** |
| f2-nopin-env-sonnet-then-slash-haiku | `ANTHROPIC_DEFAULT_MODEL=sonnet` genuinely in effect (pin removed) | `/model haiku` | `⎿  Set model to Haiku 4.5 and saved as your default for new sessions` | **`model: undefined → "haiku"`** (key CREATED) |
| j-am-haiku-then-slash-sonnet | `ANTHROPIC_MODEL=haiku` in effect | `/model sonnet` | `⎿  Set model to Sonnet 5 and saved as your default for new sessions` | **`model: "fable" → "sonnet"`** |

f1 is the plan's literal leg; f2 exists because f1's env value is MEASURED inert,
so f1 alone could only report what `/model` does under an ordinary pin and not
what the plan actually asked. Every slash carried a grid-verified composer read
before CR (the F41 failure mode), and all three landed.

So the durable-default pollution is real, is 3/3 reproducible, and lives entirely
in the mid-session switch path — the same path F41's incident rode. **Not fixed
here**: out of this slice's boundary by explicit instruction, registered for the
program. Note for whoever takes it: the receipt's own wording
(`and saved as your default for new sessions`) is the CLI telling the user what it
did, so any fix has to decide whether Sonata's mid-session switch should be a
session-scoped switch instead — the picker's `s` key (`for this session only`,
F16) is the CLI's own affordance for exactly that, and it is currently unused by
Sonata.

## F69 — THE DECISION MATRIX, and why U1 ships nothing

MEASURED, all cells, `m1-default-model-channel.capture.txt`:

| axis | `--model` flag (incumbent) | `ANTHROPIC_DEFAULT_MODEL` | `ANTHROPIC_MODEL` | `--settings` `model` |
|---|---|---|---|---|
| (i) selects at boot | **YES** (a, h3) | **NO** under a user pin; yes only with no pin (b/h1/e1 vs d) | **YES** (i1, j×5) | **YES** (g, h2, m×4) |
| (ii) `settings.json` untouched | **YES** | **YES** | **YES** | **YES** |
| (iii) every `MODEL_OPTIONS` alias | **YES** 5/5 (a, c, k, n + F18/q15 — F64) | **NO** — `haiku` refused (d) | **YES** 5/5 (j, m) | **YES** 5/5 (g, m) |
| (iv) outranks the user's pin | **YES** (a, h3) | **NO** (b, h1, e1) | **YES** (i1, j, m) | **YES** (g, h2, m) |
| (v) `fastMode` intact | **YES** (F18) | yes when in effect (e2 vs d control) | **YES** (j-am-opus1m-fast) | **YES** (m-settings-opus1m-fast) |
| precedence vs the flag | — | **loses** (c) | **loses** (j-am-haiku-flag-sonnet) | **loses** (k) |

Axis (ii) deliberately carries NO per-channel tally here: **F63 is the single
place those counts live** (6/6 · 9/9 · 9/9 · 7/7 over the 32 launch-only legs,
under its stated rule that a leg carrying two channels counts under the one that
WON). An earlier draft restated them in this row, they were not kept in step with
F63's own correction, and the stale copy could be read as contradicting F68 —
which is exactly the failure mode a duplicated tally invites. The three legs that
DID move the file are `/model` legs and belong to F68, not to any launch channel.

**Applying the plan's rule literally.** §U1's "Fork if S3 falsifies" is the outer
conditional and its antecedent is MEASURED true (F63: the flag does not persist).
The fork then says U1 ships an alternative channel *only if it wins on (iv)* —
"a real correctness gain: today a user whose `settings.json` says `fable` may or
may not get Sonata's chosen model — **unmeasured**". That unknown is now measured
and it resolves in the incumbent's favour: the flag already outranks the user's
pin (arm a, arm h3 — file `fable`, session Haiku). There is no correctness gain
left for any channel to deliver, and no channel outranks the flag on any axis.
**Therefore: no-op + register entry**, which is exactly what the fork prescribes.

The general decision rule's STOP clause ("env and `--settings model` split → bring
the matrix to Woody") reads as satisfied on its face — they do split, comprehensively
— but that clause exists to stop a one-way-door CHOICE between two candidate
channels. No channel is being adopted, so no door is being walked through: the
matrix is surfaced here rather than as a block. If Woody wants the choice made
anyway, F66/F67 are the two viable options and F67 is the one that ties on all
five axes.

**What Sonata should keep doing, now for a measured reason rather than an
inherited one:** pass `--model <alias>`. It is the only channel at the top of the
resolver ladder, it is the only one whose selection is visible in argv (which is
what `task:started` records and what every launch e2e fixture asserts), and it
costs the user's durable configuration nothing.

## F70 — method notes and one out-of-scope leak

**The settings guard is now a shared module.** `settings-guard.mjs` exports
`snapshotUserSettings` / `restoreUserSettings` / `diffJsonKeys` /
`createSettingsGuard` (with `installSignalRestore`, per-arm `restoreNow`, a
`readKey` for stating what a leg races, and a `setKeyForArm` control lever) plus
`runSettingsGuardSelfTest`, runnable standalone
(`SONATA_PROBE_SETTINGS_PATH=/tmp/x.json node settings-guard.mjs --self-test`).
m1 runs the self-test against a throwaway file BEFORE its first spawn and refuses
to proceed unless it passes. U3's `h4` reuses it. `h1-hook-census.mjs` is
deliberately left on its own inlined copy: its capture is committed evidence and
the file is that capture's provenance.

The guard closes **per arm**, which is not a refinement but a requirement: arm f
persists a model mid-run, and an unrestored pin would silently become the next
arm's user default — turning the very variable the probe controls into noise.
Across the run 53 brackets are merged in the capture, 23 of them found the file
moved, and all 23 restored it and byte-verified the result; final state
`model: "fable"`, byte-identical to the snapshot.

**Control legs and honest diffs.** Fifteen legs across arms d, e, f, i and m
deliberately changed the user's pin — removed it, or set it to a control value chosen to appear in no
leg under test. For those legs the axis-(ii) diff is taken against the file **as
the CLI found it**, not against the guard's snapshot; diffing a control leg
against the snapshot would score the probe's own deliberate change as CLI
pollution. The guard's own restore stays snapshot-anchored.

**OUT OF SCOPE, registered: `ptyEnvironment` does not scrub `CLAUDE_EFFORT`.**
The scrub deletes `CLAUDECODE` and every `CLAUDE_CODE_*` key, but this probe's own
parent process (a Claude Code session) also exports `CLAUDE_EFFORT=high`,
`CLAUDE_PID` and `CLAUDE_PLUGIN_DATA`, and all three survive into the child. The
binary reads `CLAUDE_EFFORT` — **STATIC** (`grep -ac CLAUDE_EFFORT
/opt/homebrew/lib/node_modules/@anthropic-ai/claude-code/bin/claude.exe` → 9
matching lines at 2.1.258; the variable's EFFECT on a session is not measured
here and is not claimed). m1 deletes them from its own `process.env` before
the first spawn — that makes the spawn MORE production-shaped, since a
Dock-launched Sonata has none of them — and records having done so in the capture
header. Production impact is confined to Sonata launched from inside a Claude Code
session (a dev-only shape today), which is why this is a register item and not a
fix in this slice.

**REGISTER, program-wide and PRE-EXISTING (not a defect of this slice, and
deliberately NOT fixed here): the guard brackets `~/.claude/settings.json` and
nothing else.** Every leg answers a workspace-trust dialog for a fresh
`/private/tmp/...` cwd, and the CLI records that answer in the user's
`~/.claude.json` project map, where it stays. MEASURED after this run: **35
entries under `/private/tmp/sonata-sync-2026-09/default-model/`**, each carrying
`hasTrustDialogAccepted: true`, in a file that holds **3,544** project entries in
total — so every probe generation in this program has been silently adding to it.
The capture shows the same fact from the other side: a re-run leg boots with no
trust dialog at all (`readyMs` ~666ms) while a first-run leg gets one.

Whether the bracket should WIDEN to `~/.claude.json` is a real question and NOT a
trivial yes. That file is not static configuration: it carries live per-project
accounting the CLI rewrites continuously (`lastCost`, `lastSessionId`,
`lastModelUsage`, `lastAPIDuration`, …), so a snapshot-and-byte-restore of it
would clobber whatever the user's own concurrently-running CLI sessions wrote
during the probe — trading a cosmetic leak for real data loss. A surgical
restore (delete only the project keys the probe created, leave every other key
untouched) is the shape that could work. Registered for the program to decide;
the harm today is stale entries in a map, not changed behaviour.

**Non-obvious reading hazards this probe hit**, worth pinning for the next one:
- the picker's env-attribution row is `Default (recommended)`, and its
  description ABBREVIATES `opus[1m]` to `Opus 5` (F65) — the statusline `model.id`
  is the only unambiguous read;
- `Haiku 4.5`'s banner row drops the effort segment, so a banner parse must take
  whichever of ` with <effort> effort` / ` · ` comes first;
- an alias sweep run under a user pin measures the pin, not the channel. Every
  sweep here either removed the pin or set it to a value appearing in no leg.

## F71 — evidence files

- `m1-default-model-channel.mjs` — the probe: 13 arms, 35 legs, batch-runnable
  (`node m1-default-model-channel.mjs <arm>…`) with `--capture-only` assembling
  the capture from every batch's results plus their merged guard histories.

  PROVENANCE, since the results are assembled across batches rather than written
  by one process: review of this slice found legs `a-flag-haiku` and
  `g-settings-model-haiku` missing the `userPinOverriddenByProbe` field every
  other leg carries — they had been produced by an earlier revision of the
  harness. Neither uses a pin override, so the readings were never in doubt, but
  a result set that cannot be reproduced from the committed file is not evidence.
  **Both were re-run under the committed harness**; every leg on record now
  carries the full field set. The merged guard history covers every batch except
  the very first trial run (one leg, `a`, since superseded), which predates the
  batch/assembly split — that run's bracket lives in its own per-arm
  `settingsRestore` record and the capture's guard section says so rather than
  claiming completeness it does not have.
- `m1-default-model-channel.capture.txt` — the capture: per-leg table, the guard's
  full per-arm history, per-arm JSON, and every frame (boot frames, trust dialogs,
  `/model` picker reads, post-switch frames). Sanitized for `$HOME`, the munged
  `-Users-…-` slug form, and `claude.ai` session ids.
- `settings-guard.mjs` — the shared bracket (F70), self-testable.

# D2 U2 — session-locator decoupling (probed 2026-09-02, binary 2.1.258)

Probe `p1-project-dir-name.mjs` → `p1-project-dir-name.capture.txt`. **Five arms,
five live spawns, all reproduced in ONE pass** through the production
`TerminalHost` from `dist/` (production argv with `--session-id`, production
`--settings` file, production `HookWatcher` on the production hook sink). Version
pinned `2.1.258` at start and at end, no drift. Settings guard on and byte-clean
(five brackets, none found the file moved — no arm here types a slash).

Every directory name on record is read TWICE and independently: off the CLI's own
`SessionStart` hook payload (`transcript_path`) and off a scan of
`~/.claude/projects/*/<session-id>.jsonl`. Sonata's deleted rule is computed too,
but only so the capture can say what it WOULD have looked for — never to produce a
reading.

**VERDICT: PATCHED.** `claudeProjectSlug` and `claudeCwdVariants` are gone; the
locator finds the file by session id, whatever the directory is called, and the
path memory a reopen uses is `transcript-sources.json` — which already held it
(F81, review round: the manifest-level copy this slice first built was shadowed
on every reachable path and was removed).

## F72 — the naming rule at 2.1.258, MEASURED, and why it cannot be re-implemented

STATIC first (`grep -a` over the binary), because it is what the arms went to
confirm:

```js
var IL = 200;
function be(e){ return Math.abs(zq(e)).toString(36) }      // hash of the ORIGINAL cwd
function k(e) { return e.replace(/[^a-zA-Z0-9]/g,"-") }    // Sonata's claudeProjectSlug
function KA(e){ let n=k(e); if(n.length<=IL) return n; return `${n.slice(0,IL)}-${be(e)}` }
function ia(){ return join(Se(), "projects") }             // Se() = the config dir
function Em(e){ return Apr() ?? KA(e) }                    // name = env ?? rule
function Bu(e){ return join(ia(), Em(e)) }                 // the project directory
```

MEASURED (p1, one spawn per row; `cwd chars` is the length of the cwd the CLI ran
in, and the slug is a 1:1 character mapping so slug length == cwd length):

| arm | cwd chars | directory the CLI created | Sonata's old rule agreed? |
|---|---|---|---|
| arm2a | **200** | `…-arm2a-<120×x>-<28×y>` (200 chars, no suffix) | yes |
| arm2b | **201** | `…-arm2b-<120×x>-<28×y>-ykvb5a` (200 + `-` + hash) | **NO** |
| arm2c | **300** | `…-arm2c-<120×x>-<28×x>-v5abde` (200 + `-` + hash) | **NO** |

So the threshold is exactly "**more than 200 characters**", inclusive side
confirmed, and it is not a guess bracketed by bisection — arm2a and arm2b are
adjacent by one character.

**The suffix is the part that closes the question.** It is `be(cwd)` — a hash
computed inside the binary over the original cwd, base-36 encoded. It is not
derivable from the path by any rule Sonata could hold; it is a function of a hash
implementation that ships inside `claude.exe` and can change with any release. So
this is not "Sonata's copy of the rule is out of date, update it": there is no
version of the copy that can be right. Re-implementation as a strategy is dead,
and the only stable contract left is the one the slice now depends on — the file
is named `<session-id>.jsonl` and sits one level under the projects root.

The concrete break this fixes: a Sonata task whose working directory is longer
than 200 characters (a deep monorepo path, a nested worktree) had its transcript
looked for in a directory the CLI never created. arm2c's own capture shows both
strings side by side — a 307-character name Sonata would have opened, against the
207-character name upstream actually wrote.

## F73 — S1 CONFIRMED: `CLAUDE_CODE_PROJECT_DIR_NAME` is inert for Sonata's spawn shape (MEASURED)

arm1: `CLAUDE_CODE_PROJECT_DIR_NAME=sonata-p1-armone` (valid per the binary's own
`^[A-Za-z0-9_-]{1,64}$`), NO `CLAUDE_CONFIG_DIR`, otherwise a production spawn
with `--session-id`. The transcript landed in
`-private-tmp-sonata-sync-2026-09-project-dir-arm1-ws` — the cwd slug. The
variable did nothing.

That is exactly what the static read predicted: `Apr = Zo(() => s() ? sLn(_()) :
void 0, …)` consults the name ONLY when `s()` — `process.env.CLAUDE_CONFIG_DIR` —
is set, and Sonata never sets it (SL-3: an isolated config dir is logged out). The
2.1.234 changelog says the same in words: "hosts that give each session its own
config directory can choose a short name".

Option (A) of the U2 plan is therefore **closed by measurement**, not by reading.
arm3 (a throwaway `CLAUDE_CONFIG_DIR` + the variable) was NOT run: the plan gates
it on arm1 surprising, and arm1 did not. The arm remains in the harness
(`node p1-project-dir-name.mjs arm3`) for whoever needs the other half of the
cell — with the standing caveat that a throwaway config dir is logged out, so an
inconclusive result there is the likely one.

Also worth pinning for anyone who reaches for this variable later: it sits in the
binary's list of env keys that repo-committed settings may not set, alongside the
TLS/proxy and session-token keys. It is a host-integration lever, not a
configuration knob.

## F74 — `SessionStart` carries `transcript_path`, and the FILE IS NOT THERE YET (MEASURED, 5/5)

The design question the plan asked the engineer to settle first — "does
`SessionStart` carry `transcript_path`, so the scan is bootstrap-only?" — has a
two-part answer, and the second part is the one that matters.

**Yes, the path is carried.** All five arms: `SessionStart` at ~2.0–2.6 s after
spawn, keys `{session_id, transcript_path, cwd, scratchpad_dir, hook_event_name,
source, model}` (matching F34's census).

**No, the file does not exist when the hook fires.** MEASURED 5/5:
`transcriptExistedAtHook: false` in every arm, sampled the instant the payload
landed. A full id scan taken right after boot found nothing in all five arms too.
The transcript is written LAZILY, at the first turn: arm1 and arm2c each sent one
trivial prompt, and only then did `<session-id>.jsonl` appear — under exactly the
directory the hook had named minutes earlier.

Two consequences, both already reflected in the shipped code:

1. `adoptTranscriptFromHook`'s existing `!fs.existsSync(transcriptPath)` branch is
   not defensive coding for a rare race — it is the **normal** boot path at
   2.1.258. Every fresh Claude session takes it. Good thing it was there.
2. The id scan is not merely "bootstrap-only for one hook's latency"; it is what
   covers the entire window between spawn and the first turn, during which no
   mechanism at all can name a file that does not exist. Nothing can shorten that
   window, so the scan's cost (F76) is a real running cost and not a
   one-off.

## F75 — the realpath premise was REAL, and is now irrelevant (MEASURED)

arm4 handed the spawn `/tmp/sonata-sync-2026-09/project-dir/arm4/ws` — the macOS
symlink form — while its realpath is `/private/tmp/…`. The CLI keyed the project
directory by the **realpath**: `-private-tmp-sonata-sync-2026-09-project-dir-arm4-ws`.

So `claudeCwdVariants` was not superstition; it was compensating for a real
behaviour, and a locator that used only the cwd Sonata holds would have missed
this session entirely (the capture's `== old rule(cwd)?` column reads **NO** for
this arm and `yes` for the realpath column).

It is deleted anyway, and that is the point of the slice: the id scan never asks
what the directory is called, so the realpath question — like the truncation
question, like the hash question — stops being Sonata's to answer. One class of
bug retired rather than one instance fixed.

## F76 — what the decoupling COSTS, measured through the shipped code

Not a replica — the shipped `locateSessionFile` imported from `dist/` and called
by `p1-scan-cost.mjs`, whose capture (`p1-scan-cost.capture.txt`) is the SINGLE
source of truth for every performance number in this slice: the source comments
in `session-locator.ts`, this finding, and the coupling-inventory row all cite
it. Medians of 12 warm runs, one discarded warm-up each, over this machine's real
projects root (**859 directories at the time of the run**):

| layer | shape | median | what reaches it |
|---|---|---|---|
| id scan, HIT | `readdir` + `stat` until found | **0.83 ms** | discovery once the first turn has written the file |
| id scan, MISS | `readdir` + one `stat` per directory, no early exit | **3.46 ms** | every discovery poll before the file exists (F74) — the common case |
| id-less mtime fallback, 60 s window | every dir listed, mtime filter, head read | **10.14 ms** | nothing in production |
| id-less mtime fallback, 7-day window | as above, ~2 orders more candidates | **36.44 ms** | nothing in production |

**The directory count moves on its own.** The same root held 915 entries when p1
ran that morning and 859 a few hours later (the CLI prunes). So the absolute
medians are "this machine, this many directories"; the durable claim is the
SHAPE — linear in directory count, one `stat` each, no content read.

**What this replaced** was a `readdir` of ONE slug-named directory: well under a
millisecond, never measured, and not measurable now that the code is deleted. So
the cost is stated as a shape rather than a ratio. The MISS row is the one that
matters, because F74 makes it the common case: discovery polls every 1.5 s for up
to 120 s while the transcript does not yet exist, so a task that never reaches a
first turn spends ~277 ms of `stat` across those two minutes — on the order of
0.3% of one core. Registered rather than optimized (F79.1): the saving is in
discovery's lifecycle, which this slice was scoped out of.

**The id-less rows are unreachable in production**, and that is a fact about the
call sites rather than a hope: `assembleTaskRuntime` passes
`allowMtimeFallback: false` on both entry points, and it is the only construction
site of a transcript that ever discovers. The remaining callers are the smokes.
It was kept (slug-free) rather than deleted because deleting a documented option
is a bigger change than the slice asked for.

## F77 — the one behaviour the slug was silently holding up

`claudeSessionMatchesCwd` used to end:

```ts
// Session files start with housekeeping records that carry no cwd; the
// directory slug already encodes the cwd, so accept slug-only matches.
return !head.includes('"cwd"');
```

That clause is the slug coupling in its most load-bearing form — a file that says
nothing about where it ran was accepted *because the caller had already narrowed
the search to a directory whose NAME meant the cwd*. With the search widened to
every project directory, the same clause would make any cwd-less session file, in
any folder, a match for any Task. It is removed, and a file that does not declare
its cwd no longer qualifies.

This is a genuine behaviour change and is called out rather than folded into "no
functional change": it tightens the id-LESS mtime fallback, which is the
production-unreachable path above. Every fixture in the smoke suite carries a cwd
record, so nothing measured changed.

## F78 — F2 consumed: `projectsDirectory` now has a reader

`claude auth status --json` has carried `projectsDirectory` since 2.1.258 (SL-6
recorded the field appearing; nothing read it). It is now threaded
`probe.ts` → `CliReadiness` → `RuntimeController` → `ProviderTranscript` → the
locator, as the first entry in a three-step chain
(`projectsDirectory → $CLAUDE_CONFIG_DIR/projects → ~/.claude/projects`).

**Sized honestly**: STATIC, the binary composes the root as `join(Se(),
"projects")` with `Se()` = `$CLAUDE_CONFIG_DIR ?? ~/.claude`, so at 2.1.258 the
value it reports is byte-identical to what the fallback chain derives. This buys
no user-visible fix today. What it buys is the same thing the rest of the slice
buys: the day upstream composes that path differently, Sonata follows without a
release, because it stopped deriving what the CLI is willing to say.

The value does NOT ride `CliReadinessFacts`. That shape is the renderer's IPC
payload — validated key-for-key, compared field-wise to gate the change
broadcast, and mapped over every provider — so a Claude-only operational path on
it would be wrong three ways at once. It rides an optional `observe` callback on
the probe options instead, delivered on every probe pass including the ones where
the auth command never ran (so a consumer can never hold a value from a machine
that has since lost the binary).

## F79 — register items

1. **Discovery polls the id scan for up to 120 s after a resume, finding nothing
   by construction.** On a resume the transcript is attached from
   `transcript-sources.json` before discovery starts, so it is in `excludePaths`
   and every subsequent poll is a guaranteed full-miss sweep (F76: 4.33 ms × ~80
   polls). The saving is to stop discovery once the EXPECTED id is attached and
   let `ensureDiscovery` re-arm on an id change (`/clear`) — a change to
   `ProviderTranscript`'s lifecycle, which this slice was scoped out of. Cost
   today is ~0.3% of a core per reopened task for two minutes.
2. **RESOLVED IN REVIEW, see F81** — the manifest path cache this slice first
   built was a second copy of what `transcript-sources.json` already holds, and
   was removed. The register item it would have been is now a finding.
3. **A reopen whose sources tip is MISSING on disk starts a fresh session
   rather than recovering the old one.** `readTranscriptSources` filters entries
   whose file no longer exists, so a moved `CLAUDE_CONFIG_DIR` (or any relocation
   of the transcript) empties the chain, `resumeRef` becomes null, and `openTask`
   spawns a NEW session — the locator is never consulted with the
   `providerSessionRef` the manifest still holds, even though the id scan could
   find the file at its new location. Recovering there is a change in what a
   reopen DOES (resume vs fresh start), which is a product decision for Woody and
   not a locator fix. Pre-existing; registered, not built.
4. **`e2e:codex-hooks-identity` is RED and has been since 2026-07-18** — not this
   slice. Its liveness arm creates a codex task and waits for the
   `codex-hooks-liveness` banner without ever submitting a prompt, but
   `armCodexHooksLiveness` moved to fire on the session's FIRST
   `prompt:submitted` in a16b055 (2026-07-18, the 0.144.5 sync, because
   SessionStart proved lazy). The test was last touched 2026-07-23 for an
   unrelated reason and never updated. Its first two contracts — spawn wiring and
   same-cwd identity isolation — run BEFORE the failure and did pass under this
   slice's build (the 30 s `waitFor` on both tasks' `transcript-sources.json`
   returned). Fixing the test is a codex-side change and was left alone.
5. **PRE-EXISTING, carried from U1 F70**: every probe arm answers a workspace-trust
   dialog for a fresh `/private/tmp/...` cwd and the CLI records that answer
   permanently in `~/.claude.json`'s project map. p1 re-used the same five cwds
   across both of its runs, so it added five entries, not ten. The guard brackets
   `~/.claude/settings.json` only; widening it is a program decision (see F70 for
   why a byte-restore of `~/.claude.json` would be worse than the leak).

## F81 — REVIEW ROUND: the manifest path cache was removed, because `transcript-sources.json` already IS the memory

The slice as planned had three layers, the middle one a `transcript_path` cached
in the task manifest (`Task.providerTranscriptPath`) so an offline reopen could
open the file directly. Independent review traced it and found it
**unreachable-with-effect**. The trace, verified against the code before acting:

1. the field is non-null only on a RESUME reopen — a no-resume reopen nulls it
   alongside `providerSessionRef` (`runtime-controller.ts`, the dead-binding
   void), and a fresh task has never had one;
2. on a resume, `openTask` attaches EVERY entry of `transcript-sources.json` —
   which carries the same path, written at the same `transcript:located` moment —
   *before* it calls `startDiscovery`;
3. `tryDiscover` puts every attached source's path into `excludePaths`;
4. so the cache's first test, `excludePaths.has(remembered)`, rejected it on
   every reachable path. The only shape that could have reached it is the same
   session file present in two project directories, which needs a hand copy.

The plan's layer 2 therefore already existed — it just lived in
`transcript-sources.json` rather than in the manifest — and the field was a
second copy of a fact the first copy shadowed. That is the same defect class U1
found in its own findings (two tables of the same counts, deleted rather than
reconciled, so they could not drift apart). Orchestrator's decision, recorded as
a two-way door: **delete the field and its whole pipeline.**

Removed: `Task.providerTranscriptPath`; the writes in `adoptTranscriptFromHook`
and in discovery's first-establish; the clear on a no-resume reopen;
`claudeKnownTranscriptPath` on `LocateSessionOptions` and
`ProviderTranscriptOptions`; `rememberedClaudeTranscript` and its branch; the
layer-1 and stale-cache smoke cases; the two `cross-session-isolation`
assertions about the field. The locator is now **two layers** — id scan, then the
opt-in mtime fallback — and its module header names `transcript-sources.json` as
the memory so the next reader does not re-derive the same idea.

What was NOT lost: the reopen still opens its transcript without searching, and
the long-cwd fixture, the renamed-directory case and the exact-path safety case
all still fence the thing the slice exists for. What the removal cost: nothing
measurable — layer 1 never answered.

The e2e assertions were re-pointed rather than dropped: `cross-session-isolation`
now fences that the persisted source paths are real files, are named by the id the
manifest binds, and that the chain tip FOLLOWS a `/clear` rebind — i.e. it fences
the memory that actually exists.

## F80 — evidence files

- `p1-project-dir-name.mjs` — the probe: five arms, batch-runnable
  (`node p1-project-dir-name.mjs [arm…]`, `--capture-only` to re-render). Every
  arm on record was produced by ONE run of the committed file (the U1 review's
  reproducibility rule), and the settings-guard bracket is persisted per arm to
  `.p1-results/guard-history.jsonl` so a capture assembled from several batches
  reports every bracket rather than the last batch's. `.p1-results/` is scratch —
  regenerable, unsanitized, and not evidence; the capture is the artifact.
- `p1-project-dir-name.capture.txt` — per-arm records (both independent reads of
  the directory name, the old rule's prediction for comparison, the hook payload,
  the scan timings) plus every boot and trust frame. Sanitized for `$HOME`, the
  munged `-Users-…-` form and `claude.ai` session ids; directory names derived
  from `/private/tmp/...` are left intact, because they are the evidence.
- `p1-scan-cost.mjs` / `p1-scan-cost.capture.txt` — the dist-based micro-benchmark
  and its capture: the SINGLE committed source for every performance number this
  slice quotes, in source comments, in F76 and in the inventory. It imports
  `locateSessionFile` from `dist/` rather than re-implementing the scan, which is
  the whole reason it exists as a separate file from p1 (p1 timed a replica —
  adequate as a sanity check, not as the origin of a number pinned in shipped
  source). Read-only: no spawn, no writes outside its own capture, hence the one
  probe in this program that legitimately needs no settings guard.
- `settings-guard.mjs` — the shared bracket, reused unchanged from U1 (F70).
