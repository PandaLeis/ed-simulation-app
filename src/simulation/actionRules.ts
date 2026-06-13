import type { ProviderActionOption, ProviderActionType, RuntimePatient, SimulationRun } from "./types";

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

function option(type: ProviderActionType, enabled: boolean, disabledReason?: string): ProviderActionOption {
  return {
    type,
    label: ACTION_LABELS[type],
    enabled,
    disabledReason,
    timeCostMinutes: DEFAULT_ACTION_COST_MINUTES[type],
  };
}

export function getAvailableProviderActions(
  run: SimulationRun,
  patientId?: string,
): ProviderActionOption[] {
  const providerBusy = run.provider.status === "busy";
  const patient = patientId ? run.patients.find((candidate) => candidate.id === patientId) : undefined;

  if (!patient) {
    return [option("continue_waiting", !providerBusy, providerBusy ? "Provider is busy" : undefined)];
  }

  if (providerBusy) {
    const completeTriageAction = option(
      "complete_triage",
      patient.state === "triage",
      patient.state === "triage" ? undefined : "Provider is busy",
    );
    const protocolAction = option(
      "start_protocol_orders",
      canStartProtocolOrders(run, patient),
      canStartProtocolOrders(run, patient) ? undefined : "Provider is busy",
    );
    return [completeTriageAction, protocolAction, option("continue_waiting", false, "Provider is busy")];
  }

  return actionsForPatient(run, patient);
}

function canStartProtocolOrders(run: SimulationRun, patient: RuntimePatient): boolean {
  const hasWorkup = patient.expectedLabMinutes > 0 || patient.expectedImagingMinutes > 0;
  return run.triageProviderEnabled && patient.state === "triage" && hasWorkup && patient.ordersPlacedAt === undefined;
}

function actionsForPatient(run: SimulationRun, patient: RuntimePatient): ProviderActionOption[] {
  const roomAvailable = run.rooms.some((room) => room.status === "available");
  const protocolOrdersAvailable = canStartProtocolOrders(run, patient);

  switch (patient.state) {
    case "triage":
      return [
        option("complete_triage", true),
        option(
          "start_protocol_orders",
          protocolOrdersAvailable,
          protocolOrdersAvailable ? undefined : "Protocol orders are unavailable",
        ),
        option("continue_waiting", true),
      ];
    case "waiting":
      return [
        option("room_patient", roomAvailable, roomAvailable ? undefined : "No ED room is available"),
        option("continue_waiting", true),
      ];
    case "roomed":
      return [option("see_patient", true), option("continue_waiting", true)];
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
      return [option("review_results", true), option("continue_waiting", true)];
    case "ready_for_disposition":
      return [option("discharge_home", true), option("admit_inpatient", true), option("continue_waiting", true)];
    default:
      return [option("continue_waiting", true)];
  }
}
