// One reviewed acceptance vocabulary for both historical-evidence integrity
// and freshly generated integrated runs. Exact keysets make deleting, renaming,
// or silently adding a claim a review-visible change instead of a false green.
export const SIDEBAR_DISCLOSURE_ASSERTIONS = Object.freeze([
  "exactInitialAndIncrement",
  "localOnlyShowMore",
  "outerControlsCoexistInFixedOrder",
  "outerResetAll",
  "projectCollapsePreservesDepth",
  "projectOrderCanonical",
  "dateBucketsIndependent",
  "flatAndFocusedGroups",
  "preferenceResetAndNoOp",
  "semanticFocusAndScroll",
  "pointerDoesNotForceFinalBatchFocus",
  "keyboardFinalBatchFocus",
  "nativeButtonA11yAndLockedStyles",
  "backgroundIndexRefreshFallback",
  "crossGroupNearestFallback",
  "narrowFilterMenuFocusAnchor",
  "closedMenuReturnsToTrigger",
]);

export const SIDEBAR_RENAME_ASSERTIONS = Object.freeze([
  "surfaceLocalDraft",
  "headerVisibleAndHidden",
  "enterTabShiftTabPointerAndAppBlur",
  "escapeUnchangedAndEmpty",
  "duplicateTriggersSingleFlight",
  "truePersistenceFailureAndRetry",
  "protectedNodeCaretFocusAndComposition",
  "compositionDeferredIntents",
  "queuedNavigationBlockedOnFailure",
  "queuedArchiveAndDeleteBlockedOnFailure",
  "staleRequestGenerationIsolation",
  "failedSecondIntentRefocus",
  "sessionAndProjectCanonicalPersistence",
  "disappearanceAlertsBySurface",
  "accessibleValidationAndBusyState",
]);

export const SIDEBAR_VISUAL_THEMES = Object.freeze(["sonata", "paper", "calm", "focus"]);
// Historical: the committed evidence manifests predate the Duet→Sonata rename,
// so the STORY they tell still uses the old "duet" theme id. Fresh runs assert
// against SIDEBAR_VISUAL_THEMES (the current product vocabulary) instead.
export const SIDEBAR_VISUAL_THEMES_HISTORICAL = Object.freeze(["duet", "paper", "calm", "focus"]);
export const SIDEBAR_VISUAL_MODES = Object.freeze(["light", "dark"]);
export const SIDEBAR_VISUAL_TEXT_STEPS = Object.freeze([14, 20]);

export function assertExactVisualMatrix(results, label, themes = SIDEBAR_VISUAL_THEMES) {
  const expectedKeys = themes.flatMap((theme) =>
    SIDEBAR_VISUAL_MODES.flatMap((mode) =>
      SIDEBAR_VISUAL_TEXT_STEPS.map((textStep) => `${theme}:${mode}:${textStep}`),
    ),
  ).sort();
  const actualKeys = (results ?? [])
    .map(({ theme, mode, textStep }) => `${theme}:${mode}:${textStep}`)
    .sort();
  if (JSON.stringify(actualKeys) !== JSON.stringify(expectedKeys)) {
    throw new Error(
      `${label}: expected ${JSON.stringify(expectedKeys)}, got ${JSON.stringify(actualKeys)}`,
    );
  }
}

export function assertExactTrueAssertions(assertions, requiredKeys, label) {
  const actualKeys = Object.keys(assertions ?? {}).sort();
  const expectedKeys = [...requiredKeys].sort();
  if (JSON.stringify(actualKeys) !== JSON.stringify(expectedKeys)) {
    throw new Error(
      `${label} keyset: expected ${JSON.stringify(expectedKeys)}, got ${JSON.stringify(actualKeys)}`,
    );
  }
  for (const key of expectedKeys) {
    if (assertions[key] !== true) {
      throw new Error(`${label} assertion ${key}: expected true, got ${JSON.stringify(assertions[key])}`);
    }
  }
}
