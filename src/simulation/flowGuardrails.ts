import { getAvailableProviderActions } from "./actionRules";
import type { FlowGuardrail, FlowGuardrailSummary, RuntimePatient, SimulationRun } from "./types";

function waitMinutes(patient: RuntimePatient, currentMinute: number): number {
  return patient.arrivedAt === undefined ? 0 : Math.max(0, currentMinute - patient.arrivedAt);
}

function addGuardrail(items: FlowGuardrail[], item: Omit<FlowGuardrail, "id">): void {
  items.push({
    ...item,
    id: `${item.severity}-${items.length + 1}`,
  });
}

function hasEnabledAction(run: SimulationRun, patient: RuntimePatient, actionType?: string): boolean {
  return getAvailableProviderActions(run, patient.id).some(
    (action) => action.enabled && action.type !== "continue_waiting" && (actionType === undefined || action.type === actionType),
  );
}

export function createFlowGuardrails(run: SimulationRun): FlowGuardrailSummary {
  const guardrails: FlowGuardrail[] = [];
  const idleProviderCount = run.providers.filter((provider) => provider.status === "idle").length;
  const actionablePatients = run.patients.filter((patient) => hasEnabledAction(run, patient));
  const roomedUnseenPatients = run.patients
    .filter(
      (patient) =>
        (patient.state === "roomed" || patient.state === "results_pending" || patient.state === "results_ready") &&
        patient.providerSeenAt === undefined,
    )
    .sort((left, right) => waitMinutes(right, run.currentMinute) - waitMinutes(left, run.currentMinute));
  const resultsReadySeenPatients = run.patients
    .filter((patient) => patient.state === "results_ready" && patient.providerSeenAt !== undefined)
    .sort((left, right) => (left.resultsReadyAt ?? 0) - (right.resultsReadyAt ?? 0));
  const dispositionReadyPatients = run.patients.filter((patient) => patient.state === "ready_for_disposition");
  const waitingHighRiskPatients = run.patients.filter(
    (patient) => patient.state === "waiting" && (patient.riskLevel === "high" || patient.riskLevel === "critical"),
  );

  if (idleProviderCount > 0 && actionablePatients.length > 0 && run.status === "running") {
    addGuardrail(guardrails, {
      severity: "urgent",
      title: "Idle provider with actionable flow work",
      message: "At least one ED provider is idle while patients have available flow actions.",
      metricValue: `${idleProviderCount} idle`,
    });
  }

  const delayedRoomedUnseen = roomedUnseenPatients.find((patient) => waitMinutes(patient, run.currentMinute) >= 15);
  if (delayedRoomedUnseen) {
    addGuardrail(guardrails, {
      severity: "urgent",
      title: "Roomed patient not yet seen",
      message: `${delayedRoomedUnseen.id} is roomed and still needs initial provider evaluation.`,
      metricValue: `${waitMinutes(delayedRoomedUnseen, run.currentMinute)} min`,
      patientId: delayedRoomedUnseen.id,
    });
  }

  const delayedResultsReady = resultsReadySeenPatients.find(
    (patient) => patient.resultsReadyAt !== undefined && run.currentMinute - patient.resultsReadyAt >= 10,
  );
  if (delayedResultsReady && hasEnabledAction(run, delayedResultsReady, "review_results")) {
    addGuardrail(guardrails, {
      severity: "watch",
      title: "Results ready for review",
      message: `${delayedResultsReady.id} has completed results and can move toward disposition.`,
      metricValue: `${run.currentMinute - (delayedResultsReady.resultsReadyAt ?? run.currentMinute)} min`,
      patientId: delayedResultsReady.id,
    });
  }

  if (dispositionReadyPatients.length > 0) {
    addGuardrail(guardrails, {
      severity: "urgent",
      title: "Disposition can release or define room status",
      message: "At least one roomed patient is ready for discharge or admit decision.",
      metricValue: String(dispositionReadyPatients.length),
      patientId: dispositionReadyPatients[0]?.id,
    });
  }

  if (run.metrics.availableRooms > 0 && waitingHighRiskPatients.length > 0) {
    addGuardrail(guardrails, {
      severity: "watch",
      title: "High-risk waiting patient with room capacity",
      message: "A high-risk waiting-room patient may be roomed while capacity is available.",
      metricValue: `${run.metrics.availableRooms} room(s)`,
      patientId: waitingHighRiskPatients[0]?.id,
    });
  }

  if (run.metrics.blockedRooms > 0 || run.metrics.totalBoardingMinutes >= 60) {
    addGuardrail(guardrails, {
      severity: "watch",
      title: "Boarding is consuming room capacity",
      message: "Boarding patients are operationally still occupying or blocking ED rooms.",
      metricValue: `${run.metrics.blockedRooms} blocked`,
    });
  }

  if (guardrails.length === 0) {
    addGuardrail(guardrails, {
      severity: "good",
      title: "No active flow guardrails",
      message: "No v1 flow thresholds are currently crossed.",
    });
  }

  const activeCount = guardrails.filter((item) => item.severity !== "good").length;

  return {
    headline: activeCount === 0 ? "Flow guardrails clear" : `${activeCount} flow guardrail${activeCount === 1 ? "" : "s"} active`,
    activeCount,
    guardrails: guardrails.slice(0, 6),
  };
}
