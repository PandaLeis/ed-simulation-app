export type ESILevel = 1 | 2 | 3 | 4 | 5;

export type ComplaintCategory =
  | "suspected_acs"
  | "chest_pain"
  | "abdominal_pain"
  | "shortness_of_breath"
  | "injury"
  | "weakness_dizziness"
  | "fever_infection"
  | "behavioral_health"
  | "stroke_neuro"
  | "sepsis_concern"
  | "major_trauma"
  | "pediatric"
  | "ob_pregnancy"
  | "syncope"
  | "altered_mental_status"
  | "overdose_intoxication"
  | "renal_urinary"
  | "gi_bleed"
  | "allergic_reaction"
  | "burn"
  | "eye_ent"
  | "back_pain"
  | "hypertensive_symptoms"
  | "diabetic_emergency"
  | "social_placement"
  | "minor_complaint";

export type WorkupType = "none" | "basic_labs" | "labs_imaging" | "cardiac" | "complex";

export type DispositionType = "discharge_home" | "admit_inpatient" | "observation" | "lwbs";

export type PatientState =
  | "not_arrived"
  | "triage"
  | "waiting"
  | "roomed"
  | "provider_seen"
  | "orders_placed"
  | "results_pending"
  | "results_ready"
  | "ready_for_disposition"
  | "disposition_decision_made"
  | "boarding"
  | "departed"
  | "lwbs";

export type RiskLevel = "low" | "moderate" | "high" | "critical";

export type PendingItemType =
  | "labs"
  | "imaging"
  | "ecg"
  | "troponin"
  | "repeat_troponin"
  | "chest_xray"
  | "lactate"
  | "blood_cultures"
  | "antibiotics"
  | "iv_fluids"
  | "boarding_bed";

export type CardiacPathway = "none" | "possible_acs" | "stemi_alert";

export type TriageProviderMode = "unavailable" | "manual" | "automated";

export type ProviderActionType =
  | "complete_triage"
  | "room_patient"
  | "start_protocol_orders"
  | "see_patient"
  | "place_orders"
  | "review_results"
  | "discharge_home"
  | "admit_inpatient"
  | "continue_waiting";

export interface WeightedDistribution<T extends string | number> {
  values: Array<{
    value: T;
    weight: number;
  }>;
}

export interface HourlyArrivalProfile {
  hourOffset: number;
  expectedArrivals: number;
}

export interface BoardingProfile {
  enabled: boolean;
  admitBoardingDelayMin: number;
  admitBoardingDelayMax: number;
}

export interface LWBSProfile {
  enabled: boolean;
  minimumWaitBeforeLWBS: number;
  lowPatienceMultiplier: number;
  mediumPatienceMultiplier: number;
  highPatienceMultiplier: number;
  highAcuityBlockedEsiLevels: ESILevel[];
}

export type TriageDurationProfile = Record<ComplaintCategory, number>;

export interface PertTimingRange {
  min: number;
  typical: number;
  max: number;
}

export interface TimingProfile {
  providerEvaluation: PertTimingRange;
  triage: PertTimingRange;
  labTurnaround: PertTimingRange;
  imagingTurnaround: PertTimingRange;
  boardingDuration: PertTimingRange;
}

export interface Scenario {
  id: string;
  name: string;
  shiftStartMinute: number;
  shiftDurationMinutes: number;
  randomSeed: string;
  roomCapacity: number;
  providerCount: number;
  triageProviderEnabled: boolean;
  triageProviderMode: TriageProviderMode;
  arrivalProfile: HourlyArrivalProfile[];
  esiDistribution: WeightedDistribution<ESILevel>;
  complaintDistribution: WeightedDistribution<ComplaintCategory>;
  workupDistribution: WeightedDistribution<WorkupType>;
  triageDurationProfile: TriageDurationProfile;
  triageDurationMultiplier: number;
  timingProfile: TimingProfile;
  boardingProfile: BoardingProfile;
  lwbsProfile: LWBSProfile;
}

