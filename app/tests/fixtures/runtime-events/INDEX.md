# Runtime-event corpus — pinned snapshot (sanitized)

Captured 2026-07-03 at commit bc3fb11 (post chip-merges — the code the C2
reducer extracts from) by running every e2e with DUET_RUNTIME_EVENT_LOG, then
sanitized via scripts/sanitize-runtime-corpus.mjs (deterministic, shape-
preserving; emails/home paths/session URLs/greetings replaced, pty:data bytes
included) — smoke:corpus-lint enforces this stays true. Files are stable
NN.jsonl per app instance; content is otherwise verbatim recorded reality —
never regenerate silently (schema drift must show as a reviewed diff).
Roughly a third of the e2e suite never boots the full app (harness-only or
ELECTRON_RUN_AS_NODE tests) and therefore records nothing — absence of a
scenario dir means no app instance ran, not a capture failure.
window-state-fullscreen timed out under capture load (known flaky, passes
solo); its stream covers the run up to the kill.

**Total: 26 recorded scenarios, 4938 events, 2024 KB.**

_(inspector-folder-external retired in S5 — the Inspector window it drove is
deleted; its 85-event stream + reducer golden were removed together. Totals and
the histogram below are recomputed from the remaining 26 scenarios.)_

_(ADAPTED 2026-09-23, subtraction X2 — delivery went native and the delivery
controller was deleted. Every `delivery:state` line was rewritten to the host's
`session:state` it would have carried — `{taskId, activeRun, activeRunId,
bootLatched}` taken verbatim from the recorded payload (`activeRunId` null where
the recording predates it) — and then DEDUPED per task to the new emitter's
emit-on-change contract (591 → 124; 467 were byte-identical re-announcements of
the kept fields). All 45 `delivery:receipt` lines were dropped (no such event
exists). Every other line is byte-identical. Totals, histogram and table below
are recomputed.)_

## NOT in this corpus (mandatory hand-written adversarial fixtures for C2)

- approval:expired (broker-timeout path; incl. the S6-P2 keyed-expiry case)
- approval:persisted (Always-rule receipt)
- file:watch-error
- keyed pendingApproval retraction on run settle (fix/dormant-resume landed
  after capture scenarios exercising the old wedge)

## Global event-type histogram

- pty:data: 2869
- working-status:updated: 600
- report:updated: 317
- sessions:updated: 229
- cli-state:changed: 137
- session:state: 124
- task:updated: 114
- usage:updated: 104
- run:updated: 88
- transcript:blocks: 87
- prompt:submitted: 37
- run:started: 36
- approval:detected: 34
- file:watching: 32
- task:started: 32
- transcript:located: 28
- file:changed: 24
- approval:decision: 19
- remote-control:state: 12
- task:ready: 5
- pty:exit: 5
- option-prompt:detected: 2
- option-prompt:resolved: 1
- run:stop-requested: 1
- run:stopped: 1

## Scenarios

