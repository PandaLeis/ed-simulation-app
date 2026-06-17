# ED Provider Simulation App - v1 Feature Summary

Last updated: June 16, 2026

## Purpose

This application is an operational ED-flow training simulation using synthetic patients only. It is designed to help providers and operational leaders see how patient placement, front-end triage, room capacity, boarding pressure, LWBS risk, and provider decisions affect flow.

This is not clinical decision support. The simulation does not diagnose patients, recommend clinical treatment, or use PHI.

## v1 Foundation

### Simulation Core

The simulation core is separated from the React UI and owns the ED rules, state transitions, metrics, patient generation, provider actions, and benchmark logic.

Implemented capabilities:
- Deterministic synthetic patient deck generation from scenario seed.
- Patient state machine from arrival through triage, waiting, rooming, provider evaluation, orders, results, disposition, boarding, departure, or LWBS.
- Provider action validation through `getAvailableProviderActions`.
- Provider action time costs.
- Event logging for arrivals, triage, rooming, orders, results, disposition, boarding, room release, LWBS, and workflow changes.
- Provider decision logging with run-scoped identifiers.
- Room capacity enforcement.
- Admit boarding behavior.
- Shift-end behavior.
- Metrics recalculation after state changes.

Primary files:
- `src/simulation/types.ts`
- `src/simulation/simulationEngine.ts`
- `src/simulation/actionRules.ts`
- `src/simulation/metricsEngine.ts`
- `src/simulation/eventLogger.ts`
- `src/simulation/arrivalGenerator.ts`

## v1 UI

### ED Board

The ED board provides a single-screen operational view of the simulation.

Implemented areas:
- Live Operations tab.
- Scenario Tuning tab.
- Additional Stats tab.
- Main view tabs for Workflow and Facility Setup.
- Patient Status panel.
- Process flow columns.
- Facility Setup room map with available, occupied, and blocked room status.
- Facility summary cards for room availability, waiting room, triage, and boarding.
- Right rail with Actions, Coach, Benchmark, Debrief, and Events.
- Dark mode and light mode.
- Auto-run clock with configurable speed.
- Departed and LWBS patient cards show closed risk status and stopped elapsed time.
- Patient cards show whether the ED provider has seen the patient.

Current process columns:
- Front-End Triage
- Waiting Room
- Roomed: Awaiting Provider
- Roomed: Workup Pending
- Roomed: Results Ready
- Roomed: Disposition Needed
- Boarding
- Departed

Primary files:
- `src/ui/App.tsx`
- `src/ui/styles.css`

## v1 Scenario Tuning

Scenario tuning lets the user adjust operational conditions without changing simulation rules in the UI.

Implemented controls:
- Front-End Triage Provider mode: unavailable, manual, or automated.
- ED room capacity.
- Provider count.
- Simulation length: 2, 4, 8, 12, 24, or 48 hours.
- Arrivals per hour.
- Typical provider evaluation minutes from the local ED.
- Typical front-end triage minutes from the local ED.
- Typical lab turnaround minutes from the local ED.
- Typical imaging turnaround minutes from the local ED.
- Typical boarding duration minutes from the local ED.
- LWBS enabled/disabled.
- Minimum wait before LWBS.

Default v1 baseline:
- Automated Front-End Triage Provider.
- 1 ED provider.
- 4-hour shift.
- 12 expected arrivals per hour.
- 48 synthetic patients generated in the default scenario.

Implemented presets:
- Default Flow
- Boarding Surge
- High Arrivals
- Low Room Capacity

Primary file:
- `src/simulation/scenarioTuning.ts`

## v1 Front-End Triage Provider

Front-End Triage is modeled as a separate provider process from the ED provider pool.

