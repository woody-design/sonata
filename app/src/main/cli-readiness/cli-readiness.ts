import {
  UNKNOWN_CLI_READINESS_FACTS,
  cliReadinessFactsEqual,
  hasUnhealthyCliReadiness,
  type CliReadinessFacts,
} from "../../shared/types/cli-readiness";
import { bustLoginShellPathCache } from "./cli-env";
import { probeCliReadiness } from "./probe";

/**
 * Holds the CLI readiness facts and decides when to refresh them (CLI readiness
 * S1; plan D4/L6/L7).
 *
 * What this controller does NOT have is the design:
 *
 * - **No timers, no polling.** Every refresh is an event someone caused: the
 *   window finished loading, the user came back to the window while something is
 *   broken, a later slice finished an install or a login. Readiness is not a
 *   quantity that drifts on its own — it changes when a person changes it — so a
 *   clock would spend a subprocess per tick to re-learn the same fact.
 * - **No persistence.** The facts live in this object and nowhere else. A cached
 *   readiness fact read at the next launch would be a claim about a machine we
 *   have not looked at yet, and the probe that would validate it costs ~50ms
 *   (MEASURED). Nothing on disk means nothing to invalidate, migrate, or
 *   contradict.
 * - **No per-trigger logic.** All three triggers land on {@link probe}, which is
 *   also where every condition — the focus gate, the change compare — is
 *   evaluated. A trigger only says "now may be a good time", the cli-updater's
 *   `runCycle` convention.
 *
 * Every effect is an injected seam, so the whole controller drives from plain
 * node with no subprocesses and no Electron.
 */

/** Why a probe ran. `focus` is the only reason that can decline to probe (D4);
 *  the others always do. Also the log's subject. */
export type CliReadinessProbeReason = "launch" | "focus" | "reprobe";

export interface CliReadinessOptions {
  /** Push the changed facts to every window. main owns the fan-out — the
   *  `UpdaterController` / `sendEvent` convention, and it keeps this controller
   *  free of `BrowserWindow`. */
  readonly broadcast: (facts: CliReadinessFacts) => void;
  readonly probe?: () => Promise<CliReadinessFacts>;
  readonly bustPathCache?: () => void;
  readonly log?: (message: string) => void;
}

export interface CliReadinessProbeOptions {
  /**
   * Discard the cached login-shell PATH before probing (L7). Required by a
   * re-probe that follows an install: both official installers edit the user's
   * shell profile, so the PATH captured at launch is stale at exactly that
   * moment, and a stale read would report `absent` for a CLI that installed fine.
   */
  readonly bustPathCache?: boolean;
}

export class CliReadiness {
  private readonly broadcast: (facts: CliReadinessFacts) => void;
  private readonly probeFacts: () => Promise<CliReadinessFacts>;
  private readonly bustPathCache: () => void;
  private readonly log: (message: string) => void;

  private facts: CliReadinessFacts = UNKNOWN_CLI_READINESS_FACTS;
  /**
   * Claude's transcript root, as the CLI reported it on the last probe (D2 U2 /
   * F2). Held here rather than in `facts` because it is not a readiness fact: it
   * never crosses IPC, no renderer reads it, and it must not participate in the
   * change compare that gates the broadcast. Null until a probe has read one —
   * and null is a legitimate steady state (see the getter).
   */
  private claudeProjectsDir: string | null = null;
  private inFlight: Promise<void> | null = null;
  private pending = 0;
  private disposed = false;

  constructor(options: CliReadinessOptions) {
    this.broadcast = options.broadcast;
    // The details channel rides the DEFAULT probe only. An injected probe (the
    // smokes) observes nothing and the cache stays null, which is the same
    // correct degradation as a machine whose CLI never answered.
    this.probeFacts =
      options.probe ??
      (() =>
        probeCliReadiness({
          observe: (details) => {
            this.claudeProjectsDir = details.claudeProjectsDirectory;
          },
        }));
    this.bustPathCache = options.bustPathCache ?? bustLoginShellPathCache;
    this.log = options.log ?? ((message) => console.log(`[cli-readiness] ${message}`));
  }

  /** The current facts — served on the pull channel so a window created (or a
   *  listener attached) after a change still hydrates to the truth. Starts as
   *  all-`unknown`, which is the permissive state: a renderer that reads before
   *  the first probe lands shows nothing rather than guessing. */
  read(): CliReadinessFacts {
    return this.facts;
  }

  /**
   * Where Claude keeps its transcripts, straight from `claude auth status
   * --json` — the one operational fact this controller's probe already fetches
   * and nothing used to read (D2 U2 / F2). Null before the first probe lands,
   * and on any machine whose CLI did not answer; the caller then derives the
   * path, which is what Sonata did unconditionally until now.
   *
   * Pull-only and deliberately silent: no event, no broadcast, no place in the
   * change compare. A path that moves is not news to anyone — the next locate
   * simply uses the current answer.
   */
  claudeProjectsDirectory(): string | null {
    return this.claudeProjectsDir;
  }