| scenario | files | events | types present |
|---|---|---|---|
| approval-surface | 1 | 159 | approval:decision, approval:detected, cli-state:changed, file:changed, file:watching, prompt:submitted, pty:data, report:updated, run:started, run:updated, session:state, sessions:updated, task:started, task:updated, transcript:blocks, transcript:located, usage:updated, working-status:updated |
| change-summary | 1 | 258 | approval:decision, approval:detected, cli-state:changed, file:changed, file:watching, prompt:submitted, pty:data, report:updated, run:started, run:updated, session:state, sessions:updated, task:started, task:updated, transcript:blocks, transcript:located, usage:updated, working-status:updated |
| cli-slash-semantic | 1 | 141 | cli-state:changed, file:watching, prompt:submitted, pty:data, report:updated, run:started, run:updated, session:state, sessions:updated, task:ready, task:started, task:updated, transcript:blocks, transcript:located, usage:updated, working-status:updated |
| composer-newchat-attachment | 1 | 82 | cli-state:changed, file:watching, prompt:submitted, pty:data, report:updated, run:started, run:updated, session:state, sessions:updated, task:started, task:updated, transcript:blocks, transcript:located, usage:updated, working-status:updated |
| composer-reference-attachment | 1 | 83 | cli-state:changed, file:watching, prompt:submitted, pty:data, report:updated, run:started, run:updated, session:state, sessions:updated, task:started, task:updated, transcript:blocks, transcript:located, usage:updated, working-status:updated |
| cross-session-isolation | 1 | 708 | cli-state:changed, file:changed, file:watching, prompt:submitted, pty:data, report:updated, run:started, run:updated, session:state, sessions:updated, task:ready, task:started, task:updated, transcript:blocks, transcript:located, usage:updated, working-status:updated |
| g1b-claude-hook-external | 1 | 70 | cli-state:changed, file:watching, prompt:submitted, pty:data, report:updated, run:started, run:updated, session:state, sessions:updated, task:started, task:updated, transcript:blocks, transcript:located, usage:updated, working-status:updated |
| gui-walking-skeleton | 1 | 213 | approval:decision, approval:detected, cli-state:changed, file:changed, file:watching, prompt:submitted, pty:data, report:updated, run:started, run:updated, session:state, sessions:updated, task:ready, task:started, task:updated, transcript:blocks, transcript:located, usage:updated, working-status:updated |
| new-chat | 1 | 173 | approval:decision, approval:detected, cli-state:changed, file:watching, prompt:submitted, pty:data, pty:exit, report:updated, run:started, run:updated, session:state, sessions:updated, task:ready, task:started, task:updated, transcript:blocks, transcript:located, usage:updated, working-status:updated |
| open-task | 2 | 404 | approval:decision, approval:detected, cli-state:changed, file:changed, file:watching, prompt:submitted, pty:data, report:updated, run:started, run:updated, session:state, sessions:updated, task:started, task:updated, transcript:blocks, transcript:located, usage:updated, working-status:updated |
| option-prompt-multiselect | 1 | 109 | approval:detected, cli-state:changed, file:watching, option-prompt:detected, prompt:submitted, pty:data, report:updated, run:started, run:updated, session:state, sessions:updated, task:started, task:updated, transcript:blocks, transcript:located, usage:updated, working-status:updated |
| option-prompt-surface | 1 | 133 | approval:detected, cli-state:changed, file:watching, option-prompt:detected, option-prompt:resolved, prompt:submitted, pty:data, report:updated, run:started, run:updated, session:state, sessions:updated, task:started, task:updated, transcript:blocks, transcript:located, usage:updated, working-status:updated |
| provider-locked-task | 1 | 80 | cli-state:changed, file:watching, prompt:submitted, pty:data, report:updated, run:started, run:updated, session:state, sessions:updated, task:started, task:updated, transcript:blocks, transcript:located, usage:updated, working-status:updated |
| queue-delivery | 1 | 469 | approval:decision, approval:detected, cli-state:changed, file:changed, file:watching, prompt:submitted, pty:data, report:updated, run:started, run:updated, session:state, sessions:updated, task:started, task:updated, transcript:blocks, transcript:located, usage:updated, working-status:updated |
| reading-navigation | 1 | 76 | cli-state:changed, file:watching, prompt:submitted, pty:data, report:updated, run:started, run:updated, session:state, sessions:updated, task:started, task:updated, transcript:blocks, transcript:located, usage:updated, working-status:updated |
| remote-control | 1 | 83 | cli-state:changed, file:watching, prompt:submitted, pty:data, remote-control:state, report:updated, run:started, run:updated, session:state, sessions:updated, task:started, task:updated, transcript:blocks, transcript:located, usage:updated, working-status:updated |
| remote-control-arm | 1 | 42 | cli-state:changed, file:watching, prompt:submitted, pty:data, remote-control:state, report:updated, run:started, run:updated, session:state, sessions:updated, task:started, task:updated, transcript:blocks, transcript:located, usage:updated |
| remote-control-default-resume | 1 | 83 | cli-state:changed, file:watching, prompt:submitted, pty:data, remote-control:state, report:updated, run:started, run:updated, session:state, sessions:updated, task:started, task:updated, transcript:blocks, transcript:located, usage:updated, working-status:updated |
| remote-control-default-retroactive | 1 | 70 | cli-state:changed, file:watching, prompt:submitted, pty:data, report:updated, run:started, run:updated, session:state, sessions:updated, task:started, task:updated, transcript:blocks, transcript:located, usage:updated, working-status:updated |
| remote-control-dormant | 2 | 123 | cli-state:changed, file:watching, prompt:submitted, pty:data, remote-control:state, report:updated, run:started, run:updated, session:state, sessions:updated, task:started, task:updated, transcript:blocks, transcript:located, usage:updated, working-status:updated |
| run-chat-transcript | 1 | 207 | approval:decision, approval:detected, cli-state:changed, file:changed, file:watching, prompt:submitted, pty:data, report:updated, run:started, run:updated, session:state, sessions:updated, task:started, task:updated, transcript:blocks, transcript:located, usage:updated, working-status:updated |
| run-reading-surface | 1 | 282 | approval:decision, approval:detected, cli-state:changed, file:changed, file:watching, prompt:submitted, pty:data, report:updated, run:started, run:updated, session:state, sessions:updated, task:started, task:updated, transcript:blocks, transcript:located, usage:updated, working-status:updated |
| sidebar-sessions | 1 | 382 | approval:decision, approval:detected, cli-state:changed, file:changed, file:watching, prompt:submitted, pty:data, pty:exit, report:updated, run:started, run:updated, session:state, sessions:updated, task:started, task:updated, transcript:blocks, transcript:located, usage:updated, working-status:updated |
| stop-continue | 1 | 304 | approval:decision, approval:detected, cli-state:changed, file:changed, file:watching, prompt:submitted, pty:data, report:updated, run:started, run:stop-requested, run:stopped, run:updated, session:state, sessions:updated, task:started, task:updated, transcript:blocks, transcript:located, usage:updated, working-status:updated |
| task-folder-cwd | 1 | 29 | file:watching, pty:data, pty:exit, report:updated, sessions:updated, task:started |
| transcript-selection | 1 | 175 | cli-state:changed, file:watching, prompt:submitted, pty:data, report:updated, run:started, run:updated, session:state, sessions:updated, task:started, task:updated, transcript:blocks, transcript:located, usage:updated, working-status:updated |
