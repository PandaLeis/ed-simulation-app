import { getAvailableProviderActions } from "./actionRules";
import { isCardiacWorkupPatient, isDiagnosticPendingItem } from "./cardiacWorkflow";
import { isSepsisWorkupPatient } from "./sepsisWorkflow";
import { defaultScenario } from "./mockScenario";
import {
  advanceOneMinute,
  applyProviderAction,
  createSimulationRun,
  startSimulation,
} from "./simulationEngine";
import { isReassessmentOverdue } from "./waitingRoomSafety";
import type {
  BenchmarkCoachRecommendation,
  BenchmarkComparisonView,
  BenchmarkMetricComparison,
  BenchmarkPatientOpportunity,
  CoachPriorityProfile,
  OptimalFlowBenchmark,
  ProviderActionType,
  RuntimePatient,
  Scenario,
  ScenarioPatient,
  SimulationMetrics,
  SimulationRun,
  WhatIfCoachComparison,
  WhatIfCoachStrategyId,
  WhatIfCoachStrategySummary,
} from "./types";

const BENCHMARK_MAX_STEPS = 24 * 60;

function scenarioWithCoachPriorityProfile(scenario: Scenario, profile: CoachPriorityProfile): Scenario {
  return {
    ...scenario,
    coachPriorityProfile: profile,
  };
}

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

function coachPriorityProfile(run: SimulationRun): CoachPriorityProfile {
  return run.coachPriorityProfile ?? defaultScenario.coachPriorityProfile;
}

function operationalPriority(patient: RuntimePatient, currentMinute: number, profile: CoachPriorityProfile): number {
  return (
    (6 - patient.esi) * profile.acuityWeight +
    riskRank(patient) * profile.riskWeight +
    waitMinutes(patient, currentMinute) * profile.waitWeight
  );
}

