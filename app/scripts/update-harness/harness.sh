#!/usr/bin/env bash
#
# End-to-end auto-update harness (auto-update S4).
#
# Exercises the REAL electron-updater → Squirrel.Mac swap locally, with no
# GitHub and no notarization, by building two signed versions of the CURRENT
# tree, serving the newer one from a local HTTP feed, and pointing a
# temp-installed copy of the older one at that feed via SONATA_UPDATE_FEED_URL.
#
# What it proves that a compile check cannot:
#   - the signed ZIP unpacks to a signature Squirrel.Mac accepts and swaps in;
#   - both install paths — the pill's Restart-to-Update (quitAndInstall) AND
#     autoInstallOnAppQuit (normal quit) — actually relaunch the new version;
#   - the S3 "Check for Updates…" menu reaches a live feed;
#   - the S1 feed-override gate lets a packaged app run+update from a writable
#     temp dir (NOT /Applications, where the daily driver lives).
#
# Why no notarization: a locally built app carries no quarantine xattr, so
# Gatekeeper never gates it (same reason `npm run package` skips notarization).
# Squirrel only requires a valid SIGNATURE, which every build here has.
#
# Two independent versions are built from ONE `npm run build` by overriding only
# electron-builder's version (`--config.extraMetadata.version`); package.json on
# disk is never touched. The publish provider is left as-is: electron-builder's
# generated latest-mac.yml lists RELATIVE file URLs, which the generic provider
# resolves against the runtime feed base — so the manifest is already
# feed-correct without a publish override (see README).
#
# Isolation: the harness app runs against a scratch profile — SONATA_DATA_DIR
# (Sonata's ~/.sonata home) and Electron's native --user-data-dir (updater cache,
# window state, local-api socket) both point into the work dir — so it never
# touches the daily driver's real data. (There is no single-instance lock, so a
# second Sonata launches freely.)
#
# Usage:  harness.sh <command> [flags]
# Commands:
#   build            npm build + build v1 & v2 (signed, arm64 zip) + stage feed
#   install | reset  fresh scratch profile + unpack v1 into the temp app dir
#   launch           start the feed server (if needed) + launch the temp app
#                    pointed at the feed (background)
#   serve            start the feed server only (prints the URL)
#   stop             normal quit of the temp app (Apple Event ⇒ install-on-quit)
#   kill             force-kill the temp app (SIGKILL, no install-on-quit)
#   version          print the on-disk temp bundle's CFBundleShortVersionString
#   walkthrough      print the numbered manual walkthrough for both paths
#   up               install + launch + walkthrough (the guided default flow)
#   logs             tail the app log and the feed-server log
#   clean [--all]    kill server + app; with --all also remove the work dir
#
# Env:
#   SONATA_HARNESS_WORK   work dir (default: $TMPDIR/sonata-update-harness)
#   SONATA_HARNESS_PORT   pin the feed port (default: ephemeral, collision-proof)
#   SONATA_SKIP_TAHOE_ICON=1   build icns-only (skip the actool afterPack hook)
#
set -euo pipefail

# --- logging (mirrors release.sh) --------------------------------------------
log()  { printf '%s\n' "$*"; }
warn() { printf 'warning: %s\n' "$*" >&2; }
step() { printf '\n▶ %s\n' "$*"; }
die()  { local code="$1"; shift; printf 'error: %s\n' "$*" >&2; exit "$code"; }

# --- paths -------------------------------------------------------------------
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_DIR="$(cd "$HERE/../.." && pwd)"
CONFIG="$APP_DIR/electron-builder.yml"
RELEASE_DIR="$APP_DIR/release"

WORK="${SONATA_HARNESS_WORK:-${TMPDIR:-/tmp}/sonata-update-harness}"
WORK="${WORK%/}"
FEED_DIR="$WORK/feed"
V1_DIR="$WORK/v1"
APP_ROOT="$WORK/app"
APP_BUNDLE="$APP_ROOT/Sonata.app"
APP_BIN="$APP_BUNDLE/Contents/MacOS/Sonata"
PROFILE="$WORK/profile"

