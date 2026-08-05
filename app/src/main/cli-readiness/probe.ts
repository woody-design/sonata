import { execFile } from "node:child_process";
import type { RuntimeProvider } from "../../shared/types/domain";
import type {
  CliAuthState,
  CliInstallState,
  CliProviderReadiness,
  CliReadinessFacts,
} from "../../shared/types/cli-readiness";
import { cliCommandEnv } from "./cli-env";

/**
 * The readiness probe: two structured commands per provider, turned into facts
 * (CLI readiness S1; plan D2/D3/L2).
 *
 * **Structured commands only — never TUI scraping.** The provider's own screens
 * are a moving target that a CLI upgrade rearranges without notice (the Duet
 * scar), so this module reads only what the CLIs offer as machine output: a
 * version line, a JSON document, a one-line status. When that output stops
 * looking like itself, the answer is `unknown` — the permissive state — not a
 * guess and not an accusation.
 *
 * **Nothing here throws.** Every command resolves to an outcome, every outcome
 * maps to a fact, and the ONE distinction the CLI updater's checker deliberately
 * flattens is the one this module must keep: `absent` (ENOENT — there is nothing
 * to spawn, and Sonata has something to offer) is not `unknown` (we could not
 * tell, so Sonata says nothing).
 */

/**
 * Ceiling per command. Matches the CLI updater's checker (L2), and generously:
 * MEASURED on this machine 2026-08-05, `claude --version` / `claude auth status
 * --json` / `codex --version` / `codex login status` all return in well under
 * 0.5s. Five seconds is headroom for a cold binary on a slow disk; the point of
 * the bound is that a wedged CLI can never keep a probe — or the launch trigger
 * that started it — alive for long.
 */
export const PROBE_TIMEOUT_MS = 5_000;

