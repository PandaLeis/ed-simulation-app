import type { RuntimePatient } from "./types";

export function reassessmentIntervalMinutes(patient: Pick<RuntimePatient, "esi" | "riskLevel">): number {
  if (patient.riskLevel === "critical") {
    return 10;
  }

  if (patient.riskLevel === "high" || patient.esi <= 2) {
    return 15;
  }

  if (patient.riskLevel === "moderate" || patient.esi === 3) {
    return 30;
  }

  return 60;
}

export function nextReassessmentDueAt(patient: Pick<RuntimePatient, "esi" | "riskLevel">, fromMinute: number): number {
  return fromMinute + reassessmentIntervalMinutes(patient);
}

export function reassessmentOverdueMinutes(
  patient: Pick<RuntimePatient, "nextReassessmentDueAt">,
  currentMinute: number,
): number {
  if (patient.nextReassessmentDueAt === undefined) {
    return 0;
  }

  return Math.max(0, currentMinute - patient.nextReassessmentDueAt);
}

export function isReassessmentOverdue(
  patient: Pick<RuntimePatient, "nextReassessmentDueAt">,
  currentMinute: number,
): boolean {
  return reassessmentOverdueMinutes(patient, currentMinute) > 0;
}
