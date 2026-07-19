#!/usr/bin/env bash
#
# Standing pre-push leak fence — Sonata (WS2, decisions D4/D7).
#
# The filter ran once; every push after cutover feeds a future-public remote,
# and this project routinely captures fixtures/corpora from REAL agent sessions.
# A one-time audit gate decays; this fence does not. It blocks any push whose
# OUTGOING range introduces a personal marker (the D4 "actual proof" — secret
# scanners do not detect personal paths) or a secret (gitleaks).
#
# Invoked as a git pre-push hook via core.hooksPath. Git feeds the hook, on
# stdin, one line per pushed ref:  <local_ref> <local_sha> <remote_ref> <remote_sha>
# Re-install after a fresh clone per dev/CLAUDE.md.
#
set -uo pipefail

ZERO=0000000000000000000000000000000000000000
REPO_ROOT="$(git rev-parse --show-toplevel)"
GITLEAKS_CFG="$REPO_ROOT/.gitleaks.toml"

# --- Personal-marker literals (fixed-string match) ------------------------
# The D4 marker set, extended per S2 review with the email literal. Any of
# these appearing in outgoing added content OR a commit message is a hard block.
MARKERS=(
  'woodyli'
  '-Users-woodyli'
  '/Users/woodyli'
  'woodystudio'
  'woodystudio.io@gmail.com'
)

# Personal-email net (ERE). S2 review flagged that replace-message carried no
# email rule — the fence must not inherit that asymmetry. The S2 scrub left
# ZERO @gmail.com addresses in history, so any future one is suspect. The net
# is gmail-specific on purpose: the synthetic sanitizer placeholder
# `user@example.com` must pass clean.
EMAIL_RE='[A-Za-z0-9._%+-]+@gmail\.com'

# --- Self-reference exclusion ---------------------------------------------
# The fence's own machinery necessarily contains the marker literals as
# detection patterns, so it must not scan itself for markers (it would always
# self-match). These files stay in the gitleaks pass (real-secret detection is
# unaffected) and are small tracked infra reviewed on every change.
INFRA_EXCLUDES=(
  ":(exclude)app/scripts/leak-fence.sh"
  ":(exclude)app/scripts/git-hooks/pre-push"
  ":(exclude).gitleaks.toml"
)

# Build the reusable "-e MARKER" argument list once.
MARKER_GREP=()
for m in "${MARKERS[@]}"; do MARKER_GREP+=(-e "$m"); done

fail=0

emit_block() {
  echo "" >&2
  echo "  ✗ LEAK FENCE: push blocked — $1" >&2
}

# --- Compute the outgoing commit range(s) from stdin ----------------------
ranges=()
while read -r local_ref local_sha remote_ref remote_sha; do
  [ -z "${local_sha:-}" ] && continue
  [ "$local_sha" = "$ZERO" ] && continue                 # branch deletion — nothing outgoing
  if [ "$remote_sha" = "$ZERO" ]; then
    ranges+=("$local_sha --not --remotes")               # new branch: everything not yet on a remote
  else
    ranges+=("$remote_sha..$local_sha")                  # incremental: only the new commits
  fi
done

# Delete-only push (or empty) — nothing to scan.
[ ${#ranges[@]} -eq 0 ] && exit 0

for range in "${ranges[@]}"; do
  # $range holds either "A..B" or "SHA --not --remotes" — word-splitting is intentional.
  # shellcheck disable=SC2086
  commits=$(git rev-list $range 2>/dev/null)
  [ -z "$commits" ] && continue

  # ---- (1) Marker scan over OUTGOING ADDED CONTENT ----
  # Diff-based: only lines this push newly introduces (the correct incremental
  # semantic; content already on the remote is not re-flagged). Fence infra is
  # excluded (see INFRA_EXCLUDES). `+++ b/...` file headers are dropped so a
  # path never masquerades as content.
  # shellcheck disable=SC2086
  added=$(git log $range -p --no-color --no-textconv -- . "${INFRA_EXCLUDES[@]}" 2>/dev/null \
            | grep '^+' | grep -v '^+++' || true)

  if [ -n "$added" ]; then
    marker_hits=$(printf '%s\n' "$added" | grep -aF "${MARKER_GREP[@]}" 2>/dev/null | head -20 || true)
    email_hits=$(printf '%s\n' "$added" | grep -aE "$EMAIL_RE" 2>/dev/null | head -20 || true)
    if [ -n "$marker_hits" ] || [ -n "$email_hits" ]; then
      emit_block "personal marker in outgoing changes (range: $range)"
      [ -n "$marker_hits" ] && printf '%s\n' "$marker_hits" | sed 's/^/      /' >&2
      [ -n "$email_hits" ]  && printf '%s\n' "$email_hits"  | sed 's/^/      /' >&2
      fail=1
    fi
  fi

  # ---- (2) Marker scan over OUTGOING COMMIT MESSAGES ----
  # shellcheck disable=SC2086
  msgs=$(git log --format='%H %s%n%b' $range 2>/dev/null)
  msg_marker_hits=$(printf '%s\n' "$msgs" | grep -aF "${MARKER_GREP[@]}" 2>/dev/null | head -20 || true)
  msg_email_hits=$(printf '%s\n' "$msgs" | grep -aE "$EMAIL_RE" 2>/dev/null | head -20 || true)
  if [ -n "$msg_marker_hits" ] || [ -n "$msg_email_hits" ]; then
    emit_block "personal marker in outgoing commit message (range: $range)"
    [ -n "$msg_marker_hits" ] && printf '%s\n' "$msg_marker_hits" | sed 's/^/      /' >&2
    [ -n "$msg_email_hits" ]  && printf '%s\n' "$msg_email_hits"  | sed 's/^/      /' >&2
    fail=1
  fi

  # ---- (3) gitleaks over the outgoing range ----
  if command -v gitleaks >/dev/null 2>&1; then
    cfg_arg=()
    [ -f "$GITLEAKS_CFG" ] && cfg_arg=(--config "$GITLEAKS_CFG")
    tmp="$(mktemp -t sonata-leak-fence-gitleaks)"
    if ! gitleaks git "$REPO_ROOT" "${cfg_arg[@]}" \
           --log-opts="$range" --redact --no-banner >"$tmp" 2>&1; then
      emit_block "gitleaks reported a finding (range: $range)"
      sed 's/^/      /' "$tmp" >&2 || true
      fail=1
    fi
    rm -f "$tmp"
  else
    echo "  ! leak-fence: gitleaks not on PATH — marker scan ran, secret scan skipped" >&2
  fi
done

if [ "$fail" -ne 0 ]; then
  echo "" >&2
  echo "  Push aborted by the standing leak fence (app/scripts/leak-fence.sh)." >&2
  echo "  Nothing was pushed. Remove the flagged content (or rewrite the range)" >&2
  echo "  before retrying. This fence guards a future-public remote." >&2
  echo "" >&2
  exit 1
fi

exit 0
