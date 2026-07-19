import { execFileSync } from "node:child_process";

/**
 * Login-shell PATH resolution (Mine 2 — GUI-launch PATH).
 *
 * A Finder/Dock-launched `.app` inherits launchd's minimal PATH
 * (`/usr/bin:/bin:/usr/sbin:/sbin`), NOT the user's interactive PATH. That
 * breaks every provider spawn — `node`, `claude`, `codex`, `git` all live in
 * `~/.local/bin`, `/opt/homebrew/bin`, nvm/volta shims, etc., none of which are
 * on launchd's PATH. A terminal-launched dev build never hits this because the
 * shell already exported the full PATH before Electron started.
 *
 * The fix mirrors the well-worn `fix-path`/`shell-env` approach: run the user's
 * login shell interactively, print `$PATH` between markers, parse it back out,
 * and merge it into the environment handed to every pty spawn.
 *
 * Deliberate constraints:
 * - darwin-only: launchd/Finder PATH stripping is a macOS behavior. On other
 *   platforms we leave PATH untouched.
 * - `$SHELL -ilc` (interactive login) so `~/.zprofile`/`~/.zshrc` (or bash
 *   equivalents) that mutate PATH are sourced exactly as a real terminal would.
 * - ~2s timeout: a hung shell rc must never wedge a task spawn. On timeout we
 *   fall back to the inherited (launchd) PATH — same behavior as before this
 *   existed, never worse.
 * - cached once per process: the login PATH does not change under us, and the
 *   shell subprocess is the one expensive part. The first pty spawn pays it.
 * - escape hatch `SONATA_DISABLE_LOGIN_SHELL_PATH=1`: for users whose login
 *   shell rc is slow/hostile, or for debugging, disable the merge entirely.
 */

const PATH_MARKER_BEGIN = "__SONATA_PATH_BEGIN__";
const PATH_MARKER_END = "__SONATA_PATH_END__";
const LOGIN_SHELL_TIMEOUT_MS = 2000;

export interface LoginShellPathOptions {
  /** Defaults to `process.platform`. */
  platform?: NodeJS.Platform;
  /** Defaults to `process.env.SHELL`. */
  shell?: string;
  /** Defaults to `process.env.SONATA_DISABLE_LOGIN_SHELL_PATH === "1"`. */
  disabled?: boolean;
  /** Injectable for tests; defaults to a `$SHELL -ilc` subprocess. */
  exec?: (shell: string, args: string[], timeoutMs: number) => string;
}

/**
 * Resolve the user's login-shell PATH, or `null` when it should not / cannot be
 * resolved (non-darwin, disabled, no `$SHELL`, timeout, or a shell that printed
 * no usable value). Pure w.r.t. its options — the only side effect is the
 * injectable shell subprocess.
 */
export function resolveLoginShellPath(options: LoginShellPathOptions = {}): string | null {
  const platform = options.platform ?? process.platform;
  if (platform !== "darwin") {
    return null;
  }

  const disabled = options.disabled ?? process.env.SONATA_DISABLE_LOGIN_SHELL_PATH === "1";
  if (disabled) {
    return null;
  }

  const shell = options.shell ?? process.env.SHELL;
  if (!shell) {
    return null;
  }

  const exec = options.exec ?? defaultExec;
  // Print PATH wrapped in sentinels so we can extract it even when a login shell
  // also emits MOTD/banner noise on stdout.
  const script = `printf '%s%s%s' '${PATH_MARKER_BEGIN}' "$PATH" '${PATH_MARKER_END}'`;

  let output: string;
  try {
    output = exec(shell, ["-ilc", script], LOGIN_SHELL_TIMEOUT_MS);
  } catch {
    // Timeout, non-zero exit, missing shell — fall back to the inherited PATH.
    return null;
  }

  const begin = output.indexOf(PATH_MARKER_BEGIN);
  const end = output.indexOf(PATH_MARKER_END);
  if (begin === -1 || end === -1 || end < begin) {
    return null;
  }

  const value = output.slice(begin + PATH_MARKER_BEGIN.length, end);
  return value.length > 0 ? value : null;
}

function defaultExec(shell: string, args: string[], timeoutMs: number): string {
  return execFileSync(shell, args, {
    timeout: timeoutMs,
    encoding: "utf8",
    // Ignore stdin; capture stdout; discard stderr (rc noise must not corrupt
    // the parse and must not surface as a crash).
    stdio: ["ignore", "pipe", "ignore"],
  });
}

/**
 * Merge a resolved login-shell PATH ahead of the current PATH, de-duplicating
 * while preserving first-seen order. Login-shell entries win precedence (they
 * are the user's real toolchain locations); inherited entries that are not
 * already present are appended so nothing launchd provided is lost. Returns the
 * current PATH unchanged when there is nothing to merge.
 */
export function mergePath(
  loginPath: string | null,
  currentPath: string | undefined,
): string | undefined {
  if (!loginPath) {
    return currentPath;
  }

  const seen = new Set<string>();
  const merged: string[] = [];
  const parts = [
    ...loginPath.split(":"),
    ...(currentPath ? currentPath.split(":") : []),
  ];
  for (const part of parts) {
    if (!part || seen.has(part)) {
      continue;
    }
    seen.add(part);
    merged.push(part);
  }

  return merged.length > 0 ? merged.join(":") : currentPath;
}

let cached: { value: string | null } | undefined;

/**
 * Process-cached login-shell PATH. Resolved on first call (the first pty spawn),
 * reused thereafter. The cache stores the result — including `null` — so a
 * timeout/disable is not retried on every subsequent spawn.
 */
export function loginShellPath(): string | null {
  if (cached === undefined) {
    cached = { value: resolveLoginShellPath() };
  }
  return cached.value;
}

/** Test-only: clear the process cache so a suite can exercise resolution again. */
export function __resetLoginShellPathCache(): void {
  cached = undefined;
}
