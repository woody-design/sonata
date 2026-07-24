#!/usr/bin/env bash
#
# Build Gatekeeper-clean Sonata distribution artifacts.
#
# One command turns the committed electron-builder config into a set of
# artifacts a user can download and run without Gatekeeper friction:
#   1. builds the signed, hardened-runtime arm64 app and packages it into a DMG
#      and a ZIP (+ latest-mac.yml, the electron-updater manifest);
#   2. signs the DMG itself with a secure timestamp (electron-builder leaves the
#      DMG wrapper unsigned; notarization needs it signed);
#   3. submits the DMG to Apple's notary service and gates on the PARSED JSON
#      status == "Accepted" (never on the exit code — `notarytool submit` can
#      exit 0 on a rejected submission); on rejection it pulls the notary log;
#   4. staples the notarization ticket to the DMG and to the app;
#   5. runs a fatal-before-success verification block (codesign deep/strict,
#      stapler validate, spctl Gatekeeper simulation) and mounts the DMG to
#      re-verify the app inside;
#   6. reconciles latest-mac.yml with the post-staple DMG and writes a
#      SHA-256 checksums file.
#
# The build is NOT forked from `npm run package`: this reuses the same
# electron-builder.yml and only overrides the mac target on the CLI
# (`--mac dmg zip --arm64`) and adds notarization on top, so the packaged app is
# behaviourally identical to the daily-driver build.
#
# What ships in each artifact (single notarization submission — the DMG):
#   - DMG (the human download): the DMG wrapper is notarized AND stapled, so it
#     mounts Gatekeeper-clean fully offline. This is the primary channel.
#   - The app itself (the copy inside the DMG, and the identical copy inside the
#     ZIP) is signed and its code-signature hash was registered as notarized by
#     the DMG submission — spctl reports "Notarized Developer ID" and Gatekeeper
#     accepts it. The app is NOT individually stapled: electron-builder packs it
#     before notarization, and stapling it would require a second submission plus
#     rebuilding both containers. For a GitHub-download audience (online at
#     install) the online notarization check is sufficient. (Stapling the app
#     for guaranteed offline first-launch is a documented future option — it
#     needs an afterSign hook that notarizes the app before packaging.)
#   - ZIP (the electron-updater channel): same signed+notarized app; the updater
#     runs inside an already-online app, so an unstapled app is a non-issue here.
#   - latest-mac.yml: its top-level path/sha512 point at the ZIP (untouched by
#     this script, so the manifest is authoritative for auto-update).
#
# Requirements: full Xcode (actool for the Tahoe icon afterPack hook), a
# Developer ID Application cert in the login keychain, and a notarytool keychain
# profile holding an Apple-ID app-specific password.
#
# Environment overrides:
#   SONATA_NOTARY_PROFILE   notarytool keychain profile   (default: sonata-profile)
#   SONATA_SIGN_IDENTITY    Developer ID for DMG signing  (default: Developer ID Application: Yuhui Li (NW3373QK97))
# Flags:
#   --skip-notarize / SONATA_RELEASE_SKIP_NOTARIZE=1
#         build + sign + verify signatures only; skip notarize/staple. The
#         artifacts are NOT distribution-ready (Gatekeeper will still block a
#         download). For fast local iteration on the build itself.
#   --skip-build / SONATA_RELEASE_SKIP_BUILD=1
#         reuse the artifacts already in release/ instead of rebuilding. For
#         iterating on the notarize/verify steps without paying the build cost.
#
# Exit codes:
#   0  success
#   1  usage / configuration / missing tool or credential
#   2  build or packaging failed
#   3  DMG signing failed
#   4  notarization was not Accepted (notary log printed) or submission failed
#   5  stapling or a verification check failed
#   6  latest-mac.yml did not match the shipped ZIP
#
set -euo pipefail

# --- logging -----------------------------------------------------------------
log()  { printf '%s\n' "$*"; }
warn() { printf 'warning: %s\n' "$*" >&2; }
step() { printf '\n▶ %s\n' "$*"; }
die()  { local code="$1"; shift; printf 'error: %s\n' "$*" >&2; exit "$code"; }

# --- arguments ---------------------------------------------------------------
NOTARIZE=1
[ "${SONATA_RELEASE_SKIP_NOTARIZE:-0}" = "1" ] && NOTARIZE=0
DO_BUILD=1
[ "${SONATA_RELEASE_SKIP_BUILD:-0}" = "1" ] && DO_BUILD=0