function sortByPriority(left: RuntimePatient, right: RuntimePatient, run: SimulationRun): number {
  const profile = coachPriorityProfile(run);
  const priorityDifference =
    operationalPriority(right, run.currentMinute, profile) - operationalPriority(left, run.currentMinute, profile);
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

function chooseWaitingFlowAction(run: SimulationRun, patients: RuntimePatient[]): { actionType: ProviderActionType; patientId: string } | undefined {
  const waitingPatients = patients
    .filter((patient) => patient.state === "waiting")
    .sort((left, right) => sortByPriority(left, right, run));
  const waitingPatient = waitingPatients.find(
    (patient) => enabledAction(run, patient, "room_patient") || enabledAction(run, patient, "fast_track_patient"),
  );

  if (!waitingPatient) {
    return undefined;
  }

  if (enabledAction(run, waitingPatient, "fast_track_patient")) {
    return { actionType: "fast_track_patient", patientId: waitingPatient.id };
  }

  if (enabledAction(run, waitingPatient, "room_patient")) {
    return { actionType: "room_patient", patientId: waitingPatient.id };
  }

  return undefined;
}

function chooseBenchmarkAction(run: SimulationRun): { actionType: ProviderActionType; patientId: string } | undefined {
  const patients = [...run.patients];

  const resultsReadyPatient = patients
    .filter((patient) => patient.state === "results_ready" && enabledAction(run, patient, "review_results"))
    .sort((left, right) => sortByPriority(left, right, run))[0];
  if (resultsReadyPatient) {
    return { actionType: "review_results", patientId: resultsReadyPatient.id };
  }

  const dispositionPatient = patients
    .filter((patient) => patient.state === "ready_for_disposition")
    .sort((left, right) => sortByPriority(left, right, run))[0];
  if (dispositionPatient) {
    const dispositionAction = chooseDispositionAction(dispositionPatient);
    if (enabledAction(run, dispositionPatient, dispositionAction)) {
      return { actionType: dispositionAction, patientId: dispositionPatient.id };
    }
  }

  const unseenResultsReadyPatient = patients
    .filter((patient) => patient.state === "results_ready" && patient.providerSeenAt === undefined && enabledAction(run, patient, "see_patient"))
    .sort((left, right) => sortByPriority(left, right, run))[0];
  if (unseenResultsReadyPatient) {
    return { actionType: "see_patient", patientId: unseenResultsReadyPatient.id };
  }

  const roomedReadyPatient = patients
    .filter((patient) => patient.state === "roomed" && diagnosticResultsReady(patient) && enabledAction(run, patient, "see_patient"))
    .sort((left, right) => sortByPriority(left, right, run))[0];
  if (roomedReadyPatient) {
    return { actionType: "see_patient", patientId: roomedReadyPatient.id };
  }

  const unseenResultsPendingPatient = patients
    .filter((patient) => patient.state === "results_pending" && patient.providerSeenAt === undefined && enabledAction(run, patient, "see_patient"))
    .sort((left, right) => sortByPriority(left, right, run))[0];
  if (unseenResultsPendingPatient) {
    return { actionType: "see_patient", patientId: unseenResultsPendingPatient.id };
  }

  const waitingFlowAction = chooseWaitingFlowAction(run, patients);
  if (waitingFlowAction) {
    return waitingFlowAction;
  }

  const reassessmentPatient = patients
    .filter((patient) => patient.state === "waiting" && enabledAction(run, patient, "reassess_waiting_patient"))
    .sort((left, right) => sortByPriority(left, right, run))[0];
  if (reassessmentPatient) {
    return { actionType: "reassess_waiting_patient", patientId: reassessmentPatient.id };
  }

  const roomedPatient = patients
    .filter((patient) => patient.state === "roomed" && enabledAction(run, patient, "see_patient"))
    .sort((left, right) => sortByPriority(left, right, run));
  if (roomedPatient[0]) {
    return { actionType: "see_patient", patientId: roomedPatient[0].id };
  }

  const seenPatient = patients
    .filter((patient) => patient.state === "provider_seen" && enabledAction(run, patient, "place_orders"))
    .sort((left, right) => sortByPriority(left, right, run))[0];
  if (seenPatient) {
    return { actionType: "place_orders", patientId: seenPatient.id };
  }

  const triagePatients = patients
    .filter((patient) => patient.state === "triage")
    .sort((left, right) => sortByPriority(left, right, run));
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

function chooseBalancedPriorityCoachAction(run: SimulationRun): { actionType: ProviderActionType; patientId: string } | undefined {
  const patients = [...run.patients];

  const cardiacProtocolPatient = patients
    .filter((patient) => patient.state === "triage" && isCardiacWorkupPatient(patient) && enabledAction(run, patient, "start_protocol_orders"))
    .sort((left, right) => sortByPriority(left, right, run))[0];
  if (cardiacProtocolPatient) {
    return { actionType: "start_protocol_orders", patientId: cardiacProtocolPatient.id };
  }

  const dispositionPatient = patients
    .filter((patient) => patient.state === "ready_for_disposition")
    .sort((left, right) => sortByPriority(left, right, run))[0];
  if (dispositionPatient) {
    const dispositionAction = chooseDispositionAction(dispositionPatient);
    if (enabledAction(run, dispositionPatient, dispositionAction)) {
      return { actionType: dispositionAction, patientId: dispositionPatient.id };
    }
  }

  const unseenResultsReadyPatient = patients
    .filter((patient) => patient.state === "results_ready" && patient.providerSeenAt === undefined && enabledAction(run, patient, "see_patient"))
    .sort((left, right) => sortByPriority(left, right, run))[0];
  if (unseenResultsReadyPatient) {
    return { actionType: "see_patient", patientId: unseenResultsReadyPatient.id };
  }

  const roomedPatient = patients
    .filter((patient) => patient.state === "roomed" && enabledAction(run, patient, "see_patient"))
    .sort((left, right) => sortByPriority(left, right, run))[0];
  if (roomedPatient) {
    return { actionType: "see_patient", patientId: roomedPatient.id };
  }

  const unseenResultsPendingPatient = patients
    .filter((patient) => patient.state === "results_pending" && patient.providerSeenAt === undefined && enabledAction(run, patient, "see_patient"))
    .sort((left, right) => sortByPriority(left, right, run))[0];
  if (unseenResultsPendingPatient) {
    return { actionType: "see_patient", patientId: unseenResultsPendingPatient.id };
  }

  const resultsReadyPatient = patients
    .filter((patient) => patient.state === "results_ready" && enabledAction(run, patient, "review_results"))
    .sort((left, right) => sortByPriority(left, right, run))[0];
  if (resultsReadyPatient) {
    return { actionType: "review_results", patientId: resultsReadyPatient.id };
  }

  const waitingFlowAction = chooseWaitingFlowAction(run, patients);
  if (waitingFlowAction) {
    return waitingFlowAction;
  }

  const reassessmentPatient = patients
    .filter((patient) => patient.state === "waiting" && enabledAction(run, patient, "reassess_waiting_patient"))
    .sort((left, right) => sortByPriority(left, right, run))[0];
  if (reassessmentPatient) {
    return { actionType: "reassess_waiting_patient", patientId: reassessmentPatient.id };
  }

  const seenPatient = patients
    .filter((patient) => patient.state === "provider_seen" && enabledAction(run, patient, "place_orders"))
    .sort((left, right) => sortByPriority(left, right, run))[0];
  if (seenPatient) {
    return { actionType: "place_orders", patientId: seenPatient.id };
  }

  if (patients.some((patient) => patient.state === "waiting")) {
    return undefined;
  }

  const triagePatients = patients
    .filter((patient) => patient.state === "triage")
    .sort((left, right) => sortByPriority(left, right, run));
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
  switch (coachPriorityProfile(run).mode) {
    case "safety_first":
      return chooseSafetyFirstAction(run);
    case "throughput":
      return chooseDispositionFocusAction(run) ?? chooseBenchmarkAction(run);
    case "front_end":
      return chooseFrontEndFocusAction(run) ?? chooseBalancedPriorityCoachAction(run);
    default:
      return chooseBalancedPriorityCoachAction(run);
  }
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
    .sort((left, right) => sortByPriority(left, right, run))[0];
  if (unseenResultsReadyPatient) {
    return { actionType: "see_patient", patientId: unseenResultsReadyPatient.id };
  }

  const roomedPatient = patients
    .filter((patient) => patient.state === "roomed" && enabledAction(run, patient, "see_patient"))
    .sort((left, right) => sortByPriority(left, right, run))[0];
  if (roomedPatient) {
    return { actionType: "see_patient", patientId: roomedPatient.id };
  }

  const unseenResultsPendingPatient = patients
    .filter((patient) => patient.state === "results_pending" && patient.providerSeenAt === undefined && enabledAction(run, patient, "see_patient"))
    .sort((left, right) => sortByPriority(left, right, run))[0];
  if (unseenResultsPendingPatient) {
    return { actionType: "see_patient", patientId: unseenResultsPendingPatient.id };
  }

  const seenPatient = patients
    .filter((patient) => patient.state === "provider_seen" && enabledAction(run, patient, "place_orders"))
    .sort((left, right) => sortByPriority(left, right, run))[0];
  if (seenPatient) {
    return { actionType: "place_orders", patientId: seenPatient.id };
  }

  const resultsReadyPatient = patients
    .filter((patient) => patient.state === "results_ready" && enabledAction(run, patient, "review_results"))
    .sort((left, right) => sortByPriority(left, right, run))[0];
  if (resultsReadyPatient) {
    return { actionType: "review_results", patientId: resultsReadyPatient.id };
  }

  const waitingPatient = patients
    .filter((patient) => patient.state === "waiting" && enabledAction(run, patient, "room_patient"))
    .sort((left, right) => sortByPriority(left, right, run))[0];
  if (waitingPatient) {
    return { actionType: "room_patient", patientId: waitingPatient.id };
  }

  const dispositionPatient = patients
    .filter((patient) => patient.state === "ready_for_disposition")
    .sort((left, right) => sortByPriority(left, right, run))[0];
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
    .sort((left, right) => sortByPriority(left, right, run))[0];
  if (dispositionPatient) {
    const dispositionAction = chooseDispositionAction(dispositionPatient);
    if (enabledAction(run, dispositionPatient, dispositionAction)) {
      return { actionType: dispositionAction, patientId: dispositionPatient.id };
    }
  }

  const resultsReadyPatient = patients
    .filter((patient) => patient.state === "results_ready" && enabledAction(run, patient, "review_results"))
    .sort((left, right) => sortByPriority(left, right, run))[0];
  if (resultsReadyPatient) {
    return { actionType: "review_results", patientId: resultsReadyPatient.id };
  }

  const unseenResultsReadyPatient = patients
    .filter((patient) => patient.state === "results_ready" && patient.providerSeenAt === undefined && enabledAction(run, patient, "see_patient"))
    .sort((left, right) => sortByPriority(left, right, run))[0];
  if (unseenResultsReadyPatient) {
    return { actionType: "see_patient", patientId: unseenResultsReadyPatient.id };
  }

  const seenPatient = patients
    .filter((patient) => patient.state === "provider_seen" && enabledAction(run, patient, "place_orders"))
    .sort((left, right) => sortByPriority(left, right, run))[0];
  if (seenPatient) {
    return { actionType: "place_orders", patientId: seenPatient.id };
  }

  const roomedPatient = patients
    .filter((patient) => patient.state === "roomed" && enabledAction(run, patient, "see_patient"))
    .sort((left, right) => sortByPriority(left, right, run))[0];
  if (roomedPatient) {
    return { actionType: "see_patient", patientId: roomedPatient.id };
  }

  const waitingPatient = patients
    .filter((patient) => patient.state === "waiting" && enabledAction(run, patient, "room_patient"))
    .sort((left, right) => sortByPriority(left, right, run))[0];
  if (waitingPatient) {
    return { actionType: "room_patient", patientId: waitingPatient.id };
  }

  return undefined;
}

function chooseResourceAwareAction(run: SimulationRun): { actionType: ProviderActionType; patientId: string } | undefined {
  const patients = [...run.patients];
  const nurseTotal = run.supportResources?.find((pool) => pool.role === "nurse")?.total ?? 0;
  const techTotal = run.supportResources?.find((pool) => pool.role === "tech")?.total ?? 0;
  const nursesConstrained = nurseTotal > 0 && run.metrics.nursesBusy >= nurseTotal;
  const techsConstrained = techTotal > 0 && run.metrics.techsBusy >= techTotal;
  const supportConstrained = nursesConstrained || techsConstrained;

  const dispositionPatient = patients
    .filter((patient) => patient.state === "ready_for_disposition")
    .sort((left, right) => sortByPriority(left, right, run))[0];
  if (dispositionPatient) {
    const dispositionAction = chooseDispositionAction(dispositionPatient);
    if (enabledAction(run, dispositionPatient, dispositionAction)) {
      return { actionType: dispositionAction, patientId: dispositionPatient.id };
    }
  }

  const resultsReadyPatient = patients
    .filter((patient) => patient.state === "results_ready" && enabledAction(run, patient, "review_results"))
    .sort((left, right) => sortByPriority(left, right, run))[0];
  if (resultsReadyPatient) {
    return { actionType: "review_results", patientId: resultsReadyPatient.id };
  }

  const unseenRoomedPatient = patients
    .filter(
      (patient) =>
        (patient.state === "roomed" || patient.state === "results_pending" || patient.state === "results_ready") &&
        patient.providerSeenAt === undefined &&
        enabledAction(run, patient, "see_patient"),
    )
    .sort((left, right) => sortByPriority(left, right, run))[0];
  if (unseenRoomedPatient) {
    return { actionType: "see_patient", patientId: unseenRoomedPatient.id };
  }

  if (supportConstrained) {
    return undefined;
  }

  const seenPatient = patients
    .filter((patient) => patient.state === "provider_seen" && enabledAction(run, patient, "place_orders"))
    .sort((left, right) => sortByPriority(left, right, run))[0];
  if (seenPatient) {
    return { actionType: "place_orders", patientId: seenPatient.id };
  }

  const waitingFlowAction = chooseWaitingFlowAction(run, patients);
  if (waitingFlowAction) {
    return waitingFlowAction;
  }

  const reassessmentPatient = patients
    .filter((patient) => patient.state === "waiting" && enabledAction(run, patient, "reassess_waiting_patient"))
    .sort((left, right) => sortByPriority(left, right, run))[0];
  if (reassessmentPatient) {
    return { actionType: "reassess_waiting_patient", patientId: reassessmentPatient.id };
  }

  const triagePatients = patients
    .filter((patient) => patient.state === "triage")
    .sort((left, right) => sortByPriority(left, right, run));
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

function chooseSafetyFirstAction(run: SimulationRun): { actionType: ProviderActionType; patientId: string } | undefined {
  const patients = [...run.patients];

  const timeSensitiveProtocolPatient = patients
    .filter(
      (patient) =>
        patient.state === "triage" &&
        (isCardiacWorkupPatient(patient) || isSepsisWorkupPatient(patient)) &&
        enabledAction(run, patient, "start_protocol_orders"),
    )
    .sort((left, right) => sortByPriority(left, right, run))[0];
  if (timeSensitiveProtocolPatient) {
    return { actionType: "start_protocol_orders", patientId: timeSensitiveProtocolPatient.id };
  }

  const deterioratedWaitingPatient = patients
    .filter(
      (patient) =>
        patient.state === "waiting" &&
        patient.deterioratedAt !== undefined &&
        enabledAction(run, patient, "reassess_waiting_patient"),
    )
    .sort((left, right) => (left.deterioratedAt ?? 0) - (right.deterioratedAt ?? 0))[0];
  if (deterioratedWaitingPatient) {
    return { actionType: "reassess_waiting_patient", patientId: deterioratedWaitingPatient.id };
  }

  const overdueReassessmentPatient = patients
    .filter(
      (patient) =>
        patient.state === "waiting" &&
        isReassessmentOverdue(patient, run.currentMinute) &&
        enabledAction(run, patient, "reassess_waiting_patient"),
    )
    .sort((left, right) => sortByPriority(left, right, run))[0];
  if (overdueReassessmentPatient) {
    return { actionType: "reassess_waiting_patient", patientId: overdueReassessmentPatient.id };
  }

  const timeSensitiveWaitingPatient = patients
    .filter(
      (patient) =>
        patient.state === "waiting" &&
        (isCardiacWorkupPatient(patient) || isSepsisWorkupPatient(patient)) &&
        enabledAction(run, patient, "room_patient"),
    )
    .sort((left, right) => sortByPriority(left, right, run))[0];
  if (timeSensitiveWaitingPatient) {
    return { actionType: "room_patient", patientId: timeSensitiveWaitingPatient.id };
  }

  const criticalWaitingPatient = patients
    .filter(
      (patient) =>
        patient.state === "waiting" &&
        (patient.riskLevel === "critical" || patient.esi <= 2) &&
        enabledAction(run, patient, "room_patient"),
    )
    .sort((left, right) => sortByPriority(left, right, run))[0];
  if (criticalWaitingPatient) {
    return { actionType: "room_patient", patientId: criticalWaitingPatient.id };
  }

  const timeSensitiveResultsPatient = patients
    .filter(
      (patient) =>
        patient.state === "results_ready" &&
        (isCardiacWorkupPatient(patient) || isSepsisWorkupPatient(patient)) &&
        enabledAction(run, patient, "review_results"),
    )
    .sort((left, right) => sortByPriority(left, right, run))[0];
  if (timeSensitiveResultsPatient) {
    return { actionType: "review_results", patientId: timeSensitiveResultsPatient.id };
  }

  const timeSensitiveUnseenRoomedPatient = patients
    .filter(
      (patient) =>
        (patient.state === "roomed" || patient.state === "results_pending" || patient.state === "results_ready") &&
        patient.providerSeenAt === undefined &&
        (isCardiacWorkupPatient(patient) || isSepsisWorkupPatient(patient) || patient.riskLevel === "critical") &&
        enabledAction(run, patient, "see_patient"),
    )
    .sort((left, right) => sortByPriority(left, right, run))[0];
  if (timeSensitiveUnseenRoomedPatient) {
    return { actionType: "see_patient", patientId: timeSensitiveUnseenRoomedPatient.id };
  }

  const dispositionPatient = patients
    .filter((patient) => patient.state === "ready_for_disposition")
    .sort((left, right) => sortByPriority(left, right, run))[0];
  if (dispositionPatient) {
    const dispositionAction = chooseDispositionAction(dispositionPatient);
    if (enabledAction(run, dispositionPatient, dispositionAction)) {
      return { actionType: dispositionAction, patientId: dispositionPatient.id };
    }
  }

  return chooseBenchmarkAction(run);
}

function chooseFastTrackFocusAction(run: SimulationRun): { actionType: ProviderActionType; patientId: string } | undefined {
  const patients = [...run.patients];

  const fastTrackDispositionPatient = patients
    .filter((patient) => patient.state === "ready_for_disposition" && patient.fastTrackedAt !== undefined)
    .sort(lowAcuitySort)[0];
  if (fastTrackDispositionPatient) {
    const dispositionAction = chooseDispositionAction(fastTrackDispositionPatient);
    if (enabledAction(run, fastTrackDispositionPatient, dispositionAction)) {
      return { actionType: dispositionAction, patientId: fastTrackDispositionPatient.id };
    }
  }

  const fastTrackResultsPatient = patients
    .filter((patient) => patient.state === "results_ready" && patient.fastTrackedAt !== undefined && enabledAction(run, patient, "review_results"))
    .sort(lowAcuitySort)[0];
  if (fastTrackResultsPatient) {
    return { actionType: "review_results", patientId: fastTrackResultsPatient.id };
  }

  const unseenFastTrackPatient = patients
    .filter((patient) => patient.state === "fast_track" && patient.providerSeenAt === undefined && enabledAction(run, patient, "see_patient"))
    .sort(lowAcuitySort)[0];
  if (unseenFastTrackPatient) {
    return { actionType: "see_patient", patientId: unseenFastTrackPatient.id };
  }

  const seenFastTrackPatient = patients
    .filter((patient) => patient.state === "provider_seen" && patient.fastTrackedAt !== undefined && enabledAction(run, patient, "place_orders"))
    .sort(lowAcuitySort)[0];
  if (seenFastTrackPatient) {
    return { actionType: "place_orders", patientId: seenFastTrackPatient.id };
  }

  const fastTrackCandidate = patients
    .filter((patient) => patient.state === "waiting" && enabledAction(run, patient, "fast_track_patient"))
    .sort(lowAcuitySort)[0];
  if (fastTrackCandidate) {
    return { actionType: "fast_track_patient", patientId: fastTrackCandidate.id };
  }

  return chooseBenchmarkAction(run);
}

function chooseBalancedOperationsAction(run: SimulationRun): { actionType: ProviderActionType; patientId: string } | undefined {
  const patients = [...run.patients];

  const timeSensitiveProtocolPatient = patients
    .filter(
      (patient) =>
        patient.state === "triage" &&
        (isCardiacWorkupPatient(patient) || isSepsisWorkupPatient(patient)) &&
        enabledAction(run, patient, "start_protocol_orders"),
    )
    .sort((left, right) => sortByPriority(left, right, run))[0];
  if (timeSensitiveProtocolPatient) {
    return { actionType: "start_protocol_orders", patientId: timeSensitiveProtocolPatient.id };
  }

  const deterioratedWaitingPatient = patients
    .filter(
      (patient) =>
        patient.state === "waiting" &&
        patient.deterioratedAt !== undefined &&
        enabledAction(run, patient, "reassess_waiting_patient"),
    )
    .sort((left, right) => sortByPriority(left, right, run))[0];
  if (deterioratedWaitingPatient) {
    return { actionType: "reassess_waiting_patient", patientId: deterioratedWaitingPatient.id };
  }

  const dispositionPatient = patients
    .filter((patient) => patient.state === "ready_for_disposition")
    .sort((left, right) => sortByPriority(left, right, run))[0];
  if (dispositionPatient) {
    const dispositionAction = chooseDispositionAction(dispositionPatient);
    if (enabledAction(run, dispositionPatient, dispositionAction)) {
      return { actionType: dispositionAction, patientId: dispositionPatient.id };
    }
  }

  const resultsReadyPatient = patients
    .filter((patient) => patient.state === "results_ready" && enabledAction(run, patient, "review_results"))
    .sort((left, right) => sortByPriority(left, right, run))[0];
  if (resultsReadyPatient) {
    return { actionType: "review_results", patientId: resultsReadyPatient.id };
  }

  const unseenRoomedPatient = patients
    .filter(
      (patient) =>
        (patient.state === "roomed" || patient.state === "results_pending" || patient.state === "results_ready") &&
        patient.providerSeenAt === undefined &&
        enabledAction(run, patient, "see_patient"),
    )
    .sort((left, right) => sortByPriority(left, right, run))[0];
  if (unseenRoomedPatient) {
    return { actionType: "see_patient", patientId: unseenRoomedPatient.id };
  }

  const seenPatient = patients
    .filter((patient) => patient.state === "provider_seen" && enabledAction(run, patient, "place_orders"))
    .sort((left, right) => sortByPriority(left, right, run))[0];
  if (seenPatient) {
    return { actionType: "place_orders", patientId: seenPatient.id };
  }

  const fastTrackCandidate = patients
    .filter((patient) => patient.state === "waiting" && enabledAction(run, patient, "fast_track_patient"))
    .sort(lowAcuitySort)[0];
  if (fastTrackCandidate) {
    return { actionType: "fast_track_patient", patientId: fastTrackCandidate.id };
  }

  const waitingFlowAction = chooseWaitingFlowAction(run, patients);
  if (waitingFlowAction) {
    return waitingFlowAction;
  }

  const overdueReassessmentPatient = patients
    .filter(
      (patient) =>
        patient.state === "waiting" &&
        isReassessmentOverdue(patient, run.currentMinute) &&
        enabledAction(run, patient, "reassess_waiting_patient"),
    )
    .sort((left, right) => sortByPriority(left, right, run))[0];
  if (overdueReassessmentPatient) {
    return { actionType: "reassess_waiting_patient", patientId: overdueReassessmentPatient.id };
  }

  const triagePatients = patients
    .filter((patient) => patient.state === "triage")
    .sort((left, right) => sortByPriority(left, right, run));
  const protocolPatient = triagePatients.find((patient) => enabledAction(run, patient, "start_protocol_orders"));
  if (protocolPatient) {
    return { actionType: "start_protocol_orders", patientId: protocolPatient.id };
  }
  const triagePatient = triagePatients.find((patient) => enabledAction(run, patient, "complete_triage"));
  if (triagePatient) {
    return { actionType: "complete_triage", patientId: triagePatient.id };
  }

  return chooseBenchmarkAction(run);
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
    case "fast_track_patient":
      return `${patientSummary} Fast Track can move this lower-acuity patient through vertical care without consuming an ED room.`;
    case "reassess_waiting_patient":
      return `${patientSummary} Reassessment is overdue; reassessing resets the waiting-room safety clock and may prevent further deterioration.`;
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
  priorityProfile: CoachPriorityProfile,
  untilMinute?: number,
): SimulationRun {
  let run = startSimulation(createSimulationRun(scenarioWithCoachPriorityProfile(scenario, priorityProfile), deck));

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
  return runFocusedCoachBenchmark(scenario, deck, chooseFrontEndFocusAction, scenario.coachStrategyPriorityProfiles.front_end_focus, untilMinute);
}

export function runMiddleFlowFocusCoachBenchmark(scenario: Scenario, deck: ScenarioPatient[], untilMinute?: number): SimulationRun {
  return runFocusedCoachBenchmark(scenario, deck, chooseMiddleFlowFocusAction, scenario.coachStrategyPriorityProfiles.middle_flow_focus, untilMinute);
}

export function runDispositionFocusCoachBenchmark(scenario: Scenario, deck: ScenarioPatient[], untilMinute?: number): SimulationRun {
  return runFocusedCoachBenchmark(scenario, deck, chooseDispositionFocusAction, scenario.coachStrategyPriorityProfiles.disposition_focus, untilMinute);
}

export function runResourceAwareCoachBenchmark(scenario: Scenario, deck: ScenarioPatient[], untilMinute?: number): SimulationRun {
  return runFocusedCoachBenchmark(scenario, deck, chooseResourceAwareAction, scenario.coachStrategyPriorityProfiles.resource_aware, untilMinute);
}

export function runSafetyFirstCoachBenchmark(scenario: Scenario, deck: ScenarioPatient[], untilMinute?: number): SimulationRun {
  return runFocusedCoachBenchmark(scenario, deck, chooseSafetyFirstAction, scenario.coachStrategyPriorityProfiles.safety_first, untilMinute);
}

export function runFastTrackCoachBenchmark(scenario: Scenario, deck: ScenarioPatient[], untilMinute?: number): SimulationRun {
  return runFocusedCoachBenchmark(scenario, deck, chooseFastTrackFocusAction, scenario.coachStrategyPriorityProfiles.fast_track, untilMinute);
}

export function runBalancedOperationsCoachBenchmark(scenario: Scenario, deck: ScenarioPatient[], untilMinute?: number): SimulationRun {
  return runFocusedCoachBenchmark(scenario, deck, chooseBalancedOperationsAction, scenario.coachStrategyPriorityProfiles.balanced_operations, untilMinute);
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

function benchmarkRunForStrategy(benchmark: OptimalFlowBenchmark, strategyId: WhatIfCoachStrategyId): SimulationRun {
  switch (strategyId) {
    case "front_end_focus":
      return benchmark.frontEndFocusRun;
    case "middle_flow_focus":
      return benchmark.middleFlowFocusRun;
    case "disposition_focus":
      return benchmark.dispositionFocusRun;
    case "resource_aware":
      return benchmark.resourceAwareRun;
    case "safety_first":
      return benchmark.safetyFirstRun;
    case "fast_track":
      return benchmark.fastTrackRun;
    case "balanced_operations":
      return benchmark.balancedOperationsRun;
    case "optimal_flow":
    case "provider_run":
      return benchmark.benchmarkRun;
  }
}

function benchmarkLabelForStrategy(benchmark: OptimalFlowBenchmark, strategyId: WhatIfCoachStrategyId): string {
  const summary = benchmark.whatIfComparison.summaries.find((candidate) => candidate.id === strategyId);

  return summary?.label ?? "Optimal Flow Coach";
}

function comparisonHeadline(comparisons: BenchmarkMetricComparison[], targetLabel: string): string {
  const worseComparisons = comparisons.filter((comparison) => comparison.interpretation === "worse").length;

  return worseComparisons === 0
    ? `Provider Run is tracking close to ${targetLabel}.`
    : `${worseComparisons} operational metric(s) trail ${targetLabel}.`;
}

export function createBenchmarkComparisonView(
  actualRun: SimulationRun,
  benchmark: OptimalFlowBenchmark,
  targetStrategyId: WhatIfCoachStrategyId,
): BenchmarkComparisonView {
  const normalizedStrategyId = targetStrategyId === "provider_run" ? "optimal_flow" : targetStrategyId;
  const targetRun = benchmarkRunForStrategy(benchmark, normalizedStrategyId);
  const targetLabel = benchmarkLabelForStrategy(benchmark, normalizedStrategyId);
  const comparisons = metricComparisons(actualRun.metrics, targetRun.metrics);

  return {
    targetStrategyId: normalizedStrategyId,
    targetLabel,
    headline: comparisonHeadline(comparisons, targetLabel),
    comparisons,
    opportunities: patientOpportunities(actualRun, targetRun),
  };
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
  summary: Pick<WhatIfCoachStrategySummary, "id" | "label" | "description" | "priorityProfile">,
): WhatIfCoachStrategySummary {
  return {
    ...summary,
    priorityProfile: summary.id === "provider_run" ? undefined : summary.priorityProfile ?? run.coachPriorityProfile,
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
  resourceAwareRun: SimulationRun,
  safetyFirstRun: SimulationRun,
  fastTrackRun: SimulationRun,
  balancedOperationsRun: SimulationRun,
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
        priorityProfile: optimalRun.coachPriorityProfile,
      }),
      strategySummary(frontEndFocusRun, {
        id: "front_end_focus",
        label: "Front-End Focus Coach",
        description: "Prioritizes triage, protocol starts, and waiting-room intake before downstream roomed-patient work.",
        priorityProfile: frontEndFocusRun.coachPriorityProfile,
      }),
      strategySummary(middleFlowFocusRun, {
        id: "middle_flow_focus",
        label: "Middle Flow Focus Coach",
        description: "Prioritizes roomed patients, provider evaluation, orders, and diagnostic result movement.",
        priorityProfile: middleFlowFocusRun.coachPriorityProfile,
      }),
      strategySummary(dispositionFocusRun, {
        id: "disposition_focus",
        label: "Disposition Focus Coach",
        description: "Prioritizes results review and discharge/admit decisions to clear rooms and define boarding.",
        priorityProfile: dispositionFocusRun.coachPriorityProfile,
      }),
      strategySummary(resourceAwareRun, {
        id: "resource_aware",
        label: "Resource-Aware Coach",
        description: "Works around nurse, tech, room, and provider constraints before consuming scarce support capacity.",
        priorityProfile: resourceAwareRun.coachPriorityProfile,
      }),
      strategySummary(safetyFirstRun, {
        id: "safety_first",
        label: "Safety First Coach",
        description: "Prioritizes deteriorating patients, overdue reassessments, high-risk waits, and time-sensitive cardiac/sepsis flow.",
        priorityProfile: safetyFirstRun.coachPriorityProfile,
      }),
      strategySummary(fastTrackRun, {
        id: "fast_track",
        label: "Fast Track Coach",
        description: "Prioritizes eligible lower-acuity patients into Fast Track and keeps vertical-care patients moving.",
        priorityProfile: fastTrackRun.coachPriorityProfile,
      }),
      strategySummary(balancedOperationsRun, {
        id: "balanced_operations",
        label: "Balanced Operations Coach",
        description: "Blends safety, throughput, disposition, Fast Track, and resource-aware priorities.",
        priorityProfile: balancedOperationsRun.coachPriorityProfile,
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
  const resourceAwareRun = runResourceAwareCoachBenchmark(scenario, deck, actualRun.currentMinute);
  const safetyFirstRun = runSafetyFirstCoachBenchmark(scenario, deck, actualRun.currentMinute);
  const fastTrackRun = runFastTrackCoachBenchmark(scenario, deck, actualRun.currentMinute);
  const balancedOperationsRun = runBalancedOperationsCoachBenchmark(scenario, deck, actualRun.currentMinute);
  const comparisons = metricComparisons(actualRun.metrics, benchmarkRun.metrics);
  const headline = comparisonHeadline(comparisons, "Optimal Flow Coach");

  return {
    benchmarkRun,
    frontEndFocusRun,
    middleFlowFocusRun,
    dispositionFocusRun,
    resourceAwareRun,
    safetyFirstRun,
    fastTrackRun,
    balancedOperationsRun,
    headline,
    comparisons,
    opportunities: patientOpportunities(actualRun, benchmarkRun),
    whatIfComparison: createWhatIfCoachComparison(
      actualRun,
      benchmarkRun,
      frontEndFocusRun,
      middleFlowFocusRun,
      dispositionFocusRun,
      resourceAwareRun,
      safetyFirstRun,
      fastTrackRun,
      balancedOperationsRun,
    ),
  };
}
