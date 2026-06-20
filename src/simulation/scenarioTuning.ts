import { defaultScenario } from "./mockScenario";
import { timingRangeFromTypical } from "./timingProfile";
import type {
  CoachComparisonStrategyId,
  CoachPriorityMode,
  CoachPriorityProfile,
  CoachStrategyPriorityProfiles,
  ComplaintCategory,
  ESILevel,
  HourlyArrivalProfile,
  PatientAcuityMix,
  PatientAdmissionMix,
  PatientComplaintMix,
  PatientWorkupMix,
  ProviderAssignmentMode,
  Scenario,
  ScenarioPreset,
  ScenarioPresetId,
  ScenarioTuningConfig,
  WeightedDistribution,
} from "./types";

export const coachComparisonStrategyIds: CoachComparisonStrategyId[] = [
  "front_end_focus",
  "middle_flow_focus",
  "disposition_focus",
  "resource_aware",
  "safety_first",
  "fast_track",
  "balanced_operations",
];

export const scenarioPresets: ScenarioPreset[] = [
  {
    id: "default",
    label: "Default Flow",
    description: "Baseline single-provider evening flow.",
  },
  {
    id: "boarding_surge",
    label: "Boarding Surge",
    description: "Longer admit boarding delays with moderate arrival pressure.",
  },
  {
    id: "high_arrivals",
    label: "High Arrivals",
    description: "Higher patient volume across the simulation.",
  },
  {
    id: "low_room_capacity",
    label: "Low Room Capacity",
    description: "Fewer usable rooms with baseline arrivals.",
  },
];

function boundedInteger(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, Math.round(value)));
}

function boundedDecimal(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, Math.round(value * 100) / 100));
}

function validProviderAssignmentMode(value: ProviderAssignmentMode | undefined): ProviderAssignmentMode {
  return value === "assigned" || value === "assigned_with_handoff" ? value : "team";
}

function validPatientAcuityMix(value: PatientAcuityMix | undefined): PatientAcuityMix {
  return value === "higher_acuity" || value === "lower_acuity" ? value : "standard";
}

function validPatientComplaintMix(value: PatientComplaintMix | undefined): PatientComplaintMix {
  return value === "cardiac" || value === "infection" || value === "injury_minor" ? value : "balanced";
}

function validPatientWorkupMix(value: PatientWorkupMix | undefined): PatientWorkupMix {
  return value === "higher_workup" || value === "lower_workup" ? value : "standard";
}

function validPatientAdmissionMix(value: PatientAdmissionMix | undefined): PatientAdmissionMix {
  return value === "higher_admit" || value === "lower_admit" ? value : "standard";
}

function validCoachPriorityMode(value: CoachPriorityMode | undefined): CoachPriorityMode {
  return value === "safety_first" || value === "throughput" || value === "front_end" ? value : "balanced";
}

function validCoachPriorityProfile(
  profile: CoachPriorityProfile | undefined,
  fallback: CoachPriorityProfile,
): CoachPriorityProfile {
  return {
    mode: validCoachPriorityMode(profile?.mode ?? fallback.mode),
    acuityWeight: boundedInteger(profile?.acuityWeight ?? fallback.acuityWeight, 0, 2000),
    riskWeight: boundedInteger(profile?.riskWeight ?? fallback.riskWeight, 0, 500),
    waitWeight: boundedDecimal(profile?.waitWeight ?? fallback.waitWeight, 0, 10),
  };
}

function validCoachStrategyPriorityProfiles(
  profiles: Partial<CoachStrategyPriorityProfiles> | undefined,
  fallbackProfiles = defaultScenario.coachStrategyPriorityProfiles,
): CoachStrategyPriorityProfiles {
  return Object.fromEntries(
    coachComparisonStrategyIds.map((strategyId) => [
      strategyId,
      validCoachPriorityProfile(profiles?.[strategyId], fallbackProfiles[strategyId]),
    ]),
  ) as CoachStrategyPriorityProfiles;
}