for arg in "$@"; do
  case "$arg" in
    --skip-notarize) NOTARIZE=0 ;;
    --skip-build)    DO_BUILD=0 ;;
    -h|--help)
      awk 'NR>1 && /^set / {exit} NR>1 {sub(/^# ?/, ""); print}' "$0"
      exit 0
      ;;
    *) die 1 "Unknown argument: $arg (see --help)" ;;
  esac
done

PROFILE="${SONATA_NOTARY_PROFILE:-sonata-profile}"
SIGN_IDENTITY="${SONATA_SIGN_IDENTITY:-Developer ID Application: Yuhui Li (NW3373QK97)}"

# --- paths -------------------------------------------------------------------
APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RELEASE_DIR="$APP_DIR/release"
CONFIG="$APP_DIR/electron-builder.yml"
# dmgbuild wrapper — shoves the DMG's support files off-window so they stay
# invisible even under Finder's Cmd+Shift+. show-hidden (DMG polish S2). Wired
# in via CUSTOM_DMGBUILD_PATH at the electron-builder invocation below; see the
# wrapper header and private/reports/2026-07-24-dmg-s2-slice-record.md.
DMGBUILD_WRAPPER="$APP_DIR/scripts/dmgbuild-wrapper.sh"

[ -f "$CONFIG" ] || die 1 "electron-builder config not found: $CONFIG"
[ -f "$APP_DIR/package.json" ] || die 1 "package.json not found in $APP_DIR"
[ -x "$DMGBUILD_WRAPPER" ] || die 1 "dmgbuild wrapper not found or not executable: $DMGBUILD_WRAPPER"

# --- preflight: tools --------------------------------------------------------
for tool in node npm codesign xcrun stapler hdiutil jq openssl shasum awk; do
  command -v "$tool" >/dev/null 2>&1 || die 1 "Required tool not found on PATH: $tool"
done
# The afterPack hook only invokes actool when SONATA_SKIP_TAHOE_ICON is unset
# (see build-resources/after-pack.js). Honor the same escape hatch here, or the
# preflight would kill an intentionally icns-only build before it starts.
if [ "${SONATA_SKIP_TAHOE_ICON:-0}" != "1" ]; then
  xcrun --find actool >/dev/null 2>&1 \
    || die 1 "actool not found — the Tahoe icon afterPack hook needs full Xcode (not just Command Line Tools). Set SONATA_SKIP_TAHOE_ICON=1 to build icns-only, or install Xcode."
fi

VERSION="$(node -p "require('$APP_DIR/package.json').version")"
[ -n "$VERSION" ] || die 1 "Could not read version from package.json."

DMG="$RELEASE_DIR/Sonata-$VERSION-arm64.dmg"
ZIP="$RELEASE_DIR/Sonata-$VERSION-arm64-mac.zip"
YML="$RELEASE_DIR/latest-mac.yml"
APP="$RELEASE_DIR/mac-arm64/Sonata.app"

# --- preflight: signing identity ---------------------------------------------
# Capture the identity list first, then match against the STRING with a here-string
# — never `security … | grep -qF`: under `set -o pipefail`, grep -q closes the pipe
# on the first match and `security` dies SIGPIPE(141), which becomes the pipeline
# status and would flip a PRESENT identity into a false "not found". A here-string
# has no upstream process to signal, so the match verdict is grep's alone.
identities="$(security find-identity -v -p codesigning 2>/dev/null || true)"
if ! grep -qF "$SIGN_IDENTITY" <<<"$identities"; then
  die 1 "Signing identity not found in the keychain: '$SIGN_IDENTITY'. Set SONATA_SIGN_IDENTITY, or import the Developer ID Application cert."
fi

# --- preflight: notary credentials (read-only probe) -------------------------
if [ "$NOTARIZE" = "1" ]; then
  if ! xcrun notarytool history --keychain-profile "$PROFILE" >/dev/null 2>&1; then
    die 1 "notarytool profile '$PROFILE' is not usable. Create it with 'xcrun notarytool store-credentials \"$PROFILE\"', set SONATA_NOTARY_PROFILE, or pass --skip-notarize."
  fi
fi

