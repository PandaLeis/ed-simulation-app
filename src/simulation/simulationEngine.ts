import { ACTION_LABELS, DEFAULT_ACTION_COST_MINUTES, eligibleIdleProviderForPatient, getAvailableProviderActions } from "./actionRules";
import { createRuntimePatients } from "./arrivalGenerator";
import { buildCardiacPendingItems, isCardiacWorkupPatient, isDiagnosticPendingItem } from "./cardiacWorkflow";
import { appendEvent, appendEventToList, createEvent } from "./eventLogger";
import { calculateMetrics, emptyMetrics } from "./metricsEngine";
import { sampleProviderEvaluationMinutes } from "./providerEvaluation";
import { buildSepsisPendingItems, isSepsisWorkupPatient } from "./sepsisWorkflow";
import { createSeededRandom } from "./seededRandom";
import { defaultScenario } from "./mockScenario";
import {
  accrueSupportResourceTime,
  createSupportResourcePools,
  hasAvailableSupportResources,
  releaseCompletedSupportResources,
  reserveSupportResources,
} from "./supportResources";
import { getTriageDurationMinutes } from "./triageDuration";
import {
  isReassessmentOverdue,
  nextReassessmentDueAt,
  reassessmentOverdueMinutes,
} from "./waitingRoomSafety";
import type {
  EDRoom,
  PatientState,
  ProviderActionType,
  ProviderDecision,
  RuntimePatient,
  Scenario,
  ScenarioPatient,
  RiskLevel,
  SimulationRun,
  TriageProviderMode,
} from "./types";

const FRONT_END_TRIAGE_AGING_PRIORITY_MINUTES = 60;

function createRunId(scenario: Scenario): string {
  const randomId = globalThis.crypto?.randomUUID?.() ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  return `run-${scenario.id}-${randomId}`;
}

function createProviderDecision(
  run: SimulationRun,
  actionType: ProviderActionType,
  patientId?: string,
  providerId?: string,
  timeCostMinutes = DEFAULT_ACTION_COST_MINUTES[actionType],
): ProviderDecision {
  const patient = patientId ? run.patients.find((candidate) => candidate.id === patientId) : undefined;

  return {
    id: `${run.id}-decision-${String(run.decisions.length + 1).padStart(6, "0")}`,
    runId: run.id,
    simulationMinute: run.currentMinute,
    patientId,
    actionType,
    actionLabel: ACTION_LABELS[actionType],
    timeCostMinutes,
    previousState: patient?.state,
    providerId,
  };
}

function patientState(run: SimulationRun, patientId?: string): PatientState | undefined {
  return patientId ? run.patients.find((patient) => patient.id === patientId)?.state : undefined;
}

function setDecisionResult(
  run: SimulationRun,
  decisionId: string,
  resultingState: PatientState | undefined,
): SimulationRun {
  return {
    ...run,
    decisions: run.decisions.map((decision) =>
      decision.id === decisionId
        ? {
            ...decision,
            resultingState,
          }
        : decision,
    ),
  };
}

export function createSimulationRun(scenario: Scenario, deck: ScenarioPatient[]): SimulationRun {
  const rooms: EDRoom[] = Array.from({ length: scenario.roomCapacity }, (_, index) => ({
    id: `room-${String(index + 1).padStart(2, "0")}`,
    status: "available",
  }));

  const providers = Array.from({ length: Math.max(1, scenario.providerCount) }, (_, index) => ({
    id: `provider-${String(index + 1).padStart(3, "0")}`,
    displayName: `Provider ${index + 1}`,
    status: "idle" as const,
    busyMinutes: 0,
    idleMinutes: 0,
  }));
  const primaryProvider = providers[0];
  if (!primaryProvider) {
    throw new Error("Simulation requires at least one provider.");
  }

  const run: SimulationRun = {
    id: createRunId(scenario),
    scenarioId: scenario.id,
    triageProviderEnabled: scenario.triageProviderEnabled,
    triageProviderMode: scenario.triageProviderMode ?? (scenario.triageProviderEnabled ? "manual" : "unavailable"),
    runType: "original",
    shiftStartMinute: scenario.shiftStartMinute,
    currentMinute: scenario.shiftStartMinute,
    startedAt: new Date().toISOString(),
    status: "not_started",
    fastTrackEnabled: scenario.fastTrackEnabled,
    patients: createRuntimePatients(deck),
    rooms,
    provider: primaryProvider,
    providers,
    providerAssignmentMode: scenario.providerAssignmentMode,
    triageProvider: {
      id: "front-end-triage-provider",
      displayName: "Front-End Triage Provider",
      status: "idle",
      busyMinutes: 0,
      idleMinutes: 0,
    },
    supportResources: createSupportResourcePools(scenario.nurseCount, scenario.techCount),
    triageDurationProfile: scenario.triageDurationProfile,
    triageDurationMultiplier: scenario.triageDurationMultiplier,
    timingProfile: scenario.timingProfile,
    workflowTimingProfile: scenario.workflowTimingProfile,
    coachPriorityProfile: scenario.coachPriorityProfile,
    events: [],
    decisions: [],
    metrics: {
      ...emptyMetrics(),
      availableRooms: scenario.roomCapacity,
    },
  };

  return run;
}

export function startSimulation(run: SimulationRun): SimulationRun {
  const startedRun = {
    ...run,
    status: "running" as const,
    events: [
      ...run.events,
      createEvent(run, {
        type: "simulation_started",
        message: "Simulation started.",
      }),
    ],
  };

  return withMetrics(startedRun);
}

