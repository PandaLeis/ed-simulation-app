import type { RuntimePatient, SimulationMetrics, SimulationRun } from "./types";

const terminalStates = new Set(["departed", "lwbs"]);

function average(values: number[]): number | null {
  if (values.length === 0) {
    return null;
  }

  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function boardingMinutes(patient: RuntimePatient, currentMinute: number): number {
  if (patient.dispositionType !== "admit_inpatient" || patient.dispositionDecisionAt === undefined) {
    return 0;
  }

  return (patient.departedAt ?? currentMinute) - patient.dispositionDecisionAt;
}

function currentWaitMinutes(patient: RuntimePatient, currentMinute: number): number {
  if (patient.arrivedAt === undefined || terminalStates.has(patient.state)) {
    return 0;
  }

  return currentMinute - patient.arrivedAt;
}

function waitingRoomStartMinute(patient: RuntimePatient): number | undefined {
  if (patient.triagedAt !== undefined) {
    return patient.triagedAt;
  }

  if (patient.arrivalPath !== "front_end_triage") {
    return patient.arrivedAt;
  }

  return undefined;
}

function waitingRoomEndMinute(patient: RuntimePatient, currentMinute: number): number | undefined {
  if (patient.roomedAt !== undefined) {
    return patient.roomedAt;
  }

  if (patient.lwbsAt !== undefined) {
    return patient.lwbsAt;
  }

  if (patient.departedAt !== undefined) {
    return patient.departedAt;
  }

  if (patient.state === "waiting") {
    return currentMinute;
  }

  return undefined;
}

function currentWaitingRoomWaitMinutes(patient: RuntimePatient, currentMinute: number): number {
  const waitingStart = waitingRoomStartMinute(patient);
  if (waitingStart === undefined || patient.state !== "waiting") {
    return 0;
  }

  return currentMinute - waitingStart;
}

function accumulatedWaitingRoomRiskMinutes(patient: RuntimePatient, currentMinute: number): number {
  const waitingStart = waitingRoomStartMinute(patient);
  const waitingEnd = waitingRoomEndMinute(patient, currentMinute);

  if (waitingStart === undefined || waitingEnd === undefined) {
    return 0;
  }

  return Math.max(0, waitingEnd - waitingStart - 30);
}

export function calculateMetrics(run: SimulationRun): SimulationMetrics {
  const arrived = run.patients.filter((patient) => patient.arrivedAt !== undefined);
  const seen = run.patients.filter((patient) => patient.providerSeenAt !== undefined);
  const dispositioned = run.patients.filter((patient) => patient.dispositionDecisionAt !== undefined);
  const departed = run.patients.filter((patient) => patient.departedAt !== undefined);
  const active = run.patients.filter(
    (patient) => patient.arrivedAt !== undefined && !terminalStates.has(patient.state),
  );
  const triageCensus = run.patients.filter((patient) => patient.state === "triage").length;
  const waitingPatients = run.patients.filter((patient) => patient.state === "waiting");
  const waitingRoomCensus = waitingPatients.length;
  const activePatientCensus = active.filter(
    (patient) => patient.state !== "waiting" && patient.state !== "triage",
  ).length;
  const boardingCensus = run.patients.filter((patient) => patient.state === "boarding").length;
  const waitingRoomWaits = waitingPatients.map((patient) => currentWaitingRoomWaitMinutes(patient, run.currentMinute));
  const moderateOrHigherRiskWaitingPatients = waitingPatients.filter(
    (patient) => patient.riskLevel === "moderate" || patient.riskLevel === "high" || patient.riskLevel === "critical",
  ).length;
  const highRiskWaitingPatients = waitingPatients.filter(
    (patient) => patient.riskLevel === "high" || patient.riskLevel === "critical",
  ).length;
  const criticalRiskWaitingPatients = waitingPatients.filter((patient) => patient.riskLevel === "critical").length;
  const waitingRoomRiskMinutes = run.patients.reduce(
    (sum, patient) => sum + accumulatedWaitingRoomRiskMinutes(patient, run.currentMinute),
    0,
  );
  const availableRooms = run.rooms.filter((room) => room.status === "available").length;
  const occupiedRooms = run.rooms.filter((room) => room.status === "occupied").length;
  const blockedRooms = run.rooms.filter((room) => room.status === "blocked").length;
  const elapsedHours = Math.max(1 / 60, (run.currentMinute - run.shiftStartMinute) / 60);
  const resultsReadyToDispositionValues = dispositioned
    .filter((patient) => patient.resultsReadyAt !== undefined)
    .map((patient) => (patient.dispositionDecisionAt ?? 0) - (patient.resultsReadyAt ?? 0));

  const nextMetrics: SimulationMetrics = {
    patientsArrived: arrived.length,
    patientsSeen: seen.length,
    patientsDispositioned: dispositioned.length,
    patientsDeparted: departed.length,
    triageCensus,
    waitingRoomCensus,
    averageWaitingRoomWaitMinutes: average(waitingRoomWaits),
    longestWaitingRoomWaitMinutes: Math.max(0, ...waitingRoomWaits),
    moderateOrHigherRiskWaitingPatients,
    highRiskWaitingPatients,
    criticalRiskWaitingPatients,
    waitingRoomRiskMinutes,
    activePatientCensus,
    boardingCensus,
    availableRooms,
    occupiedRooms,
    blockedRooms,
    longestCurrentWaitMinutes: Math.max(0, ...active.map((patient) => currentWaitMinutes(patient, run.currentMinute))),
    patientsSeenPerHour: seen.length / elapsedHours,
    averageDoorToProviderMinutes: average(
      seen.map((patient) => (patient.providerSeenAt ?? 0) - (patient.arrivedAt ?? 0)),
    ),
    averageTimeToDispositionMinutes: average(
      dispositioned.map((patient) => (patient.dispositionDecisionAt ?? 0) - (patient.arrivedAt ?? 0)),
    ),
    averageResultsReadyToDispositionMinutes: average(resultsReadyToDispositionValues),
    averageEDLengthOfStayMinutes: average(
      departed.map((patient) => (patient.departedAt ?? 0) - (patient.arrivedAt ?? 0)),
    ),
    totalBoardingMinutes: run.patients.reduce(
      (sum, patient) => sum + boardingMinutes(patient, run.currentMinute),
      0,
    ),
    providerBusyMinutes: run.provider.busyMinutes,
    providerIdleMinutes: run.provider.idleMinutes,
    peakWaitingRoomCensus: Math.max(run.metrics.peakWaitingRoomCensus, waitingRoomCensus),
    peakActivePatientCensus: Math.max(run.metrics.peakActivePatientCensus, activePatientCensus),
  };

  return nextMetrics;
}

export function emptyMetrics(): SimulationMetrics {
  return {
    patientsArrived: 0,
    patientsSeen: 0,
    patientsDispositioned: 0,
    patientsDeparted: 0,
    triageCensus: 0,
    waitingRoomCensus: 0,
    averageWaitingRoomWaitMinutes: null,
    longestWaitingRoomWaitMinutes: 0,
    moderateOrHigherRiskWaitingPatients: 0,
    highRiskWaitingPatients: 0,
    criticalRiskWaitingPatients: 0,
    waitingRoomRiskMinutes: 0,
    activePatientCensus: 0,
    boardingCensus: 0,
    availableRooms: 0,
    occupiedRooms: 0,
    blockedRooms: 0,
    longestCurrentWaitMinutes: 0,
    patientsSeenPerHour: 0,
    averageDoorToProviderMinutes: null,
    averageTimeToDispositionMinutes: null,
    averageResultsReadyToDispositionMinutes: null,
    averageEDLengthOfStayMinutes: null,
    totalBoardingMinutes: 0,
    providerBusyMinutes: 0,
    providerIdleMinutes: 0,
    peakWaitingRoomCensus: 0,
    peakActivePatientCensus: 0,
  };
}
