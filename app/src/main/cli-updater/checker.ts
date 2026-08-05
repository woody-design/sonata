import { execFile } from "node:child_process";
import { codexCommandEnv } from "./codex-env";
import { parseCodexVersionOutput, parseVersion } from "./policy";
import type { CliUpdaterCheckFact } from "./state";

/**
 * The CLI updater's read half: what is installed, and what is newest.
 *
 * Two independent effects behind two injectable seams, each of which resolves to
 * `null` rather than throwing. The whole module's contract is that a check
 * ALWAYS produces a fact — codex absent, registry unreachable, shell hostile,
 * output in a shape we do not recognize all yield a clean `ok: false` record.
 * Nothing downstream has a catch block, because nothing downstream can fail.
 *
 * Never on a hot path: the facts file is the cache, and `runCycle` is what
 * refreshes it in the background.
 */

/**
 * npm's dist-tags endpoint — free, unauthenticated, no rate limit (unlike the
 * GitHub API's 60/hr), and codex's own npm path already treats npm publication
 * as the gate on announcing a version. Deliberately not the brew cask API: the
 * install method is `codex update`'s business, not ours, and brew lag costs at
 * most a no-op run.
 */
export const CODEX_DIST_TAGS_URL =
  "https://registry.npmjs.org/-/package/@openai/codex/dist-tags";

/**
 * Ceiling for each of the two effects. Measured on this machine 2026-08-05:
 * `codex --version` ~0.02s, the dist-tags GET ~0.19s. Five seconds is two orders
 * of magnitude of headroom — generous enough that a cold binary or a slow link
 * still succeeds, tight enough that a wedged network cannot keep a cycle (and
 * the `runCycle` re-entrancy guard with it) alive for long.
 */
export const CHECK_TIMEOUT_MS = 5_000;

export interface CheckOptions {
  /** Resolve `codex --version` stdout; rejects when codex is absent or fails. */
  readonly execVersion?: (timeoutMs: number) => Promise<string>;
  /** Resolve the dist-tags response body; rejects on timeout / non-2xx. */
  readonly fetchDistTags?: (timeoutMs: number) => Promise<string>;
  readonly now?: () => Date;
  readonly timeoutMs?: number;
}

/**
 * Produce one `lastCheck` fact. Sequential on purpose: when codex is not
 * installed there is nothing an npm lookup could tell us, and a machine that
 * only ever runs Claude Code should not be making a request on Sonata's behalf
 * every twelve hours.
 */
export async function checkCodex(options: CheckOptions = {}): Promise<CliUpdaterCheckFact> {
  const timeoutMs = options.timeoutMs ?? CHECK_TIMEOUT_MS;
  const now = options.now ?? (() => new Date());
  const execVersion = options.execVersion ?? defaultExecVersion;
  const fetchDistTags = options.fetchDistTags ?? defaultFetchDistTags;

  const installed = await readInstalledVersion(execVersion, timeoutMs);
  const latest = installed === null ? null : await readLatestVersion(fetchDistTags, timeoutMs);

  return {
    at: now().toISOString(),
    // `ok` means "comparable pair in hand", nothing more. The three ways to miss
    // — no codex, no network, unrecognized output — are indistinguishable to the
    // policy, which does nothing in all three cases.
    ok: installed !== null && latest !== null,
    installed,
    latest,
  };
}

async function readInstalledVersion(
  execVersion: (timeoutMs: number) => Promise<string>,
  timeoutMs: number,
): Promise<string | null> {
  try {
    return parseCodexVersionOutput(await execVersion(timeoutMs));
  } catch {
    // ENOENT (codex not installed — the common, expected case), a non-zero exit,
    // or a timeout. All of them mean the same thing here: no installed version.
    return null;
  }
}

async function readLatestVersion(
  fetchDistTags: (timeoutMs: number) => Promise<string>,
  timeoutMs: number,
): Promise<string | null> {
  try {
    return parseDistTagsLatest(await fetchDistTags(timeoutMs));
  } catch {
    return null;
  }
}

/**
 * Pull `latest` out of the dist-tags payload.
 *
 * MEASURED shape (2026-08-05): the document carries ~16 tags — `latest`,
 * per-platform tags (`darwin-arm64: "0.146.0-darwin-arm64"`), and prerelease
 * channels (`alpha: "0.147.0-alpha.10"`). Only `latest` is read, and it must be
 * a bare `x.y.z`; the platform and prerelease tags exist precisely as the
 * reminder that a looser parse would happily hand back a version nobody should
 * be updated to.
 */
export function parseDistTagsLatest(body: string): string | null {
  let payload: unknown;
  try {
    payload = JSON.parse(body);
  } catch {
    return null;
  }
  if (typeof payload !== "object" || payload === null) {
    return null;
  }
  const latest = (payload as Record<string, unknown>).latest;
  if (typeof latest !== "string") {
    return null;
  }
  const parsed = parseVersion(latest);
  return parsed ? `${parsed.major}.${parsed.minor}.${parsed.patch}` : null;
}

function defaultExecVersion(timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      "codex",
      ["--version"],
      { timeout: timeoutMs, encoding: "utf8", env: codexCommandEnv() },
      (error, stdout) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(stdout);
      },
    );
  });
}

async function defaultFetchDistTags(timeoutMs: number): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(CODEX_DIST_TAGS_URL, {
      signal: controller.signal,
      headers: { accept: "application/json" },
    });
    if (!response.ok) {
      throw new Error(`dist-tags HTTP ${response.status}`);
    }
    return await response.text();
  } finally {
    clearTimeout(timer);
  }
}
