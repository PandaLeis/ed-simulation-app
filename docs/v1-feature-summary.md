# ED Provider Simulation App - v1 Feature Summary

Last updated: June 19, 2026

## Purpose

This application is an operational ED-flow training simulation using synthetic patients only. It is designed to help providers and operational leaders see how patient placement, front-end triage, room capacity, boarding pressure, LWBS risk, and provider decisions affect flow.

This is not clinical decision support. The simulation does not diagnose patients, recommend clinical treatment, or use PHI.

## v1 Foundation

### Simulation Core

The simulation core is separated from the React UI and owns the ED rules, state transitions, metrics, patient generation, provider actions, and benchmark logic.

Implemented capabilities:
- Deterministic synthetic patient deck generation from scenario seed.
- Patient state machine from arrival through triage, waiting, rooming, provider evaluation, orders, results, disposition, admission pending, boarding, departure, or LWBS.
- Provider action validation through `getAvailableProviderActions`.
- Provider action time costs.
- Event logging for arrivals, triage, rooming, orders, results, disposition, boarding, room release, LWBS, and workflow changes.
- Provider decision logging with run-scoped identifiers.
- Room capacity enforcement.
- Hospitalist consult / admission workflow after ED admit decision, including admit request, response time, acceptance or request-more-info status, admission orders, bed request, boarding, inpatient bed assignment, and ED departure.
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
- Files tab for run JSON files and CSV exports.
- Scenario Tuning tab.
- Model Assumptions tab.
- Additional Stats tab.
- Main view tabs for Workflow, Facility Setup, Benchmark, Coach Comparison, and Graphs.
- Scenario Tuning and Model Assumptions open as focused configuration views, hiding live operational panels while selected.
- Patient Status panel.
- Process flow columns.
- Facility Setup room map with available, occupied, and blocked room status.
- Facility summary cards for room availability, waiting room, triage, and boarding.
- Facility summary cards include room cleaning, next room ready, hospitalist pending, admission pending, and boarding status.
- Patient details include a dedicated Hospitalist Workflow block with consult/admit request, response time, acceptance or request more info, admission orders, bed request, boarding, inpatient bed assigned, and ED departure.
- Right rail with Actions, Coach, Guardrails, Debrief, and Activity.
- Display Options control for Heart Metrics, Sepsis Metrics, Tooltips, and Dark Mode / Light Mode.
- Auto-run clock with configurable speed.
- Hover/focus tooltips for major tabs, status cards, controls, metrics, right-rail tabs, and export actions.
- Departed and LWBS patient cards show closed risk status and stopped elapsed time.
- Patient cards show whether the ED provider has seen the patient.

Current process columns:
- Front-End Triage
- Waiting Room
- Fast Track
- Roomed: Awaiting Provider
- Roomed: Workup Pending
- Roomed: Results Ready
- Roomed: Disposition Needed
- Admission Pending
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
- Provider model: Team, Assigned, or Handoff.
- Nurse count.
- Tech count.
- Fast Track enabled/disabled.
- Simulation length: 2, 4, 8, 12, 24, or 48 hours.
- Arrivals per hour.
- Patient Mix v1: acuity pattern, complaint pattern, workup intensity, admission pressure, and deterministic deck seed.
- Workflow Rules: STEMI ECG target, ACS ECG target, repeat troponin delay, lactate collection, blood culture collection, antibiotics, IV fluids, sepsis critical wait threshold, and waiting-room deterioration grace.
- Coach Benchmark Rules: priority mode, ESI acuity weight, risk weight, and wait-minute weight.
- Typical provider evaluation minutes from the local ED.
- Typical front-end triage minutes from the local ED.
- Typical lab turnaround minutes from the local ED.
- Typical imaging turnaround minutes from the local ED.
- Typical hospitalist response / admission acceptance delay minutes from the local ED.
- Typical boarding duration minutes from the local ED.
- Typical room cleaning / bed turnover minutes from the local ED.
- LWBS enabled/disabled.
- Minimum wait before LWBS.
- The second Scenario Tuning value row marks each editable assumption as Default, Local value, or Draft change.

