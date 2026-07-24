#!/usr/bin/env bash
#
# dmgbuild wrapper — hide the DMG's support files off-window (DMG polish S2).
#
# WHY THIS EXISTS
# electron-builder 26 authors the DMG by handing a bundled Python `dmgbuild`
# an appdmg-schema JSON (`dmg-builder/out/dmgUtil.js`). The volume's support
# files (`.background.tiff`, `.VolumeIcon.icns`, `.DS_Store`, `.Trashes`,
# `.fseventsd`) get NO icon position, so Finder auto-arranges them into the
# visible window — and on a Mac with Cmd+Shift+. (show-hidden) enabled they are
# plainly visible. Off-window `.DS_Store` positions are the ONLY technique that
# survives Cmd+Shift+. (`chflags`/`SetFile`/dot-prefix are all revealed by it;
# see private/reports/2026-07-24-dmg-hidden-files-investigation.md). appdmg's
# `type:"position"` entry sets an icon location for an existing in-volume item
# WITHOUT copying it — exactly what we need — but electron-builder's own config
# schema closes the `type` enum (no `position`), so it cannot be expressed in
# electron-builder.yml.
#
# HOW IT WORKS
# `dmgUtil.js` (getDmgVendorPath, line ~27) execs the file named by
# CUSTOM_DMGBUILD_PATH instead of its vendored binary, as:
#     <tool> -s <settings.json> <volume-name> <artifact.dmg>
# This wrapper takes that invocation, injects far-off (5000,5000) `position`
# entries for the five support files into a COPY of the settings JSON, then
# execs the REAL vendored dmgbuild with the augmented settings. The vendored
# tool (dmgbuild 1.6.7, core.py load_json) maps every content entry — including
# `position` ones — to an `Iloc` record in `.DS_Store`, moving those icons far
# outside the 640×360 content rect. Positions for items that never materialize
# on the final volume (e.g. `.Trashes`, which dmgbuild deletes) are harmless.
#
# This runs at DMG-authoring time, before the DMG is signed/notarized in
# release.sh — so nothing needs re-signing.
#
# ROBUSTNESS / FAIL-LOUD
# When CUSTOM_DMGBUILD_PATH is set, electron-builder never downloads/manages the
# vendored bundle, so this wrapper must locate the already-extracted vendored
# binary itself (electron-builder's toolset cache). If it cannot — or if the
# settings file / jq is missing — it exits non-zero with a clear message rather
# than silently skipping the hiding and shipping a leaky DMG.
#
set -euo pipefail

err() { printf 'dmgbuild-wrapper: error: %s\n' "$*" >&2; }
die() { err "$*"; exit 1; }

# --- support files to shove off-window --------------------------------------
# In-volume names dmgbuild gives them (core.py: .background<ext>, .VolumeIcon.icns,
# .DS_Store; plus the two OS scratch dirs). `path` for a position entry is just
# the in-volume item name (no copy happens); `name` defaults to its basename.
FAR_X=5000
FAR_Y=5000
SUPPORT_FILES=(
  '.background.tiff'
  '.VolumeIcon.icns'
  '.DS_Store'
  '.Trashes'
  '.fseventsd'
)