function esiDistributionForMix(mix: PatientAcuityMix): WeightedDistribution<ESILevel> {
  switch (mix) {
    case "higher_acuity":
      return {
        values: [
          { value: 1, weight: 5 },
          { value: 2, weight: 25 },
          { value: 3, weight: 45 },
          { value: 4, weight: 20 },
          { value: 5, weight: 5 },
        ],
      };
    case "lower_acuity":
      return {
        values: [
          { value: 2, weight: 8 },
          { value: 3, weight: 32 },
          { value: 4, weight: 40 },
          { value: 5, weight: 20 },
        ],
      };
    default:
      return defaultScenario.esiDistribution;
  }
}

function complaintDistributionForMix(mix: PatientComplaintMix): WeightedDistribution<ComplaintCategory> {
  switch (mix) {
    case "cardiac":
      return {
        values: [
          { value: "suspected_acs", weight: 12 },
          { value: "chest_pain", weight: 32 },
          { value: "shortness_of_breath", weight: 18 },
          { value: "syncope", weight: 8 },
          { value: "abdominal_pain", weight: 8 },
          { value: "weakness_dizziness", weight: 8 },
          { value: "fever_infection", weight: 5 },
          { value: "injury", weight: 5 },
          { value: "minor_complaint", weight: 4 },
        ],
      };
    case "infection":
      return {
        values: [
          { value: "fever_infection", weight: 28 },
          { value: "sepsis_concern", weight: 14 },
          { value: "shortness_of_breath", weight: 14 },
          { value: "weakness_dizziness", weight: 10 },
          { value: "abdominal_pain", weight: 10 },
          { value: "renal_urinary", weight: 8 },
          { value: "altered_mental_status", weight: 6 },
          { value: "chest_pain", weight: 5 },
          { value: "minor_complaint", weight: 5 },
        ],
      };
    case "injury_minor":
      return {
        values: [
          { value: "injury", weight: 28 },
          { value: "minor_complaint", weight: 20 },
          { value: "back_pain", weight: 12 },
          { value: "eye_ent", weight: 10 },
          { value: "burn", weight: 6 },
          { value: "allergic_reaction", weight: 6 },
          { value: "abdominal_pain", weight: 6 },
          { value: "chest_pain", weight: 6 },
          { value: "fever_infection", weight: 6 },
        ],
      };
    default:
      return defaultScenario.complaintDistribution;
  }
}

function buildArrivalProfile(shiftDurationMinutes: number, expectedArrivalsPerHour: number): HourlyArrivalProfile[] {
  const hourCount = Math.max(1, Math.ceil(shiftDurationMinutes / 60));
  return Array.from({ length: hourCount }, (_, hourOffset) => ({
    hourOffset,
    expectedArrivals: expectedArrivalsPerHour,
  }));
}