export function pauseSimulation(run: SimulationRun): SimulationRun {
  return appendEvent(
    {
      ...run,
      status: "paused",
    },
    {
      type: "simulation_paused",
      message: "Simulation paused.",
    },
  );
}

export function setFrontEndTriageProviderEnabled(run: SimulationRun, enabled: boolean): SimulationRun {
  return setFrontEndTriageProviderMode(run, enabled ? "manual" : "unavailable");
}

export function setFrontEndTriageProviderMode(run: SimulationRun, mode: TriageProviderMode): SimulationRun {
  const enabled = mode !== "unavailable";
  if (run.triageProviderEnabled === enabled) {
    return {
      ...run,
      triageProviderMode: mode,
    };
  }

  let events = run.events;
  const patients = run.patients.map((patient) => {
    if (!enabled && patient.state === "triage") {
      events = appendEventToList(run, events, {
        type: "triage_bypassed",
        patientId: patient.id,
        previousState: "triage",
        newState: "waiting",
        message: `${patient.id} moved to the waiting room after front-end triage was disabled.`,
      });

      return {
        ...patient,
        state: "waiting" as const,
        nextReassessmentDueAt: nextReassessmentDueAt(patient, run.currentMinute),
      };
    }

    if (enabled && patient.state === "waiting" && patient.triagedAt === undefined) {
      events = appendEventToList(run, events, {
        type: "triage_reopened",
        patientId: patient.id,
        previousState: "waiting",
        newState: "triage",
        message: `${patient.id} returned to front-end triage after the triage provider became available.`,
      });

      return {
        ...patient,
        state: "triage" as const,
        arrivalPath: "front_end_triage" as const,
        nextReassessmentDueAt: undefined,
      };
    }

    return patient;
  });

  return withMetrics({
    ...run,
    triageProviderEnabled: enabled,
    triageProviderMode: mode,
    patients,
    events,
  });
}

export function advanceOneMinute(run: SimulationRun, scenario: Scenario): SimulationRun {
  if (run.status !== "running") {
    return run;
  }

  let nextRun: SimulationRun = {
    ...run,
    currentMinute: run.currentMinute + 1,
  };

  nextRun = accrueProviderTime(nextRun);
  nextRun = accrueSupportResourceTime(nextRun);
  nextRun = releaseCompletedSupportResources(nextRun);
  nextRun = processRoomCleaning(nextRun);
  nextRun = processArrivals(nextRun);
  nextRun = processTriageProviderCompletion(nextRun);
  nextRun = processProviderCompletion(nextRun, scenario);
  nextRun = processAutomatedTriage(nextRun);
  nextRun = processPendingItems(nextRun);
  nextRun = processAdmissionAcceptances(nextRun);
  nextRun = processBoardingDepartures(nextRun);
  nextRun = updateWaitingRisk(nextRun);
  nextRun = processWaitingRoomReassessmentAndDeterioration(nextRun);
  nextRun = processLWBS(nextRun, scenario);

  if (nextRun.currentMinute >= scenario.shiftStartMinute + scenario.shiftDurationMinutes) {
    nextRun = appendEvent(
      {
        ...nextRun,
        status: "shift_ended",
        endedAt: new Date().toISOString(),
      },
      {
        type: "shift_ended",
        message: "Simulation window ended.",
      },
    );
  }

  return withMetrics(nextRun);
}

export function applyProviderAction(
  run: SimulationRun,
  actionType: ProviderActionType,
  patientId?: string,
): SimulationRun {
  const triageProviderAction = actionType === "start_protocol_orders" || actionType === "complete_triage";
  const patient = patientId ? run.patients.find((candidate) => candidate.id === patientId) : undefined;
  const idleProvider = triageProviderAction ? undefined : eligibleIdleProviderForPatient(run, patient);
  if (
    run.status !== "running" ||
    (!idleProvider && !triageProviderAction) ||
    (triageProviderAction && run.triageProvider.status !== "idle")
  ) {
    return run;
  }

  const matchingAction = getAvailableProviderActions(run, patientId).find((action) => action.type === actionType);
  if (!matchingAction?.enabled) {
    return run;
  }

  const timeCostMinutes =
    actionType === "complete_triage" && patient
      ? getTriageDurationMinutes(patient, run.triageDurationProfile, run.triageDurationMultiplier)
      : actionType === "see_patient" && patient
        ? sampleProviderEvaluationMinutes(
            createSeededRandom(`${run.scenarioId}:${patient.id}:provider-evaluation:${run.currentMinute}`),
            patient,
            run.timingProfile.providerEvaluation,
          )
      : DEFAULT_ACTION_COST_MINUTES[actionType];
  const decision = createProviderDecision(
    run,
    actionType,
    patientId,
    triageProviderAction ? run.triageProvider.id : idleProvider?.id,
    timeCostMinutes,
  );

  if (actionType === "continue_waiting") {
    return {
      ...run,
      decisions: [...run.decisions, { ...decision, resultingState: decision.previousState }],
    };
  }

  if (actionType === "complete_triage") {
    return patient ? startTriageCompletion(run, patient) : run;
  }

  if (actionType === "start_protocol_orders") {
    const triageRun = startProtocolOrders(run, patientId);

    return withMetrics({
      ...triageRun,
      decisions: [...run.decisions, { ...decision, resultingState: patientState(triageRun, patientId) }],
    });
  }

  const providerRun = synchronizePrimaryProvider({
    ...run,
    patients: assignPatientProvider(run, patientId, idleProvider?.id),
    providers: run.providers.map((provider) =>
      provider.id === idleProvider?.id
        ? {
            ...provider,
            status: "busy" as const,
            busyUntilMinute: run.currentMinute + decision.timeCostMinutes,
            currentAction: {
              type: actionType,
              patientId,
              providerId: provider.id,
              decisionId: decision.id,
              startedAt: run.currentMinute,
              completedAt: run.currentMinute + decision.timeCostMinutes,
            },
          }
        : provider,
    ),
    decisions: [...run.decisions, decision],
  });

  return withMetrics(
    reserveSupportResources(
      providerRun,
      actionType,
      patientId,
      decision.id,
      run.currentMinute,
      run.currentMinute + decision.timeCostMinutes,
    ),
  );
}

