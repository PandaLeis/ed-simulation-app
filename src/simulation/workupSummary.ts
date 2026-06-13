import type { PendingItem, RuntimePatient, WorkupType } from "./types";

const workupLabels: Record<WorkupType, string> = {
  none: "No protocol workup",
  basic_labs: "Basic labs",
  labs_imaging: "Labs + imaging",
  cardiac: "Cardiac bundle",
  complex: "Complex workup",
};

const pendingItemLabels: Record<PendingItem["type"], string> = {
  labs: "Labs",
  imaging: "Imaging",
  boarding_bed: "Boarding bed",
};

export interface PendingOrderSummary {
  label: string;
  status: PendingItem["status"];
  orderedAt: number;
  readyAt: number;
  completedAt?: number;
}

export interface PatientWorkupSummary {
  workupType: WorkupType;
  label: string;
  reason: string;
  expectedOrders: string[];
  pendingOrders: PendingOrderSummary[];
}

function expectedOrders(patient: RuntimePatient): string[] {
  const orders: string[] = [];

  if (patient.expectedLabMinutes > 0) {
    orders.push("Labs");
  }

  if (patient.expectedImagingMinutes > 0) {
    orders.push("Imaging");
  }

  return orders;
}

function summarizePendingItem(item: PendingItem): PendingOrderSummary {
  return {
    label: pendingItemLabels[item.type],
    status: item.status,
    orderedAt: item.orderedAt,
    readyAt: item.readyAt,
    completedAt: item.completedAt,
  };
}

export function getPatientWorkupSummary(patient: RuntimePatient): PatientWorkupSummary {
  return {
    workupType: patient.workupType,
    label: workupLabels[patient.workupType],
    reason: `${patient.complaintCategory.replaceAll("_", " ")} synthetic bundle`,
    expectedOrders: expectedOrders(patient),
    pendingOrders: patient.pendingItems.map(summarizePendingItem),
  };
}