export interface ScenarioTuningConfig {
  triageProviderEnabled: boolean;
  triageProviderMode: TriageProviderMode;
  roomCapacity: number;
  providerCount: number;
  shiftDurationMinutes: number;
  expectedArrivalsPerHour: number;
  triageDurationMultiplier: number;
  providerEvaluationTypicalMinutes: number;
  triageTypicalMinutes: number;
  labTurnaroundTypicalMinutes: number;
  imagingTurnaroundTypicalMinutes: number;
  boardingDurationTypicalMinutes: number;
  admitBoardingDelayMinutes: number;
  lwbsEnabled: boolean;
  minimumWaitBeforeLWBS: number;
}

export type ScenarioPresetId = "default" | "boarding_surge" | "high_arrivals" | "low_room_capacity";

export interface ScenarioPreset {
  id: ScenarioPresetId;
  label: string;
  description: string;
}

export interface ScenarioPatient {
  id: string;
  scenarioId: string;
  patientNumber: number;
  arrivalMinute: number;
  esi: ESILevel;
  complaintCategory: ComplaintCategory;
  ageBand: string;
  workupType: WorkupType;
  admitProbability: number;
  dischargeProbability: number;
  observationProbability: number;
  expectedLabMinutes: number;
  expectedImagingMinutes: number;
  expectedBoardingMinutes: number;
  cardiacPathway: CardiacPathway;
  lwbsBaseRisk: number;
  patienceProfile: "low" | "medium" | "high";
}

export interface PendingItem {
  type: PendingItemType;
  orderedAt: number;
  readyAt: number;
  collectedAt?: number;
  completedAt?: number;
  status: "pending" | "ready" | "completed";
  name?: string;
}

export interface RuntimePatient extends ScenarioPatient {
  state: PatientState;
  arrivalPath?: "front_end_triage" | "direct_waiting_room";
  roomId?: string;
  arrivedAt?: number;
  triagedAt?: number;
  roomedAt?: number;
  providerSeenAt?: number;
  ordersPlacedAt?: number;
  resultsReadyAt?: number;
  resultsReviewedAt?: number;
  readyForDispositionAt?: number;
  dispositionDecisionAt?: number;
  departedAt?: number;
  lwbsAt?: number;
  ecgCompletedAt?: number;
  ecgReviewedAt?: number;
  stemiAlertActivatedAt?: number;
  sepsisRecognizedAt?: number;
  dispositionType?: DispositionType;
  pendingItems: PendingItem[];
  riskLevel: RiskLevel;
}

export interface EDRoom {
  id: string;
  patientId?: string;
  status: "available" | "occupied" | "blocked";
}

export interface ProviderAction {
  type: ProviderActionType;
  patientId?: string;
  providerId?: string;
  decisionId: string;
  startedAt: number;
  completedAt: number;
}

export interface ProviderState {
  id: string;
  displayName: string;
  status: "idle" | "busy";
  busyUntilMinute?: number;
  currentAction?: ProviderAction;
  busyMinutes: number;
  idleMinutes: number;
}

export type SimulationRunType = "original" | "replay" | "benchmark";

export interface ProviderDecision {
  id: string;
  runId: string;
  simulationMinute: number;
  patientId?: string;
  actionType: ProviderActionType;
  actionLabel: string;
  timeCostMinutes: number;
  previousState?: PatientState;
  resultingState?: PatientState;
  providerId?: string;
  details?: Record<string, unknown>;
}

export type SimulationEventType =
  | "simulation_started"
  | "simulation_paused"
  | "simulation_completed"
  | "shift_ended"
  | "patient_arrived"
  | "triage_bypassed"
  | "triage_reopened"
  | "triage_completed"
  | "patient_roomed"
  | "provider_saw_patient"
  | "orders_placed"
  | "ecg_completed"
  | "ecg_reviewed"
  | "stemi_alert_activated"
  | "results_ready"
  | "results_reviewed"
  | "patient_ready_for_disposition"
  | "disposition_decision_made"
  | "patient_boarding_started"
  | "patient_departed"
  | "patient_lwbs"
  | "room_available"
  | "metric_updated";

