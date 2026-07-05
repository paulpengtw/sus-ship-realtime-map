# Threat Typology Expansion — Design Spec

**Date:** 2026-07-05
**Status:** Approved by user (brainstorming session)
**Builds on:** [Taiwan Cable-Guard Map design](2026-07-04-taiwan-cable-guard-map-design.md)
**Phase:** 1 of 2 (single-vessel detectors)

## 1. Background & Goal

The current detection engine has four detectors, all oriented around submarine cable protection: loitering, AIS gap, identity anomaly, and anchor drag. SeaLight's mission covers broader maritime threats — gray zone operations, maritime militia, IUU fishing, sanctions evasion. A single "suspicion score" coloring vessels grey→amber→red provides no indication of *what kind* of threat a vessel represents.

This design adds two new single-vessel detectors (speed anomaly, route deviation) and event-type filters to the frontend. A second phase (designed separately) will add cross-vessel correlation detectors: rendezvous/STS and convoy/formation.

## 2. Decisions (from brainstorming)

| Question | Decision |
|---|---|
| Goal | New detectors for behaviors not currently caught (not intent classification) |
| Phase 1 scope | Speed anomaly + route deviation (single-vessel, same architecture) |
| Phase 2 scope | Rendezvous/STS + convoy/formation (cross-vessel correlation, later) |
| Architecture | Approach A: bolt-on detectors following existing pattern |
| Speed logic | Both type-mismatch AND repeated sudden changes; require pattern (3+), not one-off |
| Route data | Trajectory anomalies (reversals, circling) + shipping lane deviation where data available |
| Frontend | Filter chips on event feed by detector type; single-select |
| AISStream | Not subscribed yet; parser already handles ShipStaticData, needs shipType extraction |

## 3. New Event Types

Two new values added to the `EventType` union:

- `"speed_anomaly"` — vessel speed inconsistent with declared type, or repeated sudden speed changes
- `"route_deviation"` — course reversals, circling, or departure from shipping lanes

## 4. Data Model Changes

### 4a. AisIdentity extension

Add `shipType: number | null` to `AisIdentity`. AIS ship type codes come from message type 5 static data (e.g., 30=fishing, 70=cargo, 80=tanker). Parsed from AISStream's `ShipStaticData.Type` field.

### 4b. VesselState extensions

```typescript
shipType: number | null       // latest declared AIS ship type
lastSpeedEventTs: number | null  // cooldown for speed anomaly events
lastRouteEventTs: number | null  // cooldown for route deviation events
```

Speed change counts and trajectory analysis are computed on the fly from the existing ring buffer — no additional stored state needed.

### 4c. AISStream parser

Extend `parseAisStreamMessage` to extract `ShipStaticData.Type` into the `AisIdentity.shipType` field.

## 5. Speed Anomaly Detector (`src/detectors/speed.ts`)

Pure function: `speedOnMessage(s: VesselState, msg: AisPosition, geo: GeoContext, cfg: Config) → AnomalyEvent[]`

### 5a. Type-mismatch speed

A lookup table maps AIS ship type code ranges to expected maximum SOG:

| Ship type | Code range | Max expected SOG (kn) |
|-----------|-----------|----------------------|
| Fishing | 30 | 12 |
| Tug | 31-32, 52 | 14 |
| Pleasure/sail | 36-37 | 10 |
| Passenger | 60-69 | 25 |
| Cargo | 70-79 | 18 |
| Tanker | 80-89 | 16 |

If `s.shipType` is known and the vessel's SOG exceeds its type's max for `speedTypeMaxExceedCount` (default: 3) consecutive messages in the ring, fire a `"speed_anomaly"` event.

- Severity 3 base; boosted to 4 if inside a cable corridor.
- Evidence: `{ kind: "type_mismatch", shipType, expectedMaxKn, actualSogKn, consecutiveCount }`.

### 5b. Repeated sudden speed changes

