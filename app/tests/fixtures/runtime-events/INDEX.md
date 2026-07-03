# Runtime-event corpus — pinned snapshot

Captured 2026-07-03 at commit c325cc4 by running every e2e with
`DUET_RUNTIME_EVENT_LOG` (recorder tap at the main-process sendEvent seam,
landed in map step A1). Files are renamed to stable NN.jsonl per app
instance; content is verbatim recorded reality — never regenerate silently
(schema drift must show as a reviewed diff). run-reading-surface timed out
under back-to-back capture load; its entry is a clean solo re-capture.
Known-red tests are included deliberately — their streams cover rare paths
up to the failure point (dormant-open, entry churn).

**Total: 36 scenarios, 5810 events, 2501 KB.**

## NOT in this corpus (mandatory hand-written adversarial fixtures for C2)

- approval:expired (broker-timeout path; incl. the S6-P2 keyed-expiry case)
- approval:persisted (Always-rule receipt)
- file:watch-error

## Global event-type histogram

- pty:data: 2662
- delivery:state: 1090
- working-status:updated: 559
- report:updated: 344
- sessions:updated: 243
- cli-state:changed: 155
- task:updated: 130
- usage:updated: 113
- run:updated: 103
- transcript:blocks: 87
- delivery:receipt: 43
- approval:detected: 41
- prompt:submitted: 36
- run:started: 35
- file:watching: 32
- task:started: 32
- transcript:located: 28
- approval:decision: 27
- file:changed: 25
- remote-control:state: 12
- task:ready: 5
- pty:exit: 3
- option-prompt:detected: 2
- option-prompt:resolved: 1
- run:stop-requested: 1
- run:stopped: 1

## Scenarios

