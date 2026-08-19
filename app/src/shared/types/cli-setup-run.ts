import { CLI_READINESS_PROVIDERS } from "./cli-readiness";
import type { RuntimeProvider } from "./domain";

/**
 * A CLI **setup run** — one Sonata-initiated command the user WATCHES run in the
 * CLI window (CLI readiness S2; plan D7, L7).
 *
 * This is the recovery half of the readiness subsystem. The probe
 * (`main/cli-readiness/probe.ts`) reads the machine; a setup run is the only way
 * Sonata acts on what it read, and it acts by handing the work to the CLI's own
 * installer / first-run screens in a real pty the user can see and type into.
 * Two kinds, one mechanism:
 *
 * - `install` — the provider's official install command (D7). Success is decided
 *   by a re-probe, never by parsing installer output (L7).
 * - `start` — the provider's own LOGIN command (`claude auth login` /
 *   `codex login`; login-run redesign 2026-08-19 — before that, a bare
 *   interactive CLI the user had to know to type `/login` into, and to `/exit`
 *   out of). The one exception: a Claude install whose first-run wizard never
 *   completed gets the bare CLI, whose wizard covers theme and login together —
 *   see `spawnInputFor`. Either way Sonata never reads or scripts the flow's
 *   screens (D1/D2 red line) — which is precisely why this is NOT a
 *   `TerminalHost`: that engine exists to parse a provider TUI, and pointing it
 *   at a login flow would make Sonata a participant in an authentication
 *   ceremony it is forbidden to touch.
 *
 * **At most one run exists at a time**, app-global rather than task-keyed: a setup
 * run is about the machine, not about a conversation, so it has no task, no
 * transcript, no record, and no place in the sidebar. `id` is monotonic for the
 * process lifetime and stamps every message about a run, so a keystroke or a
 * resize aimed at a pty that has since exited can be dropped rather than
 * delivered to its successor.
 */
export type CliSetupRunKind = "install" | "start";

/**
 * Two phases, and the missing third is the design. `running` is live; `failed` is
 * an install that did not produce a working CLI (L7: a non-zero exit OR a
 * re-probe that still reads `absent`). There is no `succeeded`: a run that worked
 * is CLEARED, because the facts now say so and the card reads the facts. Keeping a
 * success around would create a second authority on the same question — one that
 * could disagree with the probe.
 *
 * A `start` run has no failure shape either — kept through the login-run
 * redesign, deliberately. `codex login` documents exit 1 on error, but
 * `claude auth login`'s exit codes are unverified and the bare-CLI onboarding
 * fallback has none at all, so a verdict built on exit codes would be a claim
 * Sonata cannot back for two of the three commands this kind runs. The re-probed
 * facts already answer the only question that matters ("is it logged in NOW"),
 * and an aborted login simply puts the signed-out card back by itself.
 */
export type CliSetupRunPhase = "running" | "failed";

export interface CliSetupRun {
  /** Monotonic within one main-process lifetime; identifies the pty. */
  readonly id: number;
  readonly kind: CliSetupRunKind;
  readonly provider: RuntimeProvider;
  readonly phase: CliSetupRunPhase;
}

/** What a window asks for. Validated in main — a renderer names a KIND and a
 *  PROVIDER, never a command line (D7 owns the command strings). */
export interface CliSetupRunRequest {
  readonly kind: CliSetupRunKind;
  readonly provider: RuntimeProvider;
}

/**
 * The pull payload: the run plus everything it has printed so far.
 *
 * The buffer is not a convenience. The CLI window may be created *by* the start
 * request (it opens to host the run) and may be closed and reopened while an
 * install continues, so "follow along in the terminal window" would be a lie the
 * first time either happens without replay. `outputSeq` is the seq of the last
 * chunk already inside `output`, so a window can hydrate and then splice the live
 * chunks that raced its read without duplicating or dropping any.
 */
export interface CliSetupRunSnapshot {
  readonly run: CliSetupRun | null;
  readonly output: string;
  readonly outputSeq: number;
}

/** One coalesced chunk of a run's output. */
export interface CliSetupRunData {
  readonly id: number;
  /** Monotonic within one run, starting at 1. */
  readonly seq: number;
  readonly data: string;
}

/** A keystroke the CLI window forwards into the run's pty — the whole reason the
 *  run is a pty rather than a piped child: a sudo password prompt, an installer
 *  confirm, or a CLI login screen has to be answerable. */
export interface CliSetupRunInputRequest {
  readonly id: number;
  readonly data: string;
}

export interface CliSetupRunResizeRequest {
  readonly id: number;
  readonly cols: number;
  readonly rows: number;
}

const KINDS: readonly CliSetupRunKind[] = ["install", "start"];
/** Borrowed from the readiness fact shape rather than respelled: that list is
 *  DERIVED from a type mapped over `RuntimeProvider`, so a third provider is a
 *  compile error at one object literal and every consumer — including this
 *  validator — picks it up with no edit. Same subsystem, one roster. */
const PROVIDERS = CLI_READINESS_PROVIDERS;

/** Boundary validation for the push payload (the `isCliReadinessFacts`
 *  convention): a garbled message can never reach a consumer as a run. */
export function isCliSetupRunState(value: unknown): value is CliSetupRun | null {
  return value === null || isCliSetupRun(value);
}

export function isCliSetupRun(value: unknown): value is CliSetupRun {
  if (!isRecord(value) || Object.keys(value).length !== 4) {
    return false;
  }
  return (
    typeof value.id === "number" &&
    Number.isInteger(value.id) &&
    value.id > 0 &&
    isKind(value.kind) &&
    isProvider(value.provider) &&
    (value.phase === "running" || value.phase === "failed")
  );
}

export function isCliSetupRunSnapshot(value: unknown): value is CliSetupRunSnapshot {
  if (!isRecord(value)) {
    return false;
  }
  return (
    isCliSetupRunState(value.run) &&
    typeof value.output === "string" &&
    typeof value.outputSeq === "number" &&
    Number.isInteger(value.outputSeq) &&
    value.outputSeq >= 0
  );
}

export function isCliSetupRunData(value: unknown): value is CliSetupRunData {
  if (!isRecord(value)) {
    return false;
  }
  return (
    typeof value.id === "number" &&
    typeof value.seq === "number" &&
    Number.isInteger(value.seq) &&
    value.seq > 0 &&
    typeof value.data === "string"
  );
}

/** Main-side validation of a renderer request. */
export function isCliSetupRunRequest(value: unknown): value is CliSetupRunRequest {
  return isRecord(value) && isKind(value.kind) && isProvider(value.provider);
}

export function isCliSetupRunInputRequest(value: unknown): value is CliSetupRunInputRequest {
  return isRecord(value) && typeof value.id === "number" && typeof value.data === "string";
}

export function isCliSetupRunResizeRequest(value: unknown): value is CliSetupRunResizeRequest {
  return (
    isRecord(value) &&
    typeof value.id === "number" &&
    typeof value.cols === "number" &&
    typeof value.rows === "number"
  );
}

function isKind(value: unknown): value is CliSetupRunKind {
  return typeof value === "string" && KINDS.includes(value as CliSetupRunKind);
}

function isProvider(value: unknown): value is RuntimeProvider {
  return typeof value === "string" && PROVIDERS.includes(value as RuntimeProvider);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