/** A command that ran to completion and was reaped. */
export interface CliCommandExit {
  readonly kind: "exit";
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

/**
 * How a probe command went. Three cases, and the split between the last two is
 * the module's whole point: `absent` is the actionable one (the binary is not on
 * the PATH the spawn would use), `failed` is everything else — timeout, signal,
 * an output flood past execFile's buffer — which is knowing nothing.
 */
export type CliCommandOutcome =
  | CliCommandExit
  | { readonly kind: "absent" }
  | { readonly kind: "failed" };

/** The effect seam. Resolves; never rejects. */
export type RunCliCommand = (
  command: string,
  args: readonly string[],
  timeoutMs: number,
) => Promise<CliCommandOutcome>;

export interface ProbeOptions {
  readonly run?: RunCliCommand;
  readonly timeoutMs?: number;
}

/**
 * One provider's probe: the binary, the two argv shapes, and the pure reading of
 * the auth command's output. The reader is a function rather than a pattern
 * because the two CLIs answer in genuinely different registers — one emits JSON,
 * the other a sentence — and pretending otherwise is how a shared "parser"
 * becomes a place where one provider's drift breaks the other.
 */
export interface CliProbeSpec {
  readonly provider: RuntimeProvider;
  readonly command: string;
  readonly versionArgs: readonly string[];
  readonly authArgs: readonly string[];
  readonly readAuth: (exit: CliCommandExit) => CliAuthState;
}

/**
 * Claude Code. MEASURED 2026-08-05 (claude 2.1.222) on this machine:
 * - `claude --version` → exit 0, stdout `2.1.222 (Claude Code)`, stderr empty.
 *   Zero file side effects.
 * - `claude auth status --json`, signed in → exit 0, stdout JSON
 *   `{"loggedIn":true,"authMethod":"claude.ai","apiProvider":"firstParty",
 *   "email":…,"orgId":…,"orgName":…,"subscriptionType":"max"}`.
 * - the same command under a fresh `HOME` → **exit 1**, stdout JSON
 *   `{"loggedIn":false,"authMethod":"none","apiProvider":"firstParty"}`. Creates
 *   the CLI's own config skeleton (`.claude.json`, `.claude/`) in that HOME —
 *   on a real user's machine it already exists, and repeat runs add nothing.
 * - an unknown `auth` subcommand → exit 1, stdout empty, stderr
 *   `error: unknown command '…'`.
 */
export const CLAUDE_PROBE: CliProbeSpec = {
  provider: "claude",
  command: "claude",
  versionArgs: ["--version"],
  authArgs: ["auth", "status", "--json"],
  readAuth: readClaudeAuth,
};

/**
 * Codex. MEASURED 2026-08-05 (codex-cli 0.146.0) on this machine:
 * - `codex --version` → exit 0, stdout `codex-cli 0.146.0`, stderr empty.
 * - `codex login status`, signed in → exit 0, **stderr** `Logged in using
 *   ChatGPT`, stdout EMPTY.
 * - the same under a fresh `CODEX_HOME` → exit 1, **stderr** `Not logged in`.
 * - the same over a malformed `config.toml` → exit 1, stderr `Error loading
 *   configuration: …:1:6: key with no value, expected \`=\``. Recognized by
 *   neither phrase, so it reads `unknown` — a config the CLI cannot load tells
 *   us nothing about whether the user is signed in, and calling it `signedOut`
 *   would send them to a login screen for a parse error.
 */
export const CODEX_PROBE: CliProbeSpec = {
  provider: "codex",
  command: "codex",
  versionArgs: ["--version"],
  authArgs: ["login", "status"],
  readAuth: readCodexAuth,
};

/** Probe both providers. Never rejects. */
export async function probeCliReadiness(options: ProbeOptions = {}): Promise<CliReadinessFacts> {
  // Concurrent because the two providers are genuinely independent — unlike the
  // two commands WITHIN a provider, where the second depends on the first. The
  // login-shell PATH capture they share is resolved synchronously on first use,
  // so there is no race to win here either.
  const [claude, codex] = await Promise.all([
    probeProvider(CLAUDE_PROBE, options),
    probeProvider(CODEX_PROBE, options),
  ]);
  return { claude, codex };
}

/**
 * Probe one provider. Sequential and short-circuiting: the auth command runs
 * ONLY over a binary that has positively answered `--version`.
 *
 * Both halves of that rule matter. Skipping it when the binary is `absent` is
 * the checker.ts precedent — there is nothing to ask. Skipping it when the
 * version command failed some OTHER way (`unknown`) is the stronger claim, and
 * it is a correctness rule rather than an optimization: `signedOut` is an
 * ACTIONABLE fact that sends the user to a login screen, and we will not derive
 * one from a CLI we could not even get a version out of. It also bounds a
 * wedged machine's cost at one timeout per provider instead of two.
 */
export async function probeProvider(
  spec: CliProbeSpec,
  options: ProbeOptions = {},
): Promise<CliProviderReadiness> {
  const timeoutMs = options.timeoutMs ?? PROBE_TIMEOUT_MS;
  const run = options.run ?? defaultRunCliCommand;

  const install = readInstall(await runSafely(run, spec.command, spec.versionArgs, timeoutMs));
  if (install !== "present") {
    return { install, auth: "unknown" };
  }

  const outcome = await runSafely(run, spec.command, spec.authArgs, timeoutMs);
  return {
    install,
    auth: outcome.kind === "exit" ? spec.readAuth(outcome) : "unknown",
  };
}

/**
 * Read the install axis off the version command. `absent` is ENOENT and nothing
 * else; a non-zero exit or a timeout is `unknown`.
 *
 * A successful exit means `present` REGARDLESS of what the binary printed. The
 * version string is not parsed, because nothing in this subsystem needs it: only
 * `absent` is actionable, and "something on PATH answered `--version`
 * successfully" is exactly the claim `present` makes. Parsing would add a way to
 * mistake a wrapper script or a shell function for a missing install.
 */
function readInstall(outcome: CliCommandOutcome): CliInstallState {
  if (outcome.kind === "absent") {
    return "absent";
  }
  return outcome.kind === "exit" && outcome.code === 0 ? "present" : "unknown";
}

/**
 * Claude's verdict comes from JSON-parsing `loggedIn`, NEVER from the exit code:
 * MEASURED, a signed-OUT answer is a perfectly well-formed document delivered on
 * exit 1, so the code alone would classify the CLI's clearest possible answer as
 * a failure. No boolean `loggedIn` in hand (an older CLI without the subcommand,
 * a future one that renames the field, an error page) is `unknown`.
 *
 * stdout first, then stderr: `--json` puts the document on stdout today, and the
 * fallback costs one line while covering the exact drift its sibling CLI already
 * demonstrates — `codex login status` prints its status on stderr.
 */
export function readClaudeAuth(exit: CliCommandExit): CliAuthState {
  const loggedIn = readLoggedInFlag(exit.stdout) ?? readLoggedInFlag(exit.stderr);
  if (loggedIn === null) {
    return "unknown";
  }
  return loggedIn ? "signedIn" : "signedOut";
}

function readLoggedInFlag(output: string): boolean | null {
  let payload: unknown;
  try {
    payload = JSON.parse(output);
  } catch {
    return null;
  }
  if (typeof payload !== "object" || payload === null) {
    return null;
  }
  const loggedIn = (payload as Record<string, unknown>).loggedIn;
  return typeof loggedIn === "boolean" ? loggedIn : null;
}

/**
 * Codex answers in a sentence, so the verdict is the two phrases it is MEASURED
 * to print and nothing else. Anchored at the START of a line and checked
 * negative-first: a bare "contains 'logged in'" test would read an error such as
 * "could not determine whether you are logged in" as signed IN, which is the one
 * mistake that matters (a false healthy hides the real problem instead of
 * showing it). Anything unrecognized is `unknown`.
 *
 * Both streams are read because the phrase arrives on stderr today (MEASURED)
 * and there is no reason a status line should be pinned to one stream.
 */
export function readCodexAuth(exit: CliCommandExit): CliAuthState {
  for (const line of `${exit.stdout}\n${exit.stderr}`.split("\n")) {
    const normalized = line.trim().toLowerCase();
    if (normalized.startsWith("not logged in")) {
      return "signedOut";
    }
    if (normalized.startsWith("logged in")) {
      return "signedIn";
    }
  }
  return "unknown";
}

/** The seam is contracted never to reject; this makes that true of every seam,
 *  including an injected one, so no caller above needs a catch block. */
async function runSafely(
  run: RunCliCommand,
  command: string,
  args: readonly string[],
  timeoutMs: number,
): Promise<CliCommandOutcome> {
  try {
    return await run(command, args, timeoutMs);
  } catch {
    return { kind: "failed" };
  }
}

/**
 * The real effect. Resolves for every failure mode rather than rejecting, so the
 * outcome classification lives in one place instead of a catch block per caller.
 *
 * `execFile`'s error channel needs decoding: `code` is the string `"ENOENT"` when
 * the binary is missing and the numeric exit status when the command merely
 * failed, and a timeout arrives as a KILLED child (`killed` / `signal` set, with
 * `code` unreliable). Checking killed/signal before trusting a numeric code is
 * what keeps a 5s timeout from being reported as an exit status.
 */
function defaultRunCliCommand(
  command: string,
  args: readonly string[],
  timeoutMs: number,
): Promise<CliCommandOutcome> {
  return new Promise((resolve) => {
    execFile(
      command,
      [...args],
      { timeout: timeoutMs, encoding: "utf8", env: cliCommandEnv() },
      (error, stdout, stderr) => {
        if (!error) {
          resolve({ kind: "exit", code: 0, stdout, stderr });
          return;
        }
        const failure = error as NodeJS.ErrnoException & {
          killed?: boolean;
          signal?: string | null;
        };
        if (failure.code === "ENOENT") {
          resolve({ kind: "absent" });
          return;
        }
        if (!failure.killed && !failure.signal && typeof failure.code === "number") {
          resolve({ kind: "exit", code: failure.code, stdout, stderr });
          return;
        }
        resolve({ kind: "failed" });
      },
    );
  });
}
