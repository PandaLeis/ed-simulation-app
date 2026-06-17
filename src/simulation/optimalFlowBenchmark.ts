import { getAvailableProviderActions } from "./actionRules";
import { isCardiacWorkupPatient, isDiagnosticPendingItem } from "./cardiacWorkflow";
import {
  advanceOneMinute,
  applyProviderAction,
  createSimulationRun,
  startSimulation,
} from "./simulationEngine";
import type {
  BenchmarkCoachRecommendation,
  BenchmarkMetricComparison,
  BenchmarkPatientOpportunity,
  OptimalFlowBenchmark,
  ProviderActionType,
  RuntimePatient,
  Scenario,
  ScenarioPatient,
  SimulationMetrics,
  SimulationRun,
  WhatIfCoachComparison,
  WhatIfCoachStrategySummary,
} from "./types";

const BENCHMARK_MAX_STEPS = 24 * 60;

function riskRank(patient: RuntimePatient): number {
  const riskScore: Record<RuntimePatient["riskLevel"], number> = {
    critical: 4,
    high: 3,
    moderate: 2,
    low: 1,
  };

  return riskScore[patient.riskLevel];
}

function waitMinutes(patient: RuntimePatient, currentMinute: number): number {
  return patient.arrivedAt === undefined ? 0 : Math.max(0, currentMinute - patient.arrivedAt);
}

function operationalPriority(patient: RuntimePatient, currentMinute: number): number {
  return (6 - patient.esi) * 1000 + riskRank(patient) * 150 + waitMinutes(patient, currentMinute);
}

function sortByPriority(left: RuntimePatient, right: RuntimePatient, currentMinute: number): number {
  const priorityDifference = operationalPriority(right, currentMinute) - operationalPriority(left, currentMinute);
  return priorityDifference === 0 ? left.patientNumber - right.patientNumber : priorityDifference;
}

function enabledAction(run: SimulationRun, patient: RuntimePatient, actionType: ProviderActionType): boolean {
  return getAvailableProviderActions(run, patient.id).some((action) => action.type === actionType && action.enabled);
}

function diagnosticResultsReady(patient: RuntimePatient): boolean {
  const diagnosticItems = patient.pendingItems.filter(isDiagnosticPendingItem);
  return patient.resultsReadyAt !== undefined && diagnosticItems.length > 0 && diagnosticItems.every((item) => item.status === "ready");
}

function actionLabel(run: SimulationRun, patient: RuntimePatient, actionType: ProviderActionType): string {
  return getAvailableProviderActions(run, patient.id).find((action) => action.type === actionType)?.label ?? actionType;
}

function chooseDispositionAction(patient: RuntimePatient): ProviderActionType {
  return patient.admitProbability >= patient.dischargeProbability ? "admit_inpatient" : "discharge_home";
}

