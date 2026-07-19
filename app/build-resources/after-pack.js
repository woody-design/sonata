// electron-builder afterPack hook — Tahoe (macOS 26) Liquid-Glass app icon.
//
// A legacy-metrics .icns (art at ~80% canvas + margin + shadow) gets dropped
// into Tahoe's gray "squircle jail". The fix is Apple's dual-asset model,
// selected per-OS from one Info.plist:
//   - pre-Tahoe reads CFBundleIconFile  → our hand-built legacy `icon.icns`
//     (already wired by electron-builder from `mac.icon`), and
//   - Tahoe reads   CFBundleIconName    → `Assets.car`, which we add here by
//     compiling the Icon Composer `Sonata.icon` package with `actool`.
//
// We deliberately DO NOT use actool's auto-derived .icns (it comes out
// full-bleed / no legacy margin — oversized on pre-Tahoe). We keep only its
// Assets.car and leave CFBundleIconFile pointing at our hand-built icon.icns.
//
// This hook runs after the app is packed but BEFORE codesign, so the
// signature seals Assets.car. It requires full Xcode (actool lives in
// Xcode.app, not the Command Line Tools) and Xcode 26+ for `.icon` compilation.
//
// Failure policy: fail LOUD by default — a silent gray-box icon on the daily
// driver is worse than a visible build error. Escape hatch
// SONATA_SKIP_TAHOE_ICON=1 skips this step (icns-only, pre-Tahoe-correct,
// gray-boxed on Tahoe) so a human blocked by an actool/Xcode regression can
// still build without editing config.

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const APP_ICON_NAME = "Sonata"; // becomes CFBundleIconName; must match --app-icon

module.exports = async function afterPack(context) {
  if (context.electronPlatformName !== "darwin") {
    return;
  }

  if (process.env.SONATA_SKIP_TAHOE_ICON === "1") {
    console.log("  • Tahoe icon: SKIPPED (SONATA_SKIP_TAHOE_ICON=1) — icns-only");
    return;
  }

  const iconPackage = path.join(__dirname, "Sonata.icon");
  if (!fs.existsSync(iconPackage)) {
    throw new Error(
      `afterPack(Tahoe icon): Icon Composer package not found at ${iconPackage}. ` +
        `Restore it or set SONATA_SKIP_TAHOE_ICON=1 to build icns-only.`,
    );
  }

  const appName = `${context.packager.appInfo.productFilename}.app`;
  const resourcesDir = path.join(context.appOutDir, appName, "Contents", "Resources");
  const infoPlist = path.join(context.appOutDir, appName, "Contents", "Info.plist");

  const compileDir = fs.mkdtempSync(path.join(os.tmpdir(), "sonata-actool-"));
  try {
    // Compile the .icon → Assets.car (+ an auto .icns we discard) via actool.
    execFileSync(
      "xcrun",
      [
        "actool",
        iconPackage,
        "--compile",
        compileDir,
        "--app-icon",
        APP_ICON_NAME,
        "--include-all-app-icons",
        "--enable-on-demand-resources",
        "NO",
        "--development-region",
        "en",
        "--target-device",
        "mac",
        "--platform",
        "macosx",
        "--minimum-deployment-target",
        "26.0",
        "--output-partial-info-plist",
        path.join(compileDir, "partial.plist"),
      ],
      { stdio: ["ignore", "pipe", "pipe"] },
    );

    const assetsCar = path.join(compileDir, "Assets.car");
    if (!fs.existsSync(assetsCar)) {
      throw new Error(
        `afterPack(Tahoe icon): actool produced no Assets.car in ${compileDir}. ` +
          `This is the actool/Xcode regression class — verify \`xcrun actool\`, ` +
          `or set SONATA_SKIP_TAHOE_ICON=1 to build icns-only.`,
      );
    }

    // Place Assets.car in Resources (keep our own icon.icns for CFBundleIconFile).
    fs.copyFileSync(assetsCar, path.join(resourcesDir, "Assets.car"));

    // Wire CFBundleIconName → Assets.car for Tahoe. Insert, or replace if a
    // prior run already set it. CFBundleIconFile stays as electron-builder set
    // it (our hand-built icon.icns), so pre-Tahoe is unaffected.
    try {
      execFileSync(
        "plutil",
        ["-insert", "CFBundleIconName", "-string", APP_ICON_NAME, infoPlist],
        { stdio: ["ignore", "pipe", "pipe"] },
      );
    } catch {
      execFileSync(
        "plutil",
        ["-replace", "CFBundleIconName", "-string", APP_ICON_NAME, infoPlist],
        { stdio: ["ignore", "pipe", "pipe"] },
      );
    }

    console.log(
      `  • Tahoe icon: Assets.car + CFBundleIconName=${APP_ICON_NAME} added ` +
        `(pre-Tahoe keeps CFBundleIconFile → icon.icns)`,
    );
  } finally {
    fs.rmSync(compileDir, { recursive: true, force: true });
  }
};
