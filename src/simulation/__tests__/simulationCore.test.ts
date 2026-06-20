import assert from "node:assert/strict";
import test from "node:test";

import { getAvailableProviderActions } from "../actionRules";
import { activityRunsToCsv, activityTimelineToCsv, createActivityTimeline } from "../activityTimeline";
import { generatePatientDeck } from "../arrivalGenerator";
import { createFlowGuardrails } from "../flowGuardrails";
import { defaultScenario } from "../mockScenario";
import {
  createBenchmarkComparisonView,
  createOptimalFlowBenchmark,
  getBenchmarkCoachRecommendation,
  runCoachDemoActions,
  runBalancedOperationsCoachBenchmark,
  runDispositionFocusCoachBenchmark,
  runFastTrackCoachBenchmark,
  runFrontEndFocusCoachBenchmark,
  runMiddleFlowFocusCoachBenchmark,
  runOptimalFlowBenchmark,
  runResourceAwareCoachBenchmark,
  runSafetyFirstCoachBenchmark,
} from "../optimalFlowBenchmark";
import { createProviderDebrief } from "../providerDebrief";
import { getProviderEvaluationTimingRange } from "../providerEvaluation";
import { createScenarioFromTuning, getDefaultScenarioTuningConfig, getScenarioTuningPreset } from "../scenarioTuning";
import {
  advanceOneMinute,
  applyProviderAction,
  createSimulationRun,
  setFrontEndTriageProviderEnabled,
  setFrontEndTriageProviderMode,
  startSimulation,
} from "../simulationEngine";
import { getPatientWorkupSummary } from "../workupSummary";
import type { ComplaintCategory, ProviderActionType, RuntimePatient, Scenario, ScenarioPatient, SimulationRun } from "../types";

type ScenarioOverrides = Partial<Omit<Scenario, "boardingProfile" | "lwbsProfile">> & {
  boardingProfile?: Partial<Scenario["boardingProfile"]>;
  lwbsProfile?: Partial<Scenario["lwbsProfile"]>;
};

function scenarioWith(overrides: ScenarioOverrides): Scenario {
  return {
    ...defaultScenario,
    ...overrides,
    boardingProfile: {
      ...defaultScenario.boardingProfile,
      ...overrides.boardingProfile,
    },
    lwbsProfile: {
      ...defaultScenario.lwbsProfile,
      ...overrides.lwbsProfile,
    },
  };
}

const expandedComplaintCategories: ComplaintCategory[] = [
  "stroke_neuro",
  "sepsis_concern",
  "major_trauma",
  "pediatric",
  "ob_pregnancy",
  "syncope",
  "altered_mental_status",
  "overdose_intoxication",
  "renal_urinary",
  "gi_bleed",
  "allergic_reaction",
  "burn",
  "eye_ent",
  "back_pain",
  "hypertensive_symptoms",
  "diabetic_emergency",
  "social_placement",
];

function startedRun(scenario = defaultScenario): SimulationRun {
  return startSimulation(createSimulationRun(scenario, generatePatientDeck(scenario)));
}

function startedNoWorkupRun(scenario: Scenario): SimulationRun {
  const deck = generatePatientDeck(scenario).map((patient) => ({
    ...patient,
    workupType: "none" as const,
    expectedLabMinutes: 0,
    expectedImagingMinutes: 0,
  }));

  return startSimulation(createSimulationRun(scenario, deck));
}

function advanceTo(run: SimulationRun, scenario: Scenario, minute: number): SimulationRun {
  let nextRun = run;

  while (nextRun.currentMinute < minute) {
    nextRun = advanceOneMinute(nextRun, scenario);
  }

  return nextRun;
}

function runAction(
  run: SimulationRun,
  scenario: Scenario,
  actionType: ProviderActionType,
  patientId: string,
): SimulationRun {
  let nextRun = applyProviderAction(run, actionType, patientId);

  while (nextRun.provider.status === "busy") {
    nextRun = advanceOneMinute(nextRun, scenario);
  }

  return nextRun;
}

function runTriageAction(run: SimulationRun, scenario: Scenario, patientId: string): SimulationRun {
  let nextRun = applyProviderAction(run, "complete_triage", patientId);

  while (nextRun.triageProvider.status === "busy") {
    nextRun = advanceOneMinute(nextRun, scenario);
  }

  return nextRun;
}

function allProvidersIdle(run: SimulationRun): boolean {
  return run.providers.every((provider) => provider.status === "idle");
}

function firstPatientId(run: SimulationRun): string {
  const patient = run.patients.find((candidate) => candidate.state === "waiting");
  assert.ok(patient, "Expected at least one waiting patient.");
  return patient.id;
}

function firstTriagePatientId(run: SimulationRun): string {
  const patient = run.patients.find((candidate) => candidate.state === "triage");
  assert.ok(patient, "Expected at least one triage patient.");
  return patient.id;
}

function assertDefined<T>(value: T | undefined, message: string): asserts value is T {
  assert.notEqual(value, undefined, message);
}

function forceLWBSDeck(scenario: Scenario, overrides: Partial<ScenarioPatient> = {}) {
  return generatePatientDeck(scenario).map((patient) => ({
    ...patient,
    arrivalMinute: 0,
    esi: 5 as const,
    lwbsBaseRisk: 1,
    patienceProfile: "low" as const,
    ...overrides,
  }));
}

function chooseSmokeDemoPatient(run: SimulationRun): RuntimePatient | undefined {
  return (
    (run.triageProviderMode === "manual" && run.triageProvider.status === "idle"
      ? run.patients.find((patient) => patient.state === "triage")
      : undefined) ??
    run.patients.find((patient) => patient.state === "ready_for_disposition") ??
    run.patients.find((patient) => patient.state === "results_ready") ??
    run.patients.find((patient) => patient.state === "provider_seen") ??
    run.patients.find((patient) => patient.state === "roomed") ??
    run.patients.find((patient) => patient.state === "waiting")
  );
}

function chooseSmokeDemoAction(run: SimulationRun, patient: RuntimePatient) {
  const actions = getAvailableProviderActions(run, patient.id).filter((candidate) => candidate.enabled);
  return (
    actions.find((action) => action.type === "start_protocol_orders") ??
    actions.find((action) => action.type === "complete_triage") ??
    actions.find((action) => action.type !== "continue_waiting") ??
    actions[0]
  );
}

function runSmokeDemoLoop(): SimulationRun {
  const deck = generatePatientDeck(defaultScenario);
  let run = startSimulation(createSimulationRun(defaultScenario, deck));

  for (let minute = 0; minute < 120; minute += 1) {
    const actionablePatient = chooseSmokeDemoPatient(run);

    if (run.provider.status === "idle" && actionablePatient) {
      const action = chooseSmokeDemoAction(run, actionablePatient);
      if (action) {
        run = applyProviderAction(run, action.type, actionablePatient.id);
      }
    }

    run = advanceOneMinute(run, defaultScenario);
  }

  return run;
}

test("same seed creates the same patient deck", () => {
  const firstDeck = generatePatientDeck(defaultScenario);
  const secondDeck = generatePatientDeck(defaultScenario);

  assert.deepEqual(secondDeck, firstDeck);
  assert.equal(firstDeck.length, 48);
});

test("default training deck includes a deterministic randomized STEMI-alert patient", () => {
  const firstDeck = generatePatientDeck(defaultScenario);
  const secondDeck = generatePatientDeck(defaultScenario);
  const alternateSeedDeck = generatePatientDeck({
    ...defaultScenario,
    randomSeed: `${defaultScenario.randomSeed}-alternate`,
  });
  const firstStemiPatients = firstDeck.filter((patient) => patient.cardiacPathway === "stemi_alert");
  const alternateStemiPatients = alternateSeedDeck.filter((patient) => patient.cardiacPathway === "stemi_alert");

  assert.deepEqual(secondDeck, firstDeck);
  assert.equal(firstDeck.length, 48);
  assert.equal(firstStemiPatients.length >= defaultScenario.minimumStemiAlertPatients, true);
  assert.equal(
    firstStemiPatients.every(
      (patient) => patient.complaintCategory === "chest_pain" || patient.complaintCategory === "suspected_acs",
    ),
    true,
  );
  assert.notDeepEqual(
    alternateStemiPatients.map((patient) => patient.id),
    firstStemiPatients.map((patient) => patient.id),
  );
});

test("scenario tuning defaults are derived from the default scenario", () => {
  const tuning = getDefaultScenarioTuningConfig();
  const scenario = createScenarioFromTuning(tuning);

  assert.equal(tuning.triageProviderEnabled, defaultScenario.triageProviderEnabled);
  assert.equal(tuning.roomCapacity, defaultScenario.roomCapacity);
  assert.equal(tuning.providerCount, defaultScenario.providerCount);
  assert.equal(tuning.nurseCount, defaultScenario.nurseCount);
  assert.equal(tuning.techCount, defaultScenario.techCount);
  assert.equal(tuning.fastTrackEnabled, defaultScenario.fastTrackEnabled);
  assert.equal(tuning.shiftDurationMinutes, defaultScenario.shiftDurationMinutes);
  assert.equal(tuning.expectedArrivalsPerHour, 12);
  assert.equal(tuning.triageDurationMultiplier, defaultScenario.triageDurationMultiplier);
  assert.equal(tuning.providerEvaluationTypicalMinutes, 12);
  assert.equal(tuning.triageTypicalMinutes, 5);
  assert.equal(tuning.labTurnaroundTypicalMinutes, 45);
  assert.equal(tuning.imagingTurnaroundTypicalMinutes, 55);
  assert.equal(tuning.admissionDecisionTypicalMinutes, 45);
  assert.equal(tuning.boardingDurationTypicalMinutes, 63);
  assert.equal(tuning.roomCleaningTypicalMinutes, 20);
  assert.equal(tuning.admitBoardingDelayMinutes, 63);
  assert.equal(tuning.lwbsEnabled, defaultScenario.lwbsProfile.enabled);
  assert.equal(tuning.minimumWaitBeforeLWBS, defaultScenario.lwbsProfile.minimumWaitBeforeLWBS);
  assert.equal(tuning.coachPriorityMode, defaultScenario.coachPriorityProfile.mode);
  assert.equal(tuning.coachAcuityWeight, defaultScenario.coachPriorityProfile.acuityWeight);
  assert.equal(tuning.coachRiskWeight, defaultScenario.coachPriorityProfile.riskWeight);
  assert.equal(tuning.coachWaitWeight, defaultScenario.coachPriorityProfile.waitWeight);
  assert.deepEqual(tuning.coachStrategyPriorityProfiles, defaultScenario.coachStrategyPriorityProfiles);
  assert.equal(scenario.roomCapacity, defaultScenario.roomCapacity);
  assert.equal(scenario.providerCount, defaultScenario.providerCount);
  assert.equal(scenario.nurseCount, defaultScenario.nurseCount);
  assert.equal(scenario.techCount, defaultScenario.techCount);
  assert.equal(scenario.fastTrackEnabled, defaultScenario.fastTrackEnabled);
  assert.equal(scenario.shiftDurationMinutes, defaultScenario.shiftDurationMinutes);
  assert.equal(scenario.arrivalProfile.length, 4);
});

test("scenario tuning changes capacity, volume, shift length, and boarding delay deterministically", () => {
  const tuning = {
    ...getDefaultScenarioTuningConfig(),
    triageProviderEnabled: false,
    triageProviderMode: "unavailable" as const,
    roomCapacity: 3,
    providerCount: 2,
    nurseCount: 1,
    techCount: 1,
    fastTrackEnabled: false,
    shiftDurationMinutes: 180,
    expectedArrivalsPerHour: 4,
    providerEvaluationTypicalMinutes: 15,
    triageTypicalMinutes: 8,
    labTurnaroundTypicalMinutes: 55,
    imagingTurnaroundTypicalMinutes: 70,
    admissionDecisionTypicalMinutes: 40,
    boardingDurationTypicalMinutes: 45,
    roomCleaningTypicalMinutes: 25,
    admitBoardingDelayMinutes: 45,
    lwbsEnabled: true,
    minimumWaitBeforeLWBS: 30,
    stemiDoorToEcgTargetMinutes: 4,
    acsDoorToEcgTargetMinutes: 9,
    repeatTroponinDelayMinutes: 90,
    sepsisLactateCollectionMinutes: 6,
    sepsisBloodCultureMinutes: 9,
    sepsisAntibioticsMinutes: 40,
    sepsisFluidsMinutes: 25,
    sepsisCriticalWaitMinutes: 15,
    deteriorationGraceMinutes: 45,
    coachPriorityMode: "throughput" as const,
    coachAcuityWeight: 800,
    coachRiskWeight: 100,
    coachWaitWeight: 3,
    coachStrategyPriorityProfiles: {
      ...getDefaultScenarioTuningConfig().coachStrategyPriorityProfiles,
      safety_first: {
        mode: "safety_first" as const,
        acuityWeight: 1500,
        riskWeight: 425,
        waitWeight: 2,
      },
    },
  };
  const scenario = createScenarioFromTuning(tuning);
  const firstDeck = generatePatientDeck(scenario);
  const secondDeck = generatePatientDeck(scenario);
  const run = createSimulationRun(scenario, firstDeck);

  assert.equal(scenario.triageProviderEnabled, false);
  assert.equal(scenario.roomCapacity, 3);
  assert.equal(scenario.providerCount, 2);
  assert.equal(scenario.nurseCount, 1);
  assert.equal(scenario.techCount, 1);
  assert.equal(scenario.fastTrackEnabled, false);
  assert.equal(scenario.shiftDurationMinutes, 180);
  assert.equal(scenario.triageDurationMultiplier, 1.6);
  assert.equal(scenario.timingProfile.providerEvaluation.typical, 15);
  assert.equal(scenario.timingProfile.triage.typical, 8);
  assert.equal(scenario.timingProfile.labTurnaround.typical, 55);
  assert.equal(scenario.timingProfile.imagingTurnaround.typical, 70);
  assert.equal(scenario.timingProfile.admissionDecision.typical, 40);
  assert.equal(scenario.timingProfile.boardingDuration.typical, 45);
  assert.equal(scenario.timingProfile.roomCleaning.typical, 25);
  assert.deepEqual(scenario.workflowTimingProfile, {
    acsDoorToEcgTargetMinutes: 9,
    deteriorationGraceMinutes: 45,
    repeatTroponinDelayMinutes: 90,
    sepsisAntibioticsMinutes: 40,
    sepsisBloodCultureMinutes: 9,
    sepsisCriticalWaitMinutes: 15,
    sepsisFluidsMinutes: 25,
    sepsisLactateCollectionMinutes: 6,
    stemiDoorToEcgTargetMinutes: 4,
  });
  assert.deepEqual(scenario.coachPriorityProfile, {
    mode: "throughput",
    acuityWeight: 800,
    riskWeight: 100,
    waitWeight: 3,
  });
  assert.deepEqual(scenario.coachStrategyPriorityProfiles.safety_first, {
    mode: "safety_first",
    acuityWeight: 1500,
    riskWeight: 425,
    waitWeight: 2,
  });
  assert.deepEqual(scenario.arrivalProfile, [
    { hourOffset: 0, expectedArrivals: 4 },
    { hourOffset: 1, expectedArrivals: 4 },
    { hourOffset: 2, expectedArrivals: 4 },
  ]);
  assert.equal(firstDeck.length, 12);
  assert.deepEqual(secondDeck, firstDeck);
  assert.equal(
    firstDeck.every(
      (patient) =>
        patient.expectedBoardingMinutes >= scenario.timingProfile.boardingDuration.min &&
        patient.expectedBoardingMinutes <= scenario.timingProfile.boardingDuration.max &&
        patient.expectedAdmissionDecisionMinutes >= scenario.timingProfile.admissionDecision.min &&
        patient.expectedAdmissionDecisionMinutes <= scenario.timingProfile.admissionDecision.max &&
        patient.expectedRoomCleaningMinutes >= scenario.timingProfile.roomCleaning.min &&
        patient.expectedRoomCleaningMinutes <= scenario.timingProfile.roomCleaning.max,
    ),
    true,
  );
  assert.equal(scenario.lwbsProfile.enabled, true);
  assert.equal(scenario.lwbsProfile.minimumWaitBeforeLWBS, 30);
  assert.equal(run.rooms.length, 3);
  assert.equal(run.supportResources.find((pool) => pool.role === "nurse")?.total, 1);
  assert.equal(run.supportResources.find((pool) => pool.role === "tech")?.total, 1);
  assert.equal(run.fastTrackEnabled, false);
  assert.equal(run.metrics.availableRooms, 3);
});

test("scenario tuning supports four providers and forty-eight hour simulation windows", () => {
  const tuning = {
    ...getDefaultScenarioTuningConfig(),
    providerCount: 4,
    shiftDurationMinutes: 2880,
    expectedArrivalsPerHour: 1,
  };
  const scenario = createScenarioFromTuning(tuning);
  const deck = generatePatientDeck(scenario);
  const run = createSimulationRun(scenario, deck);

  assert.equal(scenario.providerCount, 4);
  assert.equal(scenario.shiftDurationMinutes, 2880);
  assert.equal(scenario.arrivalProfile.length, 48);
  assert.equal(deck.length, 48);
  assert.equal(run.providers.length, 4);
});

test("scenario tuning bounds nurse and tech counts to UI-supported ranges", () => {
  const highScenario = createScenarioFromTuning({
    ...getDefaultScenarioTuningConfig(),
    nurseCount: 12,
    techCount: 12,
  });
  const lowScenario = createScenarioFromTuning({
    ...getDefaultScenarioTuningConfig(),
    nurseCount: 0,
    techCount: -1,
  });

  assert.equal(highScenario.nurseCount, 4);
  assert.equal(highScenario.techCount, 2);
  assert.equal(lowScenario.nurseCount, 1);
  assert.equal(lowScenario.techCount, 0);
});

test("patient mix tuning changes synthetic deck composition while preserving deterministic seeds", () => {
  const baseTuning = {
    ...getDefaultScenarioTuningConfig(),
    shiftDurationMinutes: 720,
    expectedArrivalsPerHour: 30,
    patientMixSeed: 7,
  };
  const standardScenario = createScenarioFromTuning(baseTuning);
  const repeatedStandardDeck = generatePatientDeck(standardScenario);
  const standardDeck = generatePatientDeck(standardScenario);
  const differentSeedDeck = generatePatientDeck(createScenarioFromTuning({ ...baseTuning, patientMixSeed: 8 }));
  const higherAcuityDeck = generatePatientDeck(createScenarioFromTuning({ ...baseTuning, patientAcuityMix: "higher_acuity" }));
  const lowerAcuityDeck = generatePatientDeck(createScenarioFromTuning({ ...baseTuning, patientAcuityMix: "lower_acuity" }));
  const cardiacDeck = generatePatientDeck(createScenarioFromTuning({ ...baseTuning, patientComplaintMix: "cardiac" }));
  const infectionDeck = generatePatientDeck(createScenarioFromTuning({ ...baseTuning, patientComplaintMix: "infection" }));
  const higherWorkupDeck = generatePatientDeck(createScenarioFromTuning({ ...baseTuning, patientWorkupMix: "higher_workup" }));
  const lowerWorkupDeck = generatePatientDeck(createScenarioFromTuning({ ...baseTuning, patientWorkupMix: "lower_workup" }));
  const higherAdmitDeck = generatePatientDeck(createScenarioFromTuning({ ...baseTuning, patientAdmissionMix: "higher_admit" }));
  const lowerAdmitDeck = generatePatientDeck(createScenarioFromTuning({ ...baseTuning, patientAdmissionMix: "lower_admit" }));

  const highAcuityCount = (deck: ScenarioPatient[]) => deck.filter((patient) => patient.esi <= 2).length;
  const cardiacComplaintCount = (deck: ScenarioPatient[]) =>
    deck.filter((patient) => patient.complaintCategory === "chest_pain" || patient.complaintCategory === "suspected_acs").length;
  const infectionComplaintCount = (deck: ScenarioPatient[]) =>
    deck.filter((patient) => patient.complaintCategory === "fever_infection" || patient.complaintCategory === "sepsis_concern").length;
  const highWorkupCount = (deck: ScenarioPatient[]) =>
    deck.filter((patient) => patient.workupType === "cardiac" || patient.workupType === "complex" || patient.workupType === "labs_imaging").length;
  const averageAdmitProbability = (deck: ScenarioPatient[]) =>
    deck.reduce((sum, patient) => sum + patient.admitProbability, 0) / Math.max(1, deck.length);

  assert.deepEqual(repeatedStandardDeck, standardDeck);
  assert.notDeepEqual(differentSeedDeck, standardDeck);
  assert.equal(standardScenario.patientMix.seed, 7);
  assert.equal(standardDeck.length, 360);
  assert.equal(highAcuityCount(higherAcuityDeck) > highAcuityCount(lowerAcuityDeck), true);
  assert.equal(cardiacComplaintCount(cardiacDeck) > cardiacComplaintCount(standardDeck), true);
  assert.equal(infectionComplaintCount(infectionDeck) > infectionComplaintCount(standardDeck), true);
  assert.equal(highWorkupCount(higherWorkupDeck) > highWorkupCount(lowerWorkupDeck), true);
  assert.equal(averageAdmitProbability(higherAdmitDeck) > averageAdmitProbability(lowerAdmitDeck), true);
});