function assignPatientProvider(run: SimulationRun, patientId: string | undefined, providerId: string | undefined): RuntimePatient[] {
  if (!patientId || !providerId || run.providerAssignmentMode === "team") {
    return run.patients;
  }

  return run.patients.map((patient) =>
    patient.id === patientId
      ? {
          ...patient,
          assignedProviderId:
            patient.assignedProviderId === undefined || run.providerAssignmentMode === "assigned_with_handoff"
              ? providerId
              : patient.assignedProviderId,
        }
      : patient,
  );
}

function synchronizePrimaryProvider(run: SimulationRun): SimulationRun {
  return {
    ...run,
    provider: run.providers[0] ?? run.provider,
  };
}

function accrueProviderTime(run: SimulationRun): SimulationRun {
  return synchronizePrimaryProvider({
    ...run,
    providers: run.providers.map((provider) =>
      provider.status === "busy"
        ? { ...provider, busyMinutes: provider.busyMinutes + 1 }
        : { ...provider, idleMinutes: provider.idleMinutes + 1 },
    ),
    triageProvider:
      run.triageProvider.status === "busy"
        ? { ...run.triageProvider, busyMinutes: run.triageProvider.busyMinutes + 1 }
        : { ...run.triageProvider, idleMinutes: run.triageProvider.idleMinutes + 1 },
  });
}

function processArrivals(run: SimulationRun): SimulationRun {
  let events = run.events;
  const patients = run.patients.map((patient) => {
    if (patient.state !== "not_arrived" || patient.arrivalMinute > run.currentMinute) {
      return patient;
    }

    const newState: PatientState = run.triageProviderEnabled ? "triage" : "waiting";
    const arrivedPatient: RuntimePatient = {
      ...patient,
      state: newState,
      arrivalPath: run.triageProviderEnabled ? "front_end_triage" : "direct_waiting_room",
      arrivedAt: run.currentMinute,
      nextReassessmentDueAt: newState === "waiting" ? nextReassessmentDueAt(patient, run.currentMinute) : undefined,
    };

    events = appendEventToList(run, events, {
        type: "patient_arrived",
        patientId: patient.id,
        previousState: "not_arrived",
        newState,
        message: run.triageProviderEnabled
          ? `${patient.id} arrived to front-end triage.`
          : `${patient.id} arrived to the waiting room.`,
      });

    return arrivedPatient;
  });

  return {
    ...run,
    patients,
    events,
  };
}

function triageWaitMinutes(patient: RuntimePatient, currentMinute: number): number {
  return patient.arrivedAt === undefined ? 0 : Math.max(0, currentMinute - patient.arrivedAt);
}

function triagePatientPriority(currentMinute: number) {
  return (left: RuntimePatient, right: RuntimePatient): number => {
    const leftWait = triageWaitMinutes(left, currentMinute);
    const rightWait = triageWaitMinutes(right, currentMinute);
    const leftAged = leftWait >= FRONT_END_TRIAGE_AGING_PRIORITY_MINUTES;
    const rightAged = rightWait >= FRONT_END_TRIAGE_AGING_PRIORITY_MINUTES;
    const agingDifference = Number(rightAged) - Number(leftAged);
    if (agingDifference !== 0) {
      return agingDifference;
    }

    if (leftAged && rightAged) {
      const waitDifference = rightWait - leftWait;
      if (waitDifference !== 0) {
        return waitDifference;
      }
    }

    const cardiacDifference = Number(isCardiacWorkupPatient(right)) - Number(isCardiacWorkupPatient(left));
    if (cardiacDifference !== 0) {
      return cardiacDifference;
    }

    const sepsisDifference = Number(isSepsisWorkupPatient(right)) - Number(isSepsisWorkupPatient(left));
    if (sepsisDifference !== 0) {
      return sepsisDifference;
    }

    const esiDifference = left.esi - right.esi;
    if (esiDifference !== 0) {
      return esiDifference;
    }

    return left.patientNumber - right.patientNumber;
  };
}

function hasAvailableProtocolOrders(patient: RuntimePatient): boolean {
  return (
    (patient.expectedLabMinutes > 0 ||
      patient.expectedImagingMinutes > 0 ||
      isCardiacWorkupPatient(patient) ||
      isSepsisWorkupPatient(patient)) &&
    patient.ordersPlacedAt === undefined
  );
}

