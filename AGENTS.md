# ED Simulation Repository Guide

## Purpose
This app is a synthetic operational ED-flow training simulation. It is not clinical decision support and must not contain PHI, diagnosis advice, or treatment recommendations.

## Layout
- `src/simulation/`: TypeScript simulation engine, rules, metrics, events, scenarios, demo, and tests.
- `src/ui/`: React board interface and styles.
- `src/main.tsx`: Vite/React entry point.

## Commands
- Install: `npm ci`
- Test: `npm test`
- Type-check: `npm run typecheck`
- Build: `npm run build`
- Run locally: `npm run dev`
- Smoke demo: `npm run demo`

## Engineering Rules
- Keep simulation rules in `src/simulation`; UI components may display state and call engine APIs, but must not encode flow rules.
- Keep strict TypeScript on for `.ts` and `.tsx`; do not use `any`, `@ts-ignore`, or unsafe non-null assertions to hide errors.
- Patient generation must remain deterministic for a given scenario seed; unique run identity must remain separate from deterministic decks.
- Provider actions and meaningful patient-state transitions must create decision/event records.
- Add or update behavior tests whenever simulation behavior changes.
- Preserve future replay compatibility: avoid module-global counters, hidden mutation, and ambiguous event semantics.

## Do Not
- Replace React, Vite, or TypeScript without a documented critical reason.
- Add PHI fields or undocumented clinical assumptions.
- Add persistence, replay, benchmark, LWBS, observation, backend, auth, or multi-provider features during foundation stabilization.

## Definition Of Done
`npm ci`, `npm test`, `npm run typecheck`, `npm run build`, and `npm run demo` pass; simulation and UI separation is preserved; synthetic-only data remains intact; IDs are collision-safe; metrics and state transitions are tested.
