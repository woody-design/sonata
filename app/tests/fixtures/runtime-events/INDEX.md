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

**Total: 26 recorded scenarios, 5450 events, 2297 KB.**

_(inspector-folder-external retired in S5 — the Inspector window it drove is
deleted; its 85-event stream + reducer golden were removed together. Totals and
the histogram below are recomputed from the remaining 26 scenarios.)_

## NOT in this corpus (mandatory hand-written adversarial fixtures for C2)

- approval:expired (broker-timeout path; incl. the S6-P2 keyed-expiry case)
- approval:persisted (Always-rule receipt)
- file:watch-error
- keyed pendingApproval retraction on run settle (fix/dormant-resume landed
  after capture scenarios exercising the old wedge)

## Global event-type histogram

- pty:data: 2869
- working-status:updated: 600
- delivery:state: 591
- report:updated: 317
- sessions:updated: 229
- cli-state:changed: 137
- task:updated: 114
- usage:updated: 104
- run:updated: 88
- transcript:blocks: 87
- delivery:receipt: 45
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
| approval-surface | 1 | 174 | approval:decision, approval:detected, cli-state:changed, delivery:receipt, delivery:state, file:changed, file:watching, prompt:submitted, pty:data, report:updated, run:started, run:updated, sessions:updated, task:started, task:updated, transcript:blocks, transcript:located, usage:updated, working-status:updated |
| change-summary | 1 | 282 | approval:decision, approval:detected, cli-state:changed, delivery:receipt, delivery:state, file:changed, file:watching, prompt:submitted, pty:data, report:updated, run:started, run:updated, sessions:updated, task:started, task:updated, transcript:blocks, transcript:located, usage:updated, working-status:updated |
| cli-slash-semantic | 1 | 171 | cli-state:changed, delivery:receipt, delivery:state, file:watching, prompt:submitted, pty:data, report:updated, run:started, run:updated, sessions:updated, task:ready, task:started, task:updated, transcript:blocks, transcript:located, usage:updated, working-status:updated |
| composer-newchat-attachment | 1 | 93 | cli-state:changed, delivery:receipt, delivery:state, file:watching, prompt:submitted, pty:data, report:updated, run:started, run:updated, sessions:updated, task:started, task:updated, transcript:blocks, transcript:located, usage:updated, working-status:updated |
| composer-reference-attachment | 1 | 92 | cli-state:changed, delivery:receipt, delivery:state, file:watching, prompt:submitted, pty:data, report:updated, run:started, run:updated, sessions:updated, task:started, task:updated, transcript:blocks, transcript:located, usage:updated, working-status:updated |
| cross-session-isolation | 1 | 757 | cli-state:changed, delivery:receipt, delivery:state, file:changed, file:watching, prompt:submitted, pty:data, report:updated, run:started, run:updated, sessions:updated, task:ready, task:started, task:updated, transcript:blocks, transcript:located, usage:updated, working-status:updated |
| g1b-claude-hook-external | 1 | 81 | cli-state:changed, delivery:receipt, delivery:state, file:watching, prompt:submitted, pty:data, report:updated, run:started, run:updated, sessions:updated, task:started, task:updated, transcript:blocks, transcript:located, usage:updated, working-status:updated |
| gui-walking-skeleton | 1 | 240 | approval:decision, approval:detected, cli-state:changed, delivery:receipt, delivery:state, file:changed, file:watching, prompt:submitted, pty:data, report:updated, run:started, run:updated, sessions:updated, task:ready, task:started, task:updated, transcript:blocks, transcript:located, usage:updated, working-status:updated |
| new-chat | 1 | 185 | approval:decision, approval:detected, cli-state:changed, delivery:receipt, delivery:state, file:watching, prompt:submitted, pty:data, pty:exit, report:updated, run:started, run:updated, sessions:updated, task:ready, task:started, task:updated, transcript:blocks, transcript:located, usage:updated, working-status:updated |
| open-task | 2 | 443 | approval:decision, approval:detected, cli-state:changed, delivery:receipt, delivery:state, file:changed, file:watching, prompt:submitted, pty:data, report:updated, run:started, run:updated, sessions:updated, task:started, task:updated, transcript:blocks, transcript:located, usage:updated, working-status:updated |
| option-prompt-multiselect | 1 | 120 | approval:detected, cli-state:changed, delivery:receipt, delivery:state, file:watching, option-prompt:detected, prompt:submitted, pty:data, report:updated, run:started, run:updated, sessions:updated, task:started, task:updated, transcript:blocks, transcript:located, usage:updated, working-status:updated |
| option-prompt-surface | 1 | 145 | approval:detected, cli-state:changed, delivery:receipt, delivery:state, file:watching, option-prompt:detected, option-prompt:resolved, prompt:submitted, pty:data, report:updated, run:started, run:updated, sessions:updated, task:started, task:updated, transcript:blocks, transcript:located, usage:updated, working-status:updated |
| provider-locked-task | 1 | 91 | cli-state:changed, delivery:receipt, delivery:state, file:watching, prompt:submitted, pty:data, report:updated, run:started, run:updated, sessions:updated, task:started, task:updated, transcript:blocks, transcript:located, usage:updated, working-status:updated |
| queue-delivery | 1 | 502 | approval:decision, approval:detected, cli-state:changed, delivery:receipt, delivery:state, file:changed, file:watching, prompt:submitted, pty:data, report:updated, run:started, run:updated, sessions:updated, task:started, task:updated, transcript:blocks, transcript:located, usage:updated, working-status:updated |
| reading-navigation | 1 | 86 | cli-state:changed, delivery:receipt, delivery:state, file:watching, prompt:submitted, pty:data, report:updated, run:started, run:updated, sessions:updated, task:started, task:updated, transcript:blocks, transcript:located, usage:updated, working-status:updated |
| remote-control | 1 | 97 | cli-state:changed, delivery:receipt, delivery:state, file:watching, prompt:submitted, pty:data, remote-control:state, report:updated, run:started, run:updated, sessions:updated, task:started, task:updated, transcript:blocks, transcript:located, usage:updated, working-status:updated |
| remote-control-arm | 1 | 55 | cli-state:changed, delivery:receipt, delivery:state, file:watching, prompt:submitted, pty:data, remote-control:state, report:updated, run:started, run:updated, sessions:updated, task:started, task:updated, transcript:blocks, transcript:located, usage:updated |
| remote-control-default-resume | 1 | 95 | cli-state:changed, delivery:receipt, delivery:state, file:watching, prompt:submitted, pty:data, remote-control:state, report:updated, run:started, run:updated, sessions:updated, task:started, task:updated, transcript:blocks, transcript:located, usage:updated, working-status:updated |
| remote-control-default-retroactive | 1 | 82 | cli-state:changed, delivery:receipt, delivery:state, file:watching, prompt:submitted, pty:data, report:updated, run:started, run:updated, sessions:updated, task:started, task:updated, transcript:blocks, transcript:located, usage:updated, working-status:updated |
| remote-control-dormant | 2 | 146 | cli-state:changed, delivery:receipt, delivery:state, file:watching, prompt:submitted, pty:data, remote-control:state, report:updated, run:started, run:updated, sessions:updated, task:started, task:updated, transcript:blocks, transcript:located, usage:updated, working-status:updated |
| run-chat-transcript | 1 | 226 | approval:decision, approval:detected, cli-state:changed, delivery:receipt, delivery:state, file:changed, file:watching, prompt:submitted, pty:data, report:updated, run:started, run:updated, sessions:updated, task:started, task:updated, transcript:blocks, transcript:located, usage:updated, working-status:updated |
| run-reading-surface | 1 | 308 | approval:decision, approval:detected, cli-state:changed, delivery:receipt, delivery:state, file:changed, file:watching, prompt:submitted, pty:data, report:updated, run:started, run:updated, sessions:updated, task:started, task:updated, transcript:blocks, transcript:located, usage:updated, working-status:updated |
| sidebar-sessions | 1 | 416 | approval:decision, approval:detected, cli-state:changed, delivery:receipt, delivery:state, file:changed, file:watching, prompt:submitted, pty:data, pty:exit, report:updated, run:started, run:updated, sessions:updated, task:started, task:updated, transcript:blocks, transcript:located, usage:updated, working-status:updated |
| stop-continue | 1 | 337 | approval:decision, approval:detected, cli-state:changed, delivery:receipt, delivery:state, file:changed, file:watching, prompt:submitted, pty:data, report:updated, run:started, run:stop-requested, run:stopped, run:updated, sessions:updated, task:started, task:updated, transcript:blocks, transcript:located, usage:updated, working-status:updated |
| task-folder-cwd | 1 | 29 | file:watching, pty:data, pty:exit, report:updated, sessions:updated, task:started |
| transcript-selection | 1 | 197 | cli-state:changed, delivery:receipt, delivery:state, file:watching, prompt:submitted, pty:data, report:updated, run:started, run:updated, sessions:updated, task:started, task:updated, transcript:blocks, transcript:located, usage:updated, working-status:updated |
