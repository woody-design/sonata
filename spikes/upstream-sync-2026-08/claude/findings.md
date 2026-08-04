# Probe S2 — claude 2.1.220 measured findings (2026-08-03)

Status: PASS — all six questions measured against the real `claude 2.1.220`
binary. Harness: fresh node-pty + `@xterm/headless` driver (`driver.mjs`,
120x40, TERM=xterm-256color, CLAUDE*/ANTHROPIC_MODEL env stripped) preserving
cell attributes + terminal cursor; needle verification ran the PRODUCTION
parsers from `app/dist/runtime` over raw captures (`check-needles.mjs`).
All spawns in throwaway scratch cwds; trust granted in exactly one disposable
dir; no permission rule approved; `$HOME/.claude/settings.json` restored
byte-exact (sha256 verified before/after).

Written by the orchestrator from the S2 agent's report (harness policy blocks
subagent-authored report files). Raw evidence: `*.capture.txt` in this dir.

## Q1 (F5) trust dialog — PASS, needles intact, no boot-hang risk

2.1.218 change is purely ADDITIVE: new `Accessing workspace:` header + bold
workspace path ABOVE the unchanged question. All pre-existing lines
byte-unchanged. `CLAUDE_WORKSPACE_TRUST_APPROVAL_HINTS` 4/4 HIT
("quick safety check" / "is this a project you created or one you trust" /
"yes, i trust this folder" / "enter to confirm"); `parseClaudeApprovalPanel`
→ kind workspace-trust, options 1 "Yes, I trust this folder" / 2 "No, exit".

CONSEQUENCE to record: `parseClaudePanelAtAnchor`'s fingerprint window now
embeds the workspace PATH → trust fingerprints stored at ≤2.1.217 no longer
match (two scratch dirs → two different hashes). Per-directory is arguably
more correct; check the approval-trail/resurface store at re-stamp.

## Q2 (F6) /model picker + receipts — PASS, needles intact

