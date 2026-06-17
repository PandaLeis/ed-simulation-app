import { useEffect, useMemo, useState } from "react";
import {
  Activity,
  Bed,
  Clock,
  Pause,
  Play,
  RotateCcw,
  Sparkles,
  StepForward,
  UserRoundCheck,
} from "lucide-react";

import { ACTION_LABELS, getAvailableProviderActions } from "../simulation/actionRules";
import { activityRunsToCsv, activityTimelineToCsv, createActivityTimeline } from "../simulation/activityTimeline";
import type { ActivityCsvRun } from "../simulation/activityTimeline";
import { generatePatientDeck } from "../simulation/arrivalGenerator";
import { createFlowGuardrails } from "../simulation/flowGuardrails";
import {
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
import {
  advanceOneMinute,
  applyProviderAction,
  createSimulationRun,
  pauseSimulation,
  setFrontEndTriageProviderEnabled,
  setFrontEndTriageProviderMode,
  startSimulation,
} from "../simulation/simulationEngine";
import type {
  PatientState,
  FlowGuardrailSummary,
  ProviderActionType,
  ProviderDebrief,
  ProviderState,
  OptimalFlowBenchmark,
  BenchmarkCoachRecommendation,
  ActivityTimeline,
  EDRoom,
  RuntimePatient,
  ScenarioPatient,
  ScenarioPresetId,
  ScenarioTuningConfig,
  SimulationRun,
  TriageProviderMode,
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

const triageColumn: BoardColumn = { title: "Front-End Triage", states: ["triage"] };

const baseBoardColumns: BoardColumn[] = [
  { title: "Waiting Room", states: ["waiting"] },
  { title: "Roomed: Awaiting Provider", states: ["roomed", "provider_seen"] },
  { title: "Roomed: Workup Pending", states: ["results_pending"] },
  { title: "Roomed: Results Ready", states: ["results_ready"] },
  { title: "Roomed: Disposition Needed", states: ["ready_for_disposition"] },
  { title: "Boarding", states: ["boarding"] },
  { title: "Departed", states: ["departed", "lwbs"] },
];

const defaultTuningConfig = getDefaultScenarioTuningConfig();
const DEFAULT_AUTO_ADVANCE_SECONDS = 2;
type SetupPanelTab = "live-operations" | "scenario" | "additional-stats";
type ColorMode = "light" | "dark";
type MainViewTab = "workflow" | "facility";
type RightRailTab = "actions" | "coach" | "guardrails" | "benchmark" | "debrief" | "activity";

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

function formatNumber(value: number | null): string {
  return value === null ? "-" : value.toFixed(0);
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

function providerNextAvailableText(provider: ProviderState): string {
  if (provider.status === "idle" || provider.busyUntilMinute === undefined) {
    return "Available now";
  }

  return `Available ${formatMinute(provider.busyUntilMinute)}`;
}

function boardLocationLabel(state: PatientState): string {
  switch (state) {
    case "triage":
      return "Front-End Triage";
    case "waiting":
      return "Waiting Room";
    case "roomed":
    case "provider_seen":
      return "Roomed: Awaiting Provider";
    case "results_pending":
      return "Roomed: Workup Pending";
    case "results_ready":
      return "Roomed: Results Ready";
    case "ready_for_disposition":
      return "Roomed: Disposition Needed";
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

function coreMetricTabs(run: SimulationRun): CoreMetricTab[] {
  return [
    {
      id: "waiting-room-census",
      label: "Waiting Room",
      value: String(run.metrics.waitingRoomCensus),
      subValue: "patients",
      measures: [
        { label: "Waiting room census", value: String(run.metrics.waitingRoomCensus) },
        { label: "Longest waiting-room wait", value: `${run.metrics.longestWaitingRoomWaitMinutes} min` },
        { label: "Average waiting-room wait", value: `${formatNumber(run.metrics.averageWaitingRoomWaitMinutes)} min` },
        { label: "Moderate-or-higher risk", value: String(run.metrics.moderateOrHigherRiskWaitingPatients) },
        { label: "High / critical risk", value: String(run.metrics.highRiskWaitingPatients) },
        { label: "Critical risk", value: String(run.metrics.criticalRiskWaitingPatients) },
        { label: "Waiting-room risk minutes", value: `${run.metrics.waitingRoomRiskMinutes} min` },
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
      ],
    },
    {
      id: "boarding-census",
      label: "Boarding",
      value: String(run.metrics.boardingCensus),
      subValue: "patients",
      measures: [
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
        { label: "Longest current wait", value: `${run.metrics.longestCurrentWaitMinutes} min` },
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
        { label: "Total boarding minutes", value: `${run.metrics.totalBoardingMinutes} min` },
      ],
    },
  ];
}

export function App() {
  const [draftTuning, setDraftTuning] = useState<ScenarioTuningConfig>(defaultTuningConfig);
  const [activeTuning, setActiveTuning] = useState<ScenarioTuningConfig>(defaultTuningConfig);
  const [selectedPresetId, setSelectedPresetId] = useState<ScenarioPresetId>("default");
  const scenario = useMemo(() => createScenarioFromTuning(activeTuning), [activeTuning]);
  const [activeDeck, setActiveDeck] = useState<ScenarioPatient[]>(() => createRunBundle(createScenarioFromTuning(defaultTuningConfig)).deck);
  const [run, setRun] = useState<SimulationRun>(() =>
    createSimulationRun(createScenarioFromTuning(defaultTuningConfig), activeDeck),
  );
  const [selectedPatientId, setSelectedPatientId] = useState<string | undefined>();
  const [selectedCoreMetricId, setSelectedCoreMetricId] = useState("waiting-room-census");
  const [selectedSetupPanelTab, setSelectedSetupPanelTab] = useState<SetupPanelTab>("live-operations");
  const [selectedMainViewTab, setSelectedMainViewTab] = useState<MainViewTab>("workflow");
  const [selectedRightRailTab, setSelectedRightRailTab] = useState<RightRailTab>("actions");
  const [autoAdvanceSeconds, setAutoAdvanceSeconds] = useState(DEFAULT_AUTO_ADVANCE_SECONDS);
  const [coachDemoEnabled, setCoachDemoEnabled] = useState(false);
  const [colorMode, setColorMode] = useState<ColorMode>("light");
  const [showHeartMetrics, setShowHeartMetrics] = useState(true);
  const [showSepsisMetrics, setShowSepsisMetrics] = useState(true);

  const selectedPatient = useMemo(
    () => run.patients.find((patient) => patient.id === selectedPatientId),
    [run.patients, selectedPatientId],
  );
  const availableActions = getAvailableProviderActions(run, selectedPatient?.id);
  const boardColumns = useMemo(
    () => (activeTuning.triageProviderMode !== "unavailable" ? [triageColumn, ...baseBoardColumns] : baseBoardColumns),
    [activeTuning.triageProviderMode],
  );
  const coreMetrics = coreMetricTabs(run);
  const providerSuggestions = getProviderSuggestions(run);
  const flowGuardrails = useMemo(() => createFlowGuardrails(run), [run]);
  const debrief = useMemo(() => createProviderDebrief(run), [run]);
  const benchmark = useMemo(() => createOptimalFlowBenchmark(scenario, activeDeck, run), [activeDeck, run, scenario]);
  const activityTimeline = useMemo(() => createActivityTimeline(run, benchmark.benchmarkRun), [benchmark.benchmarkRun, run]);
  const activityExportRuns = useMemo<ActivityCsvRun[]>(
    () => [
      { run, strategyId: "provider_run", strategyLabel: "Provider Run" },
      { run: benchmark.benchmarkRun, strategyId: "optimal_flow", strategyLabel: "Optimal Flow Coach" },
      { run: benchmark.frontEndFocusRun, strategyId: "front_end_focus", strategyLabel: "Front-End Focus Coach" },
      { run: benchmark.middleFlowFocusRun, strategyId: "middle_flow_focus", strategyLabel: "Middle Flow Focus Coach" },
      { run: benchmark.dispositionFocusRun, strategyId: "disposition_focus", strategyLabel: "Disposition Focus Coach" },
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
    draftTuning.shiftDurationMinutes !== activeTuning.shiftDurationMinutes ||
    draftTuning.expectedArrivalsPerHour !== activeTuning.expectedArrivalsPerHour ||
    draftTuning.providerEvaluationTypicalMinutes !== activeTuning.providerEvaluationTypicalMinutes ||
    draftTuning.triageTypicalMinutes !== activeTuning.triageTypicalMinutes ||
    draftTuning.labTurnaroundTypicalMinutes !== activeTuning.labTurnaroundTypicalMinutes ||
    draftTuning.imagingTurnaroundTypicalMinutes !== activeTuning.imagingTurnaroundTypicalMinutes ||
    draftTuning.boardingDurationTypicalMinutes !== activeTuning.boardingDurationTypicalMinutes ||
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
              <Metric icon={<Activity size={18} />} label="Active Census" value={run.metrics.activePatientCensus} />
              <Metric icon={<Clock size={18} />} label="Longest Wait" value={`${run.metrics.longestCurrentWaitMinutes} min`} />
              <Metric
                icon={<UserRoundCheck size={18} />}
                label="Seen / Hour"
                value={run.metrics.patientsSeenPerHour.toFixed(1)}
              />
              <Metric
                label="Results to Disp"
                value={`${formatNumber(run.metrics.averageResultsReadyToDispositionMinutes)} min`}
              />
              <Metric icon={<Bed size={18} />} label="Boarding Min" value={run.metrics.totalBoardingMinutes} />
              <Metric label="LWBS" value={`${run.metrics.patientsLWBS} / ${(run.metrics.lwbsRate * 100).toFixed(1)}%`} />
              {showHeartMetrics ? (
                <>
                  <Metric
                    className="cardiacMetric"
                    label="Door ECG <=10"
                    value={`${(run.metrics.doorToEcgWithin10Rate * 100).toFixed(0)}%`}
                  />
                  <Metric
                    className="cardiacMetric"
                    label="Median Door ECG"
                    value={`${formatNumber(run.metrics.medianDoorToEcgMinutes)} min`}
                  />
                  <Metric
                    className="cardiacMetric"
                    label="P90 Door ECG"
                    value={`${formatNumber(run.metrics.p90DoorToEcgMinutes)} min`}
                  />
                  <Metric
                    className="cardiacMetric"
                    label="ECG Reviewed <=10"
                    value={`${(run.metrics.ecgReviewedWithin10Rate * 100).toFixed(0)}%`}
                  />
                  <Metric
                    className="cardiacMetric"
                    label="Troponin TAT"
                    value={`${formatNumber(run.metrics.averageTroponinTurnaroundMinutes)} min`}
                  />
                  <Metric
                    className="cardiacMetric"
                    label="Chest Pain LWBS"
                    value={`${run.metrics.chestPainLWBS} / ${(run.metrics.chestPainLWBSRate * 100).toFixed(0)}%`}
                  />
                </>
              ) : null}
              {showSepsisMetrics ? (
                <>
                  <Metric
                    className="sepsisMetric"
                    label="Sepsis Rec <=10"
                    value={`${(run.metrics.sepsisRecognitionWithin10Rate * 100).toFixed(0)}%`}
                  />
                  <Metric
                    className="sepsisMetric"
                    label="Door Antibiotics"
                    value={`${formatNumber(run.metrics.averageDoorToAntibioticsMinutes)} min`}
                  />
                  <Metric
                    className="sepsisMetric"
                    label="Abx <=60"
                    value={`${(run.metrics.sepsisAntibioticsWithin60Rate * 100).toFixed(0)}%`}
                  />
                  <Metric
                    className="sepsisMetric"
                    label="Sepsis Waiting"
                    value={run.metrics.sepsisWaitingWithoutRoom}
                  />
                  <Metric
                    className="sepsisMetric"
                    label="Sepsis LWBS"
                    value={`${run.metrics.sepsisLWBS} / ${(run.metrics.sepsisLWBSRate * 100).toFixed(0)}%`}
                  />
                </>
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
                  <span>Provider count</span>
                  <div className="providerButtonGroup" role="group" aria-label="Provider count">
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
                <label className="toggleControl scenarioToggle lwbsToggleControl">
                  <span>LWBS Enabled</span>
                  <input
                    checked={draftTuning.lwbsEnabled}
                    onChange={(event) => updateDraftTuning("lwbsEnabled", event.currentTarget.checked)}
                    type="checkbox"
                  />
                  <small>{draftTuning.lwbsEnabled ? "LWBS Enabled" : "LWBS Disabled"}</small>
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
              <span>{selectedCoreMetric.label}</span>
              <strong>{selectedCoreMetric.value}</strong>
              <small>{selectedCoreMetric.subValue}</small>
              <dl className="tabMeasures">
                {selectedCoreMetric.measures.map((measure) => (
                  <div key={measure.label}>
                    <dt>{measure.label}</dt>
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
          return (
            <article className="providerRosterCard" key={provider.id}>
              <div className="providerRosterHeader">
                <strong>{provider.displayName}</strong>
                <span className={`providerRosterBadge ${provider.status}`}>{provider.status}</span>
              </div>
              <div className="providerRosterDetails">
                <small>{providerCurrentWorkText(provider, suggestion)}</small>
                <small>{providerLocationText(provider, run, suggestion)}</small>
                <small>{providerNextAvailableText(provider)}</small>
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
        </div>

        {selectedMainViewTab === "workflow" ? (
          <section
            aria-labelledby="workflow-view-tab"
            className="workspace"
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
                  aria-controls="right-rail-benchmark"
                  aria-selected={selectedRightRailTab === "benchmark"}
                  className={selectedRightRailTab === "benchmark" ? "active" : ""}
                  id="right-rail-benchmark-tab"
                  onClick={() => setSelectedRightRailTab("benchmark")}
                  role="tab"
                  type="button"
                >
                  Benchmark
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

                {selectedRightRailTab === "benchmark" ? (
                  <>
                    <h2>Benchmark</h2>
                    <BenchmarkPanel benchmark={benchmark} />
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
  const boardingPatients = patients.filter((patient) => patient.state === "boarding");
  const occupiedRooms = rooms.filter((room) => room.status === "occupied").length;
  const blockedRooms = rooms.filter((room) => room.status === "blocked").length;
  const availableRooms = rooms.filter((room) => room.status === "available").length;

  return (
    <div className="facilityView">
      <section className="facilitySummary" aria-label="Facility summary">
        <Metric icon={<Bed size={18} />} label="Rooms Available" value={availableRooms} />
        <Metric label="Rooms Occupied" value={occupiedRooms} />
        <Metric label="Rooms Blocked" value={blockedRooms} />
        <Metric label="Waiting Room" value={waitingPatients.length} />
        <Metric label="Front-End Triage" value={triagePatients.length} />
        <Metric label="Boarding" value={boardingPatients.length} />
      </section>

      <section className="roomMapPanel" aria-label="Room map">
        <div className="roomMapHeader">
          <div>
            <h2>Room Map</h2>
            <small>
              {rooms.length} ED rooms · {availableRooms} available · {blockedRooms} blocked
            </small>
          </div>
          <div className="roomLegend" aria-label="Room status legend">
            <span className="available">Available</span>
            <span className="occupied">Occupied</span>
            <span className="blocked">Blocked</span>
          </div>
        </div>

        <div className="roomGrid">
          {rooms.map((room) => {
            const patient = patients.find((candidate) => candidate.id === room.patientId);
            const hasPatient = patient !== undefined;
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
                <strong>{roomPatientLabel(patient)}</strong>
                <small>{roomDetailText(room, patient)}</small>
                {patient ? <small>{waitMinutes(patient, currentMinute)} min in system</small> : null}
              </button>
            );
          })}
        </div>
      </section>
    </div>
  );
}

function BenchmarkPanel({ benchmark }: { benchmark: OptimalFlowBenchmark }) {
  return (
    <div className="benchmarkPanel">
      <strong>{benchmark.headline}</strong>
      <section className="whatIfComparison" aria-label="What-if coach comparison">
        <h3>What-If Coach Comparison</h3>
        <p>{benchmark.whatIfComparison.headline}</p>
        <div className="whatIfGrid">
          {benchmark.whatIfComparison.summaries.map((summary) => (
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
                  <dd>{summary.longestWaitMinutes} min</dd>
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
        </div>
      </section>
      <dl className="benchmarkGrid">
        {benchmark.comparisons.map((comparison) => (
          <div className={comparison.interpretation} key={comparison.label}>
            <dt>{comparison.label}</dt>
            <dd>
              <span>Actual {comparison.actual}</span>
              <span>Optimal {comparison.benchmark}</span>
              <strong>{comparison.delta}</strong>
            </dd>
          </div>
        ))}
      </dl>
      <div className="debriefBlock">
        <h3>Flow Opportunities</h3>
        {benchmark.opportunities.length === 0 ? (
          <p className="emptyState">No patient-level benchmark gaps flagged yet.</p>
        ) : (
          <ul className="feedbackList">
            {benchmark.opportunities.map((opportunity) => (
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

function FlowGuardrailsPanel({ summary }: { summary: FlowGuardrailSummary }) {
  return (
    <div className="debriefPanel">
      <strong>{summary.headline}</strong>
      <ul className="feedbackList">
        {summary.guardrails.map((guardrail) => (
          <li className={guardrail.severity} key={guardrail.id}>
            <span>{guardrail.title}</span>
            <small>{guardrail.message}</small>
            {guardrail.metricValue ? <em>{guardrail.metricValue}</em> : null}
          </li>
        ))}
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
        <dt>{isTerminalPatient(patient) ? "Elapsed" : "Wait"}</dt>
        <dd>{waitMinutes(patient, currentMinute)} min</dd>
      </div>
      <div>
        <dt>Waiting Risk</dt>
        <dd>{riskDisplay.label}</dd>
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
                  <small>
                    {stateLabel(order.status)}
                    {order.readyAt === undefined ? "" : `, ready ${formatMinute(order.readyAt)}`}
                    {order.completedAt === undefined ? "" : `, completed ${formatMinute(order.completedAt)}`}
                  </small>
                </li>
              ))}
            </ul>
          )}
        </dd>
      </div>
      <div className="detailExpectedOrders">
        <dt>Expected Order Groups</dt>
        <dd>{workup.expectedOrders.length === 0 ? "None" : workup.expectedOrders.join(", ")}</dd>
      </div>
      <div className="detailDisposition">
        <dt>Disposition</dt>
        <dd>{patient.dispositionType?.replaceAll("_", " ") ?? "-"}</dd>
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
