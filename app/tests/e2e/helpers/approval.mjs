export async function approveIfVisible(page, title, timeoutMs) {
  const banner = page.locator("#approval-banner", { hasText: title });
  try {
    await banner.waitFor({ state: "visible", timeout: timeoutMs });
  } catch {
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
