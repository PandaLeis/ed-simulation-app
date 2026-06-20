import type { ComplaintCategory, PendingItem, RuntimePatient, WorkflowTimingProfile } from "./types";

export function isSepsisComplaint(complaint: ComplaintCategory): boolean {
  return complaint === "sepsis_concern";
}

export function isSepsisWorkupPatient(patient: Pick<RuntimePatient, "complaintCategory">): boolean {
  return isSepsisComplaint(patient.complaintCategory);
}

export function buildSepsisPendingItems(
  patient: RuntimePatient,
  orderedAt: number,
  workflowTimingProfile: WorkflowTimingProfile,
): PendingItem[] {
  const lactateCollectionAt = orderedAt + workflowTimingProfile.sepsisLactateCollectionMinutes;
  const lactateReadyAt = orderedAt + Math.max(20, patient.expectedLabMinutes);
  const culturesCollectedAt = orderedAt + workflowTimingProfile.sepsisBloodCultureMinutes;
  const antibioticsReadyAt = orderedAt + workflowTimingProfile.sepsisAntibioticsMinutes;
  const fluidsReadyAt = orderedAt + workflowTimingProfile.sepsisFluidsMinutes;

  return [
    {
      type: "lactate",
      name: "Lactate",
      orderedAt,
      collectedAt: lactateCollectionAt,
      readyAt: lactateReadyAt,
      status: "pending",
    },
    {
      type: "blood_cultures",
      name: "Blood cultures",
      orderedAt,
      collectedAt: culturesCollectedAt,
      readyAt: culturesCollectedAt,
      status: "pending",
    },
    {
      type: "antibiotics",
      name: "Antibiotics",
      orderedAt,
      readyAt: antibioticsReadyAt,
      status: "pending",
    },
    {
      type: "iv_fluids",
      name: "IV fluids",
      orderedAt,
      readyAt: fluidsReadyAt,
      status: "pending",
    },
  ];
}