function startTriageCompletion(run: SimulationRun, patient: RuntimePatient): SimulationRun {
  const timeCostMinutes = getTriageDurationMinutes(
    patient,
    run.triageDurationProfile,
    run.triageDurationMultiplier,
  );
  const decision = createProviderDecision(
    run,
    "complete_triage",
    patient.id,
    run.triageProvider.id,
    timeCostMinutes,
  );

  return withMetrics({
    ...run,
    triageProvider: {
      ...run.triageProvider,
      status: "busy",
      busyUntilMinute: run.currentMinute + timeCostMinutes,
      currentAction: {
        type: "complete_triage",
        patientId: patient.id,
        providerId: run.triageProvider.id,
        decisionId: decision.id,
        startedAt: run.currentMinute,
        completedAt: run.currentMinute + timeCostMinutes,
      },
    },
    decisions: [...run.decisions, decision],
  });
}

function processAutomatedTriage(run: SimulationRun): SimulationRun {
  if (run.triageProviderMode !== "automated" || !run.triageProviderEnabled || run.triageProvider.status !== "idle") {
    return run;
  }

  const patient = [...run.patients]
    .filter((candidate) => candidate.state === "triage")
    .sort(triagePatientPriority(run.currentMinute))[0];

  if (!patient) {
    return run;
  }

  const canStartProtocolOrders =
    hasAvailableProtocolOrders(patient) && hasAvailableSupportResources(run, "start_protocol_orders");
  const actionType: ProviderActionType = canStartProtocolOrders ? "start_protocol_orders" : "complete_triage";
  if (actionType === "complete_triage") {
    return startTriageCompletion(run, patient);
  }

  const decision = createProviderDecision(run, actionType, patient.id, run.triageProvider.id);
  const triageRun = startProtocolOrders(run, patient.id);

  return withMetrics({
    ...triageRun,
    decisions: [...run.decisions, { ...decision, resultingState: patientState(triageRun, patient.id) }],
  });
}

function processTriageProviderCompletion(run: SimulationRun): SimulationRun {
  const action = run.triageProvider.currentAction;
  if (!action || action.completedAt > run.currentMinute) {
    return run;
  }

  const patient = action.patientId ? run.patients.find((candidate) => candidate.id === action.patientId) : undefined;
  const completedRun = patient ? completeTriage(run, patient) : run;

  return withMetrics(
    setDecisionResult(
      {
        ...completedRun,
        triageProvider: {
          ...completedRun.triageProvider,
          status: "idle",
          busyUntilMinute: undefined,
          currentAction: undefined,
        },
      },
      action.decisionId,
      patientState(completedRun, action.patientId),
    ),
  );
}

function processProviderCompletion(run: SimulationRun, scenario: Scenario): SimulationRun {
  let nextRun = run;

  for (const provider of run.providers) {
    const action = provider.currentAction;
    if (!action || action.completedAt > run.currentMinute) {
      continue;
    }

    nextRun = {
      ...nextRun,
      providers: nextRun.providers.map((candidate) =>
        candidate.id === provider.id
          ? {
              ...candidate,
              status: "idle" as const,
              busyUntilMinute: undefined,
              currentAction: undefined,
            }
          : candidate,
      ),
    };
    nextRun = completeProviderAction(nextRun, scenario, action.type, action.patientId);
    nextRun = setDecisionResult(nextRun, action.decisionId, patientState(nextRun, action.patientId));
  }

  return withMetrics(synchronizePrimaryProvider(nextRun));
}

function completeProviderAction(
  run: SimulationRun,
  scenario: Scenario,
  actionType: ProviderActionType,
  patientId?: string,
): SimulationRun {
  const patient = patientId ? run.patients.find((candidate) => candidate.id === patientId) : undefined;
  if (!patient) {
    return run;
  }

  switch (actionType) {
    case "complete_triage":
      return completeTriage(run, patient);
    case "fast_track_patient":
      return fastTrackPatient(run, patient);
    case "reassess_waiting_patient":
      return reassessWaitingPatient(run, patient);
    case "room_patient":
      return roomPatient(run, patient);
    case "start_protocol_orders":
      return startProtocolOrders(run, patient.id);
    case "see_patient":
      return seePatient(run, patient);
    case "place_orders":
      return placeOrders(run, patient);
    case "review_results":
      return updatePatientState(run, patient.id, "ready_for_disposition", {
        resultsReviewedAt: run.currentMinute,
        readyForDispositionAt: run.currentMinute,
        pendingItems: patient.pendingItems.map((item) => ({ ...item, status: "completed", completedAt: run.currentMinute })),
      }, "results_reviewed", `${patient.id} results were reviewed.`);
    case "discharge_home":
      return departPatient(run, patient, "discharge_home");
    case "admit_inpatient":
      return admitPatient(run, scenario, patient);
    default:
      return run;
  }
}

function seePatient(run: SimulationRun, patient: RuntimePatient): SimulationRun {
  const hasDiagnosticOrders = patient.pendingItems.some(isDiagnosticPendingItem);
  const newState: PatientState = hasDiagnosticOrders
    ? patient.resultsReadyAt === undefined
      ? "results_pending"
      : "results_ready"
    : "provider_seen";

  return updatePatientState(
    run,
    patient.id,
    newState,
    {
      providerSeenAt: run.currentMinute,
    },
    "provider_saw_patient",
    `${patient.id} was seen by the provider.`,
  );
}