test("scenario presets configure requested operational stressors", () => {
  const boardingSurge = getScenarioTuningPreset("boarding_surge");
  const highArrivals = getScenarioTuningPreset("high_arrivals");
  const lowRoomCapacity = getScenarioTuningPreset("low_room_capacity");

  assert.equal(boardingSurge.admitBoardingDelayMinutes, 150);
  assert.equal(boardingSurge.expectedArrivalsPerHour, 13);
  assert.equal(highArrivals.expectedArrivalsPerHour, 16);
  assert.equal(highArrivals.lwbsEnabled, true);
  assert.equal(lowRoomCapacity.roomCapacity, 4);
  assert.equal(lowRoomCapacity.lwbsEnabled, true);
});

test("scenario presets build deterministic scenario decks", () => {
  const highArrivalScenario = createScenarioFromTuning(getScenarioTuningPreset("high_arrivals"));
  const lowRoomScenario = createScenarioFromTuning(getScenarioTuningPreset("low_room_capacity"));
  const firstDeck = generatePatientDeck(highArrivalScenario);
  const secondDeck = generatePatientDeck(highArrivalScenario);
  const lowRoomRun = createSimulationRun(lowRoomScenario, generatePatientDeck(lowRoomScenario));

  assert.equal(firstDeck.length, 64);
  assert.deepEqual(secondDeck, firstDeck);
  assert.equal(lowRoomRun.rooms.length, 4);
  assert.equal(lowRoomRun.metrics.availableRooms, 4);
});

test("tuned scenario flow stays deterministic across matching runs", () => {
  const tuning = {
    ...getDefaultScenarioTuningConfig(),
    triageProviderEnabled: false,
    triageProviderMode: "unavailable" as const,
    roomCapacity: 2,
    shiftDurationMinutes: 120,
    expectedArrivalsPerHour: 2,
    admitBoardingDelayMinutes: 30,
  };
  const scenario = createScenarioFromTuning(tuning);
  const deck = generatePatientDeck(scenario);
  let firstRun = startSimulation(createSimulationRun(scenario, deck));
  let secondRun = startSimulation(createSimulationRun(scenario, generatePatientDeck(scenario)));

  for (let minute = 0; minute < 90; minute += 1) {
    firstRun = advanceOneMinute(firstRun, scenario);
    secondRun = advanceOneMinute(secondRun, scenario);
  }

  assert.deepEqual(
    secondRun.patients.map((patient) => ({
      id: patient.id,
      arrivalMinute: patient.arrivalMinute,
      state: patient.state,
      arrivalPath: patient.arrivalPath,
      arrivedAt: patient.arrivedAt,
    })),
    firstRun.patients.map((patient) => ({
      id: patient.id,
      arrivalMinute: patient.arrivalMinute,
      state: patient.state,
      arrivalPath: patient.arrivalPath,
      arrivedAt: patient.arrivedAt,
    })),
  );
  assert.deepEqual(secondRun.metrics, firstRun.metrics);
});

test("same scenario seed creates the same patient deck but unique run ids", () => {
  const firstDeck = generatePatientDeck(defaultScenario);
  const secondDeck = generatePatientDeck(defaultScenario);
  const firstRun = createSimulationRun(defaultScenario, firstDeck);
  const secondRun = createSimulationRun(defaultScenario, secondDeck);

  assert.deepEqual(secondDeck, firstDeck);
  assert.notEqual(secondRun.id, firstRun.id);
  assert.equal(secondRun.scenarioId, firstRun.scenarioId);
});

test("complaint categories influence synthetic workup bundle mix", () => {
  const chestPainScenario = scenarioWith({
    randomSeed: "complaint-workup-chest-pain",
    arrivalProfile: [{ hourOffset: 0, expectedArrivals: 80 }],
    complaintDistribution: { values: [{ value: "chest_pain", weight: 1 }] },
  });
  const minorComplaintScenario = scenarioWith({
    randomSeed: "complaint-workup-minor",
    arrivalProfile: [{ hourOffset: 0, expectedArrivals: 80 }],
    complaintDistribution: { values: [{ value: "minor_complaint", weight: 1 }] },
  });

  const chestPainDeck = generatePatientDeck(chestPainScenario);
  const minorComplaintDeck = generatePatientDeck(minorComplaintScenario);
  const chestPainCardiacCount = chestPainDeck.filter((patient) => patient.workupType === "cardiac").length;
  const minorComplaintNoWorkupCount = minorComplaintDeck.filter((patient) => patient.workupType === "none").length;

  assert.equal(chestPainDeck.every((patient) => patient.complaintCategory === "chest_pain"), true);
  assert.equal(minorComplaintDeck.every((patient) => patient.complaintCategory === "minor_complaint"), true);
  assert.ok(chestPainCardiacCount > chestPainDeck.length / 2);
  assert.ok(minorComplaintNoWorkupCount > minorComplaintDeck.length / 2);
});

test("expanded complaint taxonomy generates deterministic synthetic presentations", () => {
  for (const complaintCategory of expandedComplaintCategories) {
    const scenario = scenarioWith({
      randomSeed: `expanded-complaint-${complaintCategory}`,
      arrivalProfile: [{ hourOffset: 0, expectedArrivals: 12 }],
      complaintDistribution: { values: [{ value: complaintCategory, weight: 1 }] },
    });

    const firstDeck = generatePatientDeck(scenario);
    const secondDeck = generatePatientDeck(scenario);

    assert.deepEqual(secondDeck, firstDeck);
    assert.equal(firstDeck.every((patient) => patient.complaintCategory === complaintCategory), true);
    assert.equal(firstDeck.every((patient) => patient.workupType !== undefined), true);
    assert.equal(firstDeck.every((patient) => patient.expectedBoardingMinutes >= scenario.timingProfile.boardingDuration.min), true);
  }
});

test("time-sensitive expanded complaints bias toward higher acuity and operational workups", () => {
  const timeSensitiveComplaints: ComplaintCategory[] = [
    "stroke_neuro",
    "sepsis_concern",
    "major_trauma",
    "altered_mental_status",
    "diabetic_emergency",
  ];

  for (const complaintCategory of timeSensitiveComplaints) {
    const scenario = scenarioWith({
      randomSeed: `time-sensitive-${complaintCategory}`,
      arrivalProfile: [{ hourOffset: 0, expectedArrivals: 60 }],
      complaintDistribution: { values: [{ value: complaintCategory, weight: 1 }] },
    });
    const deck = generatePatientDeck(scenario);
    const highAcuityCount = deck.filter((patient) => patient.esi <= 3).length;
    const complexWorkupCount = deck.filter((patient) => patient.workupType === "complex" || patient.workupType === "labs_imaging").length;

    assert.ok(highAcuityCount > deck.length * 0.8, `${complaintCategory} should skew ESI 1-3`);
    assert.ok(complexWorkupCount > deck.length * 0.5, `${complaintCategory} should skew complex or labs/imaging workups`);
  }
});

test("suspected ACS patients are high-acuity and cardiac-workup heavy", () => {
  const scenario = scenarioWith({
    randomSeed: "complaint-workup-suspected-acs",
    arrivalProfile: [{ hourOffset: 0, expectedArrivals: 40 }],
    complaintDistribution: { values: [{ value: "suspected_acs", weight: 1 }] },
  });

  const deck = generatePatientDeck(scenario);
  const secondDeck = generatePatientDeck(scenario);
  const cardiacWorkupCount = deck.filter((patient) => patient.workupType === "cardiac").length;

  assert.deepEqual(secondDeck, deck);
  assert.equal(deck.every((patient) => patient.complaintCategory === "suspected_acs"), true);
  assert.equal(deck.every((patient) => patient.esi <= 3), true);
  assert.ok(cardiacWorkupCount > deck.length * 0.7);
  assert.equal(deck.filter((patient) => patient.cardiacPathway !== "none").length, cardiacWorkupCount);
  assert.ok(deck.some((patient) => patient.cardiacPathway === "stemi_alert"));
});

test("complaint-informed workup selection remains deterministic", () => {
  const scenario = scenarioWith({
    randomSeed: "complaint-workup-deterministic",
    arrivalProfile: [{ hourOffset: 0, expectedArrivals: 30 }],
    complaintDistribution: {
      values: [
        { value: "chest_pain", weight: 1 },
        { value: "injury", weight: 1 },
        { value: "minor_complaint", weight: 1 },
      ],
    },
  });

  const firstDeck = generatePatientDeck(scenario).map((patient) => ({
    complaintCategory: patient.complaintCategory,
    workupType: patient.workupType,
    cardiacPathway: patient.cardiacPathway,
    expectedLabMinutes: patient.expectedLabMinutes,
    expectedImagingMinutes: patient.expectedImagingMinutes,
  }));
  const secondDeck = generatePatientDeck(scenario).map((patient) => ({
    complaintCategory: patient.complaintCategory,
    workupType: patient.workupType,
    cardiacPathway: patient.cardiacPathway,
    expectedLabMinutes: patient.expectedLabMinutes,
    expectedImagingMinutes: patient.expectedImagingMinutes,
  }));

  assert.deepEqual(secondDeck, firstDeck);
});

test("patient workup summary exposes bundle and pending order details", () => {
  const scenario = scenarioWith({
    triageProviderEnabled: true,
    triageProviderMode: "manual",
    minimumStemiAlertPatients: 0,
    arrivalProfile: [{ hourOffset: 0, expectedArrivals: 1 }],
    complaintDistribution: { values: [{ value: "chest_pain", weight: 1 }] },
  });
  let run = startedRun(scenario);
  run = advanceTo(run, scenario, 60);

  const patientId = firstTriagePatientId(run);
  run = applyProviderAction(run, "start_protocol_orders", patientId);

  const patient = run.patients.find((candidate) => candidate.id === patientId);
  assertDefined(patient, "Expected protocol-order patient.");
  const summary = getPatientWorkupSummary(patient);

  assert.equal(summary.reason, "chest pain synthetic bundle");
  assert.notEqual(summary.label, "No protocol workup");
  assert.ok(summary.expectedOrders.length > 0);
  assert.equal(summary.protocolStatus, "pending");
  assert.ok(summary.namedOrders.length > 0);
  assert.equal(summary.namedOrders.every((order) => order.category !== "boarding_bed"), true);
  assert.equal(summary.namedOrders.every((order) => order.status === "pending"), true);
  assert.equal(summary.pendingOrders.length, patient.pendingItems.length);
  assert.equal(summary.pendingOrders.every((order) => order.status === "pending"), true);
});

test("patient workup summary marks protocol results ready while waiting", () => {
  const scenario = scenarioWith({
    triageProviderEnabled: true,
    triageProviderMode: "manual",
    minimumStemiAlertPatients: 0,
    arrivalProfile: [{ hourOffset: 0, expectedArrivals: 1 }],
    complaintDistribution: { values: [{ value: "chest_pain", weight: 1 }] },
  });
  let run = startedRun(scenario);
  run = advanceTo(run, scenario, 60);

  const patientId = firstTriagePatientId(run);
  run = applyProviderAction(run, "start_protocol_orders", patientId);
  run = runTriageAction(run, scenario, patientId);
  run = advanceTo(run, scenario, run.currentMinute + 90);

  const patient = run.patients.find((candidate) => candidate.id === patientId);
  assertDefined(patient, "Expected waiting patient with protocol orders.");
  const summary = getPatientWorkupSummary(patient);

  assert.equal(patient.state, "waiting");
  assert.equal(summary.protocolStatus, "ready");
  assert.equal(summary.namedOrders.every((order) => order.status === "ready"), true);
  assert.equal(summary.flowImpact.includes("still waiting"), true);
});

test("patient workup summary labels available protocols before orders start", () => {
  const scenario = scenarioWith({
    triageProviderEnabled: true,
    triageProviderMode: "manual",
    arrivalProfile: [{ hourOffset: 0, expectedArrivals: 1 }],
    complaintDistribution: { values: [{ value: "abdominal_pain", weight: 1 }] },
  });
  let run = startedRun(scenario);
  run = advanceTo(run, scenario, 60);

  const patient = run.patients.find((candidate) => candidate.state === "triage");
  assertDefined(patient, "Expected front-end triage patient.");
  const summary = getPatientWorkupSummary(patient);

  assert.equal(summary.protocolStatus, "identified");
  assert.equal(summary.protocolStatusLabel, "Protocol available");
  assert.equal(summary.flowImpact, "Protocol orders are available for front-end triage but have not been started yet.");
});

test("provider debrief starts with no-decision feedback", () => {
  const run = createSimulationRun(defaultScenario, generatePatientDeck(defaultScenario));
  const debrief = createProviderDebrief(run);

  assert.equal(debrief.headline, "0 seen, 0 departed, 0 LWBS");
  assert.equal(debrief.bottlenecks.some((item) => item.title === "No major bottleneck flagged"), true);
  assert.equal(debrief.decisionFeedback.some((item) => item.title === "No provider decisions yet"), true);
  assert.equal(debrief.notablePatients.length, 0);
});

test("provider debrief surfaces bottlenecks, decisions, and notable patient timelines", () => {
  const scenario = scenarioWith({
    triageProviderEnabled: false,
    arrivalProfile: [{ hourOffset: 0, expectedArrivals: 1 }],
    lwbsProfile: {
      enabled: true,
      minimumWaitBeforeLWBS: 10,
      lowPatienceMultiplier: 10,
      highAcuityBlockedEsiLevels: [],
    },
  });
  let run = startSimulation(createSimulationRun(scenario, forceLWBSDeck(scenario, { complaintCategory: "chest_pain" })));
  run = advanceTo(run, scenario, 12);
  run = {
    ...run,
    decisions: [
      {
        id: `${run.id}-decision-test-1`,
        runId: run.id,
        simulationMinute: 1,
        actionType: "room_patient",
        actionLabel: "Room patient",
        timeCostMinutes: 2,
      },
      {
        id: `${run.id}-decision-test-2`,
        runId: run.id,
        simulationMinute: 2,
        actionType: "start_protocol_orders",
        actionLabel: "Start protocol orders",
        timeCostMinutes: 0,
      },
    ],
  };

  const debrief = createProviderDebrief(run);

  assert.equal(debrief.bottlenecks.some((item) => item.title === "LWBS occurred"), true);
  assert.equal(debrief.decisionFeedback.some((item) => item.title === "Rooming decisions made"), true);
  assert.equal(debrief.decisionFeedback.some((item) => item.title === "Protocol orders used"), true);
  assert.equal(debrief.notablePatients.some((item) => item.label === "LWBS"), true);
});

test("flow guardrails flag idle providers with actionable patients", () => {
  const scenario = scenarioWith({
    triageProviderEnabled: false,
    arrivalProfile: [{ hourOffset: 0, expectedArrivals: 1 }],
    timingProfile: {
      ...defaultScenario.timingProfile,
      roomCleaning: { min: 5, typical: 5, max: 5 },
    },
  });
  let run = startedNoWorkupRun(scenario);
  run = advanceTo(run, scenario, 60);

  const summary = createFlowGuardrails(run);

  assert.equal(summary.activeCount > 0, true);
  assert.equal(summary.guardrails.some((item) => item.title === "Idle provider with actionable flow work"), true);
});

test("flow guardrails flag roomed unseen patients with delayed provider evaluation", () => {
  const scenario = scenarioWith({
    triageProviderEnabled: false,
    arrivalProfile: [{ hourOffset: 0, expectedArrivals: 1 }],
  });
  let run = startedRun(scenario);
  run = {
    ...run,
    currentMinute: 45,
    patients: run.patients.map((patient, index) =>
      index === 0
        ? {
            ...patient,
            state: "roomed" as const,
            arrivedAt: 0,
            roomedAt: 20,
            roomId: "room-01",
          }
        : patient,
    ),
    rooms: [{ id: "room-01", status: "occupied", patientId: run.patients[0]?.id }],
  };

  const summary = createFlowGuardrails(run);

  assert.equal(summary.guardrails.some((item) => item.title === "Roomed patient not yet seen"), true);
});

test("flow guardrails flag aging front-end triage backlog", () => {
  const scenario = scenarioWith({
    triageProviderEnabled: true,
    triageProviderMode: "automated",
    arrivalProfile: [{ hourOffset: 0, expectedArrivals: 1 }],
  });
  let run = startedRun(scenario);
  run = {
    ...run,
    currentMinute: 65,
    patients: run.patients.map((patient, index) =>
      index === 0
        ? {
            ...patient,
            state: "triage" as const,
            arrivedAt: 0,
            triagedAt: undefined,
          }
        : patient,
    ),
  };

  const summary = createFlowGuardrails(run);
  const guardrail = summary.guardrails.find((item) => item.title === "Front-end triage backlog is aging");

  assert.notEqual(guardrail, undefined);
  assert.equal(guardrail?.severity, "urgent");
  assert.equal(guardrail?.metricValue, "65 min");
});

test("flow guardrails flag results-ready, disposition-ready, capacity, and boarding pressure", () => {
  const scenario = scenarioWith({
    triageProviderEnabled: false,
    roomCapacity: 3,
    arrivalProfile: [{ hourOffset: 0, expectedArrivals: 3 }],
  });
  let run = startedRun(scenario);
  run = {
    ...run,
    currentMinute: 80,
    patients: run.patients.map((patient, index) => {
      if (index === 0) {
        return {
          ...patient,
          state: "results_ready" as const,
          arrivedAt: 0,
          roomedAt: 10,
          providerSeenAt: 20,
          ordersPlacedAt: 25,
          resultsReadyAt: 50,
          roomId: "room-01",
          pendingItems: [{ type: "labs" as const, orderedAt: 25, readyAt: 50, status: "ready" as const }],
        };
      }

      if (index === 1) {
        return {
          ...patient,
          state: "ready_for_disposition" as const,
          arrivedAt: 5,
          roomedAt: 15,
          providerSeenAt: 25,
          resultsReadyAt: 40,
          roomId: "room-02",
        };
      }

      return {
        ...patient,
        state: "waiting" as const,
        arrivedAt: 10,
        riskLevel: "high" as const,
      };
    }),
    rooms: [
      { id: "room-01", status: "occupied", patientId: run.patients[0]?.id },
      { id: "room-02", status: "blocked", patientId: run.patients[1]?.id },
      { id: "room-03", status: "available" },
    ],
    metrics: {
      ...run.metrics,
      availableRooms: 1,
      blockedRooms: 1,
      totalBoardingMinutes: 70,
    },
  };

  const summary = createFlowGuardrails(run);

  assert.equal(summary.guardrails.some((item) => item.title === "Results ready for review"), true);
  assert.equal(summary.guardrails.some((item) => item.title === "Disposition can release or define room status"), true);
  assert.equal(summary.guardrails.some((item) => item.title === "High-risk waiting patient with room capacity"), true);
  assert.equal(summary.guardrails.some((item) => item.title === "Boarding is consuming room capacity"), true);
});

