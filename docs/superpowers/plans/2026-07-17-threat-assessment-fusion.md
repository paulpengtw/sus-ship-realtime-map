# Threat Assessment Fusion Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the noisy single-score anomaly firehose with per-vessel, per-category threat assessments (cable_interference / dark_activity / identity_deception) built from context-gated detector signals and deterministic evidence fusion.

**Architecture:** Two layers. Signal layer: existing detectors gain activity context (AIS navStatus + exclusion zones) and targeted gating fixes so harbor traffic, reception dropouts, and out-of-coverage checks stop firing. Fusion layer: raw events map to weighted signals per category; a per-(vessel, category) score with 24 h half-life decay opens/updates/closes `ThreatAssessment` objects with an evidence list and templated narrative. Map, feed, and stats are driven by open assessments; raw events survive only as the dossier evidence trail.

**Tech Stack:** Cloudflare Workers + Durable Object + D1 (SQLite), TypeScript, Vitest with `@cloudflare/vitest-pool-workers`, MapLibre GL frontend built with Vite.

**Spec:** `docs/superpowers/specs/2026-07-17-threat-assessment-fusion-design.md`

## Global Constraints

- All thresholds live in `src/config.ts` (existing convention). New keys and exact values: `stationaryMaxSogKn: 0.5`, `minSogForCogKn: 2`, `gapBboxEdgeBufferM: 10_000`, `gapMinPriorMessages: 5`, `gapCadenceWindowMs: 3_600_000`, `dragMinDisplacementM: 150`, `assessmentOpenScore: 0.6`, `assessmentCloseScore: 0.2`, `assessmentCloseAfterMs: 43_200_000`, `darkRepositionMinM: 9_260`. Remove `susScoreThreshold`.
- Signal class weights: strong = 1.0, medium = 0.45, weak = 0.15. Repetition damping factor = 0.25. Confidence = `Math.min(1, score / 2)` rounded to 2 decimals.
- Category order is a wire contract (stats histogram index): `["cable_interference", "dark_activity", "identity_deception", "militia_presence"]` — exported as `THREAT_CATEGORIES` in `src/types.ts`; `militia_presence` has no scorer this phase but exists in the enum.
- Category colors (frontend, used by feed badges, map, timeline): cable_interference `#e5484d`, dark_activity `#b18cff`, identity_deception `#f0a83c`, militia_presence `#4cc3ff`.
- Detectors keep their signatures `(s, msg, geo, cfg)` and keep emitting raw `AnomalyEvent`s to D1. Only the score wiring changes.
- Score decay math (`decayedScore` in `src/score.ts`) is reused per category; `applyEventToScore` is deleted.
- Run tests with `npx vitest run <file>`; full suite `npm test`; type check `npx tsc -p tsconfig.json --noEmit`.
- Commit after every task (messages given per task).

## File Structure

| File | Status | Responsibility |
|---|---|---|
| `src/types.ts` | modify | `navStatus` on positions; `ThreatCategory`/`EvidenceRef`/`ThreatAssessment`/`CategoryState`; VesselState swaps `score` for `categories`+`assessments` |
| `src/activity.ts` | create | Activity classification (moored/anchored/stationary/underway) |
| `src/fusion.ts` | create | Signal weight table, clause templates, score accumulation, assessment lifecycle |
| `src/aisstream.ts` | modify | Parse `NavigationalStatus` |
| `src/geo/regions.ts` | modify | `nearCoverageEdge()` — outer boundary of the union of region bboxes |
| `src/geo/context.ts` | modify | Split lane LineStrings from coverage Polygons; `inLaneCoverage()` |
| `data/lanes.json` | modify | Add Taiwan Strait coverage polygon |
| `src/detectors/{gap,route,speed,loitering,anchorDrag,identity}.ts` | modify | Context gating per spec §3 |
| `src/pipeline.ts` | modify | Route events into fusion; `drainChangedAssessments()` |
| `src/replay-core.ts` | modify | Return assessments alongside events |
| `src/score.ts` | modify | Delete `applyEventToScore` |
| `migrations/0004_assessments.sql` | create | `assessments` table |
| `src/db.ts` | modify | Persist assessments; hydrate open assessments; legacy `vessels.score` write |
| `src/do/tracker.ts` | modify | Drain + persist assessments each alarm; hydrate on start |
| `src/worker.ts` | modify | `/api/assessments`; snapshot/vessel/stats/trajectories reshaped |
| `web/src/assess.ts` | create | Category labels/colors, assessment card rendering (pure, testable) |
| `web/src/{api,panels,vessels,trajectories,stats,timeline}.ts` | modify | Assessment-driven UI |

---

### Task 1: Parse `navStatus` from AIS position reports

**Files:**
- Modify: `src/types.ts:3-25`
- Modify: `src/aisstream.ts:21-35`
- Test: `test/navstatus.test.ts` (create)

**Interfaces:**
- Consumes: nothing new.
- Produces: `AisPosition.navStatus?: number | null` (optional so existing test fixtures compile; parser always sets it; 0–15 valid, else `null`). Also fixes the duplicate `shipType` property in `AisIdentity`.

- [ ] **Step 1: Write the failing test**

```typescript
// test/navstatus.test.ts
import { describe, expect, it } from "vitest";
import { parseAisStreamMessage } from "../src/aisstream";

const frame = (navStatus: unknown) => ({
  MessageType: "PositionReport",
  MetaData: { MMSI: 416001234, latitude: 25.1, longitude: 121.7, time_utc: "2026-07-17 01:02:03.000000 +0000 UTC" },
  Message: { PositionReport: { Sog: 0.1, Cog: 45, TrueHeading: 511, NavigationalStatus: navStatus } },
});

describe("navStatus parsing", () => {
  it("extracts moored (5) and at-anchor (1)", () => {
    expect(parseAisStreamMessage(frame(5))!.pos!.navStatus).toBe(5);
    expect(parseAisStreamMessage(frame(1))!.pos!.navStatus).toBe(1);
    expect(parseAisStreamMessage(frame(0))!.pos!.navStatus).toBe(0);
  });

  it("treats missing or out-of-range values as null", () => {
    expect(parseAisStreamMessage(frame(undefined))!.pos!.navStatus).toBeNull();
    expect(parseAisStreamMessage(frame(99))!.pos!.navStatus).toBeNull();
    expect(parseAisStreamMessage(frame("x"))!.pos!.navStatus).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/navstatus.test.ts`
Expected: FAIL — `navStatus` is `undefined` (property does not exist yet).

- [ ] **Step 3: Implement**

In `src/types.ts`, add to `AisPosition` (after `heading`):

```typescript
  navStatus?: number | null; // AIS NavigationalStatus: 0 under way, 1 at anchor, 5 moored; null = unknown
```

Also fix the duplicate field in `AisIdentity` — it currently declares `shipType` twice (lines 17 and 19). Delete the second, optional declaration (`shipType?: number | null;`), keep `shipType: number | null;`.

In `src/aisstream.ts`, inside the `PositionReport` branch, before `return`:

```typescript
      const ns = Number(pr.NavigationalStatus);
```

and add to the returned `pos` object (after `heading`):

```typescript
          navStatus: Number.isInteger(ns) && ns >= 0 && ns <= 15 ? ns : null,
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/navstatus.test.ts test/aisstream.test.ts test/frame-decode.test.ts`
Expected: PASS (all).

- [ ] **Step 5: Commit**

```bash
git add src/types.ts src/aisstream.ts test/navstatus.test.ts
git commit -m "feat: parse AIS NavigationalStatus into AisPosition.navStatus"
```

---

### Task 2: Activity classification (`src/activity.ts`)

**Files:**
- Create: `src/activity.ts`
- Modify: `src/config.ts:24` (add key)
- Test: `test/activity.test.ts` (create)

**Interfaces:**
- Consumes: `AisPosition.navStatus` (Task 1), `GeoContext.inExclusion`.
- Produces:
  - `type Activity = "moored" | "anchored" | "stationary" | "underway"`
  - `classifyActivity(navStatus: number | null, sogKn: number, inExclusion: boolean, sustained: boolean, cfg: Config): Activity`
  - `activityFor(s: VesselState, msg: AisPosition, geo: GeoContext, cfg: Config): Activity` — for `*OnMessage` detectors (msg not yet in ring)
  - `lastActivity(s: VesselState, geo: GeoContext, cfg: Config): Activity` — for tick-time checks (gap detector)
  - Config key `stationaryMaxSogKn: 0.5`

- [ ] **Step 1: Add config key**

In `src/config.ts`, after `corridorBufferM: 1000,` add:

```typescript
  stationaryMaxSogKn: 0.5,
```

- [ ] **Step 2: Write the failing test**

```typescript
// test/activity.test.ts
import { describe, expect, it } from "vitest";
import { CONFIG } from "../src/config";
import { GeoContext } from "../src/geo/context";
import { newVesselState, type AisPosition } from "../src/types";
import { activityFor, classifyActivity, lastActivity } from "../src/activity";

const excl = { type: "FeatureCollection", features: [{ type: "Feature", properties: { name: "PORT" }, geometry: { type: "Polygon", coordinates: [[[121.6, 25.0], [121.8, 25.0], [121.8, 25.2], [121.6, 25.2], [121.6, 25.0]]] } }] };
const noFc = { type: "FeatureCollection", features: [] };
const geo = new GeoContext(noFc as any, excl as any, 1000, noFc as any, 5000);
const T0 = 1_750_000_000_000;

const pos = (lon: number, lat: number, sog: number, tMin: number, navStatus: number | null = null): AisPosition =>
  ({ mmsi: 1, lon, lat, sog, cog: 0, heading: null, navStatus, ts: T0 + tMin * 60_000 });

describe("activity classification", () => {
  it("navStatus 5 is moored and 1 is anchored regardless of position", () => {
    expect(classifyActivity(5, 3, false, false, CONFIG)).toBe("moored");
    expect(classifyActivity(1, 0.2, false, false, CONFIG)).toBe("anchored");
  });

  it("slow inside an exclusion zone is moored even without navStatus", () => {
    expect(classifyActivity(null, 0.2, true, false, CONFIG)).toBe("moored");
  });

  it("sustained slow outside exclusions is stationary; moving is underway", () => {
    expect(classifyActivity(null, 0.2, false, true, CONFIG)).toBe("stationary");
    expect(classifyActivity(null, 0.2, false, false, CONFIG)).toBe("underway"); // single slow fix — not yet sustained
    expect(classifyActivity(0, 8, false, false, CONFIG)).toBe("underway");
  });

  it("activityFor uses ring + incoming message for the sustained check", () => {
    const s = newVesselState(1, T0);
    s.ring.push(pos(120, 22, 0.2, 0), pos(120, 22, 0.3, 5));
    expect(activityFor(s, pos(120, 22, 0.1, 10), geo, CONFIG)).toBe("stationary");
    // one fast fix in the window breaks "sustained"
    const s2 = newVesselState(2, T0);
    s2.ring.push(pos(120, 22, 5, 0), pos(120, 22, 0.3, 5));
    expect(activityFor(s2, pos(120, 22, 0.1, 10), geo, CONFIG)).toBe("underway");
  });

  it("lastActivity reads the last ring fix (moored in port)", () => {
    const s = newVesselState(3, T0);
    s.ring.push(pos(121.7, 25.1, 0.1, 0), pos(121.7, 25.1, 0.1, 5), pos(121.7, 25.1, 0.1, 10));
    expect(lastActivity(s, geo, CONFIG)).toBe("moored"); // inside exclusion polygon
    expect(lastActivity(newVesselState(4, T0), geo, CONFIG)).toBe("underway"); // empty ring
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run test/activity.test.ts`
Expected: FAIL — module `src/activity.ts` not found.

- [ ] **Step 4: Implement `src/activity.ts`**

```typescript
// src/activity.ts — vessel activity context (spec §3a). Moored/anchored vessels are not suspects.
import type { Config } from "./config";
import type { GeoContext } from "./geo/context";
import type { LngLat } from "./geo/geo";
import type { AisPosition, VesselState } from "./types";

export type Activity = "moored" | "anchored" | "stationary" | "underway";

export function classifyActivity(navStatus: number | null, sogKn: number, inExclusion: boolean, sustained: boolean, cfg: Config): Activity {
  if (navStatus === 5) return "moored";
  if (navStatus === 1) return "anchored";
  if (sogKn < cfg.stationaryMaxSogKn) {
    if (inExclusion) return "moored";
    if (sustained) return "stationary";
  }
  return "underway";
}

// Sustained = the last 3 known fixes (including msg when given) are all below the threshold.
function sustainedSlow(s: VesselState, msg: AisPosition | null, cfg: Config): boolean {
  const window = msg ? [...s.ring.slice(-2), msg] : s.ring.slice(-3);
  return window.length >= 3 && window.every((p) => p.sog < cfg.stationaryMaxSogKn);
}

export function activityFor(s: VesselState, msg: AisPosition, geo: GeoContext, cfg: Config): Activity {
  const p: LngLat = [msg.lon, msg.lat];
  return classifyActivity(msg.navStatus ?? null, msg.sog, geo.inExclusion(p), sustainedSlow(s, msg, cfg), cfg);
}

export function lastActivity(s: VesselState, geo: GeoContext, cfg: Config): Activity {
  const lp = s.ring.length ? s.ring[s.ring.length - 1] : null;
  if (!lp) return "underway";
  const p: LngLat = [lp.lon, lp.lat];
  return classifyActivity(lp.navStatus ?? null, lp.sog, geo.inExclusion(p), sustainedSlow(s, null, cfg), cfg);
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run test/activity.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/activity.ts src/config.ts test/activity.test.ts
git commit -m "feat: activity classification from navStatus/SOG/exclusion context"
```

---

### Task 3: Geo groundwork — coverage-edge check and lane coverage polygon

**Files:**
- Modify: `src/geo/regions.ts`
- Modify: `src/geo/context.ts`
- Modify: `data/lanes.json`
- Modify: `src/config.ts` (add `gapBboxEdgeBufferM`)
- Test: `test/coverage.test.ts` (create), `test/lanes.test.ts` (extend)

**Interfaces:**
- Consumes: `CONFIG.regions`, `pointInPolygon`.
- Produces:
  - `nearCoverageEdge(lon: number, lat: number, bufferM: number): boolean` in `src/geo/regions.ts` — true when the point is outside all region bboxes OR within `bufferM` of the outer boundary of their union (probe method: a point `bufferM` away in any cardinal direction falls outside all bboxes).
  - `GeoContext.inLaneCoverage(p: LngLat): boolean` — true inside any Polygon feature bundled in the lanes FeatureCollection. `nearestLane`/`inLane` now ignore non-LineString features.
  - Config key `gapBboxEdgeBufferM: 10_000`.
  - `data/lanes.json` gains one Polygon feature named `"Taiwan Strait lane coverage"`.

- [ ] **Step 1: Add config key**

In `src/config.ts`, after `gapMinMs`, add:

```typescript
  gapBboxEdgeBufferM: 10_000,
```

- [ ] **Step 2: Write the failing tests**

