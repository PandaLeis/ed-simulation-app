import { createSeededRandom } from "./seededRandom";
import type { ComplaintCategory, ESILevel, Scenario, ScenarioPatient, WorkupType } from "./types";

const ageBands = ["18-34", "35-49", "50-64", "65-79", "80+"] as const;

const admissionByEsi: Record<ESILevel, number> = {
  1: 0.9,
  2: 0.55,
  3: 0.28,
  4: 0.08,
  5: 0.03,
};

const workupTiming: Record<WorkupType, { labs: number; imaging: number }> = {
  none: { labs: 0, imaging: 0 },
  basic_labs: { labs: 45, imaging: 0 },
  labs_imaging: { labs: 50, imaging: 55 },
  cardiac: { labs: 45, imaging: 35 },
  complex: { labs: 60, imaging: 75 },
};

const complaintWorkupDistribution: Record<ComplaintCategory, Scenario["workupDistribution"]> = {
  chest_pain: {
    values: [
      { value: "cardiac", weight: 60 },
      { value: "basic_labs", weight: 15 },
      { value: "labs_imaging", weight: 15 },
      { value: "complex", weight: 8 },
      { value: "none", weight: 2 },
    ],
  },
  abdominal_pain: {
    values: [
      { value: "labs_imaging", weight: 45 },
      { value: "basic_labs", weight: 30 },
      { value: "complex", weight: 15 },
      { value: "none", weight: 8 },
      { value: "cardiac", weight: 2 },
    ],
  },
  shortness_of_breath: {
    values: [
      { value: "labs_imaging", weight: 40 },
      { value: "cardiac", weight: 25 },
      { value: "complex", weight: 20 },
      { value: "basic_labs", weight: 13 },
      { value: "none", weight: 2 },
    ],
  },
  injury: {
    values: [
      { value: "labs_imaging", weight: 50 },
      { value: "none", weight: 25 },
      { value: "basic_labs", weight: 15 },
      { value: "complex", weight: 8 },
      { value: "cardiac", weight: 2 },
    ],
  },
  weakness_dizziness: {
    values: [
      { value: "basic_labs", weight: 45 },
      { value: "cardiac", weight: 20 },
      { value: "labs_imaging", weight: 18 },
      { value: "complex", weight: 10 },
      { value: "none", weight: 7 },
    ],
  },
  fever_infection: {
    values: [
      { value: "basic_labs", weight: 40 },
      { value: "labs_imaging", weight: 25 },
      { value: "complex", weight: 25 },
      { value: "none", weight: 8 },
      { value: "cardiac", weight: 2 },
    ],
  },
  behavioral_health: {
    values: [
      { value: "basic_labs", weight: 45 },
      { value: "none", weight: 35 },
      { value: "complex", weight: 10 },
      { value: "labs_imaging", weight: 8 },
      { value: "cardiac", weight: 2 },
    ],
  },
  minor_complaint: {
    values: [
      { value: "none", weight: 65 },
      { value: "basic_labs", weight: 20 },
      { value: "labs_imaging", weight: 10 },
      { value: "complex", weight: 3 },
      { value: "cardiac", weight: 2 },
    ],
  },
};

function complaintRiskModifier(complaint: ComplaintCategory): number {
  if (complaint === "chest_pain" || complaint === "shortness_of_breath") {
    return 0.1;
  }

  if (complaint === "minor_complaint") {
    return -0.05;
  }

  return 0;
}

function workupDistributionForComplaint(complaint: ComplaintCategory): Scenario["workupDistribution"] {
  return complaintWorkupDistribution[complaint];
}

export function generatePatientDeck(scenario: Scenario): ScenarioPatient[] {
  const random = createSeededRandom(scenario.randomSeed);
  const deck: ScenarioPatient[] = [];

  for (const hour of scenario.arrivalProfile) {
    const baseMinute = hour.hourOffset * 60;

    for (let arrivalIndex = 0; arrivalIndex < hour.expectedArrivals; arrivalIndex += 1) {
      const esi = random.weighted(scenario.esiDistribution);
      const complaintCategory = random.weighted(scenario.complaintDistribution);
      const workupType = random.weighted(workupDistributionForComplaint(complaintCategory));
      const timing = workupTiming[workupType];
      const admitProbability = Math.min(
        0.95,
        Math.max(0.01, admissionByEsi[esi] + complaintRiskModifier(complaintCategory)),
      );
      const patientNumber = deck.length + 1;

      deck.push({
        id: `patient-${String(patientNumber).padStart(3, "0")}`,
        scenarioId: scenario.id,
        patientNumber,
        arrivalMinute: baseMinute + random.integer(0, 59),
        esi,
        complaintCategory,
        ageBand: random.pick(ageBands),
        workupType,
        admitProbability,
        dischargeProbability: Math.max(0, 1 - admitProbability - 0.05),
        observationProbability: 0.05,
        expectedLabMinutes: timing.labs === 0 ? 0 : timing.labs + random.integer(-8, 12),
        expectedImagingMinutes: timing.imaging === 0 ? 0 : timing.imaging + random.integer(-10, 15),
        expectedBoardingMinutes: random.integer(
          scenario.boardingProfile.admitBoardingDelayMin,
          scenario.boardingProfile.admitBoardingDelayMax,
        ),
        lwbsBaseRisk: Math.max(0.02, 0.18 - esi * 0.025),
        patienceProfile: random.weighted({
          values: [
            { value: "low", weight: 25 },
            { value: "medium", weight: 55 },
            { value: "high", weight: 20 },
          ],
        }),
      });
    }
  }

  return deck.sort((left, right) => left.arrivalMinute - right.arrivalMinute);
}

export function createRuntimePatients(deck: ScenarioPatient[]) {
  return deck.map((patient) => ({
    ...patient,
    state: "not_arrived" as const,
    pendingItems: [],
    riskLevel: "low" as const,
  }));
}
