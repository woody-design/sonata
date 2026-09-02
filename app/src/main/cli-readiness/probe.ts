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
 * MEASURED on this machine 2026-08-05 and again 2026-09-01 (claude 2.1.258,
 * codex-cli 0.152.0), `claude --version` / `claude auth status --json` /
 * `codex --version` / `codex login status` return in 8 / 115 / 8 / 13 ms — well
 * under 0.5s on both binaries. Five seconds is headroom for a cold binary on a
 * slow disk; the point of the bound is that a wedged CLI can never keep a probe
 * — or the launch trigger that started it — alive for long.
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
  /**
   * Main-process-only side channel for what a probe pass saw that is NOT a
   * readiness fact (D2 U2 / F2).
   *
   * A separate channel rather than another field on `CliProviderReadiness`,
   * because that shape is the renderer's IPC payload and is deliberately closed:
   * it is validated key-for-key (`isCliProviderReadiness`), compared field-wise
   * to gate the change broadcast, and mapped over every provider — so a
   * Claude-only operational path on it would be three kinds of wrong at once.
   * Absent for every caller that does not want it, which is all of them but the
   * readiness controller.
   */
  readonly observe?: (details: CliProbeDetails) => void;
}

/** What a probe pass learned beyond readiness. Claude-shaped today; a second
 *  provider's detail would be a second field, not a mapped type — these are
 *  facts about one CLI's own layout, not an axis every provider has. */
export interface CliProbeDetails {
  /**
   * Claude's transcript root, as `claude auth status --json` reports it
   * (`projectsDirectory`). Null when the command did not run or did not answer
   * in a shape we recognize — the consumer then derives the path itself, which
   * is correct today and is exactly the derivation this field exists to retire.
   */
  readonly claudeProjectsDirectory: string | null;
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
  /**
   * Optional second reading of the SAME auth output, for facts that are not
   * readiness (see {@link ProbeOptions.observe}). Declared only by the provider
   * that has such a fact; a spec without it never observes anything, so the
   * other provider costs nothing and says nothing.
   *
   * Called on every probe of this provider — including the passes where the auth
   * command never ran, with `exit === null` — so the consumer's cache always
   * reflects the LAST probe rather than the last successful one.
   */
  readonly readDetails?: (exit: CliCommandExit | null) => CliProbeDetails;
}

/**
 * Claude Code. MEASURED 2026-08-05 (claude 2.1.222) and RE-MEASURED 2026-09-01
 * (claude **2.1.258**) on this machine — evidence
 * `spikes/upstream-sync-2026-09/codex/q24-cli-readiness.capture.txt`, which runs
 * these exact commands and feeds the outcomes to the readers below:
 * - `claude --version` → exit 0, stdout `2.1.258 (Claude Code)`, stderr empty,
 *   ~8ms. Zero file side effects.
 * - `claude auth status --json`, signed in → exit 0, stdout JSON, ~115ms. The
 *   document GREW two fields between 2.1.222 and 2.1.258 —
 *   `"analyticsDisabled":false` and `"projectsDirectory":"…/.claude/projects"`
 *   now sit alongside `loggedIn`/`authMethod`/`apiProvider`/`email`/`orgId`/
 *   `orgName`/`subscriptionType`. Nothing here reads them; recorded because a
 *   fixture that claims to be MEASURED has to say which shape it measured.
 * - the same command under a fresh `HOME` → **exit 1**, stdout JSON
 *   `{"loggedIn":false,"authMethod":"none","apiProvider":"firstParty",
 *   "analyticsDisabled":false,"projectsDirectory":…}`. A fresh `HOME` on its own
 *   is enough — `CLAUDE_CONFIG_DIR` does not have to be redirected as well
 *   (MEASURED both ways 2026-09-01). Creates the CLI's own config skeleton
 *   (`.claude.json`, `.claude/`) in that HOME — on a real user's machine it
 *   already exists, and repeat runs add nothing.
 * - an unknown `auth` subcommand → exit 1, stdout empty, stderr
 *   `error: unknown command '…'`.
 */
