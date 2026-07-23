/**
 * The interpreter prefix EVERY hook / broker / statusline command Sonata injects
 * into Claude Code and Codex begins with. Single-sourced here so all five command
 * constructors (Claude statusline + sink + broker; Codex sink + broker) emit the
 * exact same shape, and the rationale lives in one place.
 *
 *     ELECTRON_RUN_AS_NODE=1 "${SONATA_NODE:-node}" "<script>" <args...>
 *
 * **Ships-our-own-runtime.** Both CLIs ship self-contained native binaries and
 * carry NO Node.js dependency; a clean machine (no brew, no node) ran every
 * bare-`node` hook to exit 127 — the SessionStart handshake never fired, so Codex
 * transcript binding stayed blank. The shims never needed the Node *ecosystem*;
 * they need *a JS interpreter*, and Sonata already ships one (Electron). Under
 * `ELECTRON_RUN_AS_NODE=1` the Electron binary at `$SONATA_NODE` runs as a plain
 * Node process. The external-dependency count drops to zero.
 *
 * **Version pinning.** `$SONATA_NODE` is `process.execPath` (the running Sonata
 * binary), injected into the CLI spawn env by `runtime-controller.buildStartOptions`.
 * The packaged app embeds Node v24.15.0 (probe P2), so on the common path the
 * shim/interpreter version is locked to the app instead of borrowing whatever the
 * machine's PATH serves (node 12 included — a silent version-skew hazard the old
 * bare-`node` shape hid).
 *
 * **`${SONATA_NODE:-node}` fallback.** A user who manually runs `codex -p sonata`
 * OUTSIDE Sonata (the profile is persistent in `~/.codex`) has no `SONATA_NODE` in
 * their env — the shell expands `${SONATA_NODE:-node}` to bare `node`, degrading
 * to exactly today's PATH-node behavior rather than a noisy empty-string exec.
 * (Caveat: that rare fallback runs unpinned PATH node, not the pinned embed —
 * strictly better than today, which is already unpinned; the shims use only
 * long-stable Node APIs.)
 *
 * **Why env-keyed, not inline.** `$SONATA_NODE` never appears in the command TEXT,
 * so an app path containing spaces or quotes needs no quoting guard — the value
 * is delivered through the env and the expansion site here is double-quoted.
 * `ELECTRON_RUN_AS_NODE=1`, by contrast, is DELIBERATELY inline (part of this
 * constant), never in the spawn env: an env-level `ELECTRON_RUN_AS_NODE` would
 * poison any Electron binary the CLI's own children spawn, turning them into node
 * too. The command shape becomes a cross-machine constant (no absolute
 * interpreter path, no per-machine variance — better hash stability than before).
 *
 * Probe reference: `spikes/hook-runtime-binding-probe` (2026-07-23) confirmed all
 * four load-bearing assumptions (shell semantics on both CLIs incl. statusLine,
 * packaged run-as-node under hardened runtime, latency budget +14.5ms median,
 * and the unset fallback) against the real CLIs and the signed packaged app.
 */
export const SONATA_INTERPRETER_PREFIX = 'ELECTRON_RUN_AS_NODE=1 "${SONATA_NODE:-node}"';
