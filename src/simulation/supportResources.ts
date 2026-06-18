import type {
  ProviderActionType,
  SimulationRun,
  SupportResourceAssignment,
  SupportResourcePool,
  SupportResourceRole,
} from "./types";

type SupportResourceRequirement = Partial<Record<SupportResourceRole, number>>;

export const SUPPORT_RESOURCE_REQUIREMENTS: Partial<Record<ProviderActionType, SupportResourceRequirement>> = {
  room_patient: { nurse: 1, tech: 1 },
  fast_track_patient: { tech: 1 },
  reassess_waiting_patient: { nurse: 1 },
  start_protocol_orders: { nurse: 1, tech: 1 },
  place_orders: { nurse: 1, tech: 1 },
  discharge_home: { nurse: 1 },
  admit_inpatient: { nurse: 1 },
};

export function createSupportResourcePools(nurseCount: number, techCount: number): SupportResourcePool[] {
  return [
    { role: "nurse", total: Math.max(0, nurseCount), busy: [], busyMinutes: 0, idleMinutes: 0 },
    { role: "tech", total: Math.max(0, techCount), busy: [], busyMinutes: 0, idleMinutes: 0 },
  ];
}

export function supportResourceRequirementFor(actionType: ProviderActionType): SupportResourceRequirement {
  return SUPPORT_RESOURCE_REQUIREMENTS[actionType] ?? {};
}

function supportResourcePools(run: SimulationRun): SupportResourcePool[] {
  return run.supportResources ?? createSupportResourcePools(0, 0);
}

export function busySupportResourceCount(run: SimulationRun, role: SupportResourceRole): number {
  return supportResourcePools(run).find((pool) => pool.role === role)?.busy.length ?? 0;
}

export function supportResourceTotal(run: SimulationRun, role: SupportResourceRole): number {
  return supportResourcePools(run).find((pool) => pool.role === role)?.total ?? 0;
}

export function hasAvailableSupportResources(run: SimulationRun, actionType: ProviderActionType): boolean {
  const requirement = supportResourceRequirementFor(actionType);

  return (Object.entries(requirement) as Array<[SupportResourceRole, number]>).every(
    ([role, count]) => supportResourceTotal(run, role) - busySupportResourceCount(run, role) >= count,
  );
}

export function supportResourceUnavailableReason(run: SimulationRun, actionType: ProviderActionType): string | undefined {
  const requirement = supportResourceRequirementFor(actionType);
  const unavailableRoles = (Object.entries(requirement) as Array<[SupportResourceRole, number]>)
    .filter(([role, count]) => supportResourceTotal(run, role) - busySupportResourceCount(run, role) < count)
    .map(([role]) => (role === "nurse" ? "nurse" : "tech"));

  if (unavailableRoles.length === 0) {
    return undefined;
  }

  return `${unavailableRoles.join(" and ")} resource unavailable`;
}

export function reserveSupportResources(
  run: SimulationRun,
  actionType: ProviderActionType,
  patientId: string | undefined,
  decisionId: string,
  startedAt: number,
  completedAt: number,
): SimulationRun {
  if (completedAt <= startedAt) {
    return run;
  }

  const requirement = supportResourceRequirementFor(actionType);
  const supportResources = supportResourcePools(run).map((pool) => {
    const count = requirement[pool.role] ?? 0;
    if (count === 0) {
      return pool;
    }

    const assignments: SupportResourceAssignment[] = Array.from({ length: count }, (_, index) => ({
      id: `${decisionId}-${pool.role}-${index + 1}`,
      role: pool.role,
      actionType,
      patientId,
      decisionId,
      startedAt,
      completedAt,
    }));

    return {
      ...pool,
      busy: [...pool.busy, ...assignments],
    };
  });

  return {
    ...run,
    supportResources,
  };
}

export function releaseCompletedSupportResources(run: SimulationRun): SimulationRun {
  return {
    ...run,
    supportResources: supportResourcePools(run).map((pool) => ({
      ...pool,
      busy: pool.busy.filter((assignment) => assignment.completedAt > run.currentMinute),
    })),
  };
}

export function accrueSupportResourceTime(run: SimulationRun): SimulationRun {
  return {
    ...run,
    supportResources: supportResourcePools(run).map((pool) => {
      const busyCount = pool.busy.length;
      const idleCount = Math.max(0, pool.total - busyCount);

      return {
        ...pool,
        busyMinutes: pool.busyMinutes + busyCount,
        idleMinutes: pool.idleMinutes + idleCount,
      };
    }),
  };
}
