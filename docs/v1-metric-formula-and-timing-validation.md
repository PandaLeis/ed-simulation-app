# v1 Metric Formula and Timing Validation

Last reviewed: June 20, 2026

This document validates the current v1 simulation formulas and timing assumptions against the implementation. It confirms internal consistency only. It does not validate the model against real ED operational data, clinical standards, staffing studies, or local hospital performance benchmarks.

Primary implementation files:
- `src/simulation/metricsEngine.ts`
- `src/simulation/simulationEngine.ts`
- `src/simulation/timingProfile.ts`
- `src/simulation/actionRules.ts`
- `src/simulation/scenarioTuning.ts`
- `src/simulation/arrivalGenerator.ts`
- `src/simulation/optimalFlowBenchmark.ts`
- `src/simulation/flowGuardrails.ts`

## Validation Summary

The current formulas are internally consistent with the v1 training model. The app is best described as a deterministic synthetic ED-flow simulator with seeded patient generation and seeded timing variation.

Important interpretation notes:
- Metrics are operational training metrics, not clinical quality measures.
- Benchmark and Coach Comparison are heuristic strategy comparisons. They are not externally validated best-practice engines.
- Lab, imaging, ECG, lactate, antibiotic, fluid, hospitalist, bed, and room-cleaning timings are modeled as ready times, not as downstream queue-capacity systems.
- Nurse and tech capacity are pooled resources, not named staff assignments.
- Provider model supports Team, Assigned, and Handoff ownership, but it does not identify the current human user as a distinct named provider.

## Model Assumptions Status

Model Assumptions makes assumptions visible in the app and distinguishes local values from defaults before a provider uses a scenario.

Implemented behavior:
- A top-level Model Assumptions tab lists each model area, assumption, current value, source, and status.
- Calibration / Assumptions v2 adds named assumption profiles in Model Assumptions.
- Built-in profiles are Default, Local Baseline, and Boarding Surge Training.
- Custom assumption profiles save the current draft Scenario Tuning values locally in the browser profile and can be loaded, edited, duplicated, or deleted later.
- The profile edit workflow opens Scenario Tuning with an editing banner, allowing the user to save changes back to the profile, save the edited values as a new profile, apply the scenario, or cancel the edit session.
- Default is protected as a built-in profile; Local Baseline and Boarding Surge Training can be customized locally through override profiles and reset back to their built-in values.
- Applying a profile updates draft assumptions only; the scenario is not rebuilt until the user chooses Apply scenario.
- Applied Scenario Tuning values that differ from defaults are shown as local values.
- Scenario Tuning values edited but not yet applied are shown as draft changes.
- Scenario Validation v2 provides advisory checks for capacity, staffing, timing, patient mix, and extreme draft values before a scenario is applied. Each issue includes the detected condition, expected operational impact, and a suggested adjustment.
- Patient mix assumptions are configurable in Scenario Tuning for acuity pattern, complaint pattern, workup intensity, admission pressure, and deck seed.
- Coach/Benchmark priority rules are configurable in Scenario Tuning for priority mode, ESI acuity weight, risk weight, and wait-minute weight.
- Use Local Baseline populates draft tuning with the current working baseline: 17 rooms, 3 ED providers, automated front-end triage, 3 nurses, 2 techs, 12-hour simulation, arrivals at 12 per hour, provider evaluation 12 minutes, triage 5 minutes, lab TAT 45 minutes, imaging TAT 55 minutes, hospitalist response 45 minutes, boarding 63 minutes, room cleaning 20 minutes, LWBS disabled, and minimum wait before LWBS 90 minutes.
- Workflow Rules now make several former fixed v1 assumptions tunable: STEMI ECG target, possible ACS ECG target, repeat troponin delay, lactate collection, blood culture collection, antibiotics, IV fluids, sepsis critical wait threshold, and deterioration grace after overdue reassessment.
- Coach Benchmark Rules preserve the original default scoring with Balanced mode, ESI acuity weight 1000, risk weight 150, and wait-minute weight 1.
- The Scenario Tuning Coach rules apply to the live Coach and Optimal Flow Coach, and each Coach Comparison strategy has an editable priority profile that is shown on its comparison card.
- Default Coach Rules are visible first in Scenario Tuning. Comparison Coach Rules are hidden by default and are revealed with Show All Coach Rules.

