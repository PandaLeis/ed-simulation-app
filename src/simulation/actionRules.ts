import type { ProviderActionOption, ProviderActionType, ProviderState, RuntimePatient, SimulationRun } from "./types";
import { getProviderEvaluationTypicalMinutes } from "./providerEvaluation";
import { getTriageDurationMinutes } from "./triageDuration";
import { isCardiacWorkupPatient } from "./cardiacWorkflow";
import { isSepsisWorkupPatient } from "./sepsisWorkflow";
import { isReassessmentOverdue } from "./waitingRoomSafety";
import { hasAvailableSupportResources, supportResourceUnavailableReason } from "./supportResources";

export const DEFAULT_ACTION_COST_MINUTES: Record<ProviderActionType, number> = {
  complete_triage: 0,
  room_patient: 2,
  fast_track_patient: 1,
  reassess_waiting_patient: 3,
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
  fast_track_patient: "Move to Fast Track",
  reassess_waiting_patient: "Reassess waiting patient",
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

  const eligibleProvider = eligibleIdleProviderForPatient(run, patient);
  if (edProvidersBusy || !eligibleProvider) {
    const disabledReason = edProvidersBusy ? "ED provider is busy" : providerAssignmentUnavailableReason(run, patient);

    return actionsForPatient(run, patient).map((action) => ({
      ...action,
      enabled: false,
      disabledReason,
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

export function eligibleIdleProviderForPatient(run: SimulationRun, patient?: RuntimePatient): ProviderState | undefined {
  const idleProviders = run.providers.filter((provider) => provider.status === "idle");

  if (!patient || run.providerAssignmentMode === "team" || !patient.assignedProviderId) {
    return idleProviders[0];
  }

  const assignedProvider = idleProviders.find((provider) => provider.id === patient.assignedProviderId);
  if (assignedProvider) {
    return assignedProvider;
  }

  if (run.providerAssignmentMode === "assigned_with_handoff") {
    return idleProviders[0];
  }

  return undefined;
}

function providerAssignmentUnavailableReason(run: SimulationRun, patient: RuntimePatient): string {
  if (run.providerAssignmentMode === "assigned" && patient.assignedProviderId) {
    const assignedProvider = run.providers.find((provider) => provider.id === patient.assignedProviderId);
    return assignedProvider ? `${assignedProvider.displayName} owns this patient and is busy` : "Assigned provider is unavailable";
  }

  return "No eligible ED provider is available";
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
  const roomingSupportAvailable = hasAvailableSupportResources(run, "room_patient");
  const providerEvaluationTypicalMinutes = getProviderEvaluationTypicalMinutes(patient, run.timingProfile.providerEvaluation);
  const fastTrackEligible = run.fastTrackEnabled && isFastTrackEligible(patient);

  switch (patient.state) {
    case "waiting":
      return [
        option(
          "reassess_waiting_patient",
          isReassessmentOverdue(patient, run.currentMinute) && hasAvailableSupportResources(run, "reassess_waiting_patient"),
          isReassessmentOverdue(patient, run.currentMinute)
            ? supportResourceUnavailableReason(run, "reassess_waiting_patient")
            : "Reassessment is not due yet",
        ),
        option(
          "fast_track_patient",
          fastTrackEligible && hasAvailableSupportResources(run, "fast_track_patient"),
          run.fastTrackEnabled
            ? fastTrackEligible
              ? supportResourceUnavailableReason(run, "fast_track_patient")
              : "Patient is not eligible for Fast Track v1"
            : "Fast Track is disabled",
        ),
        option(
          "room_patient",
          roomAvailable && roomingSupportAvailable,
          roomAvailable ? supportResourceUnavailableReason(run, "room_patient") : "No ED room is available",
        ),
        option("continue_waiting", true),
      ];
    case "fast_track":
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

      return [
        option(
          "place_orders",
          hasAvailableSupportResources(run, "place_orders"),
          supportResourceUnavailableReason(run, "place_orders"),
        ),
        option("continue_waiting", true),
      ];
    case "results_ready":
      if (patient.providerSeenAt === undefined) {
        return [option("see_patient", true, undefined, providerEvaluationTypicalMinutes), option("continue_waiting", true)];
      }

      return [option("review_results", true), option("continue_waiting", true)];
    case "ready_for_disposition":
      return [
        option(
          "discharge_home",
          hasAvailableSupportResources(run, "discharge_home"),
          supportResourceUnavailableReason(run, "discharge_home"),
        ),
        option(
          "admit_inpatient",
          hasAvailableSupportResources(run, "admit_inpatient"),
          supportResourceUnavailableReason(run, "admit_inpatient"),
        ),
        option("continue_waiting", true),
      ];
    default:
      return [option("continue_waiting", true)];
  }
}

function isFastTrackEligible(patient: RuntimePatient): boolean {
  return (
    patient.esi >= 4 &&
    patient.providerSeenAt === undefined &&
    patient.dispositionDecisionAt === undefined &&
    !isCardiacWorkupPatient(patient) &&
    !isSepsisWorkupPatient(patient) &&
    (patient.workupType === "none" || patient.workupType === "basic_labs" || patient.workupType === "labs_imaging")
  );
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
      triageProviderAvailable && protocolOrdersAvailable && hasAvailableSupportResources(run, "start_protocol_orders"),
      triageProviderAvailable
        ? protocolOrdersAvailable
          ? supportResourceUnavailableReason(run, "start_protocol_orders")
          : "Protocol orders are unavailable"
        : unavailableReason,
    ),
    option("continue_waiting", true),
  ];
}