Implemented behavior:
- Patients route to Front-End Triage when enabled.
- Manual Front-End Triage can start protocol orders.
- Manual Front-End Triage can send patients to the Waiting Room.
- Automated Front-End Triage can manage the triage line without ED provider clicks.
- Automated Front-End Triage handles one triage patient per simulation minute.
- Automated Front-End Triage prioritizes lower ESI number first, then patient arrival order.
- Automated Front-End Triage starts available protocol orders before sending that patient to the Waiting Room.
- Automated Front-End Triage sends no-workup patients directly to the Waiting Room.
- Automated Front-End Triage logs provider decisions under the separate front-end triage provider.
- Front-End Triage completion consumes configurable time based on synthetic complaint category.
- The default symptom-based triage profile lives in the simulation layer.
- Scenario Tuning uses the local ED's typical triage time to scale symptom-based triage duration.
- ED providers can remain busy while the triage provider continues triage actions.
- Turning the triage provider off moves current triage patients to the Waiting Room.
- Turning the triage provider back on returns untriaged waiting patients to Front-End Triage.
- Patients who already completed triage remain in the Waiting Room when triage is re-enabled.

Important source of truth:
- `triagedAt` determines whether the patient has completed triage.

Primary files:
- `src/simulation/simulationEngine.ts`
- `src/simulation/actionRules.ts`

## v1 Protocol Orders and Workup Bundles

Protocol orders are synthetic operational workups generated from the patient's complaint category. They are intended to make front-end triage feel operationally realistic without becoming clinical decision support.

Implemented behavior:
- Complaint-informed workup bundle generation.
- Expanded Complaint Taxonomy v1 for broader synthetic ED presentations.
- Chest pain and suspected ACS synthetic presentations in the default complaint mix.
- Suspected ACS patients are modeled as high-acuity and cardiac-workup heavy without asserting a confirmed diagnosis.
- Workup type shown in Patient Status.
- Protocol status shown on patient cards and details.
- Orders identified in triage.
- Expected order groups.
- Pending order details with labs, imaging, ready time, and completion status.
- Flow impact summary through simulation helper.

Chest pain / suspected ACS workflow behavior:
- Chest pain remains the presenting complaint, while suspected ACS represents an operational higher-risk pathway.
- Cardiac workups create discrete synthetic orders for ECG, troponin, repeat troponin, and chest X-ray.
- A small deterministic subset of cardiac patients follows a STEMI-alert pathway without asserting a confirmed diagnosis.
- ECG completion, ECG review, and STEMI-alert activation are logged as simulation events.
- Promptly started cardiac protocols target ECG completion under 10 minutes from arrival.
- Automated Front-End Triage prioritizes cardiac protocol orders to protect door-to-ECG flow.
- Coach Mode prioritizes cardiac protocol order starts before general flow moves when a cardiac triage patient is waiting for ECG.
- Cardiac patients can still move through the normal rooming, results pending, results ready, provider review, and disposition workflow.
- Metrics track chest pain arrivals, suspected ACS arrivals, STEMI-alert pathways, door-to-ECG compliance, median and p90 door-to-ECG, ECG review compliance, troponin collection and turnaround timing, ECG-to-STEMI activation timing, cardiac results awaiting review, and chest pain / suspected ACS LWBS.

Expanded Complaint Taxonomy v1 categories:
- Suspected ACS.
- Chest pain.
- Abdominal pain.
- Shortness of breath.
- Injury.
- Weakness / dizziness.
- Fever / infection.
- Behavioral health.
- Stroke / neuro concern.
- Sepsis concern.
- Major trauma.
- Pediatric.
- OB / pregnancy.
- Syncope.
- Altered mental status.
- Overdose / intoxication.
- Renal / urinary.
- GI bleed.
- Allergic reaction.
- Burn.
- Eye / ENT.
- Back pain.
- Hypertensive symptoms.
- Diabetic emergency.
- Social / placement.
- Minor complaint.

Complaint Taxonomy v1 behavior:
- Each category maps to a synthetic operational workup bundle probability mix.
- Each category has a default front-end triage duration assumption.
- Time-sensitive categories such as stroke/neuro concern, sepsis concern, major trauma, altered mental status, diabetic emergency, and GI bleed bias toward higher acuity and more complex operational workups.
- The taxonomy is used for simulation flow, acuity mix, expected workup load, and operational timing only.

Sepsis Quality Metrics v1:
- Sepsis concern arrivals.
- Sepsis pathway starts.
- Door-to-sepsis recognition and recognition within 10 minutes.
- Door-to-lactate collection.
- Door-to-lactate result.
- Door-to-blood cultures.
- Door-to-antibiotics, antibiotics within 60 minutes, median door-to-antibiotics, and p90 door-to-antibiotics.
- Door-to-fluids.
- Sepsis patients waiting without a room.
- Sepsis LWBS count and rate.