| scenario | files | events | types present |
|---|---|---|---|
| approval-surface | 1 | 152 | approval:decision, approval:detected, cli-state:changed, delivery:receipt, delivery:state, file:changed, file:watching, prompt:submitted, pty:data, report:updated, run:started, run:updated, sessions:updated, task:started, task:updated, transcript:blocks, transcript:located, usage:updated, working-status:updated |
| change-summary | 1 | 328 | approval:decision, approval:detected, cli-state:changed, delivery:receipt, delivery:state, file:changed, file:watching, prompt:submitted, pty:data, report:updated, run:started, run:updated, sessions:updated, task:started, task:updated, transcript:blocks, transcript:located, usage:updated, working-status:updated |
| cli-slash-dispatch | 0 | 0 |  |
| cli-slash-semantic | 1 | 160 | cli-state:changed, delivery:receipt, delivery:state, file:watching, prompt:submitted, pty:data, report:updated, run:started, run:updated, sessions:updated, task:ready, task:started, task:updated, transcript:blocks, transcript:located, usage:updated, working-status:updated |
| composer-ime | 0 | 0 |  |
| composer-newchat-attachment | 1 | 91 | cli-state:changed, delivery:receipt, delivery:state, file:watching, prompt:submitted, pty:data, report:updated, run:started, run:updated, sessions:updated, task:started, task:updated, transcript:blocks, transcript:located, usage:updated, working-status:updated |
| composer-reference-attachment | 1 | 89 | cli-state:changed, delivery:receipt, delivery:state, file:watching, prompt:submitted, pty:data, report:updated, run:started, run:updated, sessions:updated, task:started, task:updated, transcript:blocks, transcript:located, usage:updated, working-status:updated |
| composer-slash-picker | 0 | 0 |  |
| cross-session-isolation | 1 | 844 | cli-state:changed, delivery:receipt, delivery:state, file:changed, file:watching, prompt:submitted, pty:data, report:updated, run:started, run:updated, sessions:updated, task:ready, task:started, task:updated, transcript:blocks, transcript:located, usage:updated, working-status:updated |
| g1b-claude-hook-external | 1 | 78 | cli-state:changed, delivery:receipt, delivery:state, file:watching, prompt:submitted, pty:data, report:updated, run:started, run:updated, sessions:updated, task:started, task:updated, transcript:blocks, transcript:located, usage:updated, working-status:updated |
| gui-walking-skeleton | 1 | 306 | approval:decision, approval:detected, cli-state:changed, delivery:receipt, delivery:state, file:changed, file:watching, prompt:submitted, pty:data, report:updated, run:started, run:updated, sessions:updated, task:started, task:updated, transcript:blocks, transcript:located, usage:updated, working-status:updated |
| inspector-folder-external | 1 | 86 | cli-state:changed, delivery:receipt, delivery:state, file:changed, file:watching, prompt:submitted, pty:data, report:updated, run:started, run:updated, sessions:updated, task:started, task:updated, transcript:blocks, transcript:located, usage:updated, working-status:updated |
| new-chat | 0 | 0 |  |
| open-task | 2 | 422 | approval:decision, approval:detected, cli-state:changed, delivery:receipt, delivery:state, file:changed, file:watching, prompt:submitted, pty:data, report:updated, run:started, run:updated, sessions:updated, task:started, task:updated, transcript:blocks, transcript:located, usage:updated, working-status:updated |
| option-prompt-multiselect | 1 | 114 | approval:detected, cli-state:changed, delivery:receipt, delivery:state, file:watching, option-prompt:detected, prompt:submitted, pty:data, report:updated, run:started, run:updated, sessions:updated, task:started, task:updated, transcript:blocks, transcript:located, usage:updated, working-status:updated |
| option-prompt-surface | 1 | 127 | approval:detected, cli-state:changed, delivery:receipt, delivery:state, file:watching, option-prompt:detected, option-prompt:resolved, prompt:submitted, pty:data, report:updated, run:started, run:updated, sessions:updated, task:started, task:updated, transcript:blocks, transcript:located, usage:updated, working-status:updated |
| provider-locked-task | 1 | 76 | cli-state:changed, delivery:receipt, delivery:state, file:watching, prompt:submitted, pty:data, report:updated, run:started, run:updated, sessions:updated, task:started, task:updated, transcript:blocks, transcript:located, usage:updated, working-status:updated |
| queue-delivery | 1 | 467 | approval:decision, approval:detected, cli-state:changed, delivery:receipt, delivery:state, file:changed, file:watching, prompt:submitted, pty:data, report:updated, run:started, run:updated, sessions:updated, task:started, task:updated, transcript:blocks, transcript:located, usage:updated, working-status:updated |
| reading-navigation | 1 | 85 | cli-state:changed, delivery:receipt, delivery:state, file:watching, prompt:submitted, pty:data, report:updated, run:started, run:updated, sessions:updated, task:started, task:updated, transcript:blocks, transcript:located, usage:updated, working-status:updated |
| reading-settings | 0 | 0 |  |
| remote-control | 1 | 95 | cli-state:changed, delivery:receipt, delivery:state, file:watching, prompt:submitted, pty:data, remote-control:state, report:updated, run:started, run:updated, sessions:updated, task:started, task:updated, transcript:blocks, transcript:located, usage:updated, working-status:updated |
| remote-control-arm | 1 | 54 | cli-state:changed, delivery:receipt, delivery:state, file:watching, prompt:submitted, pty:data, remote-control:state, report:updated, run:started, run:updated, sessions:updated, task:started, task:updated, transcript:located, usage:updated, working-status:updated |
| remote-control-default | 0 | 0 |  |
| remote-control-default-resume | 1 | 83 | cli-state:changed, delivery:receipt, delivery:state, file:watching, prompt:submitted, pty:data, remote-control:state, report:updated, run:started, run:updated, sessions:updated, task:started, task:updated, transcript:blocks, transcript:located, usage:updated, working-status:updated |
| remote-control-default-retroactive | 1 | 77 | cli-state:changed, delivery:receipt, delivery:state, file:watching, prompt:submitted, pty:data, report:updated, run:started, run:updated, sessions:updated, task:started, task:updated, transcript:blocks, transcript:located, usage:updated, working-status:updated |
| remote-control-dormant | 2 | 594 | cli-state:changed, delivery:receipt, delivery:state, file:watching, prompt:submitted, pty:data, remote-control:state, report:updated, run:started, run:updated, sessions:updated, task:started, task:updated, transcript:blocks, transcript:located, usage:updated, working-status:updated |
| run-chat-transcript | 1 | 220 | approval:decision, approval:detected, cli-state:changed, delivery:receipt, delivery:state, file:changed, file:watching, prompt:submitted, pty:data, report:updated, run:started, run:updated, sessions:updated, task:ready, task:started, task:updated, transcript:blocks, transcript:located, usage:updated, working-status:updated |
| run-reading-surface | 1 | 330 | approval:decision, approval:detected, cli-state:changed, delivery:receipt, delivery:state, file:changed, file:watching, prompt:submitted, pty:data, report:updated, run:started, run:updated, sessions:updated, task:started, task:updated, transcript:blocks, transcript:located, usage:updated, working-status:updated |
| settings-overlay | 0 | 0 |  |
| settings-screenshots | 0 | 0 |  |
| sidebar-sessions | 1 | 417 | approval:decision, approval:detected, cli-state:changed, delivery:receipt, delivery:state, file:changed, file:watching, prompt:submitted, pty:data, report:updated, run:started, run:updated, sessions:updated, task:ready, task:started, task:updated, transcript:blocks, transcript:located, usage:updated, working-status:updated |
| stop-continue | 1 | 300 | approval:decision, approval:detected, cli-state:changed, delivery:receipt, delivery:state, file:changed, file:watching, prompt:submitted, pty:data, report:updated, run:started, run:stop-requested, run:stopped, run:updated, sessions:updated, task:started, task:updated, transcript:blocks, transcript:located, usage:updated, working-status:updated |
| task-folder-cwd | 1 | 29 | file:watching, pty:data, pty:exit, report:updated, sessions:updated, task:started |
| transcript-selection | 1 | 186 | cli-state:changed, delivery:receipt, delivery:state, file:watching, prompt:submitted, pty:data, report:updated, run:started, run:updated, sessions:updated, task:started, task:updated, transcript:blocks, transcript:located, usage:updated, working-status:updated |
| window-state-fullscreen | 0 | 0 |  |
| window-state-persistence | 0 | 0 |  |