function chooseBenchmarkAction(run: SimulationRun): { actionType: ProviderActionType; patientId: string } | undefined {
  const patients = [...run.patients];

  const resultsReadyPatient = patients
    .filter((patient) => patient.state === "results_ready" && enabledAction(run, patient, "review_results"))
    .sort((left, right) => sortByPriority(left, right, run.currentMinute))[0];
  if (resultsReadyPatient) {
    return { actionType: "review_results", patientId: resultsReadyPatient.id };
  }

  const dispositionPatient = patients
    .filter((patient) => patient.state === "ready_for_disposition")
    .sort((left, right) => sortByPriority(left, right, run.currentMinute))[0];
  if (dispositionPatient) {
    const dispositionAction = chooseDispositionAction(dispositionPatient);
    if (enabledAction(run, dispositionPatient, dispositionAction)) {
      return { actionType: dispositionAction, patientId: dispositionPatient.id };
    }
  }

  const unseenResultsReadyPatient = patients
    .filter((patient) => patient.state === "results_ready" && patient.providerSeenAt === undefined && enabledAction(run, patient, "see_patient"))
    .sort((left, right) => sortByPriority(left, right, run.currentMinute))[0];
  if (unseenResultsReadyPatient) {
    return { actionType: "see_patient", patientId: unseenResultsReadyPatient.id };
  }

  const roomedReadyPatient = patients
    .filter((patient) => patient.state === "roomed" && diagnosticResultsReady(patient) && enabledAction(run, patient, "see_patient"))
    .sort((left, right) => sortByPriority(left, right, run.currentMinute))[0];
  if (roomedReadyPatient) {
    return { actionType: "see_patient", patientId: roomedReadyPatient.id };
  }

  const unseenResultsPendingPatient = patients
    .filter((patient) => patient.state === "results_pending" && patient.providerSeenAt === undefined && enabledAction(run, patient, "see_patient"))
    .sort((left, right) => sortByPriority(left, right, run.currentMinute))[0];
  if (unseenResultsPendingPatient) {
    return { actionType: "see_patient", patientId: unseenResultsPendingPatient.id };
  }

  const waitingPatient = patients
    .filter((patient) => patient.state === "waiting" && enabledAction(run, patient, "room_patient"))
    .sort((left, right) => sortByPriority(left, right, run.currentMinute))[0];
  if (waitingPatient) {
    return { actionType: "room_patient", patientId: waitingPatient.id };
  }

  const roomedPatient = patients
    .filter((patient) => patient.state === "roomed" && enabledAction(run, patient, "see_patient"))
    .sort((left, right) => sortByPriority(left, right, run.currentMinute));
  if (roomedPatient[0]) {
    return { actionType: "see_patient", patientId: roomedPatient[0].id };
  }

  const seenPatient = patients
    .filter((patient) => patient.state === "provider_seen" && enabledAction(run, patient, "place_orders"))
    .sort((left, right) => sortByPriority(left, right, run.currentMinute))[0];
  if (seenPatient) {
    return { actionType: "place_orders", patientId: seenPatient.id };
  }

  const triagePatients = patients
    .filter((patient) => patient.state === "triage")
    .sort((left, right) => sortByPriority(left, right, run.currentMinute));
  const protocolPatient = triagePatients.find((patient) => enabledAction(run, patient, "start_protocol_orders"));
  if (protocolPatient) {
    return { actionType: "start_protocol_orders", patientId: protocolPatient.id };
  }
  const triagePatient = triagePatients.find((patient) => enabledAction(run, patient, "complete_triage"));
  if (triagePatient) {
    return { actionType: "complete_triage", patientId: triagePatient.id };
  }

  return undefined;
}

function chooseCoachAction(run: SimulationRun): { actionType: ProviderActionType; patientId: string } | undefined {
  const patients = [...run.patients];

  const cardiacProtocolPatient = patients
    .filter((patient) => patient.state === "triage" && isCardiacWorkupPatient(patient) && enabledAction(run, patient, "start_protocol_orders"))
    .sort((left, right) => sortByPriority(left, right, run.currentMinute))[0];
  if (cardiacProtocolPatient) {
    return { actionType: "start_protocol_orders", patientId: cardiacProtocolPatient.id };
  }

  const dispositionPatient = patients
    .filter((patient) => patient.state === "ready_for_disposition")
    .sort((left, right) => sortByPriority(left, right, run.currentMinute))[0];
  if (dispositionPatient) {
    const dispositionAction = chooseDispositionAction(dispositionPatient);
    if (enabledAction(run, dispositionPatient, dispositionAction)) {
      return { actionType: dispositionAction, patientId: dispositionPatient.id };
    }
  }

  const unseenResultsReadyPatient = patients
    .filter((patient) => patient.state === "results_ready" && patient.providerSeenAt === undefined && enabledAction(run, patient, "see_patient"))
    .sort((left, right) => sortByPriority(left, right, run.currentMinute))[0];
  if (unseenResultsReadyPatient) {
    return { actionType: "see_patient", patientId: unseenResultsReadyPatient.id };
  }

  const roomedPatient = patients
    .filter((patient) => patient.state === "roomed" && enabledAction(run, patient, "see_patient"))
    .sort((left, right) => sortByPriority(left, right, run.currentMinute))[0];
  if (roomedPatient) {
    return { actionType: "see_patient", patientId: roomedPatient.id };
  }

  const unseenResultsPendingPatient = patients
    .filter((patient) => patient.state === "results_pending" && patient.providerSeenAt === undefined && enabledAction(run, patient, "see_patient"))
    .sort((left, right) => sortByPriority(left, right, run.currentMinute))[0];
  if (unseenResultsPendingPatient) {
    return { actionType: "see_patient", patientId: unseenResultsPendingPatient.id };
  }

  const resultsReadyPatient = patients
    .filter((patient) => patient.state === "results_ready" && enabledAction(run, patient, "review_results"))
    .sort((left, right) => sortByPriority(left, right, run.currentMinute))[0];
  if (resultsReadyPatient) {
    return { actionType: "review_results", patientId: resultsReadyPatient.id };
  }

  const waitingPatients = patients
    .filter((patient) => patient.state === "waiting")
    .sort((left, right) => sortByPriority(left, right, run.currentMinute));
  const roomablePatient = waitingPatients.find((patient) => enabledAction(run, patient, "room_patient"));
  if (roomablePatient) {
    return { actionType: "room_patient", patientId: roomablePatient.id };
  }

  const seenPatient = patients
    .filter((patient) => patient.state === "provider_seen" && enabledAction(run, patient, "place_orders"))
    .sort((left, right) => sortByPriority(left, right, run.currentMinute))[0];
  if (seenPatient) {
    return { actionType: "place_orders", patientId: seenPatient.id };
  }

  if (waitingPatients.length > 0) {
    return undefined;
  }

  const triagePatients = patients
    .filter((patient) => patient.state === "triage")
    .sort((left, right) => sortByPriority(left, right, run.currentMinute));
  const protocolPatient = triagePatients.find((patient) => enabledAction(run, patient, "start_protocol_orders"));
  if (protocolPatient) {
    return { actionType: "start_protocol_orders", patientId: protocolPatient.id };
  }
  const triagePatient = triagePatients.find((patient) => enabledAction(run, patient, "complete_triage"));
  if (triagePatient) {
    return { actionType: "complete_triage", patientId: triagePatient.id };
  }

  return undefined;
}