Patient Mix v1 options:
- Acuity mix: Standard, Higher, or Lower.
- Complaint mix: Balanced, Cardiac-heavy, Infection-heavy, or Injury/minor-heavy.
- Workup intensity: Standard, Higher, or Lower.
- Admission pressure: Standard, Higher, or Lower.
- Deck seed: changes the synthetic patient deck while preserving deterministic replay for the selected seed.

Workflow Rules v1 options:
- STEMI door-to-ECG target minutes.
- Possible ACS door-to-ECG target minutes.
- Repeat troponin delay minutes.
- Sepsis lactate collection delay minutes.
- Sepsis blood culture collection delay minutes.
- Sepsis antibiotics delay minutes.
- Sepsis IV fluids delay minutes.
- Sepsis waiting-room critical-risk threshold minutes.
- Deterioration grace minutes after overdue waiting-room reassessment.

Coach Benchmark Rules v1 options:
- Priority mode: Balanced, Safety first, Throughput, or Front-end.
- ESI acuity weight: default 1000 points per ESI step.
- Risk weight: default 150 points per risk level.
- Wait-minute weight: default 1 point per waiting minute.
- Scenario Tuning controls the live Coach and Optimal Flow Coach, and includes editable profiles for each Coach Comparison strategy.
- Default Coach Rules are shown first. Comparison Coach Rules are hidden by default and can be expanded with Show All Coach Rules.
- Benchmark and Coach Comparison runs can take a moment because the app simulates the same deck under the selected rules before comparing results.

Coach rule meaning:
- Priority mode chooses the coach's broad action strategy. Balanced uses general flow logic across safety, rooming, results, disposition, and waiting-room pressure. Safety first moves high-risk, deteriorating, overdue reassessment, cardiac, and sepsis-sensitive work earlier. Throughput favors actions that keep patients moving toward results, disposition, discharge/admit, and room release. Front-end favors triage, protocol starts, intake, and waiting-room movement.
- ESI acuity weight controls how strongly the coach prioritizes lower ESI / higher acuity patients when several patients are competing for attention.
- Risk weight controls how strongly the coach prioritizes operational risk level, from low through critical.
- Wait-minute weight controls how much priority a patient gains for each minute waited; higher values make long-waiting patients climb the queue faster for LWBS prevention, waiting-room fairness, and crowding pressure.

Coach strategy behavior:
- Default / Optimal Flow Coach: chooses the broad action path from the selected mode, then uses ESI/risk/wait weights to rank patients inside that action bucket.
- Front-End Focus Coach: clears triage and protocol starts before downstream roomed-patient work, then moves eligible waiting patients into rooms or Fast Track.
- Middle Flow Focus Coach: prioritizes roomed unseen patients, provider evaluation, orders, and diagnostic result movement.
- Disposition Focus Coach: prioritizes results review and discharge/admit decisions to clear rooms and define boarding.
- Resource-Aware Coach: checks nurse, tech, room, and provider constraints before creating more support-resource work; clears disposition, results, and unseen roomed work first when support capacity is constrained.
- Safety First Coach: moves deteriorating patients, overdue reassessments, critical waits, and cardiac/sepsis-sensitive work earlier.
- Fast Track Coach: prioritizes eligible lower-acuity patients into Fast Track and keeps vertical-care patients moving.
- Balanced Operations Coach: blends safety, throughput, disposition, Fast Track, and resource-aware priorities.

Default v1 baseline:
- Automated Front-End Triage Provider.
- Fast Track enabled.
- 1 ED provider.
- 2 nurses.
- 1 tech.
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

## v1 Model Assumptions

Model Assumptions makes the simulation assumptions visible before a provider uses a scenario. It separates local values from synthetic defaults and creates a provider-review step for operational training assumptions.

