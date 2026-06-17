import type { DebriefFeedbackItem, PatientTimelineIssue, ProviderDebrief, RuntimePatient, SimulationRun } from "./types";

function formatNumber(value: number | null): string {
  return value === null ? "-" : value.toFixed(0);
}

function percent(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

function addItem(
  items: DebriefFeedbackItem[],
  item: Omit<DebriefFeedbackItem, "id">,
): void {
  items.push({
    ...item,
    id: `${item.kind}-${items.length + 1}`,
  });
}

function resultsReadyToDispositionMinutes(patient: RuntimePatient): number | undefined {
  if (patient.resultsReadyAt === undefined || patient.dispositionDecisionAt === undefined) {
    return undefined;
  }

  return patient.dispositionDecisionAt - patient.resultsReadyAt;
}

function doorToProviderMinutes(patient: RuntimePatient): number | undefined {
  if (patient.arrivedAt === undefined || patient.providerSeenAt === undefined) {
    return undefined;
  }

  return patient.providerSeenAt - patient.arrivedAt;
}

function waitBeforeLWBS(patient: RuntimePatient): number | undefined {
  if (patient.arrivedAt === undefined || patient.lwbsAt === undefined) {
    return undefined;
  }

  return patient.lwbsAt - patient.arrivedAt;
}

function notablePatientTimelines(run: SimulationRun): PatientTimelineIssue[] {
  const issues: PatientTimelineIssue[] = [];

  for (const patient of run.patients) {
    const doorToProvider = doorToProviderMinutes(patient);
    if (doorToProvider !== undefined && doorToProvider >= 60) {
      issues.push({
        patientId: patient.id,
        label: "Long door-to-provider",
        detail: `${patient.id} waited ${doorToProvider} minutes before provider evaluation.`,
        minutes: doorToProvider,
      });
    }

    const resultsDelay = resultsReadyToDispositionMinutes(patient);
    if (resultsDelay !== undefined && resultsDelay >= 30) {
      issues.push({
        patientId: patient.id,
        label: "Results-ready delay",
        detail: `${patient.id} had results ready for ${resultsDelay} minutes before disposition.`,
        minutes: resultsDelay,
      });
    }

    const lwbsWait = waitBeforeLWBS(patient);
    if (lwbsWait !== undefined) {
      issues.push({
        patientId: patient.id,
        label: "LWBS",
        detail: `${patient.id} left without being seen after ${lwbsWait} minutes.`,
        minutes: lwbsWait,
      });
    }
  }

  return issues.sort((left, right) => (right.minutes ?? 0) - (left.minutes ?? 0)).slice(0, 5);
}

export function createProviderDebrief(run: SimulationRun): ProviderDebrief {
  const bottlenecks: DebriefFeedbackItem[] = [];
  const decisionFeedback: DebriefFeedbackItem[] = [];
  const roomingDecisions = run.decisions.filter((decision) => decision.actionType === "room_patient").length;
  const providerSeeDecisions = run.decisions.filter((decision) => decision.actionType === "see_patient").length;
  const protocolDecisions = run.decisions.filter((decision) => decision.actionType === "start_protocol_orders").length;
  const reviewResultsDecisions = run.decisions.filter((decision) => decision.actionType === "review_results").length;
  const dispositionDecisions = run.decisions.filter(
    (decision) => decision.actionType === "discharge_home" || decision.actionType === "admit_inpatient",
  ).length;

  if (run.metrics.patientsLWBS > 0) {
    addItem(bottlenecks, {
      kind: "opportunity",
      title: "LWBS occurred",
      message: `${run.metrics.patientsLWBS} patient(s) left before being seen. Review waiting-room pressure and rooming timing.`,
      metricValue: percent(run.metrics.lwbsRate),
    });
  }

  if (run.metrics.waitingRoomRiskMinutes >= 60) {
    addItem(bottlenecks, {
      kind: "watch",
      title: "Waiting-room risk exposure",
      message: "Patients accumulated extended waiting-room risk minutes during this run.",
      metricValue: `${run.metrics.waitingRoomRiskMinutes} min`,
    });
  }

  if ((run.metrics.averageDoorToProviderMinutes ?? 0) >= 45) {
    addItem(bottlenecks, {
      kind: "opportunity",
      title: "Door-to-provider delay",
      message: "Average door-to-provider time suggests delayed transition from waiting room to provider evaluation.",
      metricValue: `${formatNumber(run.metrics.averageDoorToProviderMinutes)} min`,
    });
  }

  if ((run.metrics.averageResultsReadyToDispositionMinutes ?? 0) >= 25) {
    addItem(bottlenecks, {
      kind: "opportunity",
      title: "Results-ready dwell",
      message: "Completed results waited before disposition decisions. Earlier review may improve throughput.",
      metricValue: `${formatNumber(run.metrics.averageResultsReadyToDispositionMinutes)} min`,
    });
  }

  if (run.metrics.blockedRooms > 0 || run.metrics.totalBoardingMinutes >= 60) {
    addItem(bottlenecks, {
      kind: "watch",
      title: "Boarding pressure",
      message: "Boarding consumed room capacity and may have slowed new rooming decisions.",
      metricValue: `${run.metrics.totalBoardingMinutes} min`,
    });
  }

  if (roomingDecisions > 0) {
    addItem(decisionFeedback, {
      kind: "positive",
      title: "Rooming decisions made",
      message: `${roomingDecisions} rooming decision(s) moved patients from waiting into active care.`,
      metricValue: String(roomingDecisions),
    });
  }

  if (protocolDecisions > 0) {
    addItem(decisionFeedback, {
      kind: "positive",
      title: "Protocol orders used",
      message: `${protocolDecisions} front-end protocol order decision(s) started workups before room placement.`,
      metricValue: String(protocolDecisions),
    });
  }

  if (providerSeeDecisions > 0 && reviewResultsDecisions === 0 && run.patients.some((patient) => patient.state === "results_ready")) {
    addItem(decisionFeedback, {
      kind: "opportunity",
      title: "Results awaiting review",
      message: "At least one patient had results ready without a review decision yet.",
      metricValue: String(run.patients.filter((patient) => patient.state === "results_ready").length),
    });
  }

  if (dispositionDecisions > 0) {
    addItem(decisionFeedback, {
      kind: "positive",
      title: "Disposition decisions completed",
      message: `${dispositionDecisions} disposition decision(s) created room turnover or boarding flow.`,
      metricValue: String(dispositionDecisions),
    });
  }

  if (bottlenecks.length === 0) {
    addItem(bottlenecks, {
      kind: "positive",
      title: "No major bottleneck flagged",
      message: "Current run metrics have not crossed the v1 operational delay thresholds.",
    });
  }

  if (decisionFeedback.length === 0) {
    addItem(decisionFeedback, {
      kind: "watch",
      title: "No provider decisions yet",
      message: "Start the run and act on patients to generate decision feedback.",
    });
  }

  return {
    headline: `${run.metrics.patientsSeen} seen, ${run.metrics.patientsDeparted} departed, ${run.metrics.patientsLWBS} LWBS`,
    summary: [
      { label: "Door-to-provider", value: `${formatNumber(run.metrics.averageDoorToProviderMinutes)} min` },
      { label: "Seen / hour", value: run.metrics.patientsSeenPerHour.toFixed(1) },
      { label: "LWBS", value: `${run.metrics.patientsLWBS} (${percent(run.metrics.lwbsRate)})` },
      { label: "Risk minutes", value: `${run.metrics.waitingRoomRiskMinutes} min` },
      { label: "Results to disposition", value: `${formatNumber(run.metrics.averageResultsReadyToDispositionMinutes)} min` },
      { label: "Boarding minutes", value: `${run.metrics.totalBoardingMinutes} min` },
    ],
    bottlenecks: bottlenecks.slice(0, 3),
    decisionFeedback: decisionFeedback.slice(0, 4),
    notablePatients: notablePatientTimelines(run),
  };
}
