// Codex CLI auto-update S2 — the suppress flag at the codexArgs seam.
//
// When Sonata owns keeping Codex current, Codex's own boot "Update available!"
// prompt would be a second voice asking the same question, so the spawn carries
// `-c check_for_update_on_startup=false`. Two things about that flag are exact
// and easy to get subtly wrong, so both are pinned here:
//
//   1. The value is a BARE TOML boolean. The key is `Option<bool>`; a quoted
//      "false" fails to deserialize and the popup would silently return.
//   2. It is emitted ONLY when asked. The default spawn must be byte-identical
//      to what it was before this feature existed — Sonata never touches the
//      user's own ~/.codex/config.toml, and a spawn it does not own must leave
//      codex's prompt entirely alone.

import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { codexArgs } = require("../../dist/runtime");

const results = {};
const CWD = "/tmp/sonata update flag";
const base = { cwd: CWD, permissionMode: "ask-for-approval" };

/** Index of an exact `-c <value>` pair, or -1. */
function configPairIndex(argv, value) {
  return argv.findIndex((token, i) => token === "-c" && argv[i + 1] === value);
}

const FLAG = "check_for_update_on_startup=false";

// 1) Off by default — and off is byte-for-byte the pre-feature argv.
{
  const argv = codexArgs(base);
  assert.equal(configPairIndex(argv, FLAG), -1, "unset → no flag");
  assert.equal(
    argv.some((token) => token.includes("check_for_update_on_startup")),
    false,
    "…not under any spelling",
  );
  assert.deepEqual(
    codexArgs({ ...base, suppressUpdatePrompt: false }),
    argv,
    "explicit false is identical to unset",
  );
  results.default = "no flag";
}

// 2) On → exactly one `-c check_for_update_on_startup=false` pair.
{
  const argv = codexArgs({ ...base, suppressUpdatePrompt: true });
  const index = configPairIndex(argv, FLAG);
  assert.ok(index >= 0, `flag emitted (argv: ${argv.join(" ")})`);
  assert.equal(
    argv.filter((token) => token === FLAG).length,
    1,
    "exactly one — a duplicated -c is a codex parse error, not a no-op",
  );

  // THE spelling assertion: bare `false`, never a quoted TOML string.
  assert.equal(argv[index], "-c", "carried as a -c override");
  assert.equal(argv[index + 1], FLAG, "value is the bare key=false pair");
  assert.equal(
    argv.includes('check_for_update_on_startup="false"'),
    false,
    "NOT a TOML string — a quoted bool fails to deserialize and the popup returns",
  );
  results.suppressed = FLAG;
}

// 3) The flag is additive: it displaces nothing else the spawn carries.
{
  const rich = {
    ...base,
    permissionMode: "full-access",
    model: "gpt-5.6-sol",
    reasoningEffort: "high",
    speedMode: "fast",
    profile: "sonata",
    resumeRef: "01JABCDEF",
  };
  const without = codexArgs(rich);
  const withFlag = codexArgs({ ...rich, suppressUpdatePrompt: true });

  assert.deepEqual(
    withFlag.filter((token) => token !== FLAG && token !== "-c"),
    without.filter((token) => token !== "-c"),
    "every non `-c` token is unchanged",
  );
  assert.equal(withFlag.length, without.length + 2, "adds exactly one -c pair");
  // Resume subcommand stays first — the flag must not push it out of position.
  assert.deepEqual(withFlag.slice(0, 2), ["resume", "01JABCDEF"], "resume stays the head");
  // The permission tail stays the tail (codex-permission-mode-args pins it).
  assert.deepEqual(withFlag.slice(-8), without.slice(-8), "the permission tail is untouched");
  results.additive = "one -c pair, nothing displaced";
}

// 4) It rides the same `-c` accumulator as the other overrides, so a spawn can
//    carry all of them at once without them interfering.
{
  const argv = codexArgs({
    ...base,
    reasoningEffort: "high",
    speedMode: "fast",
    suppressUpdatePrompt: true,
  });
  assert.ok(configPairIndex(argv, 'model_reasoning_effort="high"') >= 0, "effort override survives");
  assert.ok(configPairIndex(argv, 'service_tier="priority"') >= 0, "speed override survives");
  assert.ok(configPairIndex(argv, FLAG) >= 0, "and so does the update flag");
  results.coexists = "effort + speed + update flag";
}

console.log(JSON.stringify({ success: true, results }, null, 2));
process.exitCode = 0;