Sepsis protocol bundle v1:
- Synthetic sepsis concern patients can generate lactate, blood culture, antibiotic, and IV fluid protocol items.
- Sepsis concern patients waiting without a room are treated as a critical operational flow risk after 10 minutes.
- These measures are operational training metrics only and do not diagnose sepsis or recommend clinical care.

Deferred to STEMI Reperfusion Pathway v2:
- Door-to-PCI <=90 minutes.
- Door-to-lysis <=30 minutes.
- Transfer-out <=45 minutes.
- Facility capability, cath lab availability, lysis availability, and transfer capability configuration.

Important boundary:
- The UI displays workup summaries through simulation-layer helpers.
- The UI does not own the protocol-order rules.
- The app remains an operational flow simulator, not clinical decision support.

Primary files:
- `src/simulation/arrivalGenerator.ts`
- `src/simulation/cardiacWorkflow.ts`
- `src/simulation/metricsEngine.ts`
- `src/simulation/simulationEngine.ts`
- `src/simulation/workupSummary.ts`
- `src/ui/App.tsx`

## v1 PERT Timing

Timing assumptions use local ED "typical minutes" as the user-facing input. The simulation layer derives min / typical / max ranges and samples deterministic PERT-style durations from the scenario seed.

Implemented PERT-timed areas:
- Provider evaluation.
- Front-End Triage.
- Lab turnaround.
- Imaging turnaround.
- Boarding duration.

Provider evaluation time uses the scenario's typical provider evaluation minutes as the baseline, then adjusts the timing range by ESI acuity:
- ESI 1: 1.8x
- ESI 2: 1.4x
- ESI 3: 1.0x
- ESI 4: 0.75x
- ESI 5: 0.55x

Important boundary:
- The UI captures typical operational timing values.
- The simulation layer owns the statistical spread and deterministic sampling.

Primary files:
- `src/simulation/timingProfile.ts`
- `src/simulation/providerEvaluation.ts`
- `src/simulation/scenarioTuning.ts`
- `src/simulation/arrivalGenerator.ts`
- `src/simulation/simulationEngine.ts`

## v1 LWBS

LWBS represents patients leaving before being seen because of operational wait pressure.

Implemented behavior:
- Scenario-level LWBS configuration.
- LWBS only occurs from the Waiting Room.
- Patients cannot LWBS before the configured minimum wait.
- Seeded deterministic LWBS pattern.
- LWBS sets `lwbsAt`, `departedAt`, and disposition type.
- LWBS patients appear in the Departed column.
- LWBS does not release rooms because v1 only allows LWBS from Waiting Room.

Implemented metrics:
- Patients LWBS.
- LWBS rate.
- Average wait before LWBS.
- High-risk LWBS.
- LWBS with pending orders.

Primary files:
- `src/simulation/simulationEngine.ts`
- `src/simulation/metricsEngine.ts`
- `src/simulation/types.ts`

## v1 Provider Workload and Multi-Provider

The simulation supports multiple ED providers while preserving the separate Front-End Triage Provider.

Implemented behavior:
- Scenario-configurable provider count.
- Provider busy/idle tracking.
- Provider availability status in Live Operations.
- Per-provider Live Operations roster showing each provider's busy/idle status, current action, patient location, and next available time.
- Idle provider roster cards show suggested next ED-provider work when actionable patients are waiting.
- Action buttons disabled when ED providers are unavailable.
- Provider status shows when a provider is expected to become available.
- Front-End Triage Provider can continue acting independently.

Primary files:
- `src/simulation/simulationEngine.ts`
- `src/simulation/actionRules.ts`
- `src/ui/App.tsx`

## v1 Provider Feedback and Debrief

The Debrief tab summarizes provider decisions and operational bottlenecks.

Implemented feedback:
- Headline summary for seen, departed, and LWBS.
- Door-to-provider.
- Seen per hour.
- LWBS.
- Waiting-room risk minutes.
- Results-to-disposition.
- Boarding minutes.
- Bottleneck flags.
- Decision feedback.
- Notable patient timelines.

Primary file:
- `src/simulation/providerDebrief.ts`