function fastTrackPatient(run: SimulationRun, patient: RuntimePatient): SimulationRun {
  return updatePatientState(
    run,
    patient.id,
    "fast_track",
    {
      fastTrackedAt: run.currentMinute,
      nextReassessmentDueAt: undefined,
    },
    "patient_fast_tracked",
    `${patient.id} moved to Fast Track / vertical care.`,
  );
}

function reassessWaitingPatient(run: SimulationRun, patient: RuntimePatient): SimulationRun {
  if (patient.state !== "waiting" || !isReassessmentOverdue(patient, run.currentMinute)) {
    return run;
  }

  return appendEvent(
    {
      ...run,
      patients: run.patients.map((candidate) =>
        candidate.id === patient.id
          ? {
              ...candidate,
              lastReassessedAt: run.currentMinute,
              nextReassessmentDueAt: nextReassessmentDueAt(candidate, run.currentMinute),
            }
          : candidate,
      ),
    },
    {
      type: "patient_reassessed",
      patientId: patient.id,
      previousState: patient.state,
      newState: patient.state,
      message: `${patient.id} was reassessed in the waiting room.`,
      details: {
        overdueMinutes: reassessmentOverdueMinutes(patient, run.currentMinute),
        nextReassessmentDueAt: nextReassessmentDueAt(patient, run.currentMinute),
      },
    },
  );
}

function roomedDiagnosticState(patient: RuntimePatient): PatientState {
  const diagnosticItems = patient.pendingItems.filter(isDiagnosticPendingItem);
  if (diagnosticItems.length === 0) {
    return "roomed";
  }

  return patient.resultsReadyAt !== undefined || diagnosticItems.every((item) => item.status === "ready")
    ? "results_ready"
    : "results_pending";
}

function completeTriage(run: SimulationRun, patient: RuntimePatient): SimulationRun {
  return updatePatientState(
    run,
    patient.id,
    "waiting",
    {
      triagedAt: run.currentMinute,
      nextReassessmentDueAt: nextReassessmentDueAt(patient, run.currentMinute),
    },
    "triage_completed",
    `${patient.id} completed front-end triage and moved to the waiting room.`,
  );
}

function roomPatient(run: SimulationRun, patient: RuntimePatient): SimulationRun {
  const room = run.rooms.find((candidate) => candidate.status === "available");
  if (!room) {
    return run;
  }

  const rooms = run.rooms.map((candidate) =>
    candidate.id === room.id ? { ...candidate, status: "occupied" as const, patientId: patient.id } : candidate,
  );

  return updatePatientState(
    {
      ...run,
      rooms,
    },
    patient.id,
    roomedDiagnosticState(patient),
    {
      roomId: room.id,
      roomedAt: run.currentMinute,
      nextReassessmentDueAt: undefined,
    },
    "patient_roomed",
    `${patient.id} was roomed in ${room.id}.`,
  );
}

function startProtocolOrders(run: SimulationRun, patientId?: string): SimulationRun {
  const patient = patientId ? run.patients.find((candidate) => candidate.id === patientId) : undefined;
  if (!patient) {
    return run;
  }

  return placeOrders(run, patient, {
    keepCurrentState: true,
    message: `${patient.id} protocol orders were started by triage.`,
  });
}

function placeOrders(
  run: SimulationRun,
  patient: RuntimePatient,
  options: { keepCurrentState?: boolean; message?: string } = {},
): SimulationRun {
  const workflowTimingProfile = run.workflowTimingProfile ?? defaultScenario.workflowTimingProfile;
  let pendingItems = isSepsisWorkupPatient(patient)
    ? buildSepsisPendingItems(patient, run.currentMinute, workflowTimingProfile)
    : isCardiacWorkupPatient(patient)
      ? buildCardiacPendingItems(patient, run.currentMinute, workflowTimingProfile)
      : [];

  if (!isSepsisWorkupPatient(patient) && !isCardiacWorkupPatient(patient) && patient.expectedLabMinutes > 0) {
    pendingItems.push({
      type: "labs" as const,
      name: "Labs",
      orderedAt: run.currentMinute,
      readyAt: run.currentMinute + patient.expectedLabMinutes,
      status: "pending" as const,
    });
  }

  if (!isSepsisWorkupPatient(patient) && !isCardiacWorkupPatient(patient) && patient.expectedImagingMinutes > 0) {
    pendingItems.push({
      type: "imaging" as const,
      name: "Imaging",
      orderedAt: run.currentMinute,
      readyAt: run.currentMinute + patient.expectedImagingMinutes,
      status: "pending" as const,
    });
  }

  const nextState: PatientState = options.keepCurrentState
    ? patient.state
    : pendingItems.length > 0
      ? "results_pending"
      : "results_ready";

  let nextRun = updatePatientState(
    run,
    patient.id,
    nextState,
    {
      ordersPlacedAt: run.currentMinute,
      pendingItems,
      sepsisRecognizedAt: isSepsisWorkupPatient(patient) ? (patient.sepsisRecognizedAt ?? run.currentMinute) : patient.sepsisRecognizedAt,
      resultsReadyAt: pendingItems.length === 0 ? run.currentMinute : undefined,
    },
    "orders_placed",
    options.message ?? `${patient.id} orders were placed.`,
  );

  return nextRun;
}