export function getDefaultScenarioTuningConfig(baseScenario = defaultScenario): ScenarioTuningConfig {
  const totalExpectedArrivals = baseScenario.arrivalProfile.reduce(
    (total, hour) => total + hour.expectedArrivals,
    0,
  );
  const averageArrivalsPerHour = totalExpectedArrivals / Math.max(1, baseScenario.arrivalProfile.length);
  const averageBoardingDelay =
    (baseScenario.boardingProfile.admitBoardingDelayMin + baseScenario.boardingProfile.admitBoardingDelayMax) / 2;

  return {
    triageProviderEnabled: baseScenario.triageProviderEnabled,
    triageProviderMode:
      baseScenario.triageProviderMode ?? (baseScenario.triageProviderEnabled ? "manual" : "unavailable"),
    roomCapacity: baseScenario.roomCapacity,
    providerCount: baseScenario.providerCount,
    providerAssignmentMode: validProviderAssignmentMode(baseScenario.providerAssignmentMode),
    nurseCount: baseScenario.nurseCount,
    techCount: baseScenario.techCount,
    fastTrackEnabled: baseScenario.fastTrackEnabled,
    shiftDurationMinutes: baseScenario.shiftDurationMinutes,
    expectedArrivalsPerHour: Math.round(averageArrivalsPerHour),
    triageDurationMultiplier: baseScenario.triageDurationMultiplier,
    providerEvaluationTypicalMinutes: baseScenario.timingProfile.providerEvaluation.typical,
    triageTypicalMinutes: baseScenario.timingProfile.triage.typical,
    labTurnaroundTypicalMinutes: baseScenario.timingProfile.labTurnaround.typical,
    imagingTurnaroundTypicalMinutes: baseScenario.timingProfile.imagingTurnaround.typical,
    admissionDecisionTypicalMinutes: baseScenario.timingProfile.admissionDecision.typical,
    boardingDurationTypicalMinutes: baseScenario.timingProfile.boardingDuration.typical,
    roomCleaningTypicalMinutes: baseScenario.timingProfile.roomCleaning.typical,
    admitBoardingDelayMinutes: Math.round(averageBoardingDelay),
    lwbsEnabled: baseScenario.lwbsProfile.enabled,
    minimumWaitBeforeLWBS: baseScenario.lwbsProfile.minimumWaitBeforeLWBS,
    patientAcuityMix: validPatientAcuityMix(baseScenario.patientMix?.acuity),
    patientComplaintMix: validPatientComplaintMix(baseScenario.patientMix?.complaint),
    patientWorkupMix: validPatientWorkupMix(baseScenario.patientMix?.workup),
    patientAdmissionMix: validPatientAdmissionMix(baseScenario.patientMix?.admission),
    patientMixSeed: baseScenario.patientMix?.seed ?? 1,
    stemiDoorToEcgTargetMinutes: baseScenario.workflowTimingProfile.stemiDoorToEcgTargetMinutes,
    acsDoorToEcgTargetMinutes: baseScenario.workflowTimingProfile.acsDoorToEcgTargetMinutes,
    repeatTroponinDelayMinutes: baseScenario.workflowTimingProfile.repeatTroponinDelayMinutes,
    sepsisLactateCollectionMinutes: baseScenario.workflowTimingProfile.sepsisLactateCollectionMinutes,
    sepsisBloodCultureMinutes: baseScenario.workflowTimingProfile.sepsisBloodCultureMinutes,
    sepsisAntibioticsMinutes: baseScenario.workflowTimingProfile.sepsisAntibioticsMinutes,
    sepsisFluidsMinutes: baseScenario.workflowTimingProfile.sepsisFluidsMinutes,
    sepsisCriticalWaitMinutes: baseScenario.workflowTimingProfile.sepsisCriticalWaitMinutes,
    deteriorationGraceMinutes: baseScenario.workflowTimingProfile.deteriorationGraceMinutes,
    coachPriorityMode: validCoachPriorityMode(baseScenario.coachPriorityProfile?.mode),
    coachAcuityWeight: baseScenario.coachPriorityProfile?.acuityWeight ?? 1000,
    coachRiskWeight: baseScenario.coachPriorityProfile?.riskWeight ?? 150,
    coachWaitWeight: baseScenario.coachPriorityProfile?.waitWeight ?? 1,
    coachStrategyPriorityProfiles: validCoachStrategyPriorityProfiles(baseScenario.coachStrategyPriorityProfiles),
  };
}