Coach priority rule meaning:
- Priority mode chooses the coach's broad action strategy. Balanced uses general flow logic across safety, rooming, results, disposition, and waiting-room pressure. Safety first moves high-risk, deteriorating, overdue reassessment, cardiac, and sepsis-sensitive work earlier. Throughput favors actions that keep patients moving toward results, disposition, discharge/admit, and room release. Front-end favors triage, protocol starts, intake, and waiting-room movement.
- ESI acuity weight controls how strongly the coach prioritizes lower ESI / higher acuity patients.
- Risk weight controls how strongly the coach prioritizes operational risk level, from low through critical.
- Wait-minute weight controls how much priority a patient gains for each minute waited.

Within a coach rule bucket, patient priority is scored as:

```text
priority =
  (6 - ESI) * ESI acuity weight
  + risk rank * risk weight
  + wait minutes * wait-minute weight
```

Risk rank is low = 1, moderate = 2, high = 3, and critical = 4. Higher ESI acuity weight makes the coach more acuity-driven, higher risk weight makes it more safety-risk-driven, and higher wait-minute weight makes it more wait-time / throughput-driven.

Coach strategy behavior:
- Default / Optimal Flow Coach: chooses the broad action path from the selected mode, then uses ESI/risk/wait weights to rank patients inside that action bucket.
- Front-End Focus Coach: clears triage and protocol starts before downstream roomed-patient work, then moves eligible waiting patients into rooms or Fast Track.
- Middle Flow Focus Coach: prioritizes roomed unseen patients, provider evaluation, orders, and diagnostic result movement.
- Disposition Focus Coach: prioritizes results review and discharge/admit decisions to clear rooms and define boarding.
- Resource-Aware Coach: checks nurse, tech, room, and provider constraints before creating more support-resource work; clears disposition, results, and unseen roomed work first when support capacity is constrained.
- Safety First Coach: moves deteriorating patients, overdue reassessments, critical waits, and cardiac/sepsis-sensitive work earlier.
- Fast Track Coach: prioritizes eligible lower-acuity patients into Fast Track and keeps vertical-care patients moving.
- Balanced Operations Coach: blends safety, throughput, disposition, Fast Track, and resource-aware priorities.

Model Assumptions boundaries:
- It does not import historical ED data.
- It does not prove the assumptions are locally accurate.
- It does not yet edit LWBS probability curves, lab/imaging queues, EVS staffing, or detailed benchmark/coach sub-rule order.
- Configuration palette selection and Dark Mode default selection are display-only and do not change simulation math, assumptions, benchmark logic, or saved-run content.
- Configuration separates light palettes from the lower Dark Mode Palettes section.
- Dark Mode Palettes use one Default checkbox per dark palette card, with exactly one dark default selected at a time.
- The Live Operations Dark Mode checkbox switches to the selected dark default palette and returns to Daylight Clinical when turned off.

## Persistence and Replay Status

Files is the app's user-controlled save and export area.

Implemented behavior:
- Run Files contains Export Current Run and Import File.
- Export Current Run creates a saved-run JSON file containing the current scenario, patient deck, run state, events, decisions, metrics, and snapshot data needed for later load or replay.
- Import File brings saved-run JSON records back into the app and merges them by saved-run id.
- Imported and recently exported runs appear as Saved Runs cards with Replay, Load, and Delete actions.
- Load resumes from the saved point. Replay starts at the beginning of the saved run and is read-only.
- A saved/imported run exposes a Live Operations Replay shortcut in the main control row so the user can replay the file without returning to Files. If a saved run has been loaded, the shortcut uses that loaded run; otherwise it uses the most recent saved/imported run. The loaded-run pointer is cleared after new live actions alter the loaded board state, while the shortcut can still fall back to the most recent saved/imported run.
- Export is separate from saved-run JSON. Activity and All Runs exports are spreadsheet review exports and are not reloadable run files.
- Activity export contains the current visible run timeline with arrivals, operational events, provider decisions, and benchmark timing deltas.
- All Runs export contains the provider run plus benchmark and coach strategy comparison runs for side-by-side analysis.
- Download actions use the selected format: CSV comma-delimited or Excel format.
- Copy Activity CSV and Copy All Runs CSV copy plain CSV text to the clipboard for quick paste without creating a file.
- Copy actions remain CSV because clipboard copy is plain text.
- Export shows the Activity record count, All Runs record count, number of included runs, and currently selected download format before the user downloads or copies data.
- Export includes a column guide for the core Activity fields and the All Runs strategy fields.
- The Files tab presents Run Files and Export as equal-width desktop sections.