export interface SimulationEvent {
  id: string;
  runId: string;
  simulationMinute: number;
  type: SimulationEventType;
  patientId?: string;
  previousState?: PatientState;
  newState?: PatientState;
  message: string;
  details?: Record<string, unknown>;
}

export interface SimulationMetrics {
  patientsArrived: number;
  patientsSeen: number;
  patientsDispositioned: number;
  patientsDeparted: number;
  patientsLWBS: number;
  lwbsRate: number;
  averageWaitBeforeLWBS: number | null;
  highRiskLWBS: number;
  lwbsWithOrdersPending: number;
  triageCensus: number;
  waitingRoomCensus: number;
  averageWaitingRoomWaitMinutes: number | null;
  longestWaitingRoomWaitMinutes: number;
  moderateOrHigherRiskWaitingPatients: number;
  highRiskWaitingPatients: number;
  criticalRiskWaitingPatients: number;
  waitingRoomRiskMinutes: number;
  chestPainPatientsArrived: number;
  suspectedAcsPatientsArrived: number;
  stemiAlertsActivated: number;
  averageDoorToEcgMinutes: number | null;
  doorToEcgWithin10Rate: number;
  medianDoorToEcgMinutes: number | null;
  p90DoorToEcgMinutes: number | null;
  ecgReviewedWithin10Rate: number;
  averageDoorToTroponinCollectionMinutes: number | null;
  averageTroponinTurnaroundMinutes: number | null;
  averageEcgToStemiActivationMinutes: number | null;
  delayedEcgCount: number;
  cardiacResultsReadyAwaitingReview: number;
  chestPainLWBS: number;
  chestPainLWBSRate: number;
  suspectedAcsLWBS: number;
  suspectedAcsLWBSRate: number;
  sepsisPatientsArrived: number;
  sepsisPathwayStarted: number;
  sepsisRecognitionWithin10Rate: number;
  averageDoorToSepsisRecognitionMinutes: number | null;
  averageDoorToLactateCollectionMinutes: number | null;
  averageDoorToLactateResultMinutes: number | null;
  averageDoorToBloodCulturesMinutes: number | null;
  averageDoorToAntibioticsMinutes: number | null;
  sepsisAntibioticsWithin60Rate: number;
  medianDoorToAntibioticsMinutes: number | null;
  p90DoorToAntibioticsMinutes: number | null;
  averageDoorToFluidsMinutes: number | null;
  sepsisWaitingWithoutRoom: number;
  sepsisLWBS: number;
  sepsisLWBSRate: number;
  activePatientCensus: number;
  boardingCensus: number;
  availableRooms: number;
  occupiedRooms: number;
  blockedRooms: number;
  longestCurrentWaitMinutes: number;
  patientsSeenPerHour: number;
  averageDoorToProviderMinutes: number | null;
  averageTimeToDispositionMinutes: number | null;
  averageResultsReadyToDispositionMinutes: number | null;
  averageEDLengthOfStayMinutes: number | null;
  totalBoardingMinutes: number;
  providerBusyMinutes: number;
  providerIdleMinutes: number;
  peakWaitingRoomCensus: number;
  peakActivePatientCensus: number;
}

export interface SimulationRun {
  id: string;
  scenarioId: string;
  triageProviderEnabled: boolean;
  triageProviderMode: TriageProviderMode;
  runType: SimulationRunType;
  parentRunId?: string;
  shiftStartMinute: number;
  currentMinute: number;
  startedAt: string;
  endedAt?: string;
  status: "not_started" | "running" | "paused" | "shift_ended" | "completed";
  patients: RuntimePatient[];
  rooms: EDRoom[];
  provider: ProviderState;
  providers: ProviderState[];
  triageProvider: ProviderState;
  triageDurationProfile: TriageDurationProfile;
  triageDurationMultiplier: number;
  timingProfile: TimingProfile;
  events: SimulationEvent[];
  decisions: ProviderDecision[];
  metrics: SimulationMetrics;
}