export const CLAUDE_PROBE: CliProbeSpec = {
  provider: "claude",
  command: "claude",
  versionArgs: ["--version"],
  authArgs: ["auth", "status", "--json"],
  readAuth: readClaudeAuth,
  readDetails: (exit) => ({
    claudeProjectsDirectory: exit === null ? null : readClaudeProjectsDirectory(exit),
  }),
};

/**
 * Codex. MEASURED 2026-08-05 (codex-cli 0.146.0) and RE-MEASURED 2026-09-01
 * (codex-cli **0.152.0**) on this machine — same evidence file as CLAUDE_PROBE.
 * Every shape below survived the 0.146→0.152 jump unchanged, the version number
 * itself aside — which is the opposite of the claude side, whose auth document
 * grew two fields:
 * - `codex --version` → exit 0, stdout `codex-cli 0.152.0`, stderr empty, ~8ms.
 * - `codex login status`, signed in → exit 0, **stderr** `Logged in using
 *   ChatGPT`, stdout EMPTY, ~13ms.
 * - the same under a fresh `CODEX_HOME` → exit 1, **stderr** `Not logged in`.
 * - the same over a malformed `config.toml` → exit 1, stderr `Error loading
 *   configuration: …:1:6: key with no value, expected \`=\``. Recognized by
 *   neither phrase, so it reads `unknown` — a config the CLI cannot load tells
 *   us nothing about whether the user is signed in, and calling it `signedOut`
 *   would send them to a login screen for a parse error.
 *
 * The signed-in sentence is one of SEVEN at 0.152.0, one per auth mode
 * (`codex-rs/cli/src/login.rs`): `Logged in using ChatGPT` /
 * `… workload identity` / `… an API key - <masked>` / `… access token` /
 * `… personal access token` / `… Amazon Bedrock API key` / `… Amazon Bedrock AWS
 * access keys`. All seven begin `Logged in`, which is the prefix
 * {@link readCodexAuth} anchors on, so the reader needs no per-mode table — and
 * the one non-answer on that path (`Error checking login status: …`) matches
 * neither prefix and lands on `unknown`, the permissive side.
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
    // The auth command never ran, so there is no output to read details from —
    // say so rather than leave a consumer holding a value from a machine that has
    // since lost the binary.
    observe(spec, options, null);
    return { install, auth: "unknown" };
  }

  const outcome = await runSafely(run, spec.command, spec.authArgs, timeoutMs);
  observe(spec, options, outcome.kind === "exit" ? outcome : null);
  return {
    install,
    auth: outcome.kind === "exit" ? spec.readAuth(outcome) : "unknown",
  };
}

/** Deliver this provider's non-readiness details, when it has any and someone
 *  asked. Never throws into the probe: an observer is a listener, not a step. */
function observe(spec: CliProbeSpec, options: ProbeOptions, exit: CliCommandExit | null): void {
  if (!spec.readDetails || !options.observe) {
    return;
  }
  try {
    options.observe(spec.readDetails(exit));
  } catch {
    // A broken observer must not turn a completed probe into a failed one.
  }
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

/**
 * Claude's own transcript root, off the same document `readClaudeAuth` reads
 * (`projectsDirectory`, present since 2.1.258 — MEASURED, see CLAUDE_PROBE's
 * note, which recorded the field appearing before anything consumed it).
 *
 * Read on BOTH exit codes and both streams for the same reasons the auth read
 * is: a signed-OUT answer is a well-formed document delivered on exit 1, and it
 * carries this field too. Anything else — no JSON, no string, an empty string —
 * is null, and null means "derive it", never "there is none".
 */
export function readClaudeProjectsDirectory(exit: CliCommandExit): string | null {
  return readProjectsDirectory(exit.stdout) ?? readProjectsDirectory(exit.stderr);
}

function readProjectsDirectory(output: string): string | null {
  let payload: unknown;
  try {
    payload = JSON.parse(output);
  } catch {
    return null;
  }
  if (typeof payload !== "object" || payload === null) {
    return null;
  }
  const directory = (payload as Record<string, unknown>).projectsDirectory;
  return typeof directory === "string" && directory.trim() ? directory : null;
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
