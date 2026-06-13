import { ACTION_LABELS, DEFAULT_ACTION_COST_MINUTES, getAvailableProviderActions } from "./actionRules";
import { createRuntimePatients } from "./arrivalGenerator";
import { appendEvent, appendEventToList, createEvent } from "./eventLogger";
import { calculateMetrics, emptyMetrics } from "./metricsEngine";
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
} from "./types";

function createRunId(scenario: Scenario): string {
  const randomId = globalThis.crypto?.randomUUID?.() ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  return `run-${scenario.id}-${randomId}`;
}

function createProviderDecision(
  run: SimulationRun,
  actionType: ProviderActionType,
  patientId?: string,
): ProviderDecision {
  const patient = patientId ? run.patients.find((candidate) => candidate.id === patientId) : undefined;

  return {
    id: `${run.id}-decision-${String(run.decisions.length + 1).padStart(6, "0")}`,
    runId: run.id,
    simulationMinute: run.currentMinute,
    patientId,
    actionType,
    actionLabel: ACTION_LABELS[actionType],
    timeCostMinutes: DEFAULT_ACTION_COST_MINUTES[actionType],
    previousState: patient?.state,
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

  const run: SimulationRun = {
    id: createRunId(scenario),
    scenarioId: scenario.id,
    triageProviderEnabled: scenario.triageProviderEnabled,
    runType: "original",
    shiftStartMinute: scenario.shiftStartMinute,
    currentMinute: scenario.shiftStartMinute,
    startedAt: new Date().toISOString(),
    status: "not_started",
    patients: createRuntimePatients(deck),
    rooms,
    provider: {
      id: "provider-001",
      displayName: "Single Provider",
      status: "idle",
      busyMinutes: 0,
      idleMinutes: 0,
    },
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
  if (run.triageProviderEnabled === enabled) {
    return run;
  }

  let events = run.events;
  const patients = run.patients.map((patient) => {
    if (enabled || patient.state !== "triage") {
      return patient;
    }

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
    };
  });

  return withMetrics({
    ...run,
    triageProviderEnabled: enabled,
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
  nextRun = processArrivals(nextRun);
  nextRun = processProviderCompletion(nextRun, scenario);
  nextRun = processPendingItems(nextRun);
  nextRun = processBoardingDepartures(nextRun);
  nextRun = updateWaitingRisk(nextRun);

  if (nextRun.currentMinute >= scenario.shiftStartMinute + scenario.shiftDurationMinutes) {
    nextRun = appendEvent(
      {
        ...nextRun,
        status: "shift_ended",
        endedAt: new Date().toISOString(),
      },
      {
        type: "shift_ended",
        message: "Provider shift ended.",
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
  if (run.status !== "running" || (run.provider.status === "busy" && !triageProviderAction)) {
    return run;
  }

  const matchingAction = getAvailableProviderActions(run, patientId).find((action) => action.type === actionType);
  if (!matchingAction?.enabled) {
    return run;
  }

  const patient = patientId ? run.patients.find((candidate) => candidate.id === patientId) : undefined;
  const decision = createProviderDecision(run, actionType, patientId);

  if (actionType === "continue_waiting") {
    return {
      ...run,
      decisions: [...run.decisions, { ...decision, resultingState: decision.previousState }],
    };
  }

  if (actionType === "start_protocol_orders" || actionType === "complete_triage") {
    const triageRun =
      actionType === "start_protocol_orders"
        ? startProtocolOrders(run, patientId)
        : completeTriage(run, patient as RuntimePatient);

    return withMetrics({
      ...triageRun,
      decisions: [...run.decisions, { ...decision, resultingState: patientState(triageRun, patientId) }],
    });
  }

  return {
    ...run,
    provider: {
      ...run.provider,
      status: "busy",
      busyUntilMinute: run.currentMinute + decision.timeCostMinutes,
      currentAction: {
        type: actionType,
        patientId,
        decisionId: decision.id,
        startedAt: run.currentMinute,
        completedAt: run.currentMinute + decision.timeCostMinutes,
      },
    },
    decisions: [...run.decisions, decision],
  };
}

function accrueProviderTime(run: SimulationRun): SimulationRun {
  if (run.provider.status === "busy") {
    return {
      ...run,
      provider: {
        ...run.provider,
        busyMinutes: run.provider.busyMinutes + 1,
      },
    };
  }

  return {
    ...run,
    provider: {
      ...run.provider,
      idleMinutes: run.provider.idleMinutes + 1,
    },
  };
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

function processProviderCompletion(run: SimulationRun, scenario: Scenario): SimulationRun {
  const action = run.provider.currentAction;
  if (!action || action.completedAt > run.currentMinute) {
    return run;
  }

  let nextRun: SimulationRun = {
    ...run,
    provider: {
      ...run.provider,
      status: "idle",
      busyUntilMinute: undefined,
      currentAction: undefined,
    },
  };

  nextRun = completeProviderAction(nextRun, scenario, action.type, action.patientId);
  nextRun = setDecisionResult(nextRun, action.decisionId, patientState(nextRun, action.patientId));
  return withMetrics(nextRun);
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
  const hasDiagnosticOrders = patient.pendingItems.some((item) => item.type === "labs" || item.type === "imaging");
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

function completeTriage(run: SimulationRun, patient: RuntimePatient): SimulationRun {
  return updatePatientState(
    run,
    patient.id,
    "waiting",
    {
      triagedAt: run.currentMinute,
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
    "roomed",
    {
      roomId: room.id,
      roomedAt: run.currentMinute,
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
  const pendingItems = [];

  if (patient.expectedLabMinutes > 0) {
    pendingItems.push({
      type: "labs" as const,
      orderedAt: run.currentMinute,
      readyAt: run.currentMinute + patient.expectedLabMinutes,
      status: "pending" as const,
    });
  }

  if (patient.expectedImagingMinutes > 0) {
    pendingItems.push({
      type: "imaging" as const,
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

  return updatePatientState(
    run,
    patient.id,
    nextState,
    {
      ordersPlacedAt: run.currentMinute,
      pendingItems,
      resultsReadyAt: pendingItems.length === 0 ? run.currentMinute : undefined,
    },
    "orders_placed",
    options.message ?? `${patient.id} orders were placed.`,
  );
}

function processPendingItems(run: SimulationRun): SimulationRun {
  let events = run.events;
  const patients = run.patients.map((patient) => {
    const diagnosticItems = patient.pendingItems.filter((item) => item.type === "labs" || item.type === "imaging");
    if (diagnosticItems.length === 0 || patient.resultsReadyAt !== undefined) {
      return patient;
    }

    const pendingItems = patient.pendingItems.map((item) =>
      (item.type === "labs" || item.type === "imaging") && item.status === "pending" && item.readyAt <= run.currentMinute
        ? { ...item, status: "ready" as const }
        : item,
    );
    const allReady = pendingItems
      .filter((item) => item.type === "labs" || item.type === "imaging")
      .every((item) => item.status !== "pending");

    if (!allReady) {
      return {
        ...patient,
        pendingItems,
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
    scenario.boardingProfile.enabled ? "boarding" : "departed",
    {
      dispositionDecisionAt: run.currentMinute,
      dispositionType: "admit_inpatient" as const,
      pendingItems: scenario.boardingProfile.enabled ? [pendingItem] : [],
      departedAt: scenario.boardingProfile.enabled ? undefined : run.currentMinute,
    },
    scenario.boardingProfile.enabled ? "patient_boarding_started" : "patient_departed",
    scenario.boardingProfile.enabled
      ? `${patient.id} admitted and boarding.`
      : `${patient.id} admitted and departed ED.`,
  );

  nextRun = {
    ...nextRun,
    rooms: nextRun.rooms.map((room) =>
      room.patientId === patient.id && scenario.boardingProfile.enabled
        ? { ...room, status: "blocked" as const }
        : room,
    ),
  };

  if (!scenario.boardingProfile.enabled) {
    nextRun = releasePatientRoom(nextRun, patient.id);
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
      ? `${patient.id} departed the ED after boarding.`
      : `${patient.id} discharged home.`,
  );

  return releasePatientRoom(nextRun, patient.id);
}

function releasePatientRoom(run: SimulationRun, patientId: string): SimulationRun {
  const room = run.rooms.find((candidate) => candidate.patientId === patientId);
  const rooms = run.rooms.map((candidate) =>
    candidate.patientId === patientId
      ? { id: candidate.id, status: "available" as const, patientId: undefined }
      : candidate,
  );

  if (!room) {
    return {
      ...run,
      rooms,
    };
  }

  return appendEvent(
    {
      ...run,
      rooms,
    },
    {
      type: "room_available",
      message: `${room.id} is available.`,
      details: { roomId: room.id },
    },
  );
}

function updateWaitingRisk(run: SimulationRun): SimulationRun {
  const patients = run.patients.map((patient) => {
    if ((patient.state !== "waiting" && patient.state !== "triage") || patient.arrivedAt === undefined) {
      return patient;
    }

    const wait = run.currentMinute - patient.arrivedAt;
    const riskLevel: RiskLevel = wait >= 90 ? "critical" : wait >= 60 ? "high" : wait >= 30 ? "moderate" : "low";

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
