export async function approveIfVisible(page, title, timeoutMs) {
  // Match by the approval KIND, not the full title: a Claude broker card's
  // title is the tool SUMMARY ("Edit …/file.md"), not the fixed
  // "<Kind> approval requested" string — but the kind badge
  // (#approval-kind-badge: "File edit" / "Command" / "Workspace trust") is
  // always on the card, so stripping the " approval requested" suffix keeps
  // one matcher that covers scrape cards (Codex, trust) AND broker cards.
  const kindText = title.replace(/ approval requested$/, "");
  const banner = page.locator("#approval-banner", { hasText: kindText });
  try {
    await banner.waitFor({ state: "visible", timeout: timeoutMs });
  } catch {
    return false;
  }

  await approveVisibleBanner(page, banner);
  return true;
}

/**
 * Approve whichever native approval banner is on screen RIGHT NOW, regardless
 * of its title, and report whether one was answered.
 *
 * Codex picks its write mechanism per run — `apply_patch` surfaces as a
 * File-edit banner, a shell write (`printf`/heredoc/`python3 -c`) as a Command
 * banner — so a turn that "just writes a file" can raise EITHER. Draining by
 * visibility (not by a fixed title) is what keeps a wait from stalling on the
 * one banner the test didn't happen to name.
 */
export async function approveAnyVisibleApproval(page) {
  const banner = page.locator("#approval-banner:not(.hidden)");
  const visible = await banner.isVisible({ timeout: 500 }).catch(() => false);
  if (!visible) {
    return false;
  }
  await approveVisibleBanner(page, banner);
  return true;
}

export async function approveVisibleBanner(page, banner) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    await page.locator("#approve-approval").click();
    try {
      await banner.waitFor({ state: "hidden", timeout: 4000 });
      return;
    } catch {
      await page.waitForTimeout(300);
    }
  }

  await banner.waitFor({ state: "hidden", timeout: 30000 }).catch(() => {});
}
