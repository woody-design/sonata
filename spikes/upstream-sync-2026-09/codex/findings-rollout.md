# Upstream-sync 2026-09 — codex rollout/state-DB findings (SL-8, target 0.152.0)

Probed 2026-09-01, `codex-cli 0.152.0` pinned at the start of every probe
(r1–r6), no drift. Corpus: 1,528 local rollouts, 25 CLI versions
(0.142.0→0.152.0), 92,969 records. Materialized by the orchestrator from the
SL-8 engineer's report (the harness refuses subagent-authored report .md files).

## R-HEADLINE — Sonata's codex READING SURFACE was BLANK since 0.147.0

0.147.0 added per-thread `history_mode` (`session_meta.payload.history_mode`,
mirrored in `threads.history_mode`). `legacy` threads carry conversation as
`event_msg` → `user_message`/`agent_message`; `paginated` threads as
`event_msg` → `item_completed` wrapping `item.type` UserMessage/AgentMessage.
Keyed to the MODE, not the version (0.147.0-alphas are legacy; 0.147.0 and
every 0.152.0 thread are paginated). Local split: 1,408 legacy / 120 paginated.

Shipped normalizer over the live corpus (r6, pre-fix): 133/134 paginated
rollouts → ZERO blocks (tool cards survived via `response_item`, unchanged).
Post-fix: 301 blocks (`user-message×153, assistant-text×146, tool-call×2`);
the 21 remaining zero-block files are session_meta-only boots (0 turns).
Legacy vintage unchanged: 36,284 blocks / 1,408 rollouts / 0 throws.
Retired the `native-image-attachments` codex-half baseline failure (its lookup
needed a user-message block that didn't exist for paginated rollouts).

## R1 — state DB is a PROJECTION over rollout files, not a replacement

`state_5.sqlite` (threads, rollout_migration_state, …) +
`thread_history_1.sqlite` (thread_turns/items with `rollout_byte_offset` /
`rollout_ordinal`; `threads.rollout_path NOT NULL`). Migration tables EMPTY on
this machine. 1,526 files ↔ 1,528 thread rows, 0 unaccounted. Fresh session →
normal `sessions/YYYY/MM/DD/rollout-*.jsonl`; resume APPENDS to the same file.
- #41357 compressed lineages: MEASURED ABSENT (all .jsonl, no dup paths).
- #40494 ephemeral/subagent threads: PRESENT (51, `thread_source='subagent'`,
  same day-dir as parent, TUI hides them). Sonata safe by construction: the
  sole production `createProviderTranscript` call passes
  `allowMtimeFallback:false` (exact-id adoption). NOTE the DEFAULT is `true` —
  registered.

## R4/R5 — turn_context 6→18 fields; four consumed fields INTACT; reconcile premise HOLDS

New fields incl. `permission_profile` (#39145 confirmed), `approvals_reviewer`,
`turn_id`, `file_system_sandbox_policy` (**back** — 0.146 row said removed;
still never read). 1,966 records: only unreadable consumed field is
`approval_policy` as `{granular:{…}}` ×6 at 0.144.2/0.145.0-alpha — pre-existing;
string guard yields null → mirror kept (now pinned). Unique-projection matrix
re-measured: `(danger-full-access, never)` remains the only reconcilable
projection; ask-for-approval and approve-for-me STILL share
`(workspace-write, on-request)` splitting only on `approvals_reviewer`, which
echoes the SPAWN value — `codexPermissionModeFromTurnContext` unchanged.
`permission_profile.type` (`disabled` ↔ full-access, 472/472) buys no
resolution on the axis that needs it — deliberately not consumed.
New unconsumed records `thread_settings_applied` (live permission/model state,
245+) and `world_state` (sandbox XML) — feed the permission-mirror redesign.

## R6 — token_count: NO drift reaches the reader

16,539/16,539 live payloads parsed, 0 nulls/throws. `model_context_window`
only 258400 / 353400 — the #35608/#41803 reserve-phase worry has NO instance.
`rate_limits` gained `credits` (object), `spend_control_reached`,
`individual_limit` — additive. New MEASURED 0.152.0 fixture pinned.

## Compaction integrity — invariant AMENDED (62 records)

Partially falsified at 0.147.0-alpha.6.5: `agent_message` (multi-agent) joined
`replacement_history` as a plain item — 4 healthy compactions read
`unassessable` (the #36642 detector silently blind on the newest compacting
vintage). Vocabulary amended; alarm still requires zero `compaction` items.
Before: 58 summary-present / 4 unassessable → after: 62 / 0. Paginated-mode
compaction UNREPRODUCED (needs 258k window); degrades to `unassessable` (safe).

## locateSessionFile / head-scan

6/6 live 0.152.0 sessions (incl. resumed) MATCH on the id-anchored path.
First line now 18,543–18,571 bytes (base_instructions embedded; SHRANK from
~46,581 at 0.146) — inside the 256 KiB head budget.

## #39731 TUI parity — REPORT-ONLY

The TUI's paginated history DB is a projection BUILT FROM the rollout (byte
offsets), so the file cannot lack what the TUI shows; residual asymmetry runs
the other way (`thread_realtime_items`; projection lag puts Sonata AHEAD).
Watch item for SL-13, not a program risk.

## SL-7 evidence — attachments recorded at FULL fidelity; breakage is MODEL-side

Fresh 0.152.0 rollouts: `item_completed/UserMessage.content` carries
`{type:"local_image", path}` per image (232 measured, incl. 6-image and
space+apostrophe paths). The paired `response_item` fills every image slot with
`{"type":"input_text","text":"image content omitted because it could not be
processed"}`. NOT an attach failure — chase the model-side shape.

## Registered (not fixed here)

1. Tool-result previews render raw JSON arrays since 0.144.0 (output as
   `[{type:"input_text",text}]`; prettyJson burns the preview budget) — fixing
   it perturbs `codexOutputStatus`'s exit-code regex; own slice.
2. `allowMtimeFallback` default `true` vs sole caller passing `false` — flip
   the default (one line) in a hygiene slice.
3. `locateCodexSession` timestamp filter precedes the id match — latent only.
4. `file_system_sandbox_policy` back in turn_context — SL-13 stamp.