type StrategyActionChooser = (run: SimulationRun) => { actionType: ProviderActionType; patientId: string } | undefined;

function lowAcuitySort(left: RuntimePatient, right: RuntimePatient): number {
  return right.esi - left.esi || left.patientNumber - right.patientNumber;
}

function chooseFrontEndFocusAction(run: SimulationRun): { actionType: ProviderActionType; patientId: string } | undefined {
  const patients = [...run.patients];

  const triagePatients = patients
    .filter((patient) => patient.state === "triage")
    .sort((left, right) => left.patientNumber - right.patientNumber);
  const triageProtocolPatient = triagePatients.find((patient) => enabledAction(run, patient, "start_protocol_orders"));
  if (triageProtocolPatient) {
    return { actionType: "start_protocol_orders", patientId: triageProtocolPatient.id };
  }
  const triagePatient = triagePatients.find((patient) => enabledAction(run, patient, "complete_triage"));
  if (triagePatient) {
    return { actionType: "complete_triage", patientId: triagePatient.id };
  }

  const lowAcuityWaitingPatient = patients
    .filter((patient) => patient.state === "waiting" && enabledAction(run, patient, "room_patient"))
    .sort(lowAcuitySort)[0];
  if (lowAcuityWaitingPatient) {
    return { actionType: "room_patient", patientId: lowAcuityWaitingPatient.id };
  }

  const roomedPatient = patients
    .filter((patient) => patient.state === "roomed" && enabledAction(run, patient, "see_patient"))
    .sort(lowAcuitySort)[0];
  if (roomedPatient) {
    return { actionType: "see_patient", patientId: roomedPatient.id };
  }

  const seenPatient = patients
    .filter((patient) => patient.state === "provider_seen" && enabledAction(run, patient, "place_orders"))
    .sort(lowAcuitySort)[0];
  if (seenPatient) {
    return { actionType: "place_orders", patientId: seenPatient.id };
  }

  const resultsReadyPatient = patients
    .filter((patient) => patient.state === "results_ready" && enabledAction(run, patient, "review_results"))
    .sort(lowAcuitySort)[0];
  if (resultsReadyPatient) {
    return { actionType: "review_results", patientId: resultsReadyPatient.id };
  }

  const dispositionPatient = patients
    .filter((patient) => patient.state === "ready_for_disposition")
    .sort(lowAcuitySort)[0];
  if (dispositionPatient) {
    const dispositionAction = chooseDispositionAction(dispositionPatient);
    if (enabledAction(run, dispositionPatient, dispositionAction)) {
      return { actionType: dispositionAction, patientId: dispositionPatient.id };
    }
  }

  return undefined;
}

