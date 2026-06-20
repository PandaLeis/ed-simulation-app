import { createSeededRandom } from "./seededRandom";
import { samplePertDuration, timingRangeFromTypical } from "./timingProfile";
import { chooseCardiacPathway } from "./cardiacWorkflow";
import type { SeededRandom } from "./seededRandom";
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
  suspected_acs: {
    values: [
      { value: "cardiac", weight: 85 },
      { value: "complex", weight: 10 },
      { value: "labs_imaging", weight: 5 },
    ],
  },
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
  stroke_neuro: {
    values: [
      { value: "complex", weight: 55 },
      { value: "labs_imaging", weight: 30 },
      { value: "basic_labs", weight: 10 },
      { value: "cardiac", weight: 5 },
    ],
  },
  sepsis_concern: {
    values: [
      { value: "complex", weight: 55 },
      { value: "labs_imaging", weight: 30 },
      { value: "basic_labs", weight: 13 },
      { value: "cardiac", weight: 2 },
    ],
  },
  major_trauma: {
    values: [
      { value: "complex", weight: 50 },
      { value: "labs_imaging", weight: 42 },
      { value: "basic_labs", weight: 6 },
      { value: "none", weight: 2 },
    ],
  },
  pediatric: {
    values: [
      { value: "none", weight: 30 },
      { value: "basic_labs", weight: 30 },
      { value: "labs_imaging", weight: 25 },
      { value: "complex", weight: 13 },
      { value: "cardiac", weight: 2 },
    ],
  },
  ob_pregnancy: {
    values: [
      { value: "labs_imaging", weight: 35 },
      { value: "basic_labs", weight: 30 },
      { value: "complex", weight: 25 },
      { value: "none", weight: 8 },
      { value: "cardiac", weight: 2 },
    ],
  },
  syncope: {
    values: [
      { value: "cardiac", weight: 35 },
      { value: "basic_labs", weight: 30 },
      { value: "labs_imaging", weight: 20 },
      { value: "complex", weight: 12 },
      { value: "none", weight: 3 },
    ],
  },
  altered_mental_status: {
    values: [
      { value: "complex", weight: 45 },
      { value: "labs_imaging", weight: 30 },
      { value: "basic_labs", weight: 20 },
      { value: "cardiac", weight: 5 },
    ],
  },
  overdose_intoxication: {
    values: [
      { value: "basic_labs", weight: 45 },
      { value: "complex", weight: 25 },
      { value: "none", weight: 20 },
      { value: "labs_imaging", weight: 8 },
      { value: "cardiac", weight: 2 },
    ],
  },
  renal_urinary: {
    values: [
      { value: "basic_labs", weight: 45 },
      { value: "labs_imaging", weight: 35 },
      { value: "none", weight: 12 },
      { value: "complex", weight: 8 },
    ],
  },
  gi_bleed: {
    values: [
      { value: "complex", weight: 45 },
      { value: "basic_labs", weight: 35 },
      { value: "labs_imaging", weight: 15 },
      { value: "cardiac", weight: 5 },
    ],
  },
  allergic_reaction: {
    values: [
      { value: "none", weight: 45 },
      { value: "basic_labs", weight: 25 },
      { value: "complex", weight: 20 },
      { value: "labs_imaging", weight: 8 },
      { value: "cardiac", weight: 2 },
    ],
  },
  burn: {
    values: [
      { value: "none", weight: 35 },
      { value: "labs_imaging", weight: 30 },
      { value: "basic_labs", weight: 20 },
      { value: "complex", weight: 15 },
    ],
  },
  eye_ent: {
    values: [
      { value: "none", weight: 55 },
      { value: "labs_imaging", weight: 20 },
      { value: "basic_labs", weight: 18 },
      { value: "complex", weight: 5 },
      { value: "cardiac", weight: 2 },
    ],
  },
  back_pain: {
    values: [
      { value: "none", weight: 35 },
      { value: "labs_imaging", weight: 30 },
      { value: "basic_labs", weight: 25 },
      { value: "complex", weight: 8 },
      { value: "cardiac", weight: 2 },
    ],
  },
  hypertensive_symptoms: {
    values: [
      { value: "basic_labs", weight: 35 },
      { value: "cardiac", weight: 30 },
      { value: "labs_imaging", weight: 20 },
      { value: "complex", weight: 13 },
      { value: "none", weight: 2 },
    ],
  },
  diabetic_emergency: {
    values: [
      { value: "complex", weight: 45 },
      { value: "basic_labs", weight: 35 },
      { value: "labs_imaging", weight: 15 },
      { value: "cardiac", weight: 5 },
    ],
  },
  social_placement: {
    values: [
      { value: "none", weight: 45 },
      { value: "basic_labs", weight: 30 },
      { value: "complex", weight: 15 },
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
  if (
    complaint === "suspected_acs" ||
    complaint === "stroke_neuro" ||
    complaint === "sepsis_concern" ||
    complaint === "major_trauma" ||
    complaint === "altered_mental_status" ||
    complaint === "diabetic_emergency"
  ) {
    return 0.25;
  }

  if (
    complaint === "chest_pain" ||
    complaint === "shortness_of_breath" ||
    complaint === "syncope" ||
    complaint === "gi_bleed" ||
    complaint === "hypertensive_symptoms"
  ) {
    return 0.1;
  }

  if (complaint === "minor_complaint" || complaint === "eye_ent" || complaint === "back_pain") {
    return -0.05;
  }

  return 0;
}

function acuityForComplaint(baseEsi: ESILevel, complaint: ComplaintCategory, random: SeededRandom): ESILevel {
  if (complaint === "suspected_acs") {
    return random.weighted({
      values: [
        { value: 1, weight: 10 },
        { value: 2, weight: 75 },
        { value: 3, weight: 15 },
      ],
    });
  }

  if (complaint === "stroke_neuro" || complaint === "sepsis_concern" || complaint === "major_trauma") {
    return random.weighted({
      values: [
        { value: 1, weight: 12 },
        { value: 2, weight: 58 },
        { value: 3, weight: 30 },
      ],
    });
  }

  if (complaint === "altered_mental_status" || complaint === "diabetic_emergency" || complaint === "gi_bleed") {
    return random.weighted({
      values: [
        { value: 2, weight: 55 },
        { value: 3, weight: 35 },
        { value: 4, weight: 10 },
      ],
    });
  }

  return baseEsi;
}

function workupDistributionForComplaint(
  complaint: ComplaintCategory,
  scenario: Scenario,
): Scenario["workupDistribution"] {
  const baseDistribution = complaintWorkupDistribution[complaint];

  if (scenario.patientMix.workup === "standard") {
    return baseDistribution;
  }

  return {
    values: baseDistribution.values.map((item) => {
      const highIntensity = item.value === "complex" || item.value === "cardiac" || item.value === "labs_imaging";
      const lowIntensity = item.value === "none" || item.value === "basic_labs";

      if (scenario.patientMix.workup === "higher_workup" && highIntensity) {
        return { ...item, weight: Math.round(item.weight * 1.45) };
      }

      if (scenario.patientMix.workup === "higher_workup" && lowIntensity) {
        return { ...item, weight: Math.max(1, Math.round(item.weight * 0.7)) };
      }

      if (scenario.patientMix.workup === "lower_workup" && lowIntensity) {
        return { ...item, weight: Math.round(item.weight * 1.45) };
      }

      if (scenario.patientMix.workup === "lower_workup" && highIntensity) {
        return { ...item, weight: Math.max(1, Math.round(item.weight * 0.65)) };
      }

      return item;
    }),
  };
}

function admissionPressureModifier(scenario: Scenario): number {
  switch (scenario.patientMix.admission) {
    case "higher_admit":
      return 0.12;
    case "lower_admit":
      return -0.1;
    default:
      return 0;
  }
}

function stemiPromotionScore(patient: ScenarioPatient): number {
  if (patient.cardiacPathway === "stemi_alert") {
    return 0;
  }

  if (patient.complaintCategory === "suspected_acs" && patient.workupType === "cardiac") {
    return 1;
  }

  if (patient.complaintCategory === "chest_pain" && patient.workupType === "cardiac") {
    return 2;
  }

  if (patient.complaintCategory === "suspected_acs" || patient.complaintCategory === "chest_pain") {
    return 3;
  }

  if (patient.cardiacPathway === "possible_acs") {
    return 4;
  }

  if (patient.workupType === "cardiac") {
    return 5;
  }

  return Number.POSITIVE_INFINITY;
}

function chooseStemiPromotionCandidates(
  deck: ScenarioPatient[],
  promotionCount: number,
  seed: string,
): string[] {
  const promotionRandom = createSeededRandom(`${seed}:stemi-promotion`);
  const candidates = deck
    .filter((patient) => patient.cardiacPathway !== "stemi_alert")
    .map((patient) => ({ patient, score: stemiPromotionScore(patient) }))
    .filter(({ score }) => Number.isFinite(score))
    .sort((left, right) => left.patient.patientNumber - right.patient.patientNumber);
  const promotedIds: string[] = [];

  while (promotedIds.length < promotionCount && candidates.length > 0) {
    const bestScore = Math.min(...candidates.map((candidate) => candidate.score));
    const bestCandidateIndexes = candidates
      .map((candidate, index) => ({ index, score: candidate.score }))
      .filter((candidate) => candidate.score === bestScore)
      .map((candidate) => candidate.index);
    const selectedCandidateIndex = promotionRandom.pick(bestCandidateIndexes);
    const [selected] = candidates.splice(selectedCandidateIndex, 1);

    if (selected) {
      promotedIds.push(selected.patient.id);
    }
  }

  return promotedIds;
}

function ensureMinimumStemiAlertPatients(
  deck: ScenarioPatient[],
  minimumStemiAlertPatients: number,
  seed: string,
): ScenarioPatient[] {
  const required = Math.max(0, Math.floor(minimumStemiAlertPatients));
  const currentStemiCount = deck.filter((patient) => patient.cardiacPathway === "stemi_alert").length;

  if (required === 0 || currentStemiCount >= required) {
    return deck;
  }

  const candidates = chooseStemiPromotionCandidates(deck, required - currentStemiCount, seed);

  if (candidates.length === 0) {
    return deck;
  }

  const promotedIds = new Set(candidates);

  return deck.map((patient) => {
    if (!promotedIds.has(patient.id)) {
      return patient;
    }

    const timing = workupTiming.cardiac;

    return {
      ...patient,
      esi: patient.esi > 2 ? 2 : patient.esi,
      workupType: "cardiac",
      cardiacPathway: "stemi_alert",
      admitProbability: Math.max(patient.admitProbability, 0.65),
      dischargeProbability: Math.min(patient.dischargeProbability, 0.3),
      expectedLabMinutes:
        patient.expectedLabMinutes > 0
          ? patient.expectedLabMinutes
          : timing.labs,
      expectedImagingMinutes:
        patient.expectedImagingMinutes > 0
          ? patient.expectedImagingMinutes
          : timing.imaging,
    };
  });
}

export function generatePatientDeck(scenario: Scenario): ScenarioPatient[] {
  const random = createSeededRandom(scenario.randomSeed);
  const deck: ScenarioPatient[] = [];

  for (const hour of scenario.arrivalProfile) {
    const baseMinute = hour.hourOffset * 60;

    for (let arrivalIndex = 0; arrivalIndex < hour.expectedArrivals; arrivalIndex += 1) {
      const baseEsi = random.weighted(scenario.esiDistribution);
      const complaintCategory = random.weighted(scenario.complaintDistribution);
      const esi = acuityForComplaint(baseEsi, complaintCategory, random);
      const workupType = random.weighted(workupDistributionForComplaint(complaintCategory, scenario));
      const cardiacPathway = chooseCardiacPathway(complaintCategory, workupType, random);
      const timing = workupTiming[workupType];
      const labScale = scenario.timingProfile.labTurnaround.typical / 45;
      const imagingScale = scenario.timingProfile.imagingTurnaround.typical / 55;
      const admitProbability = Math.min(
        0.95,
        Math.max(0.01, admissionByEsi[esi] + complaintRiskModifier(complaintCategory) + admissionPressureModifier(scenario)),
      );
      const patientNumber = deck.length + 1;
      const roomCleaningRandom = createSeededRandom(`${scenario.randomSeed}:room-cleaning:${patientNumber}`);

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
        expectedLabMinutes:
          timing.labs === 0 ? 0 : samplePertDuration(random, timingRangeFromTypical(timing.labs * labScale, 0.7, 1.8)),
        expectedImagingMinutes:
          timing.imaging === 0
            ? 0
            : samplePertDuration(random, timingRangeFromTypical(timing.imaging * imagingScale, 0.65, 1.9)),
        expectedAdmissionDecisionMinutes: samplePertDuration(random, scenario.timingProfile.admissionDecision),
        expectedBoardingMinutes: samplePertDuration(random, scenario.timingProfile.boardingDuration),
        expectedRoomCleaningMinutes: samplePertDuration(roomCleaningRandom, scenario.timingProfile.roomCleaning),
        cardiacPathway,
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

  return ensureMinimumStemiAlertPatients(deck, scenario.minimumStemiAlertPatients, scenario.randomSeed).sort(
    (left, right) => left.arrivalMinute - right.arrivalMinute,
  );
}

export function createRuntimePatients(deck: ScenarioPatient[]) {
  return deck.map((patient) => ({
    ...patient,
    state: "not_arrived" as const,
    pendingItems: [],
    riskLevel: "low" as const,
    deteriorationCount: 0,
  }));
}
