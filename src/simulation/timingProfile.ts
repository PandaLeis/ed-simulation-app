import type { PertTimingRange } from "./types";
import type { SeededRandom } from "./seededRandom";

export const defaultTimingProfile = {
  providerEvaluation: { min: 8, typical: 12, max: 22 },
  triage: { min: 3, typical: 5, max: 10 },
  labTurnaround: { min: 35, typical: 45, max: 75 },
  imagingTurnaround: { min: 30, typical: 55, max: 95 },
  boardingDuration: { min: 35, typical: 63, max: 150 },
};

export function timingRangeFromTypical(typical: number, lowerRatio = 0.7, upperRatio = 1.8): PertTimingRange {
  const roundedTypical = Math.max(1, Math.round(typical));
  const min = Math.max(1, Math.round(roundedTypical * lowerRatio));
  const max = Math.max(min + 1, Math.round(roundedTypical * upperRatio));

  return {
    min,
    typical: roundedTypical,
    max,
  };
}

function normalSample(random: SeededRandom): number {
  const first = Math.max(Number.EPSILON, random.next());
  const second = random.next();
  return Math.sqrt(-2 * Math.log(first)) * Math.cos(2 * Math.PI * second);
}

function gammaSample(random: SeededRandom, shape: number): number {
  const d = shape - 1 / 3;
  const c = 1 / Math.sqrt(9 * d);

  for (let attempt = 0; attempt < 100; attempt += 1) {
    const x = normalSample(random);
    const v = (1 + c * x) ** 3;
    if (v <= 0) {
      continue;
    }

    const u = random.next();
    if (u < 1 - 0.0331 * x ** 4 || Math.log(u) < 0.5 * x * x + d * (1 - v + Math.log(v))) {
      return d * v;
    }
  }

  return shape;
}

export function samplePertDuration(random: SeededRandom, range: PertTimingRange): number {
  if (range.max <= range.min) {
    return Math.max(1, Math.round(range.typical));
  }

  const clampedTypical = Math.min(range.max, Math.max(range.min, range.typical));
  const lambda = 4;
  const alpha = 1 + (lambda * (clampedTypical - range.min)) / (range.max - range.min);
  const beta = 1 + (lambda * (range.max - clampedTypical)) / (range.max - range.min);
  const x = gammaSample(random, alpha);
  const y = gammaSample(random, beta);
  const betaSample = x / (x + y);

  return Math.max(1, Math.round(range.min + betaSample * (range.max - range.min)));
}