```typescript
// test/coverage.test.ts
import { describe, expect, it } from "vitest";
import { nearCoverageEdge } from "../src/geo/regions";

describe("nearCoverageEdge", () => {
  it("deep inside the tw bbox is not near an edge", () => {
    expect(nearCoverageEdge(120.5, 23.5, 10_000)).toBe(false);
  });

  it("within 10 km of the outer western tw edge is near", () => {
    expect(nearCoverageEdge(118.05, 23.5, 10_000)).toBe(true); // tw minLon = 118.0, ~5 km away
  });

  it("outside all bboxes counts as near (no coverage at all)", () => {
    expect(nearCoverageEdge(150.0, 10.0, 10_000)).toBe(true);
  });

  it("the interior kr/jp boundary at lon 130 is NOT an outer edge", () => {
    expect(nearCoverageEdge(129.99, 34.5, 10_000)).toBe(false); // probe east lands in jp
  });
});
```

Append to `test/lanes.test.ts` inside the existing `describe` (the fixture `lanes` const stays as-is):

```typescript
  it("inLaneCoverage is false when the FC has no coverage polygon", () => {
    expect(geo.inLaneCoverage([120.0, 23.0])).toBe(false);
  });

  it("inLaneCoverage respects a Polygon feature; lanes still resolve", () => {
    const withCoverage = {
      type: "FeatureCollection",
      features: [
        ...lanes.features,
        { type: "Feature", properties: { name: "coverage" }, geometry: { type: "Polygon", coordinates: [[[119.0, 22.5], [121.0, 22.5], [121.0, 23.5], [119.0, 23.5], [119.0, 22.5]]] } },
      ],
    };
    const g = new GeoContext(cables as any, exclusions as any, 1000, withCoverage as any, 5000);
    expect(g.inLaneCoverage([120.0, 23.0])).toBe(true);
    expect(g.inLaneCoverage([125.0, 30.0])).toBe(false);
    expect(g.nearestLane([120.0, 23.0])?.name).toBe("TEST-LANE"); // polygon ignored by lane matching
  });

  it("bundled lanes.json contains a coverage polygon over the Taiwan Strait", () => {
    const g = new GeoContext();
    expect(g.inLaneCoverage([120.0, 24.0])).toBe(true);   // mid-strait
    expect(g.inLaneCoverage([139.7, 35.4])).toBe(false);  // Tokyo Bay — the live false-positive site
  });
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `npx vitest run test/coverage.test.ts test/lanes.test.ts`
Expected: FAIL — `nearCoverageEdge` and `inLaneCoverage` do not exist.

- [ ] **Step 4: Implement**

Append to `src/geo/regions.ts`:

```typescript
const M_PER_DEG_LAT = 111_320;

// True when (lon, lat) is outside every region bbox, or within bufferM of the OUTER
// boundary of their union (spec §3b): probe bufferM in each cardinal direction; if any
// probe leaves all bboxes, the point is near an edge beyond which we have no AIS coverage.
// Edges shared between adjacent regions (kr/jp at lon 130) are interior: the probe lands
// in the neighboring bbox and does not trigger.
export function nearCoverageEdge(lon: number, lat: number, bufferM: number): boolean {
  if (regionForPoint(lon, lat) === null) return true;
  const dLat = bufferM / M_PER_DEG_LAT;
  const dLon = bufferM / (M_PER_DEG_LAT * Math.max(0.2, Math.cos((lat * Math.PI) / 180)));
  const probes: [number, number][] = [[lon - dLon, lat], [lon + dLon, lat], [lon, lat - dLat], [lon, lat + dLat]];
  return probes.some(([plon, plat]) => regionForPoint(plon, plat) === null);
}
```

In `src/geo/context.ts`, replace the class-private lane handling. Change the constructor and add the split + new method:

```typescript
export class GeoContext {
  private laneLines: LineFeature[];
  private laneCoverage: PolyFeature[];