Implemented behavior:
- Adds a top-level Model Assumptions tab.
- Shows counts for local values, draft changes, areas needing local data, and fixed v1 assumptions.
- Lists each model area, assumption, current value, source, and status.
- Flags applied Scenario Tuning values that differ from defaults as local values.
- Flags edited but unapplied values as draft changes.
- Shows patient mix assumptions from Scenario Tuning, including acuity, complaint, workup, admission pressure, and deck seed.
- Shows cardiac/sepsis bundle timing and waiting-room safety rules from Scenario Tuning.
- Shows Coach Benchmark Rules from Scenario Tuning, including priority mode and acuity/risk/wait scoring weights for the default coach and each comparison coach.
- Scenario Tuning displays Default Coach Rules for the live Coach and Optimal Flow Coach first, with Show All Coach Rules available to reveal the independent comparison-coach profiles.
- Provides a Use Local Baseline action that populates the draft scenario with the working baseline: 17 rooms, 3 ED providers, automated front-end triage, 3 nurses, 2 techs, 12-hour simulation, and current timing assumptions.
- Provides an Edit Scenario action that sends the user back to Scenario Tuning.
- Scenario Tuning shows Default, Local value, or Draft change badges on its second value row so providers can see assumption status while editing.

Important boundary:
- Model Assumptions does not import historical ED data.
- Model Assumptions does not yet edit LWBS probability curves, lab queue, imaging queue, EVS staffing, or detailed coach sub-rule order.
- Use Local Baseline changes draft tuning only; the user still applies the scenario from Scenario Tuning.

Primary files:
- `src/ui/App.tsx`
- `src/ui/styles.css`

## v1 Front-End Triage Provider

Front-End Triage is modeled as a separate provider process from the ED provider pool.

Implemented behavior:
- Patients route to Front-End Triage when enabled.
- Manual Front-End Triage can start protocol orders.
- Manual Front-End Triage can send patients to the Waiting Room.
- Automated Front-End Triage can manage the triage line without ED provider clicks.
- Automated Front-End Triage handles one triage patient per simulation minute.
- Automated Front-End Triage prioritizes lower ESI number first, then patient arrival order.
- Automated Front-End Triage applies an aging override after prolonged front-end waits so older triage patients are not indefinitely buried behind newer higher-acuity arrivals.
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
- Flow Guardrails flag aging front-end triage backlog when patients have not cleared triage within the configured v1 threshold.

Important source of truth:
- `triagedAt` determines whether the patient has completed triage.

Primary files:
- `src/simulation/simulationEngine.ts`
- `src/simulation/actionRules.ts`

## v1 Fast Track / Vertical Care

Fast Track is modeled as a separate vertical-care lane for lower-acuity synthetic patients. It is designed to decompress room demand without changing clinical diagnosis or treatment rules.

Implemented behavior:
- Scenario Tuning can enable or disable Fast Track.
- Eligible waiting-room patients can be moved to Fast Track without consuming an ED room.
- Fast Track eligibility is limited in v1 to lower-acuity ESI 4-5 patients without cardiac or sepsis pathways and without complex workups.
- Fast Track patients remain available for ED provider evaluation, orders, results review, and disposition.
- The Coach can recommend Fast Track when the next waiting patient is eligible, preserving rooms for higher-acuity flow.
- Fast Track census and total patients fast-tracked are tracked in metrics.
- Patient details show when the patient was fast-tracked.

Important boundary:
- Fast Track is an operational placement lane, not a clinical decision-support pathway.
- Fast Track v1 does not create a separate staffing pool; it still uses the ED provider action model.

Primary files:
- `src/simulation/types.ts`
- `src/simulation/actionRules.ts`
- `src/simulation/simulationEngine.ts`
- `src/simulation/metricsEngine.ts`
- `src/simulation/scenarioTuning.ts`
- `src/ui/App.tsx`

## v1 Waiting Room Reassessment + Deterioration

Waiting Room Reassessment + Deterioration models operational safety pressure while synthetic patients wait. It is not clinical decision support and does not diagnose patient deterioration.

Implemented behavior:
- Waiting-room patients receive a next reassessment due time when they enter the waiting room.
- Reassessment intervals are based on synthetic ESI and current operational risk level.
- Overdue waiting-room patients expose a provider action to reassess the patient.
- Reassessment records `lastReassessedAt` and schedules the next reassessment due time.
- Patients who remain overdue beyond the v1 grace period can deteriorate deterministically while waiting.
- Deterioration increases operational risk and can raise synthetic acuity priority.
- Deterioration logs a patient event and is visible on the patient card and Patient Status panel.
- Live metrics track reassessments overdue, longest reassessment overdue, and waiting-room deteriorations.
- Flow Guardrails flag overdue reassessment and deteriorated waiting-room patients.
- Coach Mode can recommend reassessment when a waiting-room patient is overdue and no better placement action is available.