test("automated triage prioritizes aged triage patients over newer high-acuity patients", () => {
  const scenario = scenarioWith({
    triageProviderEnabled: true,
    triageProviderMode: "automated",
    arrivalProfile: [{ hourOffset: 0, expectedArrivals: 2 }],
    complaintDistribution: { values: [{ value: "minor_complaint", weight: 1 }] },
    minimumStemiAlertPatients: 0,
  });
  let run = startedRun(scenario);
  run = {
    ...run,
    currentMinute: 80,
    patients: run.patients.map((patient, index) => {
      if (index === 0) {
        return {
          ...patient,
          id: "patient-old",
          patientNumber: 1,
          state: "triage" as const,
          arrivedAt: 0,
          esi: 5 as const,
          expectedLabMinutes: 0,
          expectedImagingMinutes: 0,
          workupType: "none" as const,
          cardiacPathway: "none" as const,
        };
      }

      return {
        ...patient,
        id: "patient-new",
        patientNumber: 2,
        state: "triage" as const,
        arrivedAt: 79,
        esi: 2 as const,
        expectedLabMinutes: 0,
        expectedImagingMinutes: 0,
        workupType: "none" as const,
        cardiacPathway: "none" as const,
      };
    }),
  };

  run = advanceOneMinute(run, scenario);

  assert.equal(run.triageProvider.status, "busy");
  assert.equal(run.triageProvider.currentAction?.patientId, "patient-old");
});

test("optimal flow benchmark is deterministic for the same scenario deck", () => {
  const scenario = scenarioWith({
    triageProviderEnabled: true,
    roomCapacity: 2,
    providerCount: 1,
    shiftDurationMinutes: 120,
    arrivalProfile: [{ hourOffset: 0, expectedArrivals: 3 }],
    lwbsProfile: {
      enabled: false,
    },
  });
  const deck = generatePatientDeck(scenario);
  const firstBenchmark = runOptimalFlowBenchmark(scenario, deck);
  const secondBenchmark = runOptimalFlowBenchmark(scenario, deck);

  assert.deepEqual(
    secondBenchmark.patients.map((patient) => ({
      id: patient.id,
      state: patient.state,
      triagedAt: patient.triagedAt,
      roomedAt: patient.roomedAt,
      providerSeenAt: patient.providerSeenAt,
      dispositionDecisionAt: patient.dispositionDecisionAt,
      departedAt: patient.departedAt,
      lwbsAt: patient.lwbsAt,
    })),
    firstBenchmark.patients.map((patient) => ({
      id: patient.id,
      state: patient.state,
      triagedAt: patient.triagedAt,
      roomedAt: patient.roomedAt,
      providerSeenAt: patient.providerSeenAt,
      dispositionDecisionAt: patient.dispositionDecisionAt,
      departedAt: patient.departedAt,
      lwbsAt: patient.lwbsAt,
    })),
  );
  assert.deepEqual(secondBenchmark.metrics, firstBenchmark.metrics);
  assert.deepEqual(
    secondBenchmark.decisions.map((decision) => ({
      minute: decision.simulationMinute,
      patientId: decision.patientId,
      actionType: decision.actionType,
      resultingState: decision.resultingState,
    })),
    firstBenchmark.decisions.map((decision) => ({
      minute: decision.simulationMinute,
      patientId: decision.patientId,
      actionType: decision.actionType,
      resultingState: decision.resultingState,
    })),
  );
});

test("optimal flow benchmark compares delayed actual flow with benchmark flow", () => {
  const scenario = scenarioWith({
    triageProviderEnabled: false,
    roomCapacity: 2,
    providerCount: 1,
    shiftDurationMinutes: 120,
    arrivalProfile: [{ hourOffset: 0, expectedArrivals: 3 }],
    lwbsProfile: {
      enabled: false,
    },
  });
  const deck = generatePatientDeck(scenario);
  let actualRun = startSimulation(createSimulationRun(scenario, deck));
  actualRun = advanceTo(actualRun, scenario, 90);

  const benchmark = createOptimalFlowBenchmark(scenario, deck, actualRun);
  const seenPerHourComparison = benchmark.comparisons.find((comparison) => comparison.label === "Seen / hour");

  assertDefined(seenPerHourComparison, "Expected seen-per-hour comparison.");
  assert.equal(seenPerHourComparison.interpretation, "worse");
  assert.ok(benchmark.benchmarkRun.metrics.patientsSeen > actualRun.metrics.patientsSeen);
  assert.equal(benchmark.opportunities.some((opportunity) => opportunity.label === "Earlier rooming opportunity"), true);
});

test("focused coach benchmarks are deterministic for the same scenario deck", () => {
  const scenario = scenarioWith({
    triageProviderEnabled: true,
    triageProviderMode: "manual",
    roomCapacity: 2,
    providerCount: 1,
    shiftDurationMinutes: 120,
    arrivalProfile: [{ hourOffset: 0, expectedArrivals: 4 }],
    lwbsProfile: {
      enabled: true,
      minimumWaitBeforeLWBS: 20,
    },
  });
  const deck = generatePatientDeck(scenario);
  const strategies = [
    runFrontEndFocusCoachBenchmark,
    runMiddleFlowFocusCoachBenchmark,
    runDispositionFocusCoachBenchmark,
    runResourceAwareCoachBenchmark,
    runSafetyFirstCoachBenchmark,
    runFastTrackCoachBenchmark,
    runBalancedOperationsCoachBenchmark,
  ];

  for (const runStrategy of strategies) {
    const firstBenchmark = runStrategy(scenario, deck, 90);
    const secondBenchmark = runStrategy(scenario, deck, 90);

    assert.deepEqual(secondBenchmark.metrics, firstBenchmark.metrics);
    assert.deepEqual(
      secondBenchmark.decisions.map((decision) => ({
        minute: decision.simulationMinute,
        patientId: decision.patientId,
        actionType: decision.actionType,
        resultingState: decision.resultingState,
      })),
      firstBenchmark.decisions.map((decision) => ({
        minute: decision.simulationMinute,
        patientId: decision.patientId,
        actionType: decision.actionType,
        resultingState: decision.resultingState,
      })),
    );
  }
});

test("what-if coach comparison includes provider, optimal, and focused strategies", () => {
  const scenario = scenarioWith({
    triageProviderEnabled: true,
    triageProviderMode: "manual",
    roomCapacity: 2,
    providerCount: 1,
    shiftDurationMinutes: 120,
    arrivalProfile: [{ hourOffset: 0, expectedArrivals: 4 }],
    lwbsProfile: {
      enabled: false,
    },
  });
  const deck = generatePatientDeck(scenario);
  let actualRun = startSimulation(createSimulationRun(scenario, deck));
  actualRun = advanceTo(actualRun, scenario, 60);

  const benchmark = createOptimalFlowBenchmark(scenario, deck, actualRun);

  assert.deepEqual(
    benchmark.whatIfComparison.summaries.map((summary) => summary.id),
    [
      "provider_run",
      "optimal_flow",
      "front_end_focus",
      "middle_flow_focus",
      "disposition_focus",
      "resource_aware",
      "safety_first",
      "fast_track",
      "balanced_operations",
    ],
  );
  assert.equal(benchmark.frontEndFocusRun.currentMinute, benchmark.benchmarkRun.currentMinute);
  assert.equal(benchmark.middleFlowFocusRun.currentMinute, benchmark.benchmarkRun.currentMinute);
  assert.equal(benchmark.dispositionFocusRun.currentMinute, benchmark.benchmarkRun.currentMinute);
  assert.equal(benchmark.resourceAwareRun.currentMinute, benchmark.benchmarkRun.currentMinute);
  assert.equal(benchmark.safetyFirstRun.currentMinute, benchmark.benchmarkRun.currentMinute);
  assert.equal(benchmark.fastTrackRun.currentMinute, benchmark.benchmarkRun.currentMinute);
  assert.equal(benchmark.balancedOperationsRun.currentMinute, benchmark.benchmarkRun.currentMinute);
  assert.equal(benchmark.whatIfComparison.summaries.every((summary) => summary.longestWaitMinutes >= 0), true);
  assert.equal(
    benchmark.whatIfComparison.summaries.find((summary) => summary.id === "provider_run")?.priorityProfile,
    undefined,
  );
  assert.deepEqual(
    benchmark.whatIfComparison.summaries.find((summary) => summary.id === "optimal_flow")?.priorityProfile,
    scenario.coachPriorityProfile,
  );
  assert.equal(
    benchmark.whatIfComparison.summaries.find((summary) => summary.id === "safety_first")?.priorityProfile?.mode,
    "safety_first",
  );
  assert.deepEqual(
    benchmark.whatIfComparison.summaries.find((summary) => summary.id === "disposition_focus")?.priorityProfile,
    scenario.coachStrategyPriorityProfiles.disposition_focus,
  );
});

test("benchmark comparison view can compare provider run against any coach target", () => {
  const scenario = scenarioWith({
    triageProviderEnabled: true,
    triageProviderMode: "automated",
    roomCapacity: 4,
    providerCount: 2,
    shiftDurationMinutes: 180,
    arrivalProfile: [{ hourOffset: 0, expectedArrivals: 8 }],
    lwbsProfile: {
      enabled: false,
    },
  });
  const deck = generatePatientDeck(scenario);
  let actualRun = startSimulation(createSimulationRun(scenario, deck));
  actualRun = advanceTo(actualRun, scenario, 90);

  const benchmark = createOptimalFlowBenchmark(scenario, deck, actualRun);
  const optimalView = createBenchmarkComparisonView(actualRun, benchmark, "optimal_flow");
  const balancedView = createBenchmarkComparisonView(actualRun, benchmark, "balanced_operations");

  assert.equal(optimalView.targetLabel, "Optimal Flow Coach");
  assert.equal(balancedView.targetLabel, "Balanced Operations Coach");
  assert.deepEqual(
    balancedView.comparisons.map((comparison) => comparison.label),
    ["LWBS", "Longest wait", "Door to provider", "Results to disposition", "Risk minutes", "Seen / hour"],
  );
  assert.equal(balancedView.opportunities.length <= 5, true);
  assert.notEqual(balancedView.targetLabel, optimalView.targetLabel);
});

test("what-if coach comparison shows front-end focus can leave roomed results waiting behind optimal flow", () => {
  const scenario = scenarioWith({
    triageProviderEnabled: true,
    triageProviderMode: "automated",
    roomCapacity: 8,
    providerCount: 1,
    shiftDurationMinutes: 240,
    arrivalProfile: [{ hourOffset: 0, expectedArrivals: 12 }],
    lwbsProfile: {
      enabled: false,
    },
  });
  const deck = generatePatientDeck(scenario);
  let actualRun = startSimulation(createSimulationRun(scenario, deck));
  actualRun = advanceTo(actualRun, scenario, 90);

  const benchmark = createOptimalFlowBenchmark(scenario, deck, actualRun);
  const optimalSummary = benchmark.whatIfComparison.summaries.find((summary) => summary.id === "optimal_flow");
  const frontEndSummary = benchmark.whatIfComparison.summaries.find((summary) => summary.id === "front_end_focus");

  assertDefined(optimalSummary, "Expected an optimal-flow summary.");
  assertDefined(frontEndSummary, "Expected a front-end-focus summary.");
  assert.ok(optimalSummary.patientsSeenPerHour > frontEndSummary.patientsSeenPerHour);
  assert.ok(frontEndSummary.resultsReadyWaiting > optimalSummary.resultsReadyWaiting);
});

test("activity timeline merges events, provider decisions, and benchmark comparisons", () => {
  const scenario = scenarioWith({
    triageProviderEnabled: false,
    arrivalProfile: [{ hourOffset: 0, expectedArrivals: 2 }],
    complaintDistribution: { values: [{ value: "minor_complaint", weight: 1 }] },
  });
  const deck = generatePatientDeck(scenario).map((patient) => ({
    ...patient,
    arrivalMinute: 0,
    workupType: "none" as const,
    expectedLabMinutes: 0,
    expectedImagingMinutes: 0,
  }));
  let actualRun = startSimulation(createSimulationRun(scenario, deck));
  actualRun = advanceTo(actualRun, scenario, 20);
  actualRun = runAction(actualRun, scenario, "room_patient", deck[0]?.id ?? "patient-001");
  const benchmarkRun = runOptimalFlowBenchmark(scenario, deck, actualRun.currentMinute);

  const timeline = createActivityTimeline(actualRun, benchmarkRun);
  const roomDecision = timeline.records.find(
    (record) => record.kind === "decision" && record.actionType === "room_patient" && record.patientId === deck[0]?.id,
  );

  assert.ok(timeline.records.some((record) => record.kind === "event" && record.eventType === "patient_arrived"));
  assertDefined(roomDecision, "Expected rooming decision activity.");
  assert.equal(roomDecision.benchmarkMinute, 1);
  assert.equal(roomDecision.benchmarkDeltaMinutes, 19);
  assert.equal(timeline.actualDecisionCount, actualRun.decisions.length);
  assert.equal(timeline.benchmarkDecisionCount, benchmarkRun.decisions.length);
  assert.ok((timeline.averageDecisionDelayMinutes ?? 0) > 0);
});

test("activity timeline exports records as csv", () => {
  const scenario = scenarioWith({
    triageProviderEnabled: false,
    arrivalProfile: [{ hourOffset: 0, expectedArrivals: 1 }],
    complaintDistribution: { values: [{ value: "minor_complaint", weight: 1 }] },
  });
  const deck = generatePatientDeck(scenario).map((patient) => ({
    ...patient,
    arrivalMinute: 0,
    workupType: "none" as const,
    expectedLabMinutes: 0,
    expectedImagingMinutes: 0,
  }));
  let run = startSimulation(createSimulationRun(scenario, deck));
  run = advanceOneMinute(run, scenario);
  run = runAction(run, scenario, "room_patient", deck[0]?.id ?? "patient-001");
  const timeline = createActivityTimeline(run, runOptimalFlowBenchmark(scenario, deck, run.currentMinute));
  const csv = activityTimelineToCsv(timeline);

  assert.equal(csv.startsWith("id,runId,simulationMinute,kind,label,message"), true);
  assert.equal(csv.includes("decision"), true);
  assert.equal(csv.includes("benchmarkDeltaMinutes"), true);
  assert.equal(csv.split("\n").length, timeline.records.length + 1);
});

test("activity export includes provider and all coach strategy runs", () => {
  const scenario = scenarioWith({
    triageProviderEnabled: true,
    triageProviderMode: "automated",
    arrivalProfile: [{ hourOffset: 0, expectedArrivals: 4 }],
  });
  const deck = generatePatientDeck(scenario);
  let run = startSimulation(createSimulationRun(scenario, deck));
  run = advanceTo(run, scenario, 60);
  const benchmark = createOptimalFlowBenchmark(scenario, deck, run);

  const csv = activityRunsToCsv([
    { run, strategyId: "provider_run", strategyLabel: "Provider Run" },
    { run: benchmark.benchmarkRun, strategyId: "optimal_flow", strategyLabel: "Optimal Flow Coach" },
    { run: benchmark.frontEndFocusRun, strategyId: "front_end_focus", strategyLabel: "Front-End Focus Coach" },
    { run: benchmark.middleFlowFocusRun, strategyId: "middle_flow_focus", strategyLabel: "Middle Flow Focus Coach" },
    { run: benchmark.dispositionFocusRun, strategyId: "disposition_focus", strategyLabel: "Disposition Focus Coach" },
    { run: benchmark.resourceAwareRun, strategyId: "resource_aware", strategyLabel: "Resource-Aware Coach" },
    { run: benchmark.safetyFirstRun, strategyId: "safety_first", strategyLabel: "Safety First Coach" },
    { run: benchmark.fastTrackRun, strategyId: "fast_track", strategyLabel: "Fast Track Coach" },
    { run: benchmark.balancedOperationsRun, strategyId: "balanced_operations", strategyLabel: "Balanced Operations Coach" },
  ]);

  assert.equal(csv.startsWith("strategyId,strategyLabel,id,runId,simulationMinute,kind"), true);
  assert.equal(csv.includes("Provider Run"), true);
  assert.equal(csv.includes("Optimal Flow Coach"), true);
  assert.equal(csv.includes("Front-End Focus Coach"), true);
  assert.equal(csv.includes("Middle Flow Focus Coach"), true);
  assert.equal(csv.includes("Disposition Focus Coach"), true);
  assert.equal(csv.includes("Resource-Aware Coach"), true);
  assert.equal(csv.includes("Safety First Coach"), true);
  assert.equal(csv.includes("Fast Track Coach"), true);
  assert.equal(csv.includes("Balanced Operations Coach"), true);
  assert.equal(csv.includes("decision"), true);
});

test("benchmark coach recommends the next deterministic operational action", () => {
  const scenario = scenarioWith({
    triageProviderEnabled: false,
    roomCapacity: 1,
    providerCount: 1,
    arrivalProfile: [{ hourOffset: 0, expectedArrivals: 1 }],
    lwbsProfile: {
      enabled: false,
    },
  });
  let run = startedRun(scenario);
  run = advanceTo(run, scenario, 60);

  const recommendation = getBenchmarkCoachRecommendation(run);

  assertDefined(recommendation, "Expected a coach recommendation.");
  assert.equal(recommendation.actionType, "room_patient");
  assert.equal(recommendation.patientId, firstPatientId(run));
  assert.equal(recommendation.reason.includes("Rooming this patient now"), true);
  assert.equal(recommendation.prioritySummary.includes("ESI"), true);
});

test("coach priority weights change competing waiting-patient recommendations", () => {
  const scenario = scenarioWith({
    triageProviderEnabled: false,
    roomCapacity: 1,
    providerCount: 1,
    arrivalProfile: [{ hourOffset: 0, expectedArrivals: 2 }],
    lwbsProfile: {
      enabled: false,
    },
  });
  const deck = generatePatientDeck(scenario)
    .slice(0, 2)
    .map((patient, index) => ({
      ...patient,
      arrivalMinute: index === 0 ? 119 : 0,
      expectedLabMinutes: 0,
      expectedImagingMinutes: 0,
      workupType: "none" as const,
    }));
  let run = startSimulation(createSimulationRun(scenario, deck));
  run = {
    ...run,
    currentMinute: 120,
    patients: run.patients.map((patient, index) =>
      index === 0
        ? {
            ...patient,
            id: "patient-high-acuity",
            patientNumber: 1,
            state: "waiting" as const,
            arrivedAt: 119,
            esi: 2 as const,
            riskLevel: "moderate" as const,
          }
        : {
            ...patient,
            id: "patient-long-wait",
            patientNumber: 2,
            state: "waiting" as const,
            arrivedAt: 0,
            esi: 5 as const,
            riskLevel: "low" as const,
          },
    ),
  };

  const defaultRecommendation = getBenchmarkCoachRecommendation(run);
  const waitWeightedRecommendation = getBenchmarkCoachRecommendation({
    ...run,
    coachPriorityProfile: {
      mode: "balanced",
      acuityWeight: 0,
      riskWeight: 0,
      waitWeight: 10,
    },
  });

  assert.equal(defaultRecommendation?.patientId, "patient-high-acuity");
  assert.equal(waitWeightedRecommendation?.patientId, "patient-long-wait");
});

