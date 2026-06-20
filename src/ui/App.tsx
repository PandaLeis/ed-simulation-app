import { type ChangeEvent, type CSSProperties, useEffect, useMemo, useRef, useState } from "react";
import {
  Activity,
  Ambulance,
  Bed,
  BedDouble,
  BrushCleaning,
  CalendarClock,
  CircleOff,
  CircleAlert,
  CircleGauge,
  ClipboardCheck,
  Clock,
  DoorOpen,
  Droplets,
  Gauge,
  HeartPulse,
  Hourglass,
  Pause,
  Play,
  RotateCcw,
  Siren,
  Sparkles,
  Stethoscope,
  StepForward,
  Syringe,
  TestTube,
  TestTubes,
  TimerReset,
  TrendingUp,
  UserCheck,
  UserRoundCheck,
  UserRoundCog,
  Users,
} from "lucide-react";

import { ACTION_LABELS, getAvailableProviderActions } from "../simulation/actionRules";
import { activityRunsToCsv, activityTimelineToCsv, createActivityTimeline } from "../simulation/activityTimeline";
import type { ActivityCsvRun } from "../simulation/activityTimeline";
import { generatePatientDeck } from "../simulation/arrivalGenerator";
import { createFlowGuardrails } from "../simulation/flowGuardrails";
import { calculateMetrics, emptyMetrics } from "../simulation/metricsEngine";
import {
  createBenchmarkComparisonView,
  createOptimalFlowBenchmark,
  getBenchmarkCoachRecommendation,
  runCoachDemoActions,
} from "../simulation/optimalFlowBenchmark";
import { createProviderDebrief } from "../simulation/providerDebrief";
import {
  coachComparisonStrategyIds,
  createScenarioFromTuning,
  getDefaultScenarioTuningConfig,
  getScenarioTuningPreset,
  scenarioPresets,
} from "../simulation/scenarioTuning";
import { getPatientWorkupSummary } from "../simulation/workupSummary";
import { isReassessmentOverdue, reassessmentOverdueMinutes } from "../simulation/waitingRoomSafety";
import {
  advanceOneMinute,
  applyProviderAction,
  createSimulationRun,
  pauseSimulation,
  setFrontEndTriageProviderEnabled,
  setFrontEndTriageProviderMode,
  startSimulation,
} from "../simulation/simulationEngine";
import { createSupportResourcePools } from "../simulation/supportResources";
import type {
  PatientState,
  FlowGuardrailSummary,
  ProviderActionType,
  ProviderDebrief,
  ProviderState,
  OptimalFlowBenchmark,
  BenchmarkComparisonView,
  BenchmarkCoachRecommendation,
  ActivityTimeline,
  EDRoom,
  RuntimePatient,
  ScenarioPatient,
  CoachComparisonStrategyId,
  CoachPriorityProfile,
  ScenarioPresetId,
  ScenarioTuningConfig,
  SimulationRun,
  TriageProviderMode,
  WhatIfCoachStrategyId,
} from "../simulation/types";

interface BoardColumn {
  title: string;
  states: PatientState[];
}

interface CoreMetricTab {
  id: string;
  label: string;
  value: string;
  subValue: string;
  measures: Array<{
    label: string;
    value: string;
  }>;
}

interface ProviderSuggestion {
  actionType: ProviderActionType;
  patient: RuntimePatient;
}

interface GraphPoint {
  minute: number;
  [seriesId: string]: number;
}

interface GraphSeries {
  id: string;
  label: string;
  color: string;
}

interface OperationalGraphData {
  flowCensus: GraphPoint[];
  throughput: GraphPoint[];
  safetyQuality: GraphPoint[];
}

const triageColumn: BoardColumn = { title: "Front-End Triage", states: ["triage"] };

const baseBoardColumns: BoardColumn[] = [
  { title: "Waiting Room", states: ["waiting"] },
  { title: "Fast Track", states: ["fast_track"] },
  { title: "Roomed: Awaiting Provider", states: ["roomed", "provider_seen"] },
  { title: "Roomed: Workup Pending", states: ["results_pending"] },
  { title: "Roomed: Results Ready", states: ["results_ready"] },
  { title: "Roomed: Disposition Needed", states: ["ready_for_disposition"] },
  { title: "Admission Pending", states: ["admission_pending"] },
  { title: "Boarding", states: ["boarding"] },
  { title: "Departed", states: ["departed", "lwbs"] },
];

const defaultTuningConfig = getDefaultScenarioTuningConfig();
const defaultScenarioConfig = createScenarioFromTuning(defaultTuningConfig);
const DEFAULT_AUTO_ADVANCE_SECONDS = 2;
type SetupPanelTab = "live-operations" | "files" | "scenario" | "calibration" | "additional-stats";
type ColorMode = "light" | "dark";
type MainViewTab = "workflow" | "facility" | "benchmark" | "coach-comparison" | "graphs";
type RightRailTab = "actions" | "coach" | "guardrails" | "debrief" | "activity";

type CalibrationStatus = "local" | "draft" | "default" | "needs-data" | "fixed";

interface CalibrationItem {
  area: string;
  assumption: string;
  currentValue: string;
  source: string;
  status: CalibrationStatus;
}

const localBaselineTuningConfig: ScenarioTuningConfig = {
  ...defaultTuningConfig,
  triageProviderEnabled: true,
  triageProviderMode: "automated",
  roomCapacity: 17,
  providerCount: 3,
  providerAssignmentMode: "team",
  nurseCount: 3,
  techCount: 2,
  fastTrackEnabled: true,
  shiftDurationMinutes: 720,
  expectedArrivalsPerHour: 12,
  providerEvaluationTypicalMinutes: 12,
  triageTypicalMinutes: 5,
  labTurnaroundTypicalMinutes: 45,
  imagingTurnaroundTypicalMinutes: 55,
  admissionDecisionTypicalMinutes: 45,
  boardingDurationTypicalMinutes: 63,
  roomCleaningTypicalMinutes: 20,
  lwbsEnabled: false,
  minimumWaitBeforeLWBS: 90,
  patientAcuityMix: "standard",
  patientAdmissionMix: "standard",
  patientComplaintMix: "balanced",
  patientMixSeed: 1,
  patientWorkupMix: "standard",
  acsDoorToEcgTargetMinutes: 8,
  deteriorationGraceMinutes: 30,
  repeatTroponinDelayMinutes: 60,
  sepsisAntibioticsMinutes: 35,
  sepsisBloodCultureMinutes: 8,
  sepsisCriticalWaitMinutes: 10,
  sepsisFluidsMinutes: 20,
  sepsisLactateCollectionMinutes: 5,
  stemiDoorToEcgTargetMinutes: 5,
  coachPriorityMode: "balanced",
  coachAcuityWeight: 1000,
  coachRiskWeight: 150,
  coachWaitWeight: 1,
};

const GUARDRAIL_EXPLANATIONS: Record<string, { action: string; why: string }> = {
  "Hospitalist response delaying admission": {
    action: "Follow up on the hospitalist consult or admission acceptance so boarding status and room impact are visible.",
    why: "Patients awaiting hospitalist acceptance can continue occupying ED capacity and delay room turnover.",
  },
  "Boarding is consuming room capacity": {
    action: "Account for boarded patients as occupied capacity when deciding who can be roomed next.",
    why: "Boarding reduces usable ED room capacity even after the ED disposition decision is made.",
  },
  "Disposition can release or define room status": {
    action: "Make the discharge or admit decision when appropriate to free or classify the room.",
    why: "Disposition-ready patients are often the fastest way to recover active room capacity.",
  },
  "Front-end triage backlog is aging": {
    action: "Clear front-end triage or route eligible patients to the waiting room.",
    why: "Aging triage queues delay protocol starts, waiting-room visibility, and downstream placement.",
  },
  "High-risk waiting patient with room capacity": {
    action: "Prioritize room placement for the high-risk waiting patient when capacity exists.",
    why: "Available rooms should not sit unused while higher-risk patients wait.",
  },
  "Idle provider with actionable flow work": {
    action: "Assign the idle provider to a ready patient action.",
    why: "Idle provider time during active demand increases door-to-provider and downstream delays.",
  },
  "No active flow guardrails": {
    action: "Continue monitoring census, waits, results, and room capacity.",
    why: "No current v1 threshold is crossed, but flow can change quickly as arrivals continue.",
  },
  "Nurse capacity is limiting flow": {
    action: "Avoid recommendations that depend on unavailable nurse capacity until support opens.",
    why: "Provider decisions may be correct but still fail operationally if support resources are saturated.",
  },
  "Results ready for review": {
    action: "Review results so the patient can move toward disposition.",
    why: "Completed diagnostic work sitting unreviewed keeps rooms occupied and delays throughput.",
  },
  "Room turnover is limiting placement": {
    action: "Watch cleaning completion and room the next appropriate patient as soon as capacity returns.",
    why: "Clean-room availability is the limiting step before waiting patients can move into treatment spaces.",
  },
  "Roomed patient not yet seen": {
    action: "Complete the initial provider evaluation before pulling attention to lower-value tasks.",
    why: "Roomed patients consume capacity but do not progress until the provider evaluation occurs.",
  },
  "Tech capacity is limiting placement": {
    action: "Use rooms, Fast Track, and diagnostics with awareness of tech availability.",
    why: "Tech saturation can slow rooming, testing, transport, and other movement-dependent work.",
  },
  "Waiting-room patient deteriorated": {
    action: "Prioritize reassessment and room placement for the deteriorated patient.",
    why: "Deterioration means the original queue position may no longer match current risk.",
  },
  "Waiting-room reassessment overdue": {
    action: "Reassess overdue waiting-room patients before they become invisible flow risk.",
    why: "Long waits can change risk, acuity, and safe prioritization.",
  },
};

const defaultVisibleCoachComparisonIds: WhatIfCoachStrategyId[] = [
  "provider_run",
  "optimal_flow",
  "front_end_focus",
  "middle_flow_focus",
  "disposition_focus",
  "resource_aware",
  "safety_first",
  "fast_track",
  "balanced_operations",
];
const defaultBenchmarkComparisonId: WhatIfCoachStrategyId = "optimal_flow";
const SAVED_APP_STATE_KEY = "ed-simulation-app-state-v1";
const SAVED_RUNS_KEY = "ed-simulation-saved-runs-v1";

interface SavedRunSnapshot {
  capturedAt: string;
  decisionsCount: number;
  eventsCount: number;
  metrics: SimulationRun["metrics"];
  patientStates: Record<PatientState, number>;
  run: SimulationRun;
  simulationMinute: number;
  status: SimulationRun["status"];
}

interface SavedRunRecord {
  activeDeck: ScenarioPatient[];
  activeTuning: ScenarioTuningConfig;
  createdAt: string;
  draftTuning: ScenarioTuningConfig;
  id: string;
  name: string;
  run: SimulationRun;
  scenarioId: string;
  selectedPresetId: ScenarioPresetId;
  snapshots: SavedRunSnapshot[];
  updatedAt: string;
  version: 1;
}

interface ReplaySession {
  activeDeck: ScenarioPatient[];
  activeTuning: ScenarioTuningConfig;
  draftTuning: ScenarioTuningConfig;
  isPlaying: boolean;
  minute: number;
  previousActiveDeck: ScenarioPatient[];
  previousActiveTuning: ScenarioTuningConfig;
  previousDraftTuning: ScenarioTuningConfig;
  previousRun: SimulationRun;
  previousSelectedPresetId: ScenarioPresetId;
  record: SavedRunRecord;
  selectedPresetId: ScenarioPresetId;
  sourceRun: SimulationRun;
}

interface SavedAppState {
  activeDeck: ScenarioPatient[];
  activeTuning: ScenarioTuningConfig;
  autoAdvanceSeconds: number;
  colorMode: ColorMode;
  draftTuning: ScenarioTuningConfig;
  run: SimulationRun;
  selectedCoreMetricId: string;
  selectedMainViewTab: MainViewTab;
  selectedPatientId?: string;
  selectedPresetId: ScenarioPresetId;
  selectedRightRailTab: RightRailTab;
  selectedSetupPanelTab: SetupPanelTab;
  showHeartMetrics: boolean;
  showSepsisMetrics: boolean;
  showTooltips?: boolean;
}

function loadSavedAppState(): SavedAppState | undefined {
  if (typeof window === "undefined") {
    return undefined;
  }

  try {
    const stored = window.localStorage.getItem(SAVED_APP_STATE_KEY);
    if (!stored) {
      return undefined;
    }

    const parsed = JSON.parse(stored) as Partial<SavedAppState>;
    if (!parsed.run || !Array.isArray(parsed.activeDeck) || !parsed.activeTuning || !parsed.draftTuning) {
      return undefined;
    }

    return parsed as SavedAppState;
  } catch {
    return undefined;
  }
}

function saveAppState(state: SavedAppState): void {
  if (typeof window === "undefined") {
    return;
  }

  try {
    window.localStorage.setItem(SAVED_APP_STATE_KEY, JSON.stringify(state));
  } catch {
    // Browser storage can be unavailable or full; simulation should keep running in memory.
  }
}