Important boundary:
- The primary save path is user-selected file export/import. Browser local storage is only a convenience cache for the visible Saved Runs cards.
- Replay reconstructs the saved timeline; it does not re-run the simulation engine, branch a new run, or create new provider decisions.
- Replay controls include play/pause, speed selection, jump to start, 1-minute step back, 1-minute step forward, jump to end, Exit Replay, a minute slider, previous/next recorded-activity jumps, replay progress summary cards, and a "What changed" panel for the current replay minute.
- Replay projects provider busy/available status, front-end triage provider status, nurse/tech busy counts, hospitalist pending status, and selected Patient Status from the saved timeline at the current replay minute.
- Replay projects Guardrails and Debrief to the current replay minute. Guardrails are recalculated from the saved board state, while Debrief summarizes saved events and decisions through the replay minute.
- Coach appears during replay from saved provider decisions. It explains the action recorded at the current replay minute, or the most recent saved coachable action when no provider action was recorded at that exact minute.
- Applying a Coach recommendation is disabled in replay because playback is read-only.
- Coach explanation v3 derives the next available alternatives from the same enabled action rules and displays why the selected recommendation ranked ahead of the next 2-3 options.
- Saved runs use synthetic simulation data only and do not store PHI.

## Core Metric Formulas

| Metric | Current Formula | Validation Notes |
| --- | --- | --- |
| Patients arrived | Count patients with `arrivedAt` set | Includes all arrivals regardless of final state. |
| Patients seen | Count patients with `providerSeenAt` set | Includes departed/admitted patients if they were seen. |
| Patients dispositioned | Count patients with `dispositionDecisionAt` set | Includes discharge and admit decisions. |
| Patients departed | Count patients with `departedAt` set | LWBS also sets `departedAt`, so LWBS patients are included in departed. |
| Patients LWBS | Count patients whose state is `lwbs` | LWBS only fires from Waiting Room. |
| LWBS rate | `patientsLWBS / patientsArrived` | Returns `0` when no patients have arrived. |
| Average wait before LWBS | Average of `lwbsAt - arrivedAt` | Uses arrival-to-LWBS, not triage-complete-to-LWBS. |
| High-risk LWBS | Count LWBS patients with `riskLevel` high or critical | Risk can be time-derived or deterioration-derived. |
| LWBS with pending orders | Count LWBS patients where `pendingItems.length > 0` | This currently means the patient had order/workup items, not necessarily that every item was still pending. |
| Triage census | Count state `triage` | Front-End Triage queue only. |
| Waiting room census | Count state `waiting` | Does not include triage or Fast Track. |
| Fast Track census | Count state `fast_track` | Fast Track is separate from ED rooms. |
| Patients fast tracked | Count patients with `fastTrackedAt` set | Historical count, not current census. |
| Average waiting-room wait | Average current wait for patients in state `waiting` | Starts at triage completion for front-end triage patients; starts at arrival for direct waiting-room patients. |
| Longest waiting-room wait | Max current waiting-room wait among state `waiting` patients | Returns `0` if no waiting patients. |
| Waiting-room risk minutes | Sum over all patients of waiting-room minutes beyond 30 minutes | Counts historical waiting-room exposure, not just current census. |
| Reassessments overdue | Count waiting patients with overdue reassessment minutes greater than 0 | Based on `nextReassessmentDueAt`. |
| Longest reassessment overdue | Max overdue reassessment minutes | Returns `0` if none overdue. |
| Waiting-room deteriorations | Count patients with `deterioratedAt` set | Currently one deterioration event per patient. |
| Active patient census | Arrived non-terminal patients excluding `waiting` and `triage` | Includes Fast Track, roomed, results, admission pending, and boarding. |
| Boarding census | Count state `boarding` | Admission pending is tracked separately. |
| Admission pending census | Count state `admission_pending` | Represents hospitalist consult/admission acceptance wait. |
| Average admission decision minutes | Average of `admissionAcceptedAt - dispositionDecisionAt`, using current minute if not accepted yet | Pending admissions increase this value while waiting. |
| Total admission decision minutes | Sum of the same admission decision intervals | Includes still-pending admission requests. |
| Total boarding minutes | Sum of `departedAt/currentMinute - admissionAcceptedAt` for admitted patients accepted by hospitalist | Starts after hospitalist acceptance, not at ED admit decision. |
| Available rooms | Count rooms with status `available` | Cleaning rooms are unavailable. |
| Occupied rooms | Count rooms with status `occupied` | Boarding rooms become `blocked`, not occupied. |
| Blocked rooms | Count rooms with status `blocked` | Currently used for boarding patients consuming ED room capacity. |
| Cleaning rooms | Count rooms with status `cleaning` | Room turnover status after departure. |
| Total room cleaning minutes | Sum current cleaning elapsed time for rooms currently cleaning | Current active cleaning only; completed historical cleaning is not accumulated here. |
| Longest current wait | Max `currentMinute - arrivedAt` among active non-terminal patients | This includes roomed, results, admission, and boarding patients. |
| Patients seen per hour | `patientsSeen / elapsedHours` | Elapsed hours are clamped to at least 1 minute to avoid divide-by-zero. |
| Average door-to-provider | Average `providerSeenAt - arrivedAt` | Arrival-based, not rooming-based. |
| Average time to disposition | Average `dispositionDecisionAt - arrivedAt` | Arrival-to-ED disposition decision. |
| Average results-ready-to-disposition | Average `dispositionDecisionAt - resultsReadyAt` | Only patients with results ready and dispositioned. |
| Average ED length of stay | Average `departedAt - arrivedAt` | Includes admitted boarding departures and discharges; LWBS has `departedAt`. |
| Provider busy minutes | Sum provider `busyMinutes` | ED providers only. |
| Provider idle minutes | Sum provider `idleMinutes` | ED providers only. |
| Nurse/tech busy | Current busy assignment counts by pool | Pooled resource count, not individual staff identities. |
| Nurse/tech busy minutes | Accrued busy assignment-minutes by pool | Multiple simultaneous assignments add multiple minutes per simulated minute. |
| Peak waiting-room census | Max previous peak and current waiting-room census | Incremental peak during live run. |
| Peak active patient census | Max previous peak and current active patient census | Incremental peak during live run. |