function processPendingItems(run: SimulationRun): SimulationRun {
  let events = run.events;
  const patients = run.patients.map((patient) => {
    const diagnosticItems = patient.pendingItems.filter(isDiagnosticPendingItem);
    if (diagnosticItems.length === 0 || patient.resultsReadyAt !== undefined) {
      return patient;
    }

    let ecgCompletedAt = patient.ecgCompletedAt;
    let ecgReviewedAt = patient.ecgReviewedAt;
    let stemiAlertActivatedAt = patient.stemiAlertActivatedAt;
    const pendingItems = patient.pendingItems.map((item) => {
      if (!isDiagnosticPendingItem(item) || item.status !== "pending" || item.readyAt > run.currentMinute) {
        return item;
      }

      if (item.type === "ecg" && ecgCompletedAt === undefined) {
        ecgCompletedAt = run.currentMinute;
        events = appendEventToList(run, events, {
          type: "ecg_completed",
          patientId: patient.id,
          previousState: patient.state,
          newState: patient.state,
          message: `${patient.id} ECG is complete.`,
          details: {
            doorToEcgMinutes: patient.arrivedAt === undefined ? undefined : run.currentMinute - patient.arrivedAt,
            cardiacPathway: patient.cardiacPathway,
          },
        });
        ecgReviewedAt = run.currentMinute;
        events = appendEventToList(run, events, {
          type: "ecg_reviewed",
          patientId: patient.id,
          previousState: patient.state,
          newState: patient.state,
          message: `${patient.id} ECG was reviewed.`,
          details: {
            doorToEcgReviewMinutes: patient.arrivedAt === undefined ? undefined : run.currentMinute - patient.arrivedAt,
            cardiacPathway: patient.cardiacPathway,
          },
        });

        if (patient.cardiacPathway === "stemi_alert" && stemiAlertActivatedAt === undefined) {
          stemiAlertActivatedAt = run.currentMinute;
          events = appendEventToList(run, events, {
            type: "stemi_alert_activated",
            patientId: patient.id,
            previousState: patient.state,
            newState: patient.state,
            message: `${patient.id} STEMI-alert pathway was activated.`,
            details: {
              complaintCategory: patient.complaintCategory,
              esi: patient.esi,
              ecgToActivationMinutes: run.currentMinute - ecgCompletedAt,
            },
          });
        }
      }

      return { ...item, status: "ready" as const };
    });
    const allReady = pendingItems.filter(isDiagnosticPendingItem).every((item) => item.status !== "pending");

    if (!allReady) {
      return {
        ...patient,
        pendingItems,
        ecgCompletedAt,
        ecgReviewedAt,
        stemiAlertActivatedAt,
      };
    }

    const newState: PatientState = patient.state === "results_pending" ? "results_ready" : patient.state;

    events = appendEventToList(run, events, {
        type: "results_ready",
        patientId: patient.id,
        previousState: patient.state,
        newState,
        message: `${patient.id} results are ready.`,
      });

    return {
      ...patient,
      state: newState,
      pendingItems,
      ecgCompletedAt,
      ecgReviewedAt,
      stemiAlertActivatedAt,
      resultsReadyAt: run.currentMinute,
    };
  });

  return {
    ...run,
    patients,
    events,
  };
}

function admitPatient(run: SimulationRun, scenario: Scenario, patient: RuntimePatient): SimulationRun {
  if (!scenario.boardingProfile.enabled) {
    return departPatient(run, patient, "admit_inpatient");
  }

  const admissionReadyAt = run.currentMinute + patient.expectedAdmissionDecisionMinutes;
  const pendingItem = {
    type: "admission_decision" as const,
    orderedAt: run.currentMinute,
    readyAt: admissionReadyAt,
    status: "pending" as const,
  };

  return updatePatientState(
    run,
    patient.id,
    "admission_pending",
    {
      dispositionDecisionAt: run.currentMinute,
      dispositionType: "admit_inpatient" as const,
      pendingItems: [pendingItem],
    },
    "admission_requested",
    `${patient.id} admission requested; awaiting hospitalist consult/admission acceptance.`,
  );
}

function startBoarding(run: SimulationRun, patient: RuntimePatient): SimulationRun {
  const boardingReadyAt = run.currentMinute + patient.expectedBoardingMinutes;
  const pendingItem = {
    type: "boarding_bed" as const,
    orderedAt: run.currentMinute,
    readyAt: boardingReadyAt,
    status: "pending" as const,
  };

  let nextRun = updatePatientState(
    run,
    patient.id,
    "boarding",
    {
      admissionAcceptedAt: run.currentMinute,
      dispositionType: "admit_inpatient" as const,
      pendingItems: [pendingItem],
    },
    "patient_boarding_started",
    `${patient.id} hospitalist accepted admission, placed admission orders, requested inpatient bed, and boarding started.`,
  );

  nextRun = {
    ...nextRun,
    rooms: nextRun.rooms.map((room) =>
      room.patientId === patient.id
        ? { ...room, status: "blocked" as const }
        : room,
    ),
  };

  return nextRun;
}

function processAdmissionAcceptances(run: SimulationRun): SimulationRun {
  let nextRun = run;

  for (const patient of run.patients) {
    if (patient.state !== "admission_pending") {
      continue;
    }

    const admissionItem = patient.pendingItems.find((item) => item.type === "admission_decision");
    if (!admissionItem || admissionItem.readyAt > run.currentMinute) {
      continue;
    }

    nextRun = appendEvent(
      nextRun,
      {
        type: "admission_accepted",
        patientId: patient.id,
        previousState: "admission_pending",
        newState: "boarding",
        message: `${patient.id} admission was accepted by hospitalist.`,
        details: {
          admissionDecisionMinutes: run.currentMinute - (patient.dispositionDecisionAt ?? run.currentMinute),
        },
      },
    );
    nextRun = startBoarding(nextRun, patient);
  }

  return nextRun;
}

