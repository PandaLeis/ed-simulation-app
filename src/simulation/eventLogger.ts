import type { PatientState, SimulationEvent, SimulationEventType, SimulationRun } from "./types";

export interface EventInput {
  type: SimulationEventType;
  patientId?: string;
  previousState?: PatientState;
  newState?: PatientState;
  message: string;
  details?: Record<string, unknown>;
}

export function createEvent(run: SimulationRun, input: EventInput, sequence = run.events.length + 1): SimulationEvent {
  return {
    id: `${run.id}-event-${String(sequence).padStart(6, "0")}`,
    runId: run.id,
    simulationMinute: run.currentMinute,
    ...input,
  };
}

export function appendEventToList(run: SimulationRun, events: SimulationEvent[], input: EventInput): SimulationEvent[] {
  return [...events, createEvent(run, input, events.length + 1)];
}

export function appendEvent(run: SimulationRun, input: EventInput): SimulationRun {
  return {
    ...run,
    events: appendEventToList(run, run.events, input),
  };
}