function chooseMiddleFlowFocusAction(run: SimulationRun): { actionType: ProviderActionType; patientId: string } | undefined {
  const patients = [...run.patients];

  const unseenResultsReadyPatient = patients
    .filter((patient) => patient.state === "results_ready" && patient.providerSeenAt === undefined && enabledAction(run, patient, "see_patient"))
    .sort((left, right) => sortByPriority(left, right, run.currentMinute))[0];
  if (unseenResultsReadyPatient) {
    return { actionType: "see_patient", patientId: unseenResultsReadyPatient.id };
  }

  const roomedPatient = patients
    .filter((patient) => patient.state === "roomed" && enabledAction(run, patient, "see_patient"))
    .sort((left, right) => sortByPriority(left, right, run.currentMinute))[0];
  if (roomedPatient) {
    return { actionType: "see_patient", patientId: roomedPatient.id };
  }

  const unseenResultsPendingPatient = patients
    .filter((patient) => patient.state === "results_pending" && patient.providerSeenAt === undefined && enabledAction(run, patient, "see_patient"))
    .sort((left, right) => sortByPriority(left, right, run.currentMinute))[0];
  if (unseenResultsPendingPatient) {
    return { actionType: "see_patient", patientId: unseenResultsPendingPatient.id };
  }

  const seenPatient = patients
    .filter((patient) => patient.state === "provider_seen" && enabledAction(run, patient, "place_orders"))
    .sort((left, right) => sortByPriority(left, right, run.currentMinute))[0];
  if (seenPatient) {
    return { actionType: "place_orders", patientId: seenPatient.id };
  }

  const resultsReadyPatient = patients
    .filter((patient) => patient.state === "results_ready" && enabledAction(run, patient, "review_results"))
    .sort((left, right) => sortByPriority(left, right, run.currentMinute))[0];
  if (resultsReadyPatient) {
    return { actionType: "review_results", patientId: resultsReadyPatient.id };
  }

  const waitingPatient = patients
    .filter((patient) => patient.state === "waiting" && enabledAction(run, patient, "room_patient"))
    .sort((left, right) => sortByPriority(left, right, run.currentMinute))[0];
  if (waitingPatient) {
    return { actionType: "room_patient", patientId: waitingPatient.id };
  }

  const dispositionPatient = patients
    .filter((patient) => patient.state === "ready_for_disposition")
    .sort((left, right) => sortByPriority(left, right, run.currentMinute))[0];
  if (dispositionPatient) {
    const dispositionAction = chooseDispositionAction(dispositionPatient);
    if (enabledAction(run, dispositionPatient, dispositionAction)) {
      return { actionType: dispositionAction, patientId: dispositionPatient.id };
    }
  }

  return undefined;
}

function chooseDispositionFocusAction(run: SimulationRun): { actionType: ProviderActionType; patientId: string } | undefined {
  const patients = [...run.patients];

  const dispositionPatient = patients
    .filter((patient) => patient.state === "ready_for_disposition")
    .sort((left, right) => sortByPriority(left, right, run.currentMinute))[0];
  if (dispositionPatient) {
    const dispositionAction = chooseDispositionAction(dispositionPatient);
    if (enabledAction(run, dispositionPatient, dispositionAction)) {
      return { actionType: dispositionAction, patientId: dispositionPatient.id };
    }
  }

  const resultsReadyPatient = patients
    .filter((patient) => patient.state === "results_ready" && enabledAction(run, patient, "review_results"))
    .sort((left, right) => sortByPriority(left, right, run.currentMinute))[0];
  if (resultsReadyPatient) {
    return { actionType: "review_results", patientId: resultsReadyPatient.id };
  }

  const unseenResultsReadyPatient = patients
    .filter((patient) => patient.state === "results_ready" && patient.providerSeenAt === undefined && enabledAction(run, patient, "see_patient"))
    .sort((left, right) => sortByPriority(left, right, run.currentMinute))[0];
  if (unseenResultsReadyPatient) {
    return { actionType: "see_patient", patientId: unseenResultsReadyPatient.id };
  }

  const seenPatient = patients
    .filter((patient) => patient.state === "provider_seen" && enabledAction(run, patient, "place_orders"))
    .sort((left, right) => sortByPriority(left, right, run.currentMinute))[0];
  if (seenPatient) {
    return { actionType: "place_orders", patientId: seenPatient.id };
  }

  const roomedPatient = patients
    .filter((patient) => patient.state === "roomed" && enabledAction(run, patient, "see_patient"))
    .sort((left, right) => sortByPriority(left, right, run.currentMinute))[0];
  if (roomedPatient) {
    return { actionType: "see_patient", patientId: roomedPatient.id };
  }

  const waitingPatient = patients
    .filter((patient) => patient.state === "waiting" && enabledAction(run, patient, "room_patient"))
    .sort((left, right) => sortByPriority(left, right, run.currentMinute))[0];
  if (waitingPatient) {
    return { actionType: "room_patient", patientId: waitingPatient.id };
  }

  return undefined;
}