test("coach demo applies available coach recommendations automatically", () => {
  const scenario = scenarioWith({
    triageProviderEnabled: false,
    providerCount: 2,
    nurseCount: 2,
    techCount: 2,
    roomCapacity: 2,
    arrivalProfile: [{ hourOffset: 0, expectedArrivals: 2 }],
    lwbsProfile: {
      enabled: false,
    },
  });
  const deck = generatePatientDeck(scenario).map((patient) => ({
    ...patient,
    arrivalMinute: 0,
    workupType: "none" as const,
    expectedLabMinutes: 0,
    expectedImagingMinutes: 0,
  }));
  let run = startSimulation(createSimulationRun(scenario, deck));
  run = advanceOneMinute(run, scenario);

  const recommendation = getBenchmarkCoachRecommendation(run);
  assert.equal(recommendation?.actionType, "room_patient");

  const coached = runCoachDemoActions(run);

  assert.equal(coached.appliedActions.length, 2);
  assert.equal(coached.appliedActions.every((action) => action.actionType === "room_patient"), true);
  assert.equal(coached.run.providers.every((provider) => provider.status === "busy"), true);
  assert.equal(coached.run.patients.filter((patient) => patient.state === "waiting").length, 2);

  run = advanceTo(coached.run, scenario, coached.run.currentMinute + 2);
  assert.equal(run.patients.filter((patient) => patient.state === "roomed").length, 2);
});

test("benchmark coach prioritizes roomed patients with ready diagnostic results", () => {
  const scenario = scenarioWith({
    triageProviderEnabled: true,
    roomCapacity: 1,
    providerCount: 1,
    arrivalProfile: [{ hourOffset: 0, expectedArrivals: 2 }],
    lwbsProfile: {
      enabled: false,
    },
  });
  let run = startedRun(scenario);
  run = {
    ...run,
    currentMinute: 60,
    patients: run.patients.map((patient, index) => {
      if (index === 0) {
        return {
          ...patient,
          state: "roomed" as const,
          arrivedAt: 0,
          roomId: "room-01",
          roomedAt: 20,
          ordersPlacedAt: 5,
          resultsReadyAt: 45,
          pendingItems: [{ type: "labs" as const, orderedAt: 5, readyAt: 45, status: "ready" as const }],
        };
      }

      if (index === 1) {
        return {
          ...patient,
          state: "triage" as const,
          arrivedAt: 50,
          arrivalPath: "front_end_triage" as const,
        };
      }

      return patient;
    }),
    rooms: [{ id: "room-01", status: "occupied", patientId: run.patients[0]?.id }],
  };

  const readyRoomedPatient = run.patients[0];
  assertDefined(readyRoomedPatient, "Expected roomed patient.");
  const recommendation = getBenchmarkCoachRecommendation(run);

  assertDefined(recommendation, "Expected a coach recommendation.");
  assert.equal(recommendation.patientId, readyRoomedPatient.id);
  assert.equal(recommendation.actionType, "see_patient");
  assert.equal(recommendation.reason.includes("Diagnostic results are already ready"), true);
});

test("benchmark coach sees roomed results-ready patients before rooming more waiting patients", () => {
  const scenario = scenarioWith({
    triageProviderEnabled: false,
    roomCapacity: 2,
    providerCount: 1,
    arrivalProfile: [{ hourOffset: 0, expectedArrivals: 2 }],
    lwbsProfile: {
      enabled: false,
    },
  });
  let run = startedRun(scenario);
  run = {
    ...run,
    currentMinute: 60,
    patients: run.patients.map((patient, index) => {
      if (index === 0) {
        return {
          ...patient,
          state: "results_ready" as const,
          arrivedAt: 0,
          roomId: "room-01",
          roomedAt: 20,
          ordersPlacedAt: 25,
          resultsReadyAt: 50,
          pendingItems: [{ type: "labs" as const, orderedAt: 25, readyAt: 50, status: "ready" as const }],
        };
      }

      if (index === 1) {
        return {
          ...patient,
          state: "waiting" as const,
          arrivedAt: 10,
          triagedAt: 10,
          riskLevel: "high" as const,
        };
      }

      return patient;
    }),
    rooms: [
      { id: "room-01", status: "occupied", patientId: run.patients[0]?.id },
      { id: "room-02", status: "available" },
    ],
  };

  const roomedResultsReadyPatient = run.patients[0];
  assertDefined(roomedResultsReadyPatient, "Expected results-ready patient.");
  const recommendation = getBenchmarkCoachRecommendation(run);

  assertDefined(recommendation, "Expected a coach recommendation.");
  assert.equal(recommendation.patientId, roomedResultsReadyPatient.id);
  assert.equal(recommendation.actionType, "see_patient");
  assert.equal(recommendation.reason.includes("Diagnostic results are already ready"), true);
});

test("benchmark coach sees roomed results-pending patients before rooming more waiting patients", () => {
  const scenario = scenarioWith({
    triageProviderEnabled: false,
    roomCapacity: 2,
    providerCount: 1,
    arrivalProfile: [{ hourOffset: 0, expectedArrivals: 2 }],
    lwbsProfile: {
      enabled: false,
    },
  });
  let run = startedRun(scenario);
  run = {
    ...run,
    currentMinute: 60,
    patients: run.patients.map((patient, index) => {
      if (index === 0) {
        return {
          ...patient,
          state: "results_pending" as const,
          arrivedAt: 0,
          roomId: "room-01",
          roomedAt: 20,
          ordersPlacedAt: 25,
          pendingItems: [{ type: "labs" as const, orderedAt: 25, readyAt: 90, status: "pending" as const }],
        };
      }

      if (index === 1) {
        return {
          ...patient,
          state: "waiting" as const,
          arrivedAt: 10,
          triagedAt: 10,
          riskLevel: "high" as const,
        };
      }

      return patient;
    }),
    rooms: [
      { id: "room-01", status: "occupied", patientId: run.patients[0]?.id },
      { id: "room-02", status: "available" },
    ],
  };

  const roomedResultsPendingPatient = run.patients[0];
  assertDefined(roomedResultsPendingPatient, "Expected results-pending patient.");
  const recommendation = getBenchmarkCoachRecommendation(run);

  assertDefined(recommendation, "Expected a coach recommendation.");
  assert.equal(recommendation.patientId, roomedResultsPendingPatient.id);
  assert.equal(recommendation.actionType, "see_patient");
  assert.equal(recommendation.reason.includes("provider evaluation is the next flow constraint"), true);
});

test("benchmark coach prioritizes roomed active patients before front-end triage work", () => {
  const scenario = scenarioWith({
    triageProviderEnabled: true,
    roomCapacity: 1,
    providerCount: 1,
    arrivalProfile: [{ hourOffset: 0, expectedArrivals: 2 }],
    lwbsProfile: {
      enabled: false,
    },
  });
  let run = startedRun(scenario);
  run = {
    ...run,
    currentMinute: 60,
    patients: run.patients.map((patient, index) => {
      if (index === 0) {
        return {
          ...patient,
          state: "roomed" as const,
          arrivedAt: 0,
          roomId: "room-01",
          roomedAt: 20,
        };
      }

      if (index === 1) {
        return {
          ...patient,
          state: "triage" as const,
          arrivedAt: 50,
          arrivalPath: "front_end_triage" as const,
        };
      }

      return patient;
    }),
    rooms: [{ id: "room-01", status: "occupied", patientId: run.patients[0]?.id }],
  };

  const roomedPatient = run.patients[0];
  assertDefined(roomedPatient, "Expected roomed patient.");
  const recommendation = getBenchmarkCoachRecommendation(run);

  assertDefined(recommendation, "Expected a coach recommendation.");
  assert.equal(recommendation.patientId, roomedPatient.id);
  assert.equal(recommendation.actionType, "see_patient");
  assert.equal(recommendation.reason.includes("already roomed"), true);
});

test("benchmark coach sees roomed patients before rooming more waiting patients", () => {
  const scenario = scenarioWith({
    triageProviderEnabled: false,
    roomCapacity: 2,
    providerCount: 1,
    arrivalProfile: [{ hourOffset: 0, expectedArrivals: 2 }],
    lwbsProfile: {
      enabled: false,
    },
  });
  let run = startedRun(scenario);
  run = {
    ...run,
    currentMinute: 60,
    patients: run.patients.map((patient, index) => {
      if (index === 0) {
        return {
          ...patient,
          state: "roomed" as const,
          arrivedAt: 0,
          roomId: "room-01",
          roomedAt: 20,
        };
      }

      if (index === 1) {
        return {
          ...patient,
          state: "waiting" as const,
          arrivedAt: 10,
          triagedAt: 10,
          riskLevel: "high" as const,
        };
      }

      return patient;
    }),
    rooms: [
      { id: "room-01", status: "occupied", patientId: run.patients[0]?.id },
      { id: "room-02", status: "available" },
    ],
  };

  const roomedPatient = run.patients[0];
  assertDefined(roomedPatient, "Expected roomed patient.");
  const recommendation = getBenchmarkCoachRecommendation(run);

  assertDefined(recommendation, "Expected a coach recommendation.");
  assert.equal(recommendation.patientId, roomedPatient.id);
  assert.equal(recommendation.actionType, "see_patient");
  assert.equal(recommendation.reason.includes("provider evaluation is the next flow constraint"), true);
});

test("benchmark coach does not push front-end triage while waiting-room patients need ED flow", () => {
  const scenario = scenarioWith({
    triageProviderEnabled: true,
    roomCapacity: 1,
    providerCount: 1,
    arrivalProfile: [{ hourOffset: 0, expectedArrivals: 2 }],
    lwbsProfile: {
      enabled: false,
    },
  });
  let run = startedRun(scenario);
  run = {
    ...run,
    currentMinute: 60,
    patients: run.patients.map((patient, index) => {
      if (index === 0) {
        return {
          ...patient,
          state: "waiting" as const,
          arrivedAt: 0,
          triagedAt: 10,
          arrivalPath: "front_end_triage" as const,
        };
      }

      if (index === 1) {
        return {
          ...patient,
          state: "triage" as const,
          arrivedAt: 50,
          arrivalPath: "front_end_triage" as const,
        };
      }

      return patient;
    }),
    rooms: [{ id: "room-01", status: "blocked", patientId: "boarding-patient" }],
  };

  const recommendation = getBenchmarkCoachRecommendation(run);

  assert.equal(recommendation, undefined);
});

test("patients arrive when the clock reaches their arrival minute", () => {
  const scenario = scenarioWith({
    triageProviderEnabled: false,
    arrivalProfile: [{ hourOffset: 0, expectedArrivals: 1 }],
  });
  const deck = generatePatientDeck(scenario);
  let run = startSimulation(createSimulationRun(scenario, deck));

  const arrivalMinute = deck[0]?.arrivalMinute;
  assert.equal(run.metrics.patientsArrived, 0);
  assertDefined(arrivalMinute, "Expected generated patient to have an arrival minute.");

  run = advanceTo(run, scenario, arrivalMinute);

  assert.equal(run.metrics.patientsArrived, 1);
  const patient = run.patients[0];
  assertDefined(patient, "Expected generated patient to exist.");
  assert.equal(patient.state, "waiting");
  assert.equal(patient.arrivalPath, "direct_waiting_room");
  assert.equal(patient.arrivedAt, arrivalMinute);
});

test("front-end triage routes arrivals to triage before the waiting room", () => {
  const scenario = scenarioWith({
    triageProviderEnabled: true,
    triageProviderMode: "manual",
    arrivalProfile: [{ hourOffset: 0, expectedArrivals: 1 }],
  });
  const deck = generatePatientDeck(scenario);
  let run = startSimulation(createSimulationRun(scenario, deck));
  const arrivalMinute = deck[0]?.arrivalMinute;
  assertDefined(arrivalMinute, "Expected generated patient to have an arrival minute.");

  run = advanceTo(run, scenario, arrivalMinute);

  const patient = run.patients[0];
  assertDefined(patient, "Expected generated patient to exist.");
  assert.equal(patient.state, "triage");
  assert.equal(patient.arrivalPath, "front_end_triage");
  assert.equal(run.metrics.patientsArrived, 1);
  assert.equal(run.metrics.triageCensus, 1);
  assert.equal(run.metrics.waitingRoomCensus, 0);

  run = runTriageAction(run, scenario, patient.id);
  const triagedPatient = run.patients.find((candidate) => candidate.id === patient.id);
  assert.equal(triagedPatient?.state, "waiting");
  assert.equal(triagedPatient?.triagedAt, run.currentMinute);
  assert.equal(run.metrics.triageCensus, 0);
  assert.equal(run.metrics.waitingRoomCensus, 1);
});

test("fast track moves eligible waiting patients without consuming an ED room", () => {
  const scenario = scenarioWith({
    fastTrackEnabled: true,
    triageProviderEnabled: false,
    roomCapacity: 1,
    arrivalProfile: [{ hourOffset: 0, expectedArrivals: 1 }],
    complaintDistribution: { values: [{ value: "minor_complaint", weight: 1 }] },
    minimumStemiAlertPatients: 0,
  });
  const deck = generatePatientDeck(scenario).map((patient) => ({
    ...patient,
    arrivalMinute: 0,
    esi: 5 as const,
    workupType: "none" as const,
    expectedLabMinutes: 0,
    expectedImagingMinutes: 0,
    cardiacPathway: "none" as const,
  }));
  let run = startSimulation(createSimulationRun(scenario, deck));

  run = advanceOneMinute(run, scenario);

  const patient = run.patients[0];
  assertDefined(patient, "Expected fast-track patient.");
  const actions = getAvailableProviderActions(run, patient.id);

  assert.equal(actions.find((action) => action.type === "fast_track_patient")?.enabled, true);

  run = applyProviderAction(run, "fast_track_patient", patient.id);
  run = advanceTo(run, scenario, run.currentMinute + 1);

  const fastTrackedPatient = run.patients[0];
  assertDefined(fastTrackedPatient, "Expected fast-tracked patient.");
  assert.equal(fastTrackedPatient.state, "fast_track");
  assert.equal(fastTrackedPatient.fastTrackedAt, run.currentMinute);
  assert.equal(run.rooms[0]?.status, "available");
  assert.equal(run.metrics.fastTrackCensus, 1);
  assert.equal(run.metrics.patientsFastTracked, 1);
  assert.equal(run.metrics.waitingRoomCensus, 0);
});

test("fast track toggle disables fast-track patient action", () => {
  const scenario = scenarioWith({
    fastTrackEnabled: false,
    triageProviderEnabled: false,
    arrivalProfile: [{ hourOffset: 0, expectedArrivals: 1 }],
    complaintDistribution: { values: [{ value: "minor_complaint", weight: 1 }] },
    minimumStemiAlertPatients: 0,
  });
  const deck = generatePatientDeck(scenario).map((patient) => ({
    ...patient,
    arrivalMinute: 0,
    esi: 5 as const,
    workupType: "none" as const,
    expectedLabMinutes: 0,
    expectedImagingMinutes: 0,
    cardiacPathway: "none" as const,
  }));
  let run = startSimulation(createSimulationRun(scenario, deck));

  run = advanceOneMinute(run, scenario);

  const patient = run.patients[0];
  assertDefined(patient, "Expected waiting low-acuity patient.");
  const action = getAvailableProviderActions(run, patient.id).find((candidate) => candidate.type === "fast_track_patient");

  assert.equal(run.fastTrackEnabled, false);
  assert.equal(action?.enabled, false);
  assert.equal(action?.disabledReason, "Fast Track is disabled");
});

test("waiting-room reassessment action resets overdue reassessment clock", () => {
  const scenario = scenarioWith({
    triageProviderEnabled: false,
    arrivalProfile: [{ hourOffset: 0, expectedArrivals: 1 }],
    lwbsProfile: {
      enabled: false,
    },
    minimumStemiAlertPatients: 0,
    workflowTimingProfile: {
      ...defaultScenario.workflowTimingProfile,
      deteriorationGraceMinutes: 45,
    },
  });
  const deck = generatePatientDeck(scenario).map((patient) => ({
    ...patient,
    arrivalMinute: 0,
    esi: 5 as const,
    workupType: "none" as const,
    expectedLabMinutes: 0,
    expectedImagingMinutes: 0,
    cardiacPathway: "none" as const,
  }));
  let run = startSimulation(createSimulationRun(scenario, deck));

  run = advanceOneMinute(run, scenario);
  const patientId = run.patients[0]?.id;
  assertDefined(patientId, "Expected reassessment test patient.");
  assert.equal(run.patients[0]?.nextReassessmentDueAt, 61);

  run = advanceTo(run, scenario, 62);
  const overdueAction = getAvailableProviderActions(run, patientId).find((action) => action.type === "reassess_waiting_patient");
  assert.equal(overdueAction?.enabled, true);
  assert.equal(run.metrics.reassessmentsOverdue, 1);

  run = applyProviderAction(run, "reassess_waiting_patient", patientId);
  run = advanceTo(run, scenario, run.currentMinute + 3);

  const reassessedPatient = run.patients.find((patient) => patient.id === patientId);
  assertDefined(reassessedPatient, "Expected reassessed patient.");
  assert.equal(reassessedPatient.lastReassessedAt, run.currentMinute);
  assert.equal(reassessedPatient.nextReassessmentDueAt, 80);
  assert.equal(run.metrics.reassessmentsOverdue, 0);
  assert.equal(run.events.some((event) => event.type === "patient_reassessed" && event.patientId === patientId), true);
});

test("waiting-room patient deteriorates after overdue reassessment grace period", () => {
  const scenario = scenarioWith({
    triageProviderEnabled: false,
    shiftDurationMinutes: 180,
    arrivalProfile: [{ hourOffset: 0, expectedArrivals: 1 }],
    lwbsProfile: {
      enabled: false,
    },
    minimumStemiAlertPatients: 0,
  });
  const deck = generatePatientDeck(scenario).map((patient) => ({
    ...patient,
    arrivalMinute: 0,
    esi: 5 as const,
    workupType: "none" as const,
    expectedLabMinutes: 0,
    expectedImagingMinutes: 0,
    cardiacPathway: "none" as const,
  }));
  let run = startSimulation(createSimulationRun(scenario, deck));
  run = advanceOneMinute(run, scenario);
  const patientId = run.patients[0]?.id;
  assertDefined(patientId, "Expected deterioration test patient.");
  run = {
    ...run,
    currentMinute: 44,
    patients: run.patients.map((patient) =>
      patient.id === patientId
        ? {
            ...patient,
            state: "waiting" as const,
            arrivedAt: 0,
            nextReassessmentDueAt: 0,
            riskLevel: "low" as const,
          }
        : patient,
    ),
  };

  run = advanceOneMinute(run, scenario);

  const deterioratedPatient = run.patients.find((patient) => patient.id === patientId);
  const deteriorationEvent = run.events.find((event) => event.type === "patient_deteriorated" && event.patientId === patientId);
  const guardrails = createFlowGuardrails(run);

  assertDefined(deterioratedPatient, "Expected deteriorated patient.");
  assert.equal(deterioratedPatient.deterioratedAt, 45);
  assert.equal(deterioratedPatient.deteriorationCount, 1);
  assert.equal(deterioratedPatient.esi, 4);
  assert.equal(deterioratedPatient.riskLevel, "high");
  assert.equal(run.metrics.waitingRoomDeteriorations, 1);
  assertDefined(deteriorationEvent, "Expected deterioration event.");
  assert.equal(deteriorationEvent.details?.overdueMinutes, 45);
  assert.equal(guardrails.guardrails.some((guardrail) => guardrail.title === "Waiting-room patient deteriorated"), true);
});

