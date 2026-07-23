// Shared harness helper: a genuinely pre-trusted codex temp workspace.
//
// Codex pops its directory-trust dialog for any config-unlisted cwd — even
// under explicit `-s`/`-a` flags, and a `-c projects...` CLI override does
// NOT suppress it (probed 0.144.5, spikes/codex-boot-input-window/
// trust-override-probe.mjs). What DOES suppress it is a trust entry in an
// active `-p` profile layer (pretrust-probe.mjs, same spike). So live-CLI
// smokes spawn with a throwaway `sonata-smoke` profile whose ONLY content is
// the trust entry for the smoke's temp workspace: no dialog, no hooks, and —
// critically — no silent trust-grant garbage appended to the user's real
// ~/.codex/config.toml (each answered dialog persists an entry there; the
// pre-rename smokes left dozens).
//
// The profile file is overwritten per host (hosts run sequentially) and
// removed at teardown.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const CODEX_SMOKE_PROFILE = "sonata-smoke";

// Honor CODEX_HOME like the production codexProfilePath (codex reads the
// profile from its actual home; a sandboxed CODEX_HOME run would otherwise
// never see the trust entry).
const profilePath = () =>
  path.join(
    process.env.CODEX_HOME ?? path.join(os.homedir(), ".codex"),
    `${CODEX_SMOKE_PROFILE}.config.toml`,
  );

/** Write the throwaway smoke profile trusting `workspace`. Call before each
 *  codex startTask; safe to call repeatedly (last write wins — hosts are
 *  sequential). */
export function ensureSmokeTrustProfile(workspace) {
  const body =
    `# Sonata smoke-harness profile — throwaway, regenerated per smoke run.\n` +
    `# Only purpose: pre-trust the smoke's temp workspace so the directory\n` +
    `# trust dialog never renders (see codex-smoke-trust.mjs).\n\n` +
    `[projects.${JSON.stringify(path.resolve(workspace))}]\n` +
    `trust_level = "trusted"\n`;
  fs.writeFileSync(profilePath(), body, "utf8");
}

/** Remove the throwaway profile (teardown). */
export function removeSmokeTrustProfile() {
  fs.rmSync(profilePath(), { force: true });
}

// ─── Codex boot "Update available!" TUI — environmental SKIP signal ──────────
//
// When a newer codex release exists, the CLI renders a full-screen
//   Update available! … 1. Update now (runs `brew upgrade --cask codex`) …
//   Press enter to continue
// gate at boot and BLOCKS composer readiness until dismissed — the real app is
// blocked identically (upstream drift; S4 owns the product-side needs-attention
// surfacing). The live-CLI midsession smokes cannot reach the composer while it
// is up, so a readiness failure whose terminal shows THIS signature is
// environmental, not a product regression: the smoke SKIPs (exit 77). Every
// OTHER readiness failure stays a hard FAIL — the match must be specific.

export const CODEX_UPDATE_PROMPT_SKIP_REASON =
  "codex CLI showing update prompt — run `brew upgrade --cask codex` or dismiss";

/** True iff `terminalText` (a cleaned PTY tail) shows codex's boot update gate.
 *  Anchored on the gate's own strings so an unrelated readiness failure that
 *  merely mentions "update" cannot masquerade as this environmental skip. */
export function isCodexUpdatePrompt(terminalText) {
  if (!terminalText) {
    return false;
  }
  return (
    /Update available!/i.test(terminalText) ||
    /\bUpdate now\b/.test(terminalText) ||
    /releases\/latest/i.test(terminalText)
  );
}

/** Thrown to request an environmental SKIP from inside a smoke's try-block so
 *  the finally-block cleanup (host dispose, profile/config restore) still runs
 *  — `process.exit(77)` would bypass it. The catch-block maps this to exit 77. */
export class SmokeSkip extends Error {
  constructor(reason) {
    super(reason);
    this.name = "SmokeSkip";
  }
}