function recommendationReason(run: SimulationRun, patient: RuntimePatient, actionType: ProviderActionType): string {
  const wait = waitMinutes(patient, run.currentMinute);
  const patientSummary = `${patient.id} is ESI ${patient.esi}, ${patient.riskLevel} risk, waiting ${wait} minutes.`;

  switch (actionType) {
    case "start_protocol_orders":
      if (isCardiacWorkupPatient(patient)) {
        return `${patientSummary} Start cardiac protocol orders now so ECG timing stays under the operational 10-minute target.`;
      }

      return `${patientSummary} Start protocol orders now so labs or imaging can progress while the patient waits.`;
    case "complete_triage":
      return `${patientSummary} Move the patient out of Front-End Triage so the waiting-room queue reflects completed triage.`;
    case "room_patient":
      return `${patientSummary} Rooming this patient now uses available capacity for the highest-priority waiting patient.`;
    case "see_patient":
      if (diagnosticResultsReady(patient)) {
        return `${patientSummary} Diagnostic results are already ready, so provider evaluation can move directly toward results review.`;
      }

      return `${patientSummary} The patient is already roomed, so provider evaluation is the next flow constraint.`;
    case "place_orders":
      return `${patientSummary} Orders are the next step to move this evaluation toward results and disposition.`;
    case "review_results":
      return `${patientSummary} Results are ready; reviewing them can move the patient toward disposition.`;
    case "discharge_home":
      return `${patientSummary} Discharging now releases the room and completes the visit.`;
    case "admit_inpatient":
      return `${patientSummary} Admit disposition is favored by the synthetic probabilities and moves the patient into boarding flow.`;
    default:
      return `${patientSummary} Continue observing flow until a higher-value operational action is available.`;
  }
}

export function getBenchmarkCoachRecommendation(run: SimulationRun): BenchmarkCoachRecommendation | undefined {
  if (run.status !== "running") {
    return undefined;
  }

  const nextAction = chooseCoachAction(run);
  if (!nextAction) {
    return undefined;
  }

  const patient = patientById(run, nextAction.patientId);
  if (!patient) {
    return undefined;
  }

  return {
    patientId: patient.id,
    actionType: nextAction.actionType,
    actionLabel: actionLabel(run, patient, nextAction.actionType),
    reason: recommendationReason(run, patient, nextAction.actionType),
    prioritySummary: `ESI ${patient.esi} · ${patient.riskLevel} risk · ${waitMinutes(patient, run.currentMinute)} min wait`,
  };
}

export function runCoachDemoActions(run: SimulationRun): { run: SimulationRun; appliedActions: BenchmarkCoachRecommendation[] } {
  let nextRun = run;
  const appliedActions: BenchmarkCoachRecommendation[] = [];

  for (let actionCount = 0; actionCount < nextRun.providers.length + 8; actionCount += 1) {
    const recommendation = getBenchmarkCoachRecommendation(nextRun);
    if (!recommendation) {
      return { run: nextRun, appliedActions };
    }

    const afterAction = applyProviderAction(nextRun, recommendation.actionType, recommendation.patientId);
    if (afterAction === nextRun) {
      return { run: nextRun, appliedActions };
    }

    appliedActions.push(recommendation);
    nextRun = afterAction;
  }

  return { run: nextRun, appliedActions };
}

function runBenchmarkActions(run: SimulationRun): SimulationRun {
  let nextRun = run;

  for (let actionCount = 0; actionCount < nextRun.providers.length + 8; actionCount += 1) {
    const nextAction = chooseBenchmarkAction(nextRun);
    if (!nextAction) {
      return nextRun;
    }

    const afterAction = applyProviderAction(nextRun, nextAction.actionType, nextAction.patientId);
    if (afterAction === nextRun) {
      return nextRun;
    }

    nextRun = afterAction;
  }

  return nextRun;
}