test("automated front-end triage starts protocol orders without using an ED provider", () => {
  const scenario = scenarioWith({
    triageProviderEnabled: true,
    triageProviderMode: "automated",
    arrivalProfile: [{ hourOffset: 0, expectedArrivals: 1 }],
  });
  const deck = generatePatientDeck(scenario).map((patient) => ({
    ...patient,
    arrivalMinute: 0,
    workupType: "basic_labs" as const,
    expectedLabMinutes: 30,
    expectedImagingMinutes: 0,
  }));
  let run = startSimulation(createSimulationRun(scenario, deck));

  run = advanceOneMinute(run, scenario);

  const patient = run.patients[0];
  assertDefined(patient, "Expected automated triage test patient.");
  const automatedDecision = run.decisions.find((decision) => decision.actionType === "start_protocol_orders");

  assert.equal(patient.state, "triage");
  assert.equal(patient.ordersPlacedAt, run.currentMinute);
  assert.equal(patient.pendingItems.length, 1);
  assert.equal(run.metrics.providerBusyMinutes, 0);
  assertDefined(automatedDecision, "Expected automated protocol-order decision.");
  assert.equal(automatedDecision.providerId, run.triageProvider.id);
  assert.equal(automatedDecision.resultingState, "triage");
});

test("automated front-end triage does not bypass nurse and tech constraints for protocol orders", () => {
  const scenario = scenarioWith({
    triageProviderEnabled: true,
    triageProviderMode: "automated",
    nurseCount: 1,
    techCount: 0,
    arrivalProfile: [{ hourOffset: 0, expectedArrivals: 1 }],
  });
  const deck = generatePatientDeck(scenario).map((patient) => ({
    ...patient,
    arrivalMinute: 0,
    workupType: "basic_labs" as const,
    expectedLabMinutes: 30,
    expectedImagingMinutes: 0,
  }));
  let run = startSimulation(createSimulationRun(scenario, deck));

  run = advanceOneMinute(run, scenario);

  const patient = run.patients[0];
  assertDefined(patient, "Expected automated triage resource test patient.");
  assert.equal(patient.ordersPlacedAt, undefined);
  assert.equal(patient.pendingItems.length, 0);
  assert.equal(run.decisions.some((decision) => decision.actionType === "start_protocol_orders"), false);
  assert.equal(run.triageProvider.currentAction?.type, "complete_triage");
});

test("automated front-end triage sends patients to waiting after protocol work starts", () => {
  const scenario = scenarioWith({
    triageProviderEnabled: true,
    triageProviderMode: "automated",
    arrivalProfile: [{ hourOffset: 0, expectedArrivals: 1 }],
  });
  const deck = generatePatientDeck(scenario).map((patient) => ({
    ...patient,
    arrivalMinute: 0,
    workupType: "basic_labs" as const,
    expectedLabMinutes: 30,
    expectedImagingMinutes: 0,
  }));
  let run = startSimulation(createSimulationRun(scenario, deck));
  run = advanceOneMinute(run, scenario);

  run = advanceOneMinute(run, scenario);
  while (run.triageProvider.status === "busy") {
    run = advanceOneMinute(run, scenario);
  }

  const patient = run.patients[0];
  assertDefined(patient, "Expected automated triage test patient.");
  const completedDecision = run.decisions.find((decision) => decision.actionType === "complete_triage");

  assert.equal(patient.state, "waiting");
  assert.equal(patient.triagedAt, run.currentMinute);
  assert.equal(run.metrics.triageCensus, 0);
  assert.equal(run.metrics.waitingRoomCensus, 1);
  assertDefined(completedDecision, "Expected automated complete-triage decision.");
  assert.equal(completedDecision.providerId, run.triageProvider.id);
  assert.equal(completedDecision.resultingState, "waiting");
});

test("automated front-end triage completes no-workup patients directly to waiting", () => {
  const scenario = scenarioWith({
    triageProviderEnabled: true,
    triageProviderMode: "automated",
    arrivalProfile: [{ hourOffset: 0, expectedArrivals: 1 }],
  });
  const deck = generatePatientDeck(scenario).map((patient) => ({
    ...patient,
    arrivalMinute: 0,
    workupType: "none" as const,
    expectedLabMinutes: 0,
    expectedImagingMinutes: 0,
  }));
  let run = startSimulation(createSimulationRun(scenario, deck));

  run = advanceOneMinute(run, scenario);
  while (run.triageProvider.status === "busy") {
    run = advanceOneMinute(run, scenario);
  }

  const patient = run.patients[0];
  assertDefined(patient, "Expected no-workup automated triage patient.");
  assert.equal(patient.state, "waiting");
  assert.equal(patient.ordersPlacedAt, undefined);
  assert.equal(patient.triagedAt, run.currentMinute);
  assert.equal(run.decisions.length, 1);
  assert.equal(run.decisions[0]?.actionType, "complete_triage");
});

test("automated front-end triage disables manual triage actions", () => {
  const scenario = scenarioWith({
    triageProviderEnabled: true,
    triageProviderMode: "automated",
    arrivalProfile: [{ hourOffset: 0, expectedArrivals: 1 }],
  });
  const deck = generatePatientDeck(scenario).map((patient) => ({
    ...patient,
    arrivalMinute: 0,
    workupType: "basic_labs" as const,
    expectedLabMinutes: 30,
    expectedImagingMinutes: 0,
  }));
  let run = startSimulation(createSimulationRun(scenario, deck));
  run = advanceOneMinute(run, scenario);
  const patient = run.patients[0];
  assertDefined(patient, "Expected automated triage patient.");

  const actions = getAvailableProviderActions(run, patient.id);

  assert.equal(actions.find((action) => action.type === "complete_triage")?.enabled, false);
  assert.equal(actions.find((action) => action.type === "start_protocol_orders")?.enabled, false);
  assert.equal(
    actions.find((action) => action.type === "complete_triage")?.disabledReason,
    "Front-End Triage Provider is automated",
  );
});

test("front-end triage completion consumes symptom-based triage time", () => {
  const scenario = scenarioWith({
    triageProviderEnabled: true,
    triageProviderMode: "manual",
    arrivalProfile: [{ hourOffset: 0, expectedArrivals: 1 }],
    complaintDistribution: { values: [{ value: "shortness_of_breath", weight: 1 }] },
    triageDurationMultiplier: 1,
  });
  const deck = generatePatientDeck(scenario).map((patient) => ({
    ...patient,
    arrivalMinute: 0,
    complaintCategory: "shortness_of_breath" as const,
  }));
  let run = startSimulation(createSimulationRun(scenario, deck));
  run = advanceOneMinute(run, scenario);
  const patient = run.patients[0];
  assertDefined(patient, "Expected triage duration test patient.");

  const completeTriageAction = getAvailableProviderActions(run, patient.id).find(
    (action) => action.type === "complete_triage",
  );
  assert.equal(completeTriageAction?.timeCostMinutes, 8);

  run = applyProviderAction(run, "complete_triage", patient.id);
  assert.equal(run.triageProvider.status, "busy");
  assert.equal(run.triageProvider.busyUntilMinute, run.currentMinute + 8);
  assert.equal(run.patients[0]?.state, "triage");

  run = advanceTo(run, scenario, run.currentMinute + 8);

  assert.equal(run.triageProvider.status, "idle");
  assert.equal(run.patients[0]?.state, "waiting");
  assert.equal(run.decisions[0]?.timeCostMinutes, 8);
  assert.equal(run.decisions[0]?.resultingState, "waiting");
});

test("triage duration multiplier changes front-end triage timing deterministically", () => {
  const fastScenario = scenarioWith({
    triageProviderEnabled: true,
    triageProviderMode: "manual",
    arrivalProfile: [{ hourOffset: 0, expectedArrivals: 1 }],
    triageDurationMultiplier: 0.5,
  });
  const slowScenario = scenarioWith({
    triageProviderEnabled: true,
    triageProviderMode: "manual",
    arrivalProfile: [{ hourOffset: 0, expectedArrivals: 1 }],
    triageDurationMultiplier: 2,
  });
  const fastDeck = generatePatientDeck(fastScenario).map((patient) => ({
    ...patient,
    arrivalMinute: 0,
    complaintCategory: "minor_complaint" as const,
  }));
  const slowDeck = generatePatientDeck(slowScenario).map((patient) => ({
    ...patient,
    arrivalMinute: 0,
    complaintCategory: "minor_complaint" as const,
  }));
  let fastRun = startSimulation(createSimulationRun(fastScenario, fastDeck));
  let slowRun = startSimulation(createSimulationRun(slowScenario, slowDeck));
  fastRun = advanceOneMinute(fastRun, fastScenario);
  slowRun = advanceOneMinute(slowRun, slowScenario);

  const fastPatient = fastRun.patients[0];
  const slowPatient = slowRun.patients[0];
  assertDefined(fastPatient, "Expected fast triage test patient.");
  assertDefined(slowPatient, "Expected slow triage test patient.");
  const fastAction = getAvailableProviderActions(fastRun, fastPatient.id).find(
    (action) => action.type === "complete_triage",
  );
  const slowAction = getAvailableProviderActions(slowRun, slowPatient.id).find(
    (action) => action.type === "complete_triage",
  );

  assert.equal(fastAction?.timeCostMinutes, 2);
  assert.equal(slowAction?.timeCostMinutes, 6);

  fastRun = runTriageAction(fastRun, fastScenario, fastPatient.id);
  slowRun = runTriageAction(slowRun, slowScenario, slowPatient.id);

  assert.equal(fastRun.patients[0]?.triagedAt, 3);
  assert.equal(slowRun.patients[0]?.triagedAt, 7);
});

test("switching triage provider mode preserves triage history", () => {
  const scenario = scenarioWith({
    triageProviderEnabled: true,
    triageProviderMode: "manual",
    arrivalProfile: [{ hourOffset: 0, expectedArrivals: 2 }],
  });
  let run = startedNoWorkupRun(scenario);
  run = advanceTo(run, scenario, 60);
  const triagePatientId = firstTriagePatientId(run);
  run = runTriageAction(run, scenario, triagePatientId);
  run = setFrontEndTriageProviderMode(run, "unavailable");
  run = setFrontEndTriageProviderMode(run, "automated");

  const completedTriagePatient = run.patients.find((patient) => patient.id === triagePatientId);
  assertDefined(completedTriagePatient, "Expected completed triage patient.");
  assert.equal(completedTriagePatient.state, "waiting");
  assert.notEqual(completedTriagePatient.triagedAt, undefined);
  assert.equal(run.patients.filter((patient) => patient.state === "triage").length, 1);
  assert.equal(run.triageProviderMode, "automated");
  assert.equal(run.triageProviderEnabled, true);
});

test("same seed produces the same LWBS patients", () => {
  const scenario = scenarioWith({
    triageProviderEnabled: false,
    arrivalProfile: [{ hourOffset: 0, expectedArrivals: 3 }],
    lwbsProfile: {
      enabled: true,
      minimumWaitBeforeLWBS: 10,
      lowPatienceMultiplier: 10,
      highAcuityBlockedEsiLevels: [],
    },
  });
  let firstRun = startSimulation(createSimulationRun(scenario, forceLWBSDeck(scenario)));
  let secondRun = startSimulation(createSimulationRun(scenario, forceLWBSDeck(scenario)));

  firstRun = advanceTo(firstRun, scenario, 20);
  secondRun = advanceTo(secondRun, scenario, 20);

  assert.deepEqual(
    secondRun.patients.map((patient) => ({
      id: patient.id,
      state: patient.state,
      lwbsAt: patient.lwbsAt,
      departedAt: patient.departedAt,
      dispositionType: patient.dispositionType,
    })),
    firstRun.patients.map((patient) => ({
      id: patient.id,
      state: patient.state,
      lwbsAt: patient.lwbsAt,
      departedAt: patient.departedAt,
      dispositionType: patient.dispositionType,
    })),
  );
  assert.ok(firstRun.metrics.patientsLWBS > 0);
});

test("LWBS only occurs from waiting state", () => {
  const scenario = scenarioWith({
    triageProviderEnabled: false,
    arrivalProfile: [{ hourOffset: 0, expectedArrivals: 1 }],
    lwbsProfile: {
      enabled: true,
      minimumWaitBeforeLWBS: 0,
      lowPatienceMultiplier: 10,
      highAcuityBlockedEsiLevels: [],
    },
  });
  const deck = forceLWBSDeck(scenario);
  let run = startSimulation(createSimulationRun(scenario, deck));
  run = {
    ...run,
    currentMinute: 10,
    patients: run.patients.map((patient) => ({
      ...patient,
      state: "roomed" as const,
      arrivedAt: 0,
      roomedAt: 0,
      roomId: "room-01",
    })),
    rooms: run.rooms.map((room, index) =>
      index === 0 ? { ...room, status: "occupied" as const, patientId: deck[0]?.id } : room,
    ),
  };

  run = advanceOneMinute(run, scenario);

  assert.equal(run.patients[0]?.state, "roomed");
  assert.equal(run.metrics.patientsLWBS, 0);
});

test("patients do not LWBS before the minimum wait threshold", () => {
  const scenario = scenarioWith({
    triageProviderEnabled: false,
    arrivalProfile: [{ hourOffset: 0, expectedArrivals: 1 }],
    lwbsProfile: {
      enabled: true,
      minimumWaitBeforeLWBS: 20,
      lowPatienceMultiplier: 10,
      highAcuityBlockedEsiLevels: [],
    },
  });
  let run = startSimulation(createSimulationRun(scenario, forceLWBSDeck(scenario, { complaintCategory: "chest_pain" })));

  run = advanceTo(run, scenario, 20);

  assert.equal(run.patients[0]?.state, "waiting");
  assert.equal(run.metrics.patientsLWBS, 0);
});

test("LWBS disabled produces zero LWBS patients", () => {
  const scenario = scenarioWith({
    triageProviderEnabled: false,
    arrivalProfile: [{ hourOffset: 0, expectedArrivals: 2 }],
    lwbsProfile: {
      enabled: false,
      minimumWaitBeforeLWBS: 0,
      lowPatienceMultiplier: 10,
      highAcuityBlockedEsiLevels: [],
    },
  });
  let run = startSimulation(createSimulationRun(scenario, forceLWBSDeck(scenario)));

  run = advanceTo(run, scenario, 90);

  assert.equal(run.metrics.patientsLWBS, 0);
  assert.equal(run.patients.every((patient) => patient.state !== "lwbs"), true);
});

test("LWBS patients leave waiting census and count as departed", () => {
  const scenario = scenarioWith({
    triageProviderEnabled: false,
    arrivalProfile: [{ hourOffset: 0, expectedArrivals: 1 }],
    lwbsProfile: {
      enabled: true,
      minimumWaitBeforeLWBS: 10,
      lowPatienceMultiplier: 10,
      highAcuityBlockedEsiLevels: [],
    },
  });
  let run = startSimulation(createSimulationRun(scenario, forceLWBSDeck(scenario, { complaintCategory: "chest_pain" })));

  run = advanceTo(run, scenario, 12);
  const patient = run.patients[0];
  assertDefined(patient, "Expected LWBS test patient.");

  assert.equal(patient.state, "lwbs");
  assert.equal(patient.dispositionType, "lwbs");
  assert.equal(patient.lwbsAt, patient.departedAt);
  assert.equal(run.metrics.waitingRoomCensus, 0);
  assert.equal(run.metrics.patientsDeparted, 1);
  assert.equal(run.metrics.patientsLWBS, 1);
  assert.equal(run.metrics.lwbsRate, 1);
  assert.equal(run.metrics.averageWaitBeforeLWBS, 10);
  assert.equal(run.metrics.chestPainLWBS, 1);
  assert.equal(run.metrics.chestPainLWBSRate, 1);
});

test("LWBS does not release or affect rooms", () => {
  const scenario = scenarioWith({
    triageProviderEnabled: false,
    roomCapacity: 1,
    arrivalProfile: [{ hourOffset: 0, expectedArrivals: 1 }],
    lwbsProfile: {
      enabled: true,
      minimumWaitBeforeLWBS: 0,
      lowPatienceMultiplier: 10,
      highAcuityBlockedEsiLevels: [],
    },
  });
  let run = startSimulation(createSimulationRun(scenario, forceLWBSDeck(scenario)));
  run = {
    ...run,
    rooms: [{ id: "room-01", status: "occupied", patientId: "already-roomed" }],
  };

  run = advanceTo(run, scenario, 2);

  assert.equal(run.patients[0]?.state, "lwbs");
  assert.deepEqual(run.rooms, [{ id: "room-01", status: "occupied", patientId: "already-roomed" }]);
});

test("LWBS metrics and event details update correctly", () => {
  const scenario = scenarioWith({
    triageProviderEnabled: false,
    arrivalProfile: [{ hourOffset: 0, expectedArrivals: 1 }],
    lwbsProfile: {
      enabled: true,
      minimumWaitBeforeLWBS: 60,
      lowPatienceMultiplier: 10,
      highAcuityBlockedEsiLevels: [],
    },
  });
  const deck = forceLWBSDeck(scenario, { expectedLabMinutes: 30, expectedImagingMinutes: 0 });
  let run = startSimulation(createSimulationRun(scenario, deck));
  run = {
    ...run,
    patients: run.patients.map((patient) => ({
      ...patient,
      pendingItems: [{ type: "labs", orderedAt: 1, readyAt: 31, status: "pending" }],
    })),
  };

  run = advanceTo(run, scenario, 62);
  const lwbsEvent = run.events.find((event) => event.type === "patient_lwbs");

  assert.equal(run.metrics.patientsLWBS, 1);
  assert.equal(run.metrics.highRiskLWBS, 1);
  assert.equal(run.metrics.lwbsWithOrdersPending, 1);
  assertDefined(lwbsEvent, "Expected an LWBS event.");
  assert.equal(lwbsEvent.details?.waitMinutes, 60);
  assert.equal(lwbsEvent.details?.esi, 5);
  assert.equal(lwbsEvent.details?.riskLevel, "high");
  assert.equal(lwbsEvent.details?.patienceProfile, "low");
  assert.equal(lwbsEvent.details?.triageCompleted, false);
  assert.equal(lwbsEvent.details?.hadPendingOrders, true);
});

test("reset-style run recreation clears LWBS runtime state", () => {
  const scenario = scenarioWith({
    triageProviderEnabled: false,
    arrivalProfile: [{ hourOffset: 0, expectedArrivals: 1 }],
    lwbsProfile: {
      enabled: true,
      minimumWaitBeforeLWBS: 0,
      lowPatienceMultiplier: 10,
      highAcuityBlockedEsiLevels: [],
    },
  });
  const deck = forceLWBSDeck(scenario);
  let run = startSimulation(createSimulationRun(scenario, deck));
  run = advanceTo(run, scenario, 2);
  const resetRun = createSimulationRun(scenario, deck);

  assert.equal(run.metrics.patientsLWBS, 1);
  assert.equal(resetRun.metrics.patientsLWBS, 0);
  assert.equal(resetRun.patients[0]?.state, "not_arrived");
  assert.equal(resetRun.patients[0]?.lwbsAt, undefined);
});

