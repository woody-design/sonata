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
  private inFlight: Promise<void> | null = null;
  private pending = 0;
  private disposed = false;

  constructor(options: CliReadinessOptions) {
    this.broadcast = options.broadcast;
    this.probeFacts = options.probe ?? (() => probeCliReadiness());
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
   * The single orchestration point: gate → maybe bust the PATH cache → probe →
   * compare → maybe broadcast. Never rejects.
   *
   * Concurrency has two shapes on purpose. An ordinary caller arriving mid-probe
   * JOINS the in-flight one, so `await probe(...)` always means "a probe has
   * completed" and a focus storm costs one probe. A caller that asked for
   * `bustPathCache` must NOT join: it is asking about a machine that changed
   * since the in-flight probe resolved its PATH, and handing it that probe's
   * answer is precisely the stale `absent` L7 exists to prevent — so it queues
   * behind it instead.
   */
  probe(
    reason: CliReadinessProbeReason,
    options: CliReadinessProbeOptions = {},
  ): Promise<void> {
    if (this.disposed) {
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
   * {@link probe}, against the facts as they stand when the probe starts.
   */
  noteMainWindowFocus(): void {
    void this.probe("focus");
  }

  /** No timers to clear; this only stops an in-flight probe from broadcasting
   *  into a torn-down window set. */
  dispose(): void {
    this.disposed = true;
  }

  private async runProbe(reason: CliReadinessProbeReason, bustPathCache: boolean): Promise<void> {
    if (this.disposed) {
      return;
    }
    // The focus gate (D4), evaluated here rather than at the trigger so it reads
    // the facts as of the moment the probe would run. While something is
    // actionable, coming back to the window is the natural moment to re-check —
    // the user probably just went and fixed it. Once nothing is actionable,
    // focus must cost NOTHING: a healthy machine cannot be allowed to spend two
    // subprocesses every time the window comes forward.
    if (reason === "focus" && !hasUnhealthyCliReadiness(this.facts)) {
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
