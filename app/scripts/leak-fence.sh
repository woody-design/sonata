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

# git passes the pre-push hook the remote NAME as $1 (and its URL as $2). We use
# the name to scope a new-branch/tag range to the remote actually being pushed
# (see the range computation below). Absent (e.g. manual invocation) -> empty.
REMOTE_NAME="${1:-}"

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

warn() { echo "  ! leak-fence: $1" >&2; }

# mktemp wrapper — portable template form (GNU mktemp rejects BSD `-t NAME`, and
# a silent mktemp failure would chain into scanning ZERO objects). Fail LOUD and
# fail CLOSED: on failure it emits the block message and RETURNS non-zero. It is
# always called as `x="$(make_temp)" || exit 1` — because it runs inside command
# substitution, an `exit` here would only kill that subshell and leave the parent
# scanning an empty path (an ambiguous redirect that silently skips the scan), so
# the CALLER must propagate the failure into a real block.
make_temp() {
  local t
  t="$(mktemp "${TMPDIR:-/tmp}/sonata-leak-fence.XXXXXX")" || {
    emit_block "could not create a temp file (mktemp failed) — cannot scan safely"
    return 1
  }
  printf '%s' "$t"
}

# --- Compute the outgoing commit range(s) from stdin ----------------------
# A "range" string is later word-split intentionally and fed to git as either
# "A..B" (incremental) or "SHA --not --remotes[=<remote>]" (new ref). We also
# collect annotated-tag object shas whose messages/tagger identity must be
# scanned (git log peels tags, so tag content escapes the message scan).
ranges=()
# local_ref / remote_ref name git's per-ref stdin contract for documentation;
# only the shas drive the range. shellcheck: they are intentionally unread.
# shellcheck disable=SC2034
while read -r local_ref local_sha remote_ref remote_sha; do
  [ -z "${local_sha:-}" ] && continue
  [ "$local_sha" = "$ZERO" ] && continue                 # branch deletion — nothing outgoing
  if [ "$remote_sha" = "$ZERO" ]; then
    # New ref (branch or tag). Scope the "already elsewhere" exclusion to the
    # remote actually being pushed, not ALL remotes — otherwise commits present
    # only on a DIFFERENT remote would be excluded from the scan of THIS push.
    # Unknown remote name (manual run / URL push) -> --remotes (scans more).
    if [ -n "$REMOTE_NAME" ]; then
      ranges+=("$local_sha --not --remotes=$REMOTE_NAME")
    else
      ranges+=("$local_sha --not --remotes")
    fi
  elif git cat-file -e "${remote_sha}^{commit}" 2>/dev/null; then
    ranges+=("$remote_sha..$local_sha")                  # incremental: only the new commits
  else
    # The remote sha is NOT present in this local repo, so "$remote_sha..$local_sha"
    # cannot be computed — git rev-list would exit non-zero with empty output,
    # indistinguishable from "nothing outgoing". Do NOT silently skip. Fall back
    # to scanning everything on $local_sha not known to be on a remote (over-
    # approximate on purpose: fail toward MORE scanning), and warn.
    warn "remote sha ${remote_sha} is not present locally — cannot compute an incremental range; scanning ${local_sha} against all remotes instead"
    ranges+=("$local_sha --not --remotes")
  fi
done