test("disabling front-end triage moves current triage patients to the waiting room", () => {
  const scenario = scenarioWith({
    triageProviderEnabled: true,
    triageProviderMode: "manual",
    arrivalProfile: [{ hourOffset: 0, expectedArrivals: 2 }],
  });
  let run = startedRun(scenario);
  run = advanceTo(run, scenario, 60);

  assert.equal(run.metrics.triageCensus, 2);
  assert.equal(run.metrics.waitingRoomCensus, 0);

  run = setFrontEndTriageProviderEnabled(run, false);

  assert.equal(run.triageProviderEnabled, false);
  assert.equal(run.metrics.triageCensus, 0);
  assert.equal(run.metrics.waitingRoomCensus, 2);
  assert.equal(run.patients.filter((patient) => patient.state === "triage").length, 0);
  assert.equal(run.patients.filter((patient) => patient.state === "waiting").length, 2);
  assert.equal(run.events.filter((event) => event.type === "triage_bypassed").length, 2);
});

test("future arrivals bypass triage after front-end triage is disabled", () => {
  const scenario = scenarioWith({
    triageProviderEnabled: true,
    triageProviderMode: "manual",
    arrivalProfile: [
      { hourOffset: 0, expectedArrivals: 1 },
      { hourOffset: 1, expectedArrivals: 1 },
    ],
  });
  const deck = generatePatientDeck(scenario);
  let run = startSimulation(createSimulationRun(scenario, deck));
  const firstArrival = deck[0]?.arrivalMinute;
  const secondArrival = deck[1]?.arrivalMinute;
  assertDefined(firstArrival, "Expected first arrival.");
  assertDefined(secondArrival, "Expected second arrival.");

  run = advanceTo(run, scenario, firstArrival);
  run = setFrontEndTriageProviderEnabled(run, false);
  run = advanceTo(run, scenario, secondArrival);

  const secondPatient = run.patients.find((patient) => patient.id === deck[1]?.id);
  assertDefined(secondPatient, "Expected second patient.");
  assert.equal(secondPatient.state, "waiting");
  assert.equal(secondPatient.arrivalPath, "direct_waiting_room");
  assert.equal(run.metrics.triageCensus, 0);
});

test("reenabling front-end triage returns untriaged waiting patients to triage", () => {
  const scenario = scenarioWith({
    triageProviderEnabled: true,
    triageProviderMode: "manual",
    arrivalProfile: [{ hourOffset: 0, expectedArrivals: 2 }],
  });
  let run = startedRun(scenario);
  run = advanceTo(run, scenario, 60);
  run = setFrontEndTriageProviderEnabled(run, false);

  assert.equal(run.metrics.waitingRoomCensus, 2);
  assert.equal(run.patients.filter((patient) => patient.state === "waiting" && patient.triagedAt === undefined).length, 2);

  run = setFrontEndTriageProviderEnabled(run, true);

  assert.equal(run.triageProviderEnabled, true);
  assert.equal(run.metrics.triageCensus, 2);
  assert.equal(run.metrics.waitingRoomCensus, 0);
  assert.equal(run.patients.filter((patient) => patient.state === "triage" && patient.triagedAt === undefined).length, 2);
  assert.equal(run.events.filter((event) => event.type === "triage_reopened").length, 2);
});

test("reenabling front-end triage keeps completed triage patients in the waiting room", () => {
  const scenario = scenarioWith({
    triageProviderEnabled: true,
    triageProviderMode: "manual",
    arrivalProfile: [{ hourOffset: 0, expectedArrivals: 2 }],
  });
  let run = startedRun(scenario);
  run = advanceTo(run, scenario, 60);
  const completedTriagePatientId = firstTriagePatientId(run);
  run = runTriageAction(run, scenario, completedTriagePatientId);
  run = setFrontEndTriageProviderEnabled(run, false);

  assert.equal(run.metrics.waitingRoomCensus, 2);

  run = setFrontEndTriageProviderEnabled(run, true);

  const completedTriagePatient = run.patients.find((patient) => patient.id === completedTriagePatientId);
  assertDefined(completedTriagePatient, "Expected completed-triage patient.");
  assert.equal(completedTriagePatient.state, "waiting");
  assert.notEqual(completedTriagePatient.triagedAt, undefined);
  assert.equal(run.metrics.triageCensus, 1);
  assert.equal(run.metrics.waitingRoomCensus, 1);
  assert.equal(run.events.filter((event) => event.type === "triage_reopened").length, 1);
});

test("room capacity prevents rooming when no rooms are available", () => {
  const scenario = scenarioWith({
    triageProviderEnabled: false,
    roomCapacity: 1,
    arrivalProfile: [{ hourOffset: 0, expectedArrivals: 2 }],
  });
  let run = startedRun(scenario);
  run = advanceTo(run, scenario, 60);

  const firstWaitingId = firstPatientId(run);
  run = runAction(run, scenario, "room_patient", firstWaitingId);

  const secondWaiting = run.patients.find((patient) => patient.state === "waiting");
  assertDefined(secondWaiting, "Expected a second waiting patient.");

  const roomAction = getAvailableProviderActions(run, secondWaiting.id).find(
    (action) => action.type === "room_patient",
  );

  assert.equal(run.metrics.availableRooms, 0);
  assert.equal(roomAction?.enabled, false);
  assert.equal(roomAction?.disabledReason, "No ED room is available");
});

test("support resource constraints can prevent rooming despite room availability", () => {
  const scenario = scenarioWith({
    triageProviderEnabled: false,
    roomCapacity: 2,
    nurseCount: 1,
    techCount: 0,
    arrivalProfile: [{ hourOffset: 0, expectedArrivals: 1 }],
  });
  let run = startedRun(scenario);
  run = advanceTo(run, scenario, 60);

  const patientId = firstPatientId(run);
  const roomAction = getAvailableProviderActions(run, patientId).find((action) => action.type === "room_patient");

  assert.equal(run.metrics.availableRooms, 2);
  assert.equal(roomAction?.enabled, false);
  assert.equal(roomAction?.disabledReason, "tech resource unavailable");
});

test("support resources are reserved during rooming and released when the action completes", () => {
  const scenario = scenarioWith({
    triageProviderEnabled: false,
    roomCapacity: 2,
    providerCount: 2,
    nurseCount: 1,
    techCount: 1,
    arrivalProfile: [{ hourOffset: 0, expectedArrivals: 2 }],
  });
  let run = startedRun(scenario);
  run = advanceTo(run, scenario, 60);

  const firstWaitingId = firstPatientId(run);
  run = applyProviderAction(run, "room_patient", firstWaitingId);

  assert.equal(run.metrics.nursesBusy, 1);
  assert.equal(run.metrics.techsBusy, 1);

  const secondWaiting = run.patients.find((patient) => patient.state === "waiting" && patient.id !== firstWaitingId);
  assertDefined(secondWaiting, "Expected a second waiting patient.");
  const blockedRoomAction = getAvailableProviderActions(run, secondWaiting.id).find((action) => action.type === "room_patient");
  assert.equal(blockedRoomAction?.enabled, false);
  assert.equal(blockedRoomAction?.disabledReason, "nurse and tech resource unavailable");

  run = advanceTo(run, scenario, run.currentMinute + 2);

  assert.equal(run.metrics.nursesBusy, 0);
  assert.equal(run.metrics.techsBusy, 0);
  const availableRoomAction = getAvailableProviderActions(run, secondWaiting.id).find((action) => action.type === "room_patient");
  assert.equal(availableRoomAction?.enabled, true);
});

test("invalid provider actions are rejected without changing state or records", () => {
  const scenario = scenarioWith({
    triageProviderEnabled: false,
    arrivalProfile: [{ hourOffset: 0, expectedArrivals: 1 }],
  });
  let run = startedRun(scenario);
  run = advanceTo(run, scenario, 60);

  const patientId = firstPatientId(run);
  const beforePatient = run.patients.find((patient) => patient.id === patientId);
  assertDefined(beforePatient, "Expected waiting patient.");

  const nextRun = applyProviderAction(run, "review_results", patientId);
  const afterPatient = nextRun.patients.find((patient) => patient.id === patientId);
  assertDefined(afterPatient, "Expected patient after invalid action.");

  assert.equal(afterPatient.state, beforePatient.state);
  assert.equal(nextRun.decisions.length, run.decisions.length);
  assert.equal(nextRun.events.length, run.events.length);
  assert.equal(nextRun.provider.status, run.provider.status);
});

test("provider actions consume simulated time", () => {
  const scenario = scenarioWith({
    triageProviderEnabled: false,
    arrivalProfile: [{ hourOffset: 0, expectedArrivals: 1 }],
  });
  let run = startedRun(scenario);
  run = advanceTo(run, scenario, 60);

  const patientId = firstPatientId(run);
  const startedAt = run.currentMinute;
  run = applyProviderAction(run, "room_patient", patientId);

  assert.equal(run.provider.status, "busy");
  assert.equal(run.provider.busyUntilMinute, startedAt + 2);

  run = advanceOneMinute(run, scenario);
  assert.equal(run.provider.status, "busy");

  run = advanceOneMinute(run, scenario);
  assert.equal(run.provider.status, "idle");
  assert.equal(run.provider.busyMinutes, 2);
});

test("provider evaluation action time is adjusted by ESI acuity", () => {
  const scenario = scenarioWith({
    triageProviderEnabled: false,
    roomCapacity: 2,
    arrivalProfile: [{ hourOffset: 0, expectedArrivals: 2 }],
    timingProfile: {
      ...defaultScenario.timingProfile,
      providerEvaluation: { min: 8, typical: 12, max: 22 },
    },
  });
  const deck = generatePatientDeck(scenario).slice(0, 2).map((patient, index) => ({
    ...patient,
    arrivalMinute: 0,
    esi: index === 0 ? (1 as const) : (5 as const),
    workupType: "none" as const,
    expectedLabMinutes: 0,
    expectedImagingMinutes: 0,
  }));
  let run = startSimulation(createSimulationRun(scenario, deck));
  run = advanceOneMinute(run, scenario);
  const esiOnePatient = run.patients.find((patient) => patient.esi === 1);
  const esiFivePatient = run.patients.find((patient) => patient.esi === 5);
  assertDefined(esiOnePatient, "Expected ESI 1 patient.");
  assertDefined(esiFivePatient, "Expected ESI 5 patient.");

  run = runAction(run, scenario, "room_patient", esiOnePatient.id);
  run = runAction(run, scenario, "room_patient", esiFivePatient.id);

  const esiOneAction = getAvailableProviderActions(run, esiOnePatient.id).find((action) => action.type === "see_patient");
  const esiFiveAction = getAvailableProviderActions(run, esiFivePatient.id).find((action) => action.type === "see_patient");

  assert.equal(esiOneAction?.timeCostMinutes, 22);
  assert.equal(esiFiveAction?.timeCostMinutes, 7);
});

test("provider evaluation sampled duration stays within ESI-adjusted timing range", () => {
  const scenario = scenarioWith({
    triageProviderEnabled: false,
    arrivalProfile: [{ hourOffset: 0, expectedArrivals: 1 }],
    timingProfile: {
      ...defaultScenario.timingProfile,
      providerEvaluation: { min: 8, typical: 12, max: 22 },
    },
  });
  const deck = generatePatientDeck(scenario).slice(0, 1).map((patient) => ({
    ...patient,
    arrivalMinute: 0,
    esi: 1 as const,
    workupType: "none" as const,
    expectedLabMinutes: 0,
    expectedImagingMinutes: 0,
  }));
  let run = startSimulation(createSimulationRun(scenario, deck));
  run = advanceOneMinute(run, scenario);
  const patient = run.patients[0];
  assertDefined(patient, "Expected provider timing patient.");

  run = runAction(run, scenario, "room_patient", patient.id);
  const roomedPatient = run.patients.find((candidate) => candidate.id === patient.id);
  assertDefined(roomedPatient, "Expected roomed provider timing patient.");
  const adjustedRange = getProviderEvaluationTimingRange(roomedPatient, run.timingProfile.providerEvaluation);
  run = applyProviderAction(run, "see_patient", patient.id);
  const decision = run.decisions.at(-1);
  assertDefined(decision, "Expected see-patient decision.");

  assert.equal(adjustedRange.min, 14);
  assert.equal(adjustedRange.typical, 22);
  assert.equal(adjustedRange.max, 40);
  assert.ok(decision.timeCostMinutes >= adjustedRange.min);
  assert.ok(decision.timeCostMinutes <= adjustedRange.max);
});

test("multiple providers can work simultaneous patient actions", () => {
  const scenario = scenarioWith({
    providerCount: 2,
    nurseCount: 2,
    techCount: 2,
    roomCapacity: 2,
    triageProviderEnabled: false,
    arrivalProfile: [{ hourOffset: 0, expectedArrivals: 2 }],
  });
  const deck = generatePatientDeck(scenario).slice(0, 2).map((patient) => ({
    ...patient,
    arrivalMinute: 0,
    workupType: "none" as const,
    expectedLabMinutes: 0,
    expectedImagingMinutes: 0,
  }));
  let run = startSimulation(createSimulationRun(scenario, deck));
  run = advanceOneMinute(run, scenario);

  const waitingPatients = run.patients.filter((patient) => patient.state === "waiting");
  assert.equal(waitingPatients.length, 2);
  const firstWaitingPatient = waitingPatients[0];
  const secondWaitingPatient = waitingPatients[1];
  assertDefined(firstWaitingPatient, "Expected first waiting patient.");
  assertDefined(secondWaitingPatient, "Expected second waiting patient.");

  run = applyProviderAction(run, "room_patient", firstWaitingPatient.id);
  const firstProvider = run.providers[0];
  const secondProvider = run.providers[1];
  assertDefined(firstProvider, "Expected first provider.");
  assertDefined(secondProvider, "Expected second provider.");
  assert.equal(firstProvider.status, "busy");
  assert.equal(secondProvider.status, "idle");

  const secondRoomAction = getAvailableProviderActions(run, secondWaitingPatient.id).find(
    (action) => action.type === "room_patient",
  );
  assert.equal(secondRoomAction?.enabled, true);

  run = applyProviderAction(run, "room_patient", secondWaitingPatient.id);
  assert.equal(run.providers.every((provider) => provider.status === "busy"), true);
  const firstDecision = run.decisions[0];
  const secondDecision = run.decisions[1];
  assertDefined(firstDecision, "Expected first provider decision.");
  assertDefined(secondDecision, "Expected second provider decision.");
  assert.equal(firstDecision.providerId, "provider-001");
  assert.equal(secondDecision.providerId, "provider-002");

  run = advanceTo(run, scenario, run.currentMinute + 2);
  assert.equal(allProvidersIdle(run), true);
  assert.equal(run.metrics.providerBusyMinutes, 4);
  assert.equal(run.patients.filter((patient) => patient.state === "roomed").length, 2);
});

test("multiple providers cannot work the same patient at the same time", () => {
  const scenario = scenarioWith({
    providerCount: 2,
    roomCapacity: 1,
    triageProviderEnabled: false,
    arrivalProfile: [{ hourOffset: 0, expectedArrivals: 1 }],
  });
  const deck = generatePatientDeck(scenario).slice(0, 1).map((patient) => ({
    ...patient,
    arrivalMinute: 0,
    workupType: "none" as const,
    expectedLabMinutes: 0,
    expectedImagingMinutes: 0,
  }));
  let run = startSimulation(createSimulationRun(scenario, deck));
  run = advanceOneMinute(run, scenario);
  const patient = run.patients[0];
  assertDefined(patient, "Expected duplicate-assignment test patient.");

  run = runAction(run, scenario, "room_patient", patient.id);
  run = applyProviderAction(run, "see_patient", patient.id);

  const busyProvider = run.providers.find((provider) => provider.currentAction?.patientId === patient.id);
  assertDefined(busyProvider, "Expected one provider to be assigned to patient.");
  const seeActionWhileAssigned = getAvailableProviderActions(run, patient.id).find((action) => action.type === "see_patient");
  assert.equal(seeActionWhileAssigned?.enabled, false);
  assert.equal(seeActionWhileAssigned?.disabledReason, "Provider 1 is already working with this patient");

  const nextRun = applyProviderAction(run, "see_patient", patient.id);

  assert.equal(nextRun.providers.filter((provider) => provider.currentAction?.patientId === patient.id).length, 1);
  assert.equal(nextRun.decisions.length, run.decisions.length);
});

test("assigned provider model keeps follow-up actions with the owning provider", () => {
  const scenario = scenarioWith({
    providerAssignmentMode: "assigned",
    providerCount: 2,
    nurseCount: 2,
    techCount: 2,
    roomCapacity: 3,
    triageProviderEnabled: false,
    arrivalProfile: [{ hourOffset: 0, expectedArrivals: 3 }],
  });
  const deck = generatePatientDeck(scenario).slice(0, 3).map((patient) => ({
    ...patient,
    arrivalMinute: 0,
    workupType: "none" as const,
    expectedLabMinutes: 0,
    expectedImagingMinutes: 0,
  }));
  let run = startSimulation(createSimulationRun(scenario, deck));
  run = advanceOneMinute(run, scenario);
  const firstPatient = run.patients[0];
  const secondPatient = run.patients[1];
  const thirdPatient = run.patients[2];
  assertDefined(firstPatient, "Expected first assigned-model patient.");
  assertDefined(secondPatient, "Expected second assigned-model patient.");
  assertDefined(thirdPatient, "Expected third assigned-model patient.");

  run = applyProviderAction(run, "room_patient", firstPatient.id);
  run = applyProviderAction(run, "room_patient", secondPatient.id);
  run = advanceTo(run, scenario, run.currentMinute + 2);
  run = applyProviderAction(run, "room_patient", thirdPatient.id);
  run = advanceTo(run, scenario, run.currentMinute + 2);

  const ownedFirstPatient = run.patients.find((patient) => patient.id === firstPatient.id);
  const ownedThirdPatient = run.patients.find((patient) => patient.id === thirdPatient.id);
  assertDefined(ownedFirstPatient, "Expected first patient to remain in run.");
  assertDefined(ownedThirdPatient, "Expected third patient to remain in run.");
  assert.equal(ownedFirstPatient.assignedProviderId, "provider-001");
  assert.equal(ownedThirdPatient.assignedProviderId, "provider-001");

  run = applyProviderAction(run, "see_patient", thirdPatient.id);
  const firstSeeAction = getAvailableProviderActions(run, firstPatient.id).find((action) => action.type === "see_patient");

  assert.equal(firstSeeAction?.enabled, false);
  assert.equal(firstSeeAction?.disabledReason, "Provider 1 owns this patient and is busy");
});