## v1 Flow Guardrails

Flow Guardrails provide live operational warnings when patient flow is at risk. They are synthetic training cues only and do not make clinical recommendations.

Implemented guardrails:
- Idle ED provider while actionable patient-flow work exists.
- Roomed patient not yet seen after a delay.
- Results ready and available for review.
- Disposition-ready patient awaiting discharge or admit decision.
- High-risk waiting-room patient while room capacity is available.
- Boarding pressure consuming or blocking room capacity.

Important boundary:
- Guardrails are generated in the simulation layer.
- Guardrails do not automatically perform actions.
- Guardrails teach operational flow opportunities during the live run.

Primary files:
- `src/simulation/flowGuardrails.ts`
- `src/ui/App.tsx`

## v1 Optimal Flow Benchmark

The Benchmark tab compares the provider's actual flow with a deterministic operational benchmark using the same scenario and same synthetic patient deck.

Implemented behavior:
- Runs a benchmark simulation in the simulation layer.
- Uses the same synthetic arrivals and scenario inputs.
- Compares actual flow against benchmark flow at the same simulation minute.
- Does not replace the user run.
- Does not make clinical recommendations.
- Identifies operational differences such as earlier rooming opportunities.

Benchmark strategy v1 prioritizes:
- Front-end triage completion and protocol orders.
- Results-ready patients.
- Ready-for-disposition patients.
- Highest-priority waiting patients when rooms are available.
- Roomed patients awaiting provider evaluation.
- Patients needing orders after provider evaluation.

Benchmark comparison metrics:
- LWBS.
- Longest wait.
- Door to provider.
- Results to disposition.
- Waiting-room risk minutes.
- Patients seen per hour.

Primary file:
- `src/simulation/optimalFlowBenchmark.ts`

## v1 What-If Coach Comparison

The Benchmark tab also shows what would happen if the coach emphasized different operational sections of the ED process.

Implemented behavior:
- Runs focused coach benchmarks in the simulation layer.
- Uses the same scenario and same synthetic patient deck as the provider run and optimal benchmark.
- Keeps the comparison deterministic for the same seed and scenario.
- Shows five side-by-side strategies: Provider Run, Optimal Flow Coach, Front-End Focus Coach, Middle Flow Focus Coach, and Disposition Focus Coach.
- Front-End Focus Coach prioritizes triage, protocol starts, and waiting-room intake before downstream roomed-patient work.
- Middle Flow Focus Coach prioritizes roomed patients, provider evaluation, orders, and diagnostic result movement.
- Disposition Focus Coach prioritizes results review and discharge/admit decisions to clear rooms and define boarding.
- Compares key outcomes including departed patients, LWBS, longest wait, seen per hour, results-ready patients waiting, boarding minutes, door-to-ECG performance, and sepsis antibiotics timing.

Important boundary:
- Focused coaches are teaching comparators.
- They do not change the live provider run.
- They do not add clinical decision support.

Primary files:
- `src/simulation/optimalFlowBenchmark.ts`
- `src/simulation/types.ts`
- `src/ui/App.tsx`
- `src/ui/styles.css`

## v1 Activity Timeline

Activity Timeline combines raw simulation events, provider decisions, and benchmark-only actions into one operational record.

Implemented behavior:
- Captures simulation events such as arrivals, triage, rooming, orders, results, disposition, boarding, departure, LWBS, cardiac events, and sepsis bundle progress.
- Captures provider selections with action type, patient, provider id, previous state, resulting state, and time cost.
- Compares actual provider selections with benchmark actions when the same patient/action appears in the optimal run.
- Shows benchmark minute and actual-vs-benchmark variance for matched decisions.
- Preserves benchmark-only actions so the user can see what optimal flow would have done even if the provider did not make that selection.
- Exposes an Activity right-rail tab for recent activity and summary counts.
- Exports the activity timeline as a CSV file from the browser.
- Exports an all-runs CSV with Provider Run, Optimal Flow Coach, Front-End Focus Coach, Middle Flow Focus Coach, and Disposition Focus Coach records.

Primary files:
- `src/simulation/activityTimeline.ts`
- `src/simulation/types.ts`
- `src/ui/App.tsx`

## v1 Coach Mode / Guided Benchmark Playback