## Cardiac Metrics

| Metric | Current Formula | Validation Notes |
| --- | --- | --- |
| Chest pain patients arrived | Count arrived patients with complaint `chest_pain` | Complaint-category metric. |
| Suspected ACS patients arrived | Count arrived patients with complaint `suspected_acs` | Complaint-category metric. |
| STEMI alerts activated | Count patients with `stemiAlertActivatedAt` set | Synthetic pathway activation. |
| Average door-to-ECG | Average `ecgCompletedAt - arrivedAt` | ECG is a simulated diagnostic item. |
| Door-to-ECG within 10 rate | ECG completions `<= 10` divided by arrived cardiac-pathway patients | Denominator includes cardiac patients who may not have completed ECG yet. |
| Median/P90 door-to-ECG | Percentile of completed ECG door times | Uses nearest-rank percentile. |
| ECG reviewed within 10 rate | ECG review times `<= 10` divided by arrived cardiac-pathway patients | ECG review currently occurs automatically when ECG completes. |
| Door-to-troponin collection | Average first troponin `collectedAt - arrivedAt` | Troponin collection is set at order time. |
| Troponin turnaround | Average `readyAt - collectedAt` for first troponin | Based on synthetic ready time. |
| ECG-to-STEMI activation | Average `stemiAlertActivatedAt - ecgCompletedAt` | Currently often zero because STEMI activation happens when ECG completes. |
| Delayed ECG count | Cardiac patients where `(ecgCompletedAt or currentMinute) - arrivedAt > 10` | Includes cardiac patients still waiting for ECG after 10 minutes. |
| Cardiac results ready awaiting review | Cardiac patients in `results_ready` with results not reviewed | Operational backlog count. |