Important boundary:
- Reassessment and deterioration are operational training signals only.
- The feature does not recommend medical treatment, diagnosis, or real-world triage decisions.

Primary files:
- `src/simulation/waitingRoomSafety.ts`
- `src/simulation/simulationEngine.ts`
- `src/simulation/actionRules.ts`
- `src/simulation/metricsEngine.ts`
- `src/simulation/flowGuardrails.ts`
- `src/ui/App.tsx`

## v1 Protocol Orders and Workup Bundles

Protocol orders are synthetic operational workups generated from the patient's complaint category. They are intended to make front-end triage feel operationally realistic without becoming clinical decision support.

Implemented behavior:
- Complaint-informed workup bundle generation.
- Expanded Complaint Taxonomy v1 for broader synthetic ED presentations.
- Chest pain and suspected ACS synthetic presentations in the default complaint mix.
- Suspected ACS patients are modeled as high-acuity and cardiac-workup heavy without asserting a confirmed diagnosis.
- The default training deck guarantees at least one deterministic, seed-randomized STEMI-alert pathway patient when an eligible chest pain or suspected ACS candidate is available.
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
- STEMI-alert pathway patients display a stronger `STEMI` badge on the patient card in addition to the cardiac pathway marker.
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
- Admission acceptance / consult delay.
- Boarding duration.
- Room cleaning / bed turnover.

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

## v1 Hospitalist Consult / Admission Workflow

Hospitalist Consult / Admission Workflow models the operational handoff after the ED provider decides to admit a patient. It covers hospitalist consult/admit request, hospitalist response time, acceptance or request for more information, admission orders, bed request, boarding, inpatient bed assignment, and ED departure. It is a flow-delay model only and does not represent clinical consultation advice.

Implemented behavior:
- The `admit_inpatient` provider action moves the patient to Admission Pending when boarding is enabled.
- Admission Pending patients keep occupying their ED room while waiting for hospitalist response / admission acceptance.
- A deterministic patient-specific hospitalist response delay is generated from the scenario timing profile.
- Once hospitalist acceptance is ready, the simulation records acceptance, admission orders, bed request, and boarding start as hospitalist-owned milestones.
- Boarding duration begins after hospitalist acceptance, not at the initial ED admit decision.
- Inpatient bed assignment and ED departure occur when the boarding-bed wait completes.
- Admission request, hospitalist acceptance, boarding start, inpatient bed assignment, and ED departure events are logged.
- Patient details show the full hospitalist workflow: Hospitalist Consult / Admit Request, Hospitalist Response Time, Acceptance / Request More Info, Admission Orders, Bed Request, Boarding, Inpatient Bed Assigned, and ED Departure.
- Scenario Tuning includes a local ED typical hospitalist response input.
- Live Operations shows Hospitalist status with pending consults and next response timing.
- Facility Setup and live metrics show Admission Pending, Hospitalist Pending, and Boarding census.

Implemented metrics:
- Hospitalist consults pending.
- Next hospitalist response.
- Average hospitalist response.
- Admission Pending census.
- Total admission delay minutes.
- Boarding census.
- Boarding minutes after hospitalist acceptance.

Important boundary:
- This is an operational hospitalist handoff and acceptance-delay model, not clinical consultation advice, inpatient order recommendation, or a specialty-specific decision pathway.

Primary files:
- `src/simulation/types.ts`
- `src/simulation/timingProfile.ts`
- `src/simulation/arrivalGenerator.ts`
- `src/simulation/scenarioTuning.ts`
- `src/simulation/simulationEngine.ts`
- `src/simulation/metricsEngine.ts`
- `src/ui/App.tsx`

## v1 Bed Turnover / Room Cleaning

Bed Turnover / Room Cleaning models the operational delay between a patient leaving an ED room and that room becoming ready for the next patient.

