import type {
  ActivityRecord,
  ActivityTimeline,
  ProviderDecision,
  SimulationEvent,
  SimulationRun,
  WhatIfCoachStrategyId,
} from "./types";

const activityCsvHeaders = [
  "id",
  "runId",
  "simulationMinute",
  "kind",
  "label",
  "message",
  "patientId",
  "providerId",
  "actionType",
  "eventType",
  "previousState",
  "resultingState",
  "timeCostMinutes",
  "benchmarkMinute",
  "benchmarkDeltaMinutes",
];

const activityRunCsvHeaders = [
  "strategyId",
  "strategyLabel",
  ...activityCsvHeaders,
];

export interface ActivityCsvRun {
  run: SimulationRun;
  strategyId: WhatIfCoachStrategyId;
  strategyLabel: string;
}

function average(values: number[]): number | null {
  if (values.length === 0) {
    return null;
  }

  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function decisionMatchKey(decision: ProviderDecision): string | undefined {
  return decision.patientId ? `${decision.patientId}:${decision.actionType}` : undefined;
}

function benchmarkDecisionLookup(benchmarkRun?: SimulationRun): Map<string, ProviderDecision> {
  const lookup = new Map<string, ProviderDecision>();

  for (const decision of benchmarkRun?.decisions ?? []) {
    const key = decisionMatchKey(decision);
    if (!key || lookup.has(key)) {
      continue;
    }

    lookup.set(key, decision);
  }

  return lookup;
}

function eventRecord(event: SimulationEvent): ActivityRecord {
  return {
    id: event.id,
    runId: event.runId,
    simulationMinute: event.simulationMinute,
    kind: "event",
    label: event.type.replaceAll("_", " "),
    message: event.message,
    patientId: event.patientId,
    eventType: event.type,
    previousState: event.previousState,
    resultingState: event.newState,
  };
}

function decisionRecord(decision: ProviderDecision, benchmarkDecision?: ProviderDecision): ActivityRecord {
  const benchmarkDeltaMinutes =
    benchmarkDecision === undefined ? undefined : decision.simulationMinute - benchmarkDecision.simulationMinute;

  return {
    id: decision.id,
    runId: decision.runId,
    simulationMinute: decision.simulationMinute,
    kind: "decision",
    label: decision.actionLabel,
    message: decision.patientId
      ? `${decision.actionLabel} for ${decision.patientId}`
      : decision.actionLabel,
    patientId: decision.patientId,
    providerId: decision.providerId,
    actionType: decision.actionType,
    previousState: decision.previousState,
    resultingState: decision.resultingState,
    timeCostMinutes: decision.timeCostMinutes,
    benchmarkMinute: benchmarkDecision?.simulationMinute,
    benchmarkDeltaMinutes,
  };
}

function benchmarkOnlyRecord(decision: ProviderDecision): ActivityRecord {
  return {
    id: `${decision.id}-benchmark-only`,
    runId: decision.runId,
    simulationMinute: decision.simulationMinute,
    kind: "benchmark",
    label: decision.actionLabel,
    message: decision.patientId
      ? `Benchmark: ${decision.actionLabel} for ${decision.patientId}`
      : `Benchmark: ${decision.actionLabel}`,
    patientId: decision.patientId,
    providerId: decision.providerId,
    actionType: decision.actionType,
    previousState: decision.previousState,
    resultingState: decision.resultingState,
    timeCostMinutes: decision.timeCostMinutes,
    benchmarkMinute: decision.simulationMinute,
  };
}

export function createActivityTimeline(run: SimulationRun, benchmarkRun?: SimulationRun): ActivityTimeline {
  const benchmarkLookup = benchmarkDecisionLookup(benchmarkRun);
  const matchedBenchmarkDecisionIds = new Set<string>();
  const records: ActivityRecord[] = [
    ...run.events.map(eventRecord),
    ...run.decisions.map((decision) => {
      const key = decisionMatchKey(decision);
      const benchmarkDecision = key ? benchmarkLookup.get(key) : undefined;
      if (benchmarkDecision) {
        matchedBenchmarkDecisionIds.add(benchmarkDecision.id);
      }

      return decisionRecord(decision, benchmarkDecision);
    }),
  ];

  for (const benchmarkDecision of benchmarkRun?.decisions ?? []) {
    if (matchedBenchmarkDecisionIds.has(benchmarkDecision.id)) {
      continue;
    }

    records.push(benchmarkOnlyRecord(benchmarkDecision));
  }

  const decisionDelays = records
    .filter((record) => record.kind === "decision" && record.benchmarkDeltaMinutes !== undefined)
    .map((record) => record.benchmarkDeltaMinutes ?? 0);

  return {
    records: records.sort((left, right) => {
      const minuteDifference = left.simulationMinute - right.simulationMinute;
      return minuteDifference === 0 ? left.id.localeCompare(right.id) : minuteDifference;
    }),
    actualDecisionCount: run.decisions.length,
    benchmarkDecisionCount: benchmarkRun?.decisions.length ?? 0,
    matchedDecisionCount: matchedBenchmarkDecisionIds.size,
    averageDecisionDelayMinutes: average(decisionDelays),
  };
}

function csvCell(value: string | number | undefined): string {
  if (value === undefined) {
    return "";
  }

  const text = String(value);
  if (!/[",\n\r]/.test(text)) {
    return text;
  }

  return `"${text.replaceAll("\"", "\"\"")}"`;
}

export function activityTimelineToCsv(timeline: ActivityTimeline): string {
  const rows = timeline.records.map((record) =>
    [
      record.id,
      record.runId,
      record.simulationMinute,
      record.kind,
      record.label,
      record.message,
      record.patientId,
      record.providerId,
      record.actionType,
      record.eventType,
      record.previousState,
      record.resultingState,
      record.timeCostMinutes,
      record.benchmarkMinute,
      record.benchmarkDeltaMinutes,
    ].map(csvCell).join(","),
  );

  return [activityCsvHeaders.join(","), ...rows].join("\n");
}

export function activityRunsToCsv(runs: ActivityCsvRun[]): string {
  const rows = runs.flatMap((activityRun) => {
    const records = [
      ...activityRun.run.events.map(eventRecord),
      ...activityRun.run.decisions.map((decision) => decisionRecord(decision)),
    ].sort((left, right) => {
      const minuteDifference = left.simulationMinute - right.simulationMinute;
      return minuteDifference === 0 ? left.id.localeCompare(right.id) : minuteDifference;
    });

    return records.map((record) =>
      [
        activityRun.strategyId,
        activityRun.strategyLabel,
        record.id,
        record.runId,
        record.simulationMinute,
        record.kind,
        record.label,
        record.message,
        record.patientId,
        record.providerId,
        record.actionType,
        record.eventType,
        record.previousState,
        record.resultingState,
        record.timeCostMinutes,
        record.benchmarkMinute,
        record.benchmarkDeltaMinutes,
      ].map(csvCell).join(","),
    );
  });

  return [activityRunCsvHeaders.join(","), ...rows].join("\n");
}