Scan the ring buffer for "significant speed change" events: absolute SOG delta > `speedChangeThresholdKn` (default: 5 kn) between consecutive positions where dt < `speedChangeMaxDtMs` (default: 10 minutes) (so it's a genuine maneuver, not "vessel sailed for hours then stopped").

If `speedChangeMinCount` (default: 3) or more such changes occur within the last `speedAnomalyWindow` (default: 20) ring positions, fire a `"speed_anomaly"` event.

- Severity 3 base; boosted to 4 if inside a cable corridor.
- Evidence: `{ kind: "sudden_changes", changeCount, thresholdKn, windowSize }`.

### 5c. Cooldown

`speedCooldownMs` (default: 1 hour). If `s.lastSpeedEventTs` is within the cooldown, skip.

### Config additions

```
speedTypeMaxExceedCount: 3
speedChangeThresholdKn: 5
speedChangeMaxDtMs: 600_000
speedChangeMinCount: 3
speedAnomalyWindow: 20
speedCooldownMs: 3_600_000
```

## 6. Route Deviation Detector (`src/detectors/route.ts`)

Pure function: `routeOnMessage(s: VesselState, msg: AisPosition, geo: GeoContext, cfg: Config) → AnomalyEvent[]`

### 6a. Course reversals

COG change > `routeReversalMinDeg` (default: 90 degrees) between consecutive positions where dt < `routeReversalMaxDtMs` (default: 15 minutes). If `routeReversalMinCount` (default: 2) or more reversals occur within the last `routeWindow` (default: 15) ring positions, fire a `"route_deviation"` event.

- Severity 3 base; boosted to 4 if inside a cable corridor.
- Evidence: `{ kind: "course_reversals", reversalCount, windowSize }`.

### 6b. Circling

Compute the displacement/distance ratio over the last `routeCircleMinPositions` (default: 10) ring positions:
- `displacement` = haversine distance from first to last position in the window.
- `distance` = sum of haversine distances between consecutive positions (total path length).
- If `displacement / distance < routeCircleMaxRatio` (default: 0.3) and distance > `routeCircleMinDistanceM` (default: 200m, to avoid flagging stationary vessels), the vessel is circling.

- Severity 3 base; boosted to 4 if inside a cable corridor.
- Evidence: `{ kind: "circling", displacementM, distanceM, ratio, positions }`.

### 6c. Shipping lane deviation

Requires `data/lanes.json` — GeoJSON FeatureCollection of LineStrings representing major shipping lanes, same format as `cables.json`. `GeoContext` gains a `laneBufferM` config value and an `inLane(p: LngLat): boolean` method.

If a vessel meets ALL of:
- Ship type is commercial (cargo 70-79, tanker 80-89)
- NOT in any shipping lane buffer
- NOT in any exclusion zone (port/anchorage)
- SOG > 5 kn (at transit speed)
- This condition holds for `routeLaneDeviationCount` (default: 5) consecutive positions

Then fire a `"route_deviation"` event.

- Severity 2 base (lane deviation is common and often legitimate); boosted to 4 if also inside a cable corridor.
- Evidence: `{ kind: "lane_deviation", shipType, consecutiveCount, nearestLane }`.

**Phase 1 note:** `lanes.json` ships with minimal data (major Taiwan Strait shipping lanes only, or empty). The trajectory-anomaly checks (6a, 6b) work without it. Lane data is enriched over time.

### 6d. Cooldown

`routeCooldownMs` (default: 1 hour). If `s.lastRouteEventTs` is within the cooldown, skip.

### Config additions

```
routeReversalMinDeg: 90
routeReversalMaxDtMs: 900_000
routeReversalMinCount: 2
routeCircleMaxRatio: 0.3
routeCircleMinPositions: 10
routeCircleMinDistanceM: 200
routeWindow: 15
routeLaneDeviationCount: 5
laneBufferM: 5000
routeCooldownMs: 3_600_000
```

## 7. Pipeline Integration

`pipeline.ts` `Tracker.handlePosition()` gains two new detector calls, following the existing guard pattern:

```typescript
events.push(...this.guard(s, () => speedOnMessage(s, msg, this.geo, this.cfg)));
events.push(...this.guard(s, () => routeOnMessage(s, msg, this.geo, this.cfg)));
```

`Tracker.handleStatic()` extracts `shipType` from the identity message and stores it on `VesselState`.

## 8. Frontend Changes

### 8a. Filter chips

A row of single-select filter chips above the event feed list:

`All` | `Loitering` | `AIS gap` | `Identity` | `Anchor drag` | `Speed` | `Route`

- `All` selected by default (current behavior).
- Clicking a chip filters the displayed event list to that `EventType`.
- Clicking the active chip deselects it (back to All).
- Active filter encoded in URL hash: `#filter=speed_anomaly`. Cleared when set to All.

### 8b. TYPE_LABEL additions

```typescript
speed_anomaly: "Speed anomaly",
route_deviation: "Route deviation",
```

### 8c. Dossier panel

Vessel dossier event timeline remains unfiltered — shows all events for the selected vessel regardless of active filter.

### 8d. No scoring changes

The unified suspicion score (decayed severity aggregate) continues to drive vessel dot coloring. New event types contribute to the score the same way existing ones do.

## 9. Testing

Unit tests (Vitest) for each new detector with synthetic tracks:

**Speed anomaly tests:**
- Fishing vessel doing 15 kn for 5 consecutive positions -> fires type_mismatch
- Cargo vessel doing 15 kn -> does NOT fire (within range)
- Vessel with 4 speed changes of 7 kn delta in 20 positions -> fires sudden_changes
- Vessel with 1 speed change -> does NOT fire
- Cooldown: second event within 1 hour -> suppressed

**Route deviation tests:**
- Vessel reversing course 3 times in 15 positions -> fires course_reversals
- Vessel making one normal turn -> does NOT fire
- Vessel circling (displacement/distance ratio 0.15 over 12 positions) -> fires circling
- Straight-line transit -> does NOT fire (ratio ~1.0)
- Cargo vessel out of lane, over cable, at 10 kn for 6 positions -> fires lane_deviation at severity 4
- Same vessel in exclusion zone -> does NOT fire
- Stationary vessel with low displacement -> does NOT fire circling (minimum distance check)

## 10. Data Files

- `data/lanes.json` — GeoJSON FeatureCollection of LineStrings for major shipping lanes. Starts minimal or empty for phase 1.
- `web/public/data/lanes.json` — copy for frontend (if lanes are visualized on map in future).

## 11. Migration

No D1 schema changes needed. The `events` table already stores `type TEXT` and `evidence TEXT (JSON)` — new event types fit the existing schema.
