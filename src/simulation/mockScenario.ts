import type { Scenario } from "./types";

export const defaultScenario: Scenario = {
  id: "scenario-default-evening-flow",
  name: "Single Provider Evening Flow",
  shiftStartMinute: 0,
  shiftDurationMinutes: 240,
  randomSeed: "ed-flow-mvp-001",
  roomCapacity: 8,
  providerCount: 1,
  triageProviderEnabled: true,
  arrivalProfile: [
    { hourOffset: 0, expectedArrivals: 5 },
    { hourOffset: 1, expectedArrivals: 7 },
    { hourOffset: 2, expectedArrivals: 6 },
    { hourOffset: 3, expectedArrivals: 4 },
  ],
  esiDistribution: {
    values: [
      { value: 2, weight: 15 },
      { value: 3, weight: 45 },
      { value: 4, weight: 30 },
      { value: 5, weight: 10 },
    ],
  },
  complaintDistribution: {
    values: [
      { value: "chest_pain", weight: 14 },
      { value: "abdominal_pain", weight: 16 },
      { value: "shortness_of_breath", weight: 12 },
      { value: "injury", weight: 18 },
      { value: "weakness_dizziness", weight: 12 },
      { value: "fever_infection", weight: 12 },
      { value: "behavioral_health", weight: 6 },
      { value: "minor_complaint", weight: 10 },
    ],
  },
  workupDistribution: {
    values: [
      { value: "none", weight: 10 },
      { value: "basic_labs", weight: 30 },
      { value: "labs_imaging", weight: 30 },
      { value: "cardiac", weight: 15 },
      { value: "complex", weight: 15 },
    ],
  },
  boardingProfile: {
    enabled: true,
    admitBoardingDelayMin: 35,
    admitBoardingDelayMax: 90,
  },
};