test("assigned handoff model transfers ownership when the owner is unavailable", () => {
  const scenario = scenarioWith({
    providerAssignmentMode: "assigned_with_handoff",
    providerCount: 2,
    nurseCount: 2,
    techCount: 2,
    roomCapacity: 3,
    triageProviderEnabled: false,
    arrivalProfile: [{ hourOffset: 0, expectedArrivals: 3 }],
  });
  const deck = generatePatientDeck(scenario).slice(0, 3).map((patient) => ({
    ...patient,
    arrivalMinute: 0,
    workupType: "none" as const,
    expectedLabMinutes: 0,
    expectedImagingMinutes: 0,
  }));
  let run = startSimulation(createSimulationRun(scenario, deck));
  run = advanceOneMinute(run, scenario);
  const firstPatient = run.patients[0];
  const secondPatient = run.patients[1];
  const thirdPatient = run.patients[2];
  assertDefined(firstPatient, "Expected first handoff-model patient.");
  assertDefined(secondPatient, "Expected second handoff-model patient.");
  assertDefined(thirdPatient, "Expected third handoff-model patient.");

  run = applyProviderAction(run, "room_patient", firstPatient.id);
  run = applyProviderAction(run, "room_patient", secondPatient.id);
  run = advanceTo(run, scenario, run.currentMinute + 2);
  run = applyProviderAction(run, "room_patient", thirdPatient.id);
  run = advanceTo(run, scenario, run.currentMinute + 2);
  run = applyProviderAction(run, "see_patient", thirdPatient.id);
  const firstSeeAction = getAvailableProviderActions(run, firstPatient.id).find((action) => action.type === "see_patient");
  assert.equal(firstSeeAction?.enabled, true);

  run = applyProviderAction(run, "see_patient", firstPatient.id);
  const handedOffPatient = run.patients.find((patient) => patient.id === firstPatient.id);
  assertDefined(handedOffPatient, "Expected handed-off patient to remain in run.");
  assert.equal(handedOffPatient.assignedProviderId, "provider-002");
});

test("front-end triage provider can act while ED provider is busy", () => {
  const scenario = scenarioWith({
    providerCount: 1,
    roomCapacity: 2,
    triageProviderEnabled: true,
    triageProviderMode: "manual",
    arrivalProfile: [{ hourOffset: 0, expectedArrivals: 2 }],
    workupDistribution: { values: [{ value: "basic_labs", weight: 1 }] },
  });
  const deck = generatePatientDeck(scenario).slice(0, 2).map((patient, index) => ({
    ...patient,
    arrivalMinute: 0,
    workupType: "basic_labs" as const,
    expectedLabMinutes: 20,
    expectedImagingMinutes: 0,
    patientNumber: index + 1,
  }));
  let run = startSimulation(createSimulationRun(scenario, deck));
  run = advanceOneMinute(run, scenario);

  const triagePatients = run.patients.filter((patient) => patient.state === "triage");
  assert.equal(triagePatients.length, 2);
  const firstTriagePatient = triagePatients[0];
  const secondTriagePatient = triagePatients[1];
  assertDefined(firstTriagePatient, "Expected first triage patient.");
  assertDefined(secondTriagePatient, "Expected second triage patient.");

  run = runTriageAction(run, scenario, firstTriagePatient.id);
  run = applyProviderAction(run, "room_patient", firstTriagePatient.id);
  run = advanceTo(run, scenario, run.currentMinute + 2);
  run = applyProviderAction(run, "see_patient", firstTriagePatient.id);
  assert.equal(run.provider.status, "busy");

  const protocolAction = getAvailableProviderActions(run, secondTriagePatient.id).find(
    (action) => action.type === "start_protocol_orders",
  );
  const completeTriageAction = getAvailableProviderActions(run, secondTriagePatient.id).find(
    (action) => action.type === "complete_triage",
  );
  assert.equal(protocolAction?.enabled, true);
  assert.equal(completeTriageAction?.enabled, true);

  run = applyProviderAction(run, "start_protocol_orders", secondTriagePatient.id);
  const triageDecision = run.decisions.at(-1);
  assertDefined(triageDecision, "Expected triage-provider decision.");
  assert.equal(triageDecision.providerId, "front-end-triage-provider");
});

test("continue waiting records a zero-time decision without advancing provider work", () => {
  const scenario = scenarioWith({
    triageProviderEnabled: false,
    arrivalProfile: [{ hourOffset: 0, expectedArrivals: 1 }],
  });
  let run = startedRun(scenario);
  run = advanceTo(run, scenario, 60);

  const patientId = firstPatientId(run);
  const action = getAvailableProviderActions(run, patientId).find((candidate) => candidate.type === "continue_waiting");
  assert.equal(action?.timeCostMinutes, 0);

  const currentMinute = run.currentMinute;
  run = applyProviderAction(run, "continue_waiting", patientId);

  const decision = run.decisions[0];
  assertDefined(decision, "Expected continue-waiting decision.");
  assert.equal(run.currentMinute, currentMinute);
  assert.equal(run.provider.status, "idle");
  assert.equal(decision.timeCostMinutes, 0);
  assert.equal(decision.previousState, "waiting");
  assert.equal(decision.resultingState, "waiting");
});

test("front-end triage provider can start protocol orders before the waiting room", () => {
  const scenario = scenarioWith({
    triageProviderEnabled: true,
    triageProviderMode: "manual",
    arrivalProfile: [{ hourOffset: 0, expectedArrivals: 1 }],
    workupDistribution: { values: [{ value: "basic_labs", weight: 1 }] },
  });
  let run = startedRun(scenario);
  run = advanceTo(run, scenario, 60);

  const patientId = firstTriagePatientId(run);
  const protocolAction = getAvailableProviderActions(run, patientId).find(
    (action) => action.type === "start_protocol_orders",
  );

  assert.equal(protocolAction?.enabled, true);
  run = applyProviderAction(run, "start_protocol_orders", patientId);

  const patient = run.patients.find((candidate) => candidate.id === patientId);
  assertDefined(patient, "Expected patient to exist.");
  assert.equal(patient.state, "triage");
  assert.equal(patient.ordersPlacedAt, run.currentMinute);
  assert.equal(patient.pendingItems.length, 1);
  assert.equal(run.provider.status, "idle");
});

test("protocol orders are unavailable without front-end triage provider", () => {
  const scenario = scenarioWith({
    triageProviderEnabled: false,
    arrivalProfile: [{ hourOffset: 0, expectedArrivals: 1 }],
    workupDistribution: { values: [{ value: "basic_labs", weight: 1 }] },
  });
  let run = startedRun(scenario);
  run = advanceTo(run, scenario, 60);

  const patientId = firstPatientId(run);
  const protocolAction = getAvailableProviderActions(run, patientId).find(
    (action) => action.type === "start_protocol_orders",
  );

  assert.equal(protocolAction, undefined);
});

test("provider seeing a roomed patient with pending protocol orders moves patient to results pending", () => {
  const scenario = scenarioWith({
    triageProviderEnabled: true,
    triageProviderMode: "manual",
    arrivalProfile: [{ hourOffset: 0, expectedArrivals: 1 }],
    workupDistribution: { values: [{ value: "basic_labs", weight: 1 }] },
  });
  let run = startedRun(scenario);
  run = advanceTo(run, scenario, 60);

  const patientId = firstTriagePatientId(run);
  run = applyProviderAction(run, "start_protocol_orders", patientId);
  run = runTriageAction(run, scenario, patientId);
  run = runAction(run, scenario, "room_patient", patientId);
  run = runAction(run, scenario, "see_patient", patientId);

  const patient = run.patients.find((candidate) => candidate.id === patientId);
  assert.equal(patient?.state, "results_pending");
  assert.equal(patient?.providerSeenAt, run.currentMinute);
});

test("cardiac protocol orders create ECG and serial troponin workflow events and metrics", () => {
  const scenario = scenarioWith({
    triageProviderEnabled: true,
    triageProviderMode: "manual",
    arrivalProfile: [{ hourOffset: 0, expectedArrivals: 1 }],
    complaintDistribution: { values: [{ value: "suspected_acs", weight: 1 }] },
    workflowTimingProfile: {
      ...defaultScenario.workflowTimingProfile,
      repeatTroponinDelayMinutes: 45,
      stemiDoorToEcgTargetMinutes: 4,
    },
  });
  const deck = generatePatientDeck(scenario).map((patient) => ({
    ...patient,
    arrivalMinute: 0,
    esi: 2 as const,
    complaintCategory: "suspected_acs" as const,
    workupType: "cardiac" as const,
    cardiacPathway: "stemi_alert" as const,
    expectedLabMinutes: 15,
    expectedImagingMinutes: 20,
  }));
  let run = startSimulation(createSimulationRun(scenario, deck));
  run = advanceOneMinute(run, scenario);

  const patientId = firstTriagePatientId(run);
  run = applyProviderAction(run, "start_protocol_orders", patientId);

  let patient = run.patients.find((candidate) => candidate.id === patientId);
  assertDefined(patient, "Expected cardiac protocol patient.");
  assert.equal(patient.stemiAlertActivatedAt, undefined);
  assert.deepEqual(
    patient.pendingItems.map((item) => item.type),
    ["ecg", "troponin", "repeat_troponin", "chest_xray"],
  );

  const orderedAt = patient.ordersPlacedAt ?? run.currentMinute;
  run = advanceTo(run, scenario, orderedAt + 4);
  patient = run.patients.find((candidate) => candidate.id === patientId);
  assertDefined(patient, "Expected cardiac protocol patient after ECG.");
  assert.equal(patient.ecgCompletedAt, orderedAt + 4);
  assert.equal(patient.ecgReviewedAt, patient.ecgCompletedAt);
  assert.equal(patient.stemiAlertActivatedAt, patient.ecgCompletedAt);
  assert.equal(patient.pendingItems.find((item) => item.type === "ecg")?.status, "ready");
  assert.equal(run.events.some((event) => event.type === "ecg_completed" && event.patientId === patientId), true);
  assert.equal(run.events.some((event) => event.type === "ecg_reviewed" && event.patientId === patientId), true);
  assert.equal(run.events.some((event) => event.type === "stemi_alert_activated" && event.patientId === patientId), true);
  assert.equal(run.metrics.stemiAlertsActivated, 1);
  assert.equal(run.metrics.averageDoorToEcgMinutes, patient.ecgCompletedAt - (patient.arrivedAt ?? 0));
  assert.equal(run.metrics.doorToEcgWithin10Rate, 1);
  assert.equal(run.metrics.ecgReviewedWithin10Rate, 1);
  assert.equal(run.metrics.averageEcgToStemiActivationMinutes, 0);
  assert.equal(run.metrics.averageDoorToTroponinCollectionMinutes, orderedAt - (patient.arrivedAt ?? 0));
  assert.equal(run.metrics.averageTroponinTurnaroundMinutes, 15);

  run = runTriageAction(run, scenario, patientId);
  run = runAction(run, scenario, "room_patient", patientId);
  patient = run.patients.find((candidate) => candidate.id === patientId);
  assertDefined(patient, "Expected roomed cardiac protocol patient.");
  assert.equal(patient.state, "results_pending");

  run = advanceTo(run, scenario, orderedAt + 60);
  patient = run.patients.find((candidate) => candidate.id === patientId);
  assertDefined(patient, "Expected cardiac results-ready patient.");
  assert.equal(patient.state, "results_ready");
  assert.equal(patient.pendingItems.every((item) => item.status === "ready"), true);
  assert.equal(run.metrics.cardiacResultsReadyAwaitingReview, 1);
});

test("sepsis protocol orders create timed bundle items and metrics", () => {
  const scenario = scenarioWith({
    triageProviderEnabled: true,
    triageProviderMode: "manual",
    arrivalProfile: [{ hourOffset: 0, expectedArrivals: 1 }],
    complaintDistribution: { values: [{ value: "sepsis_concern", weight: 1 }] },
    workflowTimingProfile: {
      ...defaultScenario.workflowTimingProfile,
      sepsisAntibioticsMinutes: 40,
      sepsisBloodCultureMinutes: 9,
      sepsisFluidsMinutes: 25,
      sepsisLactateCollectionMinutes: 6,
    },
  });
  const deck = generatePatientDeck(scenario).map((patient) => ({
    ...patient,
    arrivalMinute: 0,
    esi: 2 as const,
    complaintCategory: "sepsis_concern" as const,
    workupType: "complex" as const,
    expectedLabMinutes: 30,
    expectedImagingMinutes: 0,
  }));
  let run = startSimulation(createSimulationRun(scenario, deck));
  run = advanceOneMinute(run, scenario);

  const patientId = firstTriagePatientId(run);
  run = applyProviderAction(run, "start_protocol_orders", patientId);

  let patient = run.patients.find((candidate) => candidate.id === patientId);
  assertDefined(patient, "Expected sepsis protocol patient.");
  assert.equal(patient.sepsisRecognizedAt, run.currentMinute);
  assert.deepEqual(
    patient.pendingItems.map((item) => item.type),
    ["lactate", "blood_cultures", "antibiotics", "iv_fluids"],
  );

  const orderedAt = patient.ordersPlacedAt ?? run.currentMinute;
  run = advanceTo(run, scenario, orderedAt + 40);
  patient = run.patients.find((candidate) => candidate.id === patientId);
  assertDefined(patient, "Expected sepsis protocol patient after bundle timing.");

  assert.equal(patient.pendingItems.find((item) => item.type === "lactate")?.status, "ready");
  assert.equal(patient.pendingItems.find((item) => item.type === "blood_cultures")?.status, "ready");
  assert.equal(patient.pendingItems.find((item) => item.type === "iv_fluids")?.status, "ready");
  assert.equal(patient.pendingItems.find((item) => item.type === "antibiotics")?.status, "ready");
  assert.equal(run.metrics.sepsisPatientsArrived, 1);
  assert.equal(run.metrics.sepsisPathwayStarted, 1);
  assert.equal(run.metrics.sepsisRecognitionWithin10Rate, 1);
  assert.equal(run.metrics.averageDoorToSepsisRecognitionMinutes, orderedAt - (patient.arrivedAt ?? 0));
  assert.equal(run.metrics.averageDoorToLactateCollectionMinutes, orderedAt + 6 - (patient.arrivedAt ?? 0));
  assert.equal(run.metrics.averageDoorToLactateResultMinutes, orderedAt + 30 - (patient.arrivedAt ?? 0));
  assert.equal(run.metrics.averageDoorToBloodCulturesMinutes, orderedAt + 9 - (patient.arrivedAt ?? 0));
  assert.equal(run.metrics.averageDoorToAntibioticsMinutes, orderedAt + 40 - (patient.arrivedAt ?? 0));
  assert.equal(run.metrics.sepsisAntibioticsWithin60Rate, 1);
  assert.equal(run.metrics.medianDoorToAntibioticsMinutes, orderedAt + 40 - (patient.arrivedAt ?? 0));
  assert.equal(run.metrics.p90DoorToAntibioticsMinutes, orderedAt + 40 - (patient.arrivedAt ?? 0));
  assert.equal(run.metrics.averageDoorToFluidsMinutes, orderedAt + 25 - (patient.arrivedAt ?? 0));
});

test("sepsis concern patients waiting without a room are tracked as critical flow risk", () => {
  const scenario = scenarioWith({
    triageProviderEnabled: false,
    arrivalProfile: [{ hourOffset: 0, expectedArrivals: 1 }],
    complaintDistribution: { values: [{ value: "sepsis_concern", weight: 1 }] },
    workflowTimingProfile: {
      ...defaultScenario.workflowTimingProfile,
      sepsisCriticalWaitMinutes: 20,
    },
  });
  const deck = generatePatientDeck(scenario).map((patient) => ({
    ...patient,
    arrivalMinute: 0,
    complaintCategory: "sepsis_concern" as const,
    workupType: "complex" as const,
  }));
  let run = startSimulation(createSimulationRun(scenario, deck));

  run = advanceTo(run, scenario, 19);
  assert.equal(run.patients[0]?.riskLevel, "low");

  run = advanceTo(run, scenario, 21);
  const patient = run.patients[0];
  assertDefined(patient, "Expected sepsis waiting patient.");

  assert.equal(patient.state, "waiting");
  assert.equal(patient.riskLevel, "critical");
  assert.equal(run.metrics.sepsisPatientsArrived, 1);
  assert.equal(run.metrics.sepsisWaitingWithoutRoom, 1);
});

test("cardiac ECG target completes under ten minutes when protocol starts promptly", () => {
  const scenario = scenarioWith({
    triageProviderEnabled: true,
    triageProviderMode: "manual",
    arrivalProfile: [{ hourOffset: 0, expectedArrivals: 1 }],
    complaintDistribution: { values: [{ value: "chest_pain", weight: 1 }] },
  });
  const deck = generatePatientDeck(scenario).map((patient) => ({
    ...patient,
    arrivalMinute: 0,
    complaintCategory: "chest_pain" as const,
    workupType: "cardiac" as const,
    cardiacPathway: "possible_acs" as const,
    expectedLabMinutes: 15,
    expectedImagingMinutes: 20,
  }));
  let run = startSimulation(createSimulationRun(scenario, deck));
  run = advanceOneMinute(run, scenario);

  const patientId = firstTriagePatientId(run);
  run = applyProviderAction(run, "start_protocol_orders", patientId);
  let patient = run.patients.find((candidate) => candidate.id === patientId);
  assertDefined(patient, "Expected cardiac protocol patient.");
  const expectedEcgReadyAt = patient.pendingItems.find((item) => item.type === "ecg")?.readyAt;
  assert.equal(expectedEcgReadyAt, (patient.arrivedAt ?? 0) + 8);

  run = advanceTo(run, scenario, expectedEcgReadyAt ?? run.currentMinute);
  patient = run.patients.find((candidate) => candidate.id === patientId);
  assertDefined(patient, "Expected cardiac protocol patient after ECG.");
  assert.equal((patient.ecgCompletedAt ?? 0) - (patient.arrivedAt ?? 0), 8);
  assert.equal(run.metrics.averageDoorToEcgMinutes, 8);
  assert.equal(run.metrics.medianDoorToEcgMinutes, 8);
  assert.equal(run.metrics.p90DoorToEcgMinutes, 8);
  assert.equal(run.metrics.delayedEcgCount, 0);
});

test("automated triage prioritizes cardiac protocol orders for door-to-ECG flow", () => {
  const scenario = scenarioWith({
    triageProviderEnabled: true,
    triageProviderMode: "automated",
    arrivalProfile: [{ hourOffset: 0, expectedArrivals: 2 }],
  });
  const generatedDeck = generatePatientDeck(scenario);
  const deck = generatedDeck.slice(0, 2).map((patient, index) => ({
    ...patient,
    arrivalMinute: 0,
    esi: index === 0 ? (1 as const) : (3 as const),
    complaintCategory: index === 0 ? ("injury" as const) : ("chest_pain" as const),
    workupType: index === 0 ? ("labs_imaging" as const) : ("cardiac" as const),
    cardiacPathway: index === 0 ? ("none" as const) : ("possible_acs" as const),
    expectedLabMinutes: 15,
    expectedImagingMinutes: 20,
  }));
  let run = startSimulation(createSimulationRun(scenario, deck));
  run = advanceOneMinute(run, scenario);

  const cardiacPatient = run.patients.find((patient) => patient.cardiacPathway === "possible_acs");
  assertDefined(cardiacPatient, "Expected cardiac patient.");
  const updatedCardiacPatient = run.patients.find((patient) => patient.id === cardiacPatient.id);
  assertDefined(updatedCardiacPatient, "Expected updated cardiac patient.");
  assert.equal(updatedCardiacPatient.ordersPlacedAt, run.currentMinute);
  assert.equal(updatedCardiacPatient.pendingItems.some((item) => item.type === "ecg"), true);
});

