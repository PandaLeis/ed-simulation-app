import { useMemo, useState } from "react";
import {
  Activity,
  Bed,
  Clock,
  Pause,
  Play,
  RotateCcw,
  StepForward,
  UserRoundCheck,
} from "lucide-react";

import { getAvailableProviderActions } from "../simulation/actionRules";
import { generatePatientDeck } from "../simulation/arrivalGenerator";
import { defaultScenario } from "../simulation/mockScenario";
import { getPatientWorkupSummary } from "../simulation/workupSummary";
import {
  advanceOneMinute,
  applyProviderAction,
  createSimulationRun,
  pauseSimulation,
  setFrontEndTriageProviderEnabled,
  startSimulation,
} from "../simulation/simulationEngine";
import type {
  PatientState,
  ProviderActionType,
  RuntimePatient,
  Scenario,
  SimulationRun,
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

const triageColumn: BoardColumn = { title: "Front-End Triage", states: ["triage"] };

const baseBoardColumns: BoardColumn[] = [
  { title: "Waiting Room", states: ["waiting"] },
  { title: "Roomed / Active", states: ["roomed", "provider_seen"] },
  { title: "Results Pending", states: ["results_pending"] },
  { title: "Results Ready", states: ["results_ready"] },
  { title: "Ready for Disposition", states: ["ready_for_disposition"] },
  { title: "Boarding", states: ["boarding"] },
  { title: "Departed", states: ["departed", "lwbs"] },
];

function createScenario(triageProviderEnabled: boolean): Scenario {
  return {
    ...defaultScenario,
    triageProviderEnabled,
  };
}

function createInitialRun(scenario: Scenario): SimulationRun {
  return createSimulationRun(scenario, generatePatientDeck(scenario));
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

function waitMinutes(patient: RuntimePatient, currentMinute: number): number {
  return patient.arrivedAt === undefined ? 0 : Math.max(0, currentMinute - patient.arrivedAt);
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
      ],
    },
    {
      id: "front-end-triage-census",
      label: "Front-End Triage",
      value: String(run.metrics.triageCensus),
      subValue: run.triageProviderEnabled ? "patients" : "off",
      measures: [
        { label: "Triage mode", value: run.triageProviderEnabled ? "On" : "Off" },
        { label: "In front-end triage", value: String(run.metrics.triageCensus) },
        { label: "Arrived patients", value: String(run.metrics.patientsArrived) },
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
      id: "active-patient-census",
      label: "Active Census",
      value: String(run.metrics.activePatientCensus),
      subValue: "patients",
      measures: [
        { label: "Active census", value: String(run.metrics.activePatientCensus) },
        { label: "Patients seen", value: String(run.metrics.patientsSeen) },
        { label: "Patients seen / hour", value: run.metrics.patientsSeenPerHour.toFixed(1) },
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
  const [triageProviderEnabled, setTriageProviderEnabled] = useState(defaultScenario.triageProviderEnabled);
  const scenario = useMemo(() => createScenario(triageProviderEnabled), [triageProviderEnabled]);
  const [run, setRun] = useState<SimulationRun>(() => createInitialRun(createScenario(defaultScenario.triageProviderEnabled)));
  const [selectedPatientId, setSelectedPatientId] = useState<string | undefined>();
  const [selectedCoreMetricId, setSelectedCoreMetricId] = useState("waiting-room-census");

  const selectedPatient = useMemo(
    () => run.patients.find((patient) => patient.id === selectedPatientId),
    [run.patients, selectedPatientId],
  );
  const availableActions = getAvailableProviderActions(run, selectedPatient?.id);
  const boardColumns = useMemo(
    () => (triageProviderEnabled ? [triageColumn, ...baseBoardColumns] : baseBoardColumns),
    [triageProviderEnabled],
  );
  const coreMetrics = coreMetricTabs(run);
  const selectedCoreMetric =
    coreMetrics.find((metric) => metric.id === selectedCoreMetricId) ??
    coreMetrics.find((metric) => metric.id === "waiting-room-census");

  if (!selectedCoreMetric) {
    return null;
  }

  function updateRun(nextRun: SimulationRun) {
    setRun(nextRun);
  }

  function handleStartPause() {
    if (run.status === "running") {
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
    updateRun(applyProviderAction(run, actionType, selectedPatient?.id));
  }

  function handleReset() {
    setSelectedPatientId(undefined);
    setRun(createInitialRun(scenario));
  }

  function handleTriageProviderToggle(enabled: boolean) {
    setTriageProviderEnabled(enabled);
    setRun(setFrontEndTriageProviderEnabled(run, enabled));
  }

  return (
    <main className="appShell">
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

      <section className="controlStrip" aria-label="Simulation controls">
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
        <button type="button" onClick={handleReset}>
          <RotateCcw size={18} />
          Reset
        </button>
        <div className="providerStatus">
          <UserRoundCheck size={18} />
          <span>
            Provider {run.provider.status}
            {run.provider.currentAction ? ` until ${formatMinute(run.provider.currentAction.completedAt)}` : ""}
          </span>
        </div>
        <label className="toggleControl">
          <input
            checked={triageProviderEnabled}
            onChange={(event) => handleTriageProviderToggle(event.currentTarget.checked)}
            type="checkbox"
          />
          <span>Front-end triage provider</span>
        </label>
      </section>

      <section className="metricsGrid" aria-label="Live metrics">
        <Metric icon={<Activity size={18} />} label="Active Census" value={run.metrics.activePatientCensus} />
        <Metric icon={<Clock size={18} />} label="Longest Wait" value={`${run.metrics.longestCurrentWaitMinutes} min`} />
        <Metric icon={<UserRoundCheck size={18} />} label="Seen / Hour" value={run.metrics.patientsSeenPerHour.toFixed(1)} />
        <Metric
          label="Results to Disp"
          value={`${formatNumber(run.metrics.averageResultsReadyToDispositionMinutes)} min`}
        />
        <Metric icon={<Bed size={18} />} label="Boarding Min" value={run.metrics.totalBoardingMinutes} />
      </section>

      <section className="coreMetricTabs" aria-label="Core live metrics">
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

      <section className="workspace">
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
          <section className="panelSection">
            <h2>Patient</h2>
            {selectedPatient ? (
              <PatientDetails currentMinute={run.currentMinute} patient={selectedPatient} />
            ) : (
              <p className="emptyState">Select a patient card.</p>
            )}
          </section>

          <section className="panelSection">
            <h2>Actions</h2>
            <div className="actionList">
              {availableActions.map((action) => (
                <button
                  disabled={!action.enabled}
                  key={action.type}
                  onClick={() => handleAction(action.type)}
                  title={action.disabledReason}
                  type="button"
                >
                  <span>{action.label}</span>
                  <small>{action.timeCostMinutes}m</small>
                </button>
              ))}
            </div>
          </section>

          <section className="panelSection">
            <h2>Recent Events</h2>
            <ol className="eventList">
              {run.events.slice(-8).reverse().map((event) => (
                <li key={event.id}>
                  <time>{formatMinute(event.simulationMinute)}</time>
                  <span>{event.message}</span>
                </li>
              ))}
            </ol>
          </section>
        </aside>
      </section>
    </main>
  );
}

function Metric({
  icon,
  label,
  value,
}: {
  icon?: React.ReactNode;
  label: string;
  value: number | string;
}) {
  return (
    <div className="metric">
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
  isSelected,
  onSelect,
  patient,
}: {
  currentMinute: number;
  isSelected: boolean;
  onSelect: () => void;
  patient: RuntimePatient;
}) {
  return (
    <button className={`patientCard ${isSelected ? "selected" : ""}`} onClick={onSelect} type="button">
      <div className="cardTopline">
        <strong>{patient.id}</strong>
        <span className={`riskBadge ${patient.riskLevel}`}>{patient.riskLevel}</span>
      </div>
      <div className="patientMeta">
        <span>ESI {patient.esi}</span>
        <span>{patient.complaintCategory.replaceAll("_", " ")}</span>
      </div>
      <div className="patientMeta">
        <span>Wait {waitMinutes(patient, currentMinute)}m</span>
        <span>{stateLabel(patient.state)}</span>
      </div>
    </button>
  );
}

function PatientDetails({ currentMinute, patient }: { currentMinute: number; patient: RuntimePatient }) {
  const workup = getPatientWorkupSummary(patient);

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
        <dt>Wait</dt>
        <dd>{waitMinutes(patient, currentMinute)} min</dd>
      </div>
      <div>
        <dt>Room</dt>
        <dd>{patient.roomId ?? "-"}</dd>
      </div>
      <div>
        <dt>Pending</dt>
        <dd>{workup.pendingOrders.length === 0 ? "-" : `${workup.pendingOrders.length} item(s)`}</dd>
      </div>
      <div className="detailWide">
        <dt>Expected Orders</dt>
        <dd>{workup.expectedOrders.length === 0 ? "None" : workup.expectedOrders.join(", ")}</dd>
      </div>
      <div className="detailWide">
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
      <div>
        <dt>Disposition</dt>
        <dd>{patient.dispositionType?.replaceAll("_", " ") ?? "-"}</dd>
      </div>
    </dl>
  );
}
