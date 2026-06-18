import { defaultScenario } from "./mockScenario";
import { timingRangeFromTypical } from "./timingProfile";
import type { HourlyArrivalProfile, Scenario, ScenarioPreset, ScenarioPresetId, ScenarioTuningConfig } from "./types";

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