function loadSavedRunRecords(): SavedRunRecord[] {
  if (typeof window === "undefined") {
    return [];
  }

  try {
    const stored = window.localStorage.getItem(SAVED_RUNS_KEY);
    if (!stored) {
      return [];
    }

    const parsed = JSON.parse(stored) as SavedRunRecord[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function saveRunRecords(records: SavedRunRecord[]): void {
  if (typeof window === "undefined") {
    return;
  }

  window.localStorage.setItem(SAVED_RUNS_KEY, JSON.stringify(records));
}

function savedRunsExportFileName(): string {
  return `ed-simulation-saved-runs-${new Date().toISOString().slice(0, 10)}.json`;
}

function savedRunsExportJson(records: SavedRunRecord[]): string {
  return JSON.stringify(
    {
      exportedAt: new Date().toISOString(),
      key: SAVED_RUNS_KEY,
      records,
      version: 1,
    },
    null,
    2,
  );
}

function parseSavedRunsImport(text: string): SavedRunRecord[] {
  const parsed = JSON.parse(text) as { records?: SavedRunRecord[] } | SavedRunRecord[];
  const records = Array.isArray(parsed) ? parsed : parsed.records;

  if (!Array.isArray(records)) {
    return [];
  }

  return records.filter((record): record is SavedRunRecord => {
    return (
      record !== undefined &&
      record.version === 1 &&
      typeof record.id === "string" &&
      typeof record.name === "string" &&
      record.run !== undefined &&
      Array.isArray(record.activeDeck) &&
      Array.isArray(record.snapshots)
    );
  });
}

function createRunSnapshot(run: SimulationRun): SavedRunSnapshot {
  const patientStates = run.patients.reduce(
    (counts, patient) => ({
      ...counts,
      [patient.state]: (counts[patient.state] ?? 0) + 1,
    }),
    {
      admission_pending: 0,
      boarding: 0,
      departed: 0,
      disposition_decision_made: 0,
      fast_track: 0,
      lwbs: 0,
      not_arrived: 0,
      orders_placed: 0,
      provider_seen: 0,
      ready_for_disposition: 0,
      results_pending: 0,
      results_ready: 0,
      results_reviewed: 0,
      roomed: 0,
      triage: 0,
      waiting: 0,
    } as Record<PatientState, number>,
  );

  return {
    capturedAt: new Date().toISOString(),
    decisionsCount: run.decisions.length,
    eventsCount: run.events.length,
    metrics: run.metrics,
    patientStates,
    run,
    simulationMinute: run.currentMinute,
    status: run.status,
  };
}

function pruneFutureMinute(value: number | undefined, replayMinute: number): number | undefined {
  return value !== undefined && value <= replayMinute ? value : undefined;
}

function replayPatientState(patient: RuntimePatient, replayMinute: number): PatientState {
  if (patient.arrivedAt === undefined || patient.arrivedAt > replayMinute) {
    return "not_arrived";
  }

  if (patient.lwbsAt !== undefined && patient.lwbsAt <= replayMinute) {
    return "lwbs";
  }

  if (patient.departedAt !== undefined && patient.departedAt <= replayMinute) {
    return "departed";
  }

  if (patient.admissionAcceptedAt !== undefined && patient.admissionAcceptedAt <= replayMinute) {
    return "boarding";
  }

  if (patient.dispositionDecisionAt !== undefined && patient.dispositionDecisionAt <= replayMinute) {
    return patient.dispositionType === "admit_inpatient" ? "admission_pending" : "disposition_decision_made";
  }

  if (patient.readyForDispositionAt !== undefined && patient.readyForDispositionAt <= replayMinute) {
    return "ready_for_disposition";
  }

  if (patient.resultsReviewedAt !== undefined && patient.resultsReviewedAt <= replayMinute) {
    return "ready_for_disposition";
  }

  if (patient.resultsReadyAt !== undefined && patient.resultsReadyAt <= replayMinute) {
    return "results_ready";
  }

  if (patient.ordersPlacedAt !== undefined && patient.ordersPlacedAt <= replayMinute) {
    return "results_pending";
  }

  if (patient.providerSeenAt !== undefined && patient.providerSeenAt <= replayMinute) {
    return "provider_seen";
  }

  if (patient.roomedAt !== undefined && patient.roomedAt <= replayMinute) {
    return "roomed";
  }

  if (patient.fastTrackedAt !== undefined && patient.fastTrackedAt <= replayMinute) {
    return "fast_track";
  }

  if (patient.triagedAt !== undefined && patient.triagedAt <= replayMinute) {
    return "waiting";
  }

  return patient.arrivalPath === "front_end_triage" ? "triage" : "waiting";
}

function createReplayPatient(patient: RuntimePatient, replayMinute: number): RuntimePatient {
  const pendingItems = patient.pendingItems
    .filter((item) => item.orderedAt <= replayMinute)
    .map((item) => {
      const status =
        item.completedAt !== undefined && item.completedAt <= replayMinute
          ? ("completed" as const)
          : item.readyAt <= replayMinute
            ? ("ready" as const)
            : ("pending" as const);

      return {
        ...item,
        collectedAt: pruneFutureMinute(item.collectedAt, replayMinute),
        completedAt: pruneFutureMinute(item.completedAt, replayMinute),
        status,
      };
    });

  return {
    ...patient,
    state: replayPatientState(patient, replayMinute),
    arrivedAt: pruneFutureMinute(patient.arrivedAt, replayMinute),
    triagedAt: pruneFutureMinute(patient.triagedAt, replayMinute),
    roomedAt: pruneFutureMinute(patient.roomedAt, replayMinute),
    providerSeenAt: pruneFutureMinute(patient.providerSeenAt, replayMinute),
    fastTrackedAt: pruneFutureMinute(patient.fastTrackedAt, replayMinute),
    lastReassessedAt: pruneFutureMinute(patient.lastReassessedAt, replayMinute),
    nextReassessmentDueAt:
      patient.nextReassessmentDueAt !== undefined && (patient.arrivedAt ?? Number.POSITIVE_INFINITY) <= replayMinute
        ? patient.nextReassessmentDueAt
        : undefined,
    deterioratedAt: pruneFutureMinute(patient.deterioratedAt, replayMinute),
    ordersPlacedAt: pruneFutureMinute(patient.ordersPlacedAt, replayMinute),
    resultsReadyAt: pruneFutureMinute(patient.resultsReadyAt, replayMinute),
    resultsReviewedAt: pruneFutureMinute(patient.resultsReviewedAt, replayMinute),
    readyForDispositionAt: pruneFutureMinute(patient.readyForDispositionAt, replayMinute),
    dispositionDecisionAt: pruneFutureMinute(patient.dispositionDecisionAt, replayMinute),
    admissionAcceptedAt: pruneFutureMinute(patient.admissionAcceptedAt, replayMinute),
    departedAt: pruneFutureMinute(patient.departedAt, replayMinute),
    lwbsAt: pruneFutureMinute(patient.lwbsAt, replayMinute),
    ecgCompletedAt: pruneFutureMinute(patient.ecgCompletedAt, replayMinute),
    ecgReviewedAt: pruneFutureMinute(patient.ecgReviewedAt, replayMinute),
    stemiAlertActivatedAt: pruneFutureMinute(patient.stemiAlertActivatedAt, replayMinute),
    sepsisRecognizedAt: pruneFutureMinute(patient.sepsisRecognizedAt, replayMinute),
    pendingItems,
  };
}

function createReplayRooms(sourceRun: SimulationRun, replayPatients: RuntimePatient[], replayMinute: number): EDRoom[] {
  return sourceRun.rooms.map((room) => {
    const activePatient = replayPatients.find(
      (patient) =>
        patient.roomId === room.id &&
        !["not_arrived", "triage", "waiting", "fast_track", "departed", "lwbs"].includes(patient.state),
    );

    if (activePatient) {
      return {
        id: room.id,
        patientId: activePatient.id,
        status: activePatient.state === "admission_pending" || activePatient.state === "boarding" ? "blocked" : "occupied",
      };
    }

    const cleaningPatient = replayPatients.find(
      (patient) =>
        patient.roomId === room.id &&
        patient.departedAt !== undefined &&
        patient.departedAt <= replayMinute &&
        patient.departedAt + patient.expectedRoomCleaningMinutes > replayMinute,
    );

    if (cleaningPatient) {
      const cleaningStartedAt = cleaningPatient.departedAt ?? replayMinute;

      return {
        id: room.id,
        previousPatientId: cleaningPatient.id,
        status: "cleaning",
        cleaningStartedAt,
        cleaningReadyAt: cleaningStartedAt + cleaningPatient.expectedRoomCleaningMinutes,
      };
    }

    if (
      room.cleaningStartedAt !== undefined &&
      room.cleaningStartedAt <= replayMinute &&
      (room.cleaningReadyAt === undefined || room.cleaningReadyAt > replayMinute)
    ) {
      return {
        id: room.id,
        previousPatientId: room.previousPatientId,
        status: "cleaning",
        cleaningStartedAt: room.cleaningStartedAt,
        cleaningReadyAt: room.cleaningReadyAt,
      };
    }

    return {
      id: room.id,
      status: "available",
    };
  });
}

function replayAssignedProviderId(sourceRun: SimulationRun, patientId: string, replayMinute: number): string | undefined {
  if (sourceRun.providerAssignmentMode === "team") {
    return undefined;
  }

  const providerDecisions = sourceRun.decisions.filter(
    (decision) =>
      decision.patientId === patientId &&
      decision.providerId?.startsWith("provider-") &&
      decision.simulationMinute <= replayMinute,
  );

  if (providerDecisions.length === 0) {
    return undefined;
  }

  return sourceRun.providerAssignmentMode === "assigned_with_handoff"
    ? providerDecisions[providerDecisions.length - 1]?.providerId
    : providerDecisions[0]?.providerId;
}

function createReplayProviders(sourceRun: SimulationRun, replayMinute: number): ProviderState[] {
  return sourceRun.providers.map((provider) => {
    const activeDecision = sourceRun.decisions.find(
      (decision) =>
        decision.providerId === provider.id &&
        decision.simulationMinute <= replayMinute &&
        decision.simulationMinute + decision.timeCostMinutes > replayMinute,
    );

    return {
      ...provider,
      currentAction: activeDecision
        ? {
            completedAt: activeDecision.simulationMinute + activeDecision.timeCostMinutes,
            decisionId: activeDecision.id,
            patientId: activeDecision.patientId,
            providerId: activeDecision.providerId,
            startedAt: activeDecision.simulationMinute,
            type: activeDecision.actionType,
          }
        : undefined,
      status: activeDecision ? "busy" : "idle",
    };
  });
}

function createReplayRun(sourceRun: SimulationRun, replayMinute: number): SimulationRun {
  const boundedMinute = Math.min(Math.max(sourceRun.shiftStartMinute, replayMinute), sourceRun.currentMinute);
  const patients = sourceRun.patients.map((patient) => ({
    ...createReplayPatient(patient, boundedMinute),
    assignedProviderId: replayAssignedProviderId(sourceRun, patient.id, boundedMinute),
  }));
  const rooms = createReplayRooms(sourceRun, patients, boundedMinute);
  const providers = createReplayProviders(sourceRun, boundedMinute);
  const primaryProvider = providers[0] ?? sourceRun.provider;
  const projectedRun: SimulationRun = {
    ...sourceRun,
    currentMinute: boundedMinute,
    decisions: sourceRun.decisions.filter((decision) => decision.simulationMinute <= boundedMinute),
    events: sourceRun.events.filter((event) => event.simulationMinute <= boundedMinute),
    metrics: emptyMetrics(),
    parentRunId: sourceRun.parentRunId ?? sourceRun.id,
    patients,
    provider: primaryProvider,
    providers,
    rooms,
    runType: "replay",
    status: boundedMinute >= sourceRun.currentMinute ? "completed" : "paused",
    supportResources: sourceRun.supportResources.map((pool) => ({
      ...pool,
      busy: pool.busy.filter((assignment) => assignment.startedAt <= boundedMinute && assignment.completedAt > boundedMinute),
    })),
  };

  return {
    ...projectedRun,
    metrics: calculateMetrics(projectedRun),
  };
}

function createRunBundle(scenario: ReturnType<typeof createScenarioFromTuning>): {
  deck: ScenarioPatient[];
  run: SimulationRun;
} {
  const deck = generatePatientDeck(scenario);

  return {
    deck,
    run: createSimulationRun(scenario, deck),
  };
}

function formatMinute(minute: number): string {
  const baseHour = 15;
  const totalMinutes = baseHour * 60 + minute;
  const hour = Math.floor(totalMinutes / 60) % 24;
  const displayHour = hour % 12 === 0 ? 12 : hour % 12;
  const displayMinute = String(totalMinutes % 60).padStart(2, "0");
  const suffix = hour >= 12 ? "PM" : "AM";

  return `${displayHour}:${displayMinute} ${suffix}`;
}

function nextRoomReadyMinutes(rooms: EDRoom[], currentMinute: number): number | undefined {
  const readyTimes = rooms
    .filter((room) => room.status === "cleaning" && room.cleaningReadyAt !== undefined)
    .map((room) => Math.max(0, (room.cleaningReadyAt ?? currentMinute) - currentMinute));

  return readyTimes.length > 0 ? Math.min(...readyTimes) : undefined;
}

function formatRoomReadyStatus(rooms: EDRoom[], currentMinute: number): string {
  if (rooms.some((room) => room.status === "available")) {
    return "Now";
  }

  const minutes = nextRoomReadyMinutes(rooms, currentMinute);

  return minutes === undefined ? "-" : `${minutes} min`;
}

function mergeDefined<T extends object>(defaults: T, saved: Partial<T> | undefined): T {
  const merged = { ...defaults };

  if (!saved) {
    return merged;
  }

  for (const key of Object.keys(saved) as Array<keyof T>) {
    const value = saved[key];

    if (value !== undefined) {
      merged[key] = value;
    }
  }

  return merged;
}

function formatNumber(value: number | null | undefined): string {
  return value === null || value === undefined ? "-" : value.toFixed(0);
}

function formatMinutesAndHours(minutes: number | null | undefined): string {
  if (minutes === null || minutes === undefined) {
    return "- min / -";
  }

  const roundedMinutes = Math.max(0, Math.round(minutes));
  const hours = Math.floor(roundedMinutes / 60);
  const remainingMinutes = roundedMinutes % 60;

  return `${roundedMinutes} min / ${hours}h ${remainingMinutes}m`;
}

function calibrationStatusLabel(status: CalibrationStatus): string {
  switch (status) {
    case "local":
      return "Local value";
    case "draft":
      return "Draft change";
    case "default":
      return "Default";
    case "needs-data":
      return "Needs data";
    case "fixed":
      return "Fixed v1";
  }
}

function scenarioAssumptionStatusLabel(
  field: keyof ScenarioTuningConfig,
  draftTuning: ScenarioTuningConfig,
  activeTuning: ScenarioTuningConfig,
): string {
  return calibrationStatusLabel(calibrationStatusFor(field, draftTuning, activeTuning));
}

function calibrationStatusFor(
  field: keyof ScenarioTuningConfig,
  draftTuning: ScenarioTuningConfig,
  activeTuning: ScenarioTuningConfig,
): CalibrationStatus {
  if (draftTuning[field] !== activeTuning[field]) {
    return "draft";
  }

  return activeTuning[field] === defaultTuningConfig[field] ? "default" : "local";
}

function coachPriorityModeLabel(mode: ScenarioTuningConfig["coachPriorityMode"]): string {
  switch (mode) {
    case "safety_first":
      return "Safety first";
    case "throughput":
      return "Throughput";
    case "front_end":
      return "Front-end";
    default:
      return "Balanced";
  }
}

function coachComparisonStrategyLabel(strategyId: CoachComparisonStrategyId): string {
  switch (strategyId) {
    case "front_end_focus":
      return "Front-End Focus";
    case "middle_flow_focus":
      return "Middle Flow Focus";
    case "disposition_focus":
      return "Disposition Focus";
    case "resource_aware":
      return "Resource-Aware";
    case "safety_first":
      return "Safety First";
    case "fast_track":
      return "Fast Track";
    case "balanced_operations":
      return "Balanced Operations";
  }
}

function coachPriorityProfileStatus(
  strategyId: CoachComparisonStrategyId,
  draftTuning: ScenarioTuningConfig,
  activeTuning: ScenarioTuningConfig,
): CalibrationStatus {
  const draftProfile = draftTuning.coachStrategyPriorityProfiles[strategyId];
  const activeProfile = activeTuning.coachStrategyPriorityProfiles[strategyId];
  const defaultProfile = defaultTuningConfig.coachStrategyPriorityProfiles[strategyId];

  if (JSON.stringify(draftProfile) !== JSON.stringify(activeProfile)) {
    return "draft";
  }

  return JSON.stringify(activeProfile) === JSON.stringify(defaultProfile) ? "default" : "local";
}

function coachPriorityProfileSummary(profile: CoachPriorityProfile): string {
  return `${coachPriorityModeLabel(profile.mode)}, ESI ${profile.acuityWeight}, Risk ${profile.riskWeight}, Wait ${profile.waitWeight}/min`;
}

function coachStrategyBehaviorDetails(strategyId: CoachComparisonStrategyId | "default"): string[] {
  switch (strategyId) {
    case "front_end_focus":
      return [
        "Clears triage and protocol starts before downstream roomed-patient work.",
        "Moves eligible waiting patients into rooms or Fast Track once front-end work is clear.",
      ];
    case "middle_flow_focus":
      return [
        "Prioritizes roomed unseen patients, provider evaluation, orders, and diagnostic result movement.",
        "Uses patient weights to choose among competing roomed or results-pending patients.",
      ];
    case "disposition_focus":
      return [
        "Prioritizes results review and discharge/admit decisions to clear rooms and define boarding.",
        "Uses patient weights to choose among disposition-ready or results-ready patients.",
      ];
    case "resource_aware":
      return [
        "Checks nurse, tech, room, and provider constraints before creating more support-resource work.",
        "Clears disposition, results, and unseen roomed work first when support capacity is constrained.",
      ];
    case "safety_first":
      return [
        "Moves deteriorating patients, overdue reassessments, critical waits, and cardiac/sepsis-sensitive work earlier.",
        "Uses patient weights to choose among safety-sensitive patients in the same action bucket.",
      ];
    case "fast_track":
      return [
        "Prioritizes eligible lower-acuity patients into Fast Track and keeps vertical-care patients moving.",
        "Uses patient weights after Fast Track eligibility and vertical-care status are considered.",
      ];
    case "balanced_operations":
      return [
        "Blends safety, throughput, disposition, Fast Track, and resource-aware priorities.",
        "Uses patient weights as the tie-breaker inside the selected operational action bucket.",
      ];
    default:
      return [
        "Chooses the broad action path from the selected mode for the live Coach and Optimal Flow Coach.",
        "Uses ESI, risk, and wait weights to rank patients within the selected action bucket.",
      ];
  }
}

function createCalibrationItems(
  draftTuning: ScenarioTuningConfig,
  activeTuning: ScenarioTuningConfig,
): CalibrationItem[] {
  return [
    {
      area: "Demand",
      assumption: "Arrivals per hour",
      currentValue: `${draftTuning.expectedArrivalsPerHour} patients/hr`,
      source: "Scenario Tuning",
      status: calibrationStatusFor("expectedArrivalsPerHour", draftTuning, activeTuning),
    },
    {
      area: "Capacity",
      assumption: "ED treatment rooms",
      currentValue: `${draftTuning.roomCapacity} rooms`,
      source: "Scenario Tuning",
      status: calibrationStatusFor("roomCapacity", draftTuning, activeTuning),
    },
    {
      area: "Staffing",
      assumption: "ED providers",
      currentValue: `${draftTuning.providerCount} provider${draftTuning.providerCount === 1 ? "" : "s"}`,
      source: "Scenario Tuning",
      status: calibrationStatusFor("providerCount", draftTuning, activeTuning),
    },
    {
      area: "Staffing",
      assumption: "Nurse and tech capacity",
      currentValue: `${draftTuning.nurseCount} nurses / ${draftTuning.techCount} techs`,
      source: "Scenario Tuning",
      status:
        calibrationStatusFor("nurseCount", draftTuning, activeTuning) === "draft" ||
        calibrationStatusFor("techCount", draftTuning, activeTuning) === "draft"
          ? "draft"
          : calibrationStatusFor("nurseCount", draftTuning, activeTuning) === "local" ||
              calibrationStatusFor("techCount", draftTuning, activeTuning) === "local"
            ? "local"
            : "default",
    },
    {
      area: "Timing",
      assumption: "Provider evaluation typical",
      currentValue: `${draftTuning.providerEvaluationTypicalMinutes} min`,
      source: "Scenario Tuning",
      status: calibrationStatusFor("providerEvaluationTypicalMinutes", draftTuning, activeTuning),
    },
    {
      area: "Timing",
      assumption: "Front-end triage typical",
      currentValue: `${draftTuning.triageTypicalMinutes} min`,
      source: "Scenario Tuning",
      status: calibrationStatusFor("triageTypicalMinutes", draftTuning, activeTuning),
    },
    {
      area: "Timing",
      assumption: "Lab turnaround typical",
      currentValue: `${draftTuning.labTurnaroundTypicalMinutes} min`,
      source: "Scenario Tuning",
      status: calibrationStatusFor("labTurnaroundTypicalMinutes", draftTuning, activeTuning),
    },
    {
      area: "Timing",
      assumption: "Imaging turnaround typical",
      currentValue: `${draftTuning.imagingTurnaroundTypicalMinutes} min`,
      source: "Scenario Tuning",
      status: calibrationStatusFor("imagingTurnaroundTypicalMinutes", draftTuning, activeTuning),
    },
    {
      area: "Hospitalist",
      assumption: "Hospitalist response typical",
      currentValue: `${draftTuning.admissionDecisionTypicalMinutes} min`,
      source: "Scenario Tuning",
      status: calibrationStatusFor("admissionDecisionTypicalMinutes", draftTuning, activeTuning),
    },
    {
      area: "Boarding",
      assumption: "Inpatient bed wait typical",
      currentValue: `${draftTuning.boardingDurationTypicalMinutes} min`,
      source: "Scenario Tuning",
      status: calibrationStatusFor("boardingDurationTypicalMinutes", draftTuning, activeTuning),
    },
    {
      area: "Rooms",
      assumption: "Room cleaning typical",
      currentValue: `${draftTuning.roomCleaningTypicalMinutes} min`,
      source: "Scenario Tuning",
      status: calibrationStatusFor("roomCleaningTypicalMinutes", draftTuning, activeTuning),
    },
    {
      area: "LWBS",
      assumption: "Minimum wait before LWBS",
      currentValue: `${draftTuning.minimumWaitBeforeLWBS} min / ${draftTuning.lwbsEnabled ? "enabled" : "disabled"}`,
      source: "Scenario Tuning",
      status:
        calibrationStatusFor("minimumWaitBeforeLWBS", draftTuning, activeTuning) === "draft" ||
        calibrationStatusFor("lwbsEnabled", draftTuning, activeTuning) === "draft"
          ? "draft"
          : calibrationStatusFor("minimumWaitBeforeLWBS", draftTuning, activeTuning) === "local" ||
              calibrationStatusFor("lwbsEnabled", draftTuning, activeTuning) === "local"
            ? "local"
            : "default",
    },
    {
      area: "Patient Mix",
      assumption: "Acuity pattern",
      currentValue:
        draftTuning.patientAcuityMix === "higher_acuity"
          ? "Higher acuity"
          : draftTuning.patientAcuityMix === "lower_acuity"
            ? "Lower acuity"
            : "Standard",
      source: "Scenario Tuning",
      status: calibrationStatusFor("patientAcuityMix", draftTuning, activeTuning),
    },
    {
      area: "Patient Mix",
      assumption: "Complaint pattern",
      currentValue:
        draftTuning.patientComplaintMix === "cardiac"
          ? "Cardiac-heavy"
          : draftTuning.patientComplaintMix === "infection"
            ? "Infection-heavy"
            : draftTuning.patientComplaintMix === "injury_minor"
              ? "Injury/minor-heavy"
              : "Balanced",
      source: "Scenario Tuning",
      status: calibrationStatusFor("patientComplaintMix", draftTuning, activeTuning),
    },
    {
      area: "Patient Mix",
      assumption: "Workup intensity",
      currentValue:
        draftTuning.patientWorkupMix === "higher_workup"
          ? "Higher workup"
          : draftTuning.patientWorkupMix === "lower_workup"
            ? "Lower workup"
            : "Standard",
      source: "Scenario Tuning",
      status: calibrationStatusFor("patientWorkupMix", draftTuning, activeTuning),
    },
    {
      area: "Patient Mix",
      assumption: "Admission pressure",
      currentValue:
        draftTuning.patientAdmissionMix === "higher_admit"
          ? "Higher admit"
          : draftTuning.patientAdmissionMix === "lower_admit"
            ? "Lower admit"
            : "Standard",
      source: "Scenario Tuning",
      status: calibrationStatusFor("patientAdmissionMix", draftTuning, activeTuning),
    },
    {
      area: "Patient Mix",
      assumption: "Deck seed",
      currentValue: `Seed ${draftTuning.patientMixSeed}`,
      source: "Scenario Tuning",
      status: calibrationStatusFor("patientMixSeed", draftTuning, activeTuning),
    },
    {
      area: "Clinical Bundles",
      assumption: "STEMI door-to-ECG target",
      currentValue: `${draftTuning.stemiDoorToEcgTargetMinutes} min`,
      source: "Scenario Tuning",
      status: calibrationStatusFor("stemiDoorToEcgTargetMinutes", draftTuning, activeTuning),
    },
    {
      area: "Clinical Bundles",
      assumption: "Possible ACS door-to-ECG target",
      currentValue: `${draftTuning.acsDoorToEcgTargetMinutes} min`,
      source: "Scenario Tuning",
      status: calibrationStatusFor("acsDoorToEcgTargetMinutes", draftTuning, activeTuning),
    },
    {
      area: "Clinical Bundles",
      assumption: "Repeat troponin delay",
      currentValue: `${draftTuning.repeatTroponinDelayMinutes} min`,
      source: "Scenario Tuning",
      status: calibrationStatusFor("repeatTroponinDelayMinutes", draftTuning, activeTuning),
    },
    {
      area: "Clinical Bundles",
      assumption: "Sepsis lactate / culture timing",
      currentValue: `${draftTuning.sepsisLactateCollectionMinutes} / ${draftTuning.sepsisBloodCultureMinutes} min`,
      source: "Scenario Tuning",
      status:
        calibrationStatusFor("sepsisLactateCollectionMinutes", draftTuning, activeTuning) === "draft" ||
        calibrationStatusFor("sepsisBloodCultureMinutes", draftTuning, activeTuning) === "draft"
          ? "draft"
          : calibrationStatusFor("sepsisLactateCollectionMinutes", draftTuning, activeTuning) === "local" ||
              calibrationStatusFor("sepsisBloodCultureMinutes", draftTuning, activeTuning) === "local"
            ? "local"
            : "default",
    },
    {
      area: "Clinical Bundles",
      assumption: "Sepsis antibiotics / fluids timing",
      currentValue: `${draftTuning.sepsisAntibioticsMinutes} / ${draftTuning.sepsisFluidsMinutes} min`,
      source: "Scenario Tuning",
      status:
        calibrationStatusFor("sepsisAntibioticsMinutes", draftTuning, activeTuning) === "draft" ||
        calibrationStatusFor("sepsisFluidsMinutes", draftTuning, activeTuning) === "draft"
          ? "draft"
          : calibrationStatusFor("sepsisAntibioticsMinutes", draftTuning, activeTuning) === "local" ||
              calibrationStatusFor("sepsisFluidsMinutes", draftTuning, activeTuning) === "local"
            ? "local"
            : "default",
    },
    {
      area: "Safety Rules",
      assumption: "Sepsis critical wait threshold",
      currentValue: `${draftTuning.sepsisCriticalWaitMinutes} min`,
      source: "Scenario Tuning",
      status: calibrationStatusFor("sepsisCriticalWaitMinutes", draftTuning, activeTuning),
    },
    {
      area: "Safety Rules",
      assumption: "Deterioration grace after overdue reassessment",
      currentValue: `${draftTuning.deteriorationGraceMinutes} min`,
      source: "Scenario Tuning",
      status: calibrationStatusFor("deteriorationGraceMinutes", draftTuning, activeTuning),
    },
    {
      area: "Coach",
      assumption: "Coach priority mode",
      currentValue: coachPriorityModeLabel(draftTuning.coachPriorityMode),
      source: "Scenario Tuning",
      status: calibrationStatusFor("coachPriorityMode", draftTuning, activeTuning),
    },
    {
      area: "Coach",
      assumption: "Acuity priority weight",
      currentValue: `${draftTuning.coachAcuityWeight} points per ESI step`,
      source: "Scenario Tuning",
      status: calibrationStatusFor("coachAcuityWeight", draftTuning, activeTuning),
    },
    {
      area: "Coach",
      assumption: "Risk priority weight",
      currentValue: `${draftTuning.coachRiskWeight} points per risk level`,
      source: "Scenario Tuning",
      status: calibrationStatusFor("coachRiskWeight", draftTuning, activeTuning),
    },
    {
      area: "Coach",
      assumption: "Wait priority weight",
      currentValue: `${draftTuning.coachWaitWeight} point${draftTuning.coachWaitWeight === 1 ? "" : "s"} per wait minute`,
      source: "Scenario Tuning",
      status: calibrationStatusFor("coachWaitWeight", draftTuning, activeTuning),
    },
    ...coachComparisonStrategyIds.map((strategyId): CalibrationItem => ({
      area: "Coach",
      assumption: `${coachComparisonStrategyLabel(strategyId)} Coach profile`,
      currentValue: coachPriorityProfileSummary(draftTuning.coachStrategyPriorityProfiles[strategyId]),
      source: "Scenario Tuning",
      status: coachPriorityProfileStatus(strategyId, draftTuning, activeTuning),
    })),
    {
      area: "Coach",
      assumption: "Benchmark comparison runtime",
      currentValue: "Calculated from same deck and scenario",
      source: "Coach engine",
      status: "fixed",
    },
  ];
}

function graphStepMinutes(currentMinute: number): number {
  if (currentMinute <= 240) {
    return 15;
  }

  if (currentMinute <= 720) {
    return 30;
  }

  return 60;
}

function graphMinutes(currentMinute: number): number[] {
  const step = graphStepMinutes(currentMinute);
  const minutes: number[] = [];

  for (let minute = 0; minute <= currentMinute; minute += step) {
    minutes.push(minute);
  }

  if (minutes[minutes.length - 1] !== currentMinute) {
    minutes.push(currentMinute);
  }

  return minutes;
}

function createOperationalGraphData(run: SimulationRun): OperationalGraphData {
  const sortedEvents = [...run.events].sort((left, right) => left.simulationMinute - right.simulationMinute);
  const patientStates = new Map<string, PatientState>(
    run.patients.map((patient) => [patient.id, "not_arrived" as PatientState]),
  );
  const points = graphMinutes(run.currentMinute);
  const flowCensus: GraphPoint[] = [];
  const throughput: GraphPoint[] = [];
  const safetyQuality: GraphPoint[] = [];
  let eventIndex = 0;
  let deteriorations = 0;
  let lwbsEvents = 0;
  let reassessments = 0;
  let stemiAlerts = 0;

  for (const minute of points) {
    while (eventIndex < sortedEvents.length) {
      const event = sortedEvents[eventIndex];
      if (!event || event.simulationMinute > minute) {
        break;
      }

      if (event.patientId && event.newState) {
        patientStates.set(event.patientId, event.newState);
      }

      if (event.type === "patient_deteriorated") {
        deteriorations += 1;
      } else if (event.type === "patient_lwbs") {
        lwbsEvents += 1;
      } else if (event.type === "patient_reassessed") {
        reassessments += 1;
      } else if (event.type === "stemi_alert_activated") {
        stemiAlerts += 1;
      }

      eventIndex += 1;
    }

    const states = Array.from(patientStates.values());
    const waiting = states.filter((state) => state === "waiting").length;
    const roomedActive = states.filter((state) =>
      ["roomed", "provider_seen", "orders_placed", "results_pending", "results_ready", "ready_for_disposition"].includes(state),
    ).length;
    const resultsWaiting = states.filter((state) => state === "results_pending" || state === "results_ready").length;
    const boarding = states.filter((state) => state === "admission_pending" || state === "boarding").length;
    const arrived = states.filter((state) => state !== "not_arrived").length;
    const departed = states.filter((state) => state === "departed" || state === "lwbs").length;
    const seen = run.patients.filter((patient) => patient.providerSeenAt !== undefined && patient.providerSeenAt <= minute).length;

    flowCensus.push({
      minute,
      boarding,
      resultsWaiting,
      roomedActive,
      waiting,
    });
    throughput.push({
      minute,
      arrived,
      departed,
      lwbs: lwbsEvents,
      seen,
    });
    safetyQuality.push({
      minute,
      deteriorations,
      lwbs: lwbsEvents,
      reassessments,
      stemiAlerts,
    });
  }

  return {
    flowCensus,
    safetyQuality,
    throughput,
  };
}

function isTerminalPatient(patient: RuntimePatient): boolean {
  return patient.state === "departed" || patient.state === "lwbs" || patient.departedAt !== undefined;
}

function waitMinutes(patient: RuntimePatient, currentMinute: number): number {
  if (patient.arrivedAt === undefined) {
    return 0;
  }

  const endMinute = patient.departedAt ?? patient.lwbsAt ?? currentMinute;
  return Math.max(0, endMinute - patient.arrivedAt);
}

function waitingRiskDisplay(patient: RuntimePatient): { className: string; label: string } {
  if (isTerminalPatient(patient)) {
    return { className: "closed", label: "Closed" };
  }

  return { className: patient.riskLevel, label: patient.riskLevel };
}

function stateLabel(state: string): string {
  return state
    .split("_")
    .map((part) => `${part[0]?.toUpperCase() ?? ""}${part.slice(1)}`)
    .join(" ");
}

function arrivalPathLabel(patient: RuntimePatient): string {
  if (patient.arrivalPath === "front_end_triage") {
    return "Front-end triage";
  }

  if (patient.arrivalPath === "direct_waiting_room") {
    return "Direct waiting room";
  }

  return "-";
}

function patientDisplayName(patientId?: string): string {
  return patientId ?? "another patient";
}

function providerAssignmentLabel(providerId?: string): string {
  if (!providerId) {
    return "Unassigned";
  }

  const providerNumber = providerId.match(/provider-(\d+)/)?.[1];
  return providerNumber ? `Provider ${Number(providerNumber)}` : providerId;
}

function providerWorkText(run: SimulationRun, selectedPatientId?: string): string {
  const activeActions = run.providers
    .map((provider) => provider.currentAction)
    .filter((action): action is NonNullable<typeof action> => action !== undefined);

  if (activeActions.length === 0) {
    return "Provider available now";
  }

  const selectedAction = activeActions.find((action) => action.patientId === selectedPatientId);
  const action = selectedAction ?? activeActions[0];
  if (!action) {
    return "Provider available now";
  }
  const actionPatient = patientDisplayName(action.patientId);

  if (action.type === "see_patient") {
    return selectedAction
      ? `Seeing Patient ${actionPatient} until ${formatMinute(action.completedAt)}`
      : `Provider currently seeing ${actionPatient} until ${formatMinute(action.completedAt)}`;
  }

  return selectedAction
    ? `Provider working with ${actionPatient} until ${formatMinute(action.completedAt)}`
    : `Provider busy with ${actionPatient} until ${formatMinute(action.completedAt)}`;
}

function providerAvailabilityText(run: SimulationRun): string {
  if (run.providers.some((provider) => provider.status === "idle")) {
    return "Available now";
  }

  const nextAvailableMinute = Math.min(
    ...run.providers
      .map((provider) => provider.busyUntilMinute)
      .filter((minute): minute is number => minute !== undefined),
  );

  return Number.isFinite(nextAvailableMinute) ? `Next available ${formatMinute(nextAvailableMinute)}` : "Availability pending";
}

function triageProviderStatusText(run: SimulationRun): string {
  if (!run.triageProviderEnabled) {
    return "Front-End Triage Provider unavailable";
  }

  if (run.triageProviderMode === "automated") {
    return "Automated Front-End Triage active";
  }

  return run.triageProvider.status === "busy"
    ? `Front-End Triage Provider busy until ${formatMinute(run.triageProvider.busyUntilMinute ?? run.currentMinute)}`
    : "Front-End Triage Provider available separately";
}

function supportResourceStatusText(run: SimulationRun): string {
  const nurseTotal = run.supportResources.find((pool) => pool.role === "nurse")?.total ?? 0;
  const techTotal = run.supportResources.find((pool) => pool.role === "tech")?.total ?? 0;

  return `Nurses ${run.metrics.nursesBusy}/${nurseTotal} busy · Techs ${run.metrics.techsBusy}/${techTotal} busy`;
}

function pendingHospitalistResponseMinutes(run: SimulationRun): number | undefined {
  const pendingResponseTimes = run.patients
    .filter((patient) => patient.state === "admission_pending")
    .flatMap((patient) =>
      patient.pendingItems
        .filter((item) => item.type === "admission_decision")
        .map((item) => Math.max(0, item.readyAt - run.currentMinute)),
    );

  return pendingResponseTimes.length > 0 ? Math.min(...pendingResponseTimes) : undefined;
}

function hospitalistStatusText(run: SimulationRun): string {
  if (run.metrics.admissionPendingCensus === 0) {
    return "Hospitalist available · no consults pending";
  }

  const nextResponseMinutes = pendingHospitalistResponseMinutes(run);
  const nextResponseText = nextResponseMinutes === undefined ? "response pending" : `next response ${nextResponseMinutes} min`;

  return `Hospitalist ${run.metrics.admissionPendingCensus} pending · ${nextResponseText}`;
}

function providerSuggestionPriority(suggestion: ProviderSuggestion): number {
  const { actionType, patient } = suggestion;

  if (patient.state === "results_ready" && actionType === "see_patient") {
    return 100;
  }

  if (patient.state === "results_ready" && actionType === "review_results") {
    return 95;
  }

  if (patient.state === "ready_for_disposition") {
    return 90;
  }

  if (patient.state === "results_pending" && actionType === "see_patient") {
    return 85;
  }

  if (patient.state === "roomed" && actionType === "see_patient") {
    return 80;
  }

  if (patient.state === "provider_seen") {
    return 70;
  }

  if (patient.state === "waiting" && actionType === "room_patient") {
    return 60;
  }

  if (patient.state === "waiting" && actionType === "fast_track_patient") {
    return 58;
  }

  if (patient.state === "waiting" && actionType === "reassess_waiting_patient") {
    return patient.deterioratedAt !== undefined ? 75 : 55;
  }

  return 0;
}

function getProviderSuggestions(run: SimulationRun): Map<string, ProviderSuggestion> {
  const candidates = run.patients
    .flatMap((patient) =>
      getAvailableProviderActions(run, patient.id)
        .filter(
          (action) =>
            action.enabled &&
            action.type !== "continue_waiting" &&
            action.type !== "complete_triage" &&
            action.type !== "start_protocol_orders" &&
            patient.state !== "triage",
        )
        .map((action) => ({ actionType: action.type, patient })),
    )
    .sort((left, right) => {
      const priorityDifference = providerSuggestionPriority(right) - providerSuggestionPriority(left);
      if (priorityDifference !== 0) {
        return priorityDifference;
      }

      const esiDifference = left.patient.esi - right.patient.esi;
      if (esiDifference !== 0) {
        return esiDifference;
      }

      return (left.patient.arrivedAt ?? left.patient.arrivalMinute) - (right.patient.arrivedAt ?? right.patient.arrivalMinute);
    });

  const suggestions = new Map<string, ProviderSuggestion>();
  const assignedPatientIds = new Set<string>();

  for (const provider of run.providers.filter((candidate) => candidate.status === "idle")) {
    const suggestion = candidates.find((candidate) => !assignedPatientIds.has(candidate.patient.id));
    if (!suggestion) {
      continue;
    }

    suggestions.set(provider.id, suggestion);
    assignedPatientIds.add(suggestion.patient.id);
  }

  return suggestions;
}

function providerCurrentWorkText(provider: ProviderState, suggestion?: ProviderSuggestion): string {
  if (provider.status === "idle" || !provider.currentAction) {
    if (suggestion) {
      return `Suggested: ${ACTION_LABELS[suggestion.actionType]} ${suggestion.patient.id}`;
    }

    return "Available now";
  }

  return `${ACTION_LABELS[provider.currentAction.type]} ${patientDisplayName(provider.currentAction.patientId)}`;
}

function providerCurrentWorkLines(provider: ProviderState, suggestion?: ProviderSuggestion): { label: string; value: string } {
  const workText = providerCurrentWorkText(provider, suggestion);
  const patientId = provider.currentAction?.patientId ?? suggestion?.patient.id;

  if (!patientId) {
    return { label: workText, value: "" };
  }

  const patientIndex = workText.indexOf(patientId);
  if (patientIndex === -1) {
    return { label: workText, value: patientId };
  }

  return {
    label: workText.slice(0, patientIndex).trim(),
    value: workText.slice(patientIndex).trim(),
  };
}

function providerNextAvailableText(provider: ProviderState): string {
  if (provider.status === "idle" || provider.busyUntilMinute === undefined) {
    return "Available now";
  }

  return `Available ${formatMinute(provider.busyUntilMinute)}`;
}

function providerNextAvailableLines(provider: ProviderState): { label: string; value: string } {
  if (provider.status === "idle" || provider.busyUntilMinute === undefined) {
    return { label: "Available", value: "now" };
  }

  return { label: "Available", value: formatMinute(provider.busyUntilMinute) };
}

function boardLocationLabel(state: PatientState): string {
  switch (state) {
    case "triage":
      return "Front-End Triage";
    case "waiting":
      return "Waiting Room";
    case "fast_track":
      return "Fast Track";
    case "roomed":
    case "provider_seen":
      return "Roomed: Awaiting Provider";
    case "results_pending":
      return "Roomed: Workup Pending";
    case "results_ready":
      return "Roomed: Results Ready";
    case "ready_for_disposition":
      return "Roomed: Disposition Needed";
    case "admission_pending":
      return "Admission Pending";
    case "boarding":
      return "Boarding";
    case "departed":
    case "lwbs":
      return "Departed";
    default:
      return stateLabel(state);
  }
}

function providerLocationText(provider: ProviderState, run: SimulationRun, suggestion?: ProviderSuggestion): string {
  const patientId = provider.currentAction?.patientId ?? suggestion?.patient.id;
  if (!patientId) {
    return "No active assignment";
  }

  const patient = run.patients.find((candidate) => candidate.id === patientId);
  if (!patient) {
    return "Patient location unavailable";
  }

  const roomLabel = patient.roomId ? ` · ${patient.roomId}` : "";
  return `${boardLocationLabel(patient.state)}${roomLabel}`;
}

function providerLocationLines(
  provider: ProviderState,
  run: SimulationRun,
  suggestion?: ProviderSuggestion,
): { label: string; value: string } {
  const patientId = provider.currentAction?.patientId ?? suggestion?.patient.id;
  if (!patientId) {
    return { label: "Location", value: "No active assignment" };
  }

  const patient = run.patients.find((candidate) => candidate.id === patientId);
  if (!patient) {
    return { label: "Location", value: "Patient location unavailable" };
  }

  const location = boardLocationLabel(patient.state);
  if (location.startsWith("Roomed:")) {
    return {
      label: patient.roomId ? `Roomed: ${patient.roomId}` : "Roomed",
      value: location.replace("Roomed:", "").trim(),
    };
  }

  return {
    label: patient.roomId ? `${location}: ${patient.roomId}` : location,
    value: patient.roomId ? patient.id : "",
  };
}

function coreMetricTabs(run: SimulationRun): CoreMetricTab[] {
  return [
    {
      id: "waiting-room-census",
      label: "Waiting Room",
      value: String(run.metrics.waitingRoomCensus),
      subValue: "patients",
      measures: [
        { label: "Waiting room census", value: String(run.metrics.waitingRoomCensus) },
        { label: "Longest waiting-room wait", value: formatMinutesAndHours(run.metrics.longestWaitingRoomWaitMinutes) },
        { label: "Average waiting-room wait", value: `${formatNumber(run.metrics.averageWaitingRoomWaitMinutes)} min` },
        { label: "Moderate-or-higher risk", value: String(run.metrics.moderateOrHigherRiskWaitingPatients) },
        { label: "High / critical risk", value: String(run.metrics.highRiskWaitingPatients) },
        { label: "Critical risk", value: String(run.metrics.criticalRiskWaitingPatients) },
        { label: "Waiting-room risk minutes", value: `${run.metrics.waitingRoomRiskMinutes} min` },
        { label: "Reassessments overdue", value: String(run.metrics.reassessmentsOverdue) },
        { label: "Longest reassessment overdue", value: `${run.metrics.longestReassessmentOverdueMinutes} min` },
        { label: "Waiting-room deteriorations", value: String(run.metrics.waitingRoomDeteriorations) },
        { label: "LWBS count", value: String(run.metrics.patientsLWBS) },
        { label: "LWBS rate", value: `${(run.metrics.lwbsRate * 100).toFixed(1)}%` },
        { label: "Average wait before LWBS", value: `${formatNumber(run.metrics.averageWaitBeforeLWBS)} min` },
        { label: "High-risk LWBS", value: String(run.metrics.highRiskLWBS) },
        { label: "LWBS with pending orders", value: String(run.metrics.lwbsWithOrdersPending) },
      ],
    },
    {
      id: "front-end-triage-census",
      label: "Front-End Triage",
      value: String(run.metrics.triageCensus),
      subValue: run.triageProviderEnabled ? "patients" : "off",
      measures: [
        { label: "Triage mode", value: stateLabel(run.triageProviderMode) },
        { label: "Triage time multiplier", value: `${run.triageDurationMultiplier.toFixed(1)}x` },
        { label: "Triage provider available", value: run.triageProvider.status === "idle" ? "Yes" : "No" },
        { label: "In front-end triage", value: String(run.metrics.triageCensus) },
        { label: "Arrived patients", value: String(run.metrics.patientsArrived) },
      ],
    },
    {
      id: "fast-track-census",
      label: "Fast Track",
      value: String(run.metrics.fastTrackCensus),
      subValue: "vertical care",
      measures: [
        { label: "In Fast Track", value: String(run.metrics.fastTrackCensus) },
        { label: "Patients fast-tracked", value: String(run.metrics.patientsFastTracked) },
        { label: "Available rooms", value: String(run.metrics.availableRooms) },
        { label: "Waiting room census", value: String(run.metrics.waitingRoomCensus) },
      ],
    },
    {
      id: "chest-pain-acs",
      label: "Chest Pain / ACS",
      value: String(run.metrics.chestPainPatientsArrived + run.metrics.suspectedAcsPatientsArrived),
      subValue: "arrived",
      measures: [
        { label: "Chest pain arrivals", value: String(run.metrics.chestPainPatientsArrived) },
        { label: "Suspected ACS arrivals", value: String(run.metrics.suspectedAcsPatientsArrived) },
        { label: "STEMI-alert pathways", value: String(run.metrics.stemiAlertsActivated) },
        { label: "Average door-to-ECG", value: `${formatNumber(run.metrics.averageDoorToEcgMinutes)} min` },
        { label: "Door-to-ECG <=10 min", value: `${(run.metrics.doorToEcgWithin10Rate * 100).toFixed(1)}%` },
        { label: "Median door-to-ECG", value: `${formatNumber(run.metrics.medianDoorToEcgMinutes)} min` },
        { label: "P90 door-to-ECG", value: `${formatNumber(run.metrics.p90DoorToEcgMinutes)} min` },
        { label: "ECG reviewed <=10 min", value: `${(run.metrics.ecgReviewedWithin10Rate * 100).toFixed(1)}%` },
        { label: "ECG delayed over 10 min", value: String(run.metrics.delayedEcgCount) },
        {
          label: "Door-to-troponin collection",
          value: `${formatNumber(run.metrics.averageDoorToTroponinCollectionMinutes)} min`,
        },
        { label: "Troponin result turnaround", value: `${formatNumber(run.metrics.averageTroponinTurnaroundMinutes)} min` },
        { label: "ECG-to-STEMI activation", value: `${formatNumber(run.metrics.averageEcgToStemiActivationMinutes)} min` },
        { label: "Cardiac results awaiting review", value: String(run.metrics.cardiacResultsReadyAwaitingReview) },
        {
          label: "Chest pain LWBS",
          value: `${run.metrics.chestPainLWBS} / ${(run.metrics.chestPainLWBSRate * 100).toFixed(1)}%`,
        },
        {
          label: "Suspected ACS LWBS",
          value: `${run.metrics.suspectedAcsLWBS} / ${(run.metrics.suspectedAcsLWBSRate * 100).toFixed(1)}%`,
        },
      ],
    },
    {
      id: "available-rooms",
      label: "Available Rooms",
      value: String(run.metrics.availableRooms),
      subValue: "rooms",
      measures: [
        { label: "Available rooms", value: String(run.metrics.availableRooms) },
        { label: "Occupied rooms", value: String(run.metrics.occupiedRooms) },
        { label: "Blocked rooms", value: String(run.metrics.blockedRooms) },
        { label: "Cleaning rooms", value: String(run.metrics.cleaningRooms) },
        { label: "Next room ready", value: formatRoomReadyStatus(run.rooms, run.currentMinute) },
        {
          label: "Avg active cleaning",
          value:
            run.metrics.cleaningRooms > 0
              ? `${formatNumber(run.metrics.totalRoomCleaningMinutes / run.metrics.cleaningRooms)} min`
              : "-",
        },
        { label: "Room cleaning minutes", value: `${run.metrics.totalRoomCleaningMinutes} min` },
        {
          label: "Waiting for clean room",
          value:
            run.metrics.availableRooms === 0 && run.metrics.cleaningRooms > 0
              ? String(run.metrics.waitingRoomCensus)
              : "0",
        },
      ],
    },
    {
      id: "sepsis-flow",
      label: "Sepsis",
      value: String(run.metrics.sepsisPatientsArrived),
      subValue: "arrived",
      measures: [
        { label: "Sepsis arrivals", value: String(run.metrics.sepsisPatientsArrived) },
        { label: "Pathways started", value: String(run.metrics.sepsisPathwayStarted) },
        { label: "Recognition <=10 min", value: `${(run.metrics.sepsisRecognitionWithin10Rate * 100).toFixed(1)}%` },
        {
          label: "Average door-to-recognition",
          value: `${formatNumber(run.metrics.averageDoorToSepsisRecognitionMinutes)} min`,
        },
        {
          label: "Door-to-lactate collection",
          value: `${formatNumber(run.metrics.averageDoorToLactateCollectionMinutes)} min`,
        },
        {
          label: "Door-to-lactate result",
          value: `${formatNumber(run.metrics.averageDoorToLactateResultMinutes)} min`,
        },
        {
          label: "Door-to-blood cultures",
          value: `${formatNumber(run.metrics.averageDoorToBloodCulturesMinutes)} min`,
        },
        {
          label: "Door-to-antibiotics",
          value: `${formatNumber(run.metrics.averageDoorToAntibioticsMinutes)} min`,
        },
        { label: "Antibiotics <=60 min", value: `${(run.metrics.sepsisAntibioticsWithin60Rate * 100).toFixed(1)}%` },
        { label: "Median door-to-antibiotics", value: `${formatNumber(run.metrics.medianDoorToAntibioticsMinutes)} min` },
        { label: "P90 door-to-antibiotics", value: `${formatNumber(run.metrics.p90DoorToAntibioticsMinutes)} min` },
        { label: "Door-to-fluids", value: `${formatNumber(run.metrics.averageDoorToFluidsMinutes)} min` },
        { label: "Sepsis waiting without room", value: String(run.metrics.sepsisWaitingWithoutRoom) },
        { label: "Sepsis LWBS", value: `${run.metrics.sepsisLWBS} / ${(run.metrics.sepsisLWBSRate * 100).toFixed(1)}%` },
      ],
    },
    {
      id: "active-patient-census",
      label: "Active Census",
      value: String(run.metrics.activePatientCensus),
      subValue: "patients",
      measures: [
        { label: "Active census", value: String(run.metrics.activePatientCensus) },
        { label: "Patients seen", value: String(run.metrics.patientsSeen) },
        { label: "Patients seen / hour", value: run.metrics.patientsSeenPerHour.toFixed(1) },
        { label: "Provider count", value: String(run.providers.length) },
        { label: "Busy providers", value: String(run.providers.filter((provider) => provider.status === "busy").length) },
        { label: "Idle providers", value: String(run.providers.filter((provider) => provider.status === "idle").length) },
        { label: "Provider busy minutes", value: String(run.metrics.providerBusyMinutes) },
        { label: "Provider idle minutes", value: String(run.metrics.providerIdleMinutes) },
        { label: "Nurses busy", value: String(run.metrics.nursesBusy) },
        { label: "Techs busy", value: String(run.metrics.techsBusy) },
        { label: "Nurse busy minutes", value: String(run.metrics.nurseBusyMinutes) },
        { label: "Tech busy minutes", value: String(run.metrics.techBusyMinutes) },
      ],
    },
    {
      id: "boarding-census",
      label: "Boarding",
      value: String(run.metrics.boardingCensus),
      subValue: "patients",
      measures: [
        { label: "Hospitalist consults pending", value: String(run.metrics.admissionPendingCensus) },
        {
          label: "Next hospitalist response",
          value:
            pendingHospitalistResponseMinutes(run) === undefined
              ? "-"
              : `${pendingHospitalistResponseMinutes(run)} min`,
        },
        { label: "Admission pending", value: String(run.metrics.admissionPendingCensus) },
        { label: "Average hospitalist response", value: `${formatNumber(run.metrics.averageAdmissionDecisionMinutes)} min` },
        { label: "Total admission delay minutes", value: `${run.metrics.totalAdmissionDecisionMinutes} min` },
        { label: "Boarding census", value: String(run.metrics.boardingCensus) },
        { label: "Total boarding minutes", value: `${run.metrics.totalBoardingMinutes} min` },
        { label: "Blocked rooms", value: String(run.metrics.blockedRooms) },
      ],
    },
    {
      id: "door-to-provider",
      label: "Door-to-Provider",
      value: `${formatNumber(run.metrics.averageDoorToProviderMinutes)} min`,
      subValue: "average",
      measures: [
        { label: "Average door-to-provider", value: `${formatNumber(run.metrics.averageDoorToProviderMinutes)} min` },
        { label: "Patients seen", value: String(run.metrics.patientsSeen) },
        { label: "Patients seen / hour", value: run.metrics.patientsSeenPerHour.toFixed(1) },
        { label: "Longest current wait", value: formatMinutesAndHours(run.metrics.longestCurrentWaitMinutes) },
      ],
    },
    {
      id: "time-to-disposition",
      label: "Time to Disposition",
      value: `${formatNumber(run.metrics.averageTimeToDispositionMinutes)} min`,
      subValue: "average",
      measures: [
        { label: "Average time to disposition", value: `${formatNumber(run.metrics.averageTimeToDispositionMinutes)} min` },
        {
          label: "Average results-ready to disposition",
          value: `${formatNumber(run.metrics.averageResultsReadyToDispositionMinutes)} min`,
        },
        { label: "Admission pending", value: String(run.metrics.admissionPendingCensus) },
        { label: "Average hospitalist response", value: `${formatNumber(run.metrics.averageAdmissionDecisionMinutes)} min` },
        { label: "Patients dispositioned", value: String(run.metrics.patientsDispositioned) },
      ],
    },
    {
      id: "ed-los",
      label: "ED LOS",
      value: `${formatNumber(run.metrics.averageEDLengthOfStayMinutes)} min`,
      subValue: "average",
      measures: [
        { label: "Average ED LOS", value: `${formatNumber(run.metrics.averageEDLengthOfStayMinutes)} min` },
        { label: "Patients departed", value: String(run.metrics.patientsDeparted) },
        { label: "Admission delay minutes", value: `${run.metrics.totalAdmissionDecisionMinutes} min` },
        { label: "Total boarding minutes", value: `${run.metrics.totalBoardingMinutes} min` },
      ],
    },
  ];
}

function tabMeasureIcon(label: string): React.ReactNode {
  const normalized = label.toLowerCase();
  const iconSize = 16;

  if (normalized.includes("stemi")) {
    return <Siren size={iconSize} />;
  }

  if (
    normalized.includes("chest") ||
    normalized.includes("acs") ||
    normalized.includes("cardiac") ||
    normalized.includes("ecg")
  ) {
    return <HeartPulse size={iconSize} />;
  }

  if (normalized.includes("troponin") || normalized.includes("lactate") || normalized.includes("culture")) {
    return <TestTube size={iconSize} />;
  }

  if (normalized.includes("antibiotic")) {
    return <Syringe size={iconSize} />;
  }

  if (normalized.includes("fluid")) {
    return <Droplets size={iconSize} />;
  }

  if (normalized.includes("sepsis")) {
    return <Ambulance size={iconSize} />;
  }

  if (normalized.includes("lwbs") || normalized.includes("risk") || normalized.includes("critical") || normalized.includes("deterioration")) {
    return <CircleAlert size={iconSize} />;
  }

  if (normalized.includes("reassessment") || normalized.includes("recheck")) {
    return <TimerReset size={iconSize} />;
  }

  if (normalized.includes("fast track")) {
    return <StepForward size={iconSize} />;
  }

  if (normalized.includes("active census")) {
    return <Activity size={iconSize} />;
  }

  if (normalized.includes("patients seen")) {
    return <UserCheck size={iconSize} />;
  }

  if (normalized.includes("provider count")) {
    return <Stethoscope size={iconSize} />;
  }

  if (normalized.includes("busy providers") || normalized.includes("idle providers")) {
    return <UserRoundCog size={iconSize} />;
  }

  if (normalized.includes("provider busy") || normalized.includes("provider idle")) {
    return <Clock size={iconSize} />;
  }

  if (normalized.includes("nurse") || normalized.includes("tech")) {
    return <UserRoundCog size={iconSize} />;
  }

  if (normalized.includes("triage")) {
    return <Stethoscope size={iconSize} />;
  }

  if (normalized.includes("result") || normalized.includes("disposition")) {
    return <ClipboardCheck size={iconSize} />;
  }

  if (normalized.includes("admission") || normalized.includes("acceptance")) {
    return <Hourglass size={iconSize} />;
  }

  if (normalized.includes("boarding")) {
    return <BedDouble size={iconSize} />;
  }

  if (normalized.includes("cleaning")) {
    return <BrushCleaning size={iconSize} />;
  }

  if (normalized.includes("blocked")) {
    return <CircleOff size={iconSize} />;
  }

  if (normalized.includes("occupied")) {
    return <DoorOpen size={iconSize} />;
  }

  if (normalized.includes("room")) {
    return <Bed size={iconSize} />;
  }

  if (normalized.includes("provider") || normalized.includes("seen")) {
    return <UserRoundCheck size={iconSize} />;
  }

  if (normalized.includes("busy") || normalized.includes("idle")) {
    return <UserRoundCog size={iconSize} />;
  }

  if (normalized.includes("rate") || normalized.includes("%")) {
    return <Gauge size={iconSize} />;
  }

  if (
    normalized.includes("average") ||
    normalized.includes("median") ||
    normalized.includes("p90") ||
    normalized.includes("longest") ||
    normalized.includes("delay") ||
    normalized.includes("turnaround") ||
    normalized.includes("time") ||
    normalized.includes("wait") ||
    normalized.includes("los") ||
    normalized.includes("door")
  ) {
    return <Clock size={iconSize} />;
  }

  if (normalized.includes("pathway") || normalized.includes("started")) {
    return <TrendingUp size={iconSize} />;
  }

  if (normalized.includes("count") || normalized.includes("census") || normalized.includes("patients") || normalized.includes("arrived")) {
    return <Users size={iconSize} />;
  }

  if (normalized.includes("collection")) {
    return <TestTubes size={iconSize} />;
  }

  if (normalized.includes("minutes")) {
    return <CalendarClock size={iconSize} />;
  }

  return <CircleGauge size={iconSize} />;
}

function metricTooltip(label: string): string {
  const descriptions: Record<string, string> = {
    "Abx <=60": "Percent of sepsis patients who received antibiotics within 60 minutes of arrival.",
    "Active Census": "Patients currently active in the ED workflow, excluding patients who have already departed or left without being seen.",
    "Admission Pending": "Patients who need an admission decision or bed assignment and are still occupying ED flow capacity.",
    "Admission delay minutes": "Total time patients have spent waiting on admission decisions or acceptance.",
    "Arrived patients": "Total patients who have arrived during this simulation run.",
    "Average admission acceptance": "Average time from admission request to an acceptance or boarding decision.",
    "Average hospitalist response": "Average time from ED admission request to hospitalist acceptance for admitted patients.",
    "Average door-to-ECG": "Average time from patient arrival to ECG completion for chest pain or suspected ACS patients.",
    "Average door-to-recognition": "Average time from arrival to sepsis recognition.",
    "Average ED LOS": "Average emergency department length of stay from arrival to departure.",
    "Average results-ready to disposition": "Average time from results becoming ready to the provider entering a disposition decision.",
    "Average time to disposition": "Average time from arrival to the provider disposition decision.",
    "Average wait before LWBS": "Average waiting-room time before patients left without being seen.",
    "Average waiting-room wait": "Average current wait time for patients still in the waiting room.",
    "Avg active cleaning": "Average elapsed cleaning time among rooms that are currently in turnover.",
    "Blocked rooms": "Rooms unavailable for new patients because they are blocked by boarding, constraints, or operational issues.",
    Boarding: "Patients currently boarding in the ED after admission, still consuming ED room capacity.",
    "Boarding census": "Current number of admitted patients boarding in ED rooms.",
    "Boarding Min": "Cumulative boarding minutes accumulated during the current simulation run.",
    "Cardiac results awaiting review": "Cardiac diagnostic results that are ready but have not yet been reviewed by the provider.",
    "Chest Pain LWBS": "Chest pain patients who left without being seen, shown as count and rate.",
    "Chest pain arrivals": "Total chest pain patients who have arrived during this simulation run.",
    "Critical risk": "Waiting-room patients currently classified as critical risk.",
    "Door Antibiotics": "Average time from arrival to antibiotics for sepsis patients.",
    "Door-to-ECG <=10 min": "Percent of chest pain or suspected ACS patients whose ECG was completed within 10 minutes of arrival.",
    "Door ECG <=10": "Percent of chest pain or suspected ACS patients whose ECG was completed within 10 minutes of arrival.",
    "Door-to-fluids": "Average time from arrival to IV fluids for sepsis patients.",
    "Door-to-lactate collection": "Average time from arrival to lactate specimen collection for sepsis patients.",
    "Door-to-lactate result": "Average time from arrival to lactate result availability for sepsis patients.",
    "Door-to-blood cultures": "Average time from arrival to blood culture collection for sepsis patients.",
    "ECG delayed over 10 min": "Number of chest pain or suspected ACS patients whose ECG exceeded the 10-minute target.",
    "ECG reviewed <=10 min": "Percent of ECGs reviewed within 10 minutes of being completed.",
    "ECG Reviewed <=10": "Percent of ECGs reviewed within 10 minutes of being completed.",
    "ECG-to-STEMI activation": "Average time from ECG completion to STEMI-alert activation.",
    "Fast Track": "Patients currently in the fast-track pathway or total patients routed there, depending on the metric panel.",
    "Front-End Triage": "Patients currently in automated front-end triage before moving into the waiting room or care area.",
    "High / critical risk": "Waiting-room patients currently classified as high or critical risk.",
    "High-risk LWBS": "High-risk patients who left without being seen.",
    "Hospitalist consults pending": "Admitted patients currently waiting for hospitalist consult response or admission acceptance.",
    "Hospitalist Pending": "Admitted patients currently waiting for hospitalist consult response or admission acceptance.",
    "In Fast Track": "Patients currently assigned to the fast-track care pathway.",
    "In front-end triage": "Patients currently being processed by front-end triage.",
    "Longest current wait": "Longest current wait among patients who have not yet been seen by a provider.",
    "Longest reassessment overdue": "Longest overdue interval among patients who need a waiting-room reassessment.",
    "Longest Wait": "Longest current wait among patients who have not yet been seen by a provider.",
    "Longest waiting-room wait": "Longest current wait among patients still in the waiting room.",
    LWBS: "Patients who left without being seen, shown as count and percentage of arrivals.",
    "LWBS count": "Total patients who left without being seen.",
    "LWBS rate": "Percent of arrived patients who left without being seen.",
    "LWBS with pending orders": "Patients who left without being seen while orders were still pending.",
    "Median Door ECG": "Median time from arrival to ECG completion for chest pain or suspected ACS patients.",
    "Median door-to-ECG": "Median time from arrival to ECG completion for chest pain or suspected ACS patients.",
    "Median door-to-antibiotics": "Median time from arrival to antibiotics for sepsis patients.",
    "Moderate-or-higher risk": "Waiting-room patients currently classified as moderate, high, or critical risk.",
    "Nurse/Tech": "Current nurse and technician workload, shown as nurses busy / techs busy.",
    "Nurse busy minutes": "Cumulative minutes nurses have been tied up on rooming, protocols, and care tasks.",
    "Nurses busy": "Nurses currently tied up on active ED support work.",
    "Next Room Ready": "Estimated time until a room is ready. Shows Now when at least one room is already available.",
    "Next room ready": "Estimated time until a room is ready. Shows Now when at least one room is already available.",
    "Next hospitalist response": "Estimated minutes until the next pending hospitalist admission response is expected.",
    "Occupied rooms": "Rooms currently occupied by active ED patients.",
    "Patients departed": "Patients who completed the ED visit and left the department.",
    "Patients dispositioned": "Patients who have received a disposition decision.",
    "Patients fast-tracked": "Total patients routed to fast track during this simulation run.",
    "Patients seen": "Patients evaluated by an ED provider.",
    "Patients seen / hour": "Provider throughput rate based on patients seen during the run.",
    "Pathways started": "Patients for whom the sepsis pathway was started.",
    "P90 Door ECG": "90th percentile arrival-to-ECG time for chest pain or suspected ACS patients.",
    "P90 door-to-ECG": "90th percentile arrival-to-ECG time for chest pain or suspected ACS patients.",
    "P90 door-to-antibiotics": "90th percentile arrival-to-antibiotics time for sepsis patients.",
    "Provider busy minutes": "Cumulative minutes providers have been busy evaluating, reviewing, or dispositioning patients.",
    "Provider count": "Number of ED providers configured for this run.",
    "Provider idle minutes": "Cumulative provider idle minutes while the simulation was active.",
    "Reassessments overdue": "Waiting-room patients whose reassessment timer is overdue.",
    "Recheck Due": "Waiting-room patients whose reassessment timer is overdue.",
    "Results to Disp": "Average time from results becoming ready to the provider entering a disposition decision.",
    "Room cleaning minutes": "Cumulative time rooms have spent in cleaning status.",
    "Rooms Available": "Rooms open and ready for the next patient.",
    "Rooms Blocked": "Rooms unavailable for new patients because they are blocked by boarding, constraints, or operational issues.",
    "Rooms Cleaning": "Rooms currently unavailable because cleaning is in progress.",
    "Rooms Occupied": "Rooms currently occupied by active ED patients.",
    "Sepsis arrivals": "Total sepsis patients who have arrived during this simulation run.",
    "Sepsis LWBS": "Sepsis patients who left without being seen, shown as count and rate.",
    "Sepsis Rec <=10": "Percent of sepsis patients recognized within 10 minutes of arrival.",
    "Sepsis Recognition <=10 min": "Percent of sepsis patients recognized within 10 minutes of arrival.",
    "Sepsis waiting without room": "Sepsis patients waiting without an assigned ED room.",
    "Sepsis Waiting": "Sepsis patients waiting without an assigned ED room.",
    "Seen / Hour": "Provider throughput rate based on patients seen during the run.",
    "STEMI-alert pathways": "Number of STEMI-alert pathways activated.",
    "Suspected ACS arrivals": "Total suspected ACS patients who have arrived during this simulation run.",
    "Suspected ACS LWBS": "Suspected ACS patients who left without being seen, shown as count and rate.",
    "Tech busy minutes": "Cumulative minutes technicians have been tied up on active support work.",
    "Techs busy": "Technicians currently tied up on active ED support work.",
    "Total admission delay minutes": "Cumulative minutes patients have spent waiting on admission decisions or acceptance.",
    "Total boarding minutes": "Cumulative minutes admitted patients have spent boarding in the ED.",
    "Troponin result turnaround": "Average time from troponin collection to result availability.",
    "Troponin TAT": "Average time from troponin collection to result availability.",
    "Waiting Room": "Patients currently waiting for ED rooming or provider evaluation.",
    "Waiting for clean room": "Patients in the waiting room while no room is available and at least one room is still cleaning.",
    "Waiting room census": "Patients currently waiting for ED rooming or provider evaluation.",
    "Waiting-room deteriorations": "Number of waiting-room patients whose risk worsened while waiting.",
    "Waiting-room risk minutes": "Cumulative weighted risk time accumulated by patients waiting in the waiting room.",
  };

  if (descriptions[label]) {
    return descriptions[label];
  }

  const normalized = label.toLowerCase();

  if (normalized.includes("lwbs")) {
    return "Patients who left without being seen, with count or rate depending on the metric.";
  }

  if (normalized.includes("door") || normalized.includes("average") || normalized.includes("median") || normalized.includes("p90")) {
    return "Timing metric summarizing how long this step takes during the simulation.";
  }

  if (normalized.includes("busy") || normalized.includes("idle")) {
    return "Resource workload metric showing how staff capacity is being used.";
  }

  if (normalized.includes("census") || normalized.includes("waiting") || normalized.includes("patients")) {
    return "Patient count metric showing current volume or total patients in this category.";
  }

  return `${label} metric for the current simulation run.`;
}

function tabMeasureGridStyle(measureCount: number): CSSProperties {
  const columnCount = measureCount > 7 ? Math.ceil(measureCount / 2) : Math.max(1, measureCount);

  return { "--tab-measure-columns": String(columnCount) } as CSSProperties;
}

export function App() {
  const [initialAppState] = useState<SavedAppState | undefined>(() => loadSavedAppState());
  const [draftTuning, setDraftTuning] = useState<ScenarioTuningConfig>({
    ...defaultTuningConfig,
    ...initialAppState?.draftTuning,
  });
  const [activeTuning, setActiveTuning] = useState<ScenarioTuningConfig>({
    ...defaultTuningConfig,
    ...initialAppState?.activeTuning,
  });
  const [selectedPresetId, setSelectedPresetId] = useState<ScenarioPresetId>(initialAppState?.selectedPresetId ?? "default");
  const scenario = useMemo(() => createScenarioFromTuning(activeTuning), [activeTuning]);
  const [activeDeck, setActiveDeck] = useState<ScenarioPatient[]>(
    () => initialAppState?.activeDeck ?? createRunBundle(defaultScenarioConfig).deck,
  );
  const [run, setRun] = useState<SimulationRun>(() => {
    if (initialAppState?.run) {
      const restoredRun = {
        ...initialAppState.run,
        fastTrackEnabled: initialAppState.run.fastTrackEnabled ?? defaultTuningConfig.fastTrackEnabled,
        providerAssignmentMode: initialAppState.run.providerAssignmentMode ?? defaultTuningConfig.providerAssignmentMode,
        metrics: mergeDefined(emptyMetrics(), initialAppState.run.metrics),
        supportResources:
          initialAppState.run.supportResources ?? createSupportResourcePools(defaultTuningConfig.nurseCount, defaultTuningConfig.techCount),
        timingProfile: {
          ...defaultScenarioConfig.timingProfile,
          ...initialAppState.run.timingProfile,
        },
        patients: initialAppState.run.patients.map((patient) => ({
          ...patient,
          deteriorationCount: patient.deteriorationCount ?? 0,
          expectedRoomCleaningMinutes:
            patient.expectedRoomCleaningMinutes ?? defaultScenarioConfig.timingProfile.roomCleaning.typical,
        })),
      };

      return restoredRun.status === "running" ? pauseSimulation(restoredRun) : restoredRun;
    }

    return createSimulationRun(defaultScenarioConfig, activeDeck);
  });
  const [selectedPatientId, setSelectedPatientId] = useState<string | undefined>(initialAppState?.selectedPatientId);
  const [selectedCoreMetricId, setSelectedCoreMetricId] = useState(initialAppState?.selectedCoreMetricId ?? "waiting-room-census");
  const [selectedSetupPanelTab, setSelectedSetupPanelTab] = useState<SetupPanelTab>(
    initialAppState?.selectedSetupPanelTab ?? "live-operations",
  );
  const [selectedMainViewTab, setSelectedMainViewTab] = useState<MainViewTab>(initialAppState?.selectedMainViewTab ?? "workflow");
  const initialRightRailTab = ["benchmark", "export", "saved-runs"].includes(
    initialAppState?.selectedRightRailTab as string,
  )
    ? "actions"
    : (initialAppState?.selectedRightRailTab ?? "actions");
  const [selectedRightRailTab, setSelectedRightRailTab] = useState<RightRailTab>(initialRightRailTab);
  const [autoAdvanceSeconds, setAutoAdvanceSeconds] = useState(initialAppState?.autoAdvanceSeconds ?? DEFAULT_AUTO_ADVANCE_SECONDS);
  const [coachDemoEnabled, setCoachDemoEnabled] = useState(false);
  const [colorMode, setColorMode] = useState<ColorMode>(initialAppState?.colorMode ?? "light");
  const [visibleCoachComparisonIds, setVisibleCoachComparisonIds] = useState<WhatIfCoachStrategyId[]>(
    defaultVisibleCoachComparisonIds,
  );
  const [selectedBenchmarkComparisonId, setSelectedBenchmarkComparisonId] =
    useState<WhatIfCoachStrategyId>(defaultBenchmarkComparisonId);
  const [showHeartMetrics, setShowHeartMetrics] = useState(initialAppState?.showHeartMetrics ?? true);
  const [showSepsisMetrics, setShowSepsisMetrics] = useState(initialAppState?.showSepsisMetrics ?? true);
  const [showTooltips, setShowTooltips] = useState(initialAppState?.showTooltips ?? true);
  const [showAllCoachRules, setShowAllCoachRules] = useState(false);
  const [savedRunRecords, setSavedRunRecords] = useState<SavedRunRecord[]>(() => loadSavedRunRecords());
  const [savedRunStatus, setSavedRunStatus] = useState<string | undefined>();
  const [replaySession, setReplaySession] = useState<ReplaySession | undefined>();
  const benchmarkCacheRef = useRef<{ key: string; benchmark: OptimalFlowBenchmark } | undefined>(undefined);
  const isReplayMode = replaySession !== undefined;

  const selectedPatient = useMemo(
    () => run.patients.find((patient) => patient.id === selectedPatientId),
    [run.patients, selectedPatientId],
  );
  const availableActions = getAvailableProviderActions(run, selectedPatient?.id);
  const boardColumns = useMemo(() => {
    const flowColumns = activeTuning.fastTrackEnabled
      ? baseBoardColumns
      : baseBoardColumns.filter((column) => !column.states.includes("fast_track"));

    return activeTuning.triageProviderMode !== "unavailable" ? [triageColumn, ...flowColumns] : flowColumns;
  }, [activeTuning.fastTrackEnabled, activeTuning.triageProviderMode]);
  const coreMetrics = coreMetricTabs(run);
  const providerSuggestions = getProviderSuggestions(run);
  const flowGuardrails = useMemo(() => createFlowGuardrails(run), [run]);
  const debrief = useMemo(() => createProviderDebrief(run), [run]);
  const shouldComputeComparisonRuns =
    selectedMainViewTab === "benchmark" ||
    selectedMainViewTab === "coach-comparison" ||
    selectedRightRailTab === "activity" ||
    selectedSetupPanelTab === "files";
  const benchmarkCacheKey = [
    scenario.id,
    activeDeck.length,
    run.id,
    run.currentMinute,
    run.events.length,
    run.decisions.length,
    run.status,
  ].join("|");
  const benchmark = useMemo(() => {
    if (benchmarkCacheRef.current?.key === benchmarkCacheKey) {
      return benchmarkCacheRef.current.benchmark;
    }

    if (!shouldComputeComparisonRuns) {
      return undefined;
    }

    const calculatedBenchmark = createOptimalFlowBenchmark(scenario, activeDeck, run);
    benchmarkCacheRef.current = {
      benchmark: calculatedBenchmark,
      key: benchmarkCacheKey,
    };

    return calculatedBenchmark;
  }, [activeDeck, benchmarkCacheKey, run, scenario, shouldComputeComparisonRuns]);
  const benchmarkComparisonView = useMemo(
    () => (benchmark ? createBenchmarkComparisonView(run, benchmark, selectedBenchmarkComparisonId) : undefined),
    [benchmark, run, selectedBenchmarkComparisonId],
  );
  const operationalGraphData = useMemo(() => createOperationalGraphData(run), [run]);
  const activityTimeline = useMemo(() => createActivityTimeline(run, benchmark?.benchmarkRun), [benchmark?.benchmarkRun, run]);
  const activityExportRuns = useMemo<ActivityCsvRun[]>(
    () => [
      { run, strategyId: "provider_run", strategyLabel: "Provider Run" },
      ...(benchmark
        ? [
            { run: benchmark.benchmarkRun, strategyId: "optimal_flow" as const, strategyLabel: "Optimal Flow Coach" },
            { run: benchmark.frontEndFocusRun, strategyId: "front_end_focus" as const, strategyLabel: "Front-End Focus Coach" },
            { run: benchmark.middleFlowFocusRun, strategyId: "middle_flow_focus" as const, strategyLabel: "Middle Flow Focus Coach" },
            { run: benchmark.dispositionFocusRun, strategyId: "disposition_focus" as const, strategyLabel: "Disposition Focus Coach" },
            { run: benchmark.resourceAwareRun, strategyId: "resource_aware" as const, strategyLabel: "Resource-Aware Coach" },
            { run: benchmark.safetyFirstRun, strategyId: "safety_first" as const, strategyLabel: "Safety First Coach" },
            { run: benchmark.fastTrackRun, strategyId: "fast_track" as const, strategyLabel: "Fast Track Coach" },
            { run: benchmark.balancedOperationsRun, strategyId: "balanced_operations" as const, strategyLabel: "Balanced Operations Coach" },
          ]
        : []),
    ],
    [benchmark, run],
  );
  const coachRecommendation = useMemo(() => getBenchmarkCoachRecommendation(run), [run]);
  const selectedCoreMetric =
    coreMetrics.find((metric) => metric.id === selectedCoreMetricId) ??
    coreMetrics.find((metric) => metric.id === "waiting-room-census");
  const calibrationItems = useMemo(
    () => createCalibrationItems(draftTuning, activeTuning),
    [activeTuning, draftTuning],
  );
  const localCalibrationCount = calibrationItems.filter((item) => item.status === "local").length;
  const draftCalibrationCount = calibrationItems.filter((item) => item.status === "draft").length;
  const needsCalibrationDataCount = calibrationItems.filter((item) => item.status === "needs-data").length;

  useEffect(() => {
    if (isReplayMode || run.status !== "running") {
      return undefined;
    }

    const intervalId = window.setInterval(() => {
      setRun((currentRun) => {
        const coachedRun = coachDemoEnabled ? runCoachDemoActions(currentRun).run : currentRun;
        return advanceOneMinute(coachedRun, scenario);
      });
    }, autoAdvanceSeconds * 1000);

    return () => window.clearInterval(intervalId);
  }, [autoAdvanceSeconds, coachDemoEnabled, isReplayMode, run.status, scenario]);

  useEffect(() => {
    if (!replaySession?.isPlaying) {
      return undefined;
    }

    const intervalId = window.setInterval(() => {
      setReplaySession((currentSession) => {
        if (!currentSession) {
          return undefined;
        }

        const nextMinute = Math.min(currentSession.minute + 1, currentSession.sourceRun.currentMinute);
        setRun(createReplayRun(currentSession.sourceRun, nextMinute));

        return {
          ...currentSession,
          isPlaying: nextMinute < currentSession.sourceRun.currentMinute,
          minute: nextMinute,
        };
      });
    }, autoAdvanceSeconds * 1000);

    return () => window.clearInterval(intervalId);
  }, [autoAdvanceSeconds, replaySession?.isPlaying]);

  useEffect(() => {
    if (isReplayMode) {
      return;
    }

    if (run.status === "running" && run.currentMinute % 5 !== 0) {
      return;
    }

    saveAppState({
      activeDeck,
      activeTuning,
      autoAdvanceSeconds,
      colorMode,
      draftTuning,
      run,
      selectedCoreMetricId,
      selectedMainViewTab,
      selectedPatientId,
      selectedPresetId,
      selectedRightRailTab,
      selectedSetupPanelTab,
      showHeartMetrics,
      showSepsisMetrics,
      showTooltips,
    });
  }, [
    activeDeck,
    activeTuning,
    autoAdvanceSeconds,
    colorMode,
    draftTuning,
    run,
    selectedCoreMetricId,
    selectedMainViewTab,
    selectedPatientId,
    selectedPresetId,
    selectedRightRailTab,
    selectedSetupPanelTab,
    showHeartMetrics,
    showSepsisMetrics,
    showTooltips,
    isReplayMode,
  ]);

  if (!selectedCoreMetric) {
    return null;
  }

  function updateRun(nextRun: SimulationRun) {
    setRun(nextRun);
  }

  function handleStartPause() {
    if (isReplayMode) {
      return;
    }

    if (run.status === "running") {
      setCoachDemoEnabled(false);
      updateRun(pauseSimulation(run));
      return;
    }

    if (run.status === "not_started" || run.status === "paused") {
      updateRun(startSimulation(run));
    }
  }

  function handleAdvance(minutes: number) {
    if (isReplayMode) {
      return;
    }

    let nextRun = run;
    for (let index = 0; index < minutes; index += 1) {
      nextRun = advanceOneMinute(nextRun, scenario);
    }
    updateRun(nextRun);
  }

  function handleAction(actionType: ProviderActionType) {
    if (isReplayMode) {
      return;
    }

    setCoachDemoEnabled(false);
    updateRun(applyProviderAction(run, actionType, selectedPatient?.id));
  }

  function handleSelectCoachPatient() {
    if (!coachRecommendation) {
      return;
    }

    setSelectedPatientId(coachRecommendation.patientId);
    setSelectedRightRailTab("actions");
  }

  function handleApplyCoachRecommendation() {
    if (!coachRecommendation || isReplayMode) {
      return;
    }

    setCoachDemoEnabled(false);
    setSelectedPatientId(coachRecommendation.patientId);
    updateRun(applyProviderAction(run, coachRecommendation.actionType, coachRecommendation.patientId));
  }

  function handleToggleCoachComparison(strategyId: WhatIfCoachStrategyId) {
    setVisibleCoachComparisonIds((currentIds) =>
      currentIds.includes(strategyId)
        ? currentIds.filter((id) => id !== strategyId)
        : [...currentIds, strategyId],
    );
  }

  function handleSelectBenchmarkComparison(strategyId: WhatIfCoachStrategyId) {
    setSelectedBenchmarkComparisonId(strategyId === "provider_run" ? defaultBenchmarkComparisonId : strategyId);
  }

  function handleReset() {
    if (isReplayMode) {
      return;
    }

    setSelectedPatientId(undefined);
    setCoachDemoEnabled(false);
    setRun(createSimulationRun(scenario, activeDeck));
  }

  function handleCoachDemoToggle() {
    if (isReplayMode) {
      return;
    }

    setSelectedSetupPanelTab("live-operations");
    setSelectedRightRailTab("coach");

    if (coachDemoEnabled) {
      setCoachDemoEnabled(false);
      return;
    }

    setCoachDemoEnabled(true);
    if (run.status === "not_started" || run.status === "paused") {
      updateRun(startSimulation(run));
    }
  }

  function handleTriageProviderToggle(enabled: boolean) {
    if (isReplayMode) {
      return;
    }

    const mode: TriageProviderMode = enabled ? "manual" : "unavailable";
    setDraftTuning((current) => ({ ...current, triageProviderEnabled: enabled, triageProviderMode: mode }));
    setActiveTuning((current) => ({ ...current, triageProviderEnabled: enabled, triageProviderMode: mode }));
    setRun((currentRun) => setFrontEndTriageProviderEnabled(currentRun, enabled));
  }

  function handleTriageProviderModeChange(mode: TriageProviderMode) {
    if (isReplayMode) {
      return;
    }

    setDraftTuning((current) => ({ ...current, triageProviderEnabled: mode !== "unavailable", triageProviderMode: mode }));
    setActiveTuning((current) => ({ ...current, triageProviderEnabled: mode !== "unavailable", triageProviderMode: mode }));
    setRun((currentRun) => setFrontEndTriageProviderMode(currentRun, mode));
  }

  function updateDraftTuning(
    field: keyof ScenarioTuningConfig,
    value: ScenarioTuningConfig[keyof ScenarioTuningConfig],
  ) {
    setSelectedPresetId("default");
    setDraftTuning((current) => ({
      ...current,
      [field]: value,
    }));
  }

  function updateDraftCoachStrategyProfile(
    strategyId: CoachComparisonStrategyId,
    field: keyof CoachPriorityProfile,
    value: CoachPriorityProfile[keyof CoachPriorityProfile],
  ) {
    setSelectedPresetId("default");
    setDraftTuning((current) => ({
      ...current,
      coachStrategyPriorityProfiles: {
        ...current.coachStrategyPriorityProfiles,
        [strategyId]: {
          ...current.coachStrategyPriorityProfiles[strategyId],
          [field]: value,
        },
      },
    }));
  }

  function handlePresetChange(presetId: ScenarioPresetId) {
    setSelectedPresetId(presetId);
    setDraftTuning(getScenarioTuningPreset(presetId));
  }

  function handleApplyScenario() {
    if (isReplayMode) {
      return;
    }

    const nextScenario = createScenarioFromTuning(draftTuning);
    const nextBundle = createRunBundle(nextScenario);
    setSelectedPatientId(undefined);
    setCoachDemoEnabled(false);
    setActiveTuning(draftTuning);
    setActiveDeck(nextBundle.deck);
    setRun(nextBundle.run);
  }

  function handleRestoreDefaultTuning() {
    if (isReplayMode) {
      return;
    }

    const nextScenario = createScenarioFromTuning(defaultTuningConfig);
    const nextBundle = createRunBundle(nextScenario);
    setSelectedPatientId(undefined);
    setCoachDemoEnabled(false);
    setDraftTuning(defaultTuningConfig);
    setActiveTuning(defaultTuningConfig);
    setSelectedPresetId("default");
    setActiveDeck(nextBundle.deck);
    setRun(nextBundle.run);
  }

  function handleApplyLocalBaselineTuning() {
    if (isReplayMode) {
      return;
    }

    setSelectedPresetId("default");
    setDraftTuning(localBaselineTuningConfig);
  }

  function createCurrentSavedRunRecord(): SavedRunRecord {
    const now = new Date().toISOString();
    const snapshot = createRunSnapshot(run);
    const fallbackName = `${stateLabel(run.status)} run ${formatMinute(run.currentMinute)} · ${new Date().toLocaleString()}`;

    return {
      activeDeck,
      activeTuning,
      createdAt: now,
      draftTuning,
      id: `saved-run-${now}-${run.id}`,
      name: fallbackName,
      run,
      scenarioId: scenario.id,
      selectedPresetId,
      snapshots: [snapshot],
      updatedAt: now,
      version: 1,
    };
  }

  async function writeSavedRunsFile(records: SavedRunRecord[], fileName: string, successMessage: string) {
    const json = savedRunsExportJson(records);

    try {
      if ("showSaveFilePicker" in window) {
        const fileHandle = await (window as unknown as {
          showSaveFilePicker: (options: {
            suggestedName: string;
            types: Array<{ accept: Record<string, string[]>; description: string }>;
          }) => Promise<{ createWritable: () => Promise<{ close: () => Promise<void>; write: (contents: string) => Promise<void> }> }>;
        }).showSaveFilePicker({
          suggestedName: fileName,
          types: [
            {
              accept: { "application/json": [".json"] },
              description: "Saved runs JSON",
            },
          ],
        });
        const writable = await fileHandle.createWritable();
        await writable.write(json);
        await writable.close();
        setSavedRunStatus(successMessage);
        return;
      }

      const blob = new Blob([json], { type: "application/json;charset=utf-8" });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = fileName;
      anchor.click();
      URL.revokeObjectURL(url);
      setSavedRunStatus(`${successMessage} Browser downloaded ${fileName}.`);
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") {
        setSavedRunStatus("File export canceled.");
        return;
      }

      setSavedRunStatus("File export failed. Browser file access may be unavailable.");
    }
  }

  async function handleExportCurrentRunFile() {
    if (isReplayMode) {
      setSavedRunStatus("Exit replay before exporting a new run.");
      return;
    }

    const record = createCurrentSavedRunRecord();
    await writeSavedRunsFile([record], savedRunsExportFileName(), `Exported current run: ${record.name}.`);
  }

  function handleRestoreSavedRun(record: SavedRunRecord) {
    if (isReplayMode) {
      handleExitReplay();
    }

    const restoredRun = record.run.status === "running" ? pauseSimulation(record.run) : record.run;

    setSelectedPatientId(undefined);
    setCoachDemoEnabled(false);
    setDraftTuning(record.draftTuning);
    setActiveTuning(record.activeTuning);
    setSelectedPresetId(record.selectedPresetId);
    setActiveDeck(record.activeDeck);
    setRun(restoredRun);
    setSavedRunStatus(`Loaded ${record.name}.`);
  }

  function handleDeleteSavedRun(recordId: string) {
    const nextRecords = savedRunRecords.filter((record) => record.id !== recordId);
    saveRunRecords(nextRecords);
    setSavedRunRecords(nextRecords);
    setSavedRunStatus("Saved run deleted.");
  }

  function handleImportSavedRunsFile(text: string) {
    try {
      const importedRecords = parseSavedRunsImport(text);
      if (importedRecords.length === 0) {
        setSavedRunStatus("Import did not find any saved runs.");
        return;
      }

      const mergedRecords = [...importedRecords, ...savedRunRecords].filter(
        (record, index, allRecords) => allRecords.findIndex((candidate) => candidate.id === record.id) === index,
      );

      saveRunRecords(mergedRecords);
      setSavedRunRecords(mergedRecords);
      setSavedRunStatus(`Imported ${importedRecords.length} saved run${importedRecords.length === 1 ? "" : "s"}.`);
    } catch {
      setSavedRunStatus("Import failed. Choose a valid saved-runs JSON file.");
    }
  }

  function handleStartReplay(record: SavedRunRecord) {
    const replayMinute = record.run.shiftStartMinute;

    setSelectedPatientId(undefined);
    setCoachDemoEnabled(false);
    setDraftTuning(record.draftTuning);
    setActiveTuning(record.activeTuning);
    setSelectedPresetId(record.selectedPresetId);
    setActiveDeck(record.activeDeck);
    setRun(createReplayRun(record.run, replayMinute));
    setReplaySession({
      activeDeck: record.activeDeck,
      activeTuning: record.activeTuning,
      draftTuning: record.draftTuning,
      isPlaying: false,
      minute: replayMinute,
      previousActiveDeck: activeDeck,
      previousActiveTuning: activeTuning,
      previousDraftTuning: draftTuning,
      previousRun: run,
      previousSelectedPresetId: selectedPresetId,
      record,
      selectedPresetId: record.selectedPresetId,
      sourceRun: record.run,
    });
    setSelectedSetupPanelTab("live-operations");
    setSelectedRightRailTab("actions");
    setSavedRunStatus(`Replay loaded from start for ${record.name}. Press Play Replay to begin.`);
  }

  function handleReplayPlayPause() {
    setReplaySession((currentSession) =>
      currentSession
        ? {
            ...currentSession,
            isPlaying: currentSession.minute >= currentSession.sourceRun.currentMinute ? false : !currentSession.isPlaying,
          }
        : undefined,
    );
  }

  function handleReplayStep(minutes: number) {
    if (!replaySession) {
      return;
    }

    const nextMinute = Math.min(replaySession.sourceRun.currentMinute, Math.max(replaySession.sourceRun.shiftStartMinute, replaySession.minute + minutes));
    setRun(createReplayRun(replaySession.sourceRun, nextMinute));
    setReplaySession({
      ...replaySession,
      isPlaying: false,
      minute: nextMinute,
    });
  }

  function handleExitReplay() {
    if (!replaySession) {
      return;
    }

    setSelectedPatientId(undefined);
    setCoachDemoEnabled(false);
    setDraftTuning(replaySession.previousDraftTuning);
    setActiveTuning(replaySession.previousActiveTuning);
    setSelectedPresetId(replaySession.previousSelectedPresetId);
    setActiveDeck(replaySession.previousActiveDeck);
    setRun(replaySession.previousRun);
    setSavedRunStatus(`Exited replay for ${replaySession.record.name}.`);
    setReplaySession(undefined);
  }

  const hasPendingScenarioChanges =
    draftTuning.triageProviderMode !== activeTuning.triageProviderMode ||
    draftTuning.roomCapacity !== activeTuning.roomCapacity ||
    draftTuning.providerCount !== activeTuning.providerCount ||
    draftTuning.providerAssignmentMode !== activeTuning.providerAssignmentMode ||
    draftTuning.nurseCount !== activeTuning.nurseCount ||
    draftTuning.techCount !== activeTuning.techCount ||
    draftTuning.fastTrackEnabled !== activeTuning.fastTrackEnabled ||
    draftTuning.shiftDurationMinutes !== activeTuning.shiftDurationMinutes ||
    draftTuning.expectedArrivalsPerHour !== activeTuning.expectedArrivalsPerHour ||
    draftTuning.providerEvaluationTypicalMinutes !== activeTuning.providerEvaluationTypicalMinutes ||
    draftTuning.triageTypicalMinutes !== activeTuning.triageTypicalMinutes ||
    draftTuning.labTurnaroundTypicalMinutes !== activeTuning.labTurnaroundTypicalMinutes ||
    draftTuning.imagingTurnaroundTypicalMinutes !== activeTuning.imagingTurnaroundTypicalMinutes ||
    draftTuning.admissionDecisionTypicalMinutes !== activeTuning.admissionDecisionTypicalMinutes ||
    draftTuning.boardingDurationTypicalMinutes !== activeTuning.boardingDurationTypicalMinutes ||
    draftTuning.roomCleaningTypicalMinutes !== activeTuning.roomCleaningTypicalMinutes ||
    draftTuning.lwbsEnabled !== activeTuning.lwbsEnabled ||
    draftTuning.minimumWaitBeforeLWBS !== activeTuning.minimumWaitBeforeLWBS ||
    draftTuning.patientAcuityMix !== activeTuning.patientAcuityMix ||
    draftTuning.patientComplaintMix !== activeTuning.patientComplaintMix ||
    draftTuning.patientWorkupMix !== activeTuning.patientWorkupMix ||
    draftTuning.patientAdmissionMix !== activeTuning.patientAdmissionMix ||
    draftTuning.patientMixSeed !== activeTuning.patientMixSeed ||
    draftTuning.stemiDoorToEcgTargetMinutes !== activeTuning.stemiDoorToEcgTargetMinutes ||
    draftTuning.acsDoorToEcgTargetMinutes !== activeTuning.acsDoorToEcgTargetMinutes ||
    draftTuning.repeatTroponinDelayMinutes !== activeTuning.repeatTroponinDelayMinutes ||
    draftTuning.sepsisLactateCollectionMinutes !== activeTuning.sepsisLactateCollectionMinutes ||
    draftTuning.sepsisBloodCultureMinutes !== activeTuning.sepsisBloodCultureMinutes ||
    draftTuning.sepsisAntibioticsMinutes !== activeTuning.sepsisAntibioticsMinutes ||
    draftTuning.sepsisFluidsMinutes !== activeTuning.sepsisFluidsMinutes ||
    draftTuning.sepsisCriticalWaitMinutes !== activeTuning.sepsisCriticalWaitMinutes ||
    draftTuning.deteriorationGraceMinutes !== activeTuning.deteriorationGraceMinutes ||
    draftTuning.coachPriorityMode !== activeTuning.coachPriorityMode ||
    draftTuning.coachAcuityWeight !== activeTuning.coachAcuityWeight ||
    draftTuning.coachRiskWeight !== activeTuning.coachRiskWeight ||
    draftTuning.coachWaitWeight !== activeTuning.coachWaitWeight ||
    JSON.stringify(draftTuning.coachStrategyPriorityProfiles) !== JSON.stringify(activeTuning.coachStrategyPriorityProfiles);
  const isConfigurationReviewFocused = selectedSetupPanelTab === "scenario" || selectedSetupPanelTab === "calibration";

  return (
    <main className="appShell" data-theme={colorMode} data-tooltips={showTooltips ? "on" : "off"}>
      <header className="topBar">
        <div>
          <p className="eyebrow">Synthetic single-provider simulation</p>
          <h1>ED Provider Flow Board</h1>
        </div>
        <div className="clockPanel">
          <Clock size={18} />
          <span>{formatMinute(run.currentMinute)}</span>
          <small>{stateLabel(run.status)}</small>
        </div>
      </header>

      <section className="setupTabs" aria-label="Scenario and additional stats">
        <div className="setupTabList" role="tablist" aria-label="Scenario and additional stats">
          <button
            aria-label="Live Operations: control the simulation clock, view status messages, and monitor live operational metrics."
            aria-controls="live-operations-panel"
            aria-selected={selectedSetupPanelTab === "live-operations"}
            className={
              selectedSetupPanelTab === "live-operations" ? "active statusTooltip tabTooltip" : "statusTooltip tabTooltip"
            }
            data-tooltip="Control the simulation clock, run the coach demo, toggle metric groups and tooltips, and monitor live ED operational status."
            id="live-operations-tab"
            onClick={() => setSelectedSetupPanelTab("live-operations")}
            role="tab"
            type="button"
          >
            Live Operations
          </button>
          <button
            aria-label="Files: export the current run, import saved run files, replay saved runs, and export activity CSV files."
            aria-controls="files-panel"
            aria-selected={selectedSetupPanelTab === "files"}
            className={selectedSetupPanelTab === "files" ? "active statusTooltip tabTooltip" : "statusTooltip tabTooltip"}
            data-tooltip="Manage files for this simulation: export the current run, import saved run JSON files, replay or load imported runs, and export activity CSV data."
            id="files-tab"
            onClick={() => setSelectedSetupPanelTab("files")}
            role="tab"
            type="button"
          >
            Files
          </button>
          <button
            aria-label="Additional Stats: review detailed live metrics, workflow measures, and performance indicators."
            aria-controls="additional-stats-panel"
            aria-selected={selectedSetupPanelTab === "additional-stats"}
            className={
              selectedSetupPanelTab === "additional-stats" ? "active statusTooltip tabTooltip" : "statusTooltip tabTooltip"
            }
            data-tooltip="Review detailed live metrics, waiting-room risk, throughput, room use, boarding, LWBS, cardiac, and sepsis measures."
            id="additional-stats-tab"
            onClick={() => setSelectedSetupPanelTab("additional-stats")}
            role="tab"
            type="button"
          >
            Additional Stats
          </button>
          <button
            aria-label="Scenario Tuning: adjust simulation assumptions, staffing, room capacity, arrival patterns, and operational timing."
            aria-controls="scenario-setup-panel"
            aria-selected={selectedSetupPanelTab === "scenario"}
            className={selectedSetupPanelTab === "scenario" ? "active statusTooltip tabTooltip" : "statusTooltip tabTooltip"}
            data-tooltip="Adjust simulation assumptions such as arrival volume, provider staffing, nurse and tech capacity, rooms, triage, fast track, boarding, LWBS, and timing."
            id="scenario-setup-tab"
            onClick={() => setSelectedSetupPanelTab("scenario")}
            role="tab"
            type="button"
          >
            Scenario Tuning
          </button>
          <button
            aria-label="Model Assumptions: review which simulation assumptions use local values and which still need local data."
            aria-controls="calibration-panel"
            aria-selected={selectedSetupPanelTab === "calibration"}
            className={selectedSetupPanelTab === "calibration" ? "active statusTooltip tabTooltip" : "statusTooltip tabTooltip"}
            data-tooltip="Review Model Assumptions before running a scenario: local baseline values, draft changes, synthetic defaults, fixed v1 assumptions, and assumptions that still need local data."
            id="calibration-tab"
            onClick={() => setSelectedSetupPanelTab("calibration")}
            role="tab"
            type="button"
          >
            Model Assumptions
          </button>
        </div>

        {selectedSetupPanelTab === "live-operations" ? (
          <section
            aria-labelledby="live-operations-tab"
            className="liveOperationsPanel"
            id="live-operations-panel"
            role="tabpanel"
          >
            <section className="controlStrip" aria-label="Simulation controls">
              <div className="controlPrimaryRow">
                <button
                  aria-label={
                    run.status === "running"
                      ? "Pause the automatic simulation clock."
                      : "Start the simulation clock so patient arrivals and ED work begin."
                  }
                  className="primaryButton statusTooltip"
                  data-tooltip={
                    run.status === "running"
                      ? "Pause the automatic simulation clock. You can still review the board and make manual decisions."
                      : "Start the simulation clock. Patient arrivals, rooming, provider work, and operational events will begin."
                  }
                  type="button"
                  onClick={handleStartPause}
                  disabled={isReplayMode}
                >
                  {run.status === "running" ? <Pause size={18} /> : <Play size={18} />}
                  {run.status === "running" ? "Pause" : "Start"}
                </button>
                <button
                  aria-label="Advance the running simulation by one simulated minute."
                  className="statusTooltip"
                  data-tooltip="Move the running simulation ahead by 1 simulated minute. This is useful for stepping through short events."
                  type="button"
                  onClick={() => handleAdvance(1)}
                  disabled={isReplayMode || run.status !== "running"}
                >
                  <StepForward size={18} />
                  1 min
                </button>
                <button
                  aria-label="Advance the running simulation by five simulated minutes."
                  className="statusTooltip"
                  data-tooltip="Move the running simulation ahead by 5 simulated minutes. This is useful when you want to watch flow changes faster."
                  type="button"
                  onClick={() => handleAdvance(5)}
                  disabled={isReplayMode || run.status !== "running"}
                >
                  <StepForward size={18} />
                  5 min
                </button>
                <label
                  className="speedControl statusTooltip"
                  data-tooltip="Set how quickly the automatic clock runs. Lower values make each simulated minute pass faster."
                >
                  <span>Clock speed</span>
                  <input
                    aria-label="Auto clock seconds per simulated minute"
                    max={5}
                    min={1}
                    onChange={(event) => setAutoAdvanceSeconds(Number(event.currentTarget.value))}
                    step={1}
                    type="range"
                    value={autoAdvanceSeconds}
                  />
                  <strong>{autoAdvanceSeconds}s</strong>
                </label>
                <button
                  aria-label="Reset the simulation to its starting state."
                  className="statusTooltip"
                  data-tooltip="Reset the simulation back to the beginning and clear the current run state."
                  type="button"
                  onClick={handleReset}
                  disabled={isReplayMode}
                >
                  <RotateCcw size={18} />
                  Reset
                </button>
                <button
                  aria-label={
                    coachDemoEnabled
                      ? "Stop the coach demo automation."
                      : "Run the coach demo automation."
                  }
                  className={
                    coachDemoEnabled ? "coachDemoButton active statusTooltip" : "coachDemoButton statusTooltip"
                  }
                  data-tooltip={
                    coachDemoEnabled
                      ? "Stop the coach demo. Manual control remains available after the automated guidance stops."
                      : "Run an automated coach demo that advances through recommended actions for comparison and teaching."
                  }
                  type="button"
                  onClick={handleCoachDemoToggle}
                  disabled={isReplayMode || run.status === "shift_ended" || run.status === "completed"}
                >
                  {coachDemoEnabled ? <Pause size={18} /> : <Sparkles size={18} />}
                  {coachDemoEnabled ? "Stop Coach Demo" : "Run Coach Demo"}
                </button>
                <div
                  className="metricVisibilityControl statusTooltip"
                  data-tooltip="Choose which optional display aids are visible. These settings change the interface only; they do not change the simulation run."
                  role="group"
                  aria-label="Display Options"
                >
                  <span>Display Options</span>
                  <label>
                    <input
                      checked={showHeartMetrics}
                      onChange={(event) => setShowHeartMetrics(event.currentTarget.checked)}
                      type="checkbox"
                    />
                    <span>Heart Metrics</span>
                  </label>
                  <label>
                    <input
                      checked={showSepsisMetrics}
                      onChange={(event) => setShowSepsisMetrics(event.currentTarget.checked)}
                      type="checkbox"
                    />
                    <span>Sepsis Metrics</span>
                  </label>
                  <label>
                    <input
                      checked={showTooltips}
                      onChange={(event) => setShowTooltips(event.currentTarget.checked)}
                      type="checkbox"
                    />
                    <span>Tooltips</span>
                  </label>
                  <label>
                    <input
                      checked={colorMode === "dark"}
                      onChange={(event) => setColorMode(event.currentTarget.checked ? "dark" : "light")}
                      type="checkbox"
                    />
                    <span>{colorMode === "dark" ? "Dark Mode" : "Light Mode"}</span>
                  </label>
                </div>
              </div>
              {replaySession ? (
                <div className="replayControlPanel" aria-label="Replay controls">
                  <div>
                    <strong>Replay: {replaySession.record.name}</strong>
                    <span>
                      {formatMinute(replaySession.minute)} of {formatMinute(replaySession.sourceRun.currentMinute)}
                    </span>
                  </div>
                  <div className="replayActions">
                    <button
                      aria-label={replaySession.isPlaying ? "Pause replay playback." : "Play replay from the current minute."}
                      className="statusTooltip"
                      data-tooltip="Play or pause the saved run replay. Replay advances through the saved timeline without changing the saved run."
                      disabled={replaySession.minute >= replaySession.sourceRun.currentMinute}
                      onClick={handleReplayPlayPause}
                      type="button"
                    >
                      {replaySession.isPlaying ? <Pause size={18} /> : <Play size={18} />}
                      {replaySession.isPlaying ? "Pause Replay" : "Play Replay"}
                    </button>
                    <button
                      aria-label="Step replay forward by one simulated minute."
                      className="statusTooltip"
                      data-tooltip="Move the replay ahead by 1 saved simulated minute."
                      disabled={replaySession.minute >= replaySession.sourceRun.currentMinute}
                      onClick={() => handleReplayStep(1)}
                      type="button"
                    >
                      <StepForward size={18} />
                      1 min
                    </button>
                    <button
                      aria-label="Step replay forward by five simulated minutes."
                      className="statusTooltip"
                      data-tooltip="Move the replay ahead by 5 saved simulated minutes."
                      disabled={replaySession.minute >= replaySession.sourceRun.currentMinute}
                      onClick={() => handleReplayStep(5)}
                      type="button"
                    >
                      <StepForward size={18} />
                      5 min
                    </button>
                    <button
                      aria-label="Exit replay and return to the live working run."
                      className="statusTooltip"
                      data-tooltip="Exit replay and return to the run you were viewing before replay started."
                      onClick={handleExitReplay}
                      type="button"
                    >
                      <RotateCcw size={18} />
                      Exit Replay
                    </button>
                  </div>
                </div>
              ) : null}
              <div className="statusMessageRow">
                <div
                  aria-label="Automated front-end triage is managed separately from the ED provider. It can start protocol orders and move triaged patients into the waiting room."
                  className="providerStatus statusTooltip"
                  data-tooltip="Automated front-end triage is managed separately from the ED provider. It can start protocol orders and move triaged patients into the waiting room."
                  tabIndex={0}
                >
                  <ClipboardCheck size={18} />
                  <span>{triageProviderStatusText(run)}</span>
                </div>
                <div
                  aria-label="Shows how many ED providers are currently busy and when the next provider is available for patient evaluation or disposition work."
                  className="providerStatus statusTooltip"
                  data-tooltip="Shows how many ED providers are currently busy and when the next provider is available for patient evaluation or disposition work."
                  tabIndex={0}
                >
                  <Stethoscope size={18} />
                  <span>
                    Providers {run.providers.filter((provider) => provider.status === "busy").length}/{run.providers.length}{" "}
                    busy · {providerAvailabilityText(run)}
                  </span>
                </div>
                <div
                  aria-label="Shows nurse and tech support capacity currently tied up by rooming, protocol orders, and operational tasks."
                  className="providerStatus statusTooltip"
                  data-tooltip="Shows nurse and tech support capacity currently tied up by rooming, protocol orders, and operational tasks."
                  tabIndex={0}
                >
                  <Users size={18} />
                  <span>{supportResourceStatusText(run)}</span>
                </div>
                <div
                  aria-label="Shows hospitalist consult and admission acceptance status for admitted patients waiting on response."
                  className="providerStatus statusTooltip"
                  data-tooltip="Shows hospitalist consult and admission acceptance status for admitted patients. Pending consults can delay boarding and keep ED rooms occupied."
                  tabIndex={0}
                >
                  <UserRoundCheck size={18} />
                  <span>{hospitalistStatusText(run)}</span>
                </div>
                <div
                  aria-label="Shows whether the automatic simulation clock is running or paused and how many real seconds equal one simulated minute."
                  className="clockStatus statusTooltip"
                  data-tooltip="Shows whether the automatic simulation clock is running or paused and how many real seconds equal one simulated minute."
                  tabIndex={0}
                >
                  <Clock size={18} />
                  <span>
                    {run.status === "running"
                      ? `${coachDemoEnabled ? "Coach demo" : "Auto"}: 1 sim min / ${autoAdvanceSeconds} sec`
                      : `Auto paused: 1 sim min / ${autoAdvanceSeconds} sec`}
                  </span>
                </div>
              </div>
            </section>

            <section className="metricsGrid" aria-label="Live metrics">
              <div className="metricSectionRow" aria-label="Core live metrics">
                <Metric icon={<Activity size={18} />} label="Active Census" value={run.metrics.activePatientCensus} />
                <Metric icon={<StepForward size={18} />} label="Fast Track" value={run.metrics.fastTrackCensus} />
                <Metric icon={<TimerReset size={18} />} label="Recheck Due" value={run.metrics.reassessmentsOverdue} />
                <Metric
                  icon={<Clock size={18} />}
                  label="Longest Wait"
                  value={formatMinutesAndHours(run.metrics.longestCurrentWaitMinutes)}
                />
                <Metric
                  icon={<UserRoundCheck size={18} />}
                  label="Seen / Hour"
                  value={run.metrics.patientsSeenPerHour.toFixed(1)}
                />
                <Metric icon={<UserRoundCog size={18} />} label="Nurse/Tech" value={`${run.metrics.nursesBusy}/${run.metrics.techsBusy}`} />
                <Metric
                  icon={<ClipboardCheck size={18} />}
                  label="Results to Disp"
                  value={`${formatNumber(run.metrics.averageResultsReadyToDispositionMinutes)} min`}
                />
                <Metric icon={<Hourglass size={18} />} label="Admission Pending" value={run.metrics.admissionPendingCensus} />
                <Metric icon={<Bed size={18} />} label="Boarding Min" value={run.metrics.totalBoardingMinutes} />
                <Metric
                  icon={<CircleAlert size={18} />}
                  label="LWBS"
                  value={`${run.metrics.patientsLWBS} / ${(run.metrics.lwbsRate * 100).toFixed(1)}%`}
                />
              </div>
              {showHeartMetrics ? (
                <div className="metricSectionRow" aria-label="Heart metrics">
                  <Metric
                    className="cardiacMetric"
                    icon={<HeartPulse size={18} />}
                    label="Door ECG <=10"
                    value={`${(run.metrics.doorToEcgWithin10Rate * 100).toFixed(0)}%`}
                  />
                  <Metric
                    className="cardiacMetric"
                    icon={<HeartPulse size={18} />}
                    label="Median Door ECG"
                    value={`${formatNumber(run.metrics.medianDoorToEcgMinutes)} min`}
                  />
                  <Metric
                    className="cardiacMetric"
                    icon={<Clock size={18} />}
                    label="P90 Door ECG"
                    value={`${formatNumber(run.metrics.p90DoorToEcgMinutes)} min`}
                  />
                  <Metric
                    className="cardiacMetric"
                    icon={<ClipboardCheck size={18} />}
                    label="ECG Reviewed <=10"
                    value={`${(run.metrics.ecgReviewedWithin10Rate * 100).toFixed(0)}%`}
                  />
                  <Metric
                    className="cardiacMetric"
                    icon={<TestTube size={18} />}
                    label="Troponin TAT"
                    value={`${formatNumber(run.metrics.averageTroponinTurnaroundMinutes)} min`}
                  />
                  <Metric
                    className="cardiacMetric"
                    icon={<CircleAlert size={18} />}
                    label="Chest Pain LWBS"
                    value={`${run.metrics.chestPainLWBS} / ${(run.metrics.chestPainLWBSRate * 100).toFixed(0)}%`}
                  />
                </div>
              ) : null}
              {showSepsisMetrics ? (
                <div className="metricSectionRow" aria-label="Sepsis metrics">
                  <Metric
                    className="sepsisMetric"
                    icon={<Ambulance size={18} />}
                    label="Sepsis Rec <=10"
                    value={`${(run.metrics.sepsisRecognitionWithin10Rate * 100).toFixed(0)}%`}
                  />
                  <Metric
                    className="sepsisMetric"
                    icon={<Syringe size={18} />}
                    label="Door Antibiotics"
                    value={`${formatNumber(run.metrics.averageDoorToAntibioticsMinutes)} min`}
                  />
                  <Metric
                    className="sepsisMetric"
                    icon={<Syringe size={18} />}
                    label="Abx <=60"
                    value={`${(run.metrics.sepsisAntibioticsWithin60Rate * 100).toFixed(0)}%`}
                  />
                  <Metric
                    className="sepsisMetric"
                    icon={<Bed size={18} />}
                    label="Sepsis Waiting"
                    value={run.metrics.sepsisWaitingWithoutRoom}
                  />
                  <Metric
                    className="sepsisMetric"
                    icon={<CircleAlert size={18} />}
                    label="Sepsis LWBS"
                    value={`${run.metrics.sepsisLWBS} / ${(run.metrics.sepsisLWBSRate * 100).toFixed(0)}%`}
                  />
                </div>
              ) : null}
            </section>
          </section>
        ) : null}

        {selectedSetupPanelTab === "files" ? (
          <section aria-labelledby="files-tab" className="filesPanel" id="files-panel" role="tabpanel">
            <section className="filesPanelSection" aria-label="Run files">
              <h2>Run Files</h2>
              <SavedRunsPanel
                activeReplayRecordId={replaySession?.record.id}
                onDelete={handleDeleteSavedRun}
                onExportCurrentRun={handleExportCurrentRunFile}
                onImportFile={handleImportSavedRunsFile}
                onReplay={handleStartReplay}
                onRestore={handleRestoreSavedRun}
                records={savedRunRecords}
                status={savedRunStatus}
              />
            </section>
            <section className="filesPanelSection" aria-label="CSV exports">
              <h2>CSV Export</h2>
              <ExportPanel exportRuns={activityExportRuns} timeline={activityTimeline} />
            </section>
          </section>
        ) : null}

        {selectedSetupPanelTab === "scenario" ? (
          <section
            aria-labelledby="scenario-setup-tab"
            className="scenarioPanel"
            id="scenario-setup-panel"
            role="tabpanel"
          >
            <div className="scenarioPanelHeader">
              <div>
                <h2>Scenario Tuning</h2>
                <small>
                  {run.patients.length} synthetic patients, {activeTuning.roomCapacity} rooms,{" "}
                  {activeTuning.providerCount} provider{activeTuning.providerCount === 1 ? "" : "s"},{" "}
                  {activeTuning.providerAssignmentMode === "team"
                    ? "team model"
                    : activeTuning.providerAssignmentMode === "assigned"
                      ? "assigned model"
                      : "handoff model"},{" "}
                  {activeTuning.nurseCount} nurse{activeTuning.nurseCount === 1 ? "" : "s"},{" "}
                  {activeTuning.techCount} tech{activeTuning.techCount === 1 ? "" : "s"},{" "}
                  {activeTuning.fastTrackEnabled ? "Fast Track open" : "Fast Track closed"},{" "}
                  {activeTuning.shiftDurationMinutes} min simulation
                </small>
              </div>
              <div className="scenarioActions">
                <button type="button" onClick={handleApplyScenario} disabled={!hasPendingScenarioChanges}>
                  Apply scenario
                </button>
                <button type="button" onClick={handleRestoreDefaultTuning}>
                  Defaults
                </button>
              </div>
            </div>
            <div className="scenarioControls">
              <div className="scenarioTopControls">
                <div className="presetControl">
                  <span>Scenario preset</span>
                  <div className="presetButtonGroup" role="group" aria-label="Scenario preset">
                    {scenarioPresets.map((preset) => (
                      <button
                        aria-pressed={selectedPresetId === preset.id}
                        className={selectedPresetId === preset.id ? "active" : ""}
                        key={preset.id}
                        onClick={() => handlePresetChange(preset.id)}
                        type="button"
                      >
                        {preset.label}
                      </button>
                    ))}
                  </div>
                  <small>{scenarioPresets.find((preset) => preset.id === selectedPresetId)?.description}</small>
                </div>
                <div className="triageModeControl">
                  <span>Front-End Triage Provider</span>
                  <div className="triageModeButtonGroup" role="group" aria-label="Front-End Triage Provider mode">
                    {[
                      { label: "Unavailable", value: "unavailable" as const },
                      { label: "Manual", value: "manual" as const },
                      { label: "Automated", value: "automated" as const },
                    ].map((option) => (
                      <button
                        aria-pressed={draftTuning.triageProviderMode === option.value}
                        className={draftTuning.triageProviderMode === option.value ? "active" : ""}
                        key={option.value}
                        onClick={() => handleTriageProviderModeChange(option.value)}
                        type="button"
                      >
                        {option.label}
                      </button>
                    ))}
                  </div>
                  <small>
                    {draftTuning.triageProviderMode === "automated"
                      ? "Automated Provider"
                      : draftTuning.triageProviderMode === "manual"
                        ? "Manual Provider"
                        : "Provider Unavailable"}
                  </small>
                </div>
                <label className="roomCapacityControl">
                  <span>ED room capacity</span>
                  <input
                    min={1}
                    max={40}
                    onChange={(event) => updateDraftTuning("roomCapacity", Number(event.currentTarget.value))}
                    type="number"
                    value={draftTuning.roomCapacity}
                  />
                </label>
                <div className="providerCountControl">
                  <span>Providers</span>
                  <div className="providerButtonGroup" role="group" aria-label="Providers">
                    {[1, 2, 3, 4].map((count) => (
                      <button
                        aria-pressed={draftTuning.providerCount === count}
                        className={draftTuning.providerCount === count ? "active" : ""}
                        key={count}
                        onClick={() => updateDraftTuning("providerCount", count)}
                        type="button"
                      >
                        {count}
                      </button>
                    ))}
                  </div>
                </div>
                <div className="providerModelControl">
                  <span>Provider Model</span>
                  <div className="providerModelButtonGroup" role="group" aria-label="Provider assignment model">
                    {[
                      { label: "Team", value: "team" as const },
                      { label: "Assigned", value: "assigned" as const },
                      { label: "Handoff", value: "assigned_with_handoff" as const },
                    ].map((option) => (
                      <button
                        aria-pressed={draftTuning.providerAssignmentMode === option.value}
                        className={`${draftTuning.providerAssignmentMode === option.value ? "active" : ""} ${
                          option.value === "assigned_with_handoff" ? "wide" : ""
                        }`.trim()}
                        key={option.value}
                        onClick={() => updateDraftTuning("providerAssignmentMode", option.value)}
                        type="button"
                      >
                        {option.label}
                      </button>
                    ))}
                  </div>
                  <small>
                    {draftTuning.providerAssignmentMode === "team"
                      ? "Any provider may act"
                      : draftTuning.providerAssignmentMode === "assigned"
                        ? "Owner only"
                        : "Owner preferred"}
                  </small>
                </div>
                <div className="supportCountControl nurseCountControl">
                  <span>Nurses</span>
                  <div className="supportButtonGroup" role="group" aria-label="Nurse count">
                    {[1, 2, 3, 4].map((count) => (
                      <button
                        aria-pressed={draftTuning.nurseCount === count}
                        className={draftTuning.nurseCount === count ? "active" : ""}
                        key={count}
                        onClick={() => updateDraftTuning("nurseCount", count)}
                        type="button"
                      >
                        {count}
                      </button>
                    ))}
                  </div>
                </div>
                <div className="supportCountControl techCountControl">
                  <span>Techs</span>
                  <div className="supportButtonGroup" role="group" aria-label="Tech count">
                    {[0, 1, 2].map((count) => (
                      <button
                        aria-pressed={draftTuning.techCount === count}
                        className={draftTuning.techCount === count ? "active" : ""}
                        key={count}
                        onClick={() => updateDraftTuning("techCount", count)}
                        type="button"
                      >
                        {count}
                      </button>
                    ))}
                  </div>
                </div>
                <div className="shiftLengthControl">
                  <span>Simulation length</span>
                  <div className="shiftButtonGroup" role="group" aria-label="Simulation length">
                    {[
                      { label: "2 hr", value: 120 },
                      { label: "4 hr", value: 240 },
                      { label: "8 hr", value: 480 },
                      { label: "12 hr", value: 720 },
                      { label: "24 hr", value: 1440 },
                      { label: "48 hr", value: 2880 },
                    ].map((option) => (
                      <button
                        aria-label={`${option.label.replace(" hr", "")} hour simulation length`}
                        aria-pressed={draftTuning.shiftDurationMinutes === option.value}
                        className={draftTuning.shiftDurationMinutes === option.value ? "active" : ""}
                        key={option.value}
                        onClick={() => updateDraftTuning("shiftDurationMinutes", option.value)}
                        type="button"
                      >
                        {option.label}
                      </button>
                    ))}
                  </div>
                </div>
                <label className="toggleControl scenarioToggle fastTrackToggleControl">
                  <span>Fast Track</span>
                  <input
                    checked={draftTuning.fastTrackEnabled}
                    onChange={(event) => updateDraftTuning("fastTrackEnabled", event.currentTarget.checked)}
                    type="checkbox"
                  />
                  <small>{draftTuning.fastTrackEnabled ? "Open" : "Closed"}</small>
                </label>
                <label className="toggleControl scenarioToggle lwbsToggleControl">
                  <span>LWBS</span>
                  <input
                    checked={draftTuning.lwbsEnabled}
                    onChange={(event) => updateDraftTuning("lwbsEnabled", event.currentTarget.checked)}
                    type="checkbox"
                  />
                  <small>{draftTuning.lwbsEnabled ? "Enabled" : "Disabled"}</small>
                </label>
              </div>
              <div className="scenarioBottomControls">
                <label>
                  <span>Arrivals / hour</span>
                  <input
                    min={0}
                    max={30}
                    onChange={(event) => updateDraftTuning("expectedArrivalsPerHour", Number(event.currentTarget.value))}
                    type="number"
                    value={draftTuning.expectedArrivalsPerHour}
                  />
                  <small className={`scenarioAssumptionStatus ${calibrationStatusFor("expectedArrivalsPerHour", draftTuning, activeTuning)}`}>
                    {scenarioAssumptionStatusLabel("expectedArrivalsPerHour", draftTuning, activeTuning)}
                  </small>
                </label>
                <label>
                  <span>Provider eval typical</span>
                  <input
                    min={1}
                    max={90}
                    onChange={(event) => updateDraftTuning("providerEvaluationTypicalMinutes", Number(event.currentTarget.value))}
                    type="number"
                    value={draftTuning.providerEvaluationTypicalMinutes}
                  />
                  <small className={`scenarioAssumptionStatus ${calibrationStatusFor("providerEvaluationTypicalMinutes", draftTuning, activeTuning)}`}>
                    {scenarioAssumptionStatusLabel("providerEvaluationTypicalMinutes", draftTuning, activeTuning)}
                  </small>
                </label>
                <label>
                  <span>Triage typical</span>
                  <input
                    min={1}
                    max={30}
                    onChange={(event) => updateDraftTuning("triageTypicalMinutes", Number(event.currentTarget.value))}
                    type="number"
                    value={draftTuning.triageTypicalMinutes}
                  />
                  <small className={`scenarioAssumptionStatus ${calibrationStatusFor("triageTypicalMinutes", draftTuning, activeTuning)}`}>
                    {scenarioAssumptionStatusLabel("triageTypicalMinutes", draftTuning, activeTuning)}
                  </small>
                </label>
                <label>
                  <span>Lab TAT typical</span>
                  <input
                    min={1}
                    max={240}
                    onChange={(event) => updateDraftTuning("labTurnaroundTypicalMinutes", Number(event.currentTarget.value))}
                    step={5}
                    type="number"
                    value={draftTuning.labTurnaroundTypicalMinutes}
                  />
                  <small className={`scenarioAssumptionStatus ${calibrationStatusFor("labTurnaroundTypicalMinutes", draftTuning, activeTuning)}`}>
                    {scenarioAssumptionStatusLabel("labTurnaroundTypicalMinutes", draftTuning, activeTuning)}
                  </small>
                </label>
                <label>
                  <span>Imaging TAT typical</span>
                  <input
                    min={1}
                    max={300}
                    onChange={(event) => updateDraftTuning("imagingTurnaroundTypicalMinutes", Number(event.currentTarget.value))}
                    step={5}
                    type="number"
                    value={draftTuning.imagingTurnaroundTypicalMinutes}
                  />
                  <small className={`scenarioAssumptionStatus ${calibrationStatusFor("imagingTurnaroundTypicalMinutes", draftTuning, activeTuning)}`}>
                    {scenarioAssumptionStatusLabel("imagingTurnaroundTypicalMinutes", draftTuning, activeTuning)}
                  </small>
                </label>
                <label>
                  <span>Hospitalist response typical</span>
                  <input
                    min={1}
                    max={360}
                    onChange={(event) => updateDraftTuning("admissionDecisionTypicalMinutes", Number(event.currentTarget.value))}
                    step={5}
                    type="number"
                    value={draftTuning.admissionDecisionTypicalMinutes}
                  />
                  <small className={`scenarioAssumptionStatus ${calibrationStatusFor("admissionDecisionTypicalMinutes", draftTuning, activeTuning)}`}>
                    {scenarioAssumptionStatusLabel("admissionDecisionTypicalMinutes", draftTuning, activeTuning)}
                  </small>
                </label>
                <label>
                  <span>Boarding typical</span>
                  <input
                    min={0}
                    max={720}
                    onChange={(event) => updateDraftTuning("boardingDurationTypicalMinutes", Number(event.currentTarget.value))}
                    step={5}
                    type="number"
                    value={draftTuning.boardingDurationTypicalMinutes}
                  />
                  <small className={`scenarioAssumptionStatus ${calibrationStatusFor("boardingDurationTypicalMinutes", draftTuning, activeTuning)}`}>
                    {scenarioAssumptionStatusLabel("boardingDurationTypicalMinutes", draftTuning, activeTuning)}
                  </small>
                </label>
                <label>
                  <span>Room clean typical</span>
                  <input
                    min={0}
                    max={180}
                    onChange={(event) => updateDraftTuning("roomCleaningTypicalMinutes", Number(event.currentTarget.value))}
                    step={5}
                    type="number"
                    value={draftTuning.roomCleaningTypicalMinutes}
                  />
                  <small className={`scenarioAssumptionStatus ${calibrationStatusFor("roomCleaningTypicalMinutes", draftTuning, activeTuning)}`}>
                    {scenarioAssumptionStatusLabel("roomCleaningTypicalMinutes", draftTuning, activeTuning)}
                  </small>
                </label>
                <label>
                  <span>Minimum wait before LWBS</span>
                  <input
                    min={0}
                    max={360}
                    onChange={(event) => updateDraftTuning("minimumWaitBeforeLWBS", Number(event.currentTarget.value))}
                    step={5}
                    type="number"
                    value={draftTuning.minimumWaitBeforeLWBS}
                  />
                  <small className={`scenarioAssumptionStatus ${calibrationStatusFor("minimumWaitBeforeLWBS", draftTuning, activeTuning)}`}>
                    {scenarioAssumptionStatusLabel("minimumWaitBeforeLWBS", draftTuning, activeTuning)}
                  </small>
                </label>
              </div>
              <section className="patientMixControls" aria-label="Patient Mix v1">
                <div className="patientMixHeader coachRulesHeader">
                  <div>
                    <h3>Patient Mix</h3>
                    <small>Adjust the synthetic deck while keeping each seed deterministic for replay and comparison.</small>
                  </div>
                  <label>
                    <span>Deck seed</span>
                    <input
                      min={1}
                      max={9999}
                      onChange={(event) => updateDraftTuning("patientMixSeed", Number(event.currentTarget.value))}
                      type="number"
                      value={draftTuning.patientMixSeed}
                    />
                    <small className={`scenarioAssumptionStatus ${calibrationStatusFor("patientMixSeed", draftTuning, activeTuning)}`}>
                      {scenarioAssumptionStatusLabel("patientMixSeed", draftTuning, activeTuning)}
                    </small>
                  </label>
                </div>
                <div className="patientMixGrid">
                  <div className="patientMixGroup">
                    <span>Acuity mix</span>
                    <div className="patientMixButtonGroup" role="group" aria-label="Acuity mix">
                      {[
                        { label: "Standard", value: "standard" as const },
                        { label: "Higher", value: "higher_acuity" as const },
                        { label: "Lower", value: "lower_acuity" as const },
                      ].map((option) => (
                        <button
                          aria-pressed={draftTuning.patientAcuityMix === option.value}
                          className={draftTuning.patientAcuityMix === option.value ? "active" : ""}
                          key={option.value}
                          onClick={() => updateDraftTuning("patientAcuityMix", option.value)}
                          type="button"
                        >
                          {option.label}
                        </button>
                      ))}
                    </div>
                    <small className={`scenarioAssumptionStatus ${calibrationStatusFor("patientAcuityMix", draftTuning, activeTuning)}`}>
                      {scenarioAssumptionStatusLabel("patientAcuityMix", draftTuning, activeTuning)}
                    </small>
                  </div>
                  <div className="patientMixGroup">
                    <span>Complaint mix</span>
                    <div className="patientMixButtonGroup four" role="group" aria-label="Complaint mix">
                      {[
                        { label: "Balanced", value: "balanced" as const },
                        { label: "Cardiac", value: "cardiac" as const },
                        { label: "Infection", value: "infection" as const },
                        { label: "Injury/minor", value: "injury_minor" as const },
                      ].map((option) => (
                        <button
                          aria-pressed={draftTuning.patientComplaintMix === option.value}
                          className={draftTuning.patientComplaintMix === option.value ? "active" : ""}
                          key={option.value}
                          onClick={() => updateDraftTuning("patientComplaintMix", option.value)}
                          type="button"
                        >
                          {option.label}
                        </button>
                      ))}
                    </div>
                    <small className={`scenarioAssumptionStatus ${calibrationStatusFor("patientComplaintMix", draftTuning, activeTuning)}`}>
                      {scenarioAssumptionStatusLabel("patientComplaintMix", draftTuning, activeTuning)}
                    </small>
                  </div>
                  <div className="patientMixGroup">
                    <span>Workup intensity</span>
                    <div className="patientMixButtonGroup" role="group" aria-label="Workup intensity">
                      {[
                        { label: "Standard", value: "standard" as const },
                        { label: "Higher", value: "higher_workup" as const },
                        { label: "Lower", value: "lower_workup" as const },
                      ].map((option) => (
                        <button
                          aria-pressed={draftTuning.patientWorkupMix === option.value}
                          className={draftTuning.patientWorkupMix === option.value ? "active" : ""}
                          key={option.value}
                          onClick={() => updateDraftTuning("patientWorkupMix", option.value)}
                          type="button"
                        >
                          {option.label}
                        </button>
                      ))}
                    </div>
                    <small className={`scenarioAssumptionStatus ${calibrationStatusFor("patientWorkupMix", draftTuning, activeTuning)}`}>
                      {scenarioAssumptionStatusLabel("patientWorkupMix", draftTuning, activeTuning)}
                    </small>
                  </div>
                  <div className="patientMixGroup">
                    <span>Admission pressure</span>
                    <div className="patientMixButtonGroup" role="group" aria-label="Admission pressure">
                      {[
                        { label: "Standard", value: "standard" as const },
                        { label: "Higher", value: "higher_admit" as const },
                        { label: "Lower", value: "lower_admit" as const },
                      ].map((option) => (
                        <button
                          aria-pressed={draftTuning.patientAdmissionMix === option.value}
                          className={draftTuning.patientAdmissionMix === option.value ? "active" : ""}
                          key={option.value}
                          onClick={() => updateDraftTuning("patientAdmissionMix", option.value)}
                          type="button"
                        >
                          {option.label}
                        </button>
                      ))}
                    </div>
                    <small className={`scenarioAssumptionStatus ${calibrationStatusFor("patientAdmissionMix", draftTuning, activeTuning)}`}>
                      {scenarioAssumptionStatusLabel("patientAdmissionMix", draftTuning, activeTuning)}
                    </small>
                  </div>
                </div>
              </section>
              <section className="patientMixControls" aria-label="Workflow Rules">
                <div className="patientMixHeader">
                  <div>
                    <h3>Workflow Rules</h3>
                    <small>Tune built-in v1 cardiac, sepsis, and waiting-room safety timing assumptions.</small>
                  </div>
                </div>
                <div className="scenarioBottomControls workflowRuleControls">
                  {[
                    { field: "stemiDoorToEcgTargetMinutes" as const, label: "STEMI ECG target", max: 30, min: 1, step: 1 },
                    { field: "acsDoorToEcgTargetMinutes" as const, label: "ACS ECG target", max: 30, min: 1, step: 1 },
                    { field: "repeatTroponinDelayMinutes" as const, label: "Repeat troponin delay", max: 240, min: 15, step: 5 },
                    { field: "sepsisLactateCollectionMinutes" as const, label: "Lactate collection", max: 60, min: 1, step: 1 },
                    { field: "sepsisBloodCultureMinutes" as const, label: "Blood cultures", max: 60, min: 1, step: 1 },
                    { field: "sepsisAntibioticsMinutes" as const, label: "Antibiotics", max: 180, min: 1, step: 5 },
                    { field: "sepsisFluidsMinutes" as const, label: "IV fluids", max: 180, min: 1, step: 5 },
                    { field: "sepsisCriticalWaitMinutes" as const, label: "Sepsis critical wait", max: 120, min: 1, step: 5 },
                    { field: "deteriorationGraceMinutes" as const, label: "Deterioration grace", max: 180, min: 1, step: 5 },
                  ].map((item) => (
                    <label key={item.field}>
                      <span>{item.label}</span>
                      <input
                        min={item.min}
                        max={item.max}
                        onChange={(event) => updateDraftTuning(item.field, Number(event.currentTarget.value))}
                        step={item.step}
                        type="number"
                        value={draftTuning[item.field]}
                      />
                      <small className={`scenarioAssumptionStatus ${calibrationStatusFor(item.field, draftTuning, activeTuning)}`}>
                        {scenarioAssumptionStatusLabel(item.field, draftTuning, activeTuning)}
                      </small>
                    </label>
                  ))}
                </div>
              </section>
              <section className="patientMixControls" aria-label="Default Coach Benchmark Rules">
                <div className="patientMixHeader">
                  <div>
                    <h3>Default Coach Rules</h3>
                    <small>
                      Tune the live Coach and Optimal Flow Coach. Use Comparison Coach Rules below for the other strategy coaches.
                    </small>
                  </div>
                  <label className="coachRulesVisibilityToggle">
                    <input
                      checked={showAllCoachRules}
                      onChange={(event) => setShowAllCoachRules(event.currentTarget.checked)}
                      type="checkbox"
                    />
                    <span>{showAllCoachRules ? "Hide All Coach Rules" : "Show All Coach Rules"}</span>
                  </label>
                </div>
                <div className="coachStrategyRuleGrid single">
                  <div className="coachStrategyRuleRow">
                    <div className="coachStrategyRuleTitle">
                      <strong>Default / Optimal Flow</strong>
                      <small className={`scenarioAssumptionStatus ${calibrationStatusFor("coachPriorityMode", draftTuning, activeTuning)}`}>
                        {scenarioAssumptionStatusLabel("coachPriorityMode", draftTuning, activeTuning)}
                      </small>
                    </div>
                    <div className="coachStrategyBehaviorPanel compact">
                      <span>Strategy Behavior</span>
                      <ul>
                        {coachStrategyBehaviorDetails("default").map((detail) => (
                          <li key={detail}>{detail}</li>
                        ))}
                      </ul>
                    </div>
                    <div className="patientMixButtonGroup four" role="group" aria-label="Default Coach priority mode">
                      {[
                        { label: "Balanced", value: "balanced" as const },
                        { label: "Safety", value: "safety_first" as const },
                        { label: "Throughput", value: "throughput" as const },
                        { label: "Front-end", value: "front_end" as const },
                      ].map((option) => (
                        <button
                          aria-pressed={draftTuning.coachPriorityMode === option.value}
                          className={draftTuning.coachPriorityMode === option.value ? "active" : ""}
                          key={option.value}
                          onClick={() => updateDraftTuning("coachPriorityMode", option.value)}
                          type="button"
                        >
                          {option.label}
                        </button>
                      ))}
                    </div>
                    <div className="coachStrategyWeightGrid">
                    {[
                      { field: "coachAcuityWeight" as const, label: "ESI Acuity Weight", max: 2000, min: 0, step: 50 },
                      { field: "coachRiskWeight" as const, label: "Risk Weight", max: 500, min: 0, step: 25 },
                      { field: "coachWaitWeight" as const, label: "Wait Minute Weight", max: 10, min: 0, step: 0.5 },
                    ].map((item) => (
                      <label key={item.field}>
                        <span>{item.label}</span>
                        <input
                          min={item.min}
                          max={item.max}
                          onChange={(event) => updateDraftTuning(item.field, Number(event.currentTarget.value))}
                          step={item.step}
                          type="number"
                          value={draftTuning[item.field]}
                        />
                      </label>
                    ))}
                    </div>
                  </div>
                </div>
                {!showAllCoachRules ? (
                  <div className="coachRulesCollapsedNotice">
                    Comparison Coach Rules are hidden. Check Show All Coach Rules to edit the other coach profiles.
                  </div>
                ) : null}
              </section>
              {showAllCoachRules ? (
              <section className="patientMixControls" aria-label="Comparison Coach Rules">
                <div className="patientMixHeader">
                  <div>
                    <h3>Comparison Coach Rules</h3>
                    <small>Tune each Coach Comparison strategy profile independently before running the scenario.</small>
                  </div>
                </div>
                <div className="coachStrategyRuleGrid">
                  {coachComparisonStrategyIds.map((strategyId) => {
                    const profile = draftTuning.coachStrategyPriorityProfiles[strategyId];
                    const status = coachPriorityProfileStatus(strategyId, draftTuning, activeTuning);

                    return (
                      <div className="coachStrategyRuleRow" key={strategyId}>
                        <div className="coachStrategyRuleTitle">
                          <strong>{coachComparisonStrategyLabel(strategyId)}</strong>
                          <small className={`scenarioAssumptionStatus ${status}`}>{calibrationStatusLabel(status)}</small>
                        </div>
                        <div className="coachStrategyBehaviorPanel compact">
                          <span>Strategy Behavior</span>
                          <ul>
                            {coachStrategyBehaviorDetails(strategyId).map((detail) => (
                              <li key={detail}>{detail}</li>
                            ))}
                          </ul>
                        </div>
                        <div className="patientMixButtonGroup four" role="group" aria-label={`${coachComparisonStrategyLabel(strategyId)} priority mode`}>
                          {[
                            { label: "Balanced", value: "balanced" as const },
                            { label: "Safety", value: "safety_first" as const },
                            { label: "Throughput", value: "throughput" as const },
                            { label: "Front-end", value: "front_end" as const },
                          ].map((option) => (
                            <button
                              aria-pressed={profile.mode === option.value}
                              className={profile.mode === option.value ? "active" : ""}
                              key={option.value}
                              onClick={() => updateDraftCoachStrategyProfile(strategyId, "mode", option.value)}
                              type="button"
                            >
                              {option.label}
                            </button>
                          ))}
                        </div>
                        <div className="coachStrategyWeightGrid">
                          {[
                            { field: "acuityWeight" as const, label: "ESI Acuity Weight", max: 2000, min: 0, step: 50 },
                            { field: "riskWeight" as const, label: "Risk Weight", max: 500, min: 0, step: 25 },
                            { field: "waitWeight" as const, label: "Wait Minute Weight", max: 10, min: 0, step: 0.5 },
                          ].map((item) => (
                            <label key={item.field}>
                              <span>{item.label}</span>
                              <input
                                min={item.min}
                                max={item.max}
                                onChange={(event) => updateDraftCoachStrategyProfile(strategyId, item.field, Number(event.currentTarget.value))}
                                step={item.step}
                                type="number"
                                value={profile[item.field]}
                              />
                            </label>
                          ))}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </section>
              ) : null}
            </div>
          </section>
        ) : null}

        {selectedSetupPanelTab === "calibration" ? (
          <section aria-labelledby="calibration-tab" className="calibrationPanel" id="calibration-panel" role="tabpanel">
            <div className="calibrationHeader">
              <div>
                <h2>Model Assumptions</h2>
                <small>
                  {localCalibrationCount} local value{localCalibrationCount === 1 ? "" : "s"},{" "}
                  {draftCalibrationCount} draft change{draftCalibrationCount === 1 ? "" : "s"},{" "}
                  {needsCalibrationDataCount} area{needsCalibrationDataCount === 1 ? "" : "s"} still needing local data
                </small>
              </div>
              <div className="calibrationActions">
                <button type="button" onClick={handleApplyLocalBaselineTuning} disabled={isReplayMode}>
                  Use Local Baseline
                </button>
                <button type="button" onClick={() => setSelectedSetupPanelTab("scenario")}>
                  Edit Scenario
                </button>
              </div>
            </div>
            <div className="calibrationSummary" aria-label="Model assumptions summary">
              <div>
                <span>Local Values</span>
                <strong>{localCalibrationCount}</strong>
                <small>Applied scenario values that differ from default assumptions.</small>
              </div>
              <div>
                <span>Draft Changes</span>
                <strong>{draftCalibrationCount}</strong>
                <small>Edited values waiting for Apply scenario.</small>
              </div>
              <div>
                <span>Needs Local Data</span>
                <strong>{needsCalibrationDataCount}</strong>
                <small>Model areas still driven by synthetic distributions.</small>
              </div>
              <div>
                <span>Fixed v1</span>
                <strong>{calibrationItems.filter((item) => item.status === "fixed").length}</strong>
                <small>Assumptions documented but not yet editable.</small>
              </div>
            </div>
            <div className="calibrationNotice">
              <strong>Model assumptions scope</strong>
              <p>
                Providers should review these assumptions before using a scenario. This screen explains what is local,
                what is synthetic, and what is fixed in v1; it does not claim clinical validation or benchmarking
                against real ED outcomes.
              </p>
            </div>
            <div className="calibrationTable" role="table" aria-label="Model assumptions">
              <div className="calibrationTableHeader" role="row">
                <span role="columnheader">Area</span>
                <span role="columnheader">Assumption</span>
                <span role="columnheader">Current value</span>
                <span role="columnheader">Status</span>
              </div>
              {calibrationItems.map((item) => (
                <div className="calibrationTableRow" role="row" key={`${item.area}-${item.assumption}`}>
                  <span role="cell">{item.area}</span>
                  <span role="cell">
                    <strong>{item.assumption}</strong>
                    <small>{item.source}</small>
                  </span>
                  <span role="cell">{item.currentValue}</span>
                  <span role="cell">
                    <mark className={`calibrationBadge ${item.status}`}>
                      {calibrationStatusLabel(item.status)}
                    </mark>
                  </span>
                </div>
              ))}
            </div>
          </section>
        ) : null}

        {selectedSetupPanelTab === "additional-stats" ? (
          <section
            aria-labelledby="additional-stats-tab"
            className="coreMetricTabs"
            id="additional-stats-panel"
            role="tabpanel"
          >
            <div className="tabList" role="tablist" aria-label="Core live metrics">
              {coreMetrics.map((metric) => (
                <button
                  aria-controls={`${metric.id}-panel`}
                  aria-selected={metric.id === selectedCoreMetric.id}
                  className={metric.id === selectedCoreMetric.id ? "active" : ""}
                  id={`${metric.id}-tab`}
                  key={metric.id}
                  onClick={() => setSelectedCoreMetricId(metric.id)}
                  role="tab"
                  type="button"
                >
                  {metric.label}
                </button>
              ))}
            </div>
            <div
              aria-labelledby={`${selectedCoreMetric.id}-tab`}
              className="tabPanel"
              id={`${selectedCoreMetric.id}-panel`}
              role="tabpanel"
            >
              <dl
                aria-label={`${selectedCoreMetric.label} measures`}
                className="tabMeasures"
                style={tabMeasureGridStyle(selectedCoreMetric.measures.length)}
              >
                {selectedCoreMetric.measures.map((measure) => (
                  <div
                    aria-label={`${measure.label}: ${metricTooltip(measure.label)}`}
                    className="statusTooltip"
                    data-tooltip={metricTooltip(measure.label)}
                    key={measure.label}
                    tabIndex={0}
                  >
                    <dt>
                      {tabMeasureIcon(measure.label)}
                      <span>{measure.label}</span>
                    </dt>
                    <dd>{measure.value}</dd>
                  </div>
                ))}
              </dl>
            </div>
          </section>
        ) : null}
      </section>

      {!isConfigurationReviewFocused ? (
        <>
          <section className="providerRoster" aria-label="Provider status">
            {run.providers.map((provider) => {
              const suggestion = providerSuggestions.get(provider.id);
              const workLines = providerCurrentWorkLines(provider, suggestion);
              const locationLines = providerLocationLines(provider, run, suggestion);
              const availabilityLines = providerNextAvailableLines(provider);
              return (
                <article className="providerRosterCard" key={provider.id}>
                  <div className="providerRosterHeader">
                    <strong>{provider.displayName}</strong>
                    <span className={`providerRosterBadge ${provider.status}`}>{provider.status}</span>
                  </div>
                  <div className="providerRosterDetails">
                    <small>
                      <span>{workLines.label}</span>
                      {workLines.value ? <strong>{workLines.value}</strong> : null}
                    </small>
                    <small>
                      <span>{locationLines.label}</span>
                      {locationLines.value ? <strong>{locationLines.value}</strong> : null}
                    </small>
                    <small>
                      <span>{availabilityLines.label}</span>
                      <strong>{availabilityLines.value}</strong>
                    </small>
                  </div>
                </article>
              );
            })}
          </section>

          <section className="patientStatusPanel" aria-label="Selected patient status">
            <div className="patientStatusHeader">
              <h2>Patient Status</h2>
              <span>{selectedPatient ? selectedPatient.id : "No patient selected"}</span>
            </div>
            {selectedPatient ? (
              <PatientDetails currentMinute={run.currentMinute} patient={selectedPatient} />
            ) : (
              <p className="emptyState">Select a patient card.</p>
            )}
          </section>

          <section className="mainViewShell" aria-label="Simulation views">
        <div className="mainViewTabs" role="tablist" aria-label="Simulation view">
          <button
            aria-label="Workflow: View patient flow, room assignments, active patient cards, and operational actions."
            aria-controls="workflow-view-panel"
            aria-selected={selectedMainViewTab === "workflow"}
            className={selectedMainViewTab === "workflow" ? "active statusTooltip tabTooltip" : "statusTooltip tabTooltip"}
            data-tooltip="View the active ED workflow: waiting patients, rooms, patient cards, status, and operational actions."
            id="workflow-view-tab"
            onClick={() => setSelectedMainViewTab("workflow")}
            role="tab"
            type="button"
          >
            Workflow
          </button>
          <button
            aria-label="Facility Setup: View room capacity, room status, waiting room counts, triage, fast track, admissions, and boarding."
            aria-controls="facility-view-panel"
            aria-selected={selectedMainViewTab === "facility"}
            className={selectedMainViewTab === "facility" ? "active statusTooltip tabTooltip" : "statusTooltip tabTooltip"}
            data-tooltip="View facility capacity and location status: available rooms, occupied rooms, blocked rooms, waiting room, triage, fast track, admissions, and boarding."
            id="facility-view-tab"
            onClick={() => setSelectedMainViewTab("facility")}
            role="tab"
            type="button"
          >
            Facility Setup
          </button>
          <button
            aria-label="Benchmark: Compare the current run against an optimal-flow benchmark. This may take a moment to calculate when opened."
            aria-controls="benchmark-view-panel"
            aria-selected={selectedMainViewTab === "benchmark"}
            className={selectedMainViewTab === "benchmark" ? "active statusTooltip tabTooltip" : "statusTooltip tabTooltip"}
            data-tooltip="Compare the current run against an optimal-flow benchmark. This may take a moment to calculate when the tab is opened, so results may appear after a short pause."
            id="benchmark-view-tab"
            onClick={() => setSelectedMainViewTab("benchmark")}
            role="tab"
            type="button"
          >
            Benchmark
          </button>
          <button
            aria-label="Coach Comparison: Compare coach strategies and recommendations. This may take a moment to calculate when opened."
            aria-controls="coach-comparison-view-panel"
            aria-selected={selectedMainViewTab === "coach-comparison"}
            className={
              selectedMainViewTab === "coach-comparison" ? "active statusTooltip tabTooltip" : "statusTooltip tabTooltip"
            }
            data-tooltip="Compare the provider run against coach strategy options and recommendations. This may take a moment to calculate when opened, especially after the run has many events."
            id="coach-comparison-view-tab"
            onClick={() => setSelectedMainViewTab("coach-comparison")}
            role="tab"
            type="button"
          >
            Coach Comparison
          </button>
          <button
            aria-label="Graphs: View trend charts for ED volume, waits, rooms, boarding, and throughput over time."
            aria-controls="graphs-view-panel"
            aria-selected={selectedMainViewTab === "graphs"}
            className={selectedMainViewTab === "graphs" ? "active statusTooltip tabTooltip" : "statusTooltip tabTooltip"}
            data-tooltip="View trend charts for ED volume, waits, room status, boarding, throughput, and LWBS over simulated time."
            id="graphs-view-tab"
            onClick={() => setSelectedMainViewTab("graphs")}
            role="tab"
            type="button"
          >
            Graphs
          </button>
        </div>

        {selectedMainViewTab === "workflow" ? (
          <section
            aria-labelledby="workflow-view-tab"
            className="mainViewPanel workspace"
            id="workflow-view-panel"
            role="tabpanel"
          >
            <div className="board" aria-label="ED board">
              {boardColumns.map((column) => {
                const patients = run.patients.filter((patient) => column.states.includes(patient.state));
                return (
                  <section className="boardColumn" key={column.title}>
                    <div className="columnHeader">
                      <h2>{column.title}</h2>
                      <span>{patients.length}</span>
                    </div>
                    <div className="patientList">
                      {patients.map((patient) => (
                        <PatientCard
                          currentMinute={run.currentMinute}
                          isCoachRecommended={patient.id === coachRecommendation?.patientId}
                          isSelected={patient.id === selectedPatientId}
                          key={patient.id}
                          onSelect={() => setSelectedPatientId(patient.id)}
                          patient={patient}
                        />
                      ))}
                    </div>
                  </section>
                );
              })}
            </div>

            <aside className="sidePanel">
              <div className="rightRailTabs" role="tablist" aria-label="Provider tools">
                <button
                  aria-label="Actions: show provider actions available for the selected patient and current ED state."
                  aria-controls="right-rail-actions"
                  aria-selected={selectedRightRailTab === "actions"}
                  className={selectedRightRailTab === "actions" ? "active statusTooltip tabTooltip" : "statusTooltip tabTooltip"}
                  data-tooltip="Use Actions to see what the provider can do right now for the selected patient or current ED state."
                  id="right-rail-actions-tab"
                  onClick={() => setSelectedRightRailTab("actions")}
                  role="tab"
                  type="button"
                >
                  Actions
                </button>
                <button
                  aria-label="Coach: show the recommended next action and the reason behind it."
                  aria-controls="right-rail-coach"
                  aria-selected={selectedRightRailTab === "coach"}
                  className={selectedRightRailTab === "coach" ? "active statusTooltip tabTooltip" : "statusTooltip tabTooltip"}
                  data-tooltip="Use Coach to see the recommended next move, why it matters, and buttons to jump to or apply that recommendation."
                  id="right-rail-coach-tab"
                  onClick={() => setSelectedRightRailTab("coach")}
                  role="tab"
                  type="button"
                >
                  Coach
                </button>
                <button
                  aria-label="Guardrails: show operational risks and constraints that may slow flow or increase safety risk."
                  aria-controls="right-rail-guardrails"
                  aria-selected={selectedRightRailTab === "guardrails"}
                  className={
                    selectedRightRailTab === "guardrails" ? "active statusTooltip tabTooltip" : "statusTooltip tabTooltip"
                  }
                  data-tooltip="Use Guardrails to spot operational risks such as long waits, blocked rooms, staff constraints, and safety-sensitive delays."
                  id="right-rail-guardrails-tab"
                  onClick={() => setSelectedRightRailTab("guardrails")}
                  role="tab"
                  type="button"
                >
                  Guardrails
                </button>
                <button
                  aria-label="Debrief: summarize run performance, delays, decisions, and learning points."
                  aria-controls="right-rail-debrief"
                  aria-selected={selectedRightRailTab === "debrief"}
                  className={selectedRightRailTab === "debrief" ? "active statusTooltip tabTooltip" : "statusTooltip tabTooltip"}
                  data-tooltip="Use Debrief after or during a run to review what happened, where flow slowed, and what decisions helped or hurt throughput."
                  id="right-rail-debrief-tab"
                  onClick={() => setSelectedRightRailTab("debrief")}
                  role="tab"
                  type="button"
                >
                  Debrief
                </button>
                <button
                  aria-label="Activity: show the timeline of simulation events and compare provider actions with optimal timing."
                  aria-controls="right-rail-activity"
                  aria-selected={selectedRightRailTab === "activity"}
                  className={selectedRightRailTab === "activity" ? "active statusTooltip tabTooltip" : "statusTooltip tabTooltip"}
                  data-tooltip="Use Activity to review the recent event timeline, provider choices, optimal actions, matched actions, and timing variance."
                  id="right-rail-activity-tab"
                  onClick={() => setSelectedRightRailTab("activity")}
                  role="tab"
                  type="button"
                >
                  Activity
                </button>
              </div>

              <section
                aria-labelledby={`right-rail-${selectedRightRailTab}-tab`}
                className="rightRailPanel"
                id={`right-rail-${selectedRightRailTab}`}
                role="tabpanel"
              >
                {selectedRightRailTab === "actions" ? (
                  <>
                    <h2>Actions</h2>
                    <p className="panelExplanation">
                      {isReplayMode
                        ? "Replay is read-only. Exit replay to make provider moves or continue a loaded saved run."
                        : "Actions are the provider moves currently available from the selected patient and operational context. Disabled actions explain what must happen first."}
                    </p>
                    <div className="actionStatus">
                      <strong>{providerWorkText(run, selectedPatient?.id)}</strong>
                      <small>{triageProviderStatusText(run)}</small>
                      <small>
                        {selectedPatient
                          ? `Selected ${selectedPatient.id}`
                          : "Select a patient to show patient-specific actions."}
                      </small>
                    </div>
                    <div className="actionList">
                      {availableActions.map((action) => (
                        <button
                          className={
                            coachRecommendation &&
                            selectedPatient?.id === coachRecommendation.patientId &&
                            action.type === coachRecommendation.actionType
                              ? "coachRecommendedAction"
                              : ""
                          }
                          disabled={isReplayMode || !action.enabled}
                          key={action.type}
                          onClick={() => handleAction(action.type)}
                          title={action.disabledReason}
                          type="button"
                        >
                          <span>{action.label}</span>
                          <small>{action.enabled ? `${action.timeCostMinutes}m` : action.disabledReason}</small>
                        </button>
                      ))}
                    </div>
                  </>
                ) : null}

                {selectedRightRailTab === "coach" ? (
                  <>
                    <h2>Coach</h2>
                    <p className="panelExplanation">
                      Coach recommends the next high-value action by looking at patient priority, waits, available rooms, results,
                      and flow constraints.
                    </p>
                    <CoachPanel
                      onApply={handleApplyCoachRecommendation}
                      onSelectPatient={handleSelectCoachPatient}
                      recommendation={coachRecommendation}
                      runStatus={run.status}
                    />
                  </>
                ) : null}

                {selectedRightRailTab === "guardrails" ? (
                  <>
                    <h2>Guardrails</h2>
                    <FlowGuardrailsPanel summary={flowGuardrails} />
                  </>
                ) : null}

                {selectedRightRailTab === "debrief" ? (
                  <>
                    <h2>Debrief</h2>
                    <ProviderDebriefPanel debrief={debrief} />
                  </>
                ) : null}

                {selectedRightRailTab === "activity" ? (
                  <>
                    <h2>Activity</h2>
                    <ActivityPanel timeline={activityTimeline} />
                  </>
                ) : null}

              </section>
            </aside>
          </section>
        ) : null}

        {selectedMainViewTab === "facility" ? (
          <section
            aria-labelledby="facility-view-tab"
            className="mainViewPanel"
            id="facility-view-panel"
            role="tabpanel"
          >
            <FacilitySetupView
              currentMinute={run.currentMinute}
              onSelectPatient={setSelectedPatientId}
              rooms={run.rooms}
              patients={run.patients}
            />
          </section>
        ) : null}

        {selectedMainViewTab === "benchmark" ? (
          <section
            aria-labelledby="benchmark-view-tab"
            className="mainViewPanel benchmarkViewPanel"
            id="benchmark-view-panel"
            role="tabpanel"
          >
            <h2>Benchmark</h2>
            {benchmark ? (
              <BenchmarkPanel
                benchmark={benchmark}
                comparisonView={benchmarkComparisonView}
                onSelectBenchmarkComparison={handleSelectBenchmarkComparison}
                selectedBenchmarkComparisonId={selectedBenchmarkComparisonId}
              />
            ) : (
              <p className="emptyState">Benchmark comparison will calculate when this tab is opened.</p>
            )}
          </section>
        ) : null}

        {selectedMainViewTab === "coach-comparison" ? (
          <section
            aria-labelledby="coach-comparison-view-tab"
            className="mainViewPanel coachComparisonViewPanel"
            id="coach-comparison-view-panel"
            role="tabpanel"
          >
            <h2>Coach Comparison</h2>
            {benchmark ? (
              <CoachComparisonPanel
                benchmark={benchmark}
                onToggleCoachComparison={handleToggleCoachComparison}
                visibleCoachComparisonIds={visibleCoachComparisonIds}
              />
            ) : (
              <p className="emptyState">Coach comparison will calculate when this tab is opened.</p>
            )}
          </section>
        ) : null}

        {selectedMainViewTab === "graphs" ? (
          <section
            aria-labelledby="graphs-view-tab"
            className="mainViewPanel graphsViewPanel"
            id="graphs-view-panel"
            role="tabpanel"
          >
            <GraphsPanel data={operationalGraphData} currentMinute={run.currentMinute} />
          </section>
        ) : null}
          </section>
        </>
      ) : null}
    </main>
  );
}

function roomPatientLabel(patient?: RuntimePatient): string {
  if (!patient) {
    return "Open";
  }

  if (patient.state === "boarding") {
    return `${patient.id} boarding`;
  }

  return patient.id;
}

function roomDetailText(room: EDRoom, patient?: RuntimePatient): string {
  if (room.status === "available") {
    return "Ready for next patient";
  }

  if (room.status === "cleaning") {
    return "Room turnover cleaning";
  }

  if (!patient) {
    return room.status === "blocked" ? "Room blocked" : "Occupied";
  }

  const roomedText = patient.roomedAt === undefined ? "roomed" : `roomed ${formatMinute(patient.roomedAt)}`;
  return `${boardLocationLabel(patient.state)} · ${roomedText}`;
}

function FacilitySetupView({
  currentMinute,
  onSelectPatient,
  patients,
  rooms,
}: {
  currentMinute: number;
  onSelectPatient: (patientId: string) => void;
  patients: RuntimePatient[];
  rooms: EDRoom[];
}) {
  const waitingPatients = patients.filter((patient) => patient.state === "waiting");
  const triagePatients = patients.filter((patient) => patient.state === "triage");
  const fastTrackPatients = patients.filter((patient) => patient.state === "fast_track");
  const admissionPendingPatients = patients.filter((patient) => patient.state === "admission_pending");
  const boardingPatients = patients.filter((patient) => patient.state === "boarding");
  const occupiedRooms = rooms.filter((room) => room.status === "occupied").length;
  const blockedRooms = rooms.filter((room) => room.status === "blocked").length;
  const cleaningRooms = rooms.filter((room) => room.status === "cleaning").length;
  const availableRooms = rooms.filter((room) => room.status === "available").length;

  return (
    <div className="facilityView">
      <section className="facilitySummary" aria-label="Facility summary">
        <Metric icon={<Bed size={18} />} label="Rooms Available" value={availableRooms} />
        <Metric icon={<DoorOpen size={18} />} label="Rooms Occupied" value={occupiedRooms} />
        <Metric icon={<CircleOff size={18} />} label="Rooms Blocked" value={blockedRooms} />
        <Metric icon={<BrushCleaning size={18} />} label="Rooms Cleaning" value={cleaningRooms} />
        <Metric icon={<Clock size={18} />} label="Next Room Ready" value={formatRoomReadyStatus(rooms, currentMinute)} />
        <Metric icon={<Users size={18} />} label="Waiting Room" value={waitingPatients.length} />
        <Metric icon={<Stethoscope size={18} />} label="Front-End Triage" value={triagePatients.length} />
        <Metric icon={<StepForward size={18} />} label="Fast Track" value={fastTrackPatients.length} />
        <Metric icon={<Hourglass size={18} />} label="Admission Pending" value={admissionPendingPatients.length} />
        <Metric icon={<UserRoundCheck size={18} />} label="Hospitalist Pending" value={admissionPendingPatients.length} />
        <Metric icon={<BedDouble size={18} />} label="Boarding" value={boardingPatients.length} />
      </section>

      <section className="roomMapPanel" aria-label="Room map">
        <div className="roomMapHeader">
          <div>
            <h2>Room Map</h2>
            <small>
              {rooms.length} ED rooms · {availableRooms} available · {cleaningRooms} cleaning · {blockedRooms} blocked
            </small>
          </div>
          <div className="roomLegend" aria-label="Room status legend">
            <span className="available">Available</span>
            <span className="occupied">Occupied</span>
            <span className="cleaning">Cleaning</span>
            <span className="blocked">Blocked</span>
          </div>
        </div>

        <div className="roomGrid">
          {rooms.map((room) => {
            const patient = patients.find((candidate) => candidate.id === room.patientId);
            const hasPatient = patient !== undefined;
            const roomCleaningTimeRemaining =
              room.status === "cleaning" && room.cleaningReadyAt !== undefined
                ? Math.max(0, room.cleaningReadyAt - currentMinute)
                : undefined;
            return (
              <button
                className={`roomTile ${room.status}`}
                disabled={!hasPatient}
                key={room.id}
                onClick={() => {
                  if (patient) {
                    onSelectPatient(patient.id);
                  }
                }}
                type="button"
              >
                <span>{room.id}</span>
                <strong>{room.status === "cleaning" ? "Cleaning" : roomPatientLabel(patient)}</strong>
                <small>{roomDetailText(room, patient)}</small>
                {roomCleaningTimeRemaining !== undefined ? <small>{roomCleaningTimeRemaining} min until ready</small> : null}
                {patient ? <small>{waitMinutes(patient, currentMinute)} min in system</small> : null}
              </button>
            );
          })}
        </div>
      </section>
    </div>
  );
}

function BenchmarkPanel({
  benchmark,
  comparisonView,
  onSelectBenchmarkComparison,
  selectedBenchmarkComparisonId,
}: {
  benchmark: OptimalFlowBenchmark;
  comparisonView: BenchmarkComparisonView | undefined;
  onSelectBenchmarkComparison: (strategyId: WhatIfCoachStrategyId) => void;
  selectedBenchmarkComparisonId: WhatIfCoachStrategyId;
}) {
  const benchmarkTargetOptions = benchmark.whatIfComparison.summaries.filter((summary) => summary.id !== "provider_run");

  return (
    <div className="benchmarkPanel">
      <strong>{comparisonView?.headline ?? benchmark.headline}</strong>
      {comparisonView ? (
        <section className="benchmarkMetricComparison" aria-label="Provider comparison metrics">
          <div className="benchmarkTargetControl">
            <label htmlFor="benchmark-target">Compare Provider Run To</label>
            <select
              id="benchmark-target"
              onChange={(event) => onSelectBenchmarkComparison(event.target.value as WhatIfCoachStrategyId)}
              value={selectedBenchmarkComparisonId === "provider_run" ? "optimal_flow" : selectedBenchmarkComparisonId}
            >
              {benchmarkTargetOptions.map((summary) => (
                <option key={summary.id} value={summary.id}>
                  {summary.label}
                </option>
              ))}
            </select>
          </div>
          <div className="benchmarkComparisonHeader">
            <span>Metric</span>
            <span>Provider Run</span>
            <span>{comparisonView.targetLabel}</span>
            <span>Difference</span>
          </div>
          <dl className="benchmarkGrid">
            {comparisonView.comparisons.map((comparison) => (
              <div className={comparison.interpretation} key={comparison.label}>
                <dt>{comparison.label}</dt>
                <dd>
                  <span>{comparison.actual}</span>
                  <span>{comparison.benchmark}</span>
                  <strong>{comparison.delta}</strong>
                </dd>
              </div>
            ))}
          </dl>
        </section>
      ) : null}
      <div className="debriefBlock">
        <h3>Flow Opportunities</h3>
        <p>
          Patient-level timing gaps where the Provider Run differed from {comparisonView?.targetLabel ?? "the selected comparison"}.
          These highlight moments where rooming, provider evaluation, results review, disposition, or LWBS timing changed the flow.
        </p>
        {comparisonView?.opportunities.length === 0 ? (
          <p className="emptyState">No patient-level gaps flagged against {comparisonView.targetLabel}.</p>
        ) : (
          <ul className="feedbackList">
            {comparisonView?.opportunities.map((opportunity) => (
              <li className="opportunity" key={`${opportunity.patientId}-${opportunity.label}`}>
                <span>
                  {opportunity.patientId} · {opportunity.label}
                </span>
                <small>{opportunity.detail}</small>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

function CoachComparisonPanel({
  benchmark,
  onToggleCoachComparison,
  visibleCoachComparisonIds,
}: {
  benchmark: OptimalFlowBenchmark;
  onToggleCoachComparison: (strategyId: WhatIfCoachStrategyId) => void;
  visibleCoachComparisonIds: WhatIfCoachStrategyId[];
}) {
  const visibleSummaries = benchmark.whatIfComparison.summaries.filter((summary) =>
    visibleCoachComparisonIds.includes(summary.id),
  );

  return (
    <section className="whatIfComparison" aria-label="What-if coach comparison">
      <h3>What-If Coach Comparison</h3>
      <p>{benchmark.whatIfComparison.headline}</p>
      <div className="coachComparisonControls" aria-label="Show coach comparisons">
        {benchmark.whatIfComparison.summaries.map((summary) => (
          <label key={summary.id}>
            <input
              checked={visibleCoachComparisonIds.includes(summary.id)}
              onChange={() => onToggleCoachComparison(summary.id)}
              type="checkbox"
            />
            <span>{summary.label}</span>
          </label>
        ))}
      </div>
      <div className="whatIfGrid">
        {visibleSummaries.map((summary) => (
          <article className={`whatIfCard ${summary.id}`} key={summary.id}>
            <strong>{summary.label}</strong>
            <small>{summary.description}</small>
            {summary.priorityProfile ? (
              <>
                <p className="whatIfBehaviorSummary">
                  {coachStrategyBehaviorDetails(
                    summary.id === "optimal_flow" ? "default" : (summary.id as CoachComparisonStrategyId),
                  )[0]}
                </p>
                <div className="whatIfRuleProfile" aria-label={`${summary.label} patient priority weights`}>
                  <span>{coachPriorityModeLabel(summary.priorityProfile.mode)}</span>
                  <span>ESI {summary.priorityProfile.acuityWeight}</span>
                  <span>Risk {summary.priorityProfile.riskWeight}</span>
                  <span>Wait {summary.priorityProfile.waitWeight}/min</span>
                </div>
              </>
            ) : null}
            <dl>
              <div>
                <dt>Departed</dt>
                <dd>{summary.patientsDeparted}</dd>
              </div>
              <div>
                <dt>LWBS</dt>
                <dd>{summary.patientsLWBS}</dd>
              </div>
              <div>
                <dt>Longest Wait</dt>
                <dd>{formatMinutesAndHours(summary.longestWaitMinutes)}</dd>
              </div>
              <div>
                <dt>Seen / Hr</dt>
                <dd>{summary.patientsSeenPerHour.toFixed(1)}</dd>
              </div>
              <div>
                <dt>Results Waiting</dt>
                <dd>{summary.resultsReadyWaiting}</dd>
              </div>
              <div>
                <dt>Boarding Min</dt>
                <dd>{summary.totalBoardingMinutes}</dd>
              </div>
              <div>
                <dt>{"ECG <=10"}</dt>
                <dd>{(summary.doorToEcgWithin10Rate * 100).toFixed(0)}%</dd>
              </div>
              <div>
                <dt>{"Sepsis Abx <=60"}</dt>
                <dd>{(summary.sepsisAntibioticsWithin60Rate * 100).toFixed(0)}%</dd>
              </div>
            </dl>
          </article>
        ))}
        {visibleSummaries.length === 0 ? <p className="emptyState">Select at least one comparison to display.</p> : null}
      </div>
    </section>
  );
}

function FlowGuardrailsPanel({ summary }: { summary: FlowGuardrailSummary }) {
  return (
    <div className="debriefPanel">
      <strong>{summary.headline}</strong>
      <p className="guardrailIntro">
        Guardrails highlight operational conditions that can slow flow or increase waiting-room risk. Use them as prompts for
        prioritization, not as clinical decision support.
      </p>
      <dl className="guardrailLegend" aria-label="Guardrail severity meanings">
        <div>
          <dt>Urgent</dt>
          <dd>Act now if possible.</dd>
        </div>
        <div>
          <dt>Watch</dt>
          <dd>Monitor or plan next move.</dd>
        </div>
        <div>
          <dt>Good</dt>
          <dd>No threshold crossed.</dd>
        </div>
      </dl>
      <ul className="feedbackList">
        {summary.guardrails.map((guardrail) => {
          const explanation = GUARDRAIL_EXPLANATIONS[guardrail.title];

          return (
            <li className={guardrail.severity} key={guardrail.id}>
              <div className="guardrailItemHeader">
                <span>{guardrail.title}</span>
                {guardrail.metricValue ? <em>{guardrail.metricValue}</em> : null}
              </div>
              <small>{guardrail.message}</small>
              {explanation ? (
                <dl className="guardrailExplanation">
                  <div>
                    <dt>Why</dt>
                    <dd>{explanation.why}</dd>
                  </div>
                  <div>
                    <dt>Action</dt>
                    <dd>{explanation.action}</dd>
                  </div>
                </dl>
              ) : null}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function ActivityPanel({ timeline }: { timeline: ActivityTimeline }) {
  const recentRecords = timeline.records.slice(-18).reverse();

  return (
    <div className="activityPanel">
      <p className="panelExplanation">
        Activity is the running event log for the simulation. It shows arrivals, pauses, provider selections, and how provider
        action timing compares with the optimal-flow benchmark when comparison data is available.
      </p>
      <div className="activityToolbar">
        <span>{timeline.records.length} timeline records</span>
      </div>
      <dl className="activitySummary">
        <div>
          <dt>Provider selections</dt>
          <dd>{timeline.actualDecisionCount}</dd>
        </div>
        <div>
          <dt>Optimal actions</dt>
          <dd>{timeline.benchmarkDecisionCount}</dd>
        </div>
        <div>
          <dt>Matched actions</dt>
          <dd>{timeline.matchedDecisionCount}</dd>
        </div>
        <div>
          <dt>Avg variance</dt>
          <dd>{timeline.averageDecisionDelayMinutes === null ? "-" : `${timeline.averageDecisionDelayMinutes.toFixed(0)} min`}</dd>
        </div>
      </dl>

      <ol className="activityList">
        {recentRecords.length === 0 ? (
          <li>
            <span>No activity recorded yet.</span>
          </li>
        ) : (
          recentRecords.map((record) => (
            <li className={record.kind} key={record.id}>
              <time>{formatMinute(record.simulationMinute)}</time>
              <div>
                <strong>{record.label}</strong>
                <span>{record.message}</span>
                {record.benchmarkDeltaMinutes !== undefined ? (
                  <small>
                    Optimal {formatMinute(record.benchmarkMinute ?? record.simulationMinute)} ·{" "}
                    {record.benchmarkDeltaMinutes === 0
                      ? "on benchmark"
                      : record.benchmarkDeltaMinutes > 0
                        ? `${record.benchmarkDeltaMinutes} min after optimal`
                        : `${Math.abs(record.benchmarkDeltaMinutes)} min before optimal`}
                  </small>
                ) : null}
                {record.providerId ? <small>{record.providerId}</small> : null}
              </div>
            </li>
          ))
        )}
      </ol>
    </div>
  );
}

function ExportPanel({ exportRuns, timeline }: { exportRuns: ActivityCsvRun[]; timeline: ActivityTimeline }) {
  const [exportStatus, setExportStatus] = useState<string | undefined>();

  function downloadCsv(csv: string, filenamePrefix: string) {
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");

    link.href = url;
    link.download = `${filenamePrefix}-${new Date().toISOString().replaceAll(":", "-")}.csv`;
    document.body.append(link);
    link.click();
    link.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 30000);
  }

  async function copyCsv(csv: string) {
    try {
      await navigator.clipboard.writeText(csv);
      return;
    } catch {
      const textarea = document.createElement("textarea");
      textarea.value = csv;
      textarea.setAttribute("readonly", "true");
      textarea.style.position = "fixed";
      textarea.style.left = "-9999px";
      document.body.append(textarea);
      textarea.select();
      document.execCommand("copy");
      textarea.remove();
    }
  }

  function handleDownloadTimelineCsv() {
    downloadCsv(activityTimelineToCsv(timeline), "ed-simulation-activity");
    setExportStatus(`Activity CSV export started with ${timeline.records.length} records.`);
  }

  function handleDownloadAllRunsCsv() {
    const csv = activityRunsToCsv(exportRuns);
    const recordCount = Math.max(0, csv.split("\n").length - 1);
    downloadCsv(csv, "ed-simulation-all-runs");
    setExportStatus(`All-runs CSV export started with ${recordCount} records across ${exportRuns.length} runs.`);
  }

  async function handleCopyTimelineCsv() {
    await copyCsv(activityTimelineToCsv(timeline));
    setExportStatus(`Activity CSV copied with ${timeline.records.length} records.`);
  }

  async function handleCopyAllRunsCsv() {
    const csv = activityRunsToCsv(exportRuns);
    const recordCount = Math.max(0, csv.split("\n").length - 1);
    await copyCsv(csv);
    setExportStatus(`All-runs CSV copied with ${recordCount} records across ${exportRuns.length} runs.`);
  }

  return (
    <div className="activityPanel">
      <p className="panelExplanation">
        Export lets you take simulation data out of the app. Activity CSV includes the visible event timeline; All Runs CSV
        includes the provider run plus benchmark and coach strategy comparison runs.
      </p>
      <div className="activityToolbar">
        <span>{timeline.records.length} timeline records</span>
        <div className="activityToolbarActions">
          <button
            className="statusTooltip"
            data-tooltip="Download the current activity timeline as a CSV file for spreadsheet review."
            type="button"
            onClick={handleDownloadTimelineCsv}
          >
            Download Activity CSV
          </button>
          <button
            className="statusTooltip"
            data-tooltip="Download the provider run plus benchmark and coach strategy comparison runs as one CSV file."
            type="button"
            onClick={handleDownloadAllRunsCsv}
          >
            Download All Runs CSV
          </button>
          <button
            className="statusTooltip"
            data-tooltip="Copy the current activity timeline CSV to the clipboard."
            type="button"
            onClick={handleCopyTimelineCsv}
          >
            Copy Activity CSV
          </button>
          <button
            className="statusTooltip"
            data-tooltip="Copy the provider, benchmark, and coach strategy comparison CSV to the clipboard."
            type="button"
            onClick={handleCopyAllRunsCsv}
          >
            Copy All Runs CSV
          </button>
        </div>
      </div>
      {exportStatus ? <p className="activityExportStatus">{exportStatus}</p> : null}
    </div>
  );
}

function SavedRunsPanel({
  activeReplayRecordId,
  onDelete,
  onExportCurrentRun,
  onImportFile,
  onReplay,
  onRestore,
  records,
  status,
}: {
  activeReplayRecordId?: string;
  onDelete: (recordId: string) => void;
  onExportCurrentRun: () => void;
  onImportFile: (text: string) => void;
  onReplay: (record: SavedRunRecord) => void;
  onRestore: (record: SavedRunRecord) => void;
  records: SavedRunRecord[];
  status?: string;
}) {
  async function handleImportChange(event: ChangeEvent<HTMLInputElement>) {
    const file = event.currentTarget.files?.[0];
    event.currentTarget.value = "";

    if (!file) {
      return;
    }

    onImportFile(await file.text());
  }

  return (
    <div className="savedRunsPanel">
      <p className="panelExplanation">
        Export Current Run creates a JSON file the user can store in a chosen location. Import File brings a saved-run JSON
        file back later for load and replay.
      </p>
      <div className="savedRunFileTools" aria-label="Saved run file storage">
        <button className="primaryButton" type="button" onClick={onExportCurrentRun}>
          Export Current Run
        </button>
        <label>
          <span>Import File</span>
          <input accept="application/json,.json" onChange={handleImportChange} type="file" />
        </label>
      </div>
      {status ? <p className="activityExportStatus">{status}</p> : null}
      <div className="savedRunList" aria-label="Saved runs">
        {records.length === 0 ? (
          <p className="emptyState">No saved runs yet.</p>
        ) : (
          records.map((record) => (
            <article className="savedRunCard" key={record.id}>
              <div className="savedRunCardHeader">
                <strong>{record.name}</strong>
                <small>{new Date(record.updatedAt).toLocaleString()}</small>
              </div>
              <dl>
                <div>
                  <dt>Status</dt>
                  <dd>{stateLabel(record.run.status)}</dd>
                </div>
                <div>
                  <dt>Minute</dt>
                  <dd>{formatMinute(record.run.currentMinute)}</dd>
                </div>
                <div>
                  <dt>Events</dt>
                  <dd>{record.run.events.length}</dd>
                </div>
                <div>
                  <dt>Decisions</dt>
                  <dd>{record.run.decisions.length}</dd>
                </div>
                <div>
                  <dt>Snapshots</dt>
                  <dd>{record.snapshots.length}</dd>
                </div>
                <div>
                  <dt>Replay</dt>
                  <dd>{formatMinute(record.run.shiftStartMinute)}-{formatMinute(record.run.currentMinute)}</dd>
                </div>
                <div>
                  <dt>Patients</dt>
                  <dd>{record.run.patients.length}</dd>
                </div>
              </dl>
              <div className="savedRunActions">
                <button
                  className={activeReplayRecordId === record.id ? "active" : ""}
                  type="button"
                  onClick={() => onReplay(record)}
                >
                  Replay
                </button>
                <button type="button" onClick={() => onRestore(record)}>
                  Load
                </button>
                <button type="button" onClick={() => onDelete(record.id)}>
                  Delete
                </button>
              </div>
            </article>
          ))
        )}
      </div>
    </div>
  );
}

function CoachPanel({
  onApply,
  onSelectPatient,
  recommendation,
  runStatus,
}: {
  onApply: () => void;
  onSelectPatient: () => void;
  recommendation: BenchmarkCoachRecommendation | undefined;
  runStatus: SimulationRun["status"];
}) {
  if (runStatus !== "running") {
    return (
      <div className="coachPanel">
        <strong>Start the simulation to enable Coach Mode.</strong>
        <p className="emptyState">Coach recommendations appear while the clock is running and an operational action is available.</p>
      </div>
    );
  }

  if (!recommendation) {
    return (
      <div className="coachPanel">
        <strong>No coach action is available right now.</strong>
        <p className="emptyState">Advance the clock or wait for arrivals, rooms, providers, or results to become available.</p>
      </div>
    );
  }

  return (
    <div className="coachPanel">
      <strong>{recommendation.actionLabel}</strong>
      <dl className="coachSummary">
        <div>
          <dt>Patient</dt>
          <dd>{recommendation.patientId}</dd>
        </div>
        <div>
          <dt>Priority</dt>
          <dd>{recommendation.prioritySummary}</dd>
        </div>
      </dl>
      <p>{recommendation.reason}</p>
      <div className="coachActions">
        <button type="button" onClick={onSelectPatient}>
          Show action
        </button>
        <button className="primaryButton" type="button" onClick={onApply}>
          Apply recommendation
        </button>
      </div>
    </div>
  );
}

function ProviderDebriefPanel({ debrief }: { debrief: ProviderDebrief }) {
  return (
    <div className="debriefPanel">
      <strong>{debrief.headline}</strong>
      <p className="debriefIntro">
        Debrief summarizes what happened in this run, where flow slowed, and which provider decisions helped move patients
        through the ED.
      </p>
      <dl className="debriefLegend" aria-label="Debrief feedback meanings">
        <div>
          <dt>Positive</dt>
          <dd>Flow-supporting action or outcome.</dd>
        </div>
        <div>
          <dt>Watch</dt>
          <dd>Operational pressure to monitor.</dd>
        </div>
        <div>
          <dt>Opportunity</dt>
          <dd>Potential improvement area.</dd>
        </div>
      </dl>
      <dl className="debriefSummary">
        {debrief.summary.map((item) => (
          <div key={item.label}>
            <dt>{item.label}</dt>
            <dd>{item.value}</dd>
          </div>
        ))}
      </dl>
      <div className="debriefBlock">
        <h3>Top Bottlenecks</h3>
        <p>Operational delays that most affected wait, room use, or patient movement.</p>
        <ul className="feedbackList">
          {debrief.bottlenecks.map((item) => (
            <li className={item.kind} key={item.id}>
              <span>{item.title}</span>
              <small>{item.message}</small>
              {item.metricValue ? <em>{item.metricValue}</em> : null}
            </li>
          ))}
        </ul>
      </div>
      <div className="debriefBlock">
        <h3>Decision Feedback</h3>
        <p>Signals from the provider actions taken during this run.</p>
        <ul className="feedbackList">
          {debrief.decisionFeedback.map((item) => (
            <li className={item.kind} key={item.id}>
              <span>{item.title}</span>
              <small>{item.message}</small>
              {item.metricValue ? <em>{item.metricValue}</em> : null}
            </li>
          ))}
        </ul>
      </div>
      <div className="debriefBlock">
        <h3>Notable Patients</h3>
        <p>Patient timelines with longer waits, delayed review, or LWBS events worth discussing.</p>
        {debrief.notablePatients.length === 0 ? (
          <p className="emptyState">No notable patient timeline flags yet.</p>
        ) : (
          <ul className="feedbackList">
            {debrief.notablePatients.map((item) => (
              <li className="watch" key={`${item.patientId}-${item.label}`}>
                <span>
                  {item.patientId} · {item.label}
                </span>
                <small>{item.detail}</small>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

function GraphsPanel({ currentMinute, data }: { currentMinute: number; data: OperationalGraphData }) {
  const flowSeries: GraphSeries[] = [
    { id: "waiting", label: "Waiting Room", color: "#c7603b" },
    { id: "roomedActive", label: "Roomed Active", color: "#1f6f8b" },
    { id: "resultsWaiting", label: "Results Waiting", color: "#6c63b7" },
    { id: "boarding", label: "Admission / Boarding", color: "#8a5a00" },
  ];
  const throughputSeries: GraphSeries[] = [
    { id: "arrived", label: "Arrived", color: "#526173" },
    { id: "seen", label: "Seen", color: "#1f6f8b" },
    { id: "departed", label: "Departed", color: "#3e8b5d" },
    { id: "lwbs", label: "LWBS", color: "#b42318" },
  ];
  const safetySeries: GraphSeries[] = [
    { id: "reassessments", label: "Reassessments", color: "#1f6f8b" },
    { id: "deteriorations", label: "Deteriorations", color: "#b42318" },
    { id: "lwbs", label: "LWBS", color: "#c7603b" },
    { id: "stemiAlerts", label: "STEMI Alerts", color: "#7f1d1d" },
  ];

  return (
    <div className="graphsPanel">
      <div className="graphsHeader">
        <h2>Graphs</h2>
        <p>Operational trends reconstructed from the current run event log through {formatMinutesAndHours(currentMinute)}.</p>
      </div>
      <div className="graphGrid">
        <LineChart
          data={data.flowCensus}
          series={flowSeries}
          subtitle="Census snapshots by simulation minute"
          title="Flow Census Over Time"
          yLabel="Patients"
        />
        <LineChart
          data={data.throughput}
          series={throughputSeries}
          subtitle="Cumulative arrivals, patients seen, departures, and LWBS"
          title="Throughput Over Time"
          yLabel="Patients"
        />
        <LineChart
          data={data.safetyQuality}
          series={safetySeries}
          subtitle="Cumulative safety and time-sensitive pathway signals"
          title="Safety + Quality Signals"
          yLabel="Events"
        />
      </div>
    </div>
  );
}

function LineChart({
  data,
  series,
  subtitle,
  title,
  yLabel,
}: {
  data: GraphPoint[];
  series: GraphSeries[];
  subtitle: string;
  title: string;
  yLabel: string;
}) {
  const width = 720;
  const height = 260;
  const margin = { bottom: 34, left: 42, right: 18, top: 18 };
  const chartWidth = width - margin.left - margin.right;
  const chartHeight = height - margin.top - margin.bottom;
  const maxMinute = Math.max(1, data[data.length - 1]?.minute ?? 1);
  const maxValue = Math.max(
    1,
    ...data.flatMap((point) => series.map((item) => Number(point[item.id] ?? 0))),
  );
  const lastPoint = data[data.length - 1];
  const yTicks = [0, Math.ceil(maxValue / 2), Math.ceil(maxValue)];

  function xForMinute(minute: number): number {
    return margin.left + (minute / maxMinute) * chartWidth;
  }

  function yForValue(value: number): number {
    return margin.top + chartHeight - (value / maxValue) * chartHeight;
  }

  function pathForSeries(seriesId: string): string {
    return data
      .map((point, index) => {
        const command = index === 0 ? "M" : "L";
        return `${command} ${xForMinute(point.minute).toFixed(2)} ${yForValue(Number(point[seriesId] ?? 0)).toFixed(2)}`;
      })
      .join(" ");
  }

  return (
    <section className="chartCard" aria-label={title}>
      <div className="chartHeader">
        <div>
          <h3>{title}</h3>
          <p>{subtitle}</p>
        </div>
        <span>{yLabel}</span>
      </div>
      <svg className="lineChart" viewBox={`0 0 ${width} ${height}`} role="img" aria-label={`${title} line chart`}>
        <line className="chartAxis" x1={margin.left} x2={margin.left} y1={margin.top} y2={margin.top + chartHeight} />
        <line
          className="chartAxis"
          x1={margin.left}
          x2={margin.left + chartWidth}
          y1={margin.top + chartHeight}
          y2={margin.top + chartHeight}
        />
        {yTicks.map((tick) => (
          <g key={tick}>
            <line
              className="chartGridLine"
              x1={margin.left}
              x2={margin.left + chartWidth}
              y1={yForValue(tick)}
              y2={yForValue(tick)}
            />
            <text className="chartTick" x={margin.left - 9} y={yForValue(tick) + 4} textAnchor="end">
              {tick}
            </text>
          </g>
        ))}
        <text className="chartTick" x={margin.left} y={height - 9} textAnchor="middle">
          0m
        </text>
        <text className="chartTick" x={margin.left + chartWidth} y={height - 9} textAnchor="end">
          {`${maxMinute}m`}
        </text>
        {series.map((item) => (
          <path className="chartLine" d={pathForSeries(item.id)} key={item.id} stroke={item.color} />
        ))}
        {lastPoint
          ? series.map((item) => (
              <circle
                className="chartPoint"
                cx={xForMinute(lastPoint.minute)}
                cy={yForValue(Number(lastPoint[item.id] ?? 0))}
                fill={item.color}
                key={item.id}
                r="3.5"
              />
            ))
          : null}
      </svg>
      <dl className="chartLegend">
        {series.map((item) => (
          <div key={item.id}>
            <dt>
              <span style={{ background: item.color }} />
              {item.label}
            </dt>
            <dd>{lastPoint ? Number(lastPoint[item.id] ?? 0) : 0}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

function Metric({
  className = "",
  icon,
  label,
  value,
}: {
  className?: string;
  icon?: React.ReactNode;
  label: string;
  value: number | string;
}) {
  const tooltip = metricTooltip(label);

  return (
    <div
      aria-label={`${label}: ${tooltip}`}
      className={`metric statusTooltip ${className}`.trim()}
      data-tooltip={tooltip}
      tabIndex={0}
    >
      <div className="metricLabel">
        {icon}
        <span>{label}</span>
      </div>
      <strong>{value}</strong>
    </div>
  );
}

function PatientCard({
  currentMinute,
  isCoachRecommended,
  isSelected,
  onSelect,
  patient,
}: {
  currentMinute: number;
  isCoachRecommended: boolean;
  isSelected: boolean;
  onSelect: () => void;
  patient: RuntimePatient;
}) {
  const workup = getPatientWorkupSummary(patient);
  const riskDisplay = waitingRiskDisplay(patient);
  const providerSeen = patient.providerSeenAt !== undefined;
  const isCardiacPatient = patient.cardiacPathway !== "none";
  const isStemiAlertPatient = patient.cardiacPathway === "stemi_alert";
  const reassessmentOverdue = patient.state === "waiting" && isReassessmentOverdue(patient, currentMinute);
  const deteriorated = patient.deterioratedAt !== undefined;

  return (
    <button
      className={`patientCard ${isSelected ? "selected" : ""} ${isCoachRecommended ? "coachRecommendedPatient" : ""}`}
      onClick={onSelect}
      type="button"
    >
      <div className="cardTopline">
        <strong>{patient.id}</strong>
        <span className="cardBadges">
          {isCardiacPatient ? (
            <span aria-label="Cardiac pathway patient" className="cardiacBadge" title="Cardiac pathway patient">
              ❤️
            </span>
          ) : null}
          {isStemiAlertPatient ? (
            <span aria-label="STEMI-alert pathway patient" className="stemiBadge" title="STEMI-alert pathway">
              STEMI
            </span>
          ) : null}
          {deteriorated ? (
            <span aria-label="Patient deteriorated while waiting" className="deteriorationBadge" title="Deteriorated while waiting">
              WORSE
            </span>
          ) : null}
          {reassessmentOverdue ? (
            <span aria-label="Waiting-room reassessment overdue" className="reassessmentBadge" title="Reassessment overdue">
              RECHECK
            </span>
          ) : null}
          <span className={`seenBadge ${providerSeen ? "seen" : "notSeen"}`}>
            {providerSeen ? "Seen" : "Not seen"}
          </span>
          <span className={`riskBadge ${riskDisplay.className}`}>{riskDisplay.label}</span>
        </span>
      </div>
      <div className="patientMeta">
        <span>ESI {patient.esi}</span>
        <span>{patient.complaintCategory.replaceAll("_", " ")}</span>
      </div>
      <div className="patientMeta">
        <span>{isTerminalPatient(patient) ? "Elapsed" : "Wait"} {waitMinutes(patient, currentMinute)}m</span>
        <span>{stateLabel(patient.state)}</span>
      </div>
      {patient.assignedProviderId ? (
        <div className="patientMeta providerAssignmentLine">
          <span>Assigned</span>
          <span>{providerAssignmentLabel(patient.assignedProviderId)}</span>
        </div>
      ) : null}
      <div className="protocolLine">
        <span className={`protocolBadge ${workup.protocolStatus}`}>{workup.protocolStatusLabel}</span>
        <small>{workup.label}</small>
      </div>
    </button>
  );
}

function PatientDetails({ currentMinute, patient }: { currentMinute: number; patient: RuntimePatient }) {
  const workup = getPatientWorkupSummary(patient);
  const riskDisplay = waitingRiskDisplay(patient);
  const showIdentifiedOrders = workup.protocolStatus === "identified";
  const isAdmitPatient = patient.dispositionType === "admit_inpatient";
  const hospitalistRequestAt = isAdmitPatient ? patient.dispositionDecisionAt : undefined;
  const hospitalistAcceptedAt = patient.admissionAcceptedAt;
  const inpatientBedItem = patient.pendingItems.find((item) => item.type === "boarding_bed");
  const inpatientBedAssignedAt = isAdmitPatient && patient.departedAt !== undefined ? patient.departedAt : undefined;
  const hospitalistResponseTime =
    hospitalistRequestAt === undefined
      ? "-"
      : `${(hospitalistAcceptedAt ?? currentMinute) - hospitalistRequestAt} min${hospitalistAcceptedAt === undefined ? " pending" : ""}`;

  return (
    <dl className="detailGrid">
      <div>
        <dt>ID</dt>
        <dd>{patient.id}</dd>
      </div>
      <div>
        <dt>ESI</dt>
        <dd>{patient.esi}</dd>
      </div>
      <div>
        <dt>Complaint</dt>
        <dd>{patient.complaintCategory.replaceAll("_", " ")}</dd>
      </div>
      <div>
        <dt>Workup Bundle</dt>
        <dd>{workup.label}</dd>
      </div>
      <div>
        <dt>Bundle Basis</dt>
        <dd>{workup.reason}</dd>
      </div>
      <div>
        <dt>Cardiac Pathway</dt>
        <dd>{workup.cardiacPathwayLabel}</dd>
      </div>
      <div>
        <dt>ECG Complete</dt>
        <dd>{patient.ecgCompletedAt === undefined ? "-" : formatMinute(patient.ecgCompletedAt)}</dd>
      </div>
      <div>
        <dt>ECG Reviewed</dt>
        <dd>{patient.ecgReviewedAt === undefined ? "-" : formatMinute(patient.ecgReviewedAt)}</dd>
      </div>
      <div>
        <dt>State</dt>
        <dd>{stateLabel(patient.state)}</dd>
      </div>
      <div>
        <dt>Assigned Provider</dt>
        <dd>{providerAssignmentLabel(patient.assignedProviderId)}</dd>
      </div>
      <div>
        <dt>Arrival Path</dt>
        <dd>{arrivalPathLabel(patient)}</dd>
      </div>
      <div>
        <dt>Triage Done</dt>
        <dd>{patient.triagedAt === undefined ? "-" : formatMinute(patient.triagedAt)}</dd>
      </div>
      <div>
        <dt>Fast Tracked</dt>
        <dd>{patient.fastTrackedAt === undefined ? "-" : formatMinute(patient.fastTrackedAt)}</dd>
      </div>
      <div>
        <dt>{isTerminalPatient(patient) ? "Elapsed" : "Wait"}</dt>
        <dd>{waitMinutes(patient, currentMinute)} min</dd>
      </div>
      <div>
        <dt>Waiting Risk</dt>
        <dd>{riskDisplay.label}</dd>
      </div>
      <div>
        <dt>Last Reassessed</dt>
        <dd>{patient.lastReassessedAt === undefined ? "-" : formatMinute(patient.lastReassessedAt)}</dd>
      </div>
      <div>
        <dt>Next Reassessment</dt>
        <dd>
          {patient.nextReassessmentDueAt === undefined
            ? "-"
            : `${formatMinute(patient.nextReassessmentDueAt)}${
                reassessmentOverdueMinutes(patient, currentMinute) > 0
                  ? ` (${reassessmentOverdueMinutes(patient, currentMinute)} min overdue)`
                  : ""
              }`}
        </dd>
      </div>
      <div>
        <dt>Deteriorated</dt>
        <dd>{patient.deterioratedAt === undefined ? "-" : formatMinute(patient.deterioratedAt)}</dd>
      </div>
      <div>
        <dt>Room</dt>
        <dd>{patient.roomId ?? "-"}</dd>
      </div>
      <div>
        <dt>Pending</dt>
        <dd>{workup.pendingOrders.length === 0 ? "-" : `${workup.pendingOrders.length} item(s)`}</dd>
      </div>
      <div className="detailWide detailCompact">
        <dt>Protocol Status</dt>
        <dd>
          <span className={`protocolBadge ${workup.protocolStatus}`}>{workup.protocolStatusLabel}</span>
        </dd>
      </div>
      {showIdentifiedOrders ? (
        <div className="detailWide detailOrders">
          <dt>Orders Identified in Triage</dt>
          <dd>
            {workup.namedOrders.length === 0 ? (
              "None"
            ) : (
              <ul className="namedOrderList">
                {workup.namedOrders.map((order) => (
                  <li key={`${order.category}-${order.name}`}>
                    <span>{order.name}</span>
                    <small>{stateLabel(order.status)}</small>
                  </li>
                ))}
              </ul>
            )}
          </dd>
        </div>
      ) : null}
      <div className="detailExpectedOrders">
        <dt>Expected Order Groups</dt>
        <dd>{workup.expectedOrders.length === 0 ? "None" : workup.expectedOrders.join(", ")}</dd>
      </div>
      <div className="detailDisposition">
        <dt>Disposition</dt>
        <dd>{patient.dispositionType?.replaceAll("_", " ") ?? "-"}</dd>
      </div>
      <div className="detailHospitalistWorkflow">
        <dt>Hospitalist Workflow</dt>
        <dd>
          <dl className="hospitalistMilestones">
            <div>
              <dt>Hospitalist Consult / Admit Request</dt>
              <dd>{hospitalistRequestAt === undefined ? "-" : formatMinute(hospitalistRequestAt)}</dd>
            </div>
            <div>
              <dt>Hospitalist Response Time</dt>
              <dd>{hospitalistResponseTime}</dd>
            </div>
            <div>
              <dt>Acceptance / Request More Info</dt>
              <dd>
                {hospitalistRequestAt === undefined
                  ? "-"
                  : hospitalistAcceptedAt === undefined
                    ? "Pending response / may request more info"
                    : `Accepted ${formatMinute(hospitalistAcceptedAt)}`}
              </dd>
            </div>
            <div>
              <dt>Admission Orders</dt>
              <dd>{hospitalistAcceptedAt === undefined ? "-" : `Placed ${formatMinute(hospitalistAcceptedAt)}`}</dd>
            </div>
            <div>
              <dt>Bed Request</dt>
              <dd>{hospitalistAcceptedAt === undefined ? "-" : `Requested ${formatMinute(hospitalistAcceptedAt)}`}</dd>
            </div>
            <div>
              <dt>Boarding</dt>
              <dd>{hospitalistAcceptedAt === undefined ? "-" : `Started ${formatMinute(hospitalistAcceptedAt)}`}</dd>
            </div>
            <div>
              <dt>Inpatient Bed Assigned</dt>
              <dd>
                {inpatientBedAssignedAt === undefined
                  ? inpatientBedItem
                    ? `Expected ${formatMinute(inpatientBedItem.readyAt)}`
                    : "-"
                  : formatMinute(inpatientBedAssignedAt)}
              </dd>
            </div>
            <div>
              <dt>ED Departure</dt>
              <dd>{isAdmitPatient && patient.departedAt !== undefined ? formatMinute(patient.departedAt) : "-"}</dd>
            </div>
          </dl>
        </dd>
      </div>
      <div className="detailWide detailImpact">
        <dt>Flow Impact</dt>
        <dd>{workup.flowImpact}</dd>
      </div>
      <div className="detailWide detailOrders">
        <dt>Order Details</dt>
        <dd>
          {workup.pendingOrders.length === 0 ? (
            "-"
          ) : (
            <ul className="orderList">
              {workup.pendingOrders.map((order) => (
                <li key={`${order.label}-${order.orderedAt}-${order.readyAt}`}>
                  <span>{order.label}</span>
                  <small>
                    {order.status}, ready {formatMinute(order.readyAt)}
                    {order.completedAt === undefined ? "" : `, completed ${formatMinute(order.completedAt)}`}
                  </small>
                </li>
              ))}
            </ul>
          )}
        </dd>
      </div>
    </dl>
  );
}