function processBoardingDepartures(run: SimulationRun): SimulationRun {
  let nextRun = run;

  for (const patient of run.patients) {
    if (patient.state !== "boarding") {
      continue;
    }

    const boardingItem = patient.pendingItems.find((item) => item.type === "boarding_bed");
    if (!boardingItem || boardingItem.readyAt > run.currentMinute) {
      continue;
    }

    nextRun = departPatient(nextRun, patient, "admit_inpatient");
  }

  return nextRun;
}

function departPatient(
  run: SimulationRun,
  patient: RuntimePatient,
  dispositionType: "discharge_home" | "admit_inpatient",
): SimulationRun {
  const nextRun = updatePatientState(
    run,
    patient.id,
    "departed",
    {
      dispositionDecisionAt: patient.dispositionDecisionAt ?? run.currentMinute,
      dispositionType,
      departedAt: run.currentMinute,
    },
    "patient_departed",
    dispositionType === "admit_inpatient"
      ? `${patient.id} inpatient bed assigned; patient departed the ED after boarding.`
      : `${patient.id} discharged home.`,
  );

  return releasePatientRoom(nextRun, patient.id);
}

function releasePatientRoom(run: SimulationRun, patientId: string): SimulationRun {
  const room = run.rooms.find((candidate) => candidate.patientId === patientId);
  if (!room) {
    return run;
  }

  const patient = run.patients.find((candidate) => candidate.id === patientId);
  const cleaningMinutes = Math.max(0, patient?.expectedRoomCleaningMinutes ?? run.timingProfile.roomCleaning.typical);
  if (cleaningMinutes === 0) {
    return appendEvent(
      {
        ...run,
        rooms: run.rooms.map((candidate) =>
          candidate.id === room.id
            ? {
                id: candidate.id,
                status: "available" as const,
              }
            : candidate,
        ),
      },
      {
        type: "room_available",
        message: `${room.id} is available.`,
        details: { roomId: room.id, previousPatientId: patientId },
      },
    );
  }

  return appendEvent(
    {
      ...run,
      rooms: run.rooms.map((candidate) =>
        candidate.id === room.id
          ? {
              id: candidate.id,
              previousPatientId: patientId,
              status: "cleaning" as const,
              cleaningStartedAt: run.currentMinute,
              cleaningReadyAt: run.currentMinute + cleaningMinutes,
            }
          : candidate,
      ),
    },
    {
      type: "room_cleaning_started",
      message: `${room.id} started room turnover cleaning.`,
      details: {
        roomId: room.id,
        previousPatientId: patientId,
        cleaningReadyAt: run.currentMinute + cleaningMinutes,
        cleaningMinutes,
      },
    },
  );
}

function processRoomCleaning(run: SimulationRun): SimulationRun {
  let events = run.events;
  let changed = false;

  const rooms = run.rooms.map((room) => {
    if (room.status !== "cleaning" || room.cleaningReadyAt === undefined || room.cleaningReadyAt > run.currentMinute) {
      return room;
    }

    changed = true;
    events = appendEventToList(run, events, {
      type: "room_available",
      message: `${room.id} is available after room turnover cleaning.`,
      details: {
        roomId: room.id,
        previousPatientId: room.previousPatientId,
        cleaningStartedAt: room.cleaningStartedAt,
        cleaningReadyAt: room.cleaningReadyAt,
        cleaningMinutes:
          room.cleaningStartedAt === undefined ? undefined : room.cleaningReadyAt - room.cleaningStartedAt,
      },
    });

    return {
      id: room.id,
      status: "available" as const,
    };
  });

  return changed
    ? {
        ...run,
        rooms,
        events,
      }
    : run;
}

function updateWaitingRisk(run: SimulationRun): SimulationRun {
  const workflowTimingProfile = run.workflowTimingProfile ?? defaultScenario.workflowTimingProfile;
  const patients = run.patients.map((patient) => {
    if ((patient.state !== "waiting" && patient.state !== "triage") || patient.arrivedAt === undefined) {
      return patient;
    }

    const wait = run.currentMinute - patient.arrivedAt;
    const riskLevel: RiskLevel =
      patient.cardiacPathway === "stemi_alert"
        ? "critical"
        : isSepsisWorkupPatient(patient) && wait >= workflowTimingProfile.sepsisCriticalWaitMinutes
          ? "critical"
        : patient.cardiacPathway === "possible_acs" && wait >= 30
          ? "high"
          : wait >= 90
            ? "critical"
            : wait >= 60
              ? "high"
              : wait >= 30
                ? "moderate"
                : "low";

    return {
      ...patient,
      riskLevel,
    };
  });

  return {
    ...run,
    patients,
  };
}

function escalatedRiskLevel(riskLevel: RiskLevel): RiskLevel {
  switch (riskLevel) {
    case "low":
      return "moderate";
    case "moderate":
      return "high";
    default:
      return "critical";
  }
}

