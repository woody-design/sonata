import { loginShellPath, mergePath } from "../../runtime/terminal-host/login-shell-path";

/**
 * The environment the CLI updater runs `codex` in — deliberately THE SAME PATH
 * resolution the pty spawn uses.
 *
 * This is the module's whole reason to exist, and it is load-bearing. A
 * Finder/Dock-launched `.app` inherits launchd's minimal PATH, so a naive
 * `execFile("codex", …)` from the main process would fail with ENOENT on
 * exactly the installs that need updating most — and worse, a MISMATCH between
 * the two resolutions would be silently wrong rather than loudly broken: we
 * would report the version of one codex while the user's sessions run another
 * (nvm shim vs brew, say). One helper, two callers (checker + executor), so
 * "same PATH as the spawn" cannot drift into a comment nobody enforces.
 *
 * `loginShellPath()` is process-cached and already paid for by the first pty
 * spawn; `mergePath` keeps the inherited PATH's order and authority and only
 * appends what is missing (see login-shell-path.ts for why that direction).
 */
export function codexCommandEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  const mergedPath = mergePath(loginShellPath(), env.PATH);
  return {
    ...env,
    ...(mergedPath !== undefined ? { PATH: mergedPath } : {}),
  };
}
