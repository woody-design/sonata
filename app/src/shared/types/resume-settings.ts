/**
 * Resume policy for large dormant Claude sessions — a positive enum, never
 * a suppression flag (the upstream `resumeReturnDismissed` boolean is the
 * documented confusion: #60848). "ask" renders Sonata's inline choice at the
 * resume moment; "summary"/"full" apply silently with a receipt.
 */
export const RESUME_POLICY_IDS = ["ask", "summary", "full"] as const;
export type ResumePolicyId = (typeof RESUME_POLICY_IDS)[number];

// Sonata's own resume-cost thresholds. They default-mirror the upstream
// interstitial's (≥70min idle AND ≥100k tokens) but are SONATA policy — the
// choice renders from Sonata's own data, so upstream drift cannot break it.
// Shared so the Settings page discloses the same numbers the runtime uses.
export const RESUME_PROMPT_MIN_IDLE_MS = 70 * 60_000;
export const RESUME_PROMPT_MIN_TOKENS = 100_000;

/**
 * Which door last wrote the policy. "moment" = the inline resume chooser
 * ("remember my choice"); "settings" = the Settings page. The page shows
 * a one-line attribution only while the value is moment-born — once the
 * user revises it on the page, the history line retires.
 */
export const RESUME_PROVENANCE_SOURCES = ["moment", "settings"] as const;
export type ResumeProvenanceSource = (typeof RESUME_PROVENANCE_SOURCES)[number];

export interface ResumeProvenance {
  source: ResumeProvenanceSource;
  /** ISO-8601 timestamp of the write. */
  at: string;
}

export interface ResumeSettings {
  policy: ResumePolicyId;
  provenance?: ResumeProvenance;
}

export const DEFAULT_RESUME_SETTINGS: ResumeSettings = {
  policy: "ask",
};

export function normalizeResumeSettings(value: unknown): ResumeSettings {
  if (!isRecord(value)) {
    return { ...DEFAULT_RESUME_SETTINGS };
  }
  const provenance = normalizeResumeProvenance(value.provenance);
  return {
    policy: isResumePolicyId(value.policy) ? value.policy : DEFAULT_RESUME_SETTINGS.policy,
    ...(provenance ? { provenance } : {}),
  };
}

function normalizeResumeProvenance(value: unknown): ResumeProvenance | null {
  if (!isRecord(value)) {
    return null;
  }
  if (!isResumeProvenanceSource(value.source) || typeof value.at !== "string") {
    return null;
  }
  return { source: value.source, at: value.at };
}

export function isResumeProvenanceSource(value: unknown): value is ResumeProvenanceSource {
  return RESUME_PROVENANCE_SOURCES.includes(value as ResumeProvenanceSource);
}

export function isResumePolicyId(value: unknown): value is ResumePolicyId {
  return RESUME_POLICY_IDS.includes(value as ResumePolicyId);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
