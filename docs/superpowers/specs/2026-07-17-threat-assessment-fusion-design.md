# Threat Assessment Fusion — Design Spec

**Date:** 2026-07-17
**Status:** Approved by user (brainstorming session)
**Builds on:** [Threat Typology Expansion](2026-07-05-threat-typology-expansion-design.md)
**Phase:** 1 of 2 (fusion engine + cable/dark/identity categories; militia/presence baselining is phase 2)

## 1. Background: measured noise

The live deployment fires far too many alerts. Snapshot from 2026-07-17 (`/api/stats`): Korea region has **10,522 active alerts against 341 tracked vessels** (~31 per vessel); ~4,500 events/24 h in `kr` alone. Aggregating the 1,000 most recent events (`/api/events?limit=1000`):

| Source | Share | Root cause |
|---|---|---|
| `ais_gap` | 41% | 1 h of silence fires regardless of cause. Terrestrial reception dropouts and vessels leaving the region bbox (our AISStream subscription boundary) are indistinguishable from "went dark". |
| `route_deviation`/course_reversals | 29% | COG is compass jitter below ~2 kn, so anchored/moored vessels "reverse course" all night. No exclusion-zone or activity check. |
| `route_deviation`/lane_deviation | 16% | `lanes.json` covers only 3 Taiwan Strait lanes but the check runs everywhere — every cargo ship in Tokyo Bay "deviates" from the Taiwan Strait lane. |
| `identity`/flag_mismatch | 5% | Single-letter callsign fallback `B → CN` mislabels Taiwanese `BP`/`BR` callsigns; placeholder callsign `"0"` fires `identity_change`. |

Structurally, every event feeds one additive score (`src/score.ts`, 24 h half-life), and `susScoreThreshold: 2` puts a vessel on the red trajectory layer after a single severity-2 misfire. Chronically noisy is indistinguishable from genuinely suspicious.

## 2. Decisions (from brainstorming)

| Question | Decision |
|---|---|
| End state | Explainable threat categories with confidence per vessel, not a raw anomaly firehose |
| Categories | `cable_interference`, `dark_activity`, `identity_deception` now; `militia_presence` phase 2 (interfaces defined now) |
| Architecture | Deterministic evidence fusion (approach A) — no statistical baselining this phase, no LLM narratives |
| Raw events in UI | Dossier-only evidence trail; map/feed driven by assessments |
| Harbor rule (user) | A vessel stopped in harbor is not suspicious — moored/anchored context suppresses route/speed/gap signals entirely |

## 3. Signal layer

### 3a. Vessel activity context

`AisPosition` gains `navStatus: number | null`, parsed from AISStream `PositionReport.NavigationalStatus` (0 = under way, 1 = at anchor, 5 = moored, 15 = undefined).

New pure helper `activityFor(s, msg, geo): Activity` in `src/geo/context.ts` or a new `src/activity.ts`:

- `moored` — navStatus 5, or SOG < `stationaryMaxSogKn` inside an exclusion polygon
- `anchored` — navStatus 1
- `stationary` — SOG < `stationaryMaxSogKn` (sustained over the last 3 ring positions) elsewhere
- `underway` — otherwise

Every `*OnMessage` detector receives the activity. **`moored` and `anchored` vessels produce no gap, route, or speed signals.** Loitering and anchor drag keep their own gates (below).

### 3b. Gap detector (`src/detectors/gap.ts`)

A gap only **opens** (`gapOnTick`) when all of:

1. Last-fix activity is not `moored`/`anchored` and last fix is outside exclusions (AIS off in port is routine).
2. Last fix is ≥ `gapBboxEdgeBufferM` inside the **outer boundary of the union of subscribed region bboxes** — silence after sailing off the subscription edge is coverage loss, not dark activity. (Edges shared between adjacent regions, e.g. `kr`/`jp` at lon 130, are interior and don't count.) If the last fix is within the buffer of the outer boundary, mark the vessel `leftCoverage` and fire nothing.
3. Reporting cadence was healthy: ≥ `gapMinPriorMessages` messages within `gapCadenceWindowMs` before the silence started.

On close (`gapOnMessage`) the event records `gapMs`, `distanceM` (repositioning), `impliedSpeedKn`, `startInCorridor`, `endInCorridor` (as today). These attributes drive fusion weighting (§4); the raw event itself no longer implies suspicion.

### 3c. Route detector (`src/detectors/route.ts`)

- Course reversals (6a) and circling (6b): skip any position pair where either SOG < `minSogForCogKn` (COG jitter), require activity `underway`, and require the current position outside exclusions.
- Lane deviation (6c): `data/lanes.json` gains a top-level `coverage` polygon (Taiwan Strait). `GeoContext` gains `inLaneCoverage(p)`. The check runs only when the vessel is inside coverage. Outside coverage: no opinion, no event.

### 3d. Identity detector (`src/detectors/identity.ts`)

- Remove the 1-char `"B" → "CN"` fallback from the `CALLSIGN` table; match only unambiguous 2-char prefixes. (Observed: Keelung pilot boats, MMSI 416xxxxxx with `BP`/`BR` callsigns, flagged severity 4.)
- Treat callsign `"0"`, `""`, and all-whitespace as unknown: no `identity_change` when the previous or new value is a placeholder, and no `flag_mismatch` on unknown.
- `identity_change` requires both previous and new values to be real (non-placeholder).

### 3e. Speed detector (`src/detectors/speed.ts`)

Require activity `underway` and outside exclusions. Logic otherwise unchanged; speed events become weak supporting evidence in fusion (§4).

### 3f. Loitering and anchor drag

Already corridor-gated. Additions:

- Loitering: a `moored` vessel is never a loiter candidate (navStatus check joins the existing `inExclusion` check).
- Anchor drag: require net displacement across the drag window ≥ `dragMinDisplacementM` — an anchored vessel with COG jitter at 0.3 kn but no movement is swinging on its chain, not dragging.

### 3g. Config additions (`src/config.ts`)

```
stationaryMaxSogKn: 0.5
minSogForCogKn: 2
gapBboxEdgeBufferM: 10_000
gapMinPriorMessages: 5
gapCadenceWindowMs: 3_600_000
dragMinDisplacementM: 150
```

## 4. Fusion layer (`src/fusion.ts`)

### 4a. Types (`src/types.ts`)

```typescript
export type ThreatCategory = "cable_interference" | "dark_activity" | "identity_deception" | "militia_presence"; // militia_presence: phase 2, no scorer yet

export interface EvidenceRef {
  eventId: string;
  type: EventType;
  kind: string | null;   // evidence.kind of the raw event
  weight: number;        // contribution after class + repetition scaling
  ts: number;
}

export interface ThreatAssessment {
  id: string;            // `${category}-${mmsi}-${openedTs}`
  mmsi: number;
  category: ThreatCategory;
  status: "open" | "closed";
  confidence: number;    // 0..1, derived from decayed score
  openedTs: number;
  updatedTs: number;
  closedTs: number | null;
  evidence: EvidenceRef[];
  narrative: string;
  region: RegionId | null;
  lastLon: number;
  lastLat: number;
}
```

`VesselState` replaces `score`/`scoreTs` with `categories: Record<ThreatCategory, { score: number; ts: number }>` and `assessments: Partial<Record<ThreatCategory, ThreatAssessment>>` (the open one per category, if any). Plus `navStatus: number | null` and `leftCoverage: boolean`.

### 4b. Weight table

Signal classes: **strong = 1.0**, **medium = 0.45**, **weak = 0.15**.

| Signal (event type / kind + context) | Category(ies) | Class |
|---|---|---|
| `anchor_drag` (always in corridor) | cable_interference | strong |
| `loitering` closed with duration ≥ 2 h (in corridor by construction) | cable_interference | medium |
| `ais_gap` closed, `startInCorridor \|\| endInCorridor` | cable_interference AND dark_activity | medium each |
| `ais_gap` closed, repositioning > `darkRepositionMinM` (5 nm) | dark_activity | medium |
| `ais_gap` closed, `impliedSpeedKn > impossibleSpeedKn` | dark_activity | medium |
| `identity` / `teleport` | dark_activity | medium |
| `identity` / `identity_change` (real values, activity `underway`) | identity_deception | medium |
| `identity` / `identity_change` while moored/anchored | identity_deception | weak (port re-registration is common) |
| `identity` / `flag_mismatch` | identity_deception | weak |
| `speed_anomaly` (any kind), in corridor | cable_interference | weak |
| `route_deviation` (any kind), in corridor | cable_interference | weak |
| `speed_anomaly` / `route_deviation`, outside corridor | none (raw event only) | — |
| `ais_gap` closed, none of the above attributes | none (telemetry) | — |

**One weight per category per event:** when an event matches multiple table rows for the same category (e.g. a gap that is both in-corridor and >5 nm repositioning), it contributes the single highest matching class weight to that category — never a sum.

**Repetition damping:** evidence repeating a `(type, kind)` that already contributed to the same category within the last 24 h (one half-life) contributes 25% of its class weight. This is tracked in the per-category state, so it applies both before an assessment opens and within one. Four flag mismatches ≈ 0.26, not 0.60 — a repeated weak signal can never open an assessment by itself.

### 4c. Scoring and lifecycle

Per (vessel, category): `score = decayedScore(score, ts, now, scoreHalfLifeMs) + weight` — reusing `src/score.ts` decay math with the existing 24 h half-life, per category.

- **Open** when `score ≥ assessmentOpenScore` (0.6). One strong opens alone; one medium (0.45) does not; two mediums do; medium + weak does; repeated weak signals cannot (damping).
- **Confidence** `= min(1, score / 2)`.
- **Update** on each new evidence: append `EvidenceRef`, recompute confidence and narrative, bump `updatedTs`.
- **Close** when decayed score has been < `assessmentCloseScore` (0.2) continuously for `assessmentCloseAfterMs` (12 h) — evaluated in `Tracker.tick()`. Closed assessments persist to D1 for history; a later re-open creates a new assessment id.

Config: `assessmentOpenScore: 0.6`, `assessmentCloseScore: 0.2`, `assessmentCloseAfterMs: 43_200_000`, `darkRepositionMinM: 9_260`.

### 4d. Pipeline integration (`src/pipeline.ts`)

`applyEventToScore` is removed. `handlePosition`/`handleStatic`/`tick` route raw events through `fusion.applyEvent(s, ev, ctx, now)`, which returns assessment changes (`opened | updated | closed`) so `TrackerDO` can persist them. Raw events still persist to D1 unchanged.

### 4e. Narrative templates

Deterministic assembly from the evidence list: one clause per evidence item in time order, joined with "then", using formatted duration/distance/corridor names. Examples:

- `cable_interference`: "Loitered 3.2 h over Trans-Pacific Express corridor, then went dark 2.1 h and reappeared 8 nm away."
- `dark_activity`: "AIS silent 2.1 h with 8 nm repositioning; position jump implies 62 kn."
- `identity_deception`: "Name changed underway (PILOT BOAT → YONG AN); callsign country (CN) conflicts with MMSI flag (TW)."

Same evidence list ⇒ same string, every replay. Clause templates live beside the weight table in `src/fusion.ts`.

### 4f. Phase-2 interface

`fusion.ts` exposes `interface CategoryScorer { category: ThreatCategory; applyEvent(...): void; tick(...): void }` and registers the three phase-1 scorers in a list. Militia/presence baselining (phase 2) plugs in as a fourth `CategoryScorer` fed by longer-horizon aggregates; the assessments table, API, and frontend are category-agnostic and need no changes.

## 5. Persistence

New migration `migrations/0004_assessments.sql`:

```sql
CREATE TABLE assessments (
  id TEXT PRIMARY KEY,
  mmsi INTEGER NOT NULL,
  category TEXT NOT NULL,
  status TEXT NOT NULL,           -- 'open' | 'closed'
  confidence REAL NOT NULL,
  opened_ts INTEGER NOT NULL,
  updated_ts INTEGER NOT NULL,
  closed_ts INTEGER,
  region TEXT,
  narrative TEXT NOT NULL,
  evidence TEXT NOT NULL          -- JSON EvidenceRef[]
);
CREATE INDEX idx_assessments_status_region ON assessments (status, region, updated_ts);
CREATE INDEX idx_assessments_mmsi ON assessments (mmsi, updated_ts);
```

`events` table unchanged. TrackerDO persists assessments on open/close and throttles update writes to one per `persistMinIntervalMs` per assessment.

## 6. API

- **New** `GET /api/assessments?region=&window=` — open assessments plus those closed within the window; primary feed payload.
- `/api/snapshot` — each vessel gains `assessments: [{ category, confidence }]` (open only). The legacy `score` field is served as `max(confidence) * 5` during the transition and removed once the frontend ships (same change set; the field is kept only so a cached frontend doesn't break mid-deploy).
- `/api/vessel/:mmsi` — dossier returns `assessments` (open + closed history) and the raw event timeline; each assessment's evidence links to event ids in the timeline.
- `/api/stats` — `activeAlerts` becomes the count of open assessments; histogram counts assessments by category per day (replacing severity buckets).
- `/api/trajectories` — selects vessels with an open assessment instead of `score ≥ susScoreThreshold`; `susScoreThreshold` config is removed.

## 7. Frontend (`web/`)

- **Feed:** lists assessments — category badge, confidence bar, one-line narrative, evidence count. Filter chips become category chips: `All | Cable | Dark | Identity` (single-select, URL-hash persisted, same pattern as today).
- **Map:** vessel halo color/intensity from the highest-confidence open assessment (category → hue, confidence → intensity). Red pulsing halo requires an open assessment, not raw events. Sus-trajectory layer keyed to open assessments.
- **Dossier:** assessment cards (narrative + confidence + category) at top; raw event timeline below as the evidence trail; clicking evidence in a card scrolls to the raw event. Raw events appear nowhere else in the UI.

## 8. Testing

Unit tests (Vitest) per §3 rule and per fusion rule; end-to-end replay via the existing `src/replay-core.ts` harness. Noise regressions (all derived from observed live false positives):

- Moored ferry (navStatus 5) with COG jitter overnight → zero route/gap signals, no assessment.
- Cargo ship transiting Tokyo Bay (outside lane coverage) → no lane_deviation event.
- Vessel exits region bbox and falls silent → no gap opens (`leftCoverage`).
- Vessel in port with AIS off 8 h, resumes at berth → no gap opens.
- Keelung pilot boat, MMSI 416xxxxxx, callsign `BP3085`, prev callsign `"0"` → no identity events.
- Four flag-mismatch events on one vessel → identity_deception never opens (repetition damping).

True-positive path:

- Loiter 3 h over corridor, then dark gap with 8 nm repositioning → `cable_interference` opens with 2 evidence refs (loiter medium + gap medium = 0.9) and the expected narrative string. `dark_activity` accumulates a single medium (0.45, max-per-category rule) and does **not** open — one uncorroborated dark signal is not an alert.
- Same scenario plus a teleport event → `dark_activity` opens (0.45 + 0.45 = 0.9, two independent signal types).
- Anchor drag in corridor → `cable_interference` opens immediately (strong class).
- Assessment decays below 0.2 and stays there 12 h → closes; new evidence later opens a new assessment id.

## 9. Success criteria

- Open assessments per region in the **tens**, not thousands (today: 10,522 in `kr`).
- Every red vessel on the map has a human-readable narrative a user can evaluate.
- Replay of a captured live day produces assessments only for vessels a human reviewer would agree warrant a look.

## 10. Out of scope (this phase)

- Militia/presence baselining and any per-cell statistical machinery (phase 2, plugs into §4f).
- Cross-vessel correlation (rendezvous/STS, convoy).
- Expanding `exclusions.json` polygon coverage (navStatus carries most of the harbor context; polygons can be enriched independently).
- LLM-generated narratives.