  /**
   * The single orchestration point: gate → maybe bust the PATH cache → probe →
   * compare → maybe broadcast. Never rejects.
   *
   * Concurrency has two shapes on purpose. An ordinary caller arriving mid-probe
   * JOINS the in-flight one, so `await probe(...)` means "a probe has completed"
   * and a focus storm costs one probe. A caller that asked for `bustPathCache`
   * must NOT join: it is asking about a machine that changed since the in-flight
   * probe resolved its PATH, and handing it that probe's answer is precisely the
   * stale `absent` L7 exists to prevent — so it queues behind it instead.
   *
   * The focus gate runs FIRST, before this call can take the join slot, and that
   * ordering is load-bearing rather than incidental: a declined probe that had
   * already published itself into `inFlight` would be joined by the next ordinary
   * caller, which would then resolve having executed nothing. The declining
   * trigger would silently eat someone else's probe.
   */
  probe(
    reason: CliReadinessProbeReason,
    options: CliReadinessProbeOptions = {},
  ): Promise<void> {
    if (this.disposed) {
      return Promise.resolve();
    }
    // The focus gate (D4). While something is actionable, coming back to the
    // window is the natural moment to re-check — the user probably just went and
    // fixed it. Once nothing is actionable, focus must cost NOTHING: no
    // subprocess, no log line, and (see above) no join slot.
    if (reason === "focus" && !hasUnhealthyCliReadiness(this.facts)) {
      return Promise.resolve();
    }
    const bustPathCache = options.bustPathCache === true;
    if (this.inFlight !== null && !bustPathCache) {
      return this.inFlight;
    }
    this.pending += 1;
    const tracked = (this.inFlight ?? Promise.resolve())
      .then(() => this.runProbe(reason, bustPathCache))
      .finally(() => {
        this.pending -= 1;
        if (this.pending === 0) {
          this.inFlight = null;
        }
      });
    this.inFlight = tracked;
    return tracked;
  }

  /**
   * The programmatic trigger later slices call (L7) — after an install pty exits,
   * after a login pty exits. A named entry point rather than a raw `probe` reason
   * so callers outside this module state their intent instead of picking a log
   * label, and so the PATH-cache option is documented where they will find it.
   */
  reprobe(options: CliReadinessProbeOptions = {}): Promise<void> {
    return this.probe("reprobe", options);
  }

  /**
   * The main window was focused (D4). Fire-and-forget — a window activation must
   * never wait on a subprocess. Whether it probes at all is decided inside
   * {@link probe}, against the facts as they stand at the moment of the focus.
   */
  noteMainWindowFocus(): void {
    void this.probe("focus");
  }

  /** No timers to clear; this only stops an in-flight probe from broadcasting
   *  into a torn-down window set. */
  dispose(): void {
    this.disposed = true;
  }

  /**
   * Carries NO gate of its own. The focus decision lives at {@link probe}'s front
   * door, and re-checking it here would be dead code rather than defence in
   * depth: a `focus` reason only reaches this method when `inFlight` was null at
   * call time (a focus trigger never queues — only a bust caller does), and
   * nothing can write `facts` between that check and this microtask, because
   * nothing was running.
   */
  private async runProbe(reason: CliReadinessProbeReason, bustPathCache: boolean): Promise<void> {
    if (this.disposed) {
      return;
    }
    try {
      if (bustPathCache) {
        this.bustPathCache();
      }
      const facts = await this.probeFacts();
      if (this.disposed) {
        return;
      }
      // Every probe narrates (the cli-updater cycle convention — a subsystem
      // whose triggers are invisible needs a log that is not); only a CHANGE
      // reaches the renderer. Without that gate every window focus on a broken
      // machine would repaint a card that says exactly what it already said.
      const changed = !cliReadinessFactsEqual(facts, this.facts);
      this.log(`probe(${reason}): ${describeFacts(facts)}${changed ? "" : " (unchanged)"}`);
      if (!changed) {
        return;
      }
      this.facts = facts;
      this.broadcast(facts);
    } catch (error) {
      // A probe is background observation. It logs and dies; the facts keep
      // whatever they last knew, and the next trigger tries again.
      this.log(`probe(${reason}) failed: ${describe(error)}`);
    }
  }
}

function describeFacts(facts: CliReadinessFacts): string {
  return (
    `claude=${facts.claude.install}/${facts.claude.auth} ` +
    `codex=${facts.codex.install}/${facts.codex.auth}`
  );
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