# Delete-only push (or empty) — nothing to scan.
[ ${#ranges[@]} -eq 0 ] && exit 0

for range in "${ranges[@]}"; do
  # $range holds either "A..B" or "SHA --not --remotes[=<remote>]" — word-splitting
  # is intentional. Validate the range resolves (rev-list exits 0) so a genuine
  # failure — e.g. a sha that is not present locally — is caught and blocks,
  # rather than looking like an empty "nothing outgoing" range.
  #
  # Do NOT skip the range when it yields zero COMMITS: an annotated tag pointing
  # at an already-pushed commit introduces a new TAG object with zero new commits,
  # and skipping here would let its message/tagger identity escape unscanned. The
  # per-object and gitleaks passes below are each no-ops on a truly empty range,
  # so proceeding unconditionally is correct and cheap.
  # shellcheck disable=SC2086
  if ! git rev-list $range >/dev/null 2>&1; then
    emit_block "could not enumerate the outgoing range ($range) — scan infrastructure error"
    fail=1
    continue
  fi

  # ---- (1) Marker scan over OUTGOING NEW OBJECTS (blobs + tags, binary-safe) ----
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
  # rev-list --objects prints "<sha> <path>" for blobs/subtrees, "<sha> <tagname>"
  # for annotated tag objects, and a bare "<sha>" for commits/root-trees; we keep
  # only path-bearing, non-infra entries and branch on the object TYPE below.
  # ANNOTATED TAGS: their message lives in a `tag` object, not in any commit —
  # `git log` peels tags, so the commit-message scan below never sees it.
  # rev-list --objects DOES list the tag object (with the tag name as its
  # "path"), so scanning the tag MESSAGE here closes that escape hatch (the
  # tagger identity line is left unscanned — see the `tag)` case).
  pairs="$(make_temp)" || exit 1
  # shellcheck disable=SC2086
  git rev-list --objects $range 2>/dev/null \
    | awk 'NF>=2 { sha=$1; path=substr($0, index($0,$2)); print sha"\t"path }' \
    > "$pairs"

  hit_paths=""
  scan_errors=""      # any object we could not fully scan — fail CLOSED (block).
  while IFS="$(printf '\t')" read -r sha path; do
    [ -n "$path" ] || continue
    is_infra_path "$path" && continue
    otype="$(git cat-file -t "$sha" 2>/dev/null)"
    case "$otype" in
      blob)
        # Stream the FULL blob into grep. The match verdict is grep's OWN exit
        # status (PIPESTATUS[1]), NEVER the pipeline status: with `grep -q`, an
        # early match closes the pipe and the producer dies SIGPIPE(141), which
        # under `pipefail` becomes the pipeline status and would (the original
        # bug) discard the hit for any blob larger than the pipe buffer. Reading
        # grep's status directly makes the verdict independent of blob size and
        # marker position. Fail CLOSED: a producer/grep error (not a clean
        # no-match) is recorded as a scan error and blocks the push.
        git cat-file blob "$sha" 2>/dev/null | grep -aqE -e "$SCAN_ERE"
        # Snapshot the WHOLE array in one read: a later bare assignment resets
        # PIPESTATUS, so reading [1] then [0] separately would clobber the second.
        st=("${PIPESTATUS[@]}"); grc=${st[1]}; cfrc=${st[0]}
        if [ "$grc" -eq 0 ]; then
          hit_paths="${hit_paths}${path}"$'\n'
        elif [ "$grc" -ne 1 ] || [ "$cfrc" -ne 0 ]; then
          scan_errors="${scan_errors}${path} (blob ${sha}: cat-file=${cfrc} grep=${grc})"$'\n'
        fi
        ;;
      tag)
        # Scan the tag MESSAGE only (everything after the first blank line),
        # mirroring the commit treatment below: message scanned, identity NOT.
        # The `tagger` line carries git's configured user.email, which O2
        # sanctions as public (woodystudio.io@gmail.com already authors every
        # commit on the remote, and the fence deliberately does not scan
        # commit author/committer identity) — scanning it would false-block the
        # D14 `git tag -a` release workflow on its own tagger line. Capture the
        # object, then grep a here-string: no pipe, so no PIPESTATUS subtlety.
        # The tag NAME line is left unscanned, consistent with branch names.
        tag_obj="$(git cat-file tag "$sha" 2>/dev/null)"
        tcrc=$?
        if [ "$tcrc" -ne 0 ]; then
          scan_errors="${scan_errors}${path} (tag ${sha}: unreadable, cat-file=${tcrc})"$'\n'
        else
          tag_msg="$(sed '1,/^$/d' <<<"$tag_obj")"
          grep -aqE -e "$SCAN_ERE" <<<"$tag_msg"
          grc=$?
          if [ "$grc" -eq 0 ]; then
            hit_paths="${hit_paths}${path} (annotated tag ${sha} message)"$'\n'
          elif [ "$grc" -ne 1 ]; then
            scan_errors="${scan_errors}${path} (tag ${sha}: grep=${grc})"$'\n'
          fi
        fi
        ;;
      "")
        # rev-list listed it but cat-file -t cannot type it — anomalous; block.
        scan_errors="${scan_errors}${path} (object ${sha}: unreadable type)"$'\n'
        ;;
      *)
        : ;;   # commit / tree — no scannable content here (messages scanned below)
    esac
  done < "$pairs"
  rm -f "$pairs"

  if [ -n "$hit_paths" ]; then
    emit_block "personal marker in outgoing new object content (range: $range)"
    printf '%s' "$hit_paths" | sed '/^$/d;s/^/      /' >&2
    fail=1
  fi
  if [ -n "$scan_errors" ]; then
    emit_block "could not fully scan outgoing object(s) — failing closed (range: $range)"
    printf '%s' "$scan_errors" | sed '/^$/d;s/^/      /' >&2
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
    tmp="$(make_temp)" || exit 1
    # `"${cfg_arg[@]+"${cfg_arg[@]}"}"` — expand safely even when the array is
    # empty: bash 3.2 (the macOS system bash this hook runs under) treats a bare
    # `"${cfg_arg[@]}"` on an EMPTY array as an unbound-variable error under
    # `set -u`, which would abort the scan. The real repo always ships
    # .gitleaks.toml so the array is populated, but the fence must not crash in a
    # repo that lacks it (gitleaks then runs with its default ruleset).
    if ! gitleaks git "$REPO_ROOT" "${cfg_arg[@]+"${cfg_arg[@]}"}" \
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