export type DebriefFeedbackKind = "positive" | "opportunity" | "watch";

export interface DebriefFeedbackItem {
  id: string;
  kind: DebriefFeedbackKind;
  title: string;
  message: string;
  metricValue?: string;
  patientId?: string;
}

export interface PatientTimelineIssue {
  patientId: string;
  label: string;
  detail: string;
  minutes?: number;
}

export interface ProviderDebrief {
  headline: string;
  summary: Array<{
    label: string;
    value: string;
  }>;
  bottlenecks: DebriefFeedbackItem[];
  decisionFeedback: DebriefFeedbackItem[];
  notablePatients: PatientTimelineIssue[];
}

export type FlowGuardrailSeverity = "good" | "watch" | "urgent";

export interface FlowGuardrail {
  id: string;
  severity: FlowGuardrailSeverity;
  title: string;
  message: string;
  metricValue?: string;
  patientId?: string;
}

export interface FlowGuardrailSummary {
  headline: string;
  activeCount: number;
  guardrails: FlowGuardrail[];
}

export interface BenchmarkMetricComparison {
  label: string;
  actual: string;
  benchmark: string;
  delta: string;
  interpretation: "better" | "worse" | "same";
}

export interface BenchmarkPatientOpportunity {
  patientId: string;
  label: string;
  detail: string;
  actualMinute?: number;
  benchmarkMinute?: number;
}

export interface OptimalFlowBenchmark {
  benchmarkRun: SimulationRun;
  frontEndFocusRun: SimulationRun;
  middleFlowFocusRun: SimulationRun;
  dispositionFocusRun: SimulationRun;
  headline: string;
  comparisons: BenchmarkMetricComparison[];
  opportunities: BenchmarkPatientOpportunity[];
  whatIfComparison: WhatIfCoachComparison;
}

export interface BenchmarkCoachRecommendation {
  patientId: string;
  actionType: ProviderActionType;
  actionLabel: string;
  reason: string;
  prioritySummary: string;
}

export type WhatIfCoachStrategyId =
  | "provider_run"
  | "optimal_flow"
  | "front_end_focus"
  | "middle_flow_focus"
  | "disposition_focus";

export interface WhatIfCoachStrategySummary {
  id: WhatIfCoachStrategyId;
  label: string;
  description: string;
  patientsDeparted: number;
  patientsLWBS: number;
  longestWaitMinutes: number;
  patientsSeenPerHour: number;
  resultsReadyWaiting: number;
  totalBoardingMinutes: number;
  doorToEcgWithin10Rate: number;
  sepsisAntibioticsWithin60Rate: number;
}

export interface WhatIfCoachComparison {
  headline: string;
  summaries: WhatIfCoachStrategySummary[];
}

export type ActivityRecordKind = "event" | "decision" | "benchmark";

export interface ActivityRecord {
  id: string;
  runId: string;
  simulationMinute: number;
  kind: ActivityRecordKind;
  label: string;
  message: string;
  patientId?: string;
  providerId?: string;
  actionType?: ProviderActionType;
  eventType?: SimulationEventType;
  previousState?: PatientState;
  resultingState?: PatientState;
  timeCostMinutes?: number;
  benchmarkMinute?: number;
  benchmarkDeltaMinutes?: number;
}

export interface ActivityTimeline {
  records: ActivityRecord[];
  actualDecisionCount: number;
  benchmarkDecisionCount: number;
  matchedDecisionCount: number;
  averageDecisionDelayMinutes: number | null;
}

export interface ProviderActionOption {
  type: ProviderActionType;
  label: string;
  enabled: boolean;
  disabledReason?: string;
  timeCostMinutes: number;
}
