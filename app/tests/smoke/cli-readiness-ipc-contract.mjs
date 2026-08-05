import assert from "node:assert/strict";

// Contract fence for the CLI readiness IPC surface (S1, L6): the channel names,
// the payload shape, and the two predicates every consumer will branch on are
// test API. The status card (S2) and the continue-chat banner (S4) bind to
// exactly these — a rename or a widened shape is a breaking change and must fail
// here loudly rather than at some renderer's runtime.
//
// It also pins the ONE invariant the whole design rests on: `unknown` is
// permissive. `hasUnhealthyCliReadiness` must answer false for every
// combination of unknowns, and true only for `absent` / `signedOut`.

const { IPC_CHANNELS } = await import("../../dist/shared/types/ipc.js");
const {
  CLI_READINESS_PROVIDERS,
  UNKNOWN_CLI_PROVIDER_READINESS,
  UNKNOWN_CLI_READINESS_FACTS,
  cliReadinessFactsEqual,
  hasUnhealthyCliReadiness,
  isCliProviderReadiness,
  isCliProviderUnhealthy,
  isCliReadinessFacts,
} = await import("../../dist/shared/types/cli-readiness.js");

const facts = (claude, codex) => ({ claude, codex });
const fact = (install, auth) => ({ install, auth });

// 1) Channel names are frozen (L6).
assert.equal(IPC_CHANNELS.cliReadinessRead, "cli-readiness:read");
assert.equal(IPC_CHANNELS.cliReadinessChanged, "cli-readiness:changed");

// 2) The provider list every helper iterates is DERIVED from the mapped-type
//    constant, not spelled out three times. Pinned here because that derivation
//    is what makes the type's exhaustiveness claim true of the helpers too: the
//    keys must be exactly the fact set's keys, or a future provider would be
//    validated and compared by nobody (review F4).
assert.deepEqual(
  [...CLI_READINESS_PROVIDERS].sort(),
  Object.keys(UNKNOWN_CLI_READINESS_FACTS).sort(),
  "the iterated list is the fact set's own key set",
);
assert.deepEqual([...CLI_READINESS_PROVIDERS].sort(), ["claude", "codex"]);

// 3) The pre-probe constant is the permissive nothing-known payload.
assert.deepEqual(UNKNOWN_CLI_PROVIDER_READINESS, { install: "unknown", auth: "unknown" });
assert.deepEqual(UNKNOWN_CLI_READINESS_FACTS, {
  claude: { install: "unknown", auth: "unknown" },
  codex: { install: "unknown", auth: "unknown" },
});
assert.equal(isCliReadinessFacts(UNKNOWN_CLI_READINESS_FACTS), true);
assert.equal(
  hasUnhealthyCliReadiness(UNKNOWN_CLI_READINESS_FACTS),
  false,
  "knowing nothing is never actionable",
);

// 4) Payload validation — every state passes, nothing else does.
for (const install of ["present", "absent", "unknown"]) {
  for (const auth of ["signedIn", "signedOut", "unknown"]) {
    assert.equal(isCliProviderReadiness(fact(install, auth)), true, `${install}/${auth}`);
    assert.equal(isCliReadinessFacts(facts(fact(install, auth), fact(install, auth))), true);
  }
}
assert.equal(isCliProviderReadiness({ install: "present" }), false, "both axes required");
assert.equal(
  isCliProviderReadiness({ install: "present", auth: "signedIn", extra: 1 }),
  false,
  "no extra keys",
);
assert.equal(isCliProviderReadiness({ install: "installed", auth: "signedIn" }), false);
assert.equal(isCliProviderReadiness({ install: "present", auth: "yes" }), false);
assert.equal(isCliProviderReadiness(null), false);
assert.equal(isCliProviderReadiness("present"), false);
assert.equal(isCliProviderReadiness([]), false);

assert.equal(isCliReadinessFacts({ claude: fact("present", "signedIn") }), false, "codex required");
assert.equal(
  isCliReadinessFacts({
    claude: fact("present", "signedIn"),
    codex: fact("present", "signedIn"),
    gemini: fact("present", "signedIn"),
  }),
  false,
  "no third provider smuggled through",
);
assert.equal(isCliReadinessFacts(null), false);

// 5) Equality — the change event's gate. Identical facts must be silent.
assert.equal(
  cliReadinessFactsEqual(
    facts(fact("present", "signedIn"), fact("absent", "unknown")),
    facts(fact("present", "signedIn"), fact("absent", "unknown")),
  ),
  true,
);
assert.equal(
  cliReadinessFactsEqual(
    facts(fact("present", "signedIn"), fact("absent", "unknown")),
    facts(fact("present", "signedOut"), fact("absent", "unknown")),
  ),
  false,
  "an auth change on one provider is a change",
);
assert.equal(
  cliReadinessFactsEqual(
    facts(fact("present", "signedIn"), fact("absent", "unknown")),
    facts(fact("present", "signedIn"), fact("present", "unknown")),
  ),
  false,
  "an install change on the other provider is a change",
);
assert.equal(
  cliReadinessFactsEqual(UNKNOWN_CLI_READINESS_FACTS, facts(fact("unknown", "unknown"), fact("unknown", "unknown"))),
  true,
  "equality is structural, not by reference",
);

// 6) The actionable predicate — the whole permissive rule, one table.
//    Actionable ⟺ install absent OR auth signedOut. Nothing else, and above all
//    NOT `unknown` on either axis (D3): the spawn path is the final truth, so a
//    fact we could not read must never produce a card.
const unhealthyTable = [
  [fact("present", "signedIn"), false],
  [fact("present", "unknown"), false],
  [fact("unknown", "unknown"), false],
  [fact("unknown", "signedIn"), false],
  [fact("absent", "unknown"), true],
  [fact("absent", "signedOut"), true],
  [fact("present", "signedOut"), true],
  [fact("unknown", "signedOut"), true],
];
for (const [candidate, expected] of unhealthyTable) {
  assert.equal(
    isCliProviderUnhealthy(candidate),
    expected,
    `${candidate.install}/${candidate.auth} → ${expected}`,
  );
}

// …and it lifts to the pair as "any provider".
const healthy = fact("present", "signedIn");
assert.equal(hasUnhealthyCliReadiness(facts(healthy, healthy)), false);
assert.equal(hasUnhealthyCliReadiness(facts(fact("absent", "unknown"), healthy)), true);
assert.equal(hasUnhealthyCliReadiness(facts(healthy, fact("present", "signedOut"))), true);
assert.equal(
  hasUnhealthyCliReadiness(facts(fact("unknown", "unknown"), fact("present", "unknown"))),
  false,
  "a wholly unreadable machine is silent, not broken",
);

console.log(JSON.stringify({ success: true }, null, 2));