function runStrategyActions(run: SimulationRun, chooseAction: StrategyActionChooser): SimulationRun {
  let nextRun = run;

  for (let actionCount = 0; actionCount < nextRun.providers.length + 8; actionCount += 1) {
    const nextAction = chooseAction(nextRun);
    if (!nextAction) {
      return nextRun;
    }

    const afterAction = applyProviderAction(nextRun, nextAction.actionType, nextAction.patientId);
    if (afterAction === nextRun) {
      return nextRun;
    }

    nextRun = afterAction;
  }

  return nextRun;
}

function hasActiveWork(run: SimulationRun): boolean {
  return run.patients.some(
    (patient) =>
      patient.state !== "not_arrived" &&
      patient.state !== "departed" &&
      patient.state !== "lwbs",
  );
}

function hasFutureArrivals(run: SimulationRun): boolean {
  return run.patients.some((patient) => patient.state === "not_arrived" && patient.arrivalMinute >= run.currentMinute);
}

export function runOptimalFlowBenchmark(scenario: Scenario, deck: ScenarioPatient[], untilMinute?: number): SimulationRun {
  let run = startSimulation(createSimulationRun(scenario, deck));

  run = {
    ...run,
    runType: "benchmark",
  };

  for (let step = 0; step < BENCHMARK_MAX_STEPS; step += 1) {
    run = runBenchmarkActions(run);

    if (untilMinute !== undefined && run.currentMinute >= untilMinute) {
      return run;
    }

    if (run.status === "shift_ended") {
      return run;
    }

    if (!hasFutureArrivals(run) && !hasActiveWork(run)) {
      return {
        ...run,
        status: "completed",
      };
    }

    run = advanceOneMinute(run, scenario);
  }

  return run;
}

function runFocusedCoachBenchmark(
  scenario: Scenario,
  deck: ScenarioPatient[],
  chooseAction: StrategyActionChooser,
  untilMinute?: number,
): SimulationRun {
  let run = startSimulation(createSimulationRun(scenario, deck));

  run = {
    ...run,
    runType: "benchmark",
  };

  for (let step = 0; step < BENCHMARK_MAX_STEPS; step += 1) {
    run = runStrategyActions(run, chooseAction);

    if (untilMinute !== undefined && run.currentMinute >= untilMinute) {
      return run;
    }

    if (run.status === "shift_ended") {
      return run;
    }

    if (!hasFutureArrivals(run) && !hasActiveWork(run)) {
      return {
        ...run,
        status: "completed",
      };
    }

    run = advanceOneMinute(run, scenario);
  }

  return run;
}

export function runFrontEndFocusCoachBenchmark(scenario: Scenario, deck: ScenarioPatient[], untilMinute?: number): SimulationRun {
  return runFocusedCoachBenchmark(scenario, deck, chooseFrontEndFocusAction, untilMinute);
}

export function runMiddleFlowFocusCoachBenchmark(scenario: Scenario, deck: ScenarioPatient[], untilMinute?: number): SimulationRun {
  return runFocusedCoachBenchmark(scenario, deck, chooseMiddleFlowFocusAction, untilMinute);
}

export function runDispositionFocusCoachBenchmark(scenario: Scenario, deck: ScenarioPatient[], untilMinute?: number): SimulationRun {
  return runFocusedCoachBenchmark(scenario, deck, chooseDispositionFocusAction, untilMinute);
}

function formatNumber(value: number | null): string {
  return value === null ? "-" : value.toFixed(0);
}

function formatDelta(value: number): string {
  if (value === 0) {
    return "same";
  }

  return value > 0 ? `+${value.toFixed(0)}` : value.toFixed(0);
}

function compareLowerIsBetter(
  label: string,
  actualValue: number | null,
  benchmarkValue: number | null,
  suffix = "",
): BenchmarkMetricComparison {
  const actual = actualValue ?? 0;
  const benchmark = benchmarkValue ?? 0;
  const delta = actual - benchmark;

  return {
    label,
    actual: actualValue === null ? "-" : `${actual.toFixed(0)}${suffix}`,
    benchmark: benchmarkValue === null ? "-" : `${benchmark.toFixed(0)}${suffix}`,
    delta: actualValue === null || benchmarkValue === null ? "-" : delta === 0 ? "same" : `${formatDelta(delta)}${suffix}`,
    interpretation: delta === 0 ? "same" : delta > 0 ? "worse" : "better",
  };
}

