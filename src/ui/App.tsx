import { type CSSProperties, useEffect, useMemo, useRef, useState } from "react";
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
import { emptyMetrics } from "../simulation/metricsEngine";
import {
  createBenchmarkComparisonView,
  createOptimalFlowBenchmark,
  getBenchmarkCoachRecommendation,
  runCoachDemoActions,
} from "../simulation/optimalFlowBenchmark";
import { createProviderDebrief } from "../simulation/providerDebrief";
import {
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
type SetupPanelTab = "live-operations" | "scenario" | "additional-stats";
type ColorMode = "light" | "dark";
type MainViewTab = "workflow" | "facility" | "benchmark" | "coach-comparison" | "graphs";
type RightRailTab = "actions" | "coach" | "guardrails" | "debrief" | "activity";

const GUARDRAIL_EXPLANATIONS: Record<string, { action: string; why: string }> = {
  "Admission acceptance delay": {
    action: "Resolve acceptance or boarding status so the room impact is visible.",
    why: "Patients awaiting admission decisions can continue occupying ED capacity.",
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
        { label: "Room cleaning minutes", value: `${run.metrics.totalRoomCleaningMinutes} min` },
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
        { label: "Admission pending", value: String(run.metrics.admissionPendingCensus) },
        { label: "Average admission acceptance", value: `${formatNumber(run.metrics.averageAdmissionDecisionMinutes)} min` },
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
        { label: "Average admission acceptance", value: `${formatNumber(run.metrics.averageAdmissionDecisionMinutes)} min` },
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
  const initialRightRailTab =
    (initialAppState?.selectedRightRailTab as string | undefined) === "benchmark"
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
  const benchmarkCacheRef = useRef<{ key: string; benchmark: OptimalFlowBenchmark } | undefined>(undefined);

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
    selectedMainViewTab === "benchmark" || selectedMainViewTab === "coach-comparison" || selectedRightRailTab === "activity";
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

  useEffect(() => {
    if (run.status !== "running") {
      return undefined;
    }

    const intervalId = window.setInterval(() => {
      setRun((currentRun) => {
        const coachedRun = coachDemoEnabled ? runCoachDemoActions(currentRun).run : currentRun;
        return advanceOneMinute(coachedRun, scenario);
      });
    }, autoAdvanceSeconds * 1000);

    return () => window.clearInterval(intervalId);
  }, [autoAdvanceSeconds, coachDemoEnabled, run.status, scenario]);

  useEffect(() => {
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
  ]);

  if (!selectedCoreMetric) {
    return null;
  }

  function updateRun(nextRun: SimulationRun) {
    setRun(nextRun);
  }

  function handleStartPause() {
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
    let nextRun = run;
    for (let index = 0; index < minutes; index += 1) {
      nextRun = advanceOneMinute(nextRun, scenario);
    }
    updateRun(nextRun);
  }

  function handleAction(actionType: ProviderActionType) {
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
    if (!coachRecommendation) {
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
    setSelectedPatientId(undefined);
    setCoachDemoEnabled(false);
    setRun(createSimulationRun(scenario, activeDeck));
  }

  function handleCoachDemoToggle() {
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
    const mode: TriageProviderMode = enabled ? "manual" : "unavailable";
    setDraftTuning((current) => ({ ...current, triageProviderEnabled: enabled, triageProviderMode: mode }));
    setActiveTuning((current) => ({ ...current, triageProviderEnabled: enabled, triageProviderMode: mode }));
    setRun((currentRun) => setFrontEndTriageProviderEnabled(currentRun, enabled));
  }

  function handleTriageProviderModeChange(mode: TriageProviderMode) {
    setDraftTuning((current) => ({ ...current, triageProviderEnabled: mode !== "unavailable", triageProviderMode: mode }));
    setActiveTuning((current) => ({ ...current, triageProviderEnabled: mode !== "unavailable", triageProviderMode: mode }));
    setRun((currentRun) => setFrontEndTriageProviderMode(currentRun, mode));
  }

  function updateDraftTuning(field: keyof ScenarioTuningConfig, value: number | boolean | TriageProviderMode) {
    setSelectedPresetId("default");
    setDraftTuning((current) => ({
      ...current,
      [field]: value,
    }));
  }

  function handlePresetChange(presetId: ScenarioPresetId) {
    setSelectedPresetId(presetId);
    setDraftTuning(getScenarioTuningPreset(presetId));
  }

  function handleApplyScenario() {
    const nextScenario = createScenarioFromTuning(draftTuning);
    const nextBundle = createRunBundle(nextScenario);
    setSelectedPatientId(undefined);
    setCoachDemoEnabled(false);
    setActiveTuning(draftTuning);
    setActiveDeck(nextBundle.deck);
    setRun(nextBundle.run);
  }

  function handleRestoreDefaultTuning() {
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

  const hasPendingScenarioChanges =
    draftTuning.triageProviderMode !== activeTuning.triageProviderMode ||
    draftTuning.roomCapacity !== activeTuning.roomCapacity ||
    draftTuning.providerCount !== activeTuning.providerCount ||
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
    draftTuning.minimumWaitBeforeLWBS !== activeTuning.minimumWaitBeforeLWBS;

  return (
    <main className="appShell" data-theme={colorMode}>
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
            aria-controls="live-operations-panel"
            aria-selected={selectedSetupPanelTab === "live-operations"}
            className={selectedSetupPanelTab === "live-operations" ? "active" : ""}
            id="live-operations-tab"
            onClick={() => setSelectedSetupPanelTab("live-operations")}
            role="tab"
            type="button"
          >
            Live Operations
          </button>
          <button
            aria-controls="additional-stats-panel"
            aria-selected={selectedSetupPanelTab === "additional-stats"}
            className={selectedSetupPanelTab === "additional-stats" ? "active" : ""}
            id="additional-stats-tab"
            onClick={() => setSelectedSetupPanelTab("additional-stats")}
            role="tab"
            type="button"
          >
            Additional Stats
          </button>
          <button
            aria-controls="scenario-setup-panel"
            aria-selected={selectedSetupPanelTab === "scenario"}
            className={selectedSetupPanelTab === "scenario" ? "active" : ""}
            id="scenario-setup-tab"
            onClick={() => setSelectedSetupPanelTab("scenario")}
            role="tab"
            type="button"
          >
            Scenario Tuning
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
                <button className="primaryButton" type="button" onClick={handleStartPause}>
                  {run.status === "running" ? <Pause size={18} /> : <Play size={18} />}
                  {run.status === "running" ? "Pause" : "Start"}
                </button>
                <button type="button" onClick={() => handleAdvance(1)} disabled={run.status !== "running"}>
                  <StepForward size={18} />
                  1 min
                </button>
                <button type="button" onClick={() => handleAdvance(5)} disabled={run.status !== "running"}>
                  <StepForward size={18} />
                  5 min
                </button>
                <label className="speedControl">
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
                <button type="button" onClick={handleReset}>
                  <RotateCcw size={18} />
                  Reset
                </button>
                <button
                  className={coachDemoEnabled ? "coachDemoButton active" : "coachDemoButton"}
                  type="button"
                  onClick={handleCoachDemoToggle}
                  disabled={run.status === "shift_ended" || run.status === "completed"}
                >
                  {coachDemoEnabled ? <Pause size={18} /> : <Sparkles size={18} />}
                  {coachDemoEnabled ? "Stop Coach Demo" : "Run Coach Demo"}
                </button>
                <label className="themeToggle">
                  <span>Dark Mode</span>
                  <input
                    checked={colorMode === "dark"}
                    onChange={(event) => setColorMode(event.currentTarget.checked ? "dark" : "light")}
                    type="checkbox"
                  />
                  <strong>{colorMode === "dark" ? "Dark" : "Light"}</strong>
                </label>
                <div className="metricVisibilityControl" role="group" aria-label="Show Metrics">
                  <span>Show Metrics</span>
                  <label>
                    <input
                      checked={showHeartMetrics}
                      onChange={(event) => setShowHeartMetrics(event.currentTarget.checked)}
                      type="checkbox"
                    />
                    <span>Heart</span>
                  </label>
                  <label>
                    <input
                      checked={showSepsisMetrics}
                      onChange={(event) => setShowSepsisMetrics(event.currentTarget.checked)}
                      type="checkbox"
                    />
                    <span>Sepsis</span>
                  </label>
                </div>
              </div>
              <div className="statusMessageRow">
                <div className="providerStatus">
                  <UserRoundCheck size={18} />
                  <span>
                    Providers {run.providers.filter((provider) => provider.status === "busy").length}/{run.providers.length}{" "}
                    busy · {providerAvailabilityText(run)}
                  </span>
                </div>
                <div className="providerStatus">
                  <UserRoundCheck size={18} />
                  <span>{triageProviderStatusText(run)}</span>
                </div>
                <div className="providerStatus">
                  <UserRoundCheck size={18} />
                  <span>{supportResourceStatusText(run)}</span>
                </div>
                <div className="clockStatus">
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
                  <span>Fast Track Enabled</span>
                  <input
                    checked={draftTuning.fastTrackEnabled}
                    onChange={(event) => updateDraftTuning("fastTrackEnabled", event.currentTarget.checked)}
                    type="checkbox"
                  />
                  <small>{draftTuning.fastTrackEnabled ? "Open" : "Closed"}</small>
                </label>
                <label className="toggleControl scenarioToggle lwbsToggleControl">
                  <span>LWBS Enabled</span>
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
                </label>
                <label>
                  <span>Admission accept typical</span>
                  <input
                    min={1}
                    max={360}
                    onChange={(event) => updateDraftTuning("admissionDecisionTypicalMinutes", Number(event.currentTarget.value))}
                    step={5}
                    type="number"
                    value={draftTuning.admissionDecisionTypicalMinutes}
                  />
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
                </label>
              </div>
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
                  <div key={measure.label}>
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
            aria-controls="workflow-view-panel"
            aria-selected={selectedMainViewTab === "workflow"}
            className={selectedMainViewTab === "workflow" ? "active" : ""}
            id="workflow-view-tab"
            onClick={() => setSelectedMainViewTab("workflow")}
            role="tab"
            type="button"
          >
            Workflow
          </button>
          <button
            aria-controls="facility-view-panel"
            aria-selected={selectedMainViewTab === "facility"}
            className={selectedMainViewTab === "facility" ? "active" : ""}
            id="facility-view-tab"
            onClick={() => setSelectedMainViewTab("facility")}
            role="tab"
            type="button"
          >
            Facility Setup
          </button>
          <button
            aria-controls="benchmark-view-panel"
            aria-selected={selectedMainViewTab === "benchmark"}
            className={selectedMainViewTab === "benchmark" ? "active" : ""}
            id="benchmark-view-tab"
            onClick={() => setSelectedMainViewTab("benchmark")}
            role="tab"
            type="button"
          >
            Benchmark
          </button>
          <button
            aria-controls="coach-comparison-view-panel"
            aria-selected={selectedMainViewTab === "coach-comparison"}
            className={selectedMainViewTab === "coach-comparison" ? "active" : ""}
            id="coach-comparison-view-tab"
            onClick={() => setSelectedMainViewTab("coach-comparison")}
            role="tab"
            type="button"
          >
            Coach Comparison
          </button>
          <button
            aria-controls="graphs-view-panel"
            aria-selected={selectedMainViewTab === "graphs"}
            className={selectedMainViewTab === "graphs" ? "active" : ""}
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
                  aria-controls="right-rail-actions"
                  aria-selected={selectedRightRailTab === "actions"}
                  className={selectedRightRailTab === "actions" ? "active" : ""}
                  id="right-rail-actions-tab"
                  onClick={() => setSelectedRightRailTab("actions")}
                  role="tab"
                  type="button"
                >
                  Actions
                </button>
                <button
                  aria-controls="right-rail-coach"
                  aria-selected={selectedRightRailTab === "coach"}
                  className={selectedRightRailTab === "coach" ? "active" : ""}
                  id="right-rail-coach-tab"
                  onClick={() => setSelectedRightRailTab("coach")}
                  role="tab"
                  type="button"
                >
                  Coach
                </button>
                <button
                  aria-controls="right-rail-guardrails"
                  aria-selected={selectedRightRailTab === "guardrails"}
                  className={selectedRightRailTab === "guardrails" ? "active" : ""}
                  id="right-rail-guardrails-tab"
                  onClick={() => setSelectedRightRailTab("guardrails")}
                  role="tab"
                  type="button"
                >
                  Guardrails
                </button>
                <button
                  aria-controls="right-rail-debrief"
                  aria-selected={selectedRightRailTab === "debrief"}
                  className={selectedRightRailTab === "debrief" ? "active" : ""}
                  id="right-rail-debrief-tab"
                  onClick={() => setSelectedRightRailTab("debrief")}
                  role="tab"
                  type="button"
                >
                  Debrief
                </button>
                <button
                  aria-controls="right-rail-activity"
                  aria-selected={selectedRightRailTab === "activity"}
                  className={selectedRightRailTab === "activity" ? "active" : ""}
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
                          disabled={!action.enabled}
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
                    <ActivityPanel exportRuns={activityExportRuns} timeline={activityTimeline} />
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
        <Metric icon={<Users size={18} />} label="Waiting Room" value={waitingPatients.length} />
        <Metric icon={<Stethoscope size={18} />} label="Front-End Triage" value={triagePatients.length} />
        <Metric icon={<StepForward size={18} />} label="Fast Track" value={fastTrackPatients.length} />
        <Metric icon={<Hourglass size={18} />} label="Admission Pending" value={admissionPendingPatients.length} />
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
              <span>{guardrail.title}</span>
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
              {guardrail.metricValue ? <em>{guardrail.metricValue}</em> : null}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function ActivityPanel({ exportRuns, timeline }: { exportRuns: ActivityCsvRun[]; timeline: ActivityTimeline }) {
  const recentRecords = timeline.records.slice(-18).reverse();
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
      <div className="activityToolbar">
        <span>{timeline.records.length} timeline records</span>
        <div className="activityToolbarActions">
          <button type="button" onClick={handleDownloadTimelineCsv}>
            Download Activity CSV
          </button>
          <button type="button" onClick={handleDownloadAllRunsCsv}>
            Download All Runs CSV
          </button>
          <button type="button" onClick={handleCopyTimelineCsv}>
            Copy Activity CSV
          </button>
          <button type="button" onClick={handleCopyAllRunsCsv}>
            Copy All Runs CSV
          </button>
        </div>
      </div>
      {exportStatus ? <p className="activityExportStatus">{exportStatus}</p> : null}
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
  return (
    <div className={`metric ${className}`}>
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
      <div>
        <dt>Admission Requested</dt>
        <dd>{patient.dispositionType === "admit_inpatient" && patient.dispositionDecisionAt !== undefined ? formatMinute(patient.dispositionDecisionAt) : "-"}</dd>
      </div>
      <div>
        <dt>Admission Accepted</dt>
        <dd>{patient.admissionAcceptedAt === undefined ? "-" : formatMinute(patient.admissionAcceptedAt)}</dd>
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
