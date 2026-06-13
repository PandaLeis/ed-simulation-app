import { getAvailableProviderActions } from "./actionRules";
import { generatePatientDeck } from "./arrivalGenerator";
import { defaultScenario } from "./mockScenario";
import {
  advanceOneMinute,
  applyProviderAction,
  createSimulationRun,
  startSimulation,
} from "./simulationEngine";
import type { RuntimePatient, Scenario, SimulationRun } from "./types";

function chooseActionablePatient(run: SimulationRun): RuntimePatient | undefined {
  return (
    run.patients.find((patient) => patient.state === "triage") ??
    run.patients.find((patient) => patient.state === "ready_for_disposition") ??
    run.patients.find((patient) => patient.state === "results_ready") ??
    run.patients.find((patient) => patient.state === "provider_seen") ??
    run.patients.find((patient) => patient.state === "roomed") ??
    run.patients.find((patient) => patient.state === "waiting")
  );
}

function chooseAction(run: SimulationRun, patient: RuntimePatient) {
  const actions = getAvailableProviderActions(run, patient.id).filter((candidate) => candidate.enabled);
  return (
    actions.find((action) => action.type === "start_protocol_orders") ??
    actions.find((action) => action.type === "complete_triage") ??
    actions.find((action) => action.type !== "continue_waiting") ??
    actions[0]
  );
}

function runDemoScenario(scenario: Scenario, minutes: number): { deckLength: number; run: SimulationRun } {
  const deck = generatePatientDeck(scenario);
  let run = startSimulation(createSimulationRun(scenario, deck));

  for (let minute = 0; minute < minutes; minute += 1) {
    const actionablePatient = chooseActionablePatient(run);

    if (run.provider.status === "idle" && actionablePatient) {
      const action = chooseAction(run, actionablePatient);
      if (action) {
        run = applyProviderAction(run, action.type, actionablePatient.id);
      }
    }

    run = advanceOneMinute(run, scenario);
  }

  return { deckLength: deck.length, run };
}

const directWaitingScenario: Scenario = {
  ...defaultScenario,
  id: `${defaultScenario.id}-direct-waiting`,
  triageProviderEnabled: false,
};
const triageEnabledDemo = runDemoScenario(defaultScenario, 120);
const triageDisabledDemo = runDemoScenario(directWaitingScenario, 120);

console.log(
  JSON.stringify(
    {
      triageEnabled: {
        generatedPatients: triageEnabledDemo.deckLength,
        currentMinute: triageEnabledDemo.run.currentMinute,
        metrics: triageEnabledDemo.run.metrics,
        recentEvents: triageEnabledDemo.run.events.slice(-8),
      },
      triageDisabled: {
        generatedPatients: triageDisabledDemo.deckLength,
        currentMinute: triageDisabledDemo.run.currentMinute,
        metrics: triageDisabledDemo.run.metrics,
        recentEvents: triageDisabledDemo.run.events.slice(-8),
      },
    },
    null,
    2,
  ),
);