Implemented behavior:
- Discharged and admitted-departed patients no longer make the room instantly available.
- The room enters a `cleaning` state after the patient departs.
- Cleaning duration is deterministic and generated from the scenario timing profile.
- The room becomes available only after the cleaning ready time is reached.
- Room cleaning start and room available events are logged.
- Scenario Tuning includes a local ED typical room cleaning / bed turnover input.
- Facility Setup shows cleaning rooms in the room summary, legend, and room map.
- Facility Setup shows Next Room Ready when a room is currently available or when a cleaning room has a ready time.
- Flow Guardrails flag room turnover pressure when cleaning rooms exist and no rooms are available.

Implemented metrics:
- Cleaning rooms.
- Next room ready.
- Average active cleaning time.
- Waiting for clean room.
- Current room cleaning minutes.
- Available, occupied, blocked, and cleaning room counts.

Important boundary:
- Room cleaning is an operational throughput delay only; it does not model EVS staffing assignments or infection-control rules.

Primary files:
- `src/simulation/types.ts`
- `src/simulation/timingProfile.ts`
- `src/simulation/arrivalGenerator.ts`
- `src/simulation/scenarioTuning.ts`
- `src/simulation/simulationEngine.ts`
- `src/simulation/metricsEngine.ts`
- `src/simulation/flowGuardrails.ts`
- `src/ui/App.tsx`

## v1 Nurse / Tech Resource Constraints

Nurse / Tech Resource Constraints model operational support capacity that can limit patient movement even when an ED provider and room are available.

Implemented behavior:
- Scenario Tuning includes configurable nurse count and tech count.
- Rooming requires both nurse and tech capacity.
- Fast Track movement requires tech capacity.
- Waiting-room reassessment requires nurse capacity.
- Protocol order starts and provider order placement require nurse and tech capacity.
- Discharge and admit decisions require nurse capacity.
- Support resources are reserved for the action duration and released when the action completes.
- Action buttons are disabled with resource-specific reasons when required support capacity is unavailable.
- Live Operations shows nurse and tech busy status.
- Flow Guardrails flag nurse or tech capacity pressure when patients need movement or disposition.

Implemented metrics:
- Nurses busy.
- Techs busy.
- Nurse busy minutes.
- Tech busy minutes.

Important boundary:
- Nurse and tech resources are operational capacity constraints only. v1 does not assign named staff members, model skill mix, or make clinical staffing recommendations.

Primary files:
- `src/simulation/supportResources.ts`
- `src/simulation/actionRules.ts`
- `src/simulation/simulationEngine.ts`
- `src/simulation/metricsEngine.ts`
- `src/simulation/flowGuardrails.ts`
- `src/simulation/scenarioTuning.ts`
- `src/ui/App.tsx`

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
- Scenario-configurable provider model: Team, Assigned, or Handoff.
- Provider busy/idle tracking.
- Provider availability status in Live Operations.
- Per-provider Live Operations roster showing each provider's busy/idle status, current action, patient location, and next available time.
- Idle provider roster cards show suggested next ED-provider work when actionable patients are waiting.
- Action buttons disabled when ED providers are unavailable.
- Provider status shows when a provider is expected to become available.
- Front-End Triage Provider can continue acting independently.
- Team mode allows any idle ED provider to act on any eligible patient.
- Assigned mode assigns ownership when an ED provider starts work with a patient; follow-up ED-provider actions must be done by that assigned provider.
- Handoff mode prefers the assigned provider, but another idle ED provider can act when the owner is unavailable and ownership transfers.
- Patient cards and patient details show the assigned ED provider when a patient has one.
- Replay reconstructs provider ownership by minute so assignment appears only after the saved decision that created or transferred ownership.

Important boundary:
- Handoff is automatic in v1 when the assigned provider is unavailable and another ED provider acts; there is not yet a separate manual handoff action.
- Provider assignment is an operational ownership model, not a clinical scope-of-practice model.

Primary files:
- `src/simulation/types.ts`
- `src/simulation/scenarioTuning.ts`
- `src/simulation/simulationEngine.ts`
- `src/simulation/actionRules.ts`
- `src/ui/App.tsx`