# --- parse the electron-builder invocation ----------------------------------
# We only need the settings-file path (from -s/--settings); everything else is
# forwarded verbatim. electron-builder always passes `-s <file> <vol> <artifact>`,
# but accept the =form too for resilience.
args=("$@")
settings=""
settings_idx=-1
for ((i = 0; i < ${#args[@]}; i++)); do
  case "${args[i]}" in
    -s | --settings)
      settings_idx=$((i + 1))
      [ "$settings_idx" -lt "${#args[@]}" ] || die "-s/--settings given without a value"
      settings="${args[settings_idx]}"
      ;;
    --settings=*)
      settings_idx=$i
      settings="${args[i]#--settings=}"
      ;;
  esac
done

[ -n "$settings" ] || die "no -s/--settings argument found in: $*"
[ -f "$settings" ] || die "settings file does not exist: $settings"
command -v jq >/dev/null 2>&1 || die "jq not found on PATH (required to augment the DMG settings)"

# --- augment the settings JSON with off-window position entries --------------
# dmgbuild parses a settings file as appdmg JSON ONLY when it ends in `.json`
# (core.py load-dispatch). BSD mktemp substitutes trailing Xs only, so make a
# temp DIR and hold a `settings.json` inside it (random dir, stable basename).
augmented_dir="$(mktemp -d "${TMPDIR:-/tmp}/sonata-dmg.XXXXXX")"
augmented="$augmented_dir/settings.json"
cleanup() { rm -rf "$augmented_dir"; }
trap cleanup EXIT

# Build the position entries as a JSON array, then append to `.contents`.
positions_json="$(
  printf '%s\n' "${SUPPORT_FILES[@]}" |
    jq -R -s --argjson x "$FAR_X" --argjson y "$FAR_Y" '
      split("\n")
      | map(select(length > 0))
      | map({x: $x, y: $y, type: "position", path: .})
    '
)" || die "failed to build position entries"

jq --argjson pos "$positions_json" '.contents = ((.contents // []) + $pos)' \
  "$settings" > "$augmented" || die "failed to augment settings JSON ($settings)"

# --- locate the real vendored dmgbuild --------------------------------------
# Prefer an explicit override, else glob electron-builder's toolset cache. The
# extraction dir carries a random suffix (dmgbuild-bundle-<arch>-<hash>-XXXXX),
# so we match by pattern and pick the newest complete extraction. The glob is
# loose on version/hash on purpose — it survives electron-builder bumps.
resolve_vendor() {
  if [ -n "${SONATA_DMGBUILD_VENDOR:-}" ]; then
    [ -x "${SONATA_DMGBUILD_VENDOR}" ] \
      || die "SONATA_DMGBUILD_VENDOR is set but not an executable file: ${SONATA_DMGBUILD_VENDOR}"
    printf '%s\n' "${SONATA_DMGBUILD_VENDOR}"
    return 0
  fi

  local arch_tag
  case "$(uname -m)" in
    arm64) arch_tag=arm64 ;;
    x86_64) arch_tag=x86_64 ;;
    *) die "unsupported architecture: $(uname -m)" ;;
  esac

  local cache_root="${ELECTRON_BUILDER_CACHE:-$HOME/Library/Caches/electron-builder}"
  [ -d "$cache_root" ] || die "electron-builder cache not found: $cache_root (build a DMG once WITHOUT CUSTOM_DMGBUILD_PATH to populate it)"

  # Newest matching launcher wins. Use find so a no-match is empty, not a literal glob.
  local newest=""
  local candidate
  while IFS= read -r candidate; do
    [ -n "$candidate" ] || continue
    [ -x "$candidate" ] || continue
    if [ -z "$newest" ] || [ "$candidate" -nt "$newest" ]; then
      newest="$candidate"
    fi
  done < <(
    find "$cache_root" \
      -type f \
      -name dmgbuild \
      -path "*dmg-builder@*/dmgbuild-bundle-${arch_tag}-*/dmgbuild" \
      2>/dev/null
  )

  [ -n "$newest" ] \
    || die "no vendored dmgbuild found under $cache_root for arch ${arch_tag}. Build a DMG once WITHOUT CUSTOM_DMGBUILD_PATH (or set SONATA_DMGBUILD_VENDOR) to populate the toolset cache."
  printf '%s\n' "$newest"
}

vendor="$(resolve_vendor)"
printf 'dmgbuild-wrapper: hiding %d support files off-window at (%s,%s); vendored dmgbuild: %s\n' \
  "${#SUPPORT_FILES[@]}" "$FAR_X" "$FAR_Y" "$vendor" >&2

# --- exec the real dmgbuild with the augmented settings ---------------------
# Swap only the settings-path argument; forward the rest verbatim.
args[settings_idx]="$augmented"

# The vendored `dmgbuild` is a plain launcher (not electron-builder), so
# re-exec cannot recurse even with CUSTOM_DMGBUILD_PATH still in the env.
# Run (not exec) so the EXIT trap fires and cleans up the temp settings file.
"$vendor" "${args[@]}"
