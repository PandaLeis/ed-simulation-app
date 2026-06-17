import type { RuntimePatient, SimulationMetrics, SimulationRun } from "./types";

const terminalStates = new Set(["departed", "lwbs"]);

function average(values: number[]): number | null {
  if (values.length === 0) {
    return null;
  }

  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function percentile(values: number[], percentileValue: number): number | null {
  if (values.length === 0) {
    return null;
  }

  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.ceil((percentileValue / 100) * sorted.length) - 1;
  return sorted[Math.min(sorted.length - 1, Math.max(0, index))] ?? null;
}

function rate(numerator: number, denominator: number): number {
  return denominator === 0 ? 0 : numerator / denominator;
}

function firstItemTime(patient: RuntimePatient, itemType: RuntimePatient["pendingItems"][number]["type"]): number | undefined {
  const item = patient.pendingItems.find((candidate) => candidate.type === itemType && candidate.status !== "pending");
  return item?.completedAt ?? item?.readyAt;
}

function firstItemCollectedAt(patient: RuntimePatient, itemType: RuntimePatient["pendingItems"][number]["type"]): number | undefined {
  return patient.pendingItems.find((candidate) => candidate.type === itemType && candidate.collectedAt !== undefined)?.collectedAt;
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
  const lwbsPatients = run.patients.filter((patient) => patient.state === "lwbs");
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
  const lwbsWaits = lwbsPatients
    .filter((patient) => patient.arrivedAt !== undefined && patient.lwbsAt !== undefined)
    .map((patient) => (patient.lwbsAt ?? 0) - (patient.arrivedAt ?? 0));
  const waitingRoomRiskMinutes = run.patients.reduce(
    (sum, patient) => sum + accumulatedWaitingRoomRiskMinutes(patient, run.currentMinute),
    0,
  );
  const arrivedChestPainPatients = arrived.filter((patient) => patient.complaintCategory === "chest_pain");
  const arrivedSuspectedAcsPatients = arrived.filter((patient) => patient.complaintCategory === "suspected_acs");
  const arrivedCardiacPatients = arrived.filter((patient) => patient.cardiacPathway !== "none");
  const ecgDoorTimes = arrived
    .filter((patient) => patient.ecgCompletedAt !== undefined)
    .map((patient) => (patient.ecgCompletedAt ?? 0) - (patient.arrivedAt ?? 0));
  const ecgReviewDoorTimes = arrived
    .filter((patient) => patient.ecgReviewedAt !== undefined)
    .map((patient) => (patient.ecgReviewedAt ?? 0) - (patient.arrivedAt ?? 0));
  const firstTroponinItems = arrived
    .flatMap((patient) =>
      patient.pendingItems
        .filter((item) => item.type === "troponin" && item.collectedAt !== undefined)
        .map((item) => ({
          patient,
          item,
        })),
    );
  const doorToTroponinCollectionValues = firstTroponinItems
    .filter(({ patient }) => patient.arrivedAt !== undefined)
    .map(({ patient, item }) => (item.collectedAt ?? 0) - (patient.arrivedAt ?? 0));
  const troponinTurnaroundValues = firstTroponinItems.map(({ item }) => item.readyAt - (item.collectedAt ?? item.orderedAt));
  const ecgToStemiActivationValues = arrived
    .filter((patient) => patient.ecgCompletedAt !== undefined && patient.stemiAlertActivatedAt !== undefined)
    .map((patient) => (patient.stemiAlertActivatedAt ?? 0) - (patient.ecgCompletedAt ?? 0));
  const chestPainLWBSPatients = lwbsPatients.filter((patient) => patient.complaintCategory === "chest_pain");
  const suspectedAcsLWBSPatients = lwbsPatients.filter((patient) => patient.complaintCategory === "suspected_acs");
  const arrivedSepsisPatients = arrived.filter((patient) => patient.complaintCategory === "sepsis_concern");
  const sepsisPathwayPatients = arrivedSepsisPatients.filter((patient) => patient.sepsisRecognizedAt !== undefined);
  const sepsisRecognitionTimes = sepsisPathwayPatients.map(
    (patient) => (patient.sepsisRecognizedAt ?? 0) - (patient.arrivedAt ?? 0),
  );
  const sepsisLactateCollectionTimes = arrivedSepsisPatients
    .map((patient) => {
      const collectedAt = firstItemCollectedAt(patient, "lactate");
      return collectedAt === undefined ? undefined : collectedAt - (patient.arrivedAt ?? 0);
    })
    .filter((value): value is number => value !== undefined);
  const sepsisLactateResultTimes = arrivedSepsisPatients
    .map((patient) => {
      const completedAt = firstItemTime(patient, "lactate");
      return completedAt === undefined ? undefined : completedAt - (patient.arrivedAt ?? 0);
    })
    .filter((value): value is number => value !== undefined);
  const sepsisBloodCultureTimes = arrivedSepsisPatients
    .map((patient) => {
      const completedAt = firstItemTime(patient, "blood_cultures");
      return completedAt === undefined ? undefined : completedAt - (patient.arrivedAt ?? 0);
    })
    .filter((value): value is number => value !== undefined);
  const sepsisAntibioticTimes = arrivedSepsisPatients
    .map((patient) => {
      const completedAt = firstItemTime(patient, "antibiotics");
      return completedAt === undefined ? undefined : completedAt - (patient.arrivedAt ?? 0);
    })
    .filter((value): value is number => value !== undefined);
  const sepsisFluidTimes = arrivedSepsisPatients
    .map((patient) => {
      const completedAt = firstItemTime(patient, "iv_fluids");
      return completedAt === undefined ? undefined : completedAt - (patient.arrivedAt ?? 0);
    })
    .filter((value): value is number => value !== undefined);
  const sepsisLWBSPatients = lwbsPatients.filter((patient) => patient.complaintCategory === "sepsis_concern");
  const sepsisWaitingWithoutRoom = waitingPatients.filter((patient) => patient.complaintCategory === "sepsis_concern").length;
  const cardiacResultsReadyAwaitingReview = run.patients.filter(
    (patient) =>
      patient.cardiacPathway !== "none" &&
      patient.resultsReadyAt !== undefined &&
      patient.resultsReviewedAt === undefined &&
      patient.state === "results_ready",
  ).length;
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
    patientsLWBS: lwbsPatients.length,
    lwbsRate: arrived.length === 0 ? 0 : lwbsPatients.length / arrived.length,
    averageWaitBeforeLWBS: average(lwbsWaits),
    highRiskLWBS: lwbsPatients.filter(
      (patient) => patient.riskLevel === "high" || patient.riskLevel === "critical",
    ).length,
    lwbsWithOrdersPending: lwbsPatients.filter((patient) => patient.pendingItems.length > 0).length,
    triageCensus,
    waitingRoomCensus,
    averageWaitingRoomWaitMinutes: average(waitingRoomWaits),
    longestWaitingRoomWaitMinutes: Math.max(0, ...waitingRoomWaits),
    moderateOrHigherRiskWaitingPatients,
    highRiskWaitingPatients,
    criticalRiskWaitingPatients,
    waitingRoomRiskMinutes,
    chestPainPatientsArrived: arrivedChestPainPatients.length,
    suspectedAcsPatientsArrived: arrivedSuspectedAcsPatients.length,
    stemiAlertsActivated: run.patients.filter((patient) => patient.stemiAlertActivatedAt !== undefined).length,
    averageDoorToEcgMinutes: average(ecgDoorTimes),
    doorToEcgWithin10Rate: rate(ecgDoorTimes.filter((minutes) => minutes <= 10).length, arrivedCardiacPatients.length),
    medianDoorToEcgMinutes: percentile(ecgDoorTimes, 50),
    p90DoorToEcgMinutes: percentile(ecgDoorTimes, 90),
    ecgReviewedWithin10Rate: rate(
      ecgReviewDoorTimes.filter((minutes) => minutes <= 10).length,
      arrivedCardiacPatients.length,
    ),
    averageDoorToTroponinCollectionMinutes: average(doorToTroponinCollectionValues),
    averageTroponinTurnaroundMinutes: average(troponinTurnaroundValues),
    averageEcgToStemiActivationMinutes: average(ecgToStemiActivationValues),
    delayedEcgCount: run.patients.filter(
      (patient) =>
        patient.cardiacPathway !== "none" &&
        patient.arrivedAt !== undefined &&
        ((patient.ecgCompletedAt ?? run.currentMinute) - patient.arrivedAt) > 10,
    ).length,
    cardiacResultsReadyAwaitingReview,
    chestPainLWBS: chestPainLWBSPatients.length,
    chestPainLWBSRate: rate(chestPainLWBSPatients.length, arrivedChestPainPatients.length),
    suspectedAcsLWBS: suspectedAcsLWBSPatients.length,
    suspectedAcsLWBSRate: rate(suspectedAcsLWBSPatients.length, arrivedSuspectedAcsPatients.length),
    sepsisPatientsArrived: arrivedSepsisPatients.length,
    sepsisPathwayStarted: sepsisPathwayPatients.length,
    sepsisRecognitionWithin10Rate: rate(
      sepsisRecognitionTimes.filter((minutes) => minutes <= 10).length,
      arrivedSepsisPatients.length,
    ),
    averageDoorToSepsisRecognitionMinutes: average(sepsisRecognitionTimes),
    averageDoorToLactateCollectionMinutes: average(sepsisLactateCollectionTimes),
    averageDoorToLactateResultMinutes: average(sepsisLactateResultTimes),
    averageDoorToBloodCulturesMinutes: average(sepsisBloodCultureTimes),
    averageDoorToAntibioticsMinutes: average(sepsisAntibioticTimes),
    sepsisAntibioticsWithin60Rate: rate(
      sepsisAntibioticTimes.filter((minutes) => minutes <= 60).length,
      arrivedSepsisPatients.length,
    ),
    medianDoorToAntibioticsMinutes: percentile(sepsisAntibioticTimes, 50),
    p90DoorToAntibioticsMinutes: percentile(sepsisAntibioticTimes, 90),
    averageDoorToFluidsMinutes: average(sepsisFluidTimes),
    sepsisWaitingWithoutRoom,
    sepsisLWBS: sepsisLWBSPatients.length,
    sepsisLWBSRate: rate(sepsisLWBSPatients.length, arrivedSepsisPatients.length),
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
    providerBusyMinutes: run.providers.reduce((sum, provider) => sum + provider.busyMinutes, 0),
    providerIdleMinutes: run.providers.reduce((sum, provider) => sum + provider.idleMinutes, 0),
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
    patientsLWBS: 0,
    lwbsRate: 0,
    averageWaitBeforeLWBS: null,
    highRiskLWBS: 0,
    lwbsWithOrdersPending: 0,
    triageCensus: 0,
    waitingRoomCensus: 0,
    averageWaitingRoomWaitMinutes: null,
    longestWaitingRoomWaitMinutes: 0,
    moderateOrHigherRiskWaitingPatients: 0,
    highRiskWaitingPatients: 0,
    criticalRiskWaitingPatients: 0,
    waitingRoomRiskMinutes: 0,
    chestPainPatientsArrived: 0,
    suspectedAcsPatientsArrived: 0,
    stemiAlertsActivated: 0,
    averageDoorToEcgMinutes: null,
    doorToEcgWithin10Rate: 0,
    medianDoorToEcgMinutes: null,
    p90DoorToEcgMinutes: null,
    ecgReviewedWithin10Rate: 0,
    averageDoorToTroponinCollectionMinutes: null,
    averageTroponinTurnaroundMinutes: null,
    averageEcgToStemiActivationMinutes: null,
    delayedEcgCount: 0,
    cardiacResultsReadyAwaitingReview: 0,
    chestPainLWBS: 0,
    chestPainLWBSRate: 0,
    suspectedAcsLWBS: 0,
    suspectedAcsLWBSRate: 0,
    sepsisPatientsArrived: 0,
    sepsisPathwayStarted: 0,
    sepsisRecognitionWithin10Rate: 0,
    averageDoorToSepsisRecognitionMinutes: null,
    averageDoorToLactateCollectionMinutes: null,
    averageDoorToLactateResultMinutes: null,
    averageDoorToBloodCulturesMinutes: null,
    averageDoorToAntibioticsMinutes: null,
    sepsisAntibioticsWithin60Rate: 0,
    medianDoorToAntibioticsMinutes: null,
    p90DoorToAntibioticsMinutes: null,
    averageDoorToFluidsMinutes: null,
    sepsisWaitingWithoutRoom: 0,
    sepsisLWBS: 0,
    sepsisLWBSRate: 0,
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