Cardiac timing assumptions:
- Suspected ACS with cardiac workup has a 12% STEMI-alert chance before minimum-promotion logic.
- Chest pain with cardiac workup has a 4% STEMI-alert chance before minimum-promotion logic.
- Scenario guarantees at least one STEMI-alert patient by promotion when configured.
- ECG target is configurable in Workflow Rules. Defaults are arrival + 5 minutes for STEMI-alert pathway and arrival + 8 minutes for possible ACS, but never earlier than one minute after orders are placed.
- First troponin ready time is `max(15, expectedLabMinutes)`.
- Repeat troponin ready time is first troponin ready time + configurable repeat delay. Default is 60 minutes.
- Chest X-ray ready time is `max(15, expectedImagingMinutes)`.

## Sepsis Metrics

| Metric | Current Formula | Validation Notes |
| --- | --- | --- |
| Sepsis patients arrived | Count arrived patients with complaint `sepsis_concern` | Complaint-category metric. |
| Sepsis pathway started | Count sepsis patients with `sepsisRecognizedAt` set | Set when sepsis orders are placed. |
| Sepsis recognition within 10 rate | Recognition times `<= 10` divided by arrived sepsis patients | Denominator includes patients not yet recognized. |
| Door-to-sepsis recognition | Average `sepsisRecognizedAt - arrivedAt` | Only recognized patients. |
| Door-to-lactate collection | Average lactate `collectedAt - arrivedAt` | Collection is modeled at order + 5 minutes. |
| Door-to-lactate result | Average lactate ready/completed time minus arrival | Based on synthetic lab ready time. |
| Door-to-blood cultures | Average blood culture ready/completed time minus arrival | Blood cultures are collected and ready at order + 8 minutes. |
| Door-to-antibiotics | Average antibiotic ready/completed time minus arrival | Antibiotics are modeled as ready/completed at order + 35 minutes. |
| Antibiotics within 60 rate | Antibiotic times `<= 60` divided by arrived sepsis patients | Denominator includes patients not yet given antibiotics. |
| Median/P90 door-to-antibiotics | Percentile of antibiotic completion times | Uses nearest-rank percentile. |
| Door-to-fluids | Average IV fluid ready/completed time minus arrival | Fluids are modeled at order + 20 minutes. |
| Sepsis waiting without room | Count sepsis patients currently in Waiting Room | Operational risk signal. |
| Sepsis LWBS/rate | Sepsis LWBS count divided by arrived sepsis patients | Returns `0` when denominator is zero. |

Sepsis timing assumptions:
- Lactate collection: order + configurable delay. Default is 5 minutes.
- Lactate result: order + `max(20, expectedLabMinutes)`.
- Blood cultures: collected and ready at order + configurable delay. Default is 8 minutes.
- Antibiotics: order + configurable delay. Default is 35 minutes.
- IV fluids: order + configurable delay. Default is 20 minutes.
- Sepsis risk becomes critical after a configurable wait in triage or waiting. Default is 10 minutes.

## Timing Model

Base timing ranges:

| Timing Area | Default Min | Default Typical | Default Max |
| --- | ---: | ---: | ---: |
| Provider evaluation | 8 | 12 | 22 |
| Triage | 3 | 5 | 10 |
| Lab turnaround | 35 | 45 | 75 |
| Imaging turnaround | 30 | 55 | 95 |
| Admission decision / hospitalist response | 20 | 45 | 120 |
| Boarding duration / inpatient bed wait | 35 | 63 | 150 |
| Room cleaning / turnover | 8 | 20 | 45 |

Sampling:
- Durations are sampled from a seeded PERT-style distribution using min, typical, and max.
- The PERT shape uses lambda `4`, then rounds to the nearest minute.
- Scenario Tuning derives ranges from the user-entered typical value.
- Seeded randomness means the same scenario seed and inputs should generate repeatable patients and timings.

Scenario tuning bounds:

| Input | Bound |
| --- | --- |
| ED room capacity | 1 to 40 |
| ED providers | 1 to 4 |
| Nurses | 1 to 4 |
| Techs | 0 to 2 |
| Simulation length | 60 to 2880 minutes |
| Expected arrivals per hour | 0 to 30 |
| Provider evaluation typical | 1 to 90 minutes |
| Triage typical | 1 to 30 minutes |
| Lab turnaround typical | 1 to 240 minutes |
| Imaging turnaround typical | 1 to 300 minutes |
| Admission decision typical | 1 to 360 minutes |
| Boarding duration typical | 0 to 720 minutes |
| Room cleaning typical | 0 to 180 minutes |
| Minimum wait before LWBS | 0 to 360 minutes |