Picker at 2.1.220 (5 rows): `1. Default (recommended)` (= Opus 5 1M),
`2. Opus (1M context)`, `3. Fable ✔`, `4. Sonnet`, `5. Haiku`. NO "new"
marker anywhere — the 2.1.219 "highlight the newest model" changelog line
does NOT manifest as any row decoration; only `✔` marks the current model.
Highlight = `❯` glyph + label recolored to accent fg (#B1B9F9); current
model green (#4EBA65, wins over accent). NO inverse video, NO bg color
anywhere in the picker.

Terminal cursor lands exactly on the `❯` cell and tracks the focused row on
every press (2.1.218 confirmed; also true on the trust dialog). Cursor-read
is now a VALID focused-row oracle for claude panels.

Per-model effort row inside the picker: `◐ Medium effort ←/→ to adjust`
(mutates with focus; `○ Effort not supported for Haiku`). Focus wraps 5→1.

Receipts (injected byte-for-byte like `writeClaudeValueCommand`: typed chars
+ deferred raw `\r` at 120ms):
- `/model sonnet` → `⎿  Set model to Sonnet 5 and saved as your default for
  new sessions` → parser `settled`
- `/model bogus-model-xyz` → `⎿  Model 'bogus-model-xyz' not found` → `failed`
- picker + `s` → `⎿  Set model to Haiku 4.5 for this session only` → `settled`
Success tail drifted (added "for new sessions") — harmless, needle is prefix.
Arg forms remain safe on claude (no turn burned).

NEW SURFACE / UNLOCK: picker footer `Enter to set as default · s to use this
session only`. Sonata's `/model <alias>` arg form REWRITES the user's global
`~/.claude/settings.json` default (measured); the `s` path is session-scoped
and does not. Backlog candidate: session-scoped switching.

## Q3 (F7) double-ESC at idle — CONFIRMED; guard holds by ~100ms

Esc-pair at idle opens the Rewind panel; single Esc is a no-op; one Esc
dismisses the panel cleanly. Measured threshold: pair fires at gaps ≤700ms,
not at ≥800ms → threshold in (700, 800].

Code-path audit: `ESC.repeat(pickerLevel)` (control-switch-engine.ts:2051)
is CODEX-ONLY (axis "codex-model"); all multi-Esc switch-engine paths are
codex-only; claude's `failParked` writes ONE Esc. The genuinely exposed pair
is terminal-host.ts stopRun (:1976) + noteToolActivityAfterStop retry
(:2127), gated by `STOP_ESC_RETRY_MIN_MS = 800` with `elapsed < 800 →
return` — an elapsed of exactly 800ms fires. Guard HOLDS at 2.1.220 with
~100ms margin. RECOMMENDATION: raise to ~1200ms (one constant).

Secondary: an open Rewind panel is INVISIBLE to all claude parsers (no
approval candidate, completed:false/low, no panel parse) — Sonata neither
warns nor mis-fires, but a delivered prompt's Enter would hit `Enter to
continue` (a RESTORE action). Candidate interstitial anchor: body
`Restore the code and/or conversation to the point before` co-occurring
with `Enter to continue`.

## Q4 activity hint — static hypothesis REFUTED; no change needed

`esc to interrupt` RENDERS contiguously at runtime (footer token 2 swaps
while working: `⏸ manual mode on · esc to interrupt · ← for agents`).
All spinner glyphs ✢✳✶✻✽· present. `activityHints[0]` matches directly.
(Bun-compiled binary hid the literal; runtime disproves — absence-in-binary
is weak evidence, as flagged.)

## Q5 idle footer — PASS, byte-identical

`⏸ manual mode on · ? for shortcuts · ← for agents` byte-identical to the
form on record; `idlePromptModelHints` matches on `shortcuts`/`for agents`.
NEW adjacent surface: right-aligned `◐ medium · /effort` status line one row
above the composer rule at idle — a second independent hint match. Harmless;
readiness no longer depends solely on the footer.

## Q6 (F4) emoji autocomplete — SEVERITY RAISED TO CORRECTNESS

- Typed `:hea` → popup opens (5 rows).
- BRACKETED PASTE with trailing `:hea` → popup ALSO opens (not
  keystroke-gated). Mid-string colon tokens do NOT trigger; the trigger is
  "colon token ends at the cursor" = a pasted prompt's LAST token.
- With popup open, BOTH submit encodings (`\x1b[13u` CSI-u Enter — Sonata's
  paste-path submit — and raw `\r`) are SWALLOWED: emoji inserted, prompt
  NOT submitted. A Sonata prompt ending in `:word` is silently mutated and
  never sent → stalled delivery until receipt timeout.
- Kill switch VERIFIED: `--settings {"emojiCompletionEnabled": false}` fully
  suppresses popup for typed AND pasted input.

F4 is a correctness fix, not polish. `ensureClaudeRuntimeSettings` adds the key.

## Evidence files

q1-trust.capture.txt · q2a-model-picker.capture.txt ·
q2b-model-receipts.capture.txt · q3a-esc-nohistory.capture.txt ·
q3c-esc-window.capture.txt · q4q3b-activity-esc.capture.txt ·
q5-footer.capture.txt · q6-emoji-default.capture.txt ·
q6-emoji-suppressed.capture.txt · q6b-emoji-enter.capture.txt ·
driver.mjs · check-needles.mjs

## Deviation ledger (agent's, accepted by orchestrator)

Fresh attribute-preserving harness (legacy strips ANSI — cannot answer
highlight/cursor questions); production-parser needle checks via app/dist;
trust granted in one scratch dir (`~/.claude.json` gained one cosmetic
projects entry); settings.json snapshot/restored byte-exact; added
bogus-model, `s`-leg, Esc timing sweep, Enter-swallow legs, suppressed-run
verification beyond brief (each closed a load-bearing unknown).