test("rooming a patient with pending protocol labs and imaging moves through results workflow", () => {
  const scenario = scenarioWith({
    triageProviderEnabled: true,
    triageProviderMode: "manual",
    arrivalProfile: [{ hourOffset: 0, expectedArrivals: 1 }],
    complaintDistribution: { values: [{ value: "abdominal_pain", weight: 1 }] },
  });
  const deck = generatePatientDeck(scenario).map((patient) => ({
    ...patient,
    arrivalMinute: 0,
    workupType: "labs_imaging" as const,
    expectedLabMinutes: 10,
    expectedImagingMinutes: 20,
  }));
  let run = startSimulation(createSimulationRun(scenario, deck));
  run = advanceOneMinute(run, scenario);

  const patientId = firstTriagePatientId(run);
  run = applyProviderAction(run, "start_protocol_orders", patientId);
  run = runTriageAction(run, scenario, patientId);
  run = runAction(run, scenario, "room_patient", patientId);

  let patient = run.patients.find((candidate) => candidate.id === patientId);
  assertDefined(patient, "Expected roomed protocol patient.");
  assert.equal(patient.state, "results_pending");
  assert.equal(patient.pendingItems.some((item) => item.type === "labs" && item.status === "pending"), true);
  assert.equal(patient.pendingItems.some((item) => item.type === "imaging" && item.status === "pending"), true);
  assert.equal(getAvailableProviderActions(run, patientId).some((action) => action.type === "see_patient" && action.enabled), true);

  run = advanceTo(run, scenario, (patient.ordersPlacedAt ?? run.currentMinute) + 10);
  patient = run.patients.find((candidate) => candidate.id === patientId);
  assertDefined(patient, "Expected patient after labs ready.");
  assert.equal(patient.state, "results_pending");
  assert.equal(patient.pendingItems.some((item) => item.type === "labs" && item.status === "ready"), true);
  assert.equal(patient.pendingItems.some((item) => item.type === "imaging" && item.status === "pending"), true);

  run = advanceTo(run, scenario, (patient.ordersPlacedAt ?? run.currentMinute) + 20);
  patient = run.patients.find((candidate) => candidate.id === patientId);
  assertDefined(patient, "Expected patient after all results ready.");
  assert.equal(patient.state, "results_ready");
  assert.equal(patient.pendingItems.every((item) => item.status === "ready"), true);
  assert.equal(getAvailableProviderActions(run, patientId).some((action) => action.type === "see_patient" && action.enabled), true);

  run = runAction(run, scenario, "see_patient", patientId);
  patient = run.patients.find((candidate) => candidate.id === patientId);
  assert.equal(patient?.state, "results_ready");
  assert.equal(getAvailableProviderActions(run, patientId).some((action) => action.type === "review_results" && action.enabled), true);
});

test("provider can review completed triage results after seeing the patient", () => {
  const scenario = scenarioWith({
    triageProviderEnabled: true,
    triageProviderMode: "manual",
    arrivalProfile: [{ hourOffset: 0, expectedArrivals: 1 }],
    workupDistribution: { values: [{ value: "basic_labs", weight: 1 }] },
  });
  let run = startedRun(scenario);
  run = advanceTo(run, scenario, 60);

  const patientId = firstTriagePatientId(run);
  run = applyProviderAction(run, "start_protocol_orders", patientId);

  const orderedPatient = run.patients.find((candidate) => candidate.id === patientId);
  assertDefined(orderedPatient, "Expected ordered patient to exist.");
  const resultMinute = orderedPatient.pendingItems[0]?.readyAt;
  assertDefined(resultMinute, "Expected protocol order result time.");

  run = advanceTo(run, scenario, resultMinute);
  run = runTriageAction(run, scenario, patientId);
  run = runAction(run, scenario, "room_patient", patientId);
  run = runAction(run, scenario, "see_patient", patientId);

  const seenPatient = run.patients.find((candidate) => candidate.id === patientId);
  assert.equal(seenPatient?.state, "results_ready");

  const reviewAction = getAvailableProviderActions(run, patientId).find((action) => action.type === "review_results");
  assert.equal(reviewAction?.enabled, true);

  run = runAction(run, scenario, "review_results", patientId);
  const patient = run.patients.find((candidate) => candidate.id === patientId);
  assert.equal(patient?.state, "ready_for_disposition");
});

test("discharge releases the room and updates metrics", () => {
  const scenario = scenarioWith({
    triageProviderEnabled: false,
    arrivalProfile: [{ hourOffset: 0, expectedArrivals: 1 }],
  });
  let run = startedNoWorkupRun(scenario);
  run = advanceTo(run, scenario, 60);

  const patientId = firstPatientId(run);
  run = runAction(run, scenario, "room_patient", patientId);
  run = runAction(run, scenario, "see_patient", patientId);
  run = runAction(run, scenario, "place_orders", patientId);
  run = runAction(run, scenario, "review_results", patientId);
  run = runAction(run, scenario, "discharge_home", patientId);

  const patient = run.patients.find((candidate) => candidate.id === patientId);
  assert.equal(patient?.state, "departed");
  assert.equal(patient?.dispositionType, "discharge_home");
  assert.equal(run.metrics.patientsDeparted, 1);
  assert.equal(run.metrics.patientsDispositioned, 1);
  assert.equal(run.metrics.availableRooms, scenario.roomCapacity - 1);
  assert.equal(run.metrics.cleaningRooms, 1);
  const cleaningRoom = run.rooms.find((room) => room.previousPatientId === patientId);
  assert.equal(cleaningRoom?.status, "cleaning");
  assert.equal(run.events.some((event) => event.type === "room_cleaning_started"), true);

  run = advanceTo(run, scenario, cleaningRoom?.cleaningReadyAt ?? run.currentMinute);

  assert.equal(run.metrics.availableRooms, scenario.roomCapacity);
  assert.equal(run.metrics.cleaningRooms, 0);
  assert.equal(run.events.some((event) => event.type === "room_available"), true);
});

test("valid provider actions move a patient through the expected state path", () => {
  const scenario = scenarioWith({
    triageProviderEnabled: false,
    arrivalProfile: [{ hourOffset: 0, expectedArrivals: 1 }],
  });
  let run = startedNoWorkupRun(scenario);
  run = advanceTo(run, scenario, 60);

  const patientId = firstPatientId(run);
  const states = [run.patients.find((patient) => patient.id === patientId)?.state];

  run = runAction(run, scenario, "room_patient", patientId);
  states.push(run.patients.find((patient) => patient.id === patientId)?.state);
  run = runAction(run, scenario, "see_patient", patientId);
  states.push(run.patients.find((patient) => patient.id === patientId)?.state);
  run = runAction(run, scenario, "place_orders", patientId);
  states.push(run.patients.find((patient) => patient.id === patientId)?.state);
  run = runAction(run, scenario, "review_results", patientId);
  states.push(run.patients.find((patient) => patient.id === patientId)?.state);
  run = runAction(run, scenario, "discharge_home", patientId);
  states.push(run.patients.find((patient) => patient.id === patientId)?.state);

  assert.deepEqual(states, [
    "waiting",
    "roomed",
    "provider_seen",
    "results_ready",
    "ready_for_disposition",
    "departed",
  ]);
  assert.equal(run.decisions.length, 5);
  assert.equal(run.events.some((event) => event.type === "patient_departed"), true);
});

test("admitted patients board and keep the room blocked until departure", () => {
  const scenario = scenarioWith({
    triageProviderEnabled: false,
    roomCapacity: 1,
    arrivalProfile: [{ hourOffset: 0, expectedArrivals: 1 }],
    boardingProfile: {
      enabled: true,
      admitBoardingDelayMin: 5,
      admitBoardingDelayMax: 5,
    },
    timingProfile: {
      ...defaultScenario.timingProfile,
      admissionDecision: { min: 5, typical: 5, max: 5 },
      boardingDuration: { min: 5, typical: 5, max: 5 },
      roomCleaning: { min: 5, typical: 5, max: 5 },
    },
  });
  let run = startedNoWorkupRun(scenario);
  run = advanceTo(run, scenario, 60);

  const patientId = firstPatientId(run);
  run = runAction(run, scenario, "room_patient", patientId);
  run = runAction(run, scenario, "see_patient", patientId);
  run = runAction(run, scenario, "place_orders", patientId);
  run = runAction(run, scenario, "review_results", patientId);
  run = runAction(run, scenario, "admit_inpatient", patientId);

  let patient = run.patients.find((candidate) => candidate.id === patientId);
  assert.equal(patient?.state, "admission_pending");
  assert.equal(run.metrics.admissionPendingCensus, 1);
  assert.equal(run.metrics.boardingCensus, 0);
  assert.equal(run.metrics.availableRooms, 0);

  run = advanceTo(run, scenario, run.currentMinute + 5);

  patient = run.patients.find((candidate) => candidate.id === patientId);
  assert.equal(patient?.state, "boarding");
  assert.equal(patient?.admissionAcceptedAt, run.currentMinute);
  assert.equal(run.metrics.admissionPendingCensus, 0);
  assert.equal(run.metrics.boardingCensus, 1);
  assert.equal(run.metrics.averageAdmissionDecisionMinutes, 5);
  assert.equal(run.events.some((event) => event.type === "admission_accepted" && event.patientId === patientId), true);

  run = advanceTo(run, scenario, run.currentMinute + 5);

  patient = run.patients.find((candidate) => candidate.id === patientId);
  assert.equal(patient?.state, "departed");
  assert.equal(patient?.dispositionType, "admit_inpatient");
  assert.equal(run.metrics.boardingCensus, 0);
  assert.equal(run.metrics.availableRooms, 0);
  assert.equal(run.metrics.cleaningRooms, 1);
  assert.equal(run.metrics.totalBoardingMinutes, 5);

  run = advanceTo(run, scenario, run.currentMinute + 5);

  assert.equal(run.metrics.availableRooms, 1);
  assert.equal(run.metrics.cleaningRooms, 0);
});

test("metrics update as patients move through the run", () => {
  const scenario = scenarioWith({
    triageProviderEnabled: false,
    arrivalProfile: [{ hourOffset: 0, expectedArrivals: 1 }],
  });
  let run = startedNoWorkupRun(scenario);
  run = advanceTo(run, scenario, 60);

  const patientId = firstPatientId(run);
  run = runAction(run, scenario, "room_patient", patientId);
  run = runAction(run, scenario, "see_patient", patientId);
  run = runAction(run, scenario, "place_orders", patientId);
  run = runAction(run, scenario, "review_results", patientId);
  run = runAction(run, scenario, "discharge_home", patientId);

  assert.equal(run.metrics.patientsArrived, 1);
  assert.equal(run.metrics.patientsSeen, 1);
  assert.equal(run.metrics.patientsDispositioned, 1);
  assert.equal(run.metrics.patientsDeparted, 1);
  assert.equal(run.metrics.waitingRoomCensus, 0);
  assert.equal(run.metrics.activePatientCensus, 0);
  assert.equal(run.metrics.longestCurrentWaitMinutes, 0);
  assert.ok(run.metrics.patientsSeenPerHour > 0);

  const patient = run.patients.find((candidate) => candidate.id === patientId);
  assertDefined(patient, "Expected completed patient to exist.");
  assertDefined(patient.arrivedAt, "Expected patient arrival timestamp.");
  assertDefined(patient.providerSeenAt, "Expected provider seen timestamp.");
  assertDefined(patient.dispositionDecisionAt, "Expected disposition timestamp.");
  assertDefined(patient.departedAt, "Expected departure timestamp.");

  assert.equal(run.metrics.averageDoorToProviderMinutes, patient.providerSeenAt - patient.arrivedAt);
  assert.equal(run.metrics.averageTimeToDispositionMinutes, patient.dispositionDecisionAt - patient.arrivedAt);
  assert.equal(
    run.metrics.averageResultsReadyToDispositionMinutes,
    (patient.dispositionDecisionAt ?? 0) - (patient.resultsReadyAt ?? 0),
  );
  assert.equal(run.metrics.averageEDLengthOfStayMinutes, patient.departedAt - patient.arrivedAt);
});

test("scheduled shift end stops the run without marking active patients completed", () => {
  const scenario = scenarioWith({
    shiftDurationMinutes: 1,
    triageProviderEnabled: false,
    arrivalProfile: [{ hourOffset: 0, expectedArrivals: 1 }],
  });
  const deck = generatePatientDeck(scenario).map((patient) => ({
    ...patient,
    arrivalMinute: scenario.shiftStartMinute + 1,
  }));
  let run = startSimulation(createSimulationRun(scenario, deck));

  run = advanceOneMinute(run, scenario);

  assert.equal(run.status, "shift_ended");
  assert.equal(run.metrics.waitingRoomCensus, 1);
  assert.equal(run.patients.some((patient) => patient.state === "waiting"), true);
  assert.equal(run.events.at(-1)?.type, "shift_ended");

  const decisionCount = run.decisions.length;
  run = applyProviderAction(run, "continue_waiting");
  assert.equal(run.decisions.length, decisionCount);
});

test("repeated attempts of one scenario receive unique run ids", () => {
  const deck = generatePatientDeck(defaultScenario);
  const firstRun = createSimulationRun(defaultScenario, deck);
  const secondRun = createSimulationRun(defaultScenario, deck);

  assert.match(firstRun.id, new RegExp(`^run-${defaultScenario.id}-`));
  assert.match(secondRun.id, new RegExp(`^run-${defaultScenario.id}-`));
  assert.notEqual(secondRun.id, firstRun.id);
});

test("event ids are scoped to each run", () => {
  const deck = generatePatientDeck(defaultScenario);
  const firstRun = startSimulation(createSimulationRun(defaultScenario, deck));
  const secondRun = startSimulation(createSimulationRun(defaultScenario, deck));
  const firstEvent = firstRun.events[0];
  const secondEvent = secondRun.events[0];
  assertDefined(firstEvent, "Expected first run to log a start event.");
  assertDefined(secondEvent, "Expected second run to log a start event.");

  assert.equal(firstEvent.id, `${firstRun.id}-event-000001`);
  assert.equal(secondEvent.id, `${secondRun.id}-event-000001`);
  assert.notEqual(secondEvent.runId, firstEvent.runId);
});

test("multiple events in one run receive sequential run-scoped ids", () => {
  const scenario = scenarioWith({
    triageProviderEnabled: false,
    arrivalProfile: [{ hourOffset: 0, expectedArrivals: 2 }],
  });
  const deck = generatePatientDeck(scenario).map((patient) => ({
    ...patient,
    arrivalMinute: scenario.shiftStartMinute,
  }));
  let run = startSimulation(createSimulationRun(scenario, deck));

  run = advanceOneMinute(run, scenario);

  assert.deepEqual(
    run.events.map((event) => event.id),
    [`${run.id}-event-000001`, `${run.id}-event-000002`, `${run.id}-event-000003`],
  );
  assert.equal(run.events.every((event) => event.runId === run.id), true);
});

test("decision ids are scoped to each run", () => {
  const scenario = scenarioWith({
    triageProviderEnabled: false,
    arrivalProfile: [{ hourOffset: 0, expectedArrivals: 1 }],
  });
  let firstRun = startedRun(scenario);
  let secondRun = startedRun(scenario);

  firstRun = applyProviderAction(firstRun, "continue_waiting");
  secondRun = applyProviderAction(secondRun, "continue_waiting");

  const firstDecision = firstRun.decisions[0];
  const secondDecision = secondRun.decisions[0];
  assertDefined(firstDecision, "Expected first run to record a decision.");
  assertDefined(secondDecision, "Expected second run to record a decision.");

  assert.equal(firstDecision.id, `${firstRun.id}-decision-000001`);
  assert.equal(secondDecision.id, `${secondRun.id}-decision-000001`);
  assert.notEqual(secondDecision.runId, firstDecision.runId);
});

test("provider decisions record immediate and completed resulting states", () => {
  const scenario = scenarioWith({
    triageProviderEnabled: true,
    triageProviderMode: "manual",
    arrivalProfile: [{ hourOffset: 0, expectedArrivals: 1 }],
  });
  let run = startedRun(scenario);
  run = advanceTo(run, scenario, 60);

  const patientId = firstTriagePatientId(run);
  run = runTriageAction(run, scenario, patientId);

  const triageDecision = run.decisions[0];
  assertDefined(triageDecision, "Expected complete-triage decision.");
  assert.equal(triageDecision.previousState, "triage");
  assert.equal(triageDecision.resultingState, "waiting");

  run = applyProviderAction(run, "room_patient", patientId);
  const roomDecision = run.decisions[1];
  assertDefined(roomDecision, "Expected rooming decision.");
  assert.equal(roomDecision.previousState, "waiting");
  assert.equal(roomDecision.resultingState, undefined);

  run = advanceTo(run, scenario, run.provider.busyUntilMinute ?? run.currentMinute);
  const completedRoomDecision = run.decisions.find((decision) => decision.id === roomDecision.id);
  assertDefined(completedRoomDecision, "Expected completed rooming decision.");
  assert.equal(completedRoomDecision.resultingState, "roomed");
});

test("reset-style run recreation clears runtime state and creates a fresh run id", () => {
  const deck = generatePatientDeck(defaultScenario);
  const started = startSimulation(createSimulationRun(defaultScenario, deck));
  const reset = createSimulationRun(defaultScenario, deck);

  assert.notEqual(reset.id, started.id);
  assert.equal(reset.currentMinute, defaultScenario.shiftStartMinute);
  assert.equal(reset.events.length, 0);
  assert.equal(reset.decisions.length, 0);
  assert.equal(reset.patients.every((patient) => patient.state === "not_arrived"), true);
});

test("patients-seen-per-hour uses elapsed shift time", () => {
  const scenario = scenarioWith({
    shiftStartMinute: 600,
    triageProviderEnabled: false,
    arrivalProfile: [{ hourOffset: 0, expectedArrivals: 1 }],
    workupDistribution: { values: [{ value: "none", weight: 1 }] },
  });
  let run = startedRun(scenario);
  run = advanceTo(run, scenario, 660);

  const patientId = firstPatientId(run);
  run = runAction(run, scenario, "room_patient", patientId);
  run = runAction(run, scenario, "see_patient", patientId);

  assert.equal(run.metrics.patientsSeen, 1);
  assert.equal(run.metrics.patientsSeenPerHour, 1 / ((run.currentMinute - scenario.shiftStartMinute) / 60));
});

test("waiting-room risk minutes accumulate exposure beyond the moderate-risk threshold", () => {
  const scenario = scenarioWith({
    triageProviderEnabled: false,
    arrivalProfile: [{ hourOffset: 0, expectedArrivals: 1 }],
  });
  const deck = generatePatientDeck(scenario).map((patient) => ({
    ...patient,
    arrivalMinute: scenario.shiftStartMinute + 1,
    patienceProfile: "high" as const,
  }));
  let run = startSimulation(createSimulationRun(scenario, deck));

  run = advanceTo(run, scenario, scenario.shiftStartMinute + 36);

  const patientId = firstPatientId(run);
  const patient = run.patients.find((candidate) => candidate.id === patientId);
  assertDefined(patient, "Expected waiting patient.");
  assertDefined(patient.arrivedAt, "Expected patient arrival timestamp.");
  assert.equal(run.currentMinute - patient.arrivedAt, 35);
  assert.equal(run.metrics.waitingRoomRiskMinutes, 5);

  run = runAction(run, scenario, "room_patient", patientId);

  const roomedPatient = run.patients.find((candidate) => candidate.id === patientId);
  assertDefined(roomedPatient, "Expected roomed patient.");
  assertDefined(roomedPatient.arrivedAt, "Expected patient arrival timestamp.");
  assertDefined(roomedPatient.roomedAt, "Expected patient roomed timestamp.");
  assert.equal(run.metrics.waitingRoomRiskMinutes, roomedPatient.roomedAt - roomedPatient.arrivedAt - 30);
});

test("smoke demo loop processes default front-end triage into ED throughput", () => {
  const run = runSmokeDemoLoop();

  assert.equal(run.currentMinute, 120);
  assert.ok(run.metrics.patientsSeen > 0);
  assert.ok(run.events.some((event) => event.type === "triage_completed"));
  assert.ok(run.events.some((event) => event.type === "patient_roomed"));
  assert.ok(run.events.some((event) => event.type === "provider_saw_patient"));
});