Action time assumptions:

| Action | Default Time | Notes |
| --- | ---: | --- |
| Complete triage | Complaint-specific triage duration | Uses triage profile and multiplier. |
| Room patient | 2 min | Requires nurse + tech. |
| Move to Fast Track | 1 min | Requires tech. |
| Reassess waiting patient | 3 min | Requires nurse. |
| Start protocol orders | 0 min | Requires nurse + tech. |
| See patient | ESI-adjusted provider evaluation duration | Sampled from provider evaluation timing profile. |
| Place orders | 4 min | Requires nurse + tech. |
| Review results | 5 min | ED provider action. |
| Discharge home | 8 min | Requires nurse. |
| Admit inpatient | 8 min | Requires nurse. |
| Continue waiting | 0 min | Records decision only. |

Provider evaluation ESI multipliers:

| ESI | Multiplier |
| --- | ---: |
| 1 | 1.8 |
| 2 | 1.4 |
| 3 | 1.0 |
| 4 | 0.75 |
| 5 | 0.55 |

Complaint triage durations:
- Suspected ACS: 10 min
- Chest pain: 7 min
- Abdominal pain: 6 min
- Shortness of breath: 8 min
- Injury: 5 min
- Weakness/dizziness: 6 min
- Fever/infection: 5 min
- Behavioral health: 8 min
- Stroke/neuro: 9 min
- Sepsis concern: 8 min
- Major trauma: 7 min
- Pediatric: 6 min
- OB/pregnancy: 7 min
- Syncope: 6 min
- Altered mental status: 8 min
- Overdose/intoxication: 8 min
- Renal/urinary: 5 min
- GI bleed: 7 min
- Allergic reaction: 5 min
- Burn: 5 min
- Eye/ENT: 4 min
- Back pain: 4 min
- Hypertensive symptoms: 6 min
- Diabetic emergency: 7 min
- Social placement: 6 min
- Minor complaint: 3 min

## Admission, Hospitalist, Boarding, and Room Cleaning

Admission flow:
- ED provider chooses Admit Inpatient.
- Patient moves to `admission_pending`.
- Admission/hospitalist response ready time is `currentMinute + expectedAdmissionDecisionMinutes`.
- When ready, the simulation logs hospitalist acceptance and starts boarding.
- Boarding ready time is `currentMinute + expectedBoardingMinutes`.
- When boarding completes, the patient departs the ED as admitted.

Hospitalist work represented:
- Hospitalist consult / admit request: ED Admit Inpatient action.
- Hospitalist response time: `expectedAdmissionDecisionMinutes`.
- Acceptance / request more info: current v1 always transitions to acceptance when ready; request-more-info is represented in the UI/documentation language but not yet a separate branch.
- Admission orders: logged as part of hospitalist acceptance / boarding start.
- Bed request: represented by the `boarding_bed` pending item.
- Boarding: state `boarding`.
- Inpatient bed assigned: boarding item ready.
- ED departure: admitted patient departure after boarding completes.

Room cleaning:
- On departure from a room, the room enters `cleaning` for `expectedRoomCleaningMinutes`.
- If cleaning duration is 0, the room becomes available immediately.
- Completed historical cleaning minutes are not accumulated in `totalRoomCleaningMinutes`; that metric is current active cleaning elapsed time.

## Waiting-Room Risk, Reassessment, Deterioration, and LWBS

Risk level:
- STEMI-alert pathway: critical.
- Sepsis concern with wait >= 10 minutes: critical.
- Possible ACS with wait >= 30 minutes: high.
- Any wait >= 90 minutes: critical.
- Any wait >= 60 minutes: high.
- Any wait >= 30 minutes: moderate.
- Otherwise: low.

Reassessment intervals:
- Critical: every 10 minutes.
- High or ESI 1/2: every 15 minutes.
- Moderate or ESI 3: every 30 minutes.
- Low: every 60 minutes.

Deterioration:
- Waiting-room patients deteriorate if reassessment is overdue by at least the configurable deterioration grace period. Default is 30 minutes.
- Deterioration escalates risk one level and improves ESI by one level down to ESI 2.
- Current v1 allows only one deterioration timestamp per patient.

