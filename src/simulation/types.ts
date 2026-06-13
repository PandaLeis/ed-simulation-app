export type ESILevel = 1 | 2 | 3 | 4 | 5;

export type ComplaintCategory =
  | "chest_pain"
  | "abdominal_pain"
  | "shortness_of_breath"
  | "injury"
  | "weakness_dizziness"
  | "fever_infection"
  | "behavioral_health"
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

export type PendingItemType = "labs" | "imaging" | "boarding_bed";

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

export interface Scenario {
  id: string;
  name: string;
  shiftStartMinute: number;
  shiftDurationMinutes: number;
  randomSeed: string;
  roomCapacity: number;
  providerCount: number;
  triageProviderEnabled: boolean;
  arrivalProfile: HourlyArrivalProfile[];
  esiDistribution: WeightedDistribution<ESILevel>;
  complaintDistribution: WeightedDistribution<ComplaintCategory>;
  workupDistribution: WeightedDistribution<WorkupType>;
  boardingProfile: BoardingProfile;
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
  lwbsBaseRisk: number;
  patienceProfile: "low" | "medium" | "high";
}

export interface PendingItem {
  type: PendingItemType;
  orderedAt: number;
  readyAt: number;
  completedAt?: number;
  status: "pending" | "ready" | "completed";
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
  details?: Record<string, unknown>;
}

export type SimulationEventType =
  | "simulation_started"
  | "simulation_paused"
  | "simulation_completed"
  | "shift_ended"
  | "patient_arrived"
  | "triage_bypassed"
  | "triage_completed"
  | "patient_roomed"
  | "provider_saw_patient"
  | "orders_placed"
  | "results_ready"
  | "results_reviewed"
  | "patient_ready_for_disposition"
  | "disposition_decision_made"
  | "patient_boarding_started"
  | "patient_departed"
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
  triageCensus: number;
  waitingRoomCensus: number;
  averageWaitingRoomWaitMinutes: number | null;
  longestWaitingRoomWaitMinutes: number;
  moderateOrHigherRiskWaitingPatients: number;
  highRiskWaitingPatients: number;
  criticalRiskWaitingPatients: number;
  waitingRoomRiskMinutes: number;
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
  events: SimulationEvent[];
  decisions: ProviderDecision[];
  metrics: SimulationMetrics;
}

export interface ProviderActionOption {
  type: ProviderActionType;
  label: string;
  enabled: boolean;
  disabledReason?: string;
  timeCostMinutes: number;
}