# --- plan --------------------------------------------------------------------
step "Sonata release $VERSION"
log "  App dir       : $APP_DIR"
log "  Sign identity : $SIGN_IDENTITY"
log "  Build         : $([ "$DO_BUILD" = 1 ] && echo "npm run build + electron-builder (dmg, zip, arm64)" || echo "SKIPPED — reuse release/ artifacts")"
log "  Notarize      : $([ "$NOTARIZE" = 1 ] && echo "yes — profile '$PROFILE'" || echo "SKIPPED (--skip-notarize) — artifacts NOT distribution-ready")"

# --- 1. build ----------------------------------------------------------------
if [ "$DO_BUILD" = "1" ]; then
  step "Cleaning stale distribution artifacts ..."
  rm -f "$RELEASE_DIR"/*.dmg "$RELEASE_DIR"/*.zip "$RELEASE_DIR"/*.blockmap \
        "$RELEASE_DIR"/latest-mac.yml "$RELEASE_DIR"/SHASUMS256.txt 2>/dev/null || true

  step "Compiling (npm run build) ..."
  ( cd "$APP_DIR" && npm run build ) || die 2 "npm run build failed."

  step "Packaging signed app + DMG + ZIP (this takes a few minutes) ..."
  # CUSTOM_DMGBUILD_PATH routes DMG authoring through our wrapper (off-window
  # support-file positions). Scoped to this subshell — the ZIP target does not
  # invoke dmgbuild, and no other step should see the override. The wrapper
  # fails loud if it cannot find the vendored dmgbuild, so a broken hide can
  # never silently ship.
  ( cd "$APP_DIR" && CUSTOM_DMGBUILD_PATH="$DMGBUILD_WRAPPER" \
      npx electron-builder --config "$CONFIG" --mac dmg zip --arm64 --publish never ) \
    || die 2 "electron-builder packaging failed."
fi

[ -d "$APP" ] || die 2 "App bundle not found: $APP (run without --skip-build)."
[ -f "$DMG" ] || die 2 "DMG not found: $DMG (run without --skip-build)."
[ -f "$ZIP" ] || die 2 "ZIP not found: $ZIP (run without --skip-build)."
[ -f "$YML" ] || die 2 "latest-mac.yml not found: $YML (run without --skip-build)."

# --- 2. sign the DMG (secure timestamp) --------------------------------------
# electron-builder leaves the DMG wrapper unsigned; notarization requires it to
# be signed with a secure timestamp. Gate the (re-)sign on whether the DMG is
# already NOTARIZED + STAPLED, not on whether it is signed: `codesign --verify`
# is unreliable on disk images (it can report success on an unsigned DMG), and
# the actual hazard is narrow — `codesign --force` would strip an existing
# staple, and a follow-up --skip-notarize run would not catch the break. So:
#   - fresh electron-builder DMG (unsigned, unstapled) -> stapler fails -> sign;
#   - signed-but-unstapled DMG (e.g. a prior --skip-notarize run)  -> sign;
#   - already signed+stapled DMG (a prior full run) -> skip, ticket preserved.
if xcrun stapler validate "$DMG" >/dev/null 2>&1; then
  step "DMG is already notarized + stapled — leaving it intact (re-signing would strip the ticket)."
else
  step "Signing the DMG with a secure timestamp ..."
  codesign --force --timestamp --sign "$SIGN_IDENTITY" "$DMG" \
    || die 3 "Failed to sign the DMG."
  codesign --verify --verbose "$DMG" \
    || die 3 "DMG signature did not verify after signing."
fi

if [ "$NOTARIZE" != "1" ]; then
  step "Verifying signatures (notarization skipped) ..."
  codesign --verify --deep --strict --verbose=2 "$APP" || die 5 "App signature verification failed."
  codesign --verify --verbose "$DMG" || die 5 "DMG signature verification failed."
  step "Done (--skip-notarize)."
  warn "Artifacts are signed but NOT notarized/stapled — a downloaded copy will still be Gatekeeper-blocked. Re-run without --skip-notarize to ship."
  log "  DMG: $DMG"
  log "  ZIP: $ZIP"
  exit 0
fi

# --- 3. notarize the DMG -----------------------------------------------------
# Gate on the PARSED status, never on the exit code: `notarytool submit` can
# exit 0 on a rejected submission. On failure, auto-pull the notary log.
step "Submitting the DMG to Apple's notary service (this can take several minutes) ..."
# Keep notarytool's JSON (stdout) separate from any progress/warning it writes
# to stderr, so a stray stderr line can never corrupt the status parse and turn
# a real Accepted into a false failure.
submit_err="$(mktemp "${TMPDIR:-/tmp}/sonata-notary.XXXXXX")"
set +e
submit_out="$(xcrun notarytool submit "$DMG" --keychain-profile "$PROFILE" --wait --timeout 30m --output-format json 2>"$submit_err")"
submit_rc=$?
set -e

status="$(printf '%s' "$submit_out" | jq -r '.status // empty' 2>/dev/null || true)"
subid="$(printf '%s' "$submit_out" | jq -r '.id // empty' 2>/dev/null || true)"

if [ -z "$status" ]; then
  warn "notarytool returned no parseable status (exit $submit_rc). Output:"
  printf '%s\n' "$submit_out" | sed 's/^/    /' >&2
  sed 's/^/    /' "$submit_err" >&2 2>/dev/null || true
  rm -f "$submit_err"
  die 4 "Notarization submission failed (infrastructure or credentials)."
fi
rm -f "$submit_err"

log "  Submission ID : $subid"
log "  Status        : $status"

if [ "$status" != "Accepted" ]; then
  warn "Notarization was '$status' — pulling the notary log:"
  xcrun notarytool log "$subid" --keychain-profile "$PROFILE" 2>&1 | sed 's/^/    /' >&2 || true
  die 4 "Notarization not Accepted (status: $status, submission: $subid)."
fi

# --- 4. staple ---------------------------------------------------------------
# Staple the DMG (offline Gatekeeper for the download) and the app (its cdhash
# was notarized as part of the DMG submission). The ZIP's copy of the app is a
# separate, already-built file and is intentionally left unstapled (see header).
step "Stapling the notarization ticket ..."
xcrun stapler staple "$DMG" || die 5 "Failed to staple the DMG."
xcrun stapler staple "$APP" || die 5 "Failed to staple the app."

# --- 5. verification block (every check fatal before success) ----------------
step "Verifying artifacts ..."
codesign --verify --deep --strict --verbose=2 "$APP" || die 5 "codesign deep/strict failed on the app."
codesign --verify --verbose "$DMG"                   || die 5 "codesign verify failed on the DMG."
xcrun stapler validate "$APP"                        || die 5 "stapler validate failed on the app."
xcrun stapler validate "$DMG"                        || die 5 "stapler validate failed on the DMG."
spctl --assess -t open --context context:primary-signature -v "$DMG" \
  || die 5 "spctl Gatekeeper assessment failed on the DMG."
spctl --assess -t exec -vv "$APP" \
  || die 5 "spctl Gatekeeper assessment failed on the app."

# Mount the DMG and re-verify the app inside it, then detach.
step "Mounting the DMG to verify the app inside ..."
MNT="$(mktemp -d "${TMPDIR:-/tmp}/sonata-dmg.XXXXXX")"
detach_dmg() { hdiutil detach "$MNT" >/dev/null 2>&1 || true; rmdir "$MNT" 2>/dev/null || true; }
trap detach_dmg EXIT
hdiutil attach "$DMG" -nobrowse -readonly -mountpoint "$MNT" >/dev/null \
  || die 5 "Failed to mount the DMG."
INNER_APP="$MNT/Sonata.app"
[ -d "$INNER_APP" ] || die 5 "Sonata.app not found inside the mounted DMG."
# The app inside the DMG is the same signed build as the loose one but was
# packed before stapling, so it carries no stapled ticket of its own (only the
# DMG wrapper does). It does NOT need one: its code-signature hash was notarized
# by the DMG submission, so Gatekeeper accepts it. Assert exactly that — a valid
# signature plus an spctl verdict of "Notarized Developer ID" — rather than
# stapler validate (which would fail by design here).
codesign --verify --deep --strict --verbose=2 "$INNER_APP" || die 5 "codesign deep/strict failed on the app inside the DMG."
spctl --assess -t exec -vv "$INNER_APP"                    || die 5 "spctl assessment failed on the app inside the DMG."
detach_dmg
trap - EXIT

# --- 6. reconcile latest-mac.yml + checksums ---------------------------------
# Signing and stapling mutated the DMG after electron-builder wrote the manifest,
# so the manifest's DMG hash/size are stale. Patch just the DMG entry (the ZIP
# entry — the auto-update artifact — is untouched and stays authoritative). Drop
# the now-stale DMG blockmap rather than ship a lying one; mac auto-update uses
# the ZIP channel, and the ZIP blockmap is preserved.
step "Reconciling latest-mac.yml with the stapled DMG ..."
dmg_base="$(basename "$DMG")"
zip_base="$(basename "$ZIP")"
dmg_sha="$(openssl dgst -sha512 -binary "$DMG" | openssl base64 -A)"
dmg_size="$(stat -f%z "$DMG")"

awk -v u="$dmg_base" -v s="$dmg_sha" -v z="$dmg_size" '
  $1=="-" && $2=="url:" && $3==u { inblk=1; print; next }
  inblk && $1=="sha512:" { print "    sha512: " s; next }
  inblk && $1=="size:"   { print "    size: " z; inblk=0; next }
  { print }
' "$YML" > "$YML.tmp" && mv "$YML.tmp" "$YML"

# Assert the patch actually took effect — guards against a future
# electron-builder yml format change (quoted url, reindentation) silently
# no-op'ing the awk above and leaving a stale DMG entry. Symmetric with the ZIP
# cross-check below.
yml_dmg_sha="$(awk -v u="$dmg_base" '
  $1=="-" && $2=="url:" && $3==u { inblk=1; next }
  inblk && $1=="sha512:" { print $2; exit }
  inblk && $1=="-" { inblk=0 }
' "$YML")"
yml_dmg_size="$(awk -v u="$dmg_base" '
  $1=="-" && $2=="url:" && $3==u { inblk=1; next }
  inblk && $1=="size:" { print $2; exit }
  inblk && $1=="-" { inblk=0 }
' "$YML")"
[ "$yml_dmg_sha" = "$dmg_sha" ] \
  || die 6 "latest-mac.yml DMG sha512 was not reconciled (awk patch no-op — the yml format may have changed)."
[ "$yml_dmg_size" = "$dmg_size" ] \
  || die 6 "latest-mac.yml DMG size was not reconciled (awk patch no-op — the yml format may have changed)."

rm -f "$DMG.blockmap"

# --- cross-check: manifest vs the shipped ZIP (pristine) ---------------------
step "Cross-checking latest-mac.yml against the ZIP ..."
zip_sha="$(openssl dgst -sha512 -binary "$ZIP" | openssl base64 -A)"
zip_size="$(stat -f%z "$ZIP")"

yml_path="$(awk -F': ' '/^path:/{print $2; exit}' "$YML")"
yml_top_sha="$(awk -F': ' '/^sha512:/{print $2; exit}' "$YML")"
yml_zip_size="$(awk -v u="$zip_base" '
  $1=="-" && $2=="url:" && $3==u { inblk=1; next }
  inblk && $1=="size:" { print $2; exit }
  inblk && $1=="-" { inblk=0 }
' "$YML")"

[ "$yml_path" = "$zip_base" ] \
  || die 6 "latest-mac.yml path ('$yml_path') != ZIP ('$zip_base')."
[ "$yml_top_sha" = "$zip_sha" ] \
  || die 6 "latest-mac.yml top-level sha512 does not match the ZIP's sha512."
[ "$yml_zip_size" = "$zip_size" ] \
  || die 6 "latest-mac.yml ZIP size ('$yml_zip_size') != actual ZIP size ('$zip_size')."
log "  path   : $yml_path  (matches ZIP)"
log "  sha512 : matches ZIP"
log "  size   : $zip_size  (matches ZIP)"

# --- checksums over the final artifacts --------------------------------------
step "Writing SHA-256 checksums ..."
( cd "$RELEASE_DIR" && shasum -a 256 "$dmg_base" "$zip_base" > SHASUMS256.txt )
cat "$RELEASE_DIR/SHASUMS256.txt"

# --- summary -----------------------------------------------------------------
step "Release $VERSION is ready."
log "  DMG (notarized + stapled) : $DMG"
log "  ZIP (auto-update channel) : $ZIP"
log "  Manifest                  : $YML"
log "  Checksums                 : $RELEASE_DIR/SHASUMS256.txt"
log ""
log "Not published — uploading to GitHub Releases is WS4's job."
