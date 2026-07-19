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
INFRA_PATHS=(
  "app/scripts/leak-fence.sh"
  "app/scripts/git-hooks/pre-push"
  ".gitleaks.toml"
)

# True when $1 is a fence-infra path to skip in the marker scan.
is_infra_path() {
  local p
  for p in "${INFRA_PATHS[@]}"; do [ "$1" = "$p" ] && return 0; done
  return 1
}

# Build the reusable "-e MARKER" argument list (fixed-string, for messages).
MARKER_GREP=()
for m in "${MARKERS[@]}"; do MARKER_GREP+=(-e "$m"); done

# Build one combined ERE (markers + email) for the binary-safe blob scan, so
# each blob is scanned with a single grep. Marker literals are ERE-escaped so a
# metacharacter (e.g. the '.' in the email literal) cannot over-match.
SCAN_ERE=""
for m in "${MARKERS[@]}"; do
  esc=$(printf '%s' "$m" | sed 's/[][\.^$*+?(){}|]/\\&/g')
  SCAN_ERE="${SCAN_ERE:+$SCAN_ERE|}$esc"
done
SCAN_ERE="$SCAN_ERE|$EMAIL_RE"

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

  # ---- (1) Marker scan over OUTGOING NEW BLOBS (binary-safe) ----
  # Enumerate the blobs this push newly introduces — objects reachable in the
  # range but not already on the remote (`git rev-list --objects <range>`), which
  # keeps the incremental semantic AND is merge-safe (it walks the object graph,
  # not diffs, so no `-m` concern). Each new blob's FULL content is scanned with
  # `grep -a`, so a marker embedded in a BINARY blob (sqlite / tar / image EXIF /
  # captured corpus) is caught — the earlier `git log -p` approach printed
  # "Binary files differ" and missed it entirely (N1, WS2 S3 review). Fence infra
  # is excluded by path (it legitimately contains the marker literals); gitleaks
  # still scans it for real secrets.
  #
  # rev-list --objects prints "<sha> <path>" for blobs/subtrees and a bare
  # "<sha>" for commits/root-trees; we keep only path-bearing, non-infra entries
  # and confirm blob type before scanning.
  pairs="$(mktemp -t sonata-leak-fence-blobs)"
  # shellcheck disable=SC2086
  git rev-list --objects $range 2>/dev/null \
    | awk 'NF>=2 { sha=$1; path=substr($0, index($0,$2)); print sha"\t"path }' \
    > "$pairs"

  hit_paths=""
  while IFS="$(printf '\t')" read -r sha path; do
    [ -n "$path" ] || continue
    is_infra_path "$path" && continue
    [ "$(git cat-file -t "$sha" 2>/dev/null)" = blob ] || continue
    if git cat-file blob "$sha" 2>/dev/null \
         | grep -aqE -e "$SCAN_ERE" 2>/dev/null; then
      hit_paths="${hit_paths}${path}"$'\n'
    fi
  done < "$pairs"
  rm -f "$pairs"

  if [ -n "$hit_paths" ]; then
    emit_block "personal marker in outgoing new blob content (range: $range)"
    printf '%s' "$hit_paths" | sed '/^$/d;s/^/      /' >&2
    fail=1
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
