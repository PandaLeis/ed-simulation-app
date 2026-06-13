import assert from "node:assert/strict";
import test from "node:test";

import { getAvailableProviderActions } from "../actionRules";
import { generatePatientDeck } from "../arrivalGenerator";
import { defaultScenario } from "../mockScenario";
import {
  advanceOneMinute,
  applyProviderAction,
  createSimulationRun,
  setFrontEndTriageProviderEnabled,
  startSimulation,
} from "../simulationEngine";
import { getPatientWorkupSummary } from "../workupSummary";
import type { ProviderActionType, RuntimePatient, Scenario, SimulationRun } from "../types";

function scenarioWith(overrides: Partial<Scenario>): Scenario {
  return {
    ...defaultScenario,
    ...overrides,
    boardingProfile: {
      ...defaultScenario.boardingProfile,
      ...overrides.boardingProfile,
    },
  };
}

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

function chooseSmokeDemoPatient(run: SimulationRun): RuntimePatient | undefined {
  return (
    run.patients.find((patient) => patient.state === "triage") ??
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

  for (let minute = 0; minute < 75; minute += 1) {
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
  assert.equal(firstDeck.length, 22);
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
    expectedLabMinutes: patient.expectedLabMinutes,
    expectedImagingMinutes: patient.expectedImagingMinutes,
  }));
  const secondDeck = generatePatientDeck(scenario).map((patient) => ({
    complaintCategory: patient.complaintCategory,
    workupType: patient.workupType,
    expectedLabMinutes: patient.expectedLabMinutes,
    expectedImagingMinutes: patient.expectedImagingMinutes,
  }));

  assert.deepEqual(secondDeck, firstDeck);
});

test("patient workup summary exposes bundle and pending order details", () => {
  const scenario = scenarioWith({
    triageProviderEnabled: true,
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
  assert.equal(summary.pendingOrders.length, patient.pendingItems.length);
  assert.equal(summary.pendingOrders.every((order) => order.status === "pending"), true);
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

  run = applyProviderAction(run, "complete_triage", patient.id);
  const triagedPatient = run.patients.find((candidate) => candidate.id === patient.id);
  assert.equal(triagedPatient?.state, "waiting");
  assert.equal(triagedPatient?.triagedAt, run.currentMinute);
  assert.equal(run.metrics.triageCensus, 0);
  assert.equal(run.metrics.waitingRoomCensus, 1);
});

test("disabling front-end triage moves current triage patients to the waiting room", () => {
  const scenario = scenarioWith({
    triageProviderEnabled: true,
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
    arrivalProfile: [{ hourOffset: 0, expectedArrivals: 1 }],
    workupDistribution: { values: [{ value: "basic_labs", weight: 1 }] },
  });
  let run = startedRun(scenario);
  run = advanceTo(run, scenario, 60);

  const patientId = firstTriagePatientId(run);
  run = applyProviderAction(run, "start_protocol_orders", patientId);
  run = applyProviderAction(run, "complete_triage", patientId);
  run = runAction(run, scenario, "room_patient", patientId);
  run = runAction(run, scenario, "see_patient", patientId);

  const patient = run.patients.find((candidate) => candidate.id === patientId);
  assert.equal(patient?.state, "results_pending");
  assert.equal(patient?.providerSeenAt, run.currentMinute);
});

test("provider can review completed triage results after seeing the patient", () => {
  const scenario = scenarioWith({
    triageProviderEnabled: true,
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
  run = applyProviderAction(run, "complete_triage", patientId);
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
  assert.equal(run.metrics.availableRooms, scenario.roomCapacity);
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
  assert.equal(patient?.state, "boarding");
  assert.equal(run.metrics.boardingCensus, 1);
  assert.equal(run.metrics.availableRooms, 0);

  run = advanceTo(run, scenario, run.currentMinute + 5);

  patient = run.patients.find((candidate) => candidate.id === patientId);
  assert.equal(patient?.state, "departed");
  assert.equal(patient?.dispositionType, "admit_inpatient");
  assert.equal(run.metrics.boardingCensus, 0);
  assert.equal(run.metrics.availableRooms, 1);
  assert.equal(run.metrics.totalBoardingMinutes, 5);
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
    arrivalProfile: [{ hourOffset: 0, expectedArrivals: 1 }],
  });
  let run = startedRun(scenario);
  run = advanceTo(run, scenario, 60);

  const patientId = firstTriagePatientId(run);
  run = applyProviderAction(run, "complete_triage", patientId);

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

  assert.equal(run.currentMinute, 75);
  assert.ok(run.metrics.patientsSeen > 0);
  assert.ok(run.events.some((event) => event.type === "triage_completed"));
  assert.ok(run.events.some((event) => event.type === "patient_roomed"));
  assert.ok(run.events.some((event) => event.type === "provider_saw_patient"));
});