function compareHigherIsBetter(
  label: string,
  actualValue: number,
  benchmarkValue: number,
  suffix = "",
): BenchmarkMetricComparison {
  const delta = actualValue - benchmarkValue;

  return {
    label,
    actual: `${actualValue.toFixed(1)}${suffix}`,
    benchmark: `${benchmarkValue.toFixed(1)}${suffix}`,
    delta: `${delta > 0 ? "+" : ""}${delta.toFixed(1)}${suffix}`,
    interpretation: delta === 0 ? "same" : delta > 0 ? "better" : "worse",
  };
}

function metricComparisons(actual: SimulationMetrics, benchmark: SimulationMetrics): BenchmarkMetricComparison[] {
  return [
    compareLowerIsBetter("LWBS", actual.patientsLWBS, benchmark.patientsLWBS),
    compareLowerIsBetter("Longest wait", actual.longestCurrentWaitMinutes, benchmark.longestCurrentWaitMinutes, " min"),
    compareLowerIsBetter("Door to provider", actual.averageDoorToProviderMinutes, benchmark.averageDoorToProviderMinutes, " min"),
    compareLowerIsBetter(
      "Results to disposition",
      actual.averageResultsReadyToDispositionMinutes,
      benchmark.averageResultsReadyToDispositionMinutes,
      " min",
    ),
    compareLowerIsBetter("Risk minutes", actual.waitingRoomRiskMinutes, benchmark.waitingRoomRiskMinutes, " min"),
    compareHigherIsBetter("Seen / hour", actual.patientsSeenPerHour, benchmark.patientsSeenPerHour),
  ];
}

function patientById(run: SimulationRun, patientId: string): RuntimePatient | undefined {
  return run.patients.find((patient) => patient.id === patientId);
}

function patientOpportunities(actualRun: SimulationRun, benchmarkRun: SimulationRun): BenchmarkPatientOpportunity[] {
  const opportunities: BenchmarkPatientOpportunity[] = [];

  for (const actualPatient of actualRun.patients) {
    const benchmarkPatient = patientById(benchmarkRun, actualPatient.id);
    if (!benchmarkPatient) {
      continue;
    }

    if (actualPatient.roomedAt === undefined && benchmarkPatient.roomedAt !== undefined) {
      opportunities.push({
        patientId: actualPatient.id,
        label: "Earlier rooming opportunity",
        detail: `${actualPatient.id} had not been roomed in the actual run; benchmark roomed them at minute ${benchmarkPatient.roomedAt}.`,
        benchmarkMinute: benchmarkPatient.roomedAt,
      });
    } else if (
      actualPatient.roomedAt !== undefined &&
      benchmarkPatient.roomedAt !== undefined &&
      actualPatient.roomedAt - benchmarkPatient.roomedAt >= 15
    ) {
      opportunities.push({
        patientId: actualPatient.id,
        label: "Earlier rooming opportunity",
        detail: `${actualPatient.id} was roomed ${actualPatient.roomedAt - benchmarkPatient.roomedAt} minutes later than the benchmark flow.`,
        actualMinute: actualPatient.roomedAt,
        benchmarkMinute: benchmarkPatient.roomedAt,
      });
    }

    if (
      actualPatient.providerSeenAt !== undefined &&
      benchmarkPatient.providerSeenAt !== undefined &&
      actualPatient.providerSeenAt - benchmarkPatient.providerSeenAt >= 15
    ) {
      opportunities.push({
        patientId: actualPatient.id,
        label: "Earlier provider evaluation",
        detail: `${actualPatient.id} reached provider evaluation ${actualPatient.providerSeenAt - benchmarkPatient.providerSeenAt} minutes later than benchmark.`,
        actualMinute: actualPatient.providerSeenAt,
        benchmarkMinute: benchmarkPatient.providerSeenAt,
      });
    }

    if (actualPatient.lwbsAt !== undefined && benchmarkPatient.lwbsAt === undefined) {
      opportunities.push({
        patientId: actualPatient.id,
        label: "LWBS avoided in benchmark",
        detail: `${actualPatient.id} left without being seen in the actual run but remained in flow in the benchmark.`,
        actualMinute: actualPatient.lwbsAt,
        benchmarkMinute: benchmarkPatient.providerSeenAt ?? benchmarkPatient.roomedAt,
      });
    }
  }

  return opportunities
    .sort((left, right) => (right.actualMinute ?? 0) - (left.actualMinute ?? 0))
    .slice(0, 5);
}

