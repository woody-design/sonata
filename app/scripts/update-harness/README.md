# Auto-update end-to-end harness (S4)

Drives the **real** electron-updater → Squirrel.Mac update swap on your Mac,
locally, with no GitHub release and no notarization. It builds two signed
versions of the *current* tree, serves the newer one from a local HTTP feed, and
points a temp-installed copy of the older one at that feed.

This is the only way to catch the macOS-specific failures a compile check
cannot: signature-rejected swaps, translocation, `quitAndInstall` no-ops, and
install-on-quit. See `private/research/2026-07-24-autoupdate-tech-research.md`
Q5.

## What it verifies

- **The real ShipIt swap.** The signed ZIP unpacks to a bundle whose signature
  Squirrel.Mac accepts and swaps in place — the app relaunches on the new
  version.
- **Both install paths:**
  - **Pill / Restart to Update** — the S2 sidebar pill → `quitAndInstall()`
    (immediate swap + relaunch).
  - **autoInstallOnAppQuit** — a normal quit with a staged update installs it,
    so the next launch is the new version (macOS #8795/#7356 make this the less
    reliable path — that's exactly why we test it).
- **S3 "Check for Updates…" menu** reaches a live feed and reports the outcomes
  (update-available / downloading-in-background / already-downloading).
- **The S1 feed-override gate.** `SONATA_UPDATE_FEED_URL` both redirects the feed
  to the local server *and* relaxes the `/Applications` requirement, so the
  harness app runs and updates from a writable temp dir — leaving the real
  daily driver in `/Applications` untouched.

## Prerequisites

- **A Developer ID Application signing identity** in your login keychain
  (electron-builder.yml pins `Yuhui Li (NW3373QK97)`). Squirrel.Mac verifies the
  code signature of the swapped bundle and refuses an unsigned/ad-hoc one, so a
  meaningful macOS update test needs a signed build. An `Apple Development` cert
  is not enough; it must be a Developer ID.
- **No notarization is needed, and none is performed.** A locally built app
  carries no `com.apple.quarantine` xattr, so Gatekeeper never assesses it (the
  same reason `npm run package` skips notarization). Notarization/stapling only
  matters for a *downloaded* artifact and is exercised solely by the real
  release path (`scripts/release.sh`).
- **Full Xcode** (for the Tahoe-icon `afterPack` hook's `actool`), or set
  `SONATA_SKIP_TAHOE_ICON=1` to build an icns-only bundle. The icon is
  irrelevant to the update mechanics.
- Node + the repo's `node_modules` (electron-builder 26.x, electron-updater
  6.8.x).

## Usage

```sh
cd app

# 1. Build both signed versions and stage the feed (a few minutes — two builds).
scripts/update-harness/harness.sh build

# 2. Install v1 into a scratch temp profile, launch it against the local feed,
#    and print the manual walkthrough.
scripts/update-harness/harness.sh up

# … follow the printed walkthrough (drive the real UI) …

# Helpers used by the walkthrough:
scripts/update-harness/harness.sh version   # on-disk temp bundle version
scripts/update-harness/harness.sh logs      # tail app + feed-server logs
scripts/update-harness/harness.sh reset     # fresh profile + reinstall v1
scripts/update-harness/harness.sh launch    # relaunch the temp app
scripts/update-harness/harness.sh stop      # graceful quit (⇒ install-on-quit)

# 3. Tear down (kills the feed server + app; --all also removes the work dir).
scripts/update-harness/harness.sh clean --all
```

### The two versions

Both versions are built from a single `npm run build` by overriding only
electron-builder's version (`--config.extraMetadata.version`) — **package.json
on disk is never touched**:

- `v1 = <base>-harness.1` — installed into the temp dir; the app you run.
- `v2 = <base>-harness.2` — advertised by the feed; the update.

`<base>` is the current `package.json` version. They are prerelease versions;
electron-updater auto-allows prerelease→prerelease updates when the running
version is itself a prerelease, and `semver.gt('…harness.2', '…harness.1')` is
true, so `v2` is offered.

### Why no publish-provider override is needed

electron-builder's generated `latest-mac.yml` lists **relative** file URLs
(`Sonata-…-mac.zip`, not an absolute GitHub URL). electron-updater's generic
provider resolves those against the runtime feed base
(`SONATA_UPDATE_FEED_URL`). So the manifest produced by the committed
GitHub-publish config is already correct for the local generic feed — the
harness leaves the publish provider as-is and only serves the artifacts. (The
harness app's own bundled `app-update.yml` is irrelevant: `updater-controller`
calls `autoUpdater.setFeedURL({provider:"generic", …})` at runtime, which fully
overrides it.)

## Profile isolation

The harness app runs against a **scratch profile**, so it never reads or writes
the daily driver's real per-user data:

- `SONATA_DATA_DIR` → `<work>/profile/data` — Sonata's `~/.sonata` home
  (sessions, config, runtime).
- Electron's native `--user-data-dir` → `<work>/profile/userData` — window
  state, the local-api socket, and Chromium's own caches.

There is no single-instance lock, so the harness app launches even while the
daily driver is running.

### The one thing `--user-data-dir` does NOT cover: the updater cache

electron-updater's download cache and Squirrel's ShipIt working dir live under
`~/Library/Caches`, keyed by `updaterCacheDirName` / the bundle id — **not**
under `--user-data-dir`:

- `~/Library/Caches/sonata-app-updater/` — the downloaded/staged update ZIP.
- `~/Library/Caches/app.sonatacode.sonata.ShipIt/` — Squirrel's staging dir.

Left alone, a staged download would leak between the two install paths, and it
is a location **shared with the daily driver's bundle id**. So `install` /
`reset` (and `clean`) **clear both**, forcing each path to re-download fresh.
This is safe: the daily driver is an internal build with the updater inert, so
it never populates these dirs.

**One caveat at the very end:** after a successful swap, Squirrel relaunches the
bundle *without* the harness env/switch, so the relaunched process falls back to
the default `~/.sonata` profile. All the interesting updater behavior happens
*before* that relaunch; quit the relaunched app promptly. Version verification
reads the on-disk `Info.plist` (`harness.sh version`), so it never depends on the
relaunched process's profile.

## Known limits (expected, not bugs)

- **Differential download is unreliable and will fall back to full.** A
  first-install harness has no cached previous `.zip.blockmap`, so
  electron-updater logs "Unable to locate previous update.zip … falling back to
  full download". The feed server supports HTTP Range so the differential path
  can be *attempted*, but a full ~100 MB download is the normal, correct
  outcome. Differential savings are a documented non-assumption.
- **Notarization/stapling is not exercised here** — only by the real release
  path. Locally built apps are quarantine-free, so Gatekeeper never gates them.
- **The pill/menu clicks are manual.** The harness automates everything up to
  the UI (build, feed, install, launch, background download, staging) and the
  install-on-quit swap (a scripted graceful quit). The pill click and the
  Restart-to-Update confirm are driven by hand — that is the point (a human
  walks the real UI).
- **Squirrel.Mac's own localhost proxy** sits between the feed server and
  Squirrel; the feed server only sees electron-updater's full-ZIP fetch. That is
  the correct topology.
