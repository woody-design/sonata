import type { RuntimeProvider } from "./domain";

/**
 * CLI readiness facts — what Sonata has OBSERVED about the user's own CLIs, per
 * provider (CLI readiness S1; plan D3/L6).
 *
 * Sonata is a GUI over CLIs it neither ships nor manages, so readiness is an
 * observation, never a guarantee. Two axes, three states each — and the third
 * state is the load-bearing one: **`unknown` is PERMISSIVE**. It must never be
 * folded into `absent`/`signedOut`. The pty spawn is the final truth; a silent
 * false negative (we say nothing and the spawn works) costs far less than a
 * false alarm (we claim the CLI is missing while the user's own terminal runs it
 * fine). Every failure mode of the probe — timeout, unrecognized output, a
 * subcommand a future CLI dropped — therefore lands on `unknown`, and only two
 * facts are actionable: `absent` (nothing to spawn) and `signedOut` (a spawn
 * would hang on a first-run screen nobody sees).
 *
 * This shape is the ONLY readiness payload that crosses IPC, and it is
 * deliberately free of timestamps, versions, and probe diagnostics: the change
 * event fires on a deep compare, so any field that moves on every probe would
 * turn "the facts changed" into "we probed again". What the renderer needs is
 * the current fact, not its provenance.
 */
export type CliInstallState = "present" | "absent" | "unknown";

/** Whether the CLI is signed in. `unknown` whenever the CLI did not answer in a
 *  shape we recognize — see the permissive rule above. */
export type CliAuthState = "signedIn" | "signedOut" | "unknown";

export interface CliProviderReadiness {
  readonly install: CliInstallState;
  readonly auth: CliAuthState;
}

/** Mapped over `RuntimeProvider` on purpose: a third provider becomes a compile
 *  error at every construction site rather than a silently missing fact — and the
 *  helpers below iterate a list DERIVED from that mapping, so they pick a new
 *  provider up without an edit (see {@link CLI_READINESS_PROVIDERS}). */
export type CliReadinessFacts = {
  readonly [Provider in RuntimeProvider]: CliProviderReadiness;
};

/** Knowing nothing — the pre-probe state, and the state a hostile environment
 *  degrades to. Permissive by construction (see the `unknown` rule above), so a
 *  window that hydrates before the first probe lands shows nothing rather than
 *  guessing. */
export const UNKNOWN_CLI_PROVIDER_READINESS: CliProviderReadiness = {
  install: "unknown",
  auth: "unknown",
};

export const UNKNOWN_CLI_READINESS_FACTS: CliReadinessFacts = {
  claude: UNKNOWN_CLI_PROVIDER_READINESS,
  codex: UNKNOWN_CLI_PROVIDER_READINESS,
};

/**
 * The providers a fact set covers — exhaustive by CONSTRUCTION, not by
 * discipline. Derived from the mapped-type constant above, so the single place a
 * third `RuntimeProvider` fails to compile is that one object literal, and every
 * helper below then covers the new provider with no edit at all. (Spelling
 * `["claude", "codex"] as const satisfies readonly RuntimeProvider[]` inline —
 * the house idiom elsewhere — checks membership but NOT exhaustiveness, so three
 * copies of it would each need finding and updating by hand.)
 *
 * The cast is sound for exactly the reason the derivation works: the object's
 * type has one key per provider and nothing else.
 */
export const CLI_READINESS_PROVIDERS = Object.keys(
  UNKNOWN_CLI_READINESS_FACTS,
) as readonly RuntimeProvider[];

/** Boundary validation for the IPC payload — the contract fence pins the shape,
 *  and a garbled push can never reach a consumer as a valid fact. */
export function isCliReadinessFacts(value: unknown): value is CliReadinessFacts {
  if (!isRecord(value) || Object.keys(value).length !== CLI_READINESS_PROVIDERS.length) {
    return false;
  }
  return CLI_READINESS_PROVIDERS.every((provider) => isCliProviderReadiness(value[provider]));
}

export function isCliProviderReadiness(value: unknown): value is CliProviderReadiness {
  if (!isRecord(value) || Object.keys(value).length !== 2) {
    return false;
  }
  return (
    (value.install === "present" || value.install === "absent" || value.install === "unknown") &&
    (value.auth === "signedIn" || value.auth === "signedOut" || value.auth === "unknown")
  );
}

/** Whether two fact sets are indistinguishable. The change event's whole gate:
 *  a re-probe that learns the same thing must be silent, or every trigger would
 *  become a renderer repaint. */
export function cliReadinessFactsEqual(a: CliReadinessFacts, b: CliReadinessFacts): boolean {
  return CLI_READINESS_PROVIDERS.every(
    (provider) =>
      a[provider].install === b[provider].install && a[provider].auth === b[provider].auth,
  );
}

/**
 * Whether a fact is ACTIONABLE — the provider cannot serve a session AND Sonata
 * has something honest to say about it. Exactly two readings qualify: `absent`
 * and `signedOut`. `unknown` on either axis does not, which is the permissive
 * rule and not an omission.
 *
 * The two are an OR, not a priority order — which of the two to SAY is the
 * card's decision (absent before signedOut), not this predicate's. Note the
 * probe cannot produce `absent` + `signedOut` together: it only asks about auth
 * over a binary it has confirmed, so a provider it could not find always reads
 * `absent`/`unknown`.
 */
export function isCliProviderUnhealthy(fact: CliProviderReadiness): boolean {
  return fact.install === "absent" || fact.auth === "signedOut";
}

/** Whether ANY provider is actionable — the focus re-probe's gate (D4): while
 *  something is broken a window focus is worth a fresh look, and once nothing
 *  is, focus must cost nothing at all. */
export function hasUnhealthyCliReadiness(facts: CliReadinessFacts): boolean {
  return CLI_READINESS_PROVIDERS.some((provider) => isCliProviderUnhealthy(facts[provider]));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