  constructor(
    private cables: FC<LineFeature> = cablesData as unknown as FC<LineFeature>,
    private exclusions: FC<PolyFeature> = exclusionsData as unknown as FC<PolyFeature>,
    private bufferM: number = CONFIG.corridorBufferM,
    lanes: FC<LineFeature | PolyFeature> = lanesData as unknown as FC<LineFeature | PolyFeature>,
    private laneBufferM: number = CONFIG.laneBufferM,
  ) {
    this.laneLines = lanes.features.filter((f): f is LineFeature => f.geometry.type === "LineString");
    this.laneCoverage = lanes.features.filter((f): f is PolyFeature => f.geometry.type === "Polygon");
  }
```

Update `nearestLane` to iterate `this.laneLines` instead of `this.lanes.features`, and add after `inLane`:

```typescript
  // Lane opinion is only valid where we actually have lane data (spec §3c).
  inLaneCoverage(p: LngLat): boolean {
    return this.laneCoverage.some((f) => pointInPolygon(p, f.geometry.coordinates[0]));
  }
```

In `data/lanes.json`, add this feature to the `features` array (keep the three existing LineStrings):

```json
{
  "type": "Feature",
  "properties": { "name": "Taiwan Strait lane coverage" },
  "geometry": { "type": "Polygon", "coordinates": [[[118.0, 21.5], [122.5, 21.5], [122.5, 26.0], [118.0, 26.0], [118.0, 21.5]]] }
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run test/coverage.test.ts test/lanes.test.ts test/geo.test.ts test/context.test.ts`
Expected: PASS (all).

- [ ] **Step 6: Commit**

```bash
git add src/geo/regions.ts src/geo/context.ts data/lanes.json src/config.ts test/coverage.test.ts test/lanes.test.ts
git commit -m "feat: coverage-edge check + lane coverage polygon (lane checks only where data exists)"
```

---

### Task 4: Gap detector gating

**Files:**
- Modify: `src/detectors/gap.ts:13-29`
- Modify: `src/types.ts` (`VesselState.leftCoverage`), `src/config.ts` (cadence keys), `src/pipeline.ts:53` (clear flag)
- Test: `test/gap.test.ts` (update + extend)

**Interfaces:**
- Consumes: `lastActivity` (Task 2), `nearCoverageEdge` (Task 3).
- Produces: `gapOnTick` only opens a gap when the vessel was underway/stationary outside exclusions, ≥ `gapBboxEdgeBufferM` inside the coverage union, and had ≥ `gapMinPriorMessages` ring fixes within `gapCadenceWindowMs` before going quiet. New `VesselState.leftCoverage: boolean` (set on edge suppression, cleared on next message). `gapOnMessage` unchanged.

- [ ] **Step 1: Add config keys and state field**

`src/config.ts`, after `gapBboxEdgeBufferM`:

```typescript
  gapMinPriorMessages: 5,
  gapCadenceWindowMs: 3_600_000,
```

`src/types.ts` `VesselState`: add after `gapOpenSince`:

```typescript
  leftCoverage: boolean;
```

and in `newVesselState` after `gapOpenSince: null,`:

```typescript
    leftCoverage: false,
```

- [ ] **Step 2: Update the existing tests (cadence-compatible seeds) and add gating tests**

In `test/gap.test.ts`, replace the `seed` helper so every vessel has a healthy 5-message cadence (existing assertions keep working — positions are interior to the `tw` bbox):

```typescript
function seed(mmsi: number, lon: number, lat: number) {
  const s = newVesselState(mmsi, T0);
  for (let i = 4; i >= 0; i--) {
    s.ring.push({ mmsi, lon, lat, sog: 5, cog: 90, heading: 90, ts: T0 - i * 10 * 60_000 });
  }
  s.lastSeen = T0;
  return s;
}
```

Append these tests inside the `describe` block:

```typescript
  it("does NOT open for a moored vessel (navStatus 5)", () => {
    const s = seed(6, 120.5, 22.0);
    for (const p of s.ring) p.navStatus = 5;
    expect(gapOnTick(s, geo, CONFIG, T0 + 2 * HOUR)).toHaveLength(0);
  });

  it("does NOT open near the outer coverage edge; marks leftCoverage", () => {
    const s = seed(7, 118.05, 22.0); // ~5 km from tw minLon 118.0
    expect(gapOnTick(s, geo, CONFIG, T0 + 2 * HOUR)).toHaveLength(0);
    expect(s.leftCoverage).toBe(true);
  });

  it("does NOT open when prior cadence was sparse (reception was already bad)", () => {
    const s = newVesselState(8, T0);
    s.ring.push({ mmsi: 8, lon: 120.5, lat: 22.0, sog: 5, cog: 90, heading: 90, ts: T0 - 2 * HOUR });
    s.ring.push({ mmsi: 8, lon: 120.5, lat: 22.0, sog: 5, cog: 90, heading: 90, ts: T0 });
    s.lastSeen = T0;
    expect(gapOnTick(s, geo, CONFIG, T0 + 2 * HOUR)).toHaveLength(0);
  });

  it("does NOT open when the last fix was inside an exclusion zone", () => {
    const exclGeo = new GeoContext(cables as any, {
      type: "FeatureCollection",
      features: [{ type: "Feature", properties: { name: "PORT" }, geometry: { type: "Polygon", coordinates: [[[120.4, 21.9], [120.6, 21.9], [120.6, 22.1], [120.4, 22.1], [120.4, 21.9]]] } }],
    } as any, 1000);
    const s = seed(9, 120.5, 22.0);
    expect(gapOnTick(s, exclGeo, CONFIG, T0 + 2 * HOUR)).toHaveLength(0);
  });
```

- [ ] **Step 3: Run tests to verify the new ones fail**

Run: `npx vitest run test/gap.test.ts`
Expected: original 5 tests PASS (seed change is compatible); the 4 new tests FAIL (gaps still open).

- [ ] **Step 4: Implement gating in `src/detectors/gap.ts`**

Add imports:

```typescript
import { lastActivity } from "../activity";
import { nearCoverageEdge } from "../geo/regions";
```

In `gapOnTick`, after the `if (now - s.lastSeen < cfg.gapMinMs) return [];` line and before `s.gapOpenSince = s.lastSeen;`, insert:

```typescript
  // Spec §3b: silence only counts when it *could* be deliberate.
  const act = lastActivity(s, geo, cfg);
  if (act === "moored" || act === "anchored") return [];
  if (geo.inExclusion([lp.lon, lp.lat])) return [];
  if (nearCoverageEdge(lp.lon, lp.lat, cfg.gapBboxEdgeBufferM)) {
    s.leftCoverage = true;
    return [];
  }
  const cadence = s.ring.filter((p) => p.ts >= s.lastSeen - cfg.gapCadenceWindowMs).length;
  if (cadence < cfg.gapMinPriorMessages) return [];
```

In `src/pipeline.ts` `handlePosition`, add as the first line of the method body (a fresh message means the vessel is back in coverage):

```typescript
    const s = this.state(msg.mmsi, msg.ts);
    s.leftCoverage = false;
```

(The `const s = ...` line already exists — only add the `leftCoverage` reset under it.)

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run test/gap.test.ts test/pipeline.test.ts`
Expected: gap tests PASS. `pipeline.test.ts` — the test `"tick() opens gaps for silent vessels"` now FAILS (single-fix vessel no longer passes the cadence gate). Fix it by feeding a healthy cadence; replace that test with:

```typescript
  it("tick() opens gaps for silent vessels with healthy prior cadence", () => {
    const t = new Tracker(geo, CONFIG);
    for (let m = 0; m <= 40; m += 10) t.handlePosition(pos(2, 120.5, 22.0, 5, m));
    const evs = t.tick(T0 + (40 + 90) * 60_000);
    expect(evs).toHaveLength(1);
    expect(evs[0].type).toBe("ais_gap");
  });
```

Run again: `npx vitest run test/gap.test.ts test/pipeline.test.ts` → PASS.

- [ ] **Step 6: Commit**

```bash
git add src/detectors/gap.ts src/types.ts src/config.ts src/pipeline.ts test/gap.test.ts test/pipeline.test.ts
git commit -m "feat: gap detector requires underway context, interior coverage, healthy cadence"
```

---

### Task 5: Route detector gating

**Files:**
- Modify: `src/detectors/route.ts`
- Modify: `src/config.ts` (add `minSogForCogKn`)
- Test: `test/route.test.ts` (update fixture + extend)

**Interfaces:**
- Consumes: `activityFor` (Task 2), `GeoContext.inLaneCoverage` (Task 3).
- Produces: `routeOnMessage` gains: moored/anchored → no events at all; reversals count only pairs where both fixes have `sog >= minSogForCogKn` and current position is outside exclusions; circling requires every window fix `sog >= minSogForCogKn` and outside exclusions; lane deviation requires `geo.inLaneCoverage(p)`.

- [ ] **Step 1: Add config key**

`src/config.ts`, after `stationaryMaxSogKn`:

```typescript
  minSogForCogKn: 2,
```

- [ ] **Step 2: Update fixture and add failing tests**

In `test/route.test.ts`, replace the `lanes` const so lane tests sit inside coverage (existing lane tests keep passing):

```typescript
const lanes = { type: "FeatureCollection", features: [
  { type: "Feature", properties: { name: "MAIN-LANE" }, geometry: { type: "LineString", coordinates: [[119.5, 23.0], [120.5, 23.0]] } },
  { type: "Feature", properties: { name: "coverage" }, geometry: { type: "Polygon", coordinates: [[[118.5, 21.5], [121.5, 21.5], [121.5, 25.5], [118.5, 25.5], [118.5, 21.5]]] } },
] };
```

Append new tests inside the `describe`:

```typescript
  it("anchored vessel with COG jitter does NOT fire course_reversals", () => {
    const s = newVesselState(20, T0);
    const geo = makeGeo();
    const cogs = [0, 180, 0, 180, 0, 180, 0, 180, 0, 180, 0, 180, 0, 180, 0];
    const positions = cogs.map((cog, i) => {
      const p = pos(20, 120.2, 22.5, 0.3, cog, i * 5);
      p.navStatus = 1; // at anchor
      return p;
    });
    expect(feedPositions(s, positions, geo)).toHaveLength(0);
  });

  it("low-SOG COG pairs are skipped (drifting jitter, no navStatus)", () => {
    const s = newVesselState(21, T0);
    const geo = makeGeo();
    // sog 1 kn < minSogForCogKn — COG is compass noise
    const cogs = [0, 180, 0, 180, 90, 90, 90, 90, 90, 90, 90, 90, 90, 90, 90];
    const positions = cogs.map((cog, i) => pos(21, 120.2, 22.5, 1, cog, i * 5));
    expect(feedPositions(s, positions, geo).filter((e: any) => e.evidence.kind === "course_reversals")).toHaveLength(0);
  });

  it("course reversals inside an exclusion zone do NOT fire (harbor maneuvering)", () => {
    const s = newVesselState(22, T0);
    const geo = makeGeo(exclWithZone);
    const cogs = [0, 180, 0, 180, 90, 90, 90, 90, 90, 90, 90, 90, 90, 90, 90];
    const positions = cogs.map((cog, i) => pos(22, 119.0, 25.0, 8, cog, i * 5)); // inside PORT polygon
    expect(feedPositions(s, positions, geo)).toHaveLength(0);
  });

  it("slow circling (drift with current) does NOT fire circling", () => {
    const s = newVesselState(23, T0);
    const geo = makeGeo();
    const cx = 120.3, cy = 22.5, r = 0.003;
    const positions = Array.from({ length: 10 }, (_, i) => {
      const angle = (i / 10) * 2 * Math.PI;
      return pos(23, cx + r * Math.cos(angle), cy + r * Math.sin(angle), 1, (i * 36) % 360, i * 5);
    });
    expect(feedPositions(s, positions, geo).filter((e: any) => e.evidence.kind === "circling")).toHaveLength(0);
  });

  it("cargo vessel outside lane coverage does NOT fire lane_deviation (Tokyo Bay regression)", () => {
    const s = newVesselState(24, T0);
    s.shipType = 70;
    const geo = makeGeo();
    const positions = Array.from({ length: 6 }, (_, i) => pos(24, 139.7 + i * 0.001, 35.4, 10, 90, i * 5));
    expect(feedPositions(s, positions, geo).filter((e: any) => e.evidence.kind === "lane_deviation")).toHaveLength(0);
  });
```

Note: the existing circling test uses `sog: 3` (≥ 2) and the reversal tests use `sog: 8` — they must still pass.

- [ ] **Step 3: Run tests to verify the new ones fail**

Run: `npx vitest run test/route.test.ts`
Expected: existing tests PASS; 5 new tests FAIL.

- [ ] **Step 4: Implement in `src/detectors/route.ts`**

Add import:

```typescript
import { activityFor } from "../activity";
```

At the top of `routeOnMessage`, after the cooldown check:

```typescript
  const act = activityFor(s, msg, geo, cfg);
  if (act === "moored" || act === "anchored") return [];
  const inExcl = geo.inExclusion([msg.lon, msg.lat]);
```

In the 6a reversal loop, extend the pair condition to require valid COG on both fixes and no exclusion context:

```typescript
      if (dt > 0 && dt < cfg.routeReversalMaxDtMs &&
          window[i - 1].sog >= cfg.minSogForCogKn && window[i].sog >= cfg.minSogForCogKn &&
          cogDelta(window[i - 1].cog, window[i].cog) >= cfg.routeReversalMinDeg) {
```

and guard the whole 6a block with `if (!inExcl && window.length >= 2) {`.

Guard 6b (circling) with exclusion + minimum way-making speed — change its opening condition to:

```typescript
  if (!inExcl && window.length >= cfg.routeCircleMinPositions) {
    const circleWindow = window.slice(-cfg.routeCircleMinPositions);
    if (circleWindow.every((w) => w.sog >= cfg.minSogForCogKn)) {
```

(close the extra brace at the end of the 6b block).

Guard 6c (lane deviation) with coverage — change its opening condition to:

```typescript
  if (s.shipType !== null && isCommercial(s.shipType) && window.length >= cfg.routeLaneDeviationCount && geo.inLaneCoverage(p)) {
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run test/route.test.ts test/pipeline.test.ts`
Expected: PASS (pipeline's circling test uses sog 3, outside exclusions — unaffected).

- [ ] **Step 6: Commit**

```bash
git add src/detectors/route.ts src/config.ts test/route.test.ts
git commit -m "feat: route detector ignores low-SOG COG jitter, harbor context, uncovered lanes"
```

---

### Task 6: Speed, loitering, and anchor-drag gating

**Files:**
- Modify: `src/detectors/speed.ts`, `src/detectors/loitering.ts`, `src/detectors/anchorDrag.ts`
- Modify: `src/config.ts` (add `dragMinDisplacementM`)
- Test: `test/speed.test.ts`, `test/loitering.test.ts`, `test/anchorDrag.test.ts` (extend)

**Interfaces:**
- Consumes: `activityFor` (Task 2), `haversineM`.
- Produces: `speedOnMessage` returns `[]` unless activity is `underway` and outside exclusions. `loiteringOnMessage`: a `moored` vessel is never a loiter candidate (anchored still is — anchoring over a cable IS the threat). `anchorDragOnMessage` additionally requires net displacement `haversineM(window[0], msg) >= dragMinDisplacementM` (swinging on the chain ≠ dragging).

- [ ] **Step 1: Add config key**

`src/config.ts`, after `dragMinCogStdDeg`:

```typescript
  dragMinDisplacementM: 150,
```

- [ ] **Step 2: Add failing tests**

Append to `test/speed.test.ts` (the `pos` helper there has no navStatus param, so build positions inline):

```typescript
  it("moored vessel (navStatus 5) does NOT fire even at type-mismatch speed", () => {
    const s = newVesselState(9, T0);
    s.shipType = 30;
    const positions = Array.from({ length: 5 }, (_, i) => {
      const p = pos(9, 120.2, 22.0, 15, i * 5);
      (p as any).navStatus = 5;
      return p;
    });
    expect(feedPositions(s, positions)).toHaveLength(0);
  });

  it("vessel inside an exclusion zone does NOT fire", () => {
    const exclGeo = new GeoContext(cables as any, {
      type: "FeatureCollection",
      features: [{ type: "Feature", properties: { name: "PORT" }, geometry: { type: "Polygon", coordinates: [[[120.1, 21.9], [120.3, 21.9], [120.3, 22.1], [120.1, 22.1], [120.1, 21.9]]] } }],
    } as any, 1000, noLanes as any, 5000);
    const s = newVesselState(10, T0);
    s.shipType = 30;
    const positions = Array.from({ length: 5 }, (_, i) => pos(10, 120.2, 22.0, 15, i * 5));
    const evs: any[] = [];
    for (const p of positions) {
      evs.push(...speedOnMessage(s, p, exclGeo, CONFIG));
      s.ring.push(p); s.lastSeen = p.ts;
    }
    expect(evs).toHaveLength(0);
  });
```

Append to `test/loitering.test.ts`:

```typescript
  it("moored vessel (navStatus 5) in corridor does NOT loiter", () => {
    const s = newVesselState(5, T0);
    const evs: any[] = [];
    for (let m = 0; m <= 300; m += 10) {
      const p = pos(5, 120.2, 22.0, 0.5, m);
      (p as any).navStatus = 5;
      evs.push(...loiteringOnMessage(s, p, geo, CONFIG));
      s.ring.push(p); s.lastSeen = p.ts;
    }
    expect(evs).toHaveLength(0);
  });

  it("anchored vessel (navStatus 1) in corridor STILL loiters — anchoring over cable is the threat", () => {
    const s = newVesselState(6, T0);
    const evs: any[] = [];
    for (let m = 0; m <= 130; m += 10) {
      const p = pos(6, 120.2, 22.0, 0.5, m);
      (p as any).navStatus = 1;
      evs.push(...loiteringOnMessage(s, p, geo, CONFIG));
      s.ring.push(p); s.lastSeen = p.ts;
    }
    expect(evs).toHaveLength(1);
  });
```

(The existing loitering tests never push to `s.ring`; the new ones must, because `activityFor` reads it.)

Append to `test/anchorDrag.test.ts`:

```typescript
  it("swinging at anchor (jitter, no net displacement) does NOT fire", () => {
    const s = newVesselState(5, T0);
    const cogs = [10, 170, 300, 80, 220, 350, 40, 190, 310, 100, 250, 20];
    // erratic COG but the vessel oscillates within ~30 m of one spot
    const positions: AisPosition[] = cogs.map((cog, i) => ({
      mmsi: 5, lon: 120.3 + (i % 2) * 0.0003, lat: 22.0, sog: 1.0, cog, heading: cog, ts: T0 + i * 60_000,
    }));
    expect(feed(s, positions)).toHaveLength(0);
  });
```

- [ ] **Step 3: Run tests to verify the new ones fail**

Run: `npx vitest run test/speed.test.ts test/loitering.test.ts test/anchorDrag.test.ts`
Expected: existing tests PASS; the 5 new tests FAIL.

- [ ] **Step 4: Implement**

`src/detectors/speed.ts` — add import and gate after the cooldown check:

```typescript
import { activityFor } from "../activity";
```

```typescript
  const p: LngLat = [msg.lon, msg.lat];
  if (activityFor(s, msg, geo, cfg) !== "underway" || geo.inExclusion(p)) return [];
```

(the `const p` declaration moves up to serve the gate; delete the later duplicate declaration.)

`src/detectors/loitering.ts` — add import and extend the candidate condition:

```typescript
import { activityFor } from "../activity";
```

```typescript
  const loiterCandidate = msg.sog < cfg.loiterMaxSogKn && geo.inCorridor(p) && !geo.inExclusion(p)
    && activityFor(s, msg, geo, cfg) !== "moored";
```

`src/detectors/anchorDrag.ts` — add import and displacement gate after the `slowMoving`/corridor checks:

```typescript
import { haversineM } from "../geo/geo";
```

```typescript
  const displacement = haversineM([window[0].lon, window[0].lat], [msg.lon, msg.lat]);
  if (displacement < cfg.dragMinDisplacementM) return [];
```

Include `displacementM: Math.round(displacement)` in the event's `evidence` object.

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run test/speed.test.ts test/loitering.test.ts test/anchorDrag.test.ts test/pipeline.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/detectors/speed.ts src/detectors/loitering.ts src/detectors/anchorDrag.ts src/config.ts test/speed.test.ts test/loitering.test.ts test/anchorDrag.test.ts
git commit -m "feat: speed/loiter/drag gain activity context; drag requires real displacement"
```

---

### Task 7: Identity detector fixes

**Files:**
- Modify: `src/detectors/identity.ts:14-68`
- Test: `test/identity.test.ts` (extend)

**Interfaces:**
- Consumes: nothing new.
- Produces: `CALLSIGN` table loses the 1-char `"B": "CN"` entry (Taiwanese `BP`/`BR` boats stop reading as China). Placeholder values (`""`, `"0"`, whitespace) never fire `identity_change`; history still tracks raw values so a later real change compares against the latest broadcast.

- [ ] **Step 1: Add failing tests**

Append to `test/identity.test.ts`:

```typescript
  it("Taiwanese BP/BR callsigns are unknown, not China (Keelung pilot-boat regression)", () => {
    expect(callsignCountry("BP3085")).toBeNull();
    expect(callsignCountry("BR3427")).toBeNull();
    expect(callsignCountry("BV1234")).toBe("TW"); // unambiguous 2-char prefixes still resolve
    const s = newVesselState(416006655, T0);
    const evs = identityOnStatic(s, id(416006655, "YONG AN", "BP3085", 0), CONFIG);
    expect(evs).toHaveLength(0);
  });

  it("placeholder callsign '0' → real callsign is not an identity change", () => {
    const s = newVesselState(416006655, T0);
    identityOnStatic(s, id(416006655, "PILOT BOAT", "0", 0), CONFIG);
    const evs = identityOnStatic(s, id(416006655, "PILOT BOAT", "BP3085", 60), CONFIG);
    expect(evs).toHaveLength(0);
    expect(s.identities).toHaveLength(2); // raw history still updated
  });

  it("empty name → real name is not an identity change; real → real still fires", () => {
    const s = newVesselState(412111111, T0);
    identityOnStatic(s, id(412111111, "", "BXYZ1", 0), CONFIG);
    expect(identityOnStatic(s, id(412111111, "SHUNXIN 39", "BXYZ1", 30), CONFIG)).toHaveLength(0);
    const evs = identityOnStatic(s, id(412111111, "XINGSHUN 39", "BXYZ1", 60), CONFIG);
    expect(evs).toHaveLength(1);
    expect(evs[0].evidence).toMatchObject({ kind: "identity_change", prevName: "SHUNXIN 39", newName: "XINGSHUN 39" });
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/identity.test.ts`
Expected: existing tests PASS; the 3 new tests FAIL.

- [ ] **Step 3: Implement in `src/detectors/identity.ts`**

Delete the `"B": "CN",` entry from the `CALLSIGN` table (China's `B` block is shared with Taiwan's `BP`/`BR`/`BX` allocations in practice — a 1-char match mislabels them; keep only unambiguous 2-char prefixes).

Replace the change-detection block at the top of `identityOnStatic`:

```typescript
  const real = (v: string) => { const t = v.trim(); return t !== "" && t !== "0"; };
  const prev = s.identities.length ? s.identities[s.identities.length - 1] : null;
  const rawChanged = prev !== null && (prev.name !== ident.name || prev.callsign !== ident.callsign);
  const changed = prev !== null && (
    (real(prev.name) && real(ident.name) && prev.name !== ident.name) ||
    (real(prev.callsign) && real(ident.callsign) && prev.callsign !== ident.callsign)
  );
```

The event push stays keyed on `changed` (add `kind` if missing — the existing evidence already carries `kind: "identity_change"`). Change the history/flag block condition from `if (prev === null || changed)` to `if (prev === null || rawChanged)` so raw placeholder→real transitions update the baseline and re-run the flag check.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/identity.test.ts test/pipeline.test.ts`
Expected: PASS (pipeline's identity swap test uses real values "A"→"B").

- [ ] **Step 5: Commit**

```bash
git add src/detectors/identity.ts test/identity.test.ts
git commit -m "fix: drop ambiguous B->CN callsign fallback; ignore placeholder identity values"
```

---

### Task 8: Fusion core — types, weight table, open/update

**Files:**
- Modify: `src/types.ts` (fusion types, VesselState fields)
- Create: `src/fusion.ts`
- Modify: `src/config.ts` (fusion keys; remove `susScoreThreshold` **in Task 12**, not here)
- Test: `test/fusion.test.ts` (create)

**Interfaces:**
- Consumes: `decayedScore` (`src/score.ts`), `lastActivity` (Task 2), `GeoContext.inCorridor`.
- Produces (exact, used by Tasks 9–12):

```typescript
// src/types.ts
export const THREAT_CATEGORIES = ["cable_interference", "dark_activity", "identity_deception", "militia_presence"] as const;
export type ThreatCategory = (typeof THREAT_CATEGORIES)[number];
export interface EvidenceRef { eventId: string; type: EventType; kind: string | null; weight: number; ts: number; summary: string }
export interface ThreatAssessment {
  id: string; mmsi: number; category: ThreatCategory; status: "open" | "closed";
  confidence: number; openedTs: number; updatedTs: number; closedTs: number | null;
  evidence: EvidenceRef[]; narrative: string; region: RegionId | null; lastLon: number; lastLat: number;
}
export interface CategoryState { score: number; ts: number; contributed: Record<string, number>; recent: EvidenceRef[]; belowSince: number | null }
// VesselState: `score`/`scoreTs` REPLACED by:
//   categories: Record<ThreatCategory, CategoryState>;
//   assessments: Partial<Record<ThreatCategory, ThreatAssessment>>;
export function newCategoryState(now: number): CategoryState

// src/fusion.ts
export function confidenceFor(score: number): number
export function signalsFor(ev: AnomalyEvent, s: VesselState, geo: GeoContext, cfg: Config): { category: ThreatCategory; cls: SignalClass; summary: string }[]
export function applyEventToFusion(s: VesselState, ev: AnomalyEvent, geo: GeoContext, cfg: Config, now: number): ThreatAssessment[] // returns opened/updated assessments
export function maxCategoryScore(s: VesselState): { score: number; ts: number }
export type SignalClass = "strong" | "medium" | "weak";
```

- Config keys added here: `assessmentOpenScore: 0.6`, `assessmentCloseScore: 0.2`, `assessmentCloseAfterMs: 43_200_000`, `darkRepositionMinM: 9_260`.
- Deliberate simplification of spec §4f: instead of a `CategoryScorer` interface with three registered scorer objects, the weight table is one `signalsFor` switch and the lifecycle is category-generic (`THREAT_CATEGORIES` loops). The phase-2 extension point is: add `militia_presence` cases to `signalsFor` (or a new tick-time scorer feeding `applyEventToFusion`-style contributions) — no persistence/API/frontend changes needed, which is what §4f actually requires.

- [ ] **Step 1: Add types and config**

`src/types.ts` — add the block above (after the `AnomalyEvent` interface). In `VesselState`, replace

```typescript
  score: number;
  scoreTs: number;
```

with

```typescript
  categories: Record<ThreatCategory, CategoryState>;
  assessments: Partial<Record<ThreatCategory, ThreatAssessment>>;
```

Add the factory and update `newVesselState` (replace `score: 0, scoreTs: now,`):

```typescript
export function newCategoryState(now: number): CategoryState {
  return { score: 0, ts: now, contributed: {}, recent: [], belowSince: null };
}
```

```typescript
    categories: {
      cable_interference: newCategoryState(now),
      dark_activity: newCategoryState(now),
      identity_deception: newCategoryState(now),
      militia_presence: newCategoryState(now),
    },
    assessments: {},
```

`src/config.ts` — after `scoreHalfLifeMs`:

```typescript
  assessmentOpenScore: 0.6,
  assessmentCloseScore: 0.2,
  assessmentCloseAfterMs: 43_200_000,
  darkRepositionMinM: 9_260,
```

Note: `src/score.ts`'s `applyEventToScore` and its callers now fail to compile — that is expected; they are removed in Task 10. Until then run only the fusion test file, not `tsc`.

- [ ] **Step 2: Write the failing tests**

```typescript
// test/fusion.test.ts
import { describe, expect, it } from "vitest";
import { CONFIG } from "../src/config";
import { GeoContext } from "../src/geo/context";
import { newVesselState, type AnomalyEvent } from "../src/types";
import { applyEventToFusion, confidenceFor, maxCategoryScore, signalsFor } from "../src/fusion";

const cables = { type: "FeatureCollection", features: [{ type: "Feature", properties: { name: "C1", approximate: true }, geometry: { type: "LineString", coordinates: [[120.0, 22.0], [121.0, 22.0]] } }] };
const noFc = { type: "FeatureCollection", features: [] };
const geo = new GeoContext(cables as any, noFc as any, 1000, noFc as any, 5000);
const T0 = 1_750_000_000_000;

const ev = (over: Partial<AnomalyEvent>): AnomalyEvent => ({
  id: "x", type: "loitering", severity: 3, mmsi: 1, lon: 120.2, lat: 22.0,
  startTs: T0, endTs: T0, evidence: {}, region: "tw", ...over,
});

const loiterEv = (idSuffix = "1") => ev({ id: `loitering-1-${idSuffix}`, type: "loitering", evidence: { corridor: "C1", durationMs: 3 * 3_600_000 } });
const darkGapEv = () => ev({ id: "ais_gap-1-1", type: "ais_gap", endTs: T0 + 2 * 3_600_000, evidence: { gapMs: 2 * 3_600_000, distanceM: 15_000, impliedSpeedKn: 4, startInCorridor: true, endInCorridor: false } });
const flagEv = (n: number) => ev({ id: `identity-1-${n}-flag`, type: "identity", evidence: { kind: "flag_mismatch", midCountry: "CN", callsignCountry: "TW", callsign: "BV1" } });

describe("signal mapping", () => {
  it("anchor drag is a strong cable signal", () => {
    const s = newVesselState(1, T0);
    const sig = signalsFor(ev({ type: "anchor_drag", evidence: { corridor: "C1", cogStdDeg: 80, meanSogKn: 1.2 } }), s, geo, CONFIG);
    expect(sig).toEqual([expect.objectContaining({ category: "cable_interference", cls: "strong" })]);
  });

  it("a dark gap in-corridor with repositioning maps to cable AND dark, one weight each (max rule)", () => {
    const s = newVesselState(1, T0);
    const sig = signalsFor(darkGapEv(), s, geo, CONFIG);
    const cats = sig.map((x) => x.category).sort();
    expect(cats).toEqual(["cable_interference", "dark_activity"]);
    expect(sig.every((x) => x.cls === "medium")).toBe(true); // corridor+reposition does NOT sum
  });

  it("an open gap event (endTs null) produces no signals", () => {
    const s = newVesselState(1, T0);
    expect(signalsFor(ev({ type: "ais_gap", endTs: null, evidence: {} }), s, geo, CONFIG)).toEqual([]);
  });

  it("route/speed anomalies outside the corridor produce no signals", () => {
    const s = newVesselState(1, T0);
    expect(signalsFor(ev({ type: "route_deviation", lon: 120.2, lat: 23.9, evidence: { kind: "circling" } }), s, geo, CONFIG)).toEqual([]);
  });
});

describe("fusion scoring and assessment lifecycle (open/update)", () => {
  it("one medium signal does not open; a second independent type does", () => {
    const s = newVesselState(1, T0);
    expect(applyEventToFusion(s, loiterEv(), geo, CONFIG, T0)).toEqual([]); // 0.45 < 0.6
    expect(s.assessments.cable_interference).toBeUndefined();
    const changed = applyEventToFusion(s, darkGapEv(), geo, CONFIG, T0 + 60_000);
    const cable = changed.find((a) => a.category === "cable_interference")!;
    expect(cable.status).toBe("open");
    expect(cable.evidence).toHaveLength(2); // pre-open loiter evidence is preserved
    expect(cable.confidence).toBeCloseTo(confidenceFor(0.9), 1);
    // dark_activity got a single medium — must NOT open
    expect(s.assessments.dark_activity).toBeUndefined();
    expect(s.categories.dark_activity.score).toBeCloseTo(0.45, 2);
  });

  it("a strong signal opens alone", () => {
    const s = newVesselState(2, T0);
    const changed = applyEventToFusion(s, ev({ type: "anchor_drag", id: "anchor_drag-2-1", evidence: { corridor: "C1", cogStdDeg: 80, meanSogKn: 1.2 } }), geo, CONFIG, T0);
    expect(changed).toHaveLength(1);
    expect(changed[0]).toMatchObject({ category: "cable_interference", status: "open", mmsi: 2 });
    expect(changed[0].id).toBe(`cable_interference-2-${T0}`);
  });

  it("repeated weak signals are damped and can never open", () => {
    const s = newVesselState(3, T0);
    for (let i = 0; i < 6; i++) applyEventToFusion(s, flagEv(i), geo, CONFIG, T0 + i * 60_000);
    // 0.15 + 5 × 0.0375 = 0.3375 < 0.6
    expect(s.assessments.identity_deception).toBeUndefined();
    expect(s.categories.identity_deception.score).toBeLessThan(CONFIG.assessmentOpenScore);
  });

  it("same eventId re-applied (loiter close) updates the existing evidence ref, not a duplicate", () => {
    const s = newVesselState(4, T0);
    applyEventToFusion(s, ev({ type: "anchor_drag", id: "anchor_drag-4-1", evidence: { corridor: "C1" } }), geo, CONFIG, T0);
    applyEventToFusion(s, loiterEv("open"), geo, CONFIG, T0 + 1_000);
    const before = s.assessments.cable_interference!.evidence.length;
    applyEventToFusion(s, loiterEv("open"), geo, CONFIG, T0 + 2_000); // same id again (close)
    expect(s.assessments.cable_interference!.evidence).toHaveLength(before);
  });

  it("score decays with the configured half-life between contributions", () => {
    // NOTE: decay is applied lazily, at contribution time — so the second event must
    // touch the SAME category to observe the decay in the stored score.
    const s = newVesselState(5, T0);
    applyEventToFusion(s, loiterEv(), geo, CONFIG, T0);
    applyEventToFusion(s, ev({ type: "speed_anomaly", id: "speed_anomaly-5-1", evidence: { kind: "type_mismatch" } }), geo, CONFIG, T0 + CONFIG.scoreHalfLifeMs);
    // cable: 0.45 halved to 0.225, plus weak in-corridor speed signal 0.15 = 0.375
    expect(s.categories.cable_interference.score).toBeCloseTo(0.375, 2);
  });

  it("maxCategoryScore returns the hottest category for the legacy vessels.score column", () => {
    const s = newVesselState(6, T0);
    applyEventToFusion(s, loiterEv(), geo, CONFIG, T0);
    expect(maxCategoryScore(s).score).toBeCloseTo(0.45, 2);
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `npx vitest run test/fusion.test.ts`
Expected: FAIL — `src/fusion.ts` not found.

- [ ] **Step 4: Implement `src/fusion.ts`**

```typescript
// src/fusion.ts — evidence fusion (spec §4): raw events → weighted category signals →
// ThreatAssessment lifecycle. Deterministic: same events in, same assessments out.
import { lastActivity } from "./activity";
import type { Config } from "./config";
import type { GeoContext } from "./geo/context";
import { decayedScore } from "./score";
import { THREAT_CATEGORIES, type AnomalyEvent, type CategoryState, type EvidenceRef, type ThreatAssessment, type ThreatCategory, type VesselState } from "./types";

export type SignalClass = "strong" | "medium" | "weak";
const CLASS_WEIGHT: Record<SignalClass, number> = { strong: 1.0, medium: 0.45, weak: 0.15 };
const DAMPING = 0.25;         // repeat (type,kind) within one half-life contributes 25%
const RECENT_CAP = 10;        // pre-open evidence kept per category

export function confidenceFor(score: number): number {
  return Math.round(Math.min(1, score / 2) * 100) / 100;
}

const fmtH = (ms: number) => `${(ms / 3_600_000).toFixed(1)} h`;
const fmtNm = (m: number) => `${(m / 1852).toFixed(1)} nm`;
const ge = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);

// One human-readable clause per event; assessments join these into the narrative (spec §4e).
function clauseFor(ev: AnomalyEvent): string {
  const e = ev.evidence as Record<string, unknown>;
  switch (ev.type) {
    case "loitering":
      return `loitered ${fmtH(ge(e.durationMs))} over ${String(e.corridor ?? "cable")} corridor`;
    case "anchor_drag":
      return `dragged anchor across ${String(e.corridor ?? "cable")} corridor (COG σ ${ge(e.cogStdDeg)}°)`;
    case "ais_gap": {
      let c = `went dark ${fmtH(ge(e.gapMs))}`;
      if (ge(e.distanceM) > 0) c += ` and reappeared ${fmtNm(ge(e.distanceM))} away`;
      if (e.startInCorridor || e.endInCorridor) c += " near a cable corridor";
      return c;
    }
    case "identity":
      if (e.kind === "teleport") return `position jump implies ${ge(e.impliedSpeedKn)} kn`;
      if (e.kind === "flag_mismatch") return `callsign country (${String(e.callsignCountry)}) conflicts with MMSI flag (${String(e.midCountry)})`;
      return `identity changed (${String(e.prevName ?? e.prevCallsign)} → ${String(e.newName ?? e.newCallsign)})`;
    case "speed_anomaly":
      return `speed anomaly (${String(e.kind)}) in corridor`;
    case "route_deviation":
      return `route anomaly (${String(e.kind)}) in corridor`;
  }
}

// Spec §4b weight table. Returns at most one signal per category (max matching class).
export function signalsFor(ev: AnomalyEvent, s: VesselState, geo: GeoContext, cfg: Config): { category: ThreatCategory; cls: SignalClass; summary: string }[] {
  const hits = new Map<ThreatCategory, SignalClass>();
  const raise = (cat: ThreatCategory, cls: SignalClass) => {
    const cur = hits.get(cat);
    if (!cur || CLASS_WEIGHT[cls] > CLASS_WEIGHT[cur]) hits.set(cat, cls);
  };
  const e = ev.evidence as Record<string, unknown>;

  switch (ev.type) {
    case "anchor_drag":
      raise("cable_interference", "strong");
      break;
    case "loitering":
      raise("cable_interference", "medium");
      break;
    case "ais_gap": {
      if (ev.endTs === null) break; // open gap: attributes unknown, telemetry only
      if (e.startInCorridor === true || e.endInCorridor === true) {
        raise("cable_interference", "medium");
        raise("dark_activity", "medium");
      }
      if (ge(e.distanceM) > cfg.darkRepositionMinM) raise("dark_activity", "medium");
      if (ge(e.impliedSpeedKn) > cfg.impossibleSpeedKn) raise("dark_activity", "medium");
      break;
    }
    case "identity": {
      if (e.kind === "teleport") raise("dark_activity", "medium");
      else if (e.kind === "flag_mismatch") raise("identity_deception", "weak");
      else if (e.kind === "identity_change") {
        const act = lastActivity(s, geo, cfg);
        raise("identity_deception", act === "moored" || act === "anchored" ? "weak" : "medium");
      }
      break;
    }
    case "speed_anomaly":
    case "route_deviation":
      if (geo.inCorridor([ev.lon, ev.lat])) raise("cable_interference", "weak");
      break;
  }

  const summary = clauseFor(ev);
  return [...hits].map(([category, cls]) => ({ category, cls, summary }));
}

function narrativeFrom(evidence: EvidenceRef[]): string {
  const clauses = evidence.map((r) => r.summary);
  const joined = clauses.join(", then ");
  return joined ? joined.charAt(0).toUpperCase() + joined.slice(1) + "." : "";
}

function upsertEvidence(list: EvidenceRef[], ref: EvidenceRef): void {
  const i = list.findIndex((r) => r.eventId === ref.eventId);
  if (i >= 0) list[i] = { ...ref, weight: list[i].weight + ref.weight };
  else list.push(ref);
}

export function applyEventToFusion(s: VesselState, ev: AnomalyEvent, geo: GeoContext, cfg: Config, now: number): ThreatAssessment[] {
  const changed: ThreatAssessment[] = [];
  for (const { category, cls, summary } of signalsFor(ev, s, geo, cfg)) {
    const cs: CategoryState = s.categories[category];
    cs.score = decayedScore(cs.score, cs.ts, now, cfg.scoreHalfLifeMs);
    const key = `${ev.type}:${String((ev.evidence as Record<string, unknown>).kind ?? "")}`;
    const damped = cs.contributed[key] !== undefined && now - cs.contributed[key] < cfg.scoreHalfLifeMs;
    const weight = CLASS_WEIGHT[cls] * (damped ? DAMPING : 1);
    cs.score += weight;
    cs.ts = now;
    cs.contributed[key] = now;
    cs.belowSince = null;

    const ref: EvidenceRef = { eventId: ev.id, type: ev.type, kind: ((ev.evidence as Record<string, unknown>).kind as string) ?? null, weight, ts: now, summary };
    let a = s.assessments[category];
    if (!a && cs.score >= cfg.assessmentOpenScore) {
      a = {
        id: `${category}-${s.mmsi}-${now}`, mmsi: s.mmsi, category, status: "open",
        confidence: 0, openedTs: now, updatedTs: now, closedTs: null,
        evidence: [], narrative: "", region: s.region, lastLon: ev.lon, lastLat: ev.lat,
      };
      for (const r of cs.recent) upsertEvidence(a.evidence, r); // pre-open corroborating evidence
      s.assessments[category] = a;
      cs.recent = [];
    }
    if (a) {
      upsertEvidence(a.evidence, ref);
      a.confidence = confidenceFor(cs.score);
      a.narrative = narrativeFrom(a.evidence);
      a.updatedTs = now;
      a.region = s.region ?? a.region;
      a.lastLon = ev.lon;
      a.lastLat = ev.lat;
      changed.push(a);
    } else {
      upsertEvidence(cs.recent, ref);
      cs.recent = cs.recent.filter((r) => now - r.ts < cfg.scoreHalfLifeMs).slice(-RECENT_CAP);
    }
  }
  return changed;
}

export function maxCategoryScore(s: VesselState): { score: number; ts: number } {
  let best = { score: 0, ts: s.lastSeen };
  for (const c of THREAT_CATEGORIES) {
    const cs = s.categories[c];
    if (cs.score > best.score) best = { score: cs.score, ts: cs.ts };
  }
  return best;
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run test/fusion.test.ts`
Expected: PASS. (Other suites are broken by the `VesselState` change until Task 10 — that is expected mid-flight; do not run `npm test` yet.)

- [ ] **Step 6: Commit**

```bash
git add src/types.ts src/fusion.ts src/config.ts test/fusion.test.ts
git commit -m "feat: fusion core — weight table, damping, assessment open/update with narratives"
```

---

### Task 9: Fusion close lifecycle (`fusionTick`)

**Files:**
- Modify: `src/fusion.ts` (append)
- Test: `test/fusion-lifecycle.test.ts` (create)

**Interfaces:**
- Consumes: Task 8 internals.
- Produces: `fusionTick(s: VesselState, cfg: Config, now: number): ThreatAssessment[]` — decays each open assessment's category score; when it stays below `assessmentCloseScore` continuously for `assessmentCloseAfterMs`, the assessment closes (`status: "closed"`, `closedTs = now`), is removed from `s.assessments`, and is returned. A later signal opens a NEW assessment id.

- [ ] **Step 1: Write the failing test**

```typescript
// test/fusion-lifecycle.test.ts
import { describe, expect, it } from "vitest";
import { CONFIG } from "../src/config";
import { GeoContext } from "../src/geo/context";
import { newVesselState, type AnomalyEvent } from "../src/types";
import { applyEventToFusion, fusionTick } from "../src/fusion";

const cables = { type: "FeatureCollection", features: [{ type: "Feature", properties: { name: "C1", approximate: true }, geometry: { type: "LineString", coordinates: [[120.0, 22.0], [121.0, 22.0]] } }] };
const noFc = { type: "FeatureCollection", features: [] };
const geo = new GeoContext(cables as any, noFc as any, 1000, noFc as any, 5000);
const T0 = 1_750_000_000_000;
const HOUR = 3_600_000;

const drag = (mmsi: number, ts: number): AnomalyEvent => ({
  id: `anchor_drag-${mmsi}-${ts}`, type: "anchor_drag", severity: 5, mmsi, lon: 120.2, lat: 22.0,
  startTs: ts, endTs: ts, evidence: { corridor: "C1", cogStdDeg: 80, meanSogKn: 1.2 }, region: "tw",
});

describe("assessment close lifecycle", () => {
  it("closes after the score sits below the close threshold for 12 h, then reopens with a new id", () => {
    const s = newVesselState(1, T0);
    const [opened] = applyEventToFusion(s, drag(1, T0), geo, CONFIG, T0);
    // score 1.0 → below 0.2 needs log2(1/0.2) ≈ 2.32 half-lives ≈ 56 h
    const tBelow = T0 + 57 * HOUR;
    expect(fusionTick(s, CONFIG, tBelow)).toEqual([]); // just dipped below — belowSince starts
    expect(fusionTick(s, CONFIG, tBelow + 6 * HOUR)).toEqual([]); // 6 h below — not yet
    const closed = fusionTick(s, CONFIG, tBelow + 13 * HOUR);
    expect(closed).toHaveLength(1);
    expect(closed[0]).toMatchObject({ id: opened.id, status: "closed" });
    expect(closed[0].closedTs).toBe(tBelow + 13 * HOUR);
    expect(s.assessments.cable_interference).toBeUndefined();

    const t2 = tBelow + 14 * HOUR;
    const [reopened] = applyEventToFusion(s, drag(1, t2), geo, CONFIG, t2);
    expect(reopened.status).toBe("open");
    expect(reopened.id).not.toBe(opened.id);
  });

  it("a fresh signal while dipping resets the close countdown", () => {
    const s = newVesselState(2, T0);
    applyEventToFusion(s, drag(2, T0), geo, CONFIG, T0);
    const tBelow = T0 + 57 * HOUR;
    fusionTick(s, CONFIG, tBelow); // belowSince set
    applyEventToFusion(s, drag(2, tBelow + HOUR), geo, CONFIG, tBelow + HOUR); // re-energized
    expect(fusionTick(s, CONFIG, tBelow + 13 * HOUR)).toEqual([]); // countdown was reset
    expect(s.assessments.cable_interference?.status).toBe("open");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/fusion-lifecycle.test.ts`
Expected: FAIL — `fusionTick` not exported.

- [ ] **Step 3: Implement — append to `src/fusion.ts`**

```typescript
// Close assessments whose decayed score stayed below the close threshold for the
// configured dwell (spec §4c). Returns the closed assessments for persistence.
export function fusionTick(s: VesselState, cfg: Config, now: number): ThreatAssessment[] {
  const closed: ThreatAssessment[] = [];
  for (const category of THREAT_CATEGORIES) {
    const a = s.assessments[category];
    if (!a) continue;
    const cs = s.categories[category];
    const current = decayedScore(cs.score, cs.ts, now, cfg.scoreHalfLifeMs);
    if (current >= cfg.assessmentCloseScore) {
      cs.belowSince = null;
      continue;
    }
    if (cs.belowSince === null) {
      cs.belowSince = now;
      continue;
    }
    if (now - cs.belowSince >= cfg.assessmentCloseAfterMs) {
      a.status = "closed";
      a.closedTs = now;
      a.confidence = confidenceFor(current);
      a.updatedTs = now;
      delete s.assessments[category];
      cs.belowSince = null;
      closed.push(a);
    }
  }
  return closed;
}
```

(Note: `applyEventToFusion` already sets `cs.belowSince = null` on every contribution — that is what makes the second test pass.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/fusion.test.ts test/fusion-lifecycle.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/fusion.ts test/fusion-lifecycle.test.ts
git commit -m "feat: assessment close lifecycle with 12h below-threshold dwell"
```

---

### Task 10: Pipeline rewire — fusion replaces the single score

**Files:**
- Modify: `src/pipeline.ts`, `src/score.ts`, `src/replay-core.ts`
- Modify: `test/pipeline.test.ts`, `test/score.test.ts`
- Test: `test/pipeline-fusion.test.ts` (create)

**Interfaces:**
- Consumes: `applyEventToFusion`, `fusionTick` (Tasks 8–9).
- Produces:
  - `src/score.ts` exports ONLY `decayedScore` (delete `applyEventToScore` and its unused imports).
  - `Tracker` methods keep returning `AnomalyEvent[]`; new method `drainChangedAssessments(): ThreatAssessment[]` returns each assessment touched since the last drain (deduped by id, latest state, evidence array copied) and clears the buffer.
  - `replayCapture` returns `{ events, vessels, messages, assessments }` where `assessments` is every assessment ever opened during the replay (final state, open or closed).

- [ ] **Step 1: Write the failing test**

```typescript
// test/pipeline-fusion.test.ts
import { describe, expect, it } from "vitest";
import { CONFIG } from "../src/config";
import { GeoContext } from "../src/geo/context";
import { Tracker } from "../src/pipeline";
import type { AisPosition } from "../src/types";

const cables = { type: "FeatureCollection", features: [{ type: "Feature", properties: { name: "C1", approximate: true }, geometry: { type: "LineString", coordinates: [[120.0, 22.0], [121.0, 22.0]] } }] };
const noFc = { type: "FeatureCollection", features: [] };
const geo = new GeoContext(cables as any, noFc as any, 1000, noFc as any, 5000);
const T0 = 1_750_000_000_000;
const pos = (mmsi: number, lon: number, lat: number, sog: number, tMin: number, cog = 90): AisPosition =>
  ({ mmsi, lon, lat, sog, cog, heading: cog, ts: T0 + tMin * 60_000 });

describe("pipeline fusion wiring", () => {
  it("loiter alone accumulates cable score but does not open an assessment", () => {
    const t = new Tracker(geo, CONFIG);
    for (let m = 0; m <= 130; m += 10) t.handlePosition(pos(1, 120.2, 22.0, 0.5, m));
    const s = t.states.get(1)!;
    expect(s.categories.cable_interference.score).toBeCloseTo(0.45, 2);
    expect(s.assessments.cable_interference).toBeUndefined();
    expect(t.drainChangedAssessments()).toEqual([]);
  });

  it("loiter + dark gap with repositioning opens cable_interference; drain returns it once", () => {
    const t = new Tracker(geo, CONFIG);
    for (let m = 0; m <= 130; m += 10) t.handlePosition(pos(2, 120.2, 22.0, 0.5, m)); // loiter (medium)
    t.tick(T0 + (130 + 70) * 60_000);                       // gap opens (cadence is healthy)
    t.handlePosition(pos(2, 120.5, 22.0, 8, 130 + 130));    // reappears ~31 km away → gap closes
    const changed = t.drainChangedAssessments();
    const cable = changed.find((a) => a.category === "cable_interference")!;
    expect(cable).toBeDefined();
    expect(cable.status).toBe("open");
    expect(cable.evidence.length).toBeGreaterThanOrEqual(2);
    expect(cable.narrative).toContain("loitered");
    expect(t.drainChangedAssessments()).toEqual([]); // drained
    // dark_activity: single gap event (max rule) → not open
    expect(t.states.get(2)!.assessments.dark_activity).toBeUndefined();
  });

  it("tick() closes stale assessments and drain reports the closure", () => {
    const t = new Tracker(geo, CONFIG);
    // anchor drag → strong → opens immediately
    const cogs = [10, 170, 300, 80, 220, 350, 40, 190, 310, 100, 250, 20];
    cogs.forEach((cog, i) => t.handlePosition({ mmsi: 3, lon: 120.3 + i * 0.001, lat: 22.0, sog: 1.5, cog, heading: cog, ts: T0 + i * 60_000 }));
    expect(t.drainChangedAssessments().some((a) => a.category === "cable_interference")).toBe(true);
    // score 1.0 needs ~56 h to dip under 0.2, then 12 h dwell
    t.tick(T0 + 57 * 3_600_000);
    t.tick(T0 + 70 * 3_600_000);
    const closed = t.drainChangedAssessments().filter((a) => a.status === "closed");
    expect(closed).toHaveLength(1);
    expect(t.states.get(3)!.assessments.cable_interference).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/pipeline-fusion.test.ts`
Expected: FAIL — compile errors (`applyEventToScore` still imported in pipeline; no `drainChangedAssessments`).

- [ ] **Step 3: Implement**

`src/score.ts` — delete `applyEventToScore` and its now-unused imports; the file becomes:

```typescript
// src/score.ts
export function decayedScore(score: number, fromTs: number, toTs: number, halfLifeMs: number): number {
  if (toTs <= fromTs) return score;
  return score * Math.pow(0.5, (toTs - fromTs) / halfLifeMs);
}
```

`src/pipeline.ts` — replace the `applyEventToScore` import with:

```typescript
import { applyEventToFusion, fusionTick } from "./fusion";
import type { ThreatAssessment } from "./types";
```

Add a private field to `Tracker`:

```typescript
  private changedAssessments = new Map<string, ThreatAssessment>();
```

In `handlePosition`, replace the event loop:

```typescript
    for (const ev of events) {
      ev.region = region;
      for (const a of applyEventToFusion(s, ev, this.geo, this.cfg, msg.ts)) this.changedAssessments.set(a.id, a);
    }
```

In `handleStatic`, replace its event loop:

```typescript
    for (const ev of events) {
      ev.region = s.region;
      for (const a of applyEventToFusion(s, ev, this.geo, this.cfg, ident.ts)) this.changedAssessments.set(a.id, a);
    }
```

In `tick`, replace the body of the per-state loop and add closes:

```typescript
    for (const s of this.states.values()) {
      const evs = this.guard(s, () => gapOnTick(s, this.geo, this.cfg, now));
      for (const ev of evs) {
        ev.region = s.region;
        for (const a of applyEventToFusion(s, ev, this.geo, this.cfg, now)) this.changedAssessments.set(a.id, a);
      }
      events.push(...evs);
      for (const a of this.guard(s, () => fusionTick(s, this.cfg, now))) this.changedAssessments.set(a.id, a);
    }
```

(`guard` returns `AnomalyEvent[]`; give it a generic signature so it can wrap both: `private guard<T>(s: VesselState, fn: () => T[]): T[]`.)

Add the drain method:

```typescript
  drainChangedAssessments(): ThreatAssessment[] {
    const out = [...this.changedAssessments.values()].map((a) => ({ ...a, evidence: [...a.evidence] }));
    this.changedAssessments.clear();
    return out;
  }
```

`src/replay-core.ts` — change the return type and collect assessments. After the message loop, before `return`:

```typescript
  const assessById = new Map<string, ThreatAssessment>();
  const collect = () => { for (const a of tracker.drainChangedAssessments()) assessById.set(a.id, a); };
```

Call `collect()` once after the whole loop finishes AND inside the loop right after each `tracker.tick(...)` call (closes must be captured before a reopen reuses the category). Return:

```typescript
  return {
    events: region ? events.filter((e) => e.region === region) : events,
    vessels: tracker.states.size,
    messages,
    assessments: [...assessById.values()],
  };
```

Update the function's declared return type to include `assessments: ThreatAssessment[]` and import the type.

- [ ] **Step 4: Update broken existing tests**

`test/score.test.ts` — delete the `applyEventToScore` test and its import; keep the two `decayedScore` tests.

`test/pipeline.test.ts` — in `"end-to-end: loiterer over cable raises event and score"`, replace the two score assertions:

```typescript
    expect(s.categories.cable_interference.score).toBeGreaterThan(0);
```

(delete `expect(s.score).toBeGreaterThanOrEqual(3);` — `s.score` no longer exists).

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run test/pipeline-fusion.test.ts test/pipeline.test.ts test/score.test.ts test/replay.test.ts test/replay-region.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/pipeline.ts src/score.ts src/replay-core.ts test/pipeline-fusion.test.ts test/pipeline.test.ts test/score.test.ts
git commit -m "feat: pipeline routes events through fusion; drainChangedAssessments for persistence"
```

---

### Task 11: Persistence — migration, db.ts, TrackerDO wiring

**Files:**
- Create: `migrations/0004_assessments.sql`
- Modify: `src/db.ts`, `src/do/tracker.ts`
- Modify: `test/db.test.ts` (fix seeds)
- Test: `test/db-assessments.test.ts` (create)

**Interfaces:**
- Consumes: `ThreatAssessment`, `maxCategoryScore`, `newCategoryState`, `Tracker.drainChangedAssessments`.
- Produces:
  - D1 table `assessments` (schema below).
  - `PendingWrites.assessments: Map<string, ThreatAssessment>` (`newPendingWrites` initializes it; `flushWrites` upserts them).
  - `flushWrites` writes the legacy `vessels.score`/`score_ts` columns from `maxCategoryScore(s)` (keeps old dashboards/queries working; snapshot ordering no longer depends on it).
  - `loadOpenAssessments(db: D1Database): Promise<ThreatAssessment[]>` — all `status = 'open'` rows, evidence JSON-parsed.
  - `loadRecentVesselStates` no longer reads `score`/`score_ts`.
  - `TrackerDO`: hydrates open assessments into vessel states on start (`cs.score = confidence * 2`, `cs.ts = updated_ts`; creates a state if the vessel is not in the recent set); each alarm drains changed assessments into `pending.assessments` before flushing.

- [ ] **Step 1: Write the migration**

```sql
-- migrations/0004_assessments.sql — threat assessment fusion (spec §5).
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

- [ ] **Step 2: Write the failing test**

```typescript
// test/db-assessments.test.ts
import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { flushWrites, loadOpenAssessments, newPendingWrites } from "../src/db";
import { newVesselState, type ThreatAssessment } from "../src/types";

const T0 = 1_750_000_000_000;

const assessment = (over: Partial<ThreatAssessment> = {}): ThreatAssessment => ({
  id: `cable_interference-412000001-${T0}`, mmsi: 412000001, category: "cable_interference",
  status: "open", confidence: 0.45, openedTs: T0, updatedTs: T0, closedTs: null,
  evidence: [{ eventId: "loitering-412000001-1", type: "loitering", kind: null, weight: 0.45, ts: T0, summary: "loitered 3.0 h over C1 corridor" }],
  narrative: "Loitered 3.0 h over C1 corridor.", region: "tw", lastLon: 120.2, lastLat: 22.0, ...over,
});

describe("assessment persistence", () => {
  beforeEach(async () => {
    await env.DB.batch([env.DB.prepare("DELETE FROM assessments"), env.DB.prepare("DELETE FROM vessels")]);
  });

  it("flushWrites upserts assessments; loadOpenAssessments round-trips open ones", async () => {
    const p = newPendingWrites();
    p.assessments.set(assessment().id, assessment());
    await flushWrites(env.DB, p);

    // update in place (confidence bumps, still same id)
    const p2 = newPendingWrites();
    p2.assessments.set(assessment().id, assessment({ confidence: 0.62, updatedTs: T0 + 60_000 }));
    await flushWrites(env.DB, p2);

    const open = await loadOpenAssessments(env.DB);
    expect(open).toHaveLength(1);
    expect(open[0]).toMatchObject({ id: assessment().id, confidence: 0.62, category: "cable_interference", status: "open" });
    expect(open[0].evidence[0].summary).toContain("loitered");

    // closing removes it from the open set
    const p3 = newPendingWrites();
    p3.assessments.set(assessment().id, assessment({ status: "closed", closedTs: T0 + 100_000 }));
    await flushWrites(env.DB, p3);
    expect(await loadOpenAssessments(env.DB)).toHaveLength(0);
    const row = await env.DB.prepare("SELECT status, closed_ts FROM assessments").first<any>();
    expect(row).toEqual({ status: "closed", closed_ts: T0 + 100_000 });
  });

  it("flushWrites writes legacy vessels.score from the hottest category", async () => {
    const p = newPendingWrites();
    const s = newVesselState(412000001, T0);
    s.categories.cable_interference.score = 0.9;
    s.categories.cable_interference.ts = T0;
    s.ring.push({ mmsi: 412000001, lon: 120.2, lat: 22.0, sog: 0.5, cog: 90, heading: 90, ts: T0 });
    s.lastSeen = T0;
    p.vessels.set(s.mmsi, s);
    await flushWrites(env.DB, p);
    const v = await env.DB.prepare("SELECT score, score_ts FROM vessels WHERE mmsi = 412000001").first<any>();
    expect(v.score).toBeCloseTo(0.9);
    expect(v.score_ts).toBe(T0);
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run test/db-assessments.test.ts`
Expected: FAIL — no `assessments` property / table / `loadOpenAssessments`.

- [ ] **Step 4: Implement**

`src/db.ts`:

```typescript
import { maxCategoryScore } from "./fusion";
import { newVesselState, type AisPosition, type AnomalyEvent, type ThreatAssessment, type VesselState } from "./types";

export interface PendingWrites {
  positions: AisPosition[];
  events: AnomalyEvent[];
  vessels: Map<number, VesselState>;
  assessments: Map<string, ThreatAssessment>;
}

export function newPendingWrites(): PendingWrites {
  return { positions: [], events: [], vessels: new Map(), assessments: new Map() };
}
```

In `flushWrites`, the vessels statement keeps its SQL; change the bind to use the legacy score derived from categories:

```typescript
    const legacy = maxCategoryScore(s);
    stmts.push(db.prepare(/* unchanged SQL */).bind(s.mmsi, s.name, s.callsign, lp.lon, lp.lat, lp.sog, lp.cog, s.lastSeen, legacy.score, legacy.ts,
           s.region, s.shipType, s.destination, s.dimBow, s.dimStern, s.dimPort, s.dimStarboard));
```

Add after the events loop:

```typescript
  for (const a of p.assessments.values()) {
    stmts.push(db.prepare(
      `INSERT INTO assessments (id, mmsi, category, status, confidence, opened_ts, updated_ts, closed_ts, region, narrative, evidence)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)
       ON CONFLICT (id) DO UPDATE SET status = ?4, confidence = ?5, updated_ts = ?7, closed_ts = ?8, region = ?9, narrative = ?10, evidence = ?11`,
    ).bind(a.id, a.mmsi, a.category, a.status, a.confidence, a.openedTs, a.updatedTs, a.closedTs, a.region ?? null, a.narrative, JSON.stringify(a.evidence)));
  }
```

In `loadRecentVesselStates`, delete the line `s.score = r.score; s.scoreTs = r.score_ts;`.

Add:

```typescript
export async function loadOpenAssessments(db: D1Database): Promise<ThreatAssessment[]> {
  const { results } = await db.prepare(`SELECT * FROM assessments WHERE status = 'open'`).all<any>();
  return results.map((r) => ({
    id: r.id, mmsi: r.mmsi, category: r.category, status: r.status,
    confidence: r.confidence, openedTs: r.opened_ts, updatedTs: r.updated_ts, closedTs: r.closed_ts,
    evidence: JSON.parse(r.evidence ?? "[]"), narrative: r.narrative,
    region: r.region ?? null, lastLon: 0, lastLat: 0,
  }));
}
```

`src/do/tracker.ts` — extend the hydration in `ensureRunning` (after the states loop):

```typescript
      const open = await loadOpenAssessments(this.env.DB);
      for (const a of open) {
        let s = this.tracker.states.get(a.mmsi);
        if (!s) {
          s = newVesselState(a.mmsi, a.updatedTs);
          this.tracker.states.set(a.mmsi, s);
        }
        s.assessments[a.category] = a;
        const cs = s.categories[a.category];
        cs.score = a.confidence * 2; // inverse of confidenceFor; damping state resets on restart (accepted)
        cs.ts = a.updatedTs;
      }
```

Add imports for `loadOpenAssessments` (from `../db`) and `newVesselState` (from `../types`).

In `alarm()`, after the tick block (step 2) and before the flush (step 3):

```typescript
    for (const a of this.tracker.drainChangedAssessments()) this.pending.assessments.set(a.id, a);
```

Extend the flush guard: `if (this.pending.events.length || this.pending.positions.length || this.pending.vessels.size || this.pending.assessments.size)`.

(Write throttling: draining happens once per 30 s alarm, so each assessment writes at most twice a minute — within the spec's intent; no extra bookkeeping needed.)

- [ ] **Step 5: Fix `test/db.test.ts` seeds**

In `samplePending()`, replace `s.score = 6.5; s.scoreTs = T0;` with:

```typescript
  s.categories.cable_interference.score = 6.5;
  s.categories.cable_interference.ts = T0;
```

In the `loadRecentVesselStates` test, delete the line `expect(states[0].score).toBeCloseTo(6.5);`.

- [ ] **Step 6: Run tests to verify they pass**

Run: `npx vitest run test/db-assessments.test.ts test/db.test.ts test/db-regions.test.ts`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add migrations/0004_assessments.sql src/db.ts src/do/tracker.ts test/db-assessments.test.ts test/db.test.ts
git commit -m "feat: persist assessments to D1; hydrate open assessments on DO start"
```

---

### Task 12: Worker API — assessments feed, reshaped snapshot/vessel/stats/trajectories

**Files:**
- Modify: `src/worker.ts`, `src/config.ts` (remove `susScoreThreshold`)
- Modify: `test/api.test.ts`, `test/stats.test.ts`, `test/api-trajectories.test.ts`, `test/replay-trajectories.test.ts`, `test/api-regions.test.ts` (if it asserts score/activeEvents — adjust identically to api.test.ts)
- Test: `test/api-assessments.test.ts` (create)

**Interfaces:**
- Consumes: `assessments` table (Task 11), `THREAT_CATEGORIES`, `parseWindow`.
- Produces (response shapes the frontend consumes in Tasks 13–14):
  - `GET /api/assessments?region=&window=` → `{ generatedAt, assessments: [{ id, mmsi, category, status, confidence, openedTs, updatedTs, closedTs, region, narrative, evidence, lastLon, lastLat }] }` — open ones plus those closed within the window, `updated_ts` desc, limit 200. Bad region/window → 400.
  - `/api/snapshot` vessel properties: `{ mmsi, name, sog, cog, lastTs, region, shipType, assessments: [{category, confidence}], topCategory: string | null, maxConfidence: number, score }` where `score = Math.round(maxConfidence * 5 * 10) / 10` (legacy, kept one release). No more `activeEvents`/`topType`. Features sorted by `maxConfidence` desc.
  - `/api/vessel/:mmsi` → adds `assessments` array (open + closed, `updated_ts` desc, limit 20); vessel `score` legacy field = `maxConfidence * 5` from open assessments.
  - `/api/stats` → `activeAlerts` = open assessments per region; `histogram` counts = assessments by category per day, `counts` indexed by `THREAT_CATEGORIES` (length 4), keyed on `opened_ts`; `events24h` unchanged.
  - `/api/trajectories` → vessels with ≥1 open assessment, top 50 by max confidence; items `{ mmsi, name, confidence, topCategory, points }`.

- [ ] **Step 1: Write the failing test**

```typescript
// test/api-assessments.test.ts
import { env, SELF } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";

const NOW = Date.now();
const H = 3_600_000;

const seedAssessment = (id: string, mmsi: number, category: string, status: string, confidence: number, updatedTs: number, closedTs: number | null, region = "tw") =>
  env.DB.prepare(`INSERT INTO assessments (id, mmsi, category, status, confidence, opened_ts, updated_ts, closed_ts, region, narrative, evidence)
                  VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6, ?7, ?8, 'Loitered 3.0 h over C1 corridor.', '[]')`)
    .bind(id, mmsi, category, status, confidence, updatedTs, closedTs, region);

describe("/api/assessments", () => {
  beforeEach(async () => {
    await env.DB.batch([
      env.DB.prepare("DELETE FROM assessments"), env.DB.prepare("DELETE FROM vessels"),
      seedAssessment("cable_interference-1-1", 416000001, "cable_interference", "open", 0.62, NOW - H, null, "tw"),
      seedAssessment("dark_activity-2-1", 440000002, "dark_activity", "open", 0.3, NOW - 2 * H, null, "kr"),
      seedAssessment("identity_deception-3-1", 416000003, "identity_deception", "closed", 0.1, NOW - 2 * H, NOW - 2 * H, "tw"),
      seedAssessment("cable_interference-4-1", 416000004, "cable_interference", "closed", 0.05, NOW - 40 * 24 * H, NOW - 40 * 24 * H, "tw"),
    ]);
  });

  it("returns open + recently-closed assessments, newest first", async () => {
    const res = await SELF.fetch("https://x/api/assessments?window=week");
    expect(res.status).toBe(200);
    const body = await res.json<any>();
    const ids = body.assessments.map((a: any) => a.id);
    expect(ids).toContain("cable_interference-1-1");
    expect(ids).toContain("identity_deception-3-1"); // closed within window
    expect(ids).not.toContain("cable_interference-4-1"); // closed 40 d ago
    const a = body.assessments.find((x: any) => x.id === "cable_interference-1-1");
    expect(a).toMatchObject({ mmsi: 416000001, category: "cable_interference", status: "open", confidence: 0.62 });
    expect(a.narrative).toContain("Loitered");
  });

  it("filters by region and validates params", async () => {
    const kr = await (await SELF.fetch("https://x/api/assessments?region=kr&window=week")).json<any>();
    expect(kr.assessments).toHaveLength(1);
    expect(kr.assessments[0].category).toBe("dark_activity");
    expect((await SELF.fetch("https://x/api/assessments?region=zz")).status).toBe(400);
    expect((await SELF.fetch("https://x/api/assessments?window=year")).status).toBe(400);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/api-assessments.test.ts`
Expected: FAIL — 404 from the endpoint.

- [ ] **Step 3: Implement `src/worker.ts`**

Remove the now-unused `decayedScore` import and add:

```typescript
import { THREAT_CATEGORIES } from "./types";
```

Add a row mapper next to `rowToEvent`:

```typescript
const rowToAssessment = (r: any) => ({
  id: r.id, mmsi: r.mmsi, category: r.category, status: r.status,
  confidence: r.confidence, openedTs: r.opened_ts, updatedTs: r.updated_ts, closedTs: r.closed_ts,
  region: r.region ?? null, narrative: r.narrative, evidence: JSON.parse(r.evidence ?? "[]"),
});
```

Add the endpoint (before `/api/snapshot`):

```typescript
    if (url.pathname === "/api/assessments") {
      const region = regionParam(url);
      if (region === null) return json({ error: "bad region" }, 400);
      const winMs = parseWindow(url.searchParams.get("window"));
      if (winMs === null) return json({ error: "bad window" }, 400);
      const base = `SELECT * FROM assessments WHERE (status = 'open' OR closed_ts >= ?1)`;
      const { results } = region
        ? await env.DB.prepare(`${base} AND region = ?2 ORDER BY updated_ts DESC LIMIT 200`).bind(now - winMs, region).all<any>()
        : await env.DB.prepare(`${base} ORDER BY updated_ts DESC LIMIT 200`).bind(now - winMs).all<any>();
      return json({ generatedAt: now, assessments: results.map(rowToAssessment) });
    }
```

**Snapshot** — replace the `baseSelect`/scoring block with:

```typescript
      const baseSelect = `
        SELECT v.*, a.cats FROM vessels v
        LEFT JOIN (
          SELECT mmsi, json_group_array(json_object('category', category, 'confidence', confidence)) AS cats
          FROM assessments WHERE status = 'open' GROUP BY mmsi
        ) a ON a.mmsi = v.mmsi`;
      const { results } = region
        ? await env.DB.prepare(`${baseSelect} WHERE v.last_ts >= ?1 AND v.region = ?2`).bind(now - CONFIG.snapshotWindowMs, region).all<any>()
        : await env.DB.prepare(`${baseSelect} WHERE v.last_ts >= ?1`).bind(now - CONFIG.snapshotWindowMs).all<any>();
      const withAssess = results.map((r) => {
        const assessments: { category: string; confidence: number }[] = JSON.parse(r.cats ?? "[]");
        assessments.sort((a, b) => b.confidence - a.confidence);
        return { ...r, assessments, maxConfidence: assessments[0]?.confidence ?? 0, topCategory: assessments[0]?.category ?? null };
      }).sort((a, b) => b.maxConfidence - a.maxConfidence);
```

and the feature properties become:

```typescript
            properties: {
              mmsi: r.mmsi, name: r.name, sog: r.last_sog, cog: r.last_cog,
              lastTs: r.last_ts, region: r.region ?? null, shipType: r.ship_type ?? null,
              assessments: r.assessments, topCategory: r.topCategory,
              maxConfidence: r.maxConfidence,
              score: Math.round(r.maxConfidence * 5 * 10) / 10, // legacy, remove next release
            },
```

(iterate `withAssess` instead of `results`; `newestTs` reduce moves to `withAssess`).

**Vessel dossier** — after the events query add:

```typescript
      const assess = await env.DB.prepare(`SELECT * FROM assessments WHERE mmsi = ?1 ORDER BY updated_ts DESC LIMIT 20`).bind(mmsi).all<any>();
      const assessments = assess.results.map(rowToAssessment);
      const maxConfidence = Math.max(0, ...assessments.filter((a) => a.status === "open").map((a) => a.confidence));
```

Response: add `assessments,` at top level and replace the vessel `score` line with `score: Math.round(maxConfidence * 5 * 10) / 10,`.

**Stats** — replace the `ac` statement with:

```typescript
        env.DB.prepare(`SELECT region, COUNT(*) AS c FROM assessments WHERE status = 'open' AND region IS NOT NULL GROUP BY region`),
```

and the `hist` statement with:

```typescript
        env.DB.prepare(`SELECT region, category, date(opened_ts / 1000, 'unixepoch') AS d, COUNT(*) AS c
                        FROM assessments WHERE opened_ts >= ?1 AND region IS NOT NULL GROUP BY region, category, d`)
          .bind(now - 13 * DAY - (now % DAY)),
```

Histogram buckets initialize with `counts: [0, 0, 0, 0]` and fill via:

```typescript
      for (const row of hist.results as any[]) {
        const bucket = histogram[row.region]?.find((b) => b.day === row.d);
        const idx = THREAT_CATEGORIES.indexOf(row.category);
        if (bucket && idx >= 0) bucket.counts[idx] = row.c;
      }
```

**Trajectories** — replace the `susSelect` block through the `sus` computation with:

```typescript
      const susSelect = `
        SELECT v.mmsi, v.name, a.max_conf, a.top_category
        FROM vessels v
        JOIN (
          SELECT mmsi, MAX(confidence) AS max_conf,
                 (SELECT a2.category FROM assessments a2
                  WHERE a2.mmsi = a.mmsi AND a2.status = 'open'
                  ORDER BY a2.confidence DESC LIMIT 1) AS top_category
          FROM assessments a WHERE a.status = 'open' GROUP BY a.mmsi
        ) a ON a.mmsi = v.mmsi`;
      const { results } = region
        ? await env.DB.prepare(`${susSelect} WHERE v.region = ?1`).bind(region).all<any>()
        : await env.DB.prepare(susSelect).all<any>();
      const sus = results
        .sort((a, b) => b.max_conf - a.max_conf)
        .slice(0, CONFIG.trajectoryMaxVessels);
```

Update the positions query placeholders (`?${i + 2}` becomes `?${i + 2}` with `now - winMs` still `?1` — unchanged) and the response mapping:

```typescript
        trajectories: sus.map((s) => ({
          mmsi: s.mmsi, name: s.name,
          confidence: s.max_conf,
          topCategory: s.top_category ?? null,
          points: decimatePoints(byMmsi.get(s.mmsi) ?? [], CONFIG.trajectoryMaxPoints),
        })).filter((t) => t.points.length >= 2),
```

Remove `susScoreThreshold` from `src/config.ts`.

- [ ] **Step 4: Update the existing API tests**

`test/api.test.ts` — in `seed()`, add an assessment row so snapshot assertions have data:

```typescript
    env.DB.prepare(`DELETE FROM assessments`),
    env.DB.prepare(`INSERT INTO assessments (id, mmsi, category, status, confidence, opened_ts, updated_ts, closed_ts, region, narrative, evidence)
                    VALUES ('cable_interference-412000001-1', 412000001, 'cable_interference', 'open', 0.62, ?1, ?1, NULL, 'tw', 'Loitered 3.0 h over C1 corridor.', '[]')`).bind(T0),
```

In the snapshot test, replace `expect(f.properties.score).toBeGreaterThan(0);` with:

```typescript
    expect(f.properties.maxConfidence).toBeCloseTo(0.62);
    expect(f.properties.topCategory).toBe("cable_interference");
    expect(f.properties.assessments).toEqual([{ category: "cable_interference", confidence: 0.62 }]);
```

`test/api-regions.test.ts` needs **no changes**: its assertions cover only region/shipType/static-dimension fields via `toMatchObject` (which tolerates the added `assessments` field), and it never references `score`, `activeEvents`, or `topType`. If `api.test.ts` has further assertions on those three removed snapshot properties beyond the one replaced above, update each to the corresponding new field (`assessments` / `topCategory` / `maxConfidence`).

`test/stats.test.ts` — replace the seeded open/old events' role in `activeAlerts` with assessments. Add to `beforeEach`:

```typescript
      env.DB.prepare("DELETE FROM assessments"),
      env.DB.prepare(`INSERT INTO assessments (id, mmsi, category, status, confidence, opened_ts, updated_ts, closed_ts, region, narrative, evidence)
                      VALUES ('dark_activity-440000001-1', 440000001, 'dark_activity', 'open', 0.4, ?1, ?1, NULL, 'kr', 'x', '[]')`).bind(T0),
      env.DB.prepare(`INSERT INTO assessments (id, mmsi, category, status, confidence, opened_ts, updated_ts, closed_ts, region, narrative, evidence)
                      VALUES ('cable_interference-440000001-1', 440000001, 'cable_interference', 'closed', 0.1, ?1, ?1, ?1, 'kr', 'x', '[]')`).bind(NOW - 3 * DAY),
```

and update assertions:

```typescript
    expect(body.regions.kr).toEqual({ vessels: 1, activeAlerts: 1, events24h: 1 });
    ...
    expect(kr.every((b: any) => /^\d{4}-\d{2}-\d{2}$/.test(b.day) && b.counts.length === 4)).toBe(true);
    const t0Day = new Date(T0).toISOString().slice(0, 10);
    expect(kr.find((b: any) => b.day === t0Day)!.counts[1]).toBe(1);      // dark_activity index 1
    const threeAgo = new Date(NOW - 3 * DAY).toISOString().slice(0, 10);
    expect(kr.find((b: any) => b.day === threeAgo)!.counts[0]).toBe(1);   // cable_interference index 0
```

`test/api-trajectories.test.ts` — replace the event/score seeding with assessments. Replace the `beforeEach` vessel/event seeds A–D with:

```typescript
      env.DB.prepare("DELETE FROM assessments"),
      vessel(500000001, "EVENT SHIP", 0, NOW),
      env.DB.prepare(`INSERT INTO assessments (id, mmsi, category, status, confidence, opened_ts, updated_ts, closed_ts, region, narrative, evidence)
                      VALUES ('cable_interference-500000001-1', 500000001, 'cable_interference', 'open', 0.62, ?1, ?1, NULL, 'tw', 'x', '[]')`).bind(NOW - H),
      vessel(500000002, "SCORE SHIP", 5, NOW),
      env.DB.prepare(`INSERT INTO assessments (id, mmsi, category, status, confidence, opened_ts, updated_ts, closed_ts, region, narrative, evidence)
                      VALUES ('dark_activity-500000002-1', 500000002, 'dark_activity', 'open', 0.3, ?1, ?1, NULL, 'tw', 'x', '[]')`).bind(NOW - H),
      vessel(500000003, "FADED SHIP", 5, NOW - 3 * D),   // no assessment → calm
      vessel(500000004, "CALM SHIP", 0, NOW),            // no assessment → calm
```

First test's assertions become:

```typescript
    expect(Object.keys(byMmsi).map(Number).sort()).toEqual([500000001, 500000002]);
    expect(byMmsi[500000001].topCategory).toBe("cable_interference");
    expect(byMmsi[500000001].confidence).toBeCloseTo(0.62);
```

The top-50 test seeds assessments instead of scores:

```typescript
      stmts.push(env.DB.prepare(`INSERT INTO assessments (id, mmsi, category, status, confidence, opened_ts, updated_ts, closed_ts, region, narrative, evidence)
                                 VALUES (?1, ?2, 'cable_interference', 'open', ?3, ?4, ?4, NULL, 'tw', 'x', '[]')`)
        .bind(`cable_interference-${mmsi}-1`, mmsi, 0.3 + i * 0.01, NOW - H));
```

and asserts `const scores = body.trajectories.map((t: any) => t.confidence);` descending.

`test/replay-trajectories.test.ts` — the capture's lone loiter is a single medium signal and correctly does NOT open an assessment now; the test seeds the endpoint's inputs directly. Replace the `INSERT INTO events` statement with an assessment seed:

```typescript
      env.DB.prepare("DELETE FROM assessments"),
      env.DB.prepare(`INSERT INTO assessments (id, mmsi, category, status, confidence, opened_ts, updated_ts, closed_ts, region, narrative, evidence)
                      VALUES (?1, ?2, 'cable_interference', 'open', 0.45, ?3, ?3, NULL, ?4, 'Loitering over corridor.', '[]')`)
        .bind(`cable_interference-${loiter.mmsi}-1`, loiter.mmsi, loiter.startTs + shift, loiter.region ?? null),
```

and change `expect(t.topType).toBe("loitering")` to `expect(t.topCategory).toBe("cable_interference")`.

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run test/api-assessments.test.ts test/api.test.ts test/api-regions.test.ts test/stats.test.ts test/api-trajectories.test.ts test/replay-trajectories.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/worker.ts src/config.ts test/
git commit -m "feat: assessment-driven API — /api/assessments; snapshot/vessel/stats/trajectories reshaped"
```

---

### Task 13: Frontend — assessment feed, category chips, stats/timeline

**Files:**
- Create: `web/src/assess.ts`
- Modify: `web/src/api.ts`, `web/src/panels.ts:124-201`, `web/src/stats.ts:18-20`, `web/src/timeline.ts:6,29-40`
- Test: `test/web-assess.test.ts` (create)

**Interfaces:**
- Consumes: `/api/assessments` (Task 12 shape).
- Produces:
  - `web/src/api.ts`: `Assessment`, `AssessmentsResponse` interfaces; `fetchAssessments(region?: string, window?: string)`; `VesselProps` gains `assessments/topCategory/maxConfidence`; `TrajectoryVessel` becomes `{ mmsi, name, confidence, topCategory, points }`; `Dossier` gains `assessments: Assessment[]`.
  - `web/src/assess.ts`: `CATEGORY_LABEL` (short chip names), `CATEGORY_LONG`, `CATEGORY_COLOR` (Global Constraints colors), `confidencePct(c)`, `renderAssessmentItem(a): string` (pure — feed `<li>` with badge, confidence, narrative, time), `renderAssessmentCard(a): string` (dossier card).
  - Feed lists assessments; chips are `All | Cable | Dark | Identity` filtering by `category`; hash `filter` now stores a category id.

- [ ] **Step 1: Write the failing test**

```typescript
// test/web-assess.test.ts
import { describe, expect, it } from "vitest";
import { CATEGORY_COLOR, CATEGORY_LABEL, confidencePct, renderAssessmentItem } from "../web/src/assess";
import type { Assessment } from "../web/src/api";

const a: Assessment = {
  id: "cable_interference-416000001-1", mmsi: 416000001, category: "cable_interference", status: "open",
  confidence: 0.62, openedTs: 1_750_000_000_000, updatedTs: 1_750_000_100_000, closedTs: null,
  evidence: [{ eventId: "loitering-416000001-1", type: "loitering", kind: null, weight: 0.45, ts: 1_750_000_000_000, summary: "loitered 3.2 h over C1 corridor" }],
  narrative: "Loitered 3.2 h over C1 corridor.", region: "tw", lastLon: 120.2, lastLat: 22.0,
};

describe("assessment rendering helpers", () => {
  it("has a label and color for every category", () => {
    for (const c of ["cable_interference", "dark_activity", "identity_deception", "militia_presence"]) {
      expect(CATEGORY_LABEL[c]).toBeTruthy();
      expect(CATEGORY_COLOR[c]).toMatch(/^#[0-9a-f]{6}$/);
    }
  });

  it("formats confidence as a percentage", () => {
    expect(confidencePct(0.62)).toBe("62%");
    expect(confidencePct(1)).toBe("100%");
  });

  it("renders a feed item with badge, narrative, mmsi, and data attributes for click-to-fly", () => {
    const html = renderAssessmentItem(a);
    expect(html).toContain("Cable");
    expect(html).toContain("62%");
    expect(html).toContain("Loitered 3.2 h over C1 corridor.");
    expect(html).toContain(`data-mmsi="416000001"`);
    expect(html).toContain(`data-lon="120.2"`);
    expect(html).toContain("ongoing"); // open assessment
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/web-assess.test.ts`
Expected: FAIL — `web/src/assess.ts` not found.

- [ ] **Step 3: Implement**

`web/src/api.ts` — add:

```typescript
export interface AssessmentEvidence { eventId: string; type: string; kind: string | null; weight: number; ts: number; summary: string }
export interface Assessment {
  id: string; mmsi: number; category: string; status: "open" | "closed";
  confidence: number; openedTs: number; updatedTs: number; closedTs: number | null;
  evidence: AssessmentEvidence[]; narrative: string; region: string | null; lastLon: number; lastLat: number;
}
export interface AssessmentsResponse { generatedAt: number; assessments: Assessment[] }
export const fetchAssessments = (region?: string, window?: string) =>
  get<AssessmentsResponse>(`/api/assessments?${region ? `region=${region}&` : ""}window=${window ?? "day"}`);
```

Update `VesselProps` to `{ mmsi: number; name: string | null; sog: number; cog: number; score: number; lastTs: number; region: string | null; shipType: number | null; assessments: { category: string; confidence: number }[]; topCategory: string | null; maxConfidence: number }`, `TrajectoryVessel` to `{ mmsi: number; name: string | null; confidence: number; topCategory: string | null; points: [number, number, number][] }`, and add `assessments: Assessment[];` to `Dossier`.

`web/src/assess.ts`:

```typescript
// web/src/assess.ts — category presentation + pure assessment rendering (testable without DOM).
import type { Assessment } from "./api";

export const CATEGORY_LABEL: Record<string, string> = {
  cable_interference: "Cable", dark_activity: "Dark", identity_deception: "Identity", militia_presence: "Militia",
};
export const CATEGORY_LONG: Record<string, string> = {
  cable_interference: "Cable interference", dark_activity: "Dark activity",
  identity_deception: "Identity deception", militia_presence: "Militia pattern",
};
export const CATEGORY_COLOR: Record<string, string> = {
  cable_interference: "#e5484d", dark_activity: "#b18cff", identity_deception: "#f0a83c", militia_presence: "#4cc3ff",
};

export const confidencePct = (c: number): string => `${Math.round(c * 100)}%`;

const esc = (s: unknown) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]!));
const fmtTime = (ts: number) => new Date(ts).toISOString().replace("T", " ").slice(0, 16) + "Z";

export function renderAssessmentItem(a: Assessment): string {
  const color = CATEGORY_COLOR[a.category] ?? "#aab6c8";
  return `<li data-lon="${a.lastLon}" data-lat="${a.lastLat}" data-mmsi="${a.mmsi}">
    <span class="cat-badge" style="background:${color}">${CATEGORY_LABEL[a.category] ?? a.category}</span>
    <b>${confidencePct(a.confidence)}</b> — MMSI ${a.mmsi}${a.status === "open" ? " · ongoing" : ""}
    <div class="narrative">${esc(a.narrative)}</div>
    <time>${fmtTime(a.updatedTs)}</time></li>`;
}

export function renderAssessmentCard(a: Assessment): string {
  const color = CATEGORY_COLOR[a.category] ?? "#aab6c8";
  return `<div class="assess-card" style="border-left:3px solid ${color}">
    <div><span class="cat-badge" style="background:${color}">${esc(CATEGORY_LONG[a.category] ?? a.category)}</span>
      <b>${confidencePct(a.confidence)}</b> · ${a.status === "open" ? "ongoing" : `closed ${fmtTime(a.closedTs!)}`}</div>
    <div class="narrative">${esc(a.narrative)}</div>
    <ul>${a.evidence.map((e) => `<li><a href="#" data-event="${esc(e.eventId)}">${esc(e.summary)}</a></li>`).join("")}</ul>
  </div>`;
}
```

`web/src/panels.ts` — rework `initEventFeed` (keep the map-source setup, GFW crumb code, and the click-to-fly handler; they are unchanged):

- Replace `allTypes` and chips with categories:

```typescript
  const allCats = ["All", "cable_interference", "dark_activity", "identity_deception"];
```

using `CATEGORY_LABEL` for chip labels (import from `./assess`).

- Replace the `poll` body:

```typescript
  const poll = async () => {
    try {
      const f = getDayFilter();
      const res = await fetchAssessments(getRegion(), getWindow());
      let items = res.assessments;
      if (f) items = items.filter((a) => a.openedTs >= f.startTs && a.openedTs < f.endTs);
      if (activeFilter) items = items.filter((a) => a.category === activeFilter);
      list.innerHTML = items.map(renderAssessmentItem).join("") ||
        `<li>${f ? `No assessments on ${f.day}` : "No open assessments"}</li>`;
    } catch (err) { console.error("assessment feed failed:", err); }
  };
```

(import `fetchAssessments` from `./api`; `fetchEvents` import can be dropped once nothing else uses it; `renderEvent` and `TYPE_LABEL` stay for the dossier timeline.)

Add a minimal style block to `web/style.css`:

```css
.cat-badge { border-radius: 3px; padding: 0 5px; font-size: 10px; color: #0b1220; font-weight: 700; }
.narrative { color: #aab6c8; font-size: 11px; margin: 2px 0; }
.assess-card { margin: 6px 0; padding: 6px 8px; background: rgba(255,255,255,0.03); }
```

`web/src/stats.ts` — change the middle span to `<b>${s.activeAlerts}</b> open assessments`.

`web/src/timeline.ts` — replace `SEV_COLOR` with category colors in `THREAT_CATEGORIES` order and update the title text:

```typescript
const CAT_COLOR = ["#e5484d", "#b18cff", "#f0a83c", "#4cc3ff"]; // THREAT_CATEGORIES order
```

(use `CAT_COLOR[sev]` where `sev` is now the category index; rename the loop variable to `idx` for clarity; `<title>` text becomes `${b.day}: ${…} assessments`.)

- [ ] **Step 4: Run tests and build to verify**

Run: `npx vitest run test/web-assess.test.ts && npm run build:web`
Expected: test PASS; Vite build succeeds with no type errors.

- [ ] **Step 5: Commit**

```bash
git add web/src/assess.ts web/src/api.ts web/src/panels.ts web/src/stats.ts web/src/timeline.ts web/style.css test/web-assess.test.ts
git commit -m "feat: assessment feed with category chips; stats/timeline count assessments"
```

---

### Task 14: Frontend — map halos, trajectories, dossier assessments

**Files:**
- Modify: `web/src/vessels.ts:11-18,95-133`, `web/src/trajectories.ts:10,16-37`, `web/src/panels.ts:53-111`
- Test: existing `test/web-dossier.test.ts` (run; update only if it asserts removed fields), visual check via `npm run build:web`

**Interfaces:**
- Consumes: snapshot properties `maxConfidence`/`topCategory` (Task 12), `CATEGORY_COLOR` (Task 13), `Dossier.assessments`.
- Produces: sus styling driven by open assessments — colored by top category, halo opacity by confidence; trajectory lines colored by category with confidence opacity; dossier shows assessment cards above the raw event timeline with evidence → event anchor links.

- [ ] **Step 1: Update `web/src/vessels.ts`**

Replace the expression constants (lines 11–18):

```typescript
// A vessel is "sus" when it has at least one open threat assessment.
const SUS_ACTIVE = [">", ["coalesce", ["get", "maxConfidence"], 0], 0] as any;
// Colored by top assessment category; calm traffic stays grey.
const CAT_MATCH = ["match", ["coalesce", ["get", "topCategory"], ""],
  "cable_interference", "#e5484d", "dark_activity", "#b18cff",
  "identity_deception", "#f0a83c", "militia_presence", "#4cc3ff", "#e5484d"] as any;
const COLOR = ["case", SUS_ACTIVE, CAT_MATCH, "#aab6c8"] as any;
const HAS_HEADING = ["all", ["has", "cog"], [">=", ["coalesce", ["get", "sog"], 0], 0.5]] as any;
```

In the `sus-halo` layer, color the ring by category and scale opacity with confidence:

```typescript
    paint: {
      "circle-radius": 10, "circle-color": "transparent",
      "circle-stroke-color": CAT_MATCH, "circle-stroke-width": 2,
      "circle-stroke-opacity": ["interpolate", ["linear"], ["coalesce", ["get", "maxConfidence"], 0], 0.2, 0.4, 1, 0.95],
    },
```

In `startPulse()`, change the animated property floor to respect the same base (replace the `0.9 - 0.6 * s` line):

```typescript
      map.setPaintProperty("sus-halo", "circle-stroke-opacity", Math.max(0.2, 0.9 - 0.6 * s));
```

- [ ] **Step 2: Update `web/src/trajectories.ts`**

Replace `SCORE_RAMP` and the feature properties:

```typescript
const CAT_MATCH = ["match", ["coalesce", ["get", "topCategory"], ""],
  "cable_interference", "#e5484d", "dark_activity", "#b18cff",
  "identity_deception", "#f0a83c", "militia_presence", "#4cc3ff", "#e5484d"] as any;
```

Use `CAT_MATCH` for both layers' `line-color`, and set feature properties to:

```typescript
        properties: { mmsi: t.mmsi, name: t.name ?? `MMSI ${t.mmsi}`, confidence: t.confidence, topCategory: t.topCategory },
```

Scale base-layer opacity: `"line-opacity": ["interpolate", ["linear"], ["get", "confidence"], 0.2, 0.35, 1, 0.8]`.

- [ ] **Step 3: Update the dossier in `web/src/panels.ts`**

Import `renderAssessmentCard` from `./assess`. In `selectVessel`'s render, insert an assessments section directly under the identity line (before "Detector breakdown"), and give timeline items anchors:

```typescript
      <h3>Threat assessments</h3>
      ${d.assessments.length ? d.assessments.map(renderAssessmentCard).join("") : "<div>No assessments</div>"}
```

Change the event-timeline `<li>` template to `<li id="ev-${esc(e.id)}">…` and add one delegated click handler after `panel.hidden = false;`:

```typescript
    body.querySelectorAll("a[data-event]").forEach((el) => el.addEventListener("click", (ev) => {
      ev.preventDefault();
      document.getElementById(`ev-${(el as HTMLElement).dataset.event}`)?.scrollIntoView({ behavior: "smooth", block: "center" });
    }));
```

Also replace the big score `<div class="score">${v.score}</div>` with the top assessment confidence:

```typescript
      <div class="score">${d.assessments.some((a) => a.status === "open") ? Math.round(Math.max(...d.assessments.filter((a) => a.status === "open").map((a) => a.confidence)) * 100) + "%" : "—"}</div>
```

- [ ] **Step 4: Verify**

Run: `npx vitest run test/web-dossier.test.ts test/web-health.test.ts test/web-regions.test.ts test/web-windows.test.ts && npm run build:web`
Expected: PASS + clean build (`web-dossier.test.ts` tests only the MID/ship-type helpers and is unaffected).

- [ ] **Step 5: Commit**

```bash
git add web/src/vessels.ts web/src/trajectories.ts web/src/panels.ts
git commit -m "feat: map halos, trajectories, dossier driven by threat assessments"
```

---

### Task 15: End-to-end replay regressions + full verification

**Files:**
- Test: `test/replay-fusion.test.ts` (create)
- Verify: whole repo

**Interfaces:**
- Consumes: everything above; `replayCapture` assessments output (Task 10).
- Produces: executable proof of the spec §8 scenarios.

- [ ] **Step 1: Write the regression test**

```typescript
// test/replay-fusion.test.ts — spec §8: live-data false positives stay quiet; corroborated threats alert.
import { describe, expect, it } from "vitest";
import { GeoContext } from "../src/geo/context";
import { replayCapture } from "../src/replay-core";

const cables = { type: "FeatureCollection", features: [{ type: "Feature", properties: { name: "C1", approximate: true }, geometry: { type: "LineString", coordinates: [[120.0, 22.0], [121.0, 22.0]] } }] };
const noFc = { type: "FeatureCollection", features: [] };
const geo = new GeoContext(cables as any, noFc as any, 1000, noFc as any, 5000);

const T0 = Date.parse("2026-07-10T00:00:00Z");
const aisTime = (ts: number) => new Date(ts).toISOString().replace("T", " ").replace(/\.\d+Z$/, ".000000 +0000 UTC");
const posLine = (mmsi: number, lon: number, lat: number, sog: number, cog: number, tMin: number, navStatus = 0) =>
  JSON.stringify({
    MessageType: "PositionReport",
    MetaData: { MMSI: mmsi, latitude: lat, longitude: lon, time_utc: aisTime(T0 + tMin * 60_000) },
    Message: { PositionReport: { Sog: sog, Cog: cog, TrueHeading: cog, NavigationalStatus: navStatus } },
  });

describe("fusion end-to-end via replay", () => {
  it("moored ferry with COG jitter all night produces no events and no assessments", () => {
    const lines: string[] = [];
    for (let m = 0; m < 8 * 60; m += 10) lines.push(posLine(431000001, 139.75, 35.45, 0.2, (m * 37) % 360, m, 5));
    const r = replayCapture(lines, geo);
    expect(r.events).toHaveLength(0);
    expect(r.assessments).toHaveLength(0);
  });

  it("vessel that sails off the coverage edge and goes silent opens no gap", () => {
    const lines: string[] = [];
    for (let m = 0; m <= 50; m += 10) lines.push(posLine(431000002, 141.3 + m * 0.002, 34.0, 12, 90, m)); // heading for jp maxLon 141.5
    lines.push(posLine(431000002, 141.45, 34.0, 12, 90, 60));
    lines.push(posLine(431000002, 141.45, 34.01, 12, 90, 600)); // reappears 9 h later (was outside coverage)
    const r = replayCapture(lines, geo);
    expect(r.events.filter((e) => e.type === "ais_gap")).toHaveLength(0);
  });

  it("loiter over corridor + dark gap with repositioning opens cable_interference with a narrative", () => {
    const lines: string[] = [];
    for (let m = 0; m <= 150; m += 10) lines.push(posLine(416000003, 120.2, 22.0, 0.5, 90, m));  // 2.5 h loiter on C1
    lines.push(posLine(416000003, 120.45, 22.0, 8, 90, 150 + 130));                              // dark 2+ h, back 25 km away
    const r = replayCapture(lines, geo);
    const cable = r.assessments.find((a) => a.category === "cable_interference");
    expect(cable).toBeDefined();
    expect(cable!.status).toBe("open");
    expect(cable!.evidence.length).toBeGreaterThanOrEqual(2);
    expect(cable!.narrative).toMatch(/loitered .* corridor/i);
    expect(cable!.narrative).toContain("went dark");
    // single dark signal: dark_activity must NOT be among the assessments
    expect(r.assessments.find((a) => a.category === "dark_activity")).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run the regression test**

Run: `npx vitest run test/replay-fusion.test.ts`
Expected: PASS (everything was built in Tasks 1–12). Debug any failure before proceeding — this is the spec's acceptance test.

- [ ] **Step 3: Full verification**

Run: `npx tsc -p tsconfig.json --noEmit && npm test`
Expected: type check clean; entire suite PASS.

- [ ] **Step 4: Commit**

```bash
git add test/replay-fusion.test.ts
git commit -m "test: end-to-end fusion regressions from live false-positive scenarios"
```

- [ ] **Step 5 (manual, post-merge): apply the migration and deploy**

```bash
npx wrangler d1 migrations apply DB --remote
npm run deploy
```

Then verify on the live site: `/api/stats` `activeAlerts` should be in the tens per region within a day, and every red vessel's dossier should show a readable narrative.