## v1 Provider Feedback and Debrief

The Debrief tab summarizes provider decisions and operational bottlenecks.

Implemented feedback:
- Headline summary for seen, departed, and LWBS.
- In-app explanation of how to interpret positive feedback, watch items, and opportunities.
- Door-to-provider.
- Seen per hour.
- LWBS.
- Waiting-room risk minutes.
- Results-to-disposition.
- Boarding minutes.
- Bottleneck flags.
- Decision feedback.
- Notable patient timelines.
- Section-level explanations for bottlenecks, decision feedback, and notable patients.

Primary file:
- `src/simulation/providerDebrief.ts`

## v1 Flow Guardrails

Flow Guardrails provide live operational warnings when patient flow is at risk. They are synthetic training cues only and do not make clinical recommendations.

Implemented guardrails:
- Idle ED provider while actionable patient-flow work exists.
- Roomed patient not yet seen after a delay.
- Results ready and available for review.
- Disposition-ready patient awaiting discharge or admit decision.
- Hospitalist response delaying admission.
- High-risk waiting-room patient while room capacity is available.
- Boarding pressure consuming or blocking room capacity.

Important boundary:
- Guardrails are generated in the simulation layer.
- Guardrails do not automatically perform actions.
- Guardrails teach operational flow opportunities during the live run.
- The Guardrails tab explains severity, operational rationale, and suggested flow response for each active guardrail.

Primary files:
- `src/simulation/flowGuardrails.ts`
- `src/ui/App.tsx`

## v1 Optimal Flow Benchmark

The Benchmark tab compares the provider's actual flow with a deterministic operational benchmark using the same scenario and same synthetic patient deck.

Implemented behavior:
- Runs a benchmark simulation in the simulation layer.
- Uses the same synthetic arrivals and scenario inputs.
- Compares actual flow against benchmark flow at the same simulation minute.
- Labels the detailed comparison as Provider Run versus the selected coach target.
- Allows the detailed comparison target to be changed from Optimal Flow Coach to any focused coach.
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

The Coach Comparison tab shows what would happen if the coach emphasized different operational sections of the ED process.

Implemented behavior:
- Runs focused coach benchmarks in the simulation layer.
- Uses the same scenario and same synthetic patient deck as the provider run and optimal benchmark.
- Keeps the comparison deterministic for the same seed and scenario.
- Shows nine selectable strategies: Provider Run, Optimal Flow Coach, Front-End Focus Coach, Middle Flow Focus Coach, Disposition Focus Coach, Resource-Aware Coach, Safety First Coach, Fast Track Coach, and Balanced Operations Coach.
- Lets the user choose which coach comparison cards are visible in the Coach Comparison tab.
- Lets the user choose which coach the Provider Run is compared against in the detailed metric rows.
- Front-End Focus Coach prioritizes triage, protocol starts, and waiting-room intake before downstream roomed-patient work.
- Middle Flow Focus Coach prioritizes roomed patients, provider evaluation, orders, and diagnostic result movement.
- Disposition Focus Coach prioritizes results review and discharge/admit decisions to clear rooms and define boarding.
- Resource-Aware Coach prioritizes useful work around nurse, tech, room, and provider constraints before consuming scarce support capacity.
- Safety First Coach prioritizes deteriorating patients, overdue reassessments, high-risk waiting patients, and time-sensitive cardiac/sepsis flow before general throughput optimization.
- Fast Track Coach prioritizes eligible lower-acuity waiting-room patients into Fast Track and keeps vertical-care patients moving through evaluation, results, and disposition.
- Balanced Operations Coach blends safety, throughput, disposition, Fast Track, and resource-aware priorities as a general-purpose teaching comparator.
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

## v1 Graphs

The Graphs tab shows operational trends over simulation time using the current run event log.

Implemented behavior:
- Adds Graphs as a main workspace tab after Benchmark.
- Reconstructs time-series points from simulation events and patient state transitions.
- Shows Flow Census Over Time for waiting room, roomed active patients, results waiting, and admission/boarding.
- Shows Throughput Over Time for arrivals, patients seen, departures, and LWBS.
- Shows Safety + Quality Signals for reassessments, deteriorations, LWBS, and STEMI alerts.
- Uses local SVG charts without adding a charting dependency.
- Keeps graph display out of the simulation rules.