function resultsReadyWaiting(run: SimulationRun): number {
  return run.patients.filter((patient) => patient.state === "results_ready").length;
}

function strategySummary(
  run: SimulationRun,
  summary: Pick<WhatIfCoachStrategySummary, "id" | "label" | "description">,
): WhatIfCoachStrategySummary {
  return {
    ...summary,
    patientsDeparted: run.metrics.patientsDeparted,
    patientsLWBS: run.metrics.patientsLWBS,
    longestWaitMinutes: run.metrics.longestCurrentWaitMinutes,
    patientsSeenPerHour: run.metrics.patientsSeenPerHour,
    resultsReadyWaiting: resultsReadyWaiting(run),
    totalBoardingMinutes: run.metrics.totalBoardingMinutes,
    doorToEcgWithin10Rate: run.metrics.doorToEcgWithin10Rate,
    sepsisAntibioticsWithin60Rate: run.metrics.sepsisAntibioticsWithin60Rate,
  };
}

function createWhatIfCoachComparison(
  actualRun: SimulationRun,
  optimalRun: SimulationRun,
  frontEndFocusRun: SimulationRun,
  middleFlowFocusRun: SimulationRun,
  dispositionFocusRun: SimulationRun,
): WhatIfCoachComparison {
  return {
    headline: "Compare how different operational focus strategies change patient flow from the same scenario.",
    summaries: [
      strategySummary(actualRun, {
        id: "provider_run",
        label: "Provider Run",
        description: "Your current decisions in this live simulation.",
      }),
      strategySummary(optimalRun, {
        id: "optimal_flow",
        label: "Optimal Flow Coach",
        description: "Prioritizes bottlenecks, room turnover, high-risk waits, ready results, and disposition.",
      }),
      strategySummary(frontEndFocusRun, {
        id: "front_end_focus",
        label: "Front-End Focus Coach",
        description: "Prioritizes triage, protocol starts, and waiting-room intake before downstream roomed-patient work.",
      }),
      strategySummary(middleFlowFocusRun, {
        id: "middle_flow_focus",
        label: "Middle Flow Focus Coach",
        description: "Prioritizes roomed patients, provider evaluation, orders, and diagnostic result movement.",
      }),
      strategySummary(dispositionFocusRun, {
        id: "disposition_focus",
        label: "Disposition Focus Coach",
        description: "Prioritizes results review and discharge/admit decisions to clear rooms and define boarding.",
      }),
    ],
  };
}

export function createOptimalFlowBenchmark(
  scenario: Scenario,
  deck: ScenarioPatient[],
  actualRun: SimulationRun,
): OptimalFlowBenchmark {
  const benchmarkRun = runOptimalFlowBenchmark(scenario, deck, actualRun.currentMinute);
  const frontEndFocusRun = runFrontEndFocusCoachBenchmark(scenario, deck, actualRun.currentMinute);
  const middleFlowFocusRun = runMiddleFlowFocusCoachBenchmark(scenario, deck, actualRun.currentMinute);
  const dispositionFocusRun = runDispositionFocusCoachBenchmark(scenario, deck, actualRun.currentMinute);
  const comparisons = metricComparisons(actualRun.metrics, benchmarkRun.metrics);
  const worseComparisons = comparisons.filter((comparison) => comparison.interpretation === "worse").length;

  return {
    benchmarkRun,
    frontEndFocusRun,
    middleFlowFocusRun,
    dispositionFocusRun,
    headline:
      worseComparisons === 0
        ? "Actual flow is tracking close to benchmark."
        : `${worseComparisons} operational metric(s) trail the benchmark.`,
    comparisons,
    opportunities: patientOpportunities(actualRun, benchmarkRun),
    whatIfComparison: createWhatIfCoachComparison(
      actualRun,
      benchmarkRun,
      frontEndFocusRun,
      middleFlowFocusRun,
      dispositionFocusRun,
    ),
  };
}
