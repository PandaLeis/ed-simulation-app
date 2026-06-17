import type { ProviderActionOption, ProviderActionType, RuntimePatient, SimulationRun } from "./types";
import { getProviderEvaluationTypicalMinutes } from "./providerEvaluation";
import { getTriageDurationMinutes } from "./triageDuration";

export const DEFAULT_ACTION_COST_MINUTES: Record<ProviderActionType, number> = {
  complete_triage: 0,
  room_patient: 2,
  start_protocol_orders: 0,
  see_patient: 12,
  place_orders: 4,
  review_results: 5,
  discharge_home: 8,
  admit_inpatient: 8,
  continue_waiting: 0,
};

export const ACTION_LABELS: Record<ProviderActionType, string> = {
  complete_triage: "Send to waiting room",
  room_patient: "Room patient",
  start_protocol_orders: "Start protocol orders",
  see_patient: "See patient",
  place_orders: "Place orders",
  review_results: "Review results",
  discharge_home: "Discharge home",
  admit_inpatient: "Admit inpatient",
  continue_waiting: "Continue waiting",
};

function option(
  type: ProviderActionType,
  enabled: boolean,
  disabledReason?: string,
  timeCostMinutes = DEFAULT_ACTION_COST_MINUTES[type],
): ProviderActionOption {
  return {
    type,
    label: ACTION_LABELS[type],
    enabled,
    disabledReason,
    timeCostMinutes,
  };
}

export function getAvailableProviderActions(
  run: SimulationRun,
  patientId?: string,
): ProviderActionOption[] {
  const edProvidersBusy = run.providers.every((provider) => provider.status === "busy");
  const patient = patientId ? run.patients.find((candidate) => candidate.id === patientId) : undefined;
  const activePatientProvider = patientId
    ? run.providers.find((provider) => provider.status === "busy" && provider.currentAction?.patientId === patientId)
    : undefined;

  if (!patient) {
    return [option("continue_waiting", !edProvidersBusy, edProvidersBusy ? "ED provider is busy" : undefined)];
  }

  if (patient.state === "triage") {
    return triageActionsForPatient(run, patient);
  }

  if (edProvidersBusy) {
    return actionsForPatient(run, patient).map((action) => ({
      ...action,
      enabled: false,
      disabledReason: "ED provider is busy",
    }));
  }

  if (activePatientProvider) {
    return actionsForPatient(run, patient).map((action) => ({
      ...action,
      enabled: action.type === "continue_waiting",
      disabledReason:
        action.type === "continue_waiting"
          ? action.disabledReason
          : `${activePatientProvider.displayName} is already working with this patient`,
    }));
  }

  return actionsForPatient(run, patient);
}

function canStartProtocolOrders(run: SimulationRun, patient: RuntimePatient): boolean {
  const hasWorkup = patient.expectedLabMinutes > 0 || patient.expectedImagingMinutes > 0 || patient.cardiacPathway !== "none";
  return (
    run.triageProviderEnabled &&
    run.triageProviderMode !== "automated" &&
    patient.state === "triage" &&
    hasWorkup &&
    patient.ordersPlacedAt === undefined
  );
}

function actionsForPatient(run: SimulationRun, patient: RuntimePatient): ProviderActionOption[] {
  const pendingRoomAssignments = run.providers.filter((provider) => provider.currentAction?.type === "room_patient").length;
  const availableRoomCount = run.rooms.filter((room) => room.status === "available").length;
  const roomAvailable = availableRoomCount - pendingRoomAssignments > 0;
  const providerEvaluationTypicalMinutes = getProviderEvaluationTypicalMinutes(patient, run.timingProfile.providerEvaluation);

  switch (patient.state) {
    case "waiting":
      return [
        option("room_patient", roomAvailable, roomAvailable ? undefined : "No ED room is available"),
        option("continue_waiting", true),
      ];
    case "roomed":
      return [option("see_patient", true, undefined, providerEvaluationTypicalMinutes), option("continue_waiting", true)];
    case "results_pending":
      if (patient.providerSeenAt === undefined) {
        return [option("see_patient", true, undefined, providerEvaluationTypicalMinutes), option("continue_waiting", true)];
      }

      return [option("continue_waiting", true)];
    case "provider_seen":
      if (patient.ordersPlacedAt !== undefined) {
        return [
          option(
            "review_results",
            patient.resultsReadyAt !== undefined,
            patient.resultsReadyAt === undefined ? "Results are not ready" : undefined,
          ),
          option("continue_waiting", true),
        ];
      }

      return [option("place_orders", true), option("continue_waiting", true)];
    case "results_ready":
      if (patient.providerSeenAt === undefined) {
        return [option("see_patient", true, undefined, providerEvaluationTypicalMinutes), option("continue_waiting", true)];
      }

      return [option("review_results", true), option("continue_waiting", true)];
    case "ready_for_disposition":
      return [option("discharge_home", true), option("admit_inpatient", true), option("continue_waiting", true)];
    default:
      return [option("continue_waiting", true)];
  }
}

function triageActionsForPatient(run: SimulationRun, patient: RuntimePatient): ProviderActionOption[] {
  const protocolOrdersAvailable = canStartProtocolOrders(run, patient);
  const automated = run.triageProviderMode === "automated";
  const triageProviderAvailable = run.triageProviderEnabled && !automated && run.triageProvider.status === "idle";
  const triageDuration = getTriageDurationMinutes(
    patient,
    run.triageDurationProfile,
    run.triageDurationMultiplier,
  );
  const unavailableReason = automated
    ? "Front-End Triage Provider is automated"
    : run.triageProviderEnabled
    ? "Front-End Triage Provider is busy"
    : "Front-End Triage Provider is unavailable";

  return [
    option("complete_triage", triageProviderAvailable, triageProviderAvailable ? undefined : unavailableReason, triageDuration),
    option(
      "start_protocol_orders",
      triageProviderAvailable && protocolOrdersAvailable,
      triageProviderAvailable
        ? protocolOrdersAvailable
          ? undefined
          : "Protocol orders are unavailable"
        : unavailableReason,
    ),
    option("continue_waiting", true),
  ];
}