FEED_LOG="$WORK/feed-server.log"
FEED_PID_FILE="$WORK/feed-server.pid"
FEED_URL_FILE="$WORK/feed.url"
PORT_FILE="$WORK/feed.port"
RUN_LOG="$WORK/app.log"
APP_PID_FILE="$WORK/app.pid"
META_FILE="$WORK/versions.env"

[ -f "$CONFIG" ] || die 1 "electron-builder config not found: $CONFIG"
[ -f "$APP_DIR/package.json" ] || die 1 "package.json not found in $APP_DIR"

# --- version identifiers -----------------------------------------------------
# Two prerelease versions off the current base. semver.gt('X-harness.2',
# 'X-harness.1') is true and electron-updater auto-allows prerelease→prerelease
# when the current version is itself a prerelease, so the .2 update is offered.
BASE_VERSION="$(node -p "require('$APP_DIR/package.json').version")"
[ -n "$BASE_VERSION" ] || die 1 "Could not read version from package.json."
V1="${BASE_VERSION}-harness.1"
V2="${BASE_VERSION}-harness.2"
V1_ZIP_NAME="Sonata-${V1}-arm64-mac.zip"
V2_ZIP_NAME="Sonata-${V2}-arm64-mac.zip"

# --- helpers -----------------------------------------------------------------
bundle_version() {
  local plist="$1/Contents/Info.plist"
  [ -f "$plist" ] || { echo "(no bundle)"; return; }
  /usr/libexec/PlistBuddy -c "Print :CFBundleShortVersionString" "$plist" 2>/dev/null || echo "(unreadable)"
}

pid_alive() { [ -n "${1:-}" ] && kill -0 "$1" 2>/dev/null; }

read_pid() { [ -f "$1" ] && cat "$1" 2>/dev/null || true; }

# electron-updater's download cache and Squirrel's ShipIt working dir live under
# ~/Library/Caches, keyed by updaterCacheDirName / bundle id — NOT under the
# scratch --user-data-dir. Left alone, a staged download leaks between the two
# install paths (and into a location shared with the daily driver's bundle id).
# Clear both so every install/reset re-downloads fresh. (The daily driver is an
# internal build with the updater inert, so it never populates these.)
UPDATER_CACHE_FALLBACK="sonata-app-updater"
BUNDLE_ID_FALLBACK="app.sonatacode.sonata"
clear_updater_cache() {
  local cache_name="" bundle_id=""
  if [ -f "$APP_BUNDLE/Contents/Resources/app-update.yml" ]; then
    cache_name="$(awk -F': ' '/^updaterCacheDirName:/{print $2; exit}' "$APP_BUNDLE/Contents/Resources/app-update.yml")"
    bundle_id="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' "$APP_BUNDLE/Contents/Info.plist" 2>/dev/null || true)"
  fi
  cache_name="${cache_name:-$UPDATER_CACHE_FALLBACK}"
  bundle_id="${bundle_id:-$BUNDLE_ID_FALLBACK}"
  rm -rf "$HOME/Library/Caches/$cache_name" "$HOME/Library/Caches/$bundle_id.ShipIt"
}

require_built() {
  [ -f "$FEED_DIR/latest-mac.yml" ] || die 2 "Feed not staged — run 'harness.sh build' first."
  [ -f "$V1_DIR/$V1_ZIP_NAME" ]     || die 2 "v1 artifact missing — run 'harness.sh build' first."
}

# --- build -------------------------------------------------------------------
build_one() {
  local version="$1"
  step "Building signed arm64 ZIP for version $version (a few minutes) ..."
  ( cd "$APP_DIR" && npx electron-builder --config "$CONFIG" \
      --config.extraMetadata.version="$version" \
      --mac zip --arm64 --publish never ) \
    || die 2 "electron-builder failed for $version."
}

