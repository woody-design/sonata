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
