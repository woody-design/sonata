/**
 * The ONE scrub applied to every environment Sonata hands a `claude` child —
 * the pty spawn (`terminal-host`'s `ptyEnvironment`) and the readiness setup run
 * (`cli-readiness/setup-run`'s `setupRunEnv`). Two call sites, one rule, so they
 * cannot drift (they had: the same comment in both places, maintained by hand).
 *
 * WHAT GOES, AND WHY:
 *
 *  - `CLAUDECODE` and every `CLAUDE_CODE_*` key — the NESTED-SESSION markers a
 *    Claude Code session exports to its children. A `claude` that sees them
 *    registers NO `~/.claude/sessions/<pid>.json`, so the waitingFor side channel
 *    goes dark (research 2026-06-12 §4.2). Sonata is routinely launched from
 *    inside a Claude Code session during development; a Dock-launched Sonata
 *    inherits none of these.
 *
 *  - `CLAUDE_EFFORT`, `CLAUDE_PID`, `CLAUDE_PLUGIN_DATA` — three more keys a
 *    parent Claude Code session exports that the `CLAUDE_CODE_` prefix does not
 *    catch (D2 U5, 2026-09-03; F70/F95). STATIC basis: all three are read by the
 *    2.1.258 binary (`grep -ac` over `claude.exe`: 9 / 6 / 11 matching lines).
 *    The measured basis for scrubbing them is upstream-sync 2026-09 U1's probe
 *    `m1-default-model-channel.mjs`, which had to delete them from its OWN env to
 *    get a clean read of the boot banner's effort segment; this moves that harness
 *    knowledge into the product so a dev-launched Sonata spawns the same shape a
 *    Dock-launched one does. What `CLAUDE_EFFORT` DOES to a session is NOT
 *    measured and not claimed here — only that the binary reads it and that a
 *    Sonata child should never receive a parent session's value for it.
 *
 * WHAT STAYS: `CLAUDE_CONFIG_DIR` — user-owned configuration, not a marker. A
 * user who redirected their config directory must have Sonata's sessions land in
 * it too (the session-locator reads the same variable).
 *
 * Mutates and returns `env`. Callers overlay their own additions AFTER this call
 * (`extraEnv`, `TERM`, PATH merges) — the scrub is a filter on what was
 * inherited, never on what Sonata sets deliberately.
 */
const SCRUBBED_EXACT_KEYS = ["CLAUDECODE", "CLAUDE_EFFORT", "CLAUDE_PID", "CLAUDE_PLUGIN_DATA"] as const;
const SCRUBBED_PREFIX = "CLAUDE_CODE_";

export function scrubClaudeNestingEnv<T extends NodeJS.ProcessEnv>(env: T): T {
  for (const key of SCRUBBED_EXACT_KEYS) {
    delete env[key];
  }
  for (const key of Object.keys(env)) {
    if (key.startsWith(SCRUBBED_PREFIX)) {
      delete env[key];
    }
  }
  return env;
}
