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