function processWaitingRoomReassessmentAndDeterioration(run: SimulationRun): SimulationRun {
  const workflowTimingProfile = run.workflowTimingProfile ?? defaultScenario.workflowTimingProfile;
  let events = run.events;
  const patients = run.patients.map((patient) => {
    if (patient.state !== "waiting" || patient.arrivedAt === undefined) {
      return patient;
    }

    const nextDueAt = patient.nextReassessmentDueAt ?? nextReassessmentDueAt(patient, patient.triagedAt ?? patient.arrivedAt);
    const overdueMinutes = reassessmentOverdueMinutes({ nextReassessmentDueAt: nextDueAt }, run.currentMinute);

    if (patient.deterioratedAt !== undefined || overdueMinutes < workflowTimingProfile.deteriorationGraceMinutes) {
      return {
        ...patient,
        nextReassessmentDueAt: nextDueAt,
      };
    }

    const nextRiskLevel = escalatedRiskLevel(patient.riskLevel);
    const nextEsi = patient.esi > 2 ? ((patient.esi - 1) as RuntimePatient["esi"]) : patient.esi;

    events = appendEventToList(run, events, {
      type: "patient_deteriorated",
      patientId: patient.id,
      previousState: patient.state,
      newState: patient.state,
      message: `${patient.id} deteriorated while waiting and needs reassessment escalation.`,
      details: {
        overdueMinutes,
        previousEsi: patient.esi,
        newEsi: nextEsi,
        previousRiskLevel: patient.riskLevel,
        newRiskLevel: nextRiskLevel,
      },
    });

    return {
      ...patient,
      esi: nextEsi,
      riskLevel: nextRiskLevel,
      deterioratedAt: run.currentMinute,
      deteriorationCount: patient.deteriorationCount + 1,
      nextReassessmentDueAt: nextReassessmentDueAt({ ...patient, esi: nextEsi, riskLevel: nextRiskLevel }, run.currentMinute),
    };
  });

  return {
    ...run,
    patients,
    events,
  };
}

function patienceMultiplier(patient: RuntimePatient, scenario: Scenario): number {
  switch (patient.patienceProfile) {
    case "low":
      return scenario.lwbsProfile.lowPatienceMultiplier;
    case "high":
      return scenario.lwbsProfile.highPatienceMultiplier;
    default:
      return scenario.lwbsProfile.mediumPatienceMultiplier;
  }
}

function lwbsProbability(patient: RuntimePatient, scenario: Scenario, waitMinutes: number): number {
  const minutesBeyondThreshold = Math.max(0, waitMinutes - scenario.lwbsProfile.minimumWaitBeforeLWBS);
  const waitPressure = Math.min(0.18, minutesBeyondThreshold * 0.003);
  const acuityModifier = patient.esi <= 3 ? 0.6 : 1;
  const riskModifier = patient.riskLevel === "critical" ? 0.35 : patient.riskLevel === "high" ? 0.55 : 1;

  return Math.min(
    1,
    Math.max(0, (patient.lwbsBaseRisk + waitPressure) * patienceMultiplier(patient, scenario) * acuityModifier * riskModifier),
  );
}

function processLWBS(run: SimulationRun, scenario: Scenario): SimulationRun {
  if (!scenario.lwbsProfile.enabled) {
    return run;
  }

  let events = run.events;
  const patients = run.patients.map((patient) => {
    if (patient.state !== "waiting" || patient.arrivedAt === undefined) {
      return patient;
    }

    if (scenario.lwbsProfile.highAcuityBlockedEsiLevels.includes(patient.esi)) {
      return patient;
    }

    const waitMinutes = run.currentMinute - patient.arrivedAt;
    if (waitMinutes < scenario.lwbsProfile.minimumWaitBeforeLWBS) {
      return patient;
    }

    const probability = lwbsProbability(patient, scenario, waitMinutes);
    const random = createSeededRandom(`${scenario.randomSeed}:lwbs:${patient.id}:${run.currentMinute}`);
    if (random.next() >= probability) {
      return patient;
    }

    events = appendEventToList(run, events, {
      type: "patient_lwbs",
      patientId: patient.id,
      previousState: "waiting",
      newState: "lwbs",
      message: `${patient.id} left without being seen after ${waitMinutes} minutes waiting.`,
      details: {
        waitMinutes,
        esi: patient.esi,
        riskLevel: patient.riskLevel,
        patienceProfile: patient.patienceProfile,
        triageCompleted: patient.triagedAt !== undefined,
        hadPendingOrders: patient.pendingItems.length > 0,
        probability,
      },
    });

    return {
      ...patient,
      state: "lwbs" as const,
      lwbsAt: run.currentMinute,
      departedAt: run.currentMinute,
      dispositionType: "lwbs" as const,
    };
  });

  return {
    ...run,
    patients,
    events,
  };
}

function updatePatientState(
  run: SimulationRun,
  patientId: string,
  newState: PatientState,
  patch: Partial<RuntimePatient>,
  eventType: Parameters<typeof appendEvent>[1]["type"],
  message: string,
): SimulationRun {
  const patient = run.patients.find((candidate) => candidate.id === patientId);
  if (!patient) {
    return run;
  }

  const previousState = patient.state;
  const patients = run.patients.map((candidate) =>
    candidate.id === patientId
      ? {
          ...candidate,
          ...patch,
          state: newState,
        }
      : candidate,
  );

  return appendEvent(
    {
      ...run,
      patients,
    },
    {
      type: eventType,
      patientId,
      previousState,
      newState,
      message,
    },
  );
}

function withMetrics(run: SimulationRun): SimulationRun {
  return {
    ...run,
    metrics: calculateMetrics(run),
  };
}
