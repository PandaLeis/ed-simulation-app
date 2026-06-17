import type { RuntimePatient, TriageDurationProfile } from "./types";

export const defaultTriageDurationProfile: TriageDurationProfile = {
  suspected_acs: 10,
  chest_pain: 7,
  abdominal_pain: 6,
  shortness_of_breath: 8,
  injury: 5,
  weakness_dizziness: 6,
  fever_infection: 5,
  behavioral_health: 8,
  stroke_neuro: 9,
  sepsis_concern: 8,
  major_trauma: 7,
  pediatric: 6,
  ob_pregnancy: 7,
  syncope: 6,
  altered_mental_status: 8,
  overdose_intoxication: 8,
  renal_urinary: 5,
  gi_bleed: 7,
  allergic_reaction: 5,
  burn: 5,
  eye_ent: 4,
  back_pain: 4,
  hypertensive_symptoms: 6,
  diabetic_emergency: 7,
  social_placement: 6,
  minor_complaint: 3,
};

export function getTriageDurationMinutes(
  patient: RuntimePatient,
  profile: TriageDurationProfile = defaultTriageDurationProfile,
  multiplier = 1,
): number {
  const baseMinutes = profile[patient.complaintCategory] ?? defaultTriageDurationProfile[patient.complaintCategory] ?? 5;
  return Math.max(1, Math.round(baseMinutes * Math.max(0.25, multiplier)));
}
