import { samplePertDuration } from "./timingProfile";
import type { ESILevel, PertTimingRange, RuntimePatient } from "./types";
import type { SeededRandom } from "./seededRandom";

const providerEvaluationEsiMultipliers: Record<ESILevel, number> = {
  1: 1.8,
  2: 1.4,
  3: 1,
  4: 0.75,
  5: 0.55,
};

function scaleTimingRange(range: PertTimingRange, multiplier: number): PertTimingRange {
  const min = Math.max(1, Math.round(range.min * multiplier));
  const typical = Math.max(1, Math.round(range.typical * multiplier));
  const max = Math.max(min + 1, Math.round(range.max * multiplier));

  return {
    min,
    typical: Math.min(max, Math.max(min, typical)),
    max,
  };
}

export function getProviderEvaluationTimingRange(patient: RuntimePatient, baseRange: PertTimingRange): PertTimingRange {
  return scaleTimingRange(baseRange, providerEvaluationEsiMultipliers[patient.esi]);
}

export function getProviderEvaluationTypicalMinutes(patient: RuntimePatient, baseRange: PertTimingRange): number {
  return getProviderEvaluationTimingRange(patient, baseRange).typical;
}

export function sampleProviderEvaluationMinutes(
  random: SeededRandom,
  patient: RuntimePatient,
  baseRange: PertTimingRange,
): number {
  return samplePertDuration(random, getProviderEvaluationTimingRange(patient, baseRange));
}
