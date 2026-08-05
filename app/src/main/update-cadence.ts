/**
 * The shared update-check cadence — one rhythm, two independent schedulers.
 *
 * Sonata runs TWO updaters that answer to the same question ("is something
 * stale?") on the same human rhythm but through different machinery:
 *
 *  - `updater/updater-controller.ts` — Sonata's own app bundle, via
 *    electron-updater. Packaged-gated (`evaluateUpdaterGate`), so it is inert
 *    in dev.
 *  - `cli-updater/cli-updater.ts` — the user's installed Codex CLI. NOT gated:
 *    a dev build spawns the same real `codex` a packaged build does, so it must
 *    keep it fresh too.
 *
 * The gate difference is exactly why they cannot share a scheduler (there is no
 * consumer seam on UpdaterController either — its only injected seam is
 * `broadcast`). What they SHOULD share is the cadence, so a future "check less
 * often" ruling is one edit rather than two that silently drift apart. Hence:
 * shared constants, separate timers (plan v1 D1).
 *
 * The values themselves: the first check is late enough not to compete with
 * boot, soon enough to catch a stale launch; the interval is deliberately
 * unaggressive — the app updater rides a public atom feed + CDN (research Q2)
 * and the CLI updater rides the npm registry, and neither has anything to gain
 * from polling harder than a user's natural start-of-day / end-of-day rhythm.
 */

/** Delay from `start()` to the first silent check. */
export const FIRST_CHECK_DELAY_MS = 60_000;

/** Steady-state interval between silent checks after the first one. */
export const CHECK_INTERVAL_MS = 12 * 60 * 60 * 1000;
