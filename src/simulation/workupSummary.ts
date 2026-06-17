import type { PendingItem, PendingItemType, RuntimePatient, WorkupType } from "./types";
import { cardiacPathwayLabel, isDiagnosticPendingItem } from "./cardiacWorkflow";
import { isSepsisWorkupPatient } from "./sepsisWorkflow";

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
  ecg: "ECG",
  troponin: "Troponin",
  repeat_troponin: "Repeat troponin",
  chest_xray: "Chest X-ray",
  lactate: "Lactate",
  blood_cultures: "Blood cultures",
  antibiotics: "Antibiotics",
  iv_fluids: "IV fluids",
  boarding_bed: "Boarding bed",
};

const sepsisProtocolOrders: Array<{ name: string; category: PendingItemType }> = [
  { name: "Lactate", category: "lactate" },
  { name: "Blood cultures", category: "blood_cultures" },
  { name: "Antibiotics", category: "antibiotics" },
  { name: "IV fluids", category: "iv_fluids" },
];

const namedOrdersByWorkup: Record<WorkupType, Array<{ name: string; category: PendingItemType }>> = {
  none: [],
  basic_labs: [
    { name: "CBC", category: "labs" },
    { name: "CMP", category: "labs" },
    { name: "Urinalysis", category: "labs" },
  ],
  labs_imaging: [
    { name: "CBC", category: "labs" },
    { name: "CMP", category: "labs" },
    { name: "Plain-film imaging", category: "imaging" },
  ],
  cardiac: [
    { name: "ECG", category: "ecg" },
    { name: "Troponin", category: "troponin" },
    { name: "Repeat troponin", category: "repeat_troponin" },
    { name: "Chest X-ray", category: "chest_xray" },
  ],
  complex: [
    { name: "CBC", category: "labs" },
    { name: "CMP", category: "labs" },
    { name: "Lactate", category: "labs" },
    { name: "Blood cultures", category: "labs" },
    { name: "Advanced imaging", category: "imaging" },
  ],
};

export interface PendingOrderSummary {
  label: string;
  status: PendingItem["status"];
  orderedAt: number;
  readyAt: number;
  completedAt?: number;
}

export interface NamedProtocolOrderSummary {
  name: string;
  category: PendingItemType;
  status: "identified" | PendingItem["status"];
  readyAt?: number;
  completedAt?: number;
}

export interface PatientWorkupSummary {
  workupType: WorkupType;
  label: string;
  reason: string;
  cardiacPathwayLabel: string;
  protocolStatus: "none" | "identified" | "pending" | "ready" | "complete";
  protocolStatusLabel: string;
  expectedOrders: string[];
  namedOrders: NamedProtocolOrderSummary[];
  pendingOrders: PendingOrderSummary[];
  flowImpact: string;
}

function expectedOrders(patient: RuntimePatient): string[] {
  if (isSepsisWorkupPatient(patient)) {
    return ["Lactate", "Blood cultures", "Antibiotics", "IV fluids"];
  }

  if (patient.workupType === "cardiac" || patient.cardiacPathway !== "none") {
    return ["ECG", "Troponin", "Repeat troponin", "Chest X-ray"];
  }

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
    label: item.name ?? pendingItemLabels[item.type],
    status: item.status,
    orderedAt: item.orderedAt,
    readyAt: item.readyAt,
    completedAt: item.completedAt,
  };
}

function protocolStatus(patient: RuntimePatient): PatientWorkupSummary["protocolStatus"] {
  if (patient.workupType === "none") {
    return "none";
  }

  const diagnosticItems = patient.pendingItems.filter(isDiagnosticPendingItem);
  if (diagnosticItems.length === 0) {
    return "identified";
  }

  if (diagnosticItems.every((item) => item.status === "completed")) {
    return "complete";
  }

  if (diagnosticItems.every((item) => item.status !== "pending")) {
    return "ready";
  }

  return "pending";
}

function namedOrders(patient: RuntimePatient): NamedProtocolOrderSummary[] {
  const orders = isSepsisWorkupPatient(patient) ? sepsisProtocolOrders : namedOrdersByWorkup[patient.workupType];

  return orders.map((order) => {
    const pendingItem = patient.pendingItems.find((item) => item.type === order.category);

    return {
      ...order,
      status: pendingItem?.status ?? "identified",
      readyAt: pendingItem?.readyAt,
      completedAt: pendingItem?.completedAt,
    };
  });
}

function flowImpact(patient: RuntimePatient, status: PatientWorkupSummary["protocolStatus"]): string {
  if (status === "none") {
    return "No front-end protocol workup is expected for this synthetic patient.";
  }

  if (status === "identified") {
    return "Protocol orders are available for front-end triage but have not been started yet.";
  }

  if (status === "pending") {
    return "Protocol workup is running while the patient waits, which may shorten active room time.";
  }

  if (status === "ready" && patient.state === "waiting") {
    return "Protocol results are ready while the patient is still waiting; once seen, they may move directly to results review.";
  }

  if (status === "ready") {
    return "Protocol results are ready for provider review.";
  }

  return "Protocol workup has been completed.";
}

function protocolStatusLabel(status: PatientWorkupSummary["protocolStatus"]): string {
  if (status === "identified") {
    return "Protocol available";
  }

  return status;
}

export function getPatientWorkupSummary(patient: RuntimePatient): PatientWorkupSummary {
  const status = protocolStatus(patient);

  return {
    workupType: patient.workupType,
    label: workupLabels[patient.workupType],
    reason: `${patient.complaintCategory.replaceAll("_", " ")} synthetic bundle`,
    cardiacPathwayLabel: cardiacPathwayLabel(patient.cardiacPathway),
    protocolStatus: status,
    protocolStatusLabel: protocolStatusLabel(status),
    expectedOrders: expectedOrders(patient),
    namedOrders: namedOrders(patient),
    pendingOrders: patient.pendingItems.map(summarizePendingItem),
    flowImpact: flowImpact(patient, status),
  };
}