export function createScenarioFromTuning(
  tuning: ScenarioTuningConfig,
  baseScenario = defaultScenario,
): Scenario {
  const roomCapacity = boundedInteger(tuning.roomCapacity, 1, 40);
  const providerCount = boundedInteger(tuning.providerCount, 1, 4);
  const nurseCount = boundedInteger(tuning.nurseCount, 1, 4);
  const techCount = boundedInteger(tuning.techCount, 0, 2);
  const shiftDurationMinutes = boundedInteger(tuning.shiftDurationMinutes, 60, 2880);
  const expectedArrivalsPerHour = boundedInteger(tuning.expectedArrivalsPerHour, 0, 30);
  const providerEvaluationTypicalMinutes = boundedInteger(tuning.providerEvaluationTypicalMinutes, 1, 90);
  const triageTypicalMinutes = boundedInteger(tuning.triageTypicalMinutes, 1, 30);
  const labTurnaroundTypicalMinutes = boundedInteger(tuning.labTurnaroundTypicalMinutes, 1, 240);
  const imagingTurnaroundTypicalMinutes = boundedInteger(tuning.imagingTurnaroundTypicalMinutes, 1, 300);
  const admissionDecisionTypicalMinutes = boundedInteger(tuning.admissionDecisionTypicalMinutes, 1, 360);
  const boardingDurationTypicalMinutes = boundedInteger(tuning.boardingDurationTypicalMinutes, 0, 720);
  const roomCleaningTypicalMinutes = boundedInteger(tuning.roomCleaningTypicalMinutes, 0, 180);
  const minimumWaitBeforeLWBS = boundedInteger(tuning.minimumWaitBeforeLWBS, 0, 360);
  const patientAcuityMix = validPatientAcuityMix(tuning.patientAcuityMix);
  const patientComplaintMix = validPatientComplaintMix(tuning.patientComplaintMix);
  const patientWorkupMix = validPatientWorkupMix(tuning.patientWorkupMix);
  const patientAdmissionMix = validPatientAdmissionMix(tuning.patientAdmissionMix);
  const patientMixSeed = boundedInteger(tuning.patientMixSeed, 1, 9999);
  const stemiDoorToEcgTargetMinutes = boundedInteger(tuning.stemiDoorToEcgTargetMinutes, 1, 30);
  const acsDoorToEcgTargetMinutes = boundedInteger(tuning.acsDoorToEcgTargetMinutes, 1, 30);
  const repeatTroponinDelayMinutes = boundedInteger(tuning.repeatTroponinDelayMinutes, 15, 240);
  const sepsisLactateCollectionMinutes = boundedInteger(tuning.sepsisLactateCollectionMinutes, 1, 60);
  const sepsisBloodCultureMinutes = boundedInteger(tuning.sepsisBloodCultureMinutes, 1, 60);
  const sepsisAntibioticsMinutes = boundedInteger(tuning.sepsisAntibioticsMinutes, 1, 180);
  const sepsisFluidsMinutes = boundedInteger(tuning.sepsisFluidsMinutes, 1, 180);
  const sepsisCriticalWaitMinutes = boundedInteger(tuning.sepsisCriticalWaitMinutes, 1, 120);
  const deteriorationGraceMinutes = boundedInteger(tuning.deteriorationGraceMinutes, 1, 180);
  const coachPriorityMode = validCoachPriorityMode(tuning.coachPriorityMode);
  const coachAcuityWeight = boundedInteger(tuning.coachAcuityWeight, 0, 2000);
  const coachRiskWeight = boundedInteger(tuning.coachRiskWeight, 0, 500);
  const coachWaitWeight = boundedDecimal(tuning.coachWaitWeight, 0, 10);
  const coachStrategyPriorityProfiles = validCoachStrategyPriorityProfiles(
    tuning.coachStrategyPriorityProfiles,
    baseScenario.coachStrategyPriorityProfiles,
  );
  const boardingRange = timingRangeFromTypical(boardingDurationTypicalMinutes, 0.55, 2.4);
  const roomCleaningRange =
    roomCleaningTypicalMinutes === 0
      ? { min: 0, typical: 0, max: 0 }
      : timingRangeFromTypical(roomCleaningTypicalMinutes, 0.4, 2.25);

  return {
    ...baseScenario,
    triageProviderEnabled: tuning.triageProviderMode !== "unavailable",
    triageProviderMode: tuning.triageProviderMode,
    roomCapacity,
    providerCount,
    providerAssignmentMode: validProviderAssignmentMode(tuning.providerAssignmentMode),
    randomSeed: `${baseScenario.randomSeed}:patient-mix-${patientMixSeed}`,
    nurseCount,
    techCount,
    fastTrackEnabled: tuning.fastTrackEnabled,
    shiftDurationMinutes,
    triageDurationMultiplier: boundedDecimal(triageTypicalMinutes / baseScenario.timingProfile.triage.typical, 0.5, 2),
    timingProfile: {
      ...baseScenario.timingProfile,
      providerEvaluation: timingRangeFromTypical(providerEvaluationTypicalMinutes, 0.65, 1.85),
      triage: timingRangeFromTypical(triageTypicalMinutes, 0.6, 2),
      labTurnaround: timingRangeFromTypical(labTurnaroundTypicalMinutes, 0.7, 1.8),
      imagingTurnaround: timingRangeFromTypical(imagingTurnaroundTypicalMinutes, 0.65, 1.9),
      admissionDecision: timingRangeFromTypical(admissionDecisionTypicalMinutes, 0.45, 2.7),
      boardingDuration: boardingRange,
      roomCleaning: roomCleaningRange,
    },
    arrivalProfile: buildArrivalProfile(shiftDurationMinutes, expectedArrivalsPerHour),
    esiDistribution: esiDistributionForMix(patientAcuityMix),
    complaintDistribution: complaintDistributionForMix(patientComplaintMix),
    patientMix: {
      acuity: patientAcuityMix,
      admission: patientAdmissionMix,
      complaint: patientComplaintMix,
      seed: patientMixSeed,
      workup: patientWorkupMix,
    },
    workflowTimingProfile: {
      acsDoorToEcgTargetMinutes,
      deteriorationGraceMinutes,
      repeatTroponinDelayMinutes,
      sepsisAntibioticsMinutes,
      sepsisBloodCultureMinutes,
      sepsisCriticalWaitMinutes,
      sepsisFluidsMinutes,
      sepsisLactateCollectionMinutes,
      stemiDoorToEcgTargetMinutes,
    },
    coachPriorityProfile: {
      mode: coachPriorityMode,
      acuityWeight: coachAcuityWeight,
      riskWeight: coachRiskWeight,
      waitWeight: coachWaitWeight,
    },
    coachStrategyPriorityProfiles,
    boardingProfile: {
      ...baseScenario.boardingProfile,
      admitBoardingDelayMin: boardingRange.min,
      admitBoardingDelayMax: boardingRange.max,
    },
    lwbsProfile: {
      ...baseScenario.lwbsProfile,
      enabled: tuning.lwbsEnabled,
      minimumWaitBeforeLWBS,
    },
  };
}

export function getScenarioTuningPreset(
  presetId: ScenarioPresetId,
  baseScenario = defaultScenario,
): ScenarioTuningConfig {
  const defaults = getDefaultScenarioTuningConfig(baseScenario);

  switch (presetId) {
    case "boarding_surge":
      return {
        ...defaults,
        admitBoardingDelayMinutes: 150,
        boardingDurationTypicalMinutes: 150,
        expectedArrivalsPerHour: Math.max(defaults.expectedArrivalsPerHour + 1, 13),
      };
    case "high_arrivals":
      return {
        ...defaults,
        expectedArrivalsPerHour: Math.max(defaults.expectedArrivalsPerHour + 4, 16),
        lwbsEnabled: true,
        minimumWaitBeforeLWBS: 75,
      };
    case "low_room_capacity":
      return {
        ...defaults,
        roomCapacity: 4,
        lwbsEnabled: true,
        minimumWaitBeforeLWBS: 75,
      };
    default:
      return defaults;
  }
}
