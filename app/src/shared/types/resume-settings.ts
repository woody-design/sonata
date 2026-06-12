/**
 * Resume policy for large dormant Claude sessions — a positive enum, never
 * a suppression flag (the upstream `resumeReturnDismissed` boolean is the
 * documented confusion: #60848). "ask" renders Duet's inline choice at the
 * resume moment; "summary"/"full" apply silently with a receipt.
 */
export const RESUME_POLICY_IDS = ["ask", "summary", "full"] as const;
export type ResumePolicyId = (typeof RESUME_POLICY_IDS)[number];

export interface ResumeSettings {
  policy: ResumePolicyId;
}

export const DEFAULT_RESUME_SETTINGS: ResumeSettings = {
  policy: "ask",
};

export function normalizeResumeSettings(value: unknown): ResumeSettings {
  if (!isRecord(value)) {
    return { ...DEFAULT_RESUME_SETTINGS };
  }
  return {
    policy: isResumePolicyId(value.policy) ? value.policy : DEFAULT_RESUME_SETTINGS.policy,
  };
}

export function isResumePolicyId(value: unknown): value is ResumePolicyId {
  return RESUME_POLICY_IDS.includes(value as ResumePolicyId);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
