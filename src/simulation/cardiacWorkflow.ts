import type { CardiacPathway, ComplaintCategory, PendingItem, PendingItemType, RuntimePatient, WorkupType } from "./types";
import type { SeededRandom } from "./seededRandom";

const cardiacDiagnosticTypes = new Set<PendingItemType>(["ecg", "troponin", "repeat_troponin", "chest_xray"]);

export function isCardiacComplaint(complaint: ComplaintCategory): boolean {
  return complaint === "chest_pain" || complaint === "suspected_acs";
}

export function isDiagnosticPendingItem(item: PendingItem): boolean {
  return item.type !== "boarding_bed";
}

export function isCardiacDiagnosticItem(item: PendingItem): boolean {
  return cardiacDiagnosticTypes.has(item.type);
}

export function isCardiacWorkupPatient(patient: Pick<RuntimePatient, "workupType" | "cardiacPathway">): boolean {
  return patient.workupType === "cardiac" || patient.cardiacPathway !== "none";
}

export function chooseCardiacPathway(
  complaintCategory: ComplaintCategory,
  workupType: WorkupType,
  random: SeededRandom,
): CardiacPathway {
  if (workupType !== "cardiac" && !isCardiacComplaint(complaintCategory)) {
    return "none";
  }

  if (complaintCategory === "suspected_acs" && workupType === "cardiac") {
    return random.next() < 0.12 ? "stemi_alert" : "possible_acs";
  }

  if (complaintCategory === "chest_pain" && workupType === "cardiac") {
    return random.next() < 0.04 ? "stemi_alert" : "possible_acs";
  }

  if (workupType === "cardiac") {
    return "possible_acs";
  }

  return "none";
}

export function buildCardiacPendingItems(patient: RuntimePatient, orderedAt: number): PendingItem[] {
  const doorToEcgTargetMinutes = patient.cardiacPathway === "stemi_alert" ? 5 : 8;
  const ecgTargetMinute = patient.arrivedAt === undefined ? orderedAt + doorToEcgTargetMinutes : patient.arrivedAt + doorToEcgTargetMinutes;
  const ecgReadyAt = Math.max(orderedAt + 1, ecgTargetMinute);
  const firstTroponinMinutes = Math.max(15, patient.expectedLabMinutes);
  const repeatTroponinMinutes = firstTroponinMinutes + 60;
  const chestXrayMinutes = Math.max(15, patient.expectedImagingMinutes);

  return [
    {
      type: "ecg",
      name: "ECG",
      orderedAt,
      readyAt: ecgReadyAt,
      status: "pending",
    },
    {
      type: "troponin",
      name: "Troponin",
      orderedAt,
      collectedAt: orderedAt,
      readyAt: orderedAt + firstTroponinMinutes,
      status: "pending",
    },
    {
      type: "repeat_troponin",
      name: "Repeat troponin",
      orderedAt,
      collectedAt: orderedAt + firstTroponinMinutes,
      readyAt: orderedAt + repeatTroponinMinutes,
      status: "pending",
    },
    {
      type: "chest_xray",
      name: "Chest X-ray",
      orderedAt,
      readyAt: orderedAt + chestXrayMinutes,
      status: "pending",
    },
  ];
}

export function cardiacPathwayLabel(pathway: CardiacPathway): string {
  switch (pathway) {
    case "stemi_alert":
      return "STEMI-alert pathway";
    case "possible_acs":
      return "Possible ACS pathway";
    default:
      return "No cardiac pathway";
  }
}