Primary files:
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
- Exposes CSV download and copy actions in the top-level Files tab.
- Exports or copies the activity timeline as CSV from the browser.
- Exports or copies an all-runs CSV with Provider Run, Optimal Flow Coach, Front-End Focus Coach, Middle Flow Focus Coach, Disposition Focus Coach, Resource-Aware Coach, Safety First Coach, Fast Track Coach, and Balanced Operations Coach records.

Primary files:
- `src/simulation/activityTimeline.ts`
- `src/simulation/types.ts`
- `src/ui/App.tsx`

## v1 Files / Saved Runs

Persistence v1 exports completed or in-progress simulation runs as user-controlled JSON files. It is designed to preserve enough state for review and replay work without introducing a database, authentication, PHI, or networked collaboration.

Implemented behavior:
- Adds a top-level Files tab.
- Adds a Run Files section with Export Current Run and Import File.
- Export Current Run writes the current scenario configuration, active synthetic patient deck, run state, events, decisions, metrics, and a current snapshot to a saved-run JSON file.
- Import File brings a saved-run JSON file back into the app for load and replay.
- Shows saved run status, simulation minute, event count, decision count, snapshot count, patient count, and last updated time.
- Allows loading a saved run back into the simulator so the user can continue from the saved point.
- Pauses a restored run when the saved run had been running, so loading does not immediately resume the clock.
- Allows deleting saved run records.
- Provides Export Current Run for saving the current run to a user-selected JSON file location when the browser supports file picking, with browser download fallback.
- Imported and recently exported saved runs appear as cards in the Files tab and are cached in the browser profile only so the user can load, replay, or delete them during later app sessions.
- Adds a separate CSV Export section for activity timeline CSV and all-runs CSV export/copy actions.

Important boundary:
- The primary save path is file export/import so the user chooses where saved-run JSON files live.
- Browser local storage is a convenience cache for the visible saved-run cards, not the primary storage location.
- The app does not automatically write to arbitrary folders without a user file-picker or browser download action.
- Loaded saved runs resume from the saved point when the user chooses Load.
- Saved runs can also be opened in Replay v1 for read-only playback from the beginning.
- Export Current Run is a JSON save for reload/replay; Activity CSV and All Runs CSV are spreadsheet exports for review and are not reloadable saved-run files.
- Saved runs use synthetic simulation state only and do not store PHI.

Primary files:
- `src/ui/App.tsx`
- `src/ui/styles.css`

## v1 Replay / Saved Run Playback

Replay v1 lets the user play back a saved run from the beginning after saving it locally. It is a read-only timeline playback of the saved run rather than a new simulation branch.

Implemented behavior:
- Adds a Replay button to each Saved Runs card.
- Starts replay at the saved run's shift start minute.
- Shows a Replay control bar in Live Operations with Play Replay, Pause Replay, 1 min, 5 min, and Exit Replay controls.
- Advances the board minute by minute through the saved run timeline.
- Filters visible events and provider decisions to the current replay minute.
- Projects patient states, rooms, provider busy state, metrics, graphs, activity, guardrails, and debrief to the replay minute.
- Keeps replay read-only by disabling live provider actions, Start, manual advance, Reset, Coach Demo, scenario apply/default changes, and save-current-run while replay is active.
- Exit Replay restores the live working run that was open before replay started.

Important boundary:
- Replay v1 does not allow branching from a replay minute.
- Replay v1 does not re-run the simulation engine or create new decisions; it displays the saved run as it existed at each minute.
- Historical room-cleaning display is reconstructed from saved state and patient departure timing.
- Load and Replay are intentionally separate: Load resumes from the saved point, while Replay plays the saved run from the beginning.

Primary files:
- `src/ui/App.tsx`
- `src/ui/styles.css`

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
- Hospitalist pending consults and response timing.
- Room cleaning / next room ready status.
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

Formula and timing validation:
- `docs/v1-metric-formula-and-timing-validation.md`

## Intentional v1 Boundaries

Not yet included:
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
