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
