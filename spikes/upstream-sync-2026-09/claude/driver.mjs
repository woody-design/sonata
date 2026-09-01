// Upstream-sync 2026-09 claude driver — thin fork of the 2026-08 canonical
// driver. ONE behavioral change, measured 2026-09-01 at 2.1.252 (q1 first run):
// the workspace-trust dialog's DEFAULT row flipped to "No, exit" —
//
//   ❯ No, exit
//     Yes, I trust this folder
//
// so the 2026-08 bootTrusted's bare Enter now DECLINES trust and exits the CLI.
// This bootTrusted grid-verifies the "Yes, I trust this folder" row, arrows down
// to it, re-verifies the cursor row, then confirms.
export { Probe, Capture, KEYS, sanitize, sleep } from "../../upstream-sync-2026-08/claude/driver.mjs";
import { Probe, KEYS, sleep } from "../../upstream-sync-2026-08/claude/driver.mjs";

export async function bootTrusted(cwd, cap, { extraArgs = [] } = {}) {
  const p = new Probe({ cwd, args: ["--permission-mode", "default", ...extraArgs] });
  const trust = await p.waitFor(/Quick safety check|trust this folder/i, 45_000);
  if (trust) {
    if (cap) cap.frame(p, "boot — trust dialog (2.1.252 shape: default row is 'No, exit')");
    // Grid-verify the affirm row exists before touching anything.
    if (!/Yes, I trust this folder/i.test(p.screen())) {
      if (cap) cap.add("boot — TRUST DIALOG SHAPE DRIFT", "affirm row 'Yes, I trust this folder' NOT on screen; aborting answer");
    } else {
      // q2 measured an input-arming window after dialog paint: a Down sent at
      // +0ms is swallowed; +500ms registers. Verify-and-retry, never fixed-delay.
      const affirmFocused = () =>
        p.screen().split("\n").some((l) => /❯\s*Yes, I trust this folder/i.test(l));
      let landed = false;
      for (let i = 0; i < 6 && !landed; i++) {
        await sleep(500);
        p.write(KEYS.down);
        await sleep(350);
        landed = affirmFocused();
      }
      if (cap) cap.add("boot — affirm row focused (verify-and-retry)?", String(landed));
      if (landed) {
        p.write(KEYS.enter);
        await sleep(1500);
      }
    }
  }
  const ok = await p.waitFor(/for shortcuts|Welcome back|Try "|>\s*$/i, 60_000);
  if (cap) cap.add("boot — reached composer?", `${ok} (trustDialogSeen=${trust})`);
  await sleep(2500);
  return p;
}
