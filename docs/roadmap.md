# Detection Engine Roadmap

## Current (v1) — Shipped

Four cable-protection-focused detectors:
- Loitering over cable corridors
- AIS gap ("going dark")
- Identity anomaly (name/callsign swap, flag mismatch, teleport)
- Anchor drag over cables

## Phase 1 — In Progress

Two new single-vessel detectors (bolt-on, same architecture as v1):
- **Speed anomaly** — type-mismatch speed + repeated sudden speed changes
- **Route deviation** — course reversals, circling, shipping lane departure
- **Frontend filter chips** — filter event feed by detector type

See: `docs/superpowers/specs/2026-07-05-threat-typology-expansion-design.md`

## Phase 2 — Planned

Cross-vessel correlation detectors (requires architectural consideration):
- **Rendezvous / STS** — two vessels meeting at sea (ship-to-ship transfer). Common in sanctions evasion, IUU catch offloading, militia supply runs. Detection: proximity threshold between two vessels for sustained period.
- **Convoy / formation** — multiple vessels moving together in coordinated patterns. Hallmark of maritime militia flotillas. Detection: cluster analysis on heading + speed + proximity.

These require the pipeline to reason about *pairs* or *groups* of vessels, not just individual tracks. Two architectural approaches were considered and deferred:

### Approach B: Detector Registry + Shared Utilities
Extract shared pattern-detection helpers (e.g., `patternCount(ring, predicate, window)`) and a detector registry so new detectors can be added by dropping a file + registering. Reduces boilerplate when detector count grows.

### Approach C: Scored Behavior Profiles
Instead of independent detectors, build per-vessel "behavior profiles" tracking multiple dimensions (speed variance, heading stability, corridor proximity, AIS consistency). Each threat type is a weighted combination of profile dimensions. More flexible for catching novel patterns, but harder to explain to users and test deterministically.

## Phase 3 — Future Ideas

- **Intent classification** — assign threat categories (cable sabotage, gray zone, IUU fishing, militia) to detected anomalies based on combinations of detector signals and vessel metadata
- **Historical pattern matching** — flag vessels that have previously been involved in incidents (repeat offenders)
- **Satellite AIS integration** — fill terrestrial AIS blind spots with satellite data (Spire, MarineTraffic research API)
- **Alert notifications** — push alerts to SeaLight team for high-severity events

## Threat model finer-granularity — Phase 0 shipped (2026-07-18)

Labeling harness live: `candidate_incidents` + `labels` tables, `scripts/materialize-candidates.ts`
generating candidates from four sources, `GET/POST /api/labels/*`, and `#mode=review` UI.
`militia_presence` category retired. See
[Phase 0 plan](superpowers/plans/2026-07-18-threat-model-phase-0-labeling-harness.md)
and [spec §3](superpowers/specs/2026-07-18-threat-model-finer-granularity-design.md#3-phase-0---labeling-harness).

Next: accumulate ≥ 200 labeled incidents (≥ 40 threat, ≥ 100 benign) before starting Phase 1.