Coach Mode shows the next benchmark-style operational recommendation during a live simulation.

Implemented behavior:
- Uses the same simulation-layer benchmark strategy as the Benchmark tab.
- Recommends the next patient and provider action.
- Explains why the recommendation was selected.
- Highlights the recommended patient card on the ED board.
- Highlights the recommended action button when the user views the matching patient.
- Prioritizes disposition-ready roomed patients when disposition action is available.
- Prioritizes roomed, unseen patients for provider evaluation before rooming additional waiting-room patients.
- Prioritizes roomed patients with ready diagnostic results for provider evaluation when they have not yet been seen.
- Prioritizes roomed patients with pending labs or imaging for provider evaluation when they have not yet been seen.
- Avoids recommending Front-End Triage work while waiting-room patients still need ED flow movement.
- Allows the user to show the recommended action.
- Allows the user to apply the recommendation directly.
- Includes a Run Coach Demo control in Live Operations.
- Run Coach Demo starts the simulation if needed, applies available coach recommendations automatically, and advances the clock continuously.
- Run Coach Demo can apply multiple simultaneous provider actions when multiple ED providers are idle.

Important boundary:
- Coach Mode recommends operational flow actions only.
- Run Coach Demo uses the same coach recommendation helper rather than separate UI-owned rules.
- It does not move the user's real cursor.
- It does not make clinical treatment recommendations.

Primary files:
- `src/simulation/optimalFlowBenchmark.ts`
- `src/ui/App.tsx`
- `src/ui/styles.css`

## v1 Metrics

Core live and additional metrics include:
- Active census.
- Longest wait.
- Seen per hour.
- Results to disposition.
- Boarding minutes.
- Waiting-room census.
- Front-End Triage census.
- Room utilization.
- Boarding pressure.
- Provider workload.
- Disposition timing.
- LWBS count and rate.
- Waiting-room risk exposure.
- Chest pain / suspected ACS operational metrics.
- Door-to-ECG timing.

Primary file:
- `src/simulation/metricsEngine.ts`

## v1 Testing

The simulation core has automated tests for:
- Deterministic arrivals.
- Complaint-informed workup selection.
- Scenario tuning.
- Scenario presets.
- Front-End Triage routing, toggling, and automated mode.
- Room capacity.
- Provider action validation.
- Provider action time costs.
- Multi-provider behavior.
- Protocol orders.
- LWBS behavior and metrics.
- Room release.
- Boarding.
- Metrics updates.
- Event and decision identifiers.
- Reset behavior.
- Provider debrief.
- Optimal Flow Benchmark.
- Smoke demo flow.

Current verification command set:
- `npm test`
- `npm run typecheck`
- `npm run build`
- `npm run demo`

Primary test file:
- `src/simulation/__tests__/simulationCore.test.ts`

## Intentional v1 Boundaries

Not yet included:
- Persistent saved runs.
- Replay branching UI.
- Multi-user networked collaboration.
- Authentication.
- Database storage.
- Real patient data.
- PHI handling.
- Clinical decision support.
- True staffing schedules.
- Advanced bed assignment algorithms.
- Detailed nurse, lab, radiology, transport, and inpatient bed team modeling.

## Recommended Next Iterations

Strong next candidates:
- Persistence v1: save scenario, run, events, decisions, and snapshots locally.
- Replay v1: replay a completed run minute-by-minute from saved events and snapshots.
- Benchmark explanation v2: show why the benchmark chose a patient at a specific time.
- Staffing model v1: separate ED provider, triage provider, nurse rooming, and ancillary capacity.
- Lab/imaging bottleneck v1: model downstream capacity instead of only order ready times.
- Learning objectives v1: choose a training goal such as LWBS prevention, boarding surge management, or high-arrival throughput.

## Definition of Done for v1 Foundation

The v1 foundation is in place when:
- Synthetic patient flow runs deterministically.
- Scenario tuning changes flow without UI-owned rules.
- Front-End Triage can be enabled and disabled while preserving patient triage history.
- LWBS fires deterministically from Waiting Room only.
- Provider actions are validated in the simulation layer.
- Metrics update consistently.
- Debrief and Benchmark provide operational feedback.
- Automated tests pass.
- Type checking and production build pass.
