import {
  loginShellPath,
  mergePath,
  resetLoginShellPathCache,
} from "../../runtime/terminal-host/login-shell-path";

/**
 * The environment CLI probes run in — deliberately THE SAME PATH resolution the
 * pty spawn uses (plan D2).
 *
 * This is the module's whole reason to exist. A Finder/Dock-launched `.app`
 * inherits launchd's minimal PATH, so a naive `execFile("claude", …)` from the
 * main process reports ABSENT on a machine where the user's sessions run that
 * CLI every day — which is the Anthropic Desktop #42350 detect/run mismatch bug,
 * reproduced. Worse than loud breakage: a mismatch is silently wrong, so the
 * card would accuse the user of not having installed something they installed.
 *
 * Provider-agnostic by construction — nothing here knows the difference between
 * `claude` and `codex`, because "resolve a user CLI the way the spawn resolves
 * it" has no provider in it. The CLI updater's `cli-updater/codex-env.ts` is the
 * same function under a provider-specific name; collapsing the two is explicitly
 * deferred to phase 2 of the readiness program (their overlap is documented, not
 * accidental), so the duplication is a scoped decision rather than drift.
 */
export function cliCommandEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  // `mergePath` keeps the inherited PATH's order and authority and only appends
  // what is missing — see login-shell-path.ts for why that direction, and why a
  // login-first merge would hijack a test harness's injected fake CLI.
  const mergedPath = mergePath(loginShellPath(), env.PATH);
  return {
    ...env,
    ...(mergedPath !== undefined ? { PATH: mergedPath } : {}),
  };
}

/**
 * Discard the process-cached login-shell PATH so the next probe re-captures it
 * (plan L7).
 *
 * The cache is right for the steady state — the login PATH does not change under
 * us — and wrong for exactly one moment: right after an install. Both official
 * installers drop a binary into a directory they also add to the user's shell
 * profile, so the PATH captured at launch is stale BY CONSTRUCTION at the only
 * instant we need it to be fresh. A re-probe that skips this would report
 * `absent` for a CLI that was just installed successfully, and the install flow
 * would show a failure card for a success.
 */
export function bustLoginShellPathCache(): void {
  resetLoginShellPathCache();
}