cmd_build() {
  mkdir -p "$WORK" "$FEED_DIR" "$V1_DIR"
  step "Compiling (npm run build) ..."
  ( cd "$APP_DIR" && npm run build ) || die 2 "npm run build failed."

  # --- v1: the app the user is running. Keep its ZIP to install/reset from.
  build_one "$V1"
  [ -f "$RELEASE_DIR/$V1_ZIP_NAME" ] || die 2 "v1 ZIP not produced: $V1_ZIP_NAME"
  rm -f "$V1_DIR"/*.zip 2>/dev/null || true
  cp "$RELEASE_DIR/$V1_ZIP_NAME" "$V1_DIR/"

  # --- v2: the update the feed advertises. Stage ZIP + blockmap + manifest.
  build_one "$V2"
  [ -f "$RELEASE_DIR/$V2_ZIP_NAME" ] || die 2 "v2 ZIP not produced: $V2_ZIP_NAME"
  [ -f "$RELEASE_DIR/latest-mac.yml" ] || die 2 "latest-mac.yml not produced for v2."
  rm -f "$FEED_DIR"/*.zip "$FEED_DIR"/*.blockmap "$FEED_DIR"/latest-mac.yml 2>/dev/null || true
  cp "$RELEASE_DIR/$V2_ZIP_NAME" "$FEED_DIR/"
  [ -f "$RELEASE_DIR/$V2_ZIP_NAME.blockmap" ] && cp "$RELEASE_DIR/$V2_ZIP_NAME.blockmap" "$FEED_DIR/"
  cp "$RELEASE_DIR/latest-mac.yml" "$FEED_DIR/"

  {
    echo "V1=$V1"
    echo "V2=$V2"
    echo "BUILT_AT=$(date -u +%FT%TZ)"
  } > "$META_FILE"

  step "Build complete."
  log "  v1 (installed) : $V1   → $V1_DIR/$V1_ZIP_NAME"
  log "  v2 (feed)      : $V2   → $FEED_DIR/$V2_ZIP_NAME"
  log "  feed manifest  : $FEED_DIR/latest-mac.yml"
  log ""
  log "Feed manifest (advertised version + relative ZIP path):"
  grep -E '^(version|path):' "$FEED_DIR/latest-mac.yml" | sed 's/^/    /'
}

# --- install / reset ---------------------------------------------------------
cmd_install() {
  require_built
  cmd_kill >/dev/null 2>&1 || true
  step "Installing v1 into a fresh scratch profile ..."
  rm -rf "$APP_ROOT" "$PROFILE"
  mkdir -p "$APP_ROOT" "$PROFILE/data" "$PROFILE/userData"
  ditto -x -k "$V1_DIR/$V1_ZIP_NAME" "$APP_ROOT" || die 2 "Failed to unpack v1 ZIP with ditto."
  [ -x "$APP_BIN" ] || die 2 "Installed bundle has no executable at $APP_BIN"
  clear_updater_cache
  log "  Installed: $APP_BUNDLE"
  log "  Version  : $(bundle_version "$APP_BUNDLE")"
  log "  Profile  : $PROFILE  (SONATA_DATA_DIR + --user-data-dir)"
}

# --- feed server -------------------------------------------------------------
ensure_server() {
  local pid; pid="$(read_pid "$FEED_PID_FILE")"
  if pid_alive "$pid"; then
    cat "$FEED_URL_FILE"
    return
  fi
  [ -f "$FEED_DIR/latest-mac.yml" ] || die 2 "Feed not staged — run 'harness.sh build' first."
  : > "$FEED_LOG"
  rm -f "$PORT_FILE"
  HARNESS_PORT_FILE="$PORT_FILE" nohup node "$HERE/serve-feed.mjs" "$FEED_DIR" "${SONATA_HARNESS_PORT:-0}" \
    >>"$FEED_LOG" 2>&1 &
  echo $! > "$FEED_PID_FILE"
  # Wait for the port file (server picks an ephemeral port then writes it).
  local tries=0 port=""
  while [ "$tries" -lt 50 ]; do
    [ -s "$PORT_FILE" ] && { port="$(cat "$PORT_FILE")"; break; }
    sleep 0.1; tries=$((tries + 1))
  done
  [ -n "$port" ] || die 2 "Feed server did not report a port (see $FEED_LOG)."
  local url="http://127.0.0.1:$port"
  printf '%s' "$url" > "$FEED_URL_FILE"
  cat "$FEED_URL_FILE"
}

cmd_serve() {
  local url; url="$(ensure_server)"
  step "Feed server up."
  log "  URL : $url"
  log "  Dir : $FEED_DIR"
  log "  Log : $FEED_LOG"
}

# --- launch ------------------------------------------------------------------
cmd_launch() {
  [ -x "$APP_BIN" ] || die 2 "No installed app — run 'harness.sh install' first."
  local pid; pid="$(read_pid "$APP_PID_FILE")"
  if pid_alive "$pid"; then
    die 2 "Temp app already running (pid $pid). Use 'stop' or 'kill' first."
  fi
  local url; url="$(ensure_server)"
  step "Launching v1 pointed at the local feed ..."
  : > "$RUN_LOG"
  SONATA_UPDATE_FEED_URL="$url" \
  SONATA_DATA_DIR="$PROFILE/data" \
    nohup "$APP_BIN" --user-data-dir="$PROFILE/userData" >>"$RUN_LOG" 2>&1 &
  echo $! > "$APP_PID_FILE"
  sleep 1
  local apid; apid="$(read_pid "$APP_PID_FILE")"
  pid_alive "$apid" || die 2 "App exited immediately — see $RUN_LOG"
  log "  Feed URL : $url"
  log "  Bundle   : $APP_BUNDLE  (version $(bundle_version "$APP_BUNDLE"))"
  log "  App pid  : $apid"
  log "  App log  : $RUN_LOG"
  log "  Feed log : $FEED_LOG"
}

# --- stop / kill -------------------------------------------------------------
cmd_stop() {
  local pid; pid="$(read_pid "$APP_PID_FILE")"
  if ! pid_alive "$pid"; then
    log "Temp app is not running."
    rm -f "$APP_PID_FILE"
    return
  fi
  # A NORMAL quit (Apple Event, i.e. Cmd+Q semantics) routes through AppKit's
  # -[NSApplication terminate:], which is what Squirrel.Mac hooks to install the
  # staged update on quit. A bare SIGTERM does NOT reliably trigger that handoff
  # (observed to swap only intermittently — the documented install-on-quit
  # flakiness, #8795/#7356), so we send the Apple Event and only fall back to
  # SIGTERM if it doesn't take.
  local bundle_id
  bundle_id="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' "$APP_BUNDLE/Contents/Info.plist" 2>/dev/null || echo "$BUNDLE_ID_FALLBACK")"
  local n
  n="$(pgrep -f 'Sonata.app/Contents/MacOS/Sonata' 2>/dev/null | wc -l | tr -d ' ')"
  [ "$n" -gt 1 ] && warn "$n Sonata processes running — an Apple Event quit targets by bundle id, so it may hit the daily driver. Prefer Cmd+Q in the harness window."
  step "Normal quit (Apple Event ⇒ Squirrel install-on-quit) of pid $pid ..."
  osascript -e "tell application id \"$bundle_id\" to quit" >/dev/null 2>&1 || true
  local t=0
  while pid_alive "$pid" && [ "$t" -lt 12 ]; do sleep 0.5; t=$((t + 1)); done
  if pid_alive "$pid"; then
    warn "Apple Event quit did not take; sending SIGTERM to pid $pid."
    kill -TERM "$pid" 2>/dev/null || true
  fi
  rm -f "$APP_PID_FILE"
}

cmd_kill() {
  local pid; pid="$(read_pid "$APP_PID_FILE")"
  if pid_alive "$pid"; then
    step "Force-killing pid $pid (no install-on-quit) ..."
    kill -KILL "$pid" 2>/dev/null || true
  fi
  rm -f "$APP_PID_FILE"
}

# --- version / logs ----------------------------------------------------------
cmd_version() {
  log "$(bundle_version "$APP_BUNDLE")"
}

cmd_logs() {
  step "app.log (last 40)"; tail -n 40 "$RUN_LOG" 2>/dev/null || log "  (none)"
  step "feed-server.log (last 20)"; tail -n 20 "$FEED_LOG" 2>/dev/null || log "  (none)"
}

# --- clean -------------------------------------------------------------------
cmd_clean() {
  cmd_kill >/dev/null 2>&1 || true
  local fpid; fpid="$(read_pid "$FEED_PID_FILE")"
  if pid_alive "$fpid"; then
    step "Stopping feed server pid $fpid ..."
    kill -TERM "$fpid" 2>/dev/null || true
  fi
  rm -f "$FEED_PID_FILE" "$FEED_URL_FILE" "$PORT_FILE"
  clear_updater_cache
  if [ "${1:-}" = "--all" ]; then
    step "Removing work dir $WORK ..."
    rm -rf "$WORK"
  fi
  log "Clean (incl. shared ~/Library/Caches updater + ShipIt dirs)."
}

# --- walkthrough -------------------------------------------------------------
cmd_walkthrough() {
  local url="unknown"; [ -f "$FEED_URL_FILE" ] && url="$(cat "$FEED_URL_FILE")"
  cat <<EOF

────────────────────────────────────────────────────────────────────────────
  Manual walkthrough — drive the REAL Sonata UI. Feed: $url
  Installed bundle: $APP_BUNDLE  (currently $(bundle_version "$APP_BUNDLE"))
────────────────────────────────────────────────────────────────────────────

  PATH A — pill / Restart to Update (exercises S2 + S3, skips the 60s wait)
   1. In the launched Sonata, open the menu: Sonata ▸ "Check for Updates…".
      Expect the native dialog to report an update is available and downloading
      in the background (S3 outcome). Dismiss it.
   2. Watch the app log for the download + stage:
         harness.sh logs        (look for update-downloaded / staged)
   3. The bottom-right sidebar pill appears: "Update". Click it once.
   4. It arms to "Restart to Update". Click again.
   5. It shows "Updating…", the window closes, ShipIt swaps the bundle, and
      the app relaunches on v2.
   6. Verify the swap:
         harness.sh version     → expect $V2

  PATH B — autoInstallOnAppQuit (normal quit, no clicking)
   7. Reset to v1 and relaunch (fresh profile, feed still advertises v2):
         harness.sh reset && harness.sh launch
   8. Do NOT touch the pill. Wait for the silent background download to stage:
         harness.sh logs        (update-downloaded)
   9. Quit normally (Cmd+Q in the app, or:  harness.sh stop).
  10. Relaunch and verify the install-on-quit swap took:
         harness.sh launch
         harness.sh version     → expect $V2

  Cleanup:  harness.sh clean --all
────────────────────────────────────────────────────────────────────────────
EOF
}

# --- up ----------------------------------------------------------------------
cmd_up() {
  cmd_install
  cmd_launch
  cmd_walkthrough
}

# --- dispatch ----------------------------------------------------------------
cmd="${1:-}"
[ "$#" -gt 0 ] && shift || true
case "$cmd" in
  build)        cmd_build ;;
  install|reset) cmd_install ;;
  serve)        cmd_serve ;;
  launch)       cmd_launch ;;
  stop)         cmd_stop ;;
  kill)         cmd_kill ;;
  version)      cmd_version ;;
  logs)         cmd_logs ;;
  walkthrough)  cmd_walkthrough ;;
  up)           cmd_up ;;
  clean)        cmd_clean "${1:-}" ;;
  -h|--help|"")
    awk 'NR>1 && /^set -euo/ {exit} NR>1 {sub(/^# ?/, ""); print}' "$0"
    ;;
  *) die 1 "Unknown command: $cmd (see --help)" ;;
esac