LWBS:
- LWBS only applies to Waiting Room patients.
- LWBS is disabled by default in the default scenario.
- ESI levels listed in `highAcuityBlockedEsiLevels` cannot LWBS; default blocks ESI 1 and ESI 2.
- A patient cannot LWBS before `minimumWaitBeforeLWBS`.
- Probability is:

```text
min(1, max(0, (lwbsBaseRisk + waitPressure) * patienceMultiplier * acuityModifier * riskModifier))
```

Where:
- `waitPressure = min(0.18, minutesBeyondThreshold * 0.003)`
- `acuityModifier = 0.6` for ESI 1 to 3, otherwise `1`
- `riskModifier = 0.35` for critical, `0.55` for high, otherwise `1`
- low-patience multiplier default is `1.6`
- medium-patience multiplier default is `1`
- high-patience multiplier default is `0.45`

## Benchmark and Coach Assumptions

The benchmark and coach use deterministic rule-based action selection.

Shared prioritization includes:
- ESI acuity.
- Risk level.
- Wait time.
- Patient number as a stable tie-breaker.

The primary benchmark generally prioritizes:
- Results review.
- Disposition decisions.
- Unseen patients with ready or pending results.
- Waiting-room flow actions.
- Overdue reassessments.
- Roomed patients.
- Orders.
- Front-end triage/protocol orders.

Coach comparison strategies are specialized heuristics:
- Front-End Focus.
- Middle Flow Focus.
- Disposition Focus.
- Resource Aware.
- Safety First.
- Fast Track Focus.
- Balanced Operations.

Validation note:
- These are plausible operational heuristics for training and comparison.
- They are not calibrated to local ED policy, staffing contracts, hospital throughput data, physician practice patterns, or clinical quality benchmarks.
- Because benchmark and coach runs simulate alternate futures, they can take time to calculate, especially for longer runs or higher patient volumes.

## Guardrail Thresholds

Current v1 guardrails include:
- Idle ED provider while actionable flow work exists.
- Front-end triage wait >= 30 minutes as watch, >= 60 minutes as urgent.
- Reassessment overdue, urgent when longest overdue >= 30 minutes.
- Waiting-room deterioration.
- Roomed patient not yet seen after 15 minutes.
- Results ready for review after 10 minutes when review is available.
- Patient ready for disposition.
- High-risk waiting patient while room capacity is available.
- Boarding pressure when blocked rooms exist or total boarding minutes >= 60.
- Room cleaning pressure when cleaning rooms exist and no rooms are available.
- Nurse capacity limiting flow when all configured nurses are busy and patients need support.
- Tech capacity limiting placement when all configured techs are busy and waiting-room patients need placement.
- Hospitalist response delay when admission pending census > 0 and total admission decision minutes >= 45.

## Validation Gaps and Recommended Next Checks

The formulas are internally coherent, but the following items should be considered before calling the model operationally validated:

- Calibrate arrival distributions, ESI mix, complaint mix, admission probability, LWBS probability, and timing ranges against local historical data.
- Decide whether ECG review should remain automatic or become a provider/radiology/cardiology workload item.
- Decide whether `LWBS with pending orders` should count only items with status `pending` instead of any workup item.
- Decide whether completed historical room cleaning minutes should be accumulated separately from currently active cleaning minutes.
- Add a separate request-more-info branch to the hospitalist workflow if that behavior should be trained.
- Add capacity queues for lab, imaging, transport, EVS, and inpatient bed assignment if downstream bottlenecks need realistic behavior.
- Add named provider attribution if the user-provider should be distinct from automated providers.
- Consider adding tests for every displayed UI metric label to ensure it maps to the intended `SimulationMetrics` field.

## Current Automated Coverage

The primary automated test suite covers:
- Scenario tuning and presets.
- Patient generation.
- Provider actions and validation.
- Multi-provider assignment modes.
- Triage and automated triage.
- Protocol orders.
- Nurse and tech support resource constraints.
- LWBS behavior.
- Waiting-room reassessment and deterioration.
- Guardrails.
- Room cleaning.
- Hospitalist/admission/boarding flow.
- Activity timeline and activity export behavior.
- Benchmark and coach behavior.
- Replay and persistence-related behavior.

Recommended verification commands:
- `npm test`
- `npm run typecheck`
- `npm run build`
