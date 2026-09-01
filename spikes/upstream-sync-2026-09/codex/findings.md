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
