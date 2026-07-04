# Taiwan Cable-Guard Map Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A public, embeddable, permalink-able real-time map of ships behaving suspiciously near Taiwan's submarine cables, running Cloudflare-native at ~$5/mo.

**Architecture:** A single Cloudflare Worker project hosts everything: `TrackerDO` (Durable Object) holds the AISStream.io websocket and per-vessel hot state and runs four pure-TypeScript detectors per message; D1 persists vessels/positions/events; a daily cron pulls Global Fishing Watch corroboration events; the same Worker serves API routes and the static MapLibre frontend via Workers Static Assets (this fulfils the spec's "Pages" role with one fewer deploy target — Workers Assets is Cloudflare's successor to Pages for this shape).

**Tech Stack:** TypeScript, Cloudflare Workers + Durable Objects + D1 + Static Assets, wrangler v4, Vitest + @cloudflare/vitest-pool-workers, Vite, MapLibre GL JS, OpenFreeMap tiles.

**Spec:** `docs/superpowers/specs/2026-07-04-taiwan-cable-guard-map-design.md`

## Global Constraints

- All detector logic is pure TypeScript, signature shape `(vesselState, newMessage, geoContext) → Event[]` — no I/O inside detectors.
- All tunable thresholds live in ONE file: `src/config.ts`.
- Event severity is an integer 1–5. Suspicion score = decayed aggregate of recent event severities (half-life in config).
- Cable-corridor buffer: ~1 km around route geometry (`corridorBufferM: 1000`).
- Loitering: SOG < 2 kn continuously > 2 h inside corridor buffer; suppressed inside exclusion polygons.
- AIS gap: silent > 1 h; severity boosted if gap starts/ends in a corridor or reappearance implies impossible speed.
- Anchor-drag: SOG < ~3 kn with high heading/COG variance directly over a cable route.
- Positions retention: 30 days. Frontend poll: ~15 s. Staleness banner threshold: 5 min.
- Websocket reconnect backoff 1 s → 60 s cap; watchdog forces reconnect if no message for 2 min; DO alarm every 30 s.
- One malformed AIS message must never kill the stream handler (per-message try/catch).
- D1 writes are batched; a failed batch is retried on the next alarm tick.
- Every API response includes `generatedAt` (ms epoch).
- Matsu/Penghu domestic cable lines are approximate — must carry `"approximate": true` and be labeled "approximate" in the UI.
- Timestamps are **ms since epoch** everywhere in code; SOG is knots; coordinates are `[lon, lat]` order in all internal APIs and GeoJSON.
- Secrets: `AISSTREAM_KEY`, `GFW_TOKEN` via `wrangler secret put` — never committed.
- Out of scope (v1): auth, push alerting, satellite AIS ingestion (keep feed parsing in its own module so another poller can be added), >30-day analytics, non-Taiwan AOI.

---

## File Structure

```
package.json / tsconfig.json / vitest.config.ts / wrangler.jsonc
migrations/0001_init.sql            — D1 schema
data/cables.json                    — cable corridors GeoJSON (starter, approximate)
data/exclusions.json                — anchorage/port exclusion polygons GeoJSON
src/config.ts                       — ALL tunable thresholds
src/types.ts                        — AisPosition, AisIdentity, AnomalyEvent, VesselState
src/geo/geo.ts                      — haversine, point-to-polyline distance, point-in-polygon
src/geo/context.ts                  — GeoContext (inCorridor / inExclusion / nearestCorridor)
src/detectors/loitering.ts          — detector 1
src/detectors/gap.ts                — detector 2 (tick-open, message-close)
src/detectors/identity.ts           — detector 3 (identity swap, MID/callsign mismatch, teleport)
src/detectors/anchorDrag.ts         — detector 4
src/score.ts                        — suspicion score decay/apply
src/pipeline.ts                     — Tracker: pure ingest→detect engine (DO wraps this; replay harness reuses it)
src/aisstream.ts                    — AISStream.io raw JSON → typed messages
src/db.ts                           — D1 batch flush / rehydrate / prune
src/do/tracker.ts                   — TrackerDO durable object (ws, alarm, persistence)
src/gfw.ts                          — GFW v3 events sync
src/worker.ts                       — fetch router (API + assets) + scheduled()
web/index.html, web/style.css, web/src/main.ts, web/src/api.ts, web/src/panels.ts, web/src/hash.ts
web/public/data/                    — cables.json + exclusions.json copied for the frontend
scripts/replay.ts                   — CLI replay harness
test/…                              — one test file per module + fixtures
```

Responsibility boundaries: detectors never touch storage or the network; `pipeline.ts` owns vessel state transitions and score application; `do/tracker.ts` owns *only* websocket lifecycle, alarms, and batching to D1; `worker.ts` owns HTTP shape.

---

### Task 1: Project scaffold

**Files:**
- Create: `package.json`, `tsconfig.json`, `vitest.config.ts`, `wrangler.jsonc`, `.gitignore`, `test/apply-migrations.ts`, `test/env.d.ts`, `src/worker.ts` (stub), `src/do/tracker.ts` (stub), `migrations/.gitkeep`, `web/dist/.gitkeep`, `test/smoke.test.ts`

**Interfaces:**
- Produces: `Env` type with bindings `DB: D1Database`, `TRACKER: DurableObjectNamespace`, `ASSETS: Fetcher`, `AISSTREAM_KEY: string`, `GFW_TOKEN: string`. Stub `TrackerDO` class and worker entry that later tasks flesh out.

- [ ] **Step 1: Create `package.json`**

```json
{
  "name": "cable-guard-map",
  "private": true,
  "type": "module",
  "scripts": {
    "test": "vitest run",
    "dev": "wrangler dev",
    "build:web": "vite build web",
    "deploy": "npm run build:web && wrangler deploy",
    "replay": "tsx scripts/replay.ts"
  },
  "devDependencies": {
    "@cloudflare/vitest-pool-workers": "^0.8.19",
    "@cloudflare/workers-types": "^4.20250620.0",
    "tsx": "^4.19.0",
    "typescript": "^5.5.0",
    "vite": "^6.0.0",
    "vitest": "^3.1.0",
    "wrangler": "^4.20.0"
  },
  "dependencies": {
    "maplibre-gl": "^5.6.0"
  }
}
```

- [ ] **Step 2: Create `tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ES2022",
    "moduleResolution": "bundler",
    "lib": ["ES2022"],
    "types": ["@cloudflare/workers-types/2023-07-01"],
    "strict": true,
    "noEmit": true,
    "resolveJsonModule": true,
    "isolatedModules": true,
    "skipLibCheck": true
  },
  "include": ["src", "test", "scripts"]
}
```

- [ ] **Step 3: Create `wrangler.jsonc`**

```jsonc
{
  "name": "cable-guard",
  "main": "src/worker.ts",
  "compatibility_date": "2026-06-01",
  "compatibility_flags": ["nodejs_compat"],
  "assets": { "directory": "web/dist", "binding": "ASSETS" },
  "durable_objects": { "bindings": [{ "name": "TRACKER", "class_name": "TrackerDO" }] },
  "migrations": [{ "tag": "v1", "new_sqlite_classes": ["TrackerDO"] }],
  "d1_databases": [{ "binding": "DB", "database_name": "cable-guard", "database_id": "REPLACE_ME_AFTER_wrangler_d1_create" }],
  // */5: keep TrackerDO's websocket alive; 02:15 UTC daily: GFW corroboration sync
  "triggers": { "crons": ["*/5 * * * *", "15 2 * * *"] }
  // Secrets (not here): wrangler secret put AISSTREAM_KEY ; wrangler secret put GFW_TOKEN
}
```

`REPLACE_ME_AFTER_wrangler_d1_create` is intentional: local dev/tests use miniflare's ephemeral D1, so this only needs a real ID at first deploy (`npx wrangler d1 create cable-guard`).

- [ ] **Step 4: Create `vitest.config.ts`, migration applier, and env typing**

```ts
// vitest.config.ts
import path from "node:path";
import { defineWorkersConfig, readD1Migrations } from "@cloudflare/vitest-pool-workers/config";

export default defineWorkersConfig(async () => {
  const migrations = await readD1Migrations(path.join(__dirname, "migrations"));
  return {
    test: {
      setupFiles: ["./test/apply-migrations.ts"],
      poolOptions: {
        workers: {
          wrangler: { configPath: "./wrangler.jsonc" },
          miniflare: { bindings: { TEST_MIGRATIONS: migrations } },
        },
      },
    },
  };
});
```

```ts
// test/apply-migrations.ts
import { applyD1Migrations, env } from "cloudflare:test";
await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
```

```ts
// test/env.d.ts
declare module "cloudflare:test" {
  interface ProvidedEnv extends Env {
    TEST_MIGRATIONS: import("@cloudflare/vitest-pool-workers/config").D1Migration[];
  }
}
```

- [ ] **Step 5: Create stub worker + stub DO (so miniflare can load the config)**

```ts
// src/worker.ts
export { TrackerDO } from "./do/tracker";

export interface Env {
  DB: D1Database;
  TRACKER: DurableObjectNamespace;
  ASSETS: Fetcher;
  AISSTREAM_KEY: string;
  GFW_TOKEN: string;
}

export default {
  async fetch(_req: Request, _env: Env): Promise<Response> {
    return new Response("not implemented", { status: 501 });
  },
} satisfies ExportedHandler<Env>;
```

```ts
// src/do/tracker.ts
export class TrackerDO implements DurableObject {
  async fetch(_req: Request): Promise<Response> {
    return new Response("ok");
  }
}
```

- [ ] **Step 6: Create `.gitignore`**

```
node_modules/
web/dist/
!web/dist/.gitkeep
.wrangler/
.dev.vars
```

- [ ] **Step 7: Write smoke test**

```ts
// test/smoke.test.ts
import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";

describe("scaffold", () => {
  it("has a D1 binding", async () => {
    const row = await env.DB.prepare("SELECT 1 AS one").first<{ one: number }>();
    expect(row?.one).toBe(1);
  });
});
```

- [ ] **Step 8: Install and run**

Run: `npm install && mkdir -p migrations web/dist && touch migrations/.gitkeep web/dist/.gitkeep && npm test`
Expected: 1 test file, 1 passed.

- [ ] **Step 9: Commit**

```bash
git add -A
git commit -m "chore: scaffold Cloudflare worker project with vitest-pool-workers"
```

---

### Task 2: Config, core types, geo helpers

**Files:**
- Create: `src/config.ts`, `src/types.ts`, `src/geo/geo.ts`
- Test: `test/geo.test.ts`

**Interfaces:**
- Produces:
  - `CONFIG` object and `type Config = typeof CONFIG` (all thresholds; consumed by every detector).
  - Types `AisPosition { mmsi, lon, lat, sog, cog, heading, ts }`, `AisIdentity { mmsi, name, callsign, ts }`, `EventType = 'loitering'|'ais_gap'|'identity'|'anchor_drag'`, `AnomalyEvent { id, type, severity, mmsi, lon, lat, startTs, endTs, evidence }`, `VesselState`, `newVesselState(mmsi, now)`.
  - Geo: `haversineM(a, b)`, `pointToSegmentM(p, a, b)`, `pointToPolylineM(p, line)`, `pointInPolygon(p, ring)` — all `LngLat = [number, number]`, meters.

- [ ] **Step 1: Write failing geo tests (known coordinates on a real cable route)**

```ts
// test/geo.test.ts
import { describe, expect, it } from "vitest";
import { haversineM, pointInPolygon, pointToPolylineM, pointToSegmentM } from "../src/geo/geo";

// Fangshan (SMW3/FLAG landing, ~120.593E 22.263N) → offshore point SW.
const FANGSHAN: [number, number] = [120.593, 22.263];
const OFFSHORE: [number, number] = [119.8, 21.7];

describe("geo helpers", () => {
  it("haversine: Fangshan→Toucheng landing ≈ 320 km", () => {
    const toucheng: [number, number] = [121.882, 24.855];
    const d = haversineM(FANGSHAN, toucheng);
    expect(d).toBeGreaterThan(300_000);
    expect(d).toBeLessThan(340_000);
  });

  it("point on the segment has ~0 distance", () => {
    const mid: [number, number] = [(FANGSHAN[0] + OFFSHORE[0]) / 2, (FANGSHAN[1] + OFFSHORE[1]) / 2];
    expect(pointToSegmentM(mid, FANGSHAN, OFFSHORE)).toBeLessThan(600); // straight-line midpoint vs geodesic
  });

  it("point ~1.1 km north of the segment midpoint is 900–1300 m away", () => {
    const mid: [number, number] = [(FANGSHAN[0] + OFFSHORE[0]) / 2, (FANGSHAN[1] + OFFSHORE[1]) / 2];
    const off: [number, number] = [mid[0], mid[1] + 0.01]; // +0.01° lat ≈ 1105 m
    const d = pointToPolylineM(off, [FANGSHAN, OFFSHORE]);
    expect(d).toBeGreaterThan(700);
    expect(d).toBeLessThan(1400);
  });

  it("distance beyond an endpoint clamps to the endpoint", () => {
    const past: [number, number] = [120.7, 22.35]; // beyond Fangshan end
    const d = pointToSegmentM(past, FANGSHAN, OFFSHORE);
    expect(Math.abs(d - haversineM(past, FANGSHAN))).toBeLessThan(d * 0.05);
  });

  it("pointInPolygon: Kaohsiung anchorage box", () => {
    const box: [number, number][] = [[120.2, 22.5], [120.35, 22.5], [120.35, 22.62], [120.2, 22.62], [120.2, 22.5]];
    expect(pointInPolygon([120.27, 22.55], box)).toBe(true);
    expect(pointInPolygon([120.5, 22.55], box)).toBe(false);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run test/geo.test.ts`
Expected: FAIL — cannot resolve `../src/geo/geo`.

- [ ] **Step 3: Implement `src/config.ts`**

```ts
// src/config.ts — ALL tunable thresholds live here (spec §3).
export const CONFIG = {
  // Area of interest: Taiwan + strait + Matsu/Penghu, sent to AISStream as the bbox subscription.
  bbox: { minLon: 118.0, minLat: 21.0, maxLon: 124.5, maxLat: 26.5 },

  corridorBufferM: 1000,          // cable corridor = within 1 km of route line

  loiterMaxSogKn: 2,              // detector 1
  loiterMinMs: 2 * 60 * 60 * 1000,

  gapMinMs: 60 * 60 * 1000,       // detector 2
  impossibleSpeedKn: 50,          // implied speed above this = physically impossible

  teleportMaxGapMs: 10 * 60 * 1000, // detector 3: impossible speed WITHIN this window = two transmitters

  dragMaxSogKn: 3,                // detector 4
  dragMinSogKn: 0.3,              // below this the vessel is moored, not dragging
  dragWindow: 10,                 // positions considered for COG variance
  dragMinCogStdDeg: 40,           // circular std-dev threshold
  dragCooldownMs: 60 * 60 * 1000, // one drag event per vessel per hour

  ringSize: 120,                  // hot-state position ring buffer per vessel
  identityHistorySize: 20,

  scoreHalfLifeMs: 24 * 60 * 60 * 1000, // suspicion score decay

  persistMinIntervalMs: 5 * 60 * 1000,  // downsampling: persist a track point at most…
  persistMinMoveM: 100,                 // …every 5 min unless the vessel moved ≥100 m
  positionRetentionMs: 30 * 24 * 60 * 60 * 1000,

  snapshotWindowMs: 60 * 60 * 1000, // /api/snapshot shows vessels heard in the last hour
  staleAfterMs: 5 * 60 * 1000,      // frontend staleness banner threshold

  alarmIntervalMs: 30 * 1000,       // DO alarm cadence
  watchdogMs: 2 * 60 * 1000,        // reconnect if no ws message for this long
  backoffMinMs: 1000,
  backoffMaxMs: 60 * 1000,
} as const;

export type Config = typeof CONFIG;
```

- [ ] **Step 4: Implement `src/types.ts`**

```ts
// src/types.ts
export interface AisPosition {
  mmsi: number;
  lon: number;
  lat: number;
  sog: number;            // knots
  cog: number;            // degrees true
  heading: number | null; // degrees, null when unavailable (AIS 511)
  ts: number;             // ms epoch
}

export interface AisIdentity {
  mmsi: number;
  name: string;
  callsign: string;
  ts: number;
}

export type EventType = "loitering" | "ais_gap" | "identity" | "anchor_drag";
export type Severity = 1 | 2 | 3 | 4 | 5;

export interface AnomalyEvent {
  id: string;             // deterministic: `${type}-${mmsi}-${startTs}` → idempotent upserts
  type: EventType;
  severity: Severity;
  mmsi: number;
  lon: number;
  lat: number;
  startTs: number;
  endTs: number | null;   // null = ongoing
  evidence: Record<string, unknown>;
}

export interface VesselState {
  mmsi: number;
  name: string | null;
  callsign: string | null;
  ring: AisPosition[];         // newest LAST, length ≤ CONFIG.ringSize
  identities: AisIdentity[];   // distinct identity snapshots, newest last
  lastSeen: number;            // ts of newest position
  loiterStart: number | null;
  loiterReported: boolean;
  gapOpenSince: number | null; // = lastSeen at the moment the gap opened
  dragReportedTs: number | null;
  score: number;
  scoreTs: number;
}

export function newVesselState(mmsi: number, now: number): VesselState {
  return {
    mmsi, name: null, callsign: null,
    ring: [], identities: [],
    lastSeen: now,
    loiterStart: null, loiterReported: false,
    gapOpenSince: null, dragReportedTs: null,
    score: 0, scoreTs: now,
  };
}
```

- [ ] **Step 5: Implement `src/geo/geo.ts`**

```ts
// src/geo/geo.ts — pure geometry, meters, [lon, lat] order.
export type LngLat = [number, number];

const R = 6_371_000;
const D2R = Math.PI / 180;

export function haversineM(a: LngLat, b: LngLat): number {
  const dLat = (b[1] - a[1]) * D2R;
  const dLon = (b[0] - a[0]) * D2R;
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(a[1] * D2R) * Math.cos(b[1] * D2R) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

// Equirectangular projection centred on p — error <1% at the ≤10 km scales we use.
export function pointToSegmentM(p: LngLat, a: LngLat, b: LngLat): number {
  const k = Math.cos(p[1] * D2R);
  const ax = (a[0] - p[0]) * k * 111_320, ay = (a[1] - p[1]) * 110_540;
  const bx = (b[0] - p[0]) * k * 111_320, by = (b[1] - p[1]) * 110_540;
  const dx = bx - ax, dy = by - ay;
  const len2 = dx * dx + dy * dy;
  const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, (-ax * dx - ay * dy) / len2));
  return Math.hypot(ax + t * dx, ay + t * dy);
}

export function pointToPolylineM(p: LngLat, line: LngLat[]): number {
  let min = Infinity;
  for (let i = 0; i < line.length - 1; i++) {
    min = Math.min(min, pointToSegmentM(p, line[i], line[i + 1]));
  }
  return min;
}

// Ray casting; ring may be open or closed.
export function pointInPolygon(p: LngLat, ring: LngLat[]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i], [xj, yj] = ring[j];
    if (yi > p[1] !== yj > p[1] && p[0] < ((xj - xi) * (p[1] - yi)) / (yj - yi) + xi) {
      inside = !inside;
    }
  }
  return inside;
}
```

- [ ] **Step 6: Run tests**

Run: `npx vitest run test/geo.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 7: Commit**

```bash
git add src/config.ts src/types.ts src/geo/geo.ts test/geo.test.ts
git commit -m "feat: config, core types, and geo helpers with real-route tests"
```

---

### Task 3: Cable & exclusion geodata + GeoContext

**Files:**
- Create: `data/cables.json`, `data/exclusions.json`, `src/geo/context.ts`
- Test: `test/context.test.ts`

**Interfaces:**
- Consumes: `pointToPolylineM`, `pointInPolygon` from Task 2; `CONFIG.corridorBufferM`.
- Produces: `class GeoContext { nearestCorridor(p): {name, distanceM} | null; inCorridor(p): boolean; inExclusion(p): boolean }` with `p: LngLat`. Constructor `new GeoContext(cablesFc?, exclusionsFc?, bufferM?)` defaults to the bundled JSON — tests inject synthetic geometry.

**Data caveat (from spec §§8–9):** these geometries are *starter approximations* — international routes should be re-digitized from TeleGeography's public map and Matsu/Penghu routes confirmed with SeaLight before public launch. Every feature carries `approximate: true` until then. This does not block any other task.

- [ ] **Step 1: Write failing tests**

```ts
// test/context.test.ts
import { describe, expect, it } from "vitest";
import { GeoContext } from "../src/geo/context";

const cables = {
  type: "FeatureCollection",
  features: [{
    type: "Feature",
    properties: { name: "TEST-CABLE", approximate: true },
    geometry: { type: "LineString", coordinates: [[120.0, 22.0], [121.0, 22.0]] },
  }],
};
const exclusions = {
  type: "FeatureCollection",
  features: [{
    type: "Feature",
    properties: { name: "TEST-ANCHORAGE" },
    geometry: { type: "Polygon", coordinates: [[[120.4, 21.95], [120.6, 21.95], [120.6, 22.05], [120.4, 22.05], [120.4, 21.95]]] },
  }],
};

describe("GeoContext", () => {
  const geo = new GeoContext(cables as any, exclusions as any, 1000);

  it("point on the cable is in corridor", () => {
    expect(geo.inCorridor([120.2, 22.0])).toBe(true);
    expect(geo.nearestCorridor([120.2, 22.0])?.name).toBe("TEST-CABLE");
  });

  it("point 5 km off the cable is not in corridor", () => {
    expect(geo.inCorridor([120.2, 22.045])).toBe(false); // 0.045° lat ≈ 5 km
  });

  it("exclusion polygon membership", () => {
    expect(geo.inExclusion([120.5, 22.0])).toBe(true);
    expect(geo.inExclusion([120.2, 22.0])).toBe(false);
  });

  it("default construction loads the bundled Taiwan data", () => {
    const real = new GeoContext();
    // Fangshan landing point sits on the bundled southern corridor.
    expect(real.inCorridor([120.593, 22.263])).toBe(true);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run test/context.test.ts` — Expected: FAIL (module not found).

- [ ] **Step 3: Create `data/cables.json`** (starter approximations; refine per spec §9)

```json
{
  "type": "FeatureCollection",
  "features": [
    { "type": "Feature", "properties": { "name": "Toucheng East Corridor (intl. landings)", "approximate": true },
      "geometry": { "type": "LineString", "coordinates": [[121.882, 24.855], [122.4, 24.9], [123.2, 25.0]] } },
    { "type": "Feature", "properties": { "name": "Tamsui North Corridor (intl. landings)", "approximate": true },
      "geometry": { "type": "LineString", "coordinates": [[121.41, 25.19], [121.3, 25.6], [121.1, 26.1]] } },
    { "type": "Feature", "properties": { "name": "Fangshan Southwest Corridor (SMW3/FLAG/APG)", "approximate": true },
      "geometry": { "type": "LineString", "coordinates": [[120.593, 22.263], [119.8, 21.7], [118.8, 21.3]] } },
    { "type": "Feature", "properties": { "name": "Taiwan–Matsu No.2/3 (domestic)", "approximate": true },
      "geometry": { "type": "LineString", "coordinates": [[121.41, 25.19], [120.7, 25.7], [119.97, 26.15]] } },
    { "type": "Feature", "properties": { "name": "Taiwan–Penghu No.3 (domestic)", "approximate": true },
      "geometry": { "type": "LineString", "coordinates": [[120.18, 23.35], [119.9, 23.4], [119.6, 23.55]] } }
  ]
}
```

- [ ] **Step 4: Create `data/exclusions.json`** (known anchorages/port approaches — suppress loiter false positives)

```json
{
  "type": "FeatureCollection",
  "features": [
    { "type": "Feature", "properties": { "name": "Kaohsiung anchorage" },
      "geometry": { "type": "Polygon", "coordinates": [[[120.20, 22.48], [120.38, 22.48], [120.38, 22.63], [120.20, 22.63], [120.20, 22.48]]] } },
    { "type": "Feature", "properties": { "name": "Keelung anchorage" },
      "geometry": { "type": "Polygon", "coordinates": [[[121.70, 25.14], [121.82, 25.14], [121.82, 25.24], [121.70, 25.24], [121.70, 25.14]]] } },
    { "type": "Feature", "properties": { "name": "Taichung anchorage" },
      "geometry": { "type": "Polygon", "coordinates": [[[120.42, 24.20], [120.55, 24.20], [120.55, 24.32], [120.42, 24.32], [120.42, 24.20]]] } }
  ]
}
```

- [ ] **Step 5: Implement `src/geo/context.ts`**

```ts
// src/geo/context.ts
import cablesData from "../../data/cables.json";
import exclusionsData from "../../data/exclusions.json";
import { CONFIG } from "../config";
import { pointInPolygon, pointToPolylineM, type LngLat } from "./geo";

interface LineFeature { properties: { name: string }; geometry: { type: "LineString"; coordinates: LngLat[] } }
interface PolyFeature { properties: { name: string }; geometry: { type: "Polygon"; coordinates: LngLat[][] } }
interface FC<F> { features: F[] }

export interface CorridorHit { name: string; distanceM: number }

export class GeoContext {
  constructor(
    private cables: FC<LineFeature> = cablesData as unknown as FC<LineFeature>,
    private exclusions: FC<PolyFeature> = exclusionsData as unknown as FC<PolyFeature>,
    private bufferM: number = CONFIG.corridorBufferM,
  ) {}

  nearestCorridor(p: LngLat): CorridorHit | null {
    let best: CorridorHit | null = null;
    for (const f of this.cables.features) {
      const d = pointToPolylineM(p, f.geometry.coordinates);
      if (!best || d < best.distanceM) best = { name: f.properties.name, distanceM: d };
    }
    return best;
  }

  inCorridor(p: LngLat): boolean {
    const hit = this.nearestCorridor(p);
    return hit !== null && hit.distanceM <= this.bufferM;
  }

  inExclusion(p: LngLat): boolean {
    return this.exclusions.features.some((f) => pointInPolygon(p, f.geometry.coordinates[0]));
  }
}
```

- [ ] **Step 6: Run tests**

Run: `npx vitest run test/context.test.ts` — Expected: PASS (4 tests).

- [ ] **Step 7: Commit**

```bash
git add data/ src/geo/context.ts test/context.test.ts
git commit -m "feat: cable corridor + exclusion geodata and GeoContext lookups"
```

---

### Task 4: Loitering detector

**Files:**
- Create: `src/detectors/loitering.ts`
- Test: `test/loitering.test.ts`

**Interfaces:**
- Consumes: `VesselState`, `AisPosition`, `AnomalyEvent` (Task 2); `GeoContext` (Task 3); `Config`.
- Produces: `loiteringOnMessage(s: VesselState, msg: AisPosition, geo: GeoContext, cfg: Config): AnomalyEvent[]`. Mutates `s.loiterStart` / `s.loiterReported`. Emits an *open* event (endTs null) once when the threshold is crossed, and the *same id* with `endTs` set when loitering ends (persistence upserts by id).

- [ ] **Step 1: Write failing tests** — synthetic tracks from spec §7: a loiterer over a cable fires; a slow fishing fleet inside an exclusion zone must NOT fire; a normal transit must NOT fire.

```ts
// test/loitering.test.ts
import { describe, expect, it } from "vitest";
import { GeoContext } from "../src/geo/context";
import { CONFIG } from "../src/config";
import { newVesselState, type AisPosition } from "../src/types";
import { loiteringOnMessage } from "../src/detectors/loitering";

const cables = { type: "FeatureCollection", features: [{ type: "Feature", properties: { name: "C1", approximate: true }, geometry: { type: "LineString", coordinates: [[120.0, 22.0], [121.0, 22.0]] } }] };
const excl = { type: "FeatureCollection", features: [{ type: "Feature", properties: { name: "A1" }, geometry: { type: "Polygon", coordinates: [[[120.4, 21.99], [120.6, 21.99], [120.6, 22.01], [120.4, 22.01], [120.4, 21.99]]] } }] };
const geo = new GeoContext(cables as any, excl as any, 1000);
const T0 = 1_750_000_000_000;

function pos(mmsi: number, lon: number, lat: number, sog: number, tMin: number): AisPosition {
  return { mmsi, lon, lat, sog, cog: 90, heading: 90, ts: T0 + tMin * 60_000 };
}

describe("loitering detector", () => {
  it("fires after >2h slow in corridor, once, then closes on departure", () => {
    const s = newVesselState(1, T0);
    const evs: any[] = [];
    for (let m = 0; m <= 130; m += 10) evs.push(...loiteringOnMessage(s, pos(1, 120.2, 22.0, 0.5, m), geo, CONFIG));
    expect(evs).toHaveLength(1);
    expect(evs[0]).toMatchObject({ type: "loitering", severity: 3, mmsi: 1, endTs: null });
    expect(evs[0].evidence.corridor).toBe("C1");
    // speeds up and leaves → same id, closed
    const close = loiteringOnMessage(s, pos(1, 120.2, 22.0, 8, 140), geo, CONFIG);
    expect(close).toHaveLength(1);
    expect(close[0].id).toBe(evs[0].id);
    expect(close[0].endTs).toBe(T0 + 140 * 60_000);
  });

  it("does NOT fire inside an exclusion zone (slow fishing fleet)", () => {
    const s = newVesselState(2, T0);
    const evs: any[] = [];
    for (let m = 0; m <= 300; m += 10) evs.push(...loiteringOnMessage(s, pos(2, 120.5, 22.0, 0.5, m), geo, CONFIG));
    expect(evs).toHaveLength(0);
  });

  it("does NOT fire on a normal transit through the corridor", () => {
    const s = newVesselState(3, T0);
    const evs: any[] = [];
    for (let m = 0; m <= 30; m += 5) evs.push(...loiteringOnMessage(s, pos(3, 120.1 + m * 0.01, 22.0, 12, m), geo, CONFIG));
    expect(evs).toHaveLength(0);
  });

  it("timer resets when the vessel speeds up briefly", () => {
    const s = newVesselState(4, T0);
    const evs: any[] = [];
    for (let m = 0; m <= 110; m += 10) evs.push(...loiteringOnMessage(s, pos(4, 120.2, 22.0, 0.5, m), geo, CONFIG));
    evs.push(...loiteringOnMessage(s, pos(4, 120.2, 22.0, 6, 115), geo, CONFIG)); // burst of speed
    for (let m = 120; m <= 230; m += 10) evs.push(...loiteringOnMessage(s, pos(4, 120.2, 22.0, 0.5, m), geo, CONFIG));
    expect(evs).toHaveLength(0); // neither stretch alone reaches 2 h
  });
});
```

- [ ] **Step 2: Run to verify failure** — `npx vitest run test/loitering.test.ts` → FAIL (module not found).

- [ ] **Step 3: Implement**

```ts
// src/detectors/loitering.ts
import type { Config } from "../config";
import type { GeoContext } from "../geo/context";
import type { AisPosition, AnomalyEvent, VesselState } from "../types";
import type { LngLat } from "../geo/geo";

export function loiteringOnMessage(s: VesselState, msg: AisPosition, geo: GeoContext, cfg: Config): AnomalyEvent[] {
  const p: LngLat = [msg.lon, msg.lat];
  const loiterCandidate = msg.sog < cfg.loiterMaxSogKn && geo.inCorridor(p) && !geo.inExclusion(p);

  if (loiterCandidate) {
    if (s.loiterStart === null) {
      s.loiterStart = msg.ts;
      return [];
    }
    if (!s.loiterReported && msg.ts - s.loiterStart >= cfg.loiterMinMs) {
      s.loiterReported = true;
      return [{
        id: `loitering-${s.mmsi}-${s.loiterStart}`,
        type: "loitering", severity: 3, mmsi: s.mmsi,
        lon: msg.lon, lat: msg.lat,
        startTs: s.loiterStart, endTs: null,
        evidence: { corridor: geo.nearestCorridor(p)!.name, sogKn: msg.sog, durationMs: msg.ts - s.loiterStart },
      }];
    }
    return [];
  }

  // Condition broken: close the open event if one was reported, then reset.
  const out: AnomalyEvent[] = [];
  if (s.loiterStart !== null && s.loiterReported) {
    out.push({
      id: `loitering-${s.mmsi}-${s.loiterStart}`,
      type: "loitering", severity: 3, mmsi: s.mmsi,
      lon: msg.lon, lat: msg.lat,
      startTs: s.loiterStart, endTs: msg.ts,
      evidence: { corridor: geo.nearestCorridor(p)?.name ?? null, durationMs: msg.ts - s.loiterStart },
    });
  }
  s.loiterStart = null;
  s.loiterReported = false;
  return out;
}
```

- [ ] **Step 4: Run tests** — `npx vitest run test/loitering.test.ts` → PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/detectors/loitering.ts test/loitering.test.ts
git commit -m "feat: loitering detector with exclusion-zone suppression"
```

---

### Task 5: AIS-gap detector

**Files:**
- Create: `src/detectors/gap.ts`
- Test: `test/gap.test.ts`

**Interfaces:**
- Consumes: Tasks 2–3 types/GeoContext.
- Produces:
  - `gapOnTick(s: VesselState, geo: GeoContext, cfg: Config, now: number): AnomalyEvent[]` — opens a gap event when silent > `gapMinMs`; severity 4 if last position was in a corridor, else 2. Sets `s.gapOpenSince`.
  - `gapOnMessage(s: VesselState, msg: AisPosition, geo: GeoContext, cfg: Config): AnomalyEvent[]` — closes an open gap; severity escalates to 5 if reappearance is in a corridor or implied speed > `impossibleSpeedKn`. Clears `s.gapOpenSince`. Call BEFORE pushing `msg` onto the ring.

- [ ] **Step 1: Write failing tests**

```ts
// test/gap.test.ts
import { describe, expect, it } from "vitest";
import { GeoContext } from "../src/geo/context";
import { CONFIG } from "../src/config";
import { newVesselState, type AisPosition } from "../src/types";
import { gapOnMessage, gapOnTick } from "../src/detectors/gap";

const cables = { type: "FeatureCollection", features: [{ type: "Feature", properties: { name: "C1", approximate: true }, geometry: { type: "LineString", coordinates: [[120.0, 22.0], [121.0, 22.0]] } }] };
const noExcl = { type: "FeatureCollection", features: [] };
const geo = new GeoContext(cables as any, noExcl as any, 1000);
const T0 = 1_750_000_000_000;
const HOUR = 3_600_000;

function seed(mmsi: number, lon: number, lat: number) {
  const s = newVesselState(mmsi, T0);
  const p: AisPosition = { mmsi, lon, lat, sog: 5, cog: 90, heading: 90, ts: T0 };
  s.ring.push(p); s.lastSeen = T0;
  return s;
}

describe("AIS gap detector", () => {
  it("opens severity-4 gap when silent >1h with last fix in a corridor", () => {
    const s = seed(1, 120.5, 22.0);
    expect(gapOnTick(s, geo, CONFIG, T0 + HOUR - 60_000)).toHaveLength(0);
    const evs = gapOnTick(s, geo, CONFIG, T0 + HOUR + 60_000);
    expect(evs).toHaveLength(1);
    expect(evs[0]).toMatchObject({ type: "ais_gap", severity: 4, mmsi: 1, startTs: T0, endTs: null });
    expect(gapOnTick(s, geo, CONFIG, T0 + 2 * HOUR)).toHaveLength(0); // fires once
  });

  it("opens severity-2 gap when last fix was outside corridors", () => {
    const s = seed(2, 120.5, 23.5);
    const evs = gapOnTick(s, geo, CONFIG, T0 + HOUR + 60_000);
    expect(evs[0].severity).toBe(2);
  });

  it("closes with severity 5 on impossible-speed reappearance (gap-and-teleport)", () => {
    const s = seed(3, 120.5, 22.0);
    gapOnTick(s, geo, CONFIG, T0 + HOUR + 60_000);
    // reappears 2 h later, ~200 km away → ~54 kn implied
    const back: AisPosition = { mmsi: 3, lon: 122.45, lat: 22.0, sog: 10, cog: 90, heading: 90, ts: T0 + 2 * HOUR };
    const evs = gapOnMessage(s, back, geo, CONFIG);
    expect(evs).toHaveLength(1);
    expect(evs[0]).toMatchObject({ severity: 5, endTs: T0 + 2 * HOUR });
    expect((evs[0].evidence as any).impliedSpeedKn).toBeGreaterThan(CONFIG.impossibleSpeedKn);
    expect(s.gapOpenSince).toBeNull();
  });

  it("plausible reappearance outside corridor keeps opening severity", () => {
    const s = seed(4, 120.5, 23.5);
    gapOnTick(s, geo, CONFIG, T0 + HOUR + 60_000);
    const back: AisPosition = { mmsi: 4, lon: 120.6, lat: 23.55, sog: 5, cog: 90, heading: 90, ts: T0 + 2 * HOUR };
    const evs = gapOnMessage(s, back, geo, CONFIG);
    expect(evs[0].severity).toBe(2);
  });

  it("no-op close when no gap is open", () => {
    const s = seed(5, 120.5, 22.0);
    const p: AisPosition = { mmsi: 5, lon: 120.51, lat: 22.0, sog: 5, cog: 90, heading: 90, ts: T0 + 60_000 };
    expect(gapOnMessage(s, p, geo, CONFIG)).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run to verify failure** — `npx vitest run test/gap.test.ts` → FAIL (module not found).

- [ ] **Step 3: Implement**

```ts
// src/detectors/gap.ts
import type { Config } from "../config";
import type { GeoContext } from "../geo/context";
import { haversineM, type LngLat } from "../geo/geo";
import type { AisPosition, AnomalyEvent, Severity, VesselState } from "../types";

function last(s: VesselState): AisPosition | null {
  return s.ring.length ? s.ring[s.ring.length - 1] : null;
}

export function gapOnTick(s: VesselState, geo: GeoContext, cfg: Config, now: number): AnomalyEvent[] {
  if (s.gapOpenSince !== null) return [];
  const lp = last(s);
  if (!lp) return [];
  if (now - s.lastSeen < cfg.gapMinMs) return [];

  s.gapOpenSince = s.lastSeen;
  const inCorr = geo.inCorridor([lp.lon, lp.lat]);
  const severity: Severity = inCorr ? 4 : 2;
  return [{
    id: `ais_gap-${s.mmsi}-${s.lastSeen}`,
    type: "ais_gap", severity, mmsi: s.mmsi,
    lon: lp.lon, lat: lp.lat,
    startTs: s.lastSeen, endTs: null,
    evidence: { lastFixInCorridor: inCorr, silentMs: now - s.lastSeen },
  }];
}

export function gapOnMessage(s: VesselState, msg: AisPosition, geo: GeoContext, cfg: Config): AnomalyEvent[] {
  if (s.gapOpenSince === null) return [];
  const lp = last(s);
  const startTs = s.gapOpenSince;
  s.gapOpenSince = null;
  if (!lp) return [];

  const gapMs = msg.ts - lp.ts;
  const distM = haversineM([lp.lon, lp.lat] as LngLat, [msg.lon, msg.lat] as LngLat);
  const impliedSpeedKn = gapMs > 0 ? distM / 1852 / (gapMs / HOUR_MS) : 0;
  const startInCorr = geo.inCorridor([lp.lon, lp.lat]);
  const endInCorr = geo.inCorridor([msg.lon, msg.lat]);
  const impossible = impliedSpeedKn > cfg.impossibleSpeedKn;

  let severity: Severity = startInCorr ? 4 : 2;
  if (impossible || endInCorr) severity = 5;

  return [{
    id: `ais_gap-${s.mmsi}-${startTs}`,
    type: "ais_gap", severity, mmsi: s.mmsi,
    lon: msg.lon, lat: msg.lat,
    startTs, endTs: msg.ts,
    evidence: { gapMs, distanceM: Math.round(distM), impliedSpeedKn: Math.round(impliedSpeedKn * 10) / 10, startInCorridor: startInCorr, endInCorridor: endInCorr },
  }];
}

const HOUR_MS = 3_600_000;
```

- [ ] **Step 4: Run tests** — `npx vitest run test/gap.test.ts` → PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add src/detectors/gap.ts test/gap.test.ts
git commit -m "feat: AIS gap detector with corridor and impossible-speed severity boosts"
```

---

### Task 6: Identity-anomaly detector

**Files:**
- Create: `src/detectors/identity.ts`
- Test: `test/identity.test.ts`

**Interfaces:**
- Consumes: Tasks 2–3.
- Produces:
  - `identityOnStatic(s: VesselState, ident: AisIdentity, cfg: Config): AnomalyEvent[]` — fires when the same MMSI broadcasts a different name/callsign than previously recorded; also flags MMSI-MID vs callsign-prefix flag mismatch. Appends to `s.identities` (capped at `cfg.identityHistorySize`) and updates `s.name`/`s.callsign`.
  - `teleportOnMessage(s: VesselState, msg: AisPosition, cfg: Config): AnomalyEvent[]` — one MMSI in two places: implied speed > `impossibleSpeedKn` across a short interval (< `teleportMaxGapMs`). Call BEFORE ring push, only when no gap is open.
  - `midCountry(mmsi: number): string | null` and `callsignCountry(callsign: string): string | null` (exported for tests).

- [ ] **Step 1: Write failing tests** — identity swapper (Shunxin-39 pattern), flag mismatch, teleport.

```ts
// test/identity.test.ts
import { describe, expect, it } from "vitest";
import { CONFIG } from "../src/config";
import { newVesselState, type AisIdentity, type AisPosition } from "../src/types";
import { callsignCountry, identityOnStatic, midCountry, teleportOnMessage } from "../src/detectors/identity";

const T0 = 1_750_000_000_000;
const id = (mmsi: number, name: string, callsign: string, tMin: number): AisIdentity =>
  ({ mmsi, name, callsign, ts: T0 + tMin * 60_000 });

describe("identity detector", () => {
  it("first identity is recorded silently", () => {
    const s = newVesselState(412111111, T0);
    expect(identityOnStatic(s, id(412111111, "SHUNXIN 39", "BXYZ1", 0), CONFIG)).toHaveLength(0);
    expect(s.name).toBe("SHUNXIN 39");
    expect(s.identities).toHaveLength(1);
  });

  it("same MMSI, new name → severity-4 identity event with before/after evidence", () => {
    const s = newVesselState(412111111, T0);
    identityOnStatic(s, id(412111111, "SHUNXIN 39", "BXYZ1", 0), CONFIG);
    const evs = identityOnStatic(s, id(412111111, "XINGSHUN 39", "BXYZ1", 60), CONFIG);
    expect(evs).toHaveLength(1);
    expect(evs[0]).toMatchObject({ type: "identity", severity: 4 });
    expect(evs[0].evidence).toMatchObject({ prevName: "SHUNXIN 39", newName: "XINGSHUN 39" });
    expect(s.identities).toHaveLength(2);
  });

  it("unchanged identity re-broadcast does not fire or grow history", () => {
    const s = newVesselState(412111111, T0);
    identityOnStatic(s, id(412111111, "SHUNXIN 39", "BXYZ1", 0), CONFIG);
    expect(identityOnStatic(s, id(412111111, "SHUNXIN 39", "BXYZ1", 30), CONFIG)).toHaveLength(0);
    expect(s.identities).toHaveLength(1);
  });

  it("MID/callsign flag mismatch → identity event (China MMSI, Taiwan callsign)", () => {
    expect(midCountry(412000000)).toBe("CN");
    expect(midCountry(416000000)).toBe("TW");
    expect(callsignCountry("BV1234")).toBe("TW");
    const s = newVesselState(412222222, T0);
    const evs = identityOnStatic(s, id(412222222, "SOME SHIP", "BV1234", 0), CONFIG);
    expect(evs).toHaveLength(1);
    expect(evs[0].evidence).toMatchObject({ midCountry: "CN", callsignCountry: "TW" });
  });

  it("teleport: two fixes 3 min apart, ~30 km apart → severity-4 event", () => {
    const s = newVesselState(9, T0);
    s.ring.push({ mmsi: 9, lon: 120.0, lat: 22.0, sog: 5, cog: 0, heading: 0, ts: T0 });
    s.lastSeen = T0;
    const p: AisPosition = { mmsi: 9, lon: 120.3, lat: 22.0, sog: 5, cog: 0, heading: 0, ts: T0 + 3 * 60_000 };
    const evs = teleportOnMessage(s, p, CONFIG);
    expect(evs).toHaveLength(1);
    expect(evs[0].type).toBe("identity");
    expect((evs[0].evidence as any).impliedSpeedKn).toBeGreaterThan(CONFIG.impossibleSpeedKn);
  });

  it("teleport does not fire on normal movement", () => {
    const s = newVesselState(10, T0);
    s.ring.push({ mmsi: 10, lon: 120.0, lat: 22.0, sog: 10, cog: 90, heading: 90, ts: T0 });
    s.lastSeen = T0;
    const p: AisPosition = { mmsi: 10, lon: 120.01, lat: 22.0, sog: 10, cog: 90, heading: 90, ts: T0 + 3 * 60_000 };
    expect(teleportOnMessage(s, p, CONFIG)).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run to verify failure** — `npx vitest run test/identity.test.ts` → FAIL.

- [ ] **Step 3: Implement**

```ts
// src/detectors/identity.ts
import type { Config } from "../config";
import { haversineM } from "../geo/geo";
import type { AisIdentity, AisPosition, AnomalyEvent, VesselState } from "../types";

// MMSI MID (first 3 digits) → ISO country, strait-relevant subset. Extend as needed.
const MID: Record<string, string> = {
  "412": "CN", "413": "CN", "414": "CN", "416": "TW", "440": "KR", "441": "KR",
  "431": "JP", "432": "JP", "273": "RU", "511": "PW", "352": "PA", "354": "PA",
  "353": "PA", "563": "SG", "564": "SG", "477": "HK", "312": "BZ", "620": "GA",
  "572": "TV", "574": "VN", "533": "MY", "667": "SL", "671": "TG",
};

// ITU callsign prefix → ISO country, same subset. First match on 2-char then 1-char prefix.
const CALLSIGN: Record<string, string> = {
  "BV": "TW", "BX": "TW", "BM": "TW", "BN": "TW", "BO": "TW", "BQ": "TW",
  "B": "CN", "3E": "PA", "3F": "PA", "H3": "PA", "H8": "PA", "H9": "PA", "HO": "PA", "HP": "PA",
  "9V": "SG", "HL": "KR", "DS": "KR", "JA": "JP", "7J": "JP", "UA": "RU", "T8": "PW",
  "V3": "BZ", "TR": "GA", "T2": "TV", "XV": "VN", "9M": "MY",
};

export function midCountry(mmsi: number): string | null {
  return MID[String(mmsi).padStart(9, "0").slice(0, 3)] ?? null;
}

export function callsignCountry(callsign: string): string | null {
  const cs = callsign.trim().toUpperCase();
  if (!cs) return null;
  return CALLSIGN[cs.slice(0, 2)] ?? CALLSIGN[cs.slice(0, 1)] ?? null;
}

export function identityOnStatic(s: VesselState, ident: AisIdentity, cfg: Config): AnomalyEvent[] {
  const out: AnomalyEvent[] = [];
  const prev = s.identities.length ? s.identities[s.identities.length - 1] : null;
  const changed = prev !== null && (prev.name !== ident.name || prev.callsign !== ident.callsign);

  if (changed) {
    out.push({
      id: `identity-${s.mmsi}-${ident.ts}`,
      type: "identity", severity: 4, mmsi: s.mmsi,
      lon: s.ring.length ? s.ring[s.ring.length - 1].lon : 0,
      lat: s.ring.length ? s.ring[s.ring.length - 1].lat : 0,
      startTs: ident.ts, endTs: ident.ts,
      evidence: { kind: "identity_change", prevName: prev.name, newName: ident.name, prevCallsign: prev.callsign, newCallsign: ident.callsign },
    });
  }

  if (prev === null || changed) {
    s.identities.push(ident);
    if (s.identities.length > cfg.identityHistorySize) s.identities.shift();

    const mc = midCountry(ident.mmsi);
    const cc = callsignCountry(ident.callsign);
    if (mc && cc && mc !== cc) {
      out.push({
        id: `identity-${s.mmsi}-${ident.ts}-flag`,
        type: "identity", severity: 4, mmsi: s.mmsi,
        lon: s.ring.length ? s.ring[s.ring.length - 1].lon : 0,
        lat: s.ring.length ? s.ring[s.ring.length - 1].lat : 0,
        startTs: ident.ts, endTs: ident.ts,
        evidence: { kind: "flag_mismatch", midCountry: mc, callsignCountry: cc, callsign: ident.callsign },
      });
    }
  }

  s.name = ident.name;
  s.callsign = ident.callsign;
  return out;
}

export function teleportOnMessage(s: VesselState, msg: AisPosition, cfg: Config): AnomalyEvent[] {
  const lp = s.ring.length ? s.ring[s.ring.length - 1] : null;
  if (!lp) return [];
  const dtMs = msg.ts - lp.ts;
  if (dtMs <= 0 || dtMs > cfg.teleportMaxGapMs) return [];
  const distM = haversineM([lp.lon, lp.lat], [msg.lon, msg.lat]);
  const impliedSpeedKn = distM / 1852 / (dtMs / 3_600_000);
  if (impliedSpeedKn <= cfg.impossibleSpeedKn) return [];
  return [{
    id: `identity-${s.mmsi}-${msg.ts}-teleport`,
    type: "identity", severity: 4, mmsi: s.mmsi,
    lon: msg.lon, lat: msg.lat,
    startTs: lp.ts, endTs: msg.ts,
    evidence: { kind: "teleport", impliedSpeedKn: Math.round(impliedSpeedKn), distanceM: Math.round(distM), dtMs, from: [lp.lon, lp.lat], to: [msg.lon, msg.lat] },
  }];
}
```

- [ ] **Step 4: Run tests** — `npx vitest run test/identity.test.ts` → PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add src/detectors/identity.ts test/identity.test.ts
git commit -m "feat: identity anomaly detector (swap, flag mismatch, teleport)"
```

---

### Task 7: Anchor-drag detector

**Files:**
- Create: `src/detectors/anchorDrag.ts`
- Test: `test/anchorDrag.test.ts`

**Interfaces:**
- Consumes: Tasks 2–3.
- Produces: `anchorDragOnMessage(s: VesselState, msg: AisPosition, geo: GeoContext, cfg: Config): AnomalyEvent[]` and exported `circularStdDeg(degrees: number[]): number`. Uses the ring's last `cfg.dragWindow - 1` fixes + `msg`; fires severity 5 when slow-but-moving with erratic COG directly over a corridor; per-vessel cooldown via `s.dragReportedTs`.

- [ ] **Step 1: Write failing tests** — Hong Tai 58 pattern: creeping over a cable with wild COG swings.

```ts
// test/anchorDrag.test.ts
import { describe, expect, it } from "vitest";
import { CONFIG } from "../src/config";
import { GeoContext } from "../src/geo/context";
import { newVesselState, type AisPosition } from "../src/types";
import { anchorDragOnMessage, circularStdDeg } from "../src/detectors/anchorDrag";

const cables = { type: "FeatureCollection", features: [{ type: "Feature", properties: { name: "TPKM-3", approximate: true }, geometry: { type: "LineString", coordinates: [[120.0, 22.0], [121.0, 22.0]] } }] };
const geo = new GeoContext(cables as any, { type: "FeatureCollection", features: [] } as any, 1000);
const T0 = 1_750_000_000_000;

function feed(s: ReturnType<typeof newVesselState>, positions: AisPosition[]) {
  const out: any[] = [];
  for (const p of positions) {
    out.push(...anchorDragOnMessage(s, p, geo, CONFIG));
    s.ring.push(p); s.lastSeen = p.ts; // pipeline does this after detectors; tests mimic it
  }
  return out;
}

const track = (mmsi: number, lat: number, cogs: number[], sog: number): AisPosition[] =>
  cogs.map((cog, i) => ({ mmsi, lon: 120.3 + i * 0.001, lat, sog, cog, heading: cog, ts: T0 + i * 60_000 }));

describe("anchor drag detector", () => {
  it("circularStdDeg: steady course ≈ 0, erratic course is large", () => {
    expect(circularStdDeg([90, 90, 90, 90])).toBeLessThan(1);
    expect(circularStdDeg([10, 170, 300, 80, 220, 350])).toBeGreaterThan(60);
  });

  it("fires severity 5 for slow erratic vessel over the cable, respecting cooldown", () => {
    const s = newVesselState(1, T0);
    const cogs = [10, 170, 300, 80, 220, 350, 40, 190, 310, 100, 250, 20];
    const evs = feed(s, track(1, 22.0, cogs, 1.5));
    expect(evs.length).toBe(1); // cooldown: not once per message
    expect(evs[0]).toMatchObject({ type: "anchor_drag", severity: 5, mmsi: 1 });
    expect(evs[0].evidence.corridor).toBe("TPKM-3");
  });

  it("does NOT fire off-corridor", () => {
    const s = newVesselState(2, T0);
    const cogs = [10, 170, 300, 80, 220, 350, 40, 190, 310, 100, 250, 20];
    expect(feed(s, track(2, 23.5, cogs, 1.5))).toHaveLength(0);
  });

  it("does NOT fire for steady slow transit over the cable", () => {
    const s = newVesselState(3, T0);
    expect(feed(s, track(3, 22.0, Array(12).fill(90), 2.5))).toHaveLength(0);
  });

  it("does NOT fire for a moored vessel (SOG ~0)", () => {
    const s = newVesselState(4, T0);
    const cogs = [10, 170, 300, 80, 220, 350, 40, 190, 310, 100, 250, 20];
    expect(feed(s, track(4, 22.0, cogs, 0.1))).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run to verify failure** — `npx vitest run test/anchorDrag.test.ts` → FAIL.

- [ ] **Step 3: Implement**

```ts
// src/detectors/anchorDrag.ts
import type { Config } from "../config";
import type { GeoContext } from "../geo/context";
import type { AisPosition, AnomalyEvent, VesselState } from "../types";

const D2R = Math.PI / 180;

// Circular standard deviation of headings, in degrees.
export function circularStdDeg(degrees: number[]): number {
  if (degrees.length === 0) return 0;
  let sx = 0, sy = 0;
  for (const d of degrees) { sx += Math.cos(d * D2R); sy += Math.sin(d * D2R); }
  const r = Math.hypot(sx, sy) / degrees.length;
  if (r <= 1e-9) return 180;
  return Math.sqrt(-2 * Math.log(r)) / D2R;
}

export function anchorDragOnMessage(s: VesselState, msg: AisPosition, geo: GeoContext, cfg: Config): AnomalyEvent[] {
  if (s.dragReportedTs !== null && msg.ts - s.dragReportedTs < cfg.dragCooldownMs) return [];

  const window = [...s.ring.slice(-(cfg.dragWindow - 1)), msg];
  if (window.length < cfg.dragWindow) return [];

  const slowMoving = window.every((p) => p.sog >= cfg.dragMinSogKn && p.sog < cfg.dragMaxSogKn);
  if (!slowMoving) return [];
  if (!geo.inCorridor([msg.lon, msg.lat])) return [];

  const cogStd = circularStdDeg(window.map((p) => p.cog));
  if (cogStd < cfg.dragMinCogStdDeg) return [];

  s.dragReportedTs = msg.ts;
  return [{
    id: `anchor_drag-${s.mmsi}-${window[0].ts}`,
    type: "anchor_drag", severity: 5, mmsi: s.mmsi,
    lon: msg.lon, lat: msg.lat,
    startTs: window[0].ts, endTs: msg.ts,
    evidence: { corridor: geo.nearestCorridor([msg.lon, msg.lat])!.name, cogStdDeg: Math.round(cogStd), meanSogKn: Math.round((window.reduce((a, p) => a + p.sog, 0) / window.length) * 10) / 10 },
  }];
}
```

- [ ] **Step 4: Run tests** — `npx vitest run test/anchorDrag.test.ts` → PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add src/detectors/anchorDrag.ts test/anchorDrag.test.ts
git commit -m "feat: anchor-drag detector using circular COG variance over corridors"
```

---

### Task 8: Suspicion score + Tracker pipeline

**Files:**
- Create: `src/score.ts`, `src/pipeline.ts`
- Test: `test/score.test.ts`, `test/pipeline.test.ts`

**Interfaces:**
- Consumes: all four detector modules (Tasks 4–7), `GeoContext`, types, `CONFIG`.
- Produces:
  - `decayedScore(score: number, fromTs: number, toTs: number, halfLifeMs: number): number`
  - `applyEventToScore(s: VesselState, ev: AnomalyEvent, cfg: Config, now: number): void`
  - `class Tracker { states: Map<number, VesselState>; constructor(geo: GeoContext, cfg?: Config); handlePosition(msg: AisPosition): AnomalyEvent[]; handleStatic(ident: AisIdentity): AnomalyEvent[]; tick(now: number): AnomalyEvent[] }` — the ONE pure ingest→detect engine. The DO (Task 10) and the replay harness (Task 16) both wrap this class. `handlePosition` runs detectors against the pre-update state, applies scores, THEN pushes to the ring (cap `cfg.ringSize`) and bumps `lastSeen`. Detector exceptions are caught per-vessel (spec §6) — a throwing detector must not break ingest.

- [ ] **Step 1: Write failing score tests**

```ts
// test/score.test.ts
import { describe, expect, it } from "vitest";
import { CONFIG } from "../src/config";
import { newVesselState } from "../src/types";
import { applyEventToScore, decayedScore } from "../src/score";

const T0 = 1_750_000_000_000;
const DAY = 24 * 3_600_000;

describe("suspicion score", () => {
  it("halves over one half-life", () => {
    expect(decayedScore(8, T0, T0 + CONFIG.scoreHalfLifeMs, CONFIG.scoreHalfLifeMs)).toBeCloseTo(4, 5);
  });

  it("is stable when no time passes", () => {
    expect(decayedScore(8, T0, T0, CONFIG.scoreHalfLifeMs)).toBe(8);
  });

  it("applyEventToScore decays then adds severity", () => {
    const s = newVesselState(1, T0);
    s.score = 4; s.scoreTs = T0;
    applyEventToScore(s, { id: "x", type: "loitering", severity: 3, mmsi: 1, lon: 0, lat: 0, startTs: T0, endTs: null, evidence: {} }, CONFIG, T0 + DAY);
    expect(s.score).toBeCloseTo(2 + 3, 5); // 4 halved + severity 3
    expect(s.scoreTs).toBe(T0 + DAY);
  });
});
```

- [ ] **Step 2: Write failing pipeline tests**

```ts
// test/pipeline.test.ts
import { describe, expect, it } from "vitest";
import { CONFIG } from "../src/config";
import { GeoContext } from "../src/geo/context";
import { Tracker } from "../src/pipeline";
import type { AisPosition } from "../src/types";

const cables = { type: "FeatureCollection", features: [{ type: "Feature", properties: { name: "C1", approximate: true }, geometry: { type: "LineString", coordinates: [[120.0, 22.0], [121.0, 22.0]] } }] };
const geo = new GeoContext(cables as any, { type: "FeatureCollection", features: [] } as any, 1000);
const T0 = 1_750_000_000_000;
const pos = (mmsi: number, lon: number, lat: number, sog: number, tMin: number): AisPosition =>
  ({ mmsi, lon, lat, sog, cog: 90, heading: 90, ts: T0 + tMin * 60_000 });

describe("Tracker pipeline", () => {
  it("end-to-end: loiterer over cable raises event and score", () => {
    const t = new Tracker(geo, CONFIG);
    const evs: any[] = [];
    for (let m = 0; m <= 130; m += 10) evs.push(...t.handlePosition(pos(1, 120.2, 22.0, 0.5, m)));
    expect(evs.filter((e) => e.type === "loitering")).toHaveLength(1);
    const s = t.states.get(1)!;
    expect(s.score).toBeGreaterThanOrEqual(3);
    expect(s.ring.length).toBe(14);
    expect(s.lastSeen).toBe(T0 + 130 * 60_000);
  });

  it("tick() opens gaps for silent vessels", () => {
    const t = new Tracker(geo, CONFIG);
    t.handlePosition(pos(2, 120.5, 22.0, 5, 0));
    const evs = t.tick(T0 + 90 * 60_000);
    expect(evs).toHaveLength(1);
    expect(evs[0].type).toBe("ais_gap");
  });

  it("ring is capped at cfg.ringSize", () => {
    const t = new Tracker(geo, CONFIG);
    for (let i = 0; i < CONFIG.ringSize + 30; i++) t.handlePosition(pos(3, 119.0, 23.0, 10, i));
    expect(t.states.get(3)!.ring.length).toBe(CONFIG.ringSize);
  });

  it("a throwing detector cannot kill ingest", () => {
    const badGeo = new GeoContext(cables as any, { type: "FeatureCollection", features: [] } as any, 1000);
    (badGeo as any).inCorridor = () => { throw new Error("boom"); };
    const t = new Tracker(badGeo, CONFIG);
    expect(() => t.handlePosition(pos(4, 120.2, 22.0, 0.5, 0))).not.toThrow();
    expect(t.states.get(4)!.ring.length).toBe(1); // state still updated
  });

  it("handleStatic records identity and fires on swap", () => {
    const t = new Tracker(geo, CONFIG);
    t.handleStatic({ mmsi: 5, name: "A", callsign: "BV111", ts: T0 });
    const evs = t.handleStatic({ mmsi: 5, name: "B", callsign: "BV111", ts: T0 + 3_600_000 });
    expect(evs.some((e) => e.type === "identity")).toBe(true);
  });
});
```

- [ ] **Step 3: Run to verify failure** — `npx vitest run test/score.test.ts test/pipeline.test.ts` → FAIL.

- [ ] **Step 4: Implement `src/score.ts`**

```ts
// src/score.ts
import type { Config } from "./config";
import type { AnomalyEvent, VesselState } from "./types";

export function decayedScore(score: number, fromTs: number, toTs: number, halfLifeMs: number): number {
  if (toTs <= fromTs) return score;
  return score * Math.pow(0.5, (toTs - fromTs) / halfLifeMs);
}

export function applyEventToScore(s: VesselState, ev: AnomalyEvent, cfg: Config, now: number): void {
  s.score = decayedScore(s.score, s.scoreTs, now, cfg.scoreHalfLifeMs) + ev.severity;
  s.scoreTs = now;
}
```

- [ ] **Step 5: Implement `src/pipeline.ts`**

```ts
// src/pipeline.ts — pure ingest→detect engine; no I/O. Wrapped by TrackerDO and the replay harness.
import { CONFIG, type Config } from "./config";
import { anchorDragOnMessage } from "./detectors/anchorDrag";
import { gapOnMessage, gapOnTick } from "./detectors/gap";
import { identityOnStatic, teleportOnMessage } from "./detectors/identity";
import { loiteringOnMessage } from "./detectors/loitering";
import type { GeoContext } from "./geo/context";
import { applyEventToScore } from "./score";
import { newVesselState, type AisIdentity, type AisPosition, type AnomalyEvent, type VesselState } from "./types";

export class Tracker {
  states = new Map<number, VesselState>();

  constructor(private geo: GeoContext, private cfg: Config = CONFIG) {}

  private state(mmsi: number, now: number): VesselState {
    let s = this.states.get(mmsi);
    if (!s) { s = newVesselState(mmsi, now); this.states.set(mmsi, s); }
    return s;
  }

  private guard(s: VesselState, fn: () => AnomalyEvent[]): AnomalyEvent[] {
    try { return fn(); } catch (err) {
      console.error(`detector error mmsi=${s.mmsi}:`, err);
      return [];
    }
  }

  handlePosition(msg: AisPosition): AnomalyEvent[] {
    const s = this.state(msg.mmsi, msg.ts);
    const events: AnomalyEvent[] = [];

    // Detectors run against the PRE-update state (ring still ends at the previous fix).
    if (s.gapOpenSince !== null) {
      events.push(...this.guard(s, () => gapOnMessage(s, msg, this.geo, this.cfg)));
    } else {
      events.push(...this.guard(s, () => teleportOnMessage(s, msg, this.cfg)));
    }
    events.push(...this.guard(s, () => loiteringOnMessage(s, msg, this.geo, this.cfg)));
    events.push(...this.guard(s, () => anchorDragOnMessage(s, msg, this.geo, this.cfg)));

    for (const ev of events) applyEventToScore(s, ev, this.cfg, msg.ts);

    s.ring.push(msg);
    if (s.ring.length > this.cfg.ringSize) s.ring.shift();
    s.lastSeen = msg.ts;
    return events;
  }

  handleStatic(ident: AisIdentity): AnomalyEvent[] {
    const s = this.state(ident.mmsi, ident.ts);
    const events = this.guard(s, () => identityOnStatic(s, ident, this.cfg));
    for (const ev of events) applyEventToScore(s, ev, this.cfg, ident.ts);
    return events;
  }

  tick(now: number): AnomalyEvent[] {
    const events: AnomalyEvent[] = [];
    for (const s of this.states.values()) {
      const evs = this.guard(s, () => gapOnTick(s, this.geo, this.cfg, now));
      for (const ev of evs) applyEventToScore(s, ev, this.cfg, now);
      events.push(...evs);
    }
    return events;
  }
}
```

- [ ] **Step 6: Run tests** — `npx vitest run test/score.test.ts test/pipeline.test.ts` → PASS (8 tests). Then `npm test` → full suite green.

- [ ] **Step 7: Commit**

```bash
git add src/score.ts src/pipeline.ts test/score.test.ts test/pipeline.test.ts
git commit -m "feat: suspicion scoring and Tracker pipeline wiring all detectors"
```

---

### Task 9: D1 schema + persistence helpers

**Files:**
- Create: `migrations/0001_init.sql`, `src/db.ts`
- Test: `test/db.test.ts`

**Interfaces:**
- Consumes: types (Task 2). Migrations auto-apply in tests via Task 1's setup file.
- Produces:
  - Tables `vessels`, `positions`, `events`, `gfw_events` (schema below).
  - `interface PendingWrites { positions: AisPosition[]; events: AnomalyEvent[]; vessels: Map<number, VesselState> }` + `newPendingWrites()`
  - `flushWrites(db: D1Database, p: PendingWrites): Promise<void>` — single `db.batch`, upserts by PK; throws on failure so the caller retains `p` and retries next tick (spec §6).
  - `loadRecentVesselStates(db: D1Database, sinceTs: number): Promise<VesselState[]>` — DO rehydration: vessel row + its latest persisted position seeded into the ring.
  - `pruneOldPositions(db: D1Database, beforeTs: number): Promise<void>`

- [ ] **Step 1: Create `migrations/0001_init.sql`**

```sql
-- migrations/0001_init.sql
CREATE TABLE vessels (
  mmsi INTEGER PRIMARY KEY,
  name TEXT,
  callsign TEXT,
  last_lon REAL NOT NULL,
  last_lat REAL NOT NULL,
  last_sog REAL NOT NULL,
  last_cog REAL NOT NULL,
  last_ts INTEGER NOT NULL,
  score REAL NOT NULL DEFAULT 0,
  score_ts INTEGER NOT NULL
);
CREATE INDEX idx_vessels_last_ts ON vessels (last_ts);

CREATE TABLE positions (
  mmsi INTEGER NOT NULL,
  ts INTEGER NOT NULL,
  lon REAL NOT NULL,
  lat REAL NOT NULL,
  sog REAL NOT NULL,
  cog REAL NOT NULL,
  PRIMARY KEY (mmsi, ts)
);
CREATE INDEX idx_positions_ts ON positions (ts);

CREATE TABLE events (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  severity INTEGER NOT NULL,
  mmsi INTEGER NOT NULL,
  lon REAL NOT NULL,
  lat REAL NOT NULL,
  start_ts INTEGER NOT NULL,
  end_ts INTEGER,
  evidence TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX idx_events_start_ts ON events (start_ts);
CREATE INDEX idx_events_mmsi ON events (mmsi);

CREATE TABLE gfw_events (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  mmsi INTEGER,
  lon REAL NOT NULL,
  lat REAL NOT NULL,
  start_ts INTEGER NOT NULL,
  end_ts INTEGER,
  raw TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX idx_gfw_events_start_ts ON gfw_events (start_ts);
```

- [ ] **Step 2: Write failing tests**

```ts
// test/db.test.ts
import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { flushWrites, loadRecentVesselStates, newPendingWrites, pruneOldPositions } from "../src/db";
import { newVesselState } from "../src/types";

const T0 = 1_750_000_000_000;

function samplePending() {
  const p = newPendingWrites();
  const s = newVesselState(412000001, T0);
  s.name = "TEST SHIP"; s.callsign = "BXYZ1"; s.score = 6.5; s.scoreTs = T0;
  s.ring.push({ mmsi: 412000001, lon: 120.2, lat: 22.0, sog: 0.5, cog: 90, heading: 90, ts: T0 });
  s.lastSeen = T0;
  p.vessels.set(s.mmsi, s);
  p.positions.push({ mmsi: 412000001, lon: 120.2, lat: 22.0, sog: 0.5, cog: 90, heading: 90, ts: T0 });
  p.events.push({ id: `loitering-412000001-${T0}`, type: "loitering", severity: 3, mmsi: 412000001, lon: 120.2, lat: 22.0, startTs: T0, endTs: null, evidence: { corridor: "C1" } });
  return p;
}

describe("db persistence", () => {
  beforeEach(async () => {
    await env.DB.batch([env.DB.prepare("DELETE FROM vessels"), env.DB.prepare("DELETE FROM positions"), env.DB.prepare("DELETE FROM events")]);
  });

  it("flushWrites persists vessels, positions, events", async () => {
    await flushWrites(env.DB, samplePending());
    const v = await env.DB.prepare("SELECT * FROM vessels WHERE mmsi = 412000001").first<any>();
    expect(v.name).toBe("TEST SHIP");
    expect(v.score).toBeCloseTo(6.5);
    const e = await env.DB.prepare("SELECT * FROM events").first<any>();
    expect(e.end_ts).toBeNull();
    expect(JSON.parse(e.evidence).corridor).toBe("C1");
  });

  it("re-flushing the same event id upserts (closes) instead of duplicating", async () => {
    const p = samplePending();
    await flushWrites(env.DB, p);
    p.events[0] = { ...p.events[0], endTs: T0 + 3_600_000 };
    await flushWrites(env.DB, p);
    const rows = await env.DB.prepare("SELECT COUNT(*) AS n FROM events").first<any>();
    expect(rows.n).toBe(1);
    const e = await env.DB.prepare("SELECT end_ts FROM events").first<any>();
    expect(e.end_ts).toBe(T0 + 3_600_000);
  });

  it("loadRecentVesselStates rehydrates state with last position in ring", async () => {
    await flushWrites(env.DB, samplePending());
    const states = await loadRecentVesselStates(env.DB, T0 - 1);
    expect(states).toHaveLength(1);
    expect(states[0].mmsi).toBe(412000001);
    expect(states[0].ring).toHaveLength(1);
    expect(states[0].ring[0].lon).toBeCloseTo(120.2);
    expect(states[0].score).toBeCloseTo(6.5);
  });

  it("pruneOldPositions deletes only old rows", async () => {
    const p = samplePending();
    p.positions.push({ mmsi: 412000001, lon: 120.2, lat: 22.0, sog: 0.5, cog: 90, heading: 90, ts: T0 - 40 * 24 * 3_600_000 });
    await flushWrites(env.DB, p);
    await pruneOldPositions(env.DB, T0 - 30 * 24 * 3_600_000);
    const rows = await env.DB.prepare("SELECT COUNT(*) AS n FROM positions").first<any>();
    expect(rows.n).toBe(1);
  });
});
```

- [ ] **Step 3: Run to verify failure** — `npx vitest run test/db.test.ts` → FAIL.

- [ ] **Step 4: Implement `src/db.ts`**

```ts
// src/db.ts
import { newVesselState, type AisPosition, type AnomalyEvent, type VesselState } from "./types";

export interface PendingWrites {
  positions: AisPosition[];
  events: AnomalyEvent[];
  vessels: Map<number, VesselState>;
}

export function newPendingWrites(): PendingWrites {
  return { positions: [], events: [], vessels: new Map() };
}

export async function flushWrites(db: D1Database, p: PendingWrites): Promise<void> {
  const stmts: D1PreparedStatement[] = [];

  for (const s of p.vessels.values()) {
    const lp = s.ring[s.ring.length - 1];
    if (!lp) continue;
    stmts.push(db.prepare(
      `INSERT INTO vessels (mmsi, name, callsign, last_lon, last_lat, last_sog, last_cog, last_ts, score, score_ts)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)
       ON CONFLICT (mmsi) DO UPDATE SET name = ?2, callsign = ?3, last_lon = ?4, last_lat = ?5,
         last_sog = ?6, last_cog = ?7, last_ts = ?8, score = ?9, score_ts = ?10`,
    ).bind(s.mmsi, s.name, s.callsign, lp.lon, lp.lat, lp.sog, lp.cog, s.lastSeen, s.score, s.scoreTs));
  }

  for (const pos of p.positions) {
    stmts.push(db.prepare(
      `INSERT OR REPLACE INTO positions (mmsi, ts, lon, lat, sog, cog) VALUES (?1, ?2, ?3, ?4, ?5, ?6)`,
    ).bind(pos.mmsi, pos.ts, pos.lon, pos.lat, pos.sog, pos.cog));
  }

  for (const ev of p.events) {
    stmts.push(db.prepare(
      `INSERT INTO events (id, type, severity, mmsi, lon, lat, start_ts, end_ts, evidence)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
       ON CONFLICT (id) DO UPDATE SET severity = ?3, lon = ?5, lat = ?6, end_ts = ?8, evidence = ?9`,
    ).bind(ev.id, ev.type, ev.severity, ev.mmsi, ev.lon, ev.lat, ev.startTs, ev.endTs, JSON.stringify(ev.evidence)));
  }

  if (stmts.length) await db.batch(stmts);
}

export async function loadRecentVesselStates(db: D1Database, sinceTs: number): Promise<VesselState[]> {
  const { results } = await db.prepare(`SELECT * FROM vessels WHERE last_ts >= ?1`).bind(sinceTs).all<any>();
  return results.map((r) => {
    const s = newVesselState(r.mmsi, r.last_ts);
    s.name = r.name; s.callsign = r.callsign;
    s.score = r.score; s.scoreTs = r.score_ts;
    s.lastSeen = r.last_ts;
    s.ring.push({ mmsi: r.mmsi, lon: r.last_lon, lat: r.last_lat, sog: r.last_sog, cog: r.last_cog, heading: null, ts: r.last_ts });
    return s;
  });
}

export async function pruneOldPositions(db: D1Database, beforeTs: number): Promise<void> {
  await db.prepare(`DELETE FROM positions WHERE ts < ?1`).bind(beforeTs).run();
}
```

- [ ] **Step 5: Run tests** — `npx vitest run test/db.test.ts` → PASS (4 tests).

- [ ] **Step 6: Commit**

```bash
git add migrations/0001_init.sql src/db.ts test/db.test.ts
git rm --cached migrations/.gitkeep 2>/dev/null; rm -f migrations/.gitkeep
git commit -m "feat: D1 schema and batched persistence helpers"
```

---

### Task 10: AISStream parser + TrackerDO

**Files:**
- Create: `src/aisstream.ts`
- Modify: `src/do/tracker.ts` (replace Task 1 stub entirely)
- Test: `test/aisstream.test.ts`

**Interfaces:**
- Consumes: `Tracker` (Task 8), `flushWrites`/`loadRecentVesselStates`/`pruneOldPositions`/`PendingWrites` (Task 9), `CONFIG`, `Env` (Task 1).
- Produces:
  - `parseAisTime(s: string): number | null` — AISStream `time_utc` like `"2026-07-04 12:34:56.789101 +0000 UTC"` → ms epoch.
  - `parseAisStreamMessage(raw: unknown): { pos?: AisPosition; ident?: AisIdentity } | null` — returns null for unknown/malformed messages, never throws.
  - `TrackerDO` with `fetch()` handling `GET /ensure` (connect ws if needed, returns `{connected, vessels}` JSON) — Task 11's worker calls this from `scheduled()` and API traffic.

- [ ] **Step 1: Write failing parser tests**

```ts
// test/aisstream.test.ts
import { describe, expect, it } from "vitest";
import { parseAisStreamMessage, parseAisTime } from "../src/aisstream";

describe("aisstream parsing", () => {
  it("parses time_utc format", () => {
    const ms = parseAisTime("2026-07-04 12:00:00.000000 +0000 UTC");
    expect(ms).toBe(Date.UTC(2026, 6, 4, 12, 0, 0));
  });

  it("parses a PositionReport", () => {
    const raw = {
      MessageType: "PositionReport",
      MetaData: { MMSI: 412345678, ShipName: "TEST", latitude: 24.5, longitude: 121.9, time_utc: "2026-07-04 12:00:00.000000 +0000 UTC" },
      Message: { PositionReport: { Sog: 1.4, Cog: 132.7, TrueHeading: 130 } },
    };
    const out = parseAisStreamMessage(raw)!;
    expect(out.pos).toMatchObject({ mmsi: 412345678, lon: 121.9, lat: 24.5, sog: 1.4, cog: 132.7, heading: 130 });
    expect(out.ident).toBeUndefined();
  });

  it("maps TrueHeading 511 (unavailable) to null", () => {
    const raw = {
      MessageType: "PositionReport",
      MetaData: { MMSI: 1, latitude: 24, longitude: 121, time_utc: "2026-07-04 12:00:00.000000 +0000 UTC" },
      Message: { PositionReport: { Sog: 0, Cog: 0, TrueHeading: 511 } },
    };
    expect(parseAisStreamMessage(raw)!.pos!.heading).toBeNull();
  });

  it("parses ShipStaticData into an identity", () => {
    const raw = {
      MessageType: "ShipStaticData",
      MetaData: { MMSI: 412345678, latitude: 24.5, longitude: 121.9, time_utc: "2026-07-04 12:00:00.000000 +0000 UTC" },
      Message: { ShipStaticData: { Name: "SHUNXIN 39", CallSign: "BXYZ1" } },
    };
    const out = parseAisStreamMessage(raw)!;
    expect(out.ident).toMatchObject({ mmsi: 412345678, name: "SHUNXIN 39", callsign: "BXYZ1" });
  });

  it("returns null on malformed input instead of throwing", () => {
    expect(parseAisStreamMessage(null)).toBeNull();
    expect(parseAisStreamMessage({ MessageType: "PositionReport" })).toBeNull();
    expect(parseAisStreamMessage("garbage")).toBeNull();
  });
});
```

- [ ] **Step 2: Run to verify failure** — `npx vitest run test/aisstream.test.ts` → FAIL.

- [ ] **Step 3: Implement `src/aisstream.ts`**

```ts
// src/aisstream.ts — AISStream.io wire format → internal types. Never throws.
import type { AisIdentity, AisPosition } from "./types";

export function parseAisTime(s: string): number | null {
  // "2026-07-04 12:34:56.789101 +0000 UTC" → ISO
  const m = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2})(\.\d+)? \+0000 UTC$/.exec(s);
  if (!m) return null;
  const frac = m[3] ? m[3].slice(0, 4) : "";
  const ms = Date.parse(`${m[1]}T${m[2]}${frac}Z`);
  return Number.isNaN(ms) ? null : ms;
}

export function parseAisStreamMessage(raw: unknown): { pos?: AisPosition; ident?: AisIdentity } | null {
  try {
    const r = raw as any;
    if (!r || typeof r !== "object" || !r.MetaData) return null;
    const mmsi = Number(r.MetaData.MMSI);
    const ts = parseAisTime(String(r.MetaData.time_utc ?? ""));
    if (!Number.isInteger(mmsi) || mmsi <= 0 || ts === null) return null;

    if (r.MessageType === "PositionReport" && r.Message?.PositionReport) {
      const pr = r.Message.PositionReport;
      const lat = Number(r.MetaData.latitude), lon = Number(r.MetaData.longitude);
      if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
      const heading = Number(pr.TrueHeading);
      return {
        pos: {
          mmsi, lon, lat,
          sog: Number(pr.Sog) || 0,
          cog: Number(pr.Cog) || 0,
          heading: Number.isFinite(heading) && heading !== 511 ? heading : null,
          ts,
        },
      };
    }

    if (r.MessageType === "ShipStaticData" && r.Message?.ShipStaticData) {
      const sd = r.Message.ShipStaticData;
      return { ident: { mmsi, name: String(sd.Name ?? "").trim(), callsign: String(sd.CallSign ?? "").trim(), ts } };
    }

    return null;
  } catch {
    return null;
  }
}
```

- [ ] **Step 4: Run parser tests** — `npx vitest run test/aisstream.test.ts` → PASS (5 tests).

- [ ] **Step 5: Replace `src/do/tracker.ts` with the real DO**

The DO is deliberately thin glue: everything testable lives in `pipeline.ts`/`db.ts` (already covered). Websocket behavior is verified manually in Step 7.

```ts
// src/do/tracker.ts — websocket lifecycle, alarms, batching. Logic lives in pipeline.ts.
import { CONFIG } from "../config";
import { flushWrites, loadRecentVesselStates, newPendingWrites, pruneOldPositions, type PendingWrites } from "../db";
import { GeoContext } from "../geo/context";
import { Tracker } from "../pipeline";
import { parseAisStreamMessage } from "../aisstream";
import { haversineM } from "../geo/geo";
import type { AisPosition } from "../types";
import type { Env } from "../worker";

export class TrackerDO implements DurableObject {
  private tracker = new Tracker(new GeoContext());
  private pending: PendingWrites = newPendingWrites();
  private ws: WebSocket | null = null;
  private lastWsMessageAt = 0;
  private backoffMs = CONFIG.backoffMinMs;
  private hydrated = false;
  private lastPersisted = new Map<number, AisPosition>(); // downsampling reference
  private lastPruneAt = 0;

  constructor(private ctx: DurableObjectState, private env: Env) {}

  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname === "/ensure") {
      await this.ensureRunning();
      return Response.json({
        connected: this.ws !== null && this.ws.readyState === WebSocket.READY_STATE_OPEN,
        vessels: this.tracker.states.size,
        lastWsMessageAt: this.lastWsMessageAt,
      });
    }
    return new Response("not found", { status: 404 });
  }

  private async ensureRunning(): Promise<void> {
    if (!this.hydrated) {
      this.hydrated = true;
      const states = await loadRecentVesselStates(this.env.DB, Date.now() - 6 * 3_600_000);
      for (const s of states) this.tracker.states.set(s.mmsi, s);
    }
    if ((await this.ctx.storage.getAlarm()) === null) {
      await this.ctx.storage.setAlarm(Date.now() + CONFIG.alarmIntervalMs);
    }
    this.connect();
  }

  private connect(): void {
    if (this.ws && (this.ws.readyState === WebSocket.READY_STATE_OPEN || this.ws.readyState === WebSocket.READY_STATE_CONNECTING)) return;
    try {
      const ws = new WebSocket("wss://stream.aisstream.io/v0/stream");
      this.ws = ws;
      ws.addEventListener("open", () => {
        this.backoffMs = CONFIG.backoffMinMs;
        this.lastWsMessageAt = Date.now();
        const b = CONFIG.bbox;
        ws.send(JSON.stringify({
          APIKey: this.env.AISSTREAM_KEY,
          BoundingBoxes: [[[b.minLat, b.minLon], [b.maxLat, b.maxLon]]], // AISStream expects [lat, lon]
          FilterMessageTypes: ["PositionReport", "ShipStaticData"],
        }));
      });
      ws.addEventListener("message", (ev) => this.onWsMessage(ev));
      ws.addEventListener("close", () => { this.ws = null; });
      ws.addEventListener("error", () => { try { ws.close(); } catch {} this.ws = null; });
    } catch (err) {
      console.error("ws connect failed:", err);
      this.ws = null;
    }
  }

  private onWsMessage(ev: MessageEvent): void {
    this.lastWsMessageAt = Date.now();
    // Per-message try/catch: one malformed message must not kill the handler (spec §6).
    try {
      const parsed = parseAisStreamMessage(JSON.parse(String(ev.data)));
      if (!parsed) return;
      if (parsed.pos) {
        const events = this.tracker.handlePosition(parsed.pos);
        this.pending.events.push(...events);
        this.pending.vessels.set(parsed.pos.mmsi, this.tracker.states.get(parsed.pos.mmsi)!);
        this.maybeQueuePosition(parsed.pos);
      }
      if (parsed.ident) {
        const events = this.tracker.handleStatic(parsed.ident);
        this.pending.events.push(...events);
        this.pending.vessels.set(parsed.ident.mmsi, this.tracker.states.get(parsed.ident.mmsi)!);
      }
    } catch (err) {
      console.error("message handling error:", err);
    }
  }

  // Downsample: persist a track point only if enough time passed or the vessel moved enough.
  private maybeQueuePosition(pos: AisPosition): void {
    const prev = this.lastPersisted.get(pos.mmsi);
    if (prev &&
        pos.ts - prev.ts < CONFIG.persistMinIntervalMs &&
        haversineM([prev.lon, prev.lat], [pos.lon, pos.lat]) < CONFIG.persistMinMoveM) return;
    this.lastPersisted.set(pos.mmsi, pos);
    this.pending.positions.push(pos);
  }

  async alarm(): Promise<void> {
    const now = Date.now();

    // 1. Watchdog: reconnect (with backoff) if the stream went quiet.
    const wsOpen = this.ws !== null && this.ws.readyState === WebSocket.READY_STATE_OPEN;
    if (!wsOpen || now - this.lastWsMessageAt > CONFIG.watchdogMs) {
      try { this.ws?.close(); } catch {}
      this.ws = null;
      this.backoffMs = Math.min(this.backoffMs * 2, CONFIG.backoffMaxMs);
      if (now - this.lastWsMessageAt > this.backoffMs) this.connect();
    }

    // 2. Gap detection tick.
    const events = this.tracker.tick(now);
    this.pending.events.push(...events);
    for (const ev of events) this.pending.vessels.set(ev.mmsi, this.tracker.states.get(ev.mmsi)!);

    // 3. Flush batched writes; on failure keep pending and retry next tick (spec §6).
    if (this.pending.events.length || this.pending.positions.length || this.pending.vessels.size) {
      const batch = this.pending;
      try {
        await flushWrites(this.env.DB, batch);
        this.pending = newPendingWrites();
      } catch (err) {
        console.error("flush failed; retrying next tick:", err);
      }
    }

    // 4. Hourly retention prune.
    if (now - this.lastPruneAt > 3_600_000) {
      this.lastPruneAt = now;
      try { await pruneOldPositions(this.env.DB, now - CONFIG.positionRetentionMs); } catch (err) { console.error(err); }
    }

    await this.ctx.storage.setAlarm(now + CONFIG.alarmIntervalMs);
  }
}
```

- [ ] **Step 6: Typecheck + full suite**

Run: `npx tsc --noEmit && npm test`
Expected: no type errors; all prior tests still PASS.

- [ ] **Step 7: Manual smoke against live AISStream**

Get a free key at https://aisstream.io (account required). Then:

```bash
echo 'AISSTREAM_KEY=<your key>' >> .dev.vars
echo 'GFW_TOKEN=placeholder' >> .dev.vars
npx wrangler dev
# in another terminal:
curl -s http://localhost:8787/api/admin/ensure   # 501 until Task 11 wires routing — instead hit the DO directly:
```

Note: until Task 11 the stub worker returns 501 for everything, so full manual verification happens in Task 11 Step 5. This step only confirms clean startup (`wrangler dev` boots without errors).

- [ ] **Step 8: Commit**

```bash
git add src/aisstream.ts src/do/tracker.ts test/aisstream.test.ts
git commit -m "feat: AISStream parser and TrackerDO with watchdog, backoff, batched flush"
```

---

### Task 11: API worker routes

**Files:**
- Modify: `src/worker.ts` (replace stub fetch handler; keep `Env` and the `TrackerDO` re-export)
- Test: `test/api.test.ts`

**Interfaces:**
- Consumes: D1 tables (Task 9), `TrackerDO /ensure` (Task 10), `CONFIG`.
- Produces HTTP API (all responses include `generatedAt`, CORS `*` for embedding):
  - `GET /api/snapshot` → `{ generatedAt, newestTs, vessels: <GeoJSON FeatureCollection> }`; Point features, properties `{ mmsi, name, sog, cog, score, lastTs }`; vessels heard within `snapshotWindowMs`; score decayed to read time.
  - `GET /api/events?since=<ms>` → `{ generatedAt, events: AnomalyEvent[] }` newest-first, limit 200.
  - `GET /api/gfw` → `{ generatedAt, events: [...] }` from `gfw_events`, last 14 days.
  - `GET /api/vessel/:mmsi` → `{ generatedAt, vessel, track: [{lon,lat,sog,cog,ts}...] (≤500 asc), events: AnomalyEvent[] (desc) }` or 404.
  - Anything not `/api/*` → `env.ASSETS.fetch(request)`.

- [ ] **Step 1: Write failing tests** (seed D1 directly, call the worker via `SELF`)

```ts
// test/api.test.ts
import { env, SELF } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";

const T0 = Date.now() - 10 * 60_000; // "10 minutes ago" so snapshot window includes it

async function seed() {
  await env.DB.batch([
    env.DB.prepare("DELETE FROM vessels"), env.DB.prepare("DELETE FROM positions"),
    env.DB.prepare("DELETE FROM events"), env.DB.prepare("DELETE FROM gfw_events"),
    env.DB.prepare(`INSERT INTO vessels VALUES (412000001, 'TEST SHIP', 'BXYZ1', 120.2, 22.0, 0.5, 90, ?1, 6.5, ?1)`).bind(T0),
    env.DB.prepare(`INSERT INTO vessels VALUES (412000002, 'OLD SHIP', NULL, 121.0, 23.0, 5, 0, ?1, 0, ?1)`).bind(T0 - 2 * 3_600_000),
    env.DB.prepare(`INSERT INTO positions VALUES (412000001, ?1, 120.19, 21.99, 1, 88)`).bind(T0 - 60_000),
    env.DB.prepare(`INSERT INTO positions VALUES (412000001, ?1, 120.2, 22.0, 0.5, 90)`).bind(T0),
    env.DB.prepare(`INSERT INTO events VALUES ('loitering-412000001-1', 'loitering', 3, 412000001, 120.2, 22.0, ?1, NULL, '{"corridor":"C1"}')`).bind(T0),
    env.DB.prepare(`INSERT INTO gfw_events VALUES ('gfw-1', 'gap', 412000001, 120.3, 22.1, ?1, ?2, '{}')`).bind(T0 - 3_600_000, T0),
  ]);
}

describe("API worker", () => {
  beforeEach(seed);

  it("/api/snapshot returns recent vessels as GeoJSON with generatedAt", async () => {
    const res = await SELF.fetch("https://x/api/snapshot");
    expect(res.status).toBe(200);
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
    const body = await res.json<any>();
    expect(body.generatedAt).toBeGreaterThan(0);
    expect(body.vessels.type).toBe("FeatureCollection");
    const mmsis = body.vessels.features.map((f: any) => f.properties.mmsi);
    expect(mmsis).toContain(412000001);
    expect(mmsis).not.toContain(412000002); // outside snapshot window
    const f = body.vessels.features[0];
    expect(f.geometry).toEqual({ type: "Point", coordinates: [120.2, 22.0] });
    expect(f.properties.score).toBeGreaterThan(0);
  });

  it("/api/events honours since and orders newest-first", async () => {
    const res = await SELF.fetch(`https://x/api/events?since=${T0 - 1}`);
    const body = await res.json<any>();
    expect(body.events).toHaveLength(1);
    expect(body.events[0]).toMatchObject({ id: "loitering-412000001-1", type: "loitering", endTs: null });
    expect(body.events[0].evidence.corridor).toBe("C1");
    const none = await (await SELF.fetch(`https://x/api/events?since=${T0 + 1}`)).json<any>();
    expect(none.events).toHaveLength(0);
  });

  it("/api/gfw returns corroboration events", async () => {
    const body = await (await SELF.fetch("https://x/api/gfw")).json<any>();
    expect(body.events).toHaveLength(1);
    expect(body.events[0].id).toBe("gfw-1");
  });

  it("/api/vessel/:mmsi returns dossier with ascending track", async () => {
    const body = await (await SELF.fetch("https://x/api/vessel/412000001")).json<any>();
    expect(body.vessel.name).toBe("TEST SHIP");
    expect(body.track).toHaveLength(2);
    expect(body.track[0].ts).toBeLessThan(body.track[1].ts);
    expect(body.events).toHaveLength(1);
  });

  it("/api/vessel unknown mmsi → 404; bad mmsi → 400", async () => {
    expect((await SELF.fetch("https://x/api/vessel/999999999")).status).toBe(404);
    expect((await SELF.fetch("https://x/api/vessel/abc")).status).toBe(400);
  });
});
```

- [ ] **Step 2: Run to verify failure** — `npx vitest run test/api.test.ts` → FAIL (worker returns 501).

- [ ] **Step 3: Implement the router in `src/worker.ts`** (keep `Env` interface and `export { TrackerDO }`)

```ts
// src/worker.ts
export { TrackerDO } from "./do/tracker";
import { CONFIG } from "./config";
import { decayedScore } from "./score";
import { gfwSync } from "./gfw";

export interface Env {
  DB: D1Database;
  TRACKER: DurableObjectNamespace;
  ASSETS: Fetcher;
  AISSTREAM_KEY: string;
  GFW_TOKEN: string;
}

const CORS = { "access-control-allow-origin": "*", "content-type": "application/json" };
const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: CORS });

function ensureTracker(env: Env, ctx: ExecutionContext): void {
  const stub = env.TRACKER.get(env.TRACKER.idFromName("singleton"));
  ctx.waitUntil(stub.fetch("https://do/ensure").catch((e) => console.error("ensure failed:", e)));
}

const rowToEvent = (r: any) => ({
  id: r.id, type: r.type, severity: r.severity, mmsi: r.mmsi,
  lon: r.lon, lat: r.lat, startTs: r.start_ts, endTs: r.end_ts,
  evidence: JSON.parse(r.evidence ?? "{}"),
});

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(req.url);
    if (!url.pathname.startsWith("/api/")) return env.ASSETS.fetch(req);

    ensureTracker(env, ctx); // any API hit keeps the ingest DO alive
    const now = Date.now();

    if (url.pathname === "/api/snapshot") {
      const { results } = await env.DB.prepare(
        `SELECT * FROM vessels WHERE last_ts >= ?1 ORDER BY score DESC`,
      ).bind(now - CONFIG.snapshotWindowMs).all<any>();
      const newestTs = results.reduce((m, r) => Math.max(m, r.last_ts), 0);
      return json({
        generatedAt: now,
        newestTs: newestTs || null,
        vessels: {
          type: "FeatureCollection",
          features: results.map((r) => ({
            type: "Feature",
            geometry: { type: "Point", coordinates: [r.last_lon, r.last_lat] },
            properties: {
              mmsi: r.mmsi, name: r.name, sog: r.last_sog, cog: r.last_cog,
              score: Math.round(decayedScore(r.score, r.score_ts, now, CONFIG.scoreHalfLifeMs) * 10) / 10,
              lastTs: r.last_ts,
            },
          })),
        },
      });
    }

    if (url.pathname === "/api/events") {
      const since = Number(url.searchParams.get("since") ?? 0);
      const { results } = await env.DB.prepare(
        `SELECT * FROM events WHERE start_ts >= ?1 ORDER BY start_ts DESC LIMIT 200`,
      ).bind(Number.isFinite(since) ? since : 0).all<any>();
      return json({ generatedAt: now, events: results.map(rowToEvent) });
    }

    if (url.pathname === "/api/gfw") {
      const { results } = await env.DB.prepare(
        `SELECT * FROM gfw_events WHERE start_ts >= ?1 ORDER BY start_ts DESC LIMIT 500`,
      ).bind(now - 14 * 24 * 3_600_000).all<any>();
      return json({
        generatedAt: now,
        events: results.map((r) => ({ id: r.id, type: r.type, mmsi: r.mmsi, lon: r.lon, lat: r.lat, startTs: r.start_ts, endTs: r.end_ts })),
      });
    }

    const vesselMatch = /^\/api\/vessel\/(\d{1,9})$/.exec(url.pathname);
    if (vesselMatch) {
      const mmsi = Number(vesselMatch[1]);
      const vessel = await env.DB.prepare(`SELECT * FROM vessels WHERE mmsi = ?1`).bind(mmsi).first<any>();
      if (!vessel) return json({ error: "unknown vessel" }, 404);
      const [track, events] = await Promise.all([
        env.DB.prepare(`SELECT ts, lon, lat, sog, cog FROM positions WHERE mmsi = ?1 ORDER BY ts DESC LIMIT 500`).bind(mmsi).all<any>(),
        env.DB.prepare(`SELECT * FROM events WHERE mmsi = ?1 ORDER BY start_ts DESC LIMIT 100`).bind(mmsi).all<any>(),
      ]);
      return json({
        generatedAt: now,
        vessel: {
          mmsi: vessel.mmsi, name: vessel.name, callsign: vessel.callsign,
          lon: vessel.last_lon, lat: vessel.last_lat, sog: vessel.last_sog, cog: vessel.last_cog, lastTs: vessel.last_ts,
          score: Math.round(decayedScore(vessel.score, vessel.score_ts, now, CONFIG.scoreHalfLifeMs) * 10) / 10,
        },
        track: track.results.reverse(),
        events: events.results.map(rowToEvent),
      });
    }

    if (url.pathname.startsWith("/api/vessel/")) return json({ error: "bad mmsi" }, 400);
    return json({ error: "not found" }, 404);
  },

  async scheduled(event: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ensureTracker(env, ctx); // */5 cron doubles as ingest keep-alive
    if (event.cron === "15 2 * * *") {
      ctx.waitUntil(gfwSync(env, Date.now()).catch((e) => console.error("gfw sync failed:", e)));
    }
  },
} satisfies ExportedHandler<Env>;
```

This imports `gfwSync` from Task 12. To keep this task independently green, create a placeholder module now (Task 12 replaces it — this is glue, not deferred work):

```ts
// src/gfw.ts (minimal until Task 12)
import type { Env } from "./worker";
export async function gfwSync(_env: Env, _now: number): Promise<number> { return 0; }
```

- [ ] **Step 4: Run tests** — `npx vitest run test/api.test.ts` → PASS (5 tests). Then `npx tsc --noEmit && npm test` → all green.

- [ ] **Step 5: Manual smoke with live data**

```bash
npx wrangler dev
# other terminal (wait ~2 min for AIS traffic to accumulate):
curl -s http://localhost:8787/api/snapshot | head -c 400
```
Expected: JSON with `generatedAt` and a growing `vessels.features` array (Taiwan Strait has dense traffic; tens of vessels within minutes).

- [ ] **Step 6: Commit**

```bash
git add src/worker.ts src/gfw.ts test/api.test.ts
git commit -m "feat: public API routes (snapshot, events, gfw, vessel dossier)"
```

---

### Task 12: GFW corroboration sync

**Files:**
- Modify: `src/gfw.ts` (replace placeholder)
- Test: `test/gfw.test.ts`

**Interfaces:**
- Consumes: `Env`, D1 `gfw_events` table, `CONFIG.bbox`.
- Produces: `gfwSync(env: Env, now: number, fetchImpl?: typeof fetch): Promise<number>` (returns rows upserted; `fetchImpl` injectable for tests) and exported `GFW_DATASETS` constant.

**External-API note:** endpoint shape follows GFW API v3 (`POST https://gateway.api.globalfishingwatch.org/v3/events`, Bearer token). Dataset IDs are constants at the top of the file — verify them against https://globalfishingwatch.org/our-apis/documentation when obtaining the token (free registration), and adjust the constant only.

- [ ] **Step 1: Write failing tests (mock fetch)**

```ts
// test/gfw.test.ts
import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { gfwSync } from "../src/gfw";

const T0 = Date.now();

const fakeFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const req = { url: String(input), ...init };
  expect(req.url).toContain("globalfishingwatch.org");
  expect((init!.headers as any).Authorization).toMatch(/^Bearer /);
  return new Response(JSON.stringify({
    entries: [
      { id: "gfw-abc", type: "gap", start: new Date(T0 - 86_400_000).toISOString(), end: new Date(T0 - 82_800_000).toISOString(),
        position: { lon: 120.4, lat: 22.2 }, vessel: { ssvid: "412000009" } },
      { id: "gfw-def", type: "loitering", start: new Date(T0 - 40_000_000).toISOString(), end: null,
        position: { lon: 121.9, lat: 24.7 }, vessel: {} },
    ],
    nextOffset: null,
  }), { status: 200, headers: { "content-type": "application/json" } });
}) as typeof fetch;

describe("gfwSync", () => {
  beforeEach(async () => { await env.DB.prepare("DELETE FROM gfw_events").run(); });

  it("upserts GFW entries into gfw_events", async () => {
    const n = await gfwSync({ ...env, GFW_TOKEN: "tok" } as any, T0, fakeFetch);
    expect(n).toBe(2);
    const rows = await env.DB.prepare("SELECT * FROM gfw_events ORDER BY id").all<any>();
    expect(rows.results).toHaveLength(2);
    expect(rows.results[0]).toMatchObject({ id: "gfw-abc", type: "gap", mmsi: 412000009, lon: 120.4, lat: 22.2 });
    expect(rows.results[1].mmsi).toBeNull();
    expect(rows.results[1].end_ts).toBeNull();
  });

  it("is idempotent on re-run", async () => {
    await gfwSync({ ...env, GFW_TOKEN: "tok" } as any, T0, fakeFetch);
    await gfwSync({ ...env, GFW_TOKEN: "tok" } as any, T0, fakeFetch);
    const n = await env.DB.prepare("SELECT COUNT(*) AS n FROM gfw_events").first<any>();
    expect(n.n).toBe(2);
  });
});
```

- [ ] **Step 2: Run to verify failure** — `npx vitest run test/gfw.test.ts` → FAIL (placeholder returns 0).

- [ ] **Step 3: Implement `src/gfw.ts`**

```ts
// src/gfw.ts — daily corroboration pull from Global Fishing Watch v3 events API.
import { CONFIG } from "./config";
import type { Env } from "./worker";

// Verify against GFW docs when registering for a token; only these constants should need editing.
export const GFW_DATASETS = [
  "public-global-gaps-events:latest",
  "public-global-loitering-events:latest",
];
const GFW_URL = "https://gateway.api.globalfishingwatch.org/v3/events?limit=500&offset=0";

export async function gfwSync(env: Env, now: number, fetchImpl: typeof fetch = fetch): Promise<number> {
  const b = CONFIG.bbox;
  const res = await fetchImpl(GFW_URL, {
    method: "POST",
    headers: { Authorization: `Bearer ${env.GFW_TOKEN}`, "content-type": "application/json" },
    body: JSON.stringify({
      datasets: GFW_DATASETS,
      startDate: new Date(now - 7 * 24 * 3_600_000).toISOString().slice(0, 10),
      endDate: new Date(now).toISOString().slice(0, 10),
      geometry: {
        type: "Polygon",
        coordinates: [[[b.minLon, b.minLat], [b.maxLon, b.minLat], [b.maxLon, b.maxLat], [b.minLon, b.maxLat], [b.minLon, b.minLat]]],
      },
    }),
  });
  if (!res.ok) throw new Error(`GFW API ${res.status}: ${await res.text()}`);
  const data = await res.json<any>();
  const entries: any[] = data.entries ?? [];

  const stmts = entries
    .filter((e) => e.id && e.position && Number.isFinite(e.position.lon) && Number.isFinite(e.position.lat))
    .map((e) => env.DB.prepare(
      `INSERT OR REPLACE INTO gfw_events (id, type, mmsi, lon, lat, start_ts, end_ts, raw) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)`,
    ).bind(
      String(e.id), String(e.type ?? "unknown"),
      e.vessel?.ssvid ? Number(e.vessel.ssvid) : null,
      e.position.lon, e.position.lat,
      Date.parse(e.start), e.end ? Date.parse(e.end) : null,
      JSON.stringify(e),
    ));
  if (stmts.length) await env.DB.batch(stmts);
  return stmts.length;
}
```

- [ ] **Step 4: Run tests** — `npx vitest run test/gfw.test.ts` → PASS (2 tests); `npm test` all green.

- [ ] **Step 5: Commit**

```bash
git add src/gfw.ts test/gfw.test.ts
git commit -m "feat: daily GFW corroboration sync into gfw_events"
```

---

### Task 13: Frontend shell — map, cable layers, API client, permalinks

**Files:**
- Create: `web/vite.config.ts`, `web/index.html`, `web/style.css`, `web/src/api.ts`, `web/src/hash.ts`, `web/src/main.ts`
- Create: `web/public/data/cables.json`, `web/public/data/exclusions.json` (copies of `data/*.json` — keep in sync when geometry changes)

**Interfaces:**
- Consumes: `/api/*` routes (Task 11 shapes, verbatim).
- Produces:
  - `web/src/api.ts`: `fetchSnapshot(): Promise<Snapshot>`, `fetchEvents(since: number): Promise<EventsResponse>`, `fetchGfw(): Promise<GfwResponse>`, `fetchVessel(mmsi: number): Promise<Dossier>` + those response types mirroring Task 11 JSON.
  - `web/src/hash.ts`: `readHash(): { view?: {lon,lat,zoom}, vessel?: number }`, `writeHash(state): void` — format `#v=<lon>,<lat>,<zoom>&vessel=<mmsi>` (spec §5 permalinks).
  - `web/src/main.ts` exposes `selectVessel(mmsi: number | null)` used by Task 14/15 modules via direct import.

No unit tests (spec §7 scopes testing to detectors/geo/replay); each frontend task ends with a scripted visual verification via `wrangler dev`.

- [ ] **Step 1: Create `web/vite.config.ts`**

```ts
import { defineConfig } from "vite";
export default defineConfig({
  root: __dirname,
  build: { outDir: "dist", emptyOutDir: true },
  server: { proxy: { "/api": "http://localhost:8787" } },
});
```

- [ ] **Step 2: Create `web/index.html`**

```html
<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Taiwan Cable Guard — live vessel anomaly map</title>
  <link rel="stylesheet" href="./style.css" />
</head>
<body>
  <div id="map"></div>
  <div id="stale-banner" hidden></div>
  <aside id="event-feed"><h2>Live events</h2><ol id="event-list"></ol></aside>
  <aside id="dossier" hidden>
    <button id="dossier-close" aria-label="Close">×</button>
    <div id="dossier-body"></div>
  </aside>
  <div id="attribution">Cable routes approximate · AIS via AISStream.io · GFW corroboration delayed ~72 h</div>
  <script type="module" src="./src/main.ts"></script>
</body>
</html>
```

- [ ] **Step 3: Create `web/style.css`** (dark-first, spec §5)

```css
:root {
  --bg: #0b1220; --panel: #101a2ecc; --text: #dbe4f0; --muted: #7d8aa0;
  --amber: #f0a83c; --red: #e5484d; --grey: #8b96a5; --accent: #4cc3ff;
  font-family: system-ui, sans-serif;
}
* { box-sizing: border-box; margin: 0; }
html, body, #map { height: 100%; background: var(--bg); color: var(--text); }
#stale-banner {
  position: absolute; top: 0; left: 0; right: 0; z-index: 30;
  background: var(--red); color: #fff; text-align: center; padding: 6px; font-size: 14px;
}
#event-feed {
  position: absolute; top: 12px; right: 12px; z-index: 20; width: 300px; max-height: 60vh;
  overflow-y: auto; background: var(--panel); backdrop-filter: blur(6px);
  border-radius: 8px; padding: 12px;
}
#event-feed h2 { font-size: 13px; text-transform: uppercase; letter-spacing: .08em; color: var(--muted); margin-bottom: 8px; }
#event-list { list-style: none; }
#event-list li { padding: 8px; border-radius: 6px; cursor: pointer; font-size: 13px; line-height: 1.4; }
#event-list li:hover { background: #ffffff14; }
#event-list .sev { font-weight: 700; }
#event-list .sev-high { color: var(--red); }
#event-list .sev-mid { color: var(--amber); }
#event-list .sev-low { color: var(--grey); }
#event-list time { color: var(--muted); font-size: 11px; display: block; }
#dossier {
  position: absolute; top: 12px; left: 12px; z-index: 20; width: 340px; max-height: 80vh;
  overflow-y: auto; background: var(--panel); backdrop-filter: blur(6px);
  border-radius: 8px; padding: 16px;
}
#dossier-close { position: absolute; top: 8px; right: 10px; background: none; border: 0; color: var(--muted); font-size: 20px; cursor: pointer; }
#dossier h2 { font-size: 18px; } #dossier h3 { font-size: 12px; text-transform: uppercase; color: var(--muted); margin: 14px 0 6px; }
#dossier .score { font-size: 26px; font-weight: 700; }
#dossier ul { list-style: none; font-size: 13px; } #dossier li { padding: 4px 0; border-bottom: 1px solid #ffffff10; }
#attribution { position: absolute; bottom: 4px; left: 8px; z-index: 20; font-size: 11px; color: var(--muted); }
@media (max-width: 720px) { #event-feed { display: none; } #dossier { width: calc(100vw - 24px); } }
```

- [ ] **Step 4: Create `web/src/api.ts`**

```ts
// web/src/api.ts — mirrors Task 11 response shapes.
export interface VesselProps { mmsi: number; name: string | null; sog: number; cog: number; score: number; lastTs: number }
export interface Snapshot { generatedAt: number; newestTs: number | null; vessels: GeoJSON.FeatureCollection<GeoJSON.Point, VesselProps> }
export interface ApiEvent { id: string; type: string; severity: number; mmsi: number; lon: number; lat: number; startTs: number; endTs: number | null; evidence: Record<string, unknown> }
export interface EventsResponse { generatedAt: number; events: ApiEvent[] }
export interface GfwEvent { id: string; type: string; mmsi: number | null; lon: number; lat: number; startTs: number; endTs: number | null }
export interface GfwResponse { generatedAt: number; events: GfwEvent[] }
export interface Dossier {
  generatedAt: number;
  vessel: { mmsi: number; name: string | null; callsign: string | null; lon: number; lat: number; sog: number; cog: number; lastTs: number; score: number };
  track: { ts: number; lon: number; lat: number; sog: number; cog: number }[];
  events: ApiEvent[];
}

async function get<T>(path: string): Promise<T> {
  const res = await fetch(path);
  if (!res.ok) throw new Error(`${path} → ${res.status}`);
  return res.json() as Promise<T>;
}

export const fetchSnapshot = () => get<Snapshot>("/api/snapshot");
export const fetchEvents = (since: number) => get<EventsResponse>(`/api/events?since=${since}`);
export const fetchGfw = () => get<GfwResponse>("/api/gfw");
export const fetchVessel = (mmsi: number) => get<Dossier>(`/api/vessel/${mmsi}`);
```

- [ ] **Step 5: Create `web/src/hash.ts`**

```ts
// web/src/hash.ts — shareable permalinks: #v=<lon>,<lat>,<zoom>&vessel=<mmsi>
export interface HashState { view?: { lon: number; lat: number; zoom: number }; vessel?: number }

export function readHash(): HashState {
  const params = new URLSearchParams(location.hash.slice(1));
  const out: HashState = {};
  const v = params.get("v")?.split(",").map(Number);
  if (v && v.length === 3 && v.every(Number.isFinite)) out.view = { lon: v[0], lat: v[1], zoom: v[2] };
  const m = Number(params.get("vessel"));
  if (Number.isInteger(m) && m > 0) out.vessel = m;
  return out;
}

export function writeHash(state: HashState): void {
  const params = new URLSearchParams();
  if (state.view) params.set("v", `${state.view.lon.toFixed(4)},${state.view.lat.toFixed(4)},${state.view.zoom.toFixed(2)}`);
  if (state.vessel) params.set("vessel", String(state.vessel));
  history.replaceState(null, "", `#${params}`);
}
```

- [ ] **Step 6: Create `web/src/main.ts`** (map + cable/exclusion layers; vessel/GFW/panel wiring lands in Tasks 14–15)

```ts
// web/src/main.ts
import maplibregl from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import { readHash, writeHash, type HashState } from "./hash";

export const hashState: HashState = readHash();

export const map = new maplibregl.Map({
  container: "map",
  style: "https://tiles.openfreemap.org/styles/dark",
  center: hashState.view ? [hashState.view.lon, hashState.view.lat] : [120.9, 23.7],
  zoom: hashState.view?.zoom ?? 6.3,
  attributionControl: { compact: true },
});
map.addControl(new maplibregl.NavigationControl(), "bottom-right");

map.on("moveend", () => {
  const c = map.getCenter();
  hashState.view = { lon: c.lng, lat: c.lat, zoom: map.getZoom() };
  writeHash(hashState);
});

map.on("load", () => {
  map.addSource("cables", { type: "geojson", data: "/data/cables.json" });
  map.addSource("exclusions", { type: "geojson", data: "/data/exclusions.json" });

  // Corridor buffer glow + core line (spec §5).
  map.addLayer({ id: "cable-glow", type: "line", source: "cables",
    paint: { "line-color": "#4cc3ff", "line-width": 14, "line-opacity": 0.15, "line-blur": 6 } });
  map.addLayer({ id: "cable-line", type: "line", source: "cables",
    paint: { "line-color": "#4cc3ff", "line-width": 1.5, "line-opacity": 0.8, "line-dasharray": [2, 2] } });
  map.addLayer({ id: "cable-label", type: "symbol", source: "cables",
    layout: { "symbol-placement": "line", "text-field": ["concat", ["get", "name"], ["case", ["get", "approximate"], " (approximate)", ""]], "text-size": 10 },
    paint: { "text-color": "#7d8aa0", "text-halo-color": "#0b1220", "text-halo-width": 1 } });

  // Exclusion zones: toggleable, OFF by default (spec §5).
  map.addLayer({ id: "exclusion-fill", type: "fill", source: "exclusions",
    layout: { visibility: "none" }, paint: { "fill-color": "#8b96a5", "fill-opacity": 0.12 } });
});

class ExclusionToggle implements maplibregl.IControl {
  onAdd(m: maplibregl.Map) {
    const div = document.createElement("div");
    div.className = "maplibregl-ctrl maplibregl-ctrl-group";
    const btn = document.createElement("button");
    btn.textContent = "⚓";
    btn.title = "Toggle exclusion zones";
    btn.onclick = () => {
      const vis = m.getLayoutProperty("exclusion-fill", "visibility") === "none" ? "visible" : "none";
      m.setLayoutProperty("exclusion-fill", "visibility", vis);
    };
    div.appendChild(btn);
    return div;
  }
  onRemove() {}
}
map.addControl(new ExclusionToggle(), "bottom-right");
```

- [ ] **Step 7: Copy geodata for the frontend**

Run: `mkdir -p web/public/data && cp data/cables.json data/exclusions.json web/public/data/`

- [ ] **Step 8: Verify visually**

Run: `npx wrangler dev` (terminal 1), `npx vite web` (terminal 2), open `http://localhost:5173`.
Expected: dark map centred on Taiwan; dashed cyan cable lines with glow and "(approximate)" labels; ⚓ button toggles grey exclusion boxes; panning updates `#v=…` in the URL; reloading a copied URL restores the view. Also `npm run build:web` completes and `web/dist/index.html` exists.

- [ ] **Step 9: Commit**

```bash
git add web/ && git rm --cached web/dist -r --ignore-unmatch
git commit -m "feat: MapLibre frontend shell with cable corridors and permalinks"
```

---

### Task 14: Live vessels layer, polling, staleness banner

**Files:**
- Create: `web/src/vessels.ts`
- Modify: `web/src/main.ts` (add ~6 lines at the end: import + init call)

**Interfaces:**
- Consumes: `map`, `hashState` (Task 13 `main.ts`), `fetchSnapshot`/`fetchGfw` (api.ts), `writeHash`.
- Produces: `initVessels(onSelect: (mmsi: number) => void): void` — polls `/api/snapshot` every 15 s, renders suspicion-colored vessels (grey→amber→red by score), a GFW-confirmed layer with distinct style, the staleness banner, and calls `onSelect(mmsi)` on vessel click. Also exports `startPolling` internals kept private.

- [ ] **Step 1: Create `web/src/vessels.ts`**

```ts
// web/src/vessels.ts
import type { GeoJSONSource } from "maplibre-gl";
import { fetchGfw, fetchSnapshot } from "./api";
import { map } from "./main";

const POLL_MS = 15_000;
const STALE_MS = 5 * 60_000; // keep in sync with CONFIG.staleAfterMs

function setStaleBanner(newestTs: number | null): void {
  const el = document.getElementById("stale-banner")!;
  if (newestTs !== null && Date.now() - newestTs > STALE_MS) {
    const t = new Date(newestTs);
    el.textContent = `⚠ data stale since ${String(t.getHours()).padStart(2, "0")}:${String(t.getMinutes()).padStart(2, "0")}`;
    el.hidden = false;
  } else {
    el.hidden = true;
  }
}

async function poll(): Promise<void> {
  try {
    const snap = await fetchSnapshot();
    (map.getSource("vessels") as GeoJSONSource | undefined)?.setData(snap.vessels as any);
    setStaleBanner(snap.newestTs);
  } catch (err) {
    console.error("snapshot poll failed:", err);
    setStaleBanner(0); // unreachable API = stale (spec §6: never silently show stale data)
  }
}

export function initVessels(onSelect: (mmsi: number) => void): void {
  map.addSource("vessels", { type: "geojson", data: { type: "FeatureCollection", features: [] } });
  map.addSource("gfw", { type: "geojson", data: { type: "FeatureCollection", features: [] } });

  // GFW-confirmed (delayed) — distinct hollow diamond style under the live layer.
  map.addLayer({ id: "gfw-events", type: "circle", source: "gfw",
    paint: { "circle-radius": 7, "circle-color": "transparent", "circle-stroke-color": "#b18cff", "circle-stroke-width": 1.5 } });

  map.addLayer({
    id: "vessels", type: "circle", source: "vessels",
    paint: {
      // grey → amber → red by suspicion score (spec §5)
      "circle-color": ["interpolate", ["linear"], ["get", "score"], 0, "#8b96a5", 3, "#f0a83c", 8, "#e5484d"],
      "circle-radius": ["interpolate", ["linear"], ["get", "score"], 0, 3.5, 8, 7],
      "circle-stroke-color": "#0b1220", "circle-stroke-width": 1,
      "circle-opacity": 0.9,
    },
  });

  map.on("click", "vessels", (e) => {
    const f = e.features?.[0];
    if (f) onSelect((f.properties as any).mmsi);
  });
  map.on("mouseenter", "vessels", () => { map.getCanvas().style.cursor = "pointer"; });
  map.on("mouseleave", "vessels", () => { map.getCanvas().style.cursor = ""; });

  void poll();
  setInterval(poll, POLL_MS);

  void fetchGfw().then((g) => {
    (map.getSource("gfw") as GeoJSONSource).setData({
      type: "FeatureCollection",
      features: g.events.map((ev) => ({
        type: "Feature", geometry: { type: "Point", coordinates: [ev.lon, ev.lat] },
        properties: { id: ev.id, type: ev.type, gfw: true },
      })),
    } as any);
  }).catch((err) => console.error("gfw layer failed:", err));
}
```

- [ ] **Step 2: Wire into `web/src/main.ts`** — append inside the existing `map.on("load", …)` callback (after the exclusion layer), plus imports at top:

```ts
// at top of main.ts:
import { initVessels } from "./vessels";
import { selectVessel } from "./panels";

// last lines inside map.on("load", ...):
  initVessels(selectVessel);
```

(`./panels` arrives in Task 15; to keep this task runnable create it now with a stub used only until Task 15 fills it:)

```ts
// web/src/panels.ts (stub — Task 15 replaces)
export function selectVessel(mmsi: number | null): void { console.log("select", mmsi); }
```

- [ ] **Step 3: Verify visually**

With `wrangler dev` + `vite web` running and AISSTREAM_KEY set: vessels appear within ~1 min, mostly grey; clicking one logs `select <mmsi>`; killing `wrangler dev` makes the red staleness banner appear on the next poll; restarting clears it within 15 s.

- [ ] **Step 4: Commit**

```bash
git add web/src/vessels.ts web/src/panels.ts web/src/main.ts
git commit -m "feat: live vessel layer with suspicion coloring, GFW layer, staleness banner"
```

---

### Task 15: Vessel dossier panel + event feed sidebar

**Files:**
- Modify: `web/src/panels.ts` (replace stub), `web/src/main.ts` (3 lines: hash-vessel restore + close handler)

**Interfaces:**
- Consumes: `fetchVessel`, `fetchEvents`, `ApiEvent`, `Dossier` (api.ts); `map`, `hashState` (main.ts); `writeHash` (hash.ts).
- Produces: `selectVessel(mmsi: number | null): void` (open/close dossier, draws track trail, updates `#vessel=`), `initEventFeed(): void` (reverse-chron feed polling every 15 s, click-to-fly-to).

- [ ] **Step 1: Replace `web/src/panels.ts`**

```ts
// web/src/panels.ts
import type { GeoJSONSource } from "maplibre-gl";
import { fetchEvents, fetchVessel, type ApiEvent } from "./api";
import { writeHash } from "./hash";
import { hashState, map } from "./main";

const esc = (s: unknown) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]!));
const fmtTime = (ts: number) => new Date(ts).toISOString().replace("T", " ").slice(0, 16) + "Z";
const TYPE_LABEL: Record<string, string> = { loitering: "Loitering", ais_gap: "AIS gap", identity: "Identity anomaly", anchor_drag: "Anchor drag" };

export function selectVessel(mmsi: number | null): void {
  const panel = document.getElementById("dossier")!;
  hashState.vessel = mmsi ?? undefined;
  writeHash(hashState);

  if (mmsi === null) {
    panel.hidden = true;
    (map.getSource("track") as GeoJSONSource | undefined)?.setData({ type: "FeatureCollection", features: [] } as any);
    return;
  }

  void fetchVessel(mmsi).then((d) => {
    const body = document.getElementById("dossier-body")!;
    const identityEvents = d.events.filter((e) => e.type === "identity");
    body.innerHTML = `
      <h2>${esc(d.vessel.name) || "Unknown vessel"}</h2>
      <div class="score">${d.vessel.score}</div>
      <div>MMSI ${d.vessel.mmsi} · ${esc(d.vessel.callsign) || "no callsign"} · ${d.vessel.sog} kn</div>
      <div>Last seen ${fmtTime(d.vessel.lastTs)}</div>
      <h3>Identity history</h3>
      <ul>${identityEvents.length ? identityEvents.map((e) => `<li>${fmtTime(e.startTs)} — ${esc(JSON.stringify(e.evidence))}</li>`).join("") : "<li>No identity changes observed</li>"}</ul>
      <h3>Event timeline</h3>
      <ul>${d.events.length ? d.events.map((e) => `<li>${fmtTime(e.startTs)} — ${TYPE_LABEL[e.type] ?? e.type} (sev ${e.severity})${e.endTs === null ? " · ongoing" : ""}</li>`).join("") : "<li>No events</li>"}</ul>`;
    panel.hidden = false;

    const track = map.getSource("track") as GeoJSONSource | undefined;
    if (track && d.track.length > 1) {
      track.setData({ type: "Feature", properties: {},
        geometry: { type: "LineString", coordinates: d.track.map((p) => [p.lon, p.lat]) } } as any);
    }
  }).catch((err) => console.error("dossier failed:", err));
}

function renderEvent(ev: ApiEvent): string {
  const sevClass = ev.severity >= 4 ? "sev-high" : ev.severity === 3 ? "sev-mid" : "sev-low";
  return `<li data-lon="${ev.lon}" data-lat="${ev.lat}" data-mmsi="${ev.mmsi}">
    <span class="sev ${sevClass}">sev ${ev.severity}</span> ${TYPE_LABEL[ev.type] ?? ev.type} — MMSI ${ev.mmsi}${ev.endTs === null ? " · ongoing" : ""}
    <time>${fmtTime(ev.startTs)}</time></li>`;
}

export function initEventFeed(): void {
  map.addSource("track", { type: "geojson", data: { type: "FeatureCollection", features: [] } });
  map.addLayer({ id: "track", type: "line", source: "track",
    paint: { "line-color": "#4cc3ff", "line-width": 2, "line-opacity": 0.7 } }, "vessels");

  const list = document.getElementById("event-list")!;
  const poll = async () => {
    try {
      const res = await fetchEvents(Date.now() - 24 * 3_600_000);
      list.innerHTML = res.events.map(renderEvent).join("") || "<li>No events in the last 24 h</li>";
    } catch (err) { console.error("event feed failed:", err); }
  };
  list.addEventListener("click", (e) => {
    const li = (e.target as HTMLElement).closest("li[data-mmsi]") as HTMLElement | null;
    if (!li) return;
    map.flyTo({ center: [Number(li.dataset.lon), Number(li.dataset.lat)], zoom: 10 });
    selectVessel(Number(li.dataset.mmsi));
  });
  void poll();
  setInterval(poll, 15_000);
}
```

- [ ] **Step 2: Wire into `web/src/main.ts`** — inside `map.on("load", …)` after `initVessels(selectVessel)`, and once at module bottom:

```ts
// inside map.on("load", ...):
  initEventFeed();
  if (hashState.vessel) selectVessel(hashState.vessel);   // permalink restore (spec §5)

// module bottom:
document.getElementById("dossier-close")!.addEventListener("click", () => selectVessel(null));
```
(Adjust the top import to `import { initEventFeed, selectVessel } from "./panels";`.)

- [ ] **Step 3: Verify visually**

Full flow: click a vessel → dossier opens with score/timeline and cyan track trail; URL gains `#vessel=…`; hard-reload restores view AND reopens the dossier; event feed lists events newest-first; clicking an entry flies to it and opens that vessel; × closes and drops `vessel` from the hash. `npm run build:web` succeeds.

- [ ] **Step 4: Commit**

```bash
git add web/src/panels.ts web/src/main.ts
git commit -m "feat: vessel dossier panel and live event feed with fly-to"
```

---

### Task 16: Replay harness

**Files:**
- Create: `scripts/replay.ts`, `test/fixtures/capture.ndjson`, `test/replay.test.ts`, `src/replay-core.ts`

**Interfaces:**
- Consumes: `Tracker` (Task 8), `parseAisStreamMessage` (Task 10), `GeoContext` (Task 3).
- Produces: `replayCapture(lines: string[], geo: GeoContext, tickIntervalMs?: number): { events: AnomalyEvent[]; vessels: number; messages: number }` in `src/replay-core.ts` (pure — tested); `scripts/replay.ts` CLI wrapper: `npm run replay -- <capture.ndjson>` prints a summary + events as JSON lines.

- [ ] **Step 1: Create the fixture** — a synthetic capture in AISStream wire format: MMSI 999000001 loiters at the bundled Fangshan corridor landing coordinate (120.593, 22.263) for 2.5 h; MMSI 999000002 transits normally.

Generate it with a one-off node snippet rather than hand-typing 20 lines (run from repo root):

```bash
node --input-type=module -e '
const T0 = Date.UTC(2026, 6, 1, 0, 0, 0);
const fmt = (ms) => new Date(ms).toISOString().replace("T", " ").replace(/\.\d+Z/, ".000000 +0000 UTC");
const pos = (mmsi, lon, lat, sog, ts) => JSON.stringify({
  MessageType: "PositionReport",
  MetaData: { MMSI: mmsi, latitude: lat, longitude: lon, time_utc: fmt(ts) },
  Message: { PositionReport: { Sog: sog, Cog: 90, TrueHeading: 90 } },
});
const lines = [];
for (let m = 0; m <= 150; m += 10) lines.push(pos(999000001, 120.593, 22.263, 0.4, T0 + m * 60000));  // loiterer on Fangshan landing
for (let m = 0; m <= 60; m += 10) lines.push(pos(999000002, 119.0 + m * 0.03, 23.0, 14, T0 + m * 60000)); // normal transit
console.log(lines.join("\n"));
' > test/fixtures/capture.ndjson
wc -l test/fixtures/capture.ndjson   # expect 23
```

- [ ] **Step 2: Write failing test**

```ts
// test/replay.test.ts
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { GeoContext } from "../src/geo/context";
import { replayCapture } from "../src/replay-core";

describe("replay harness", () => {
  it("replays a capture and emits a loitering event for the loiterer only", () => {
    const lines = readFileSync("test/fixtures/capture.ndjson", "utf8").trim().split("\n");
    const result = replayCapture(lines, new GeoContext());
    expect(result.messages).toBe(23);
    expect(result.vessels).toBe(2);
    const loiters = result.events.filter((e) => e.type === "loitering" && e.endTs === null);
    expect(loiters).toHaveLength(1);
    expect(loiters[0].mmsi).toBe(999000001);
    expect(result.events.filter((e) => e.mmsi === 999000002)).toHaveLength(0);
  });
});
```

Note: `readFileSync` works under vitest-pool-workers only with `nodejs_compat`; if it errors, move this one test to a plain node environment by adding `// @vitest-environment node`-style split — simplest fallback: inline the fixture via `import capture from "./fixtures/capture.ndjson?raw"` is NOT available here, so instead pass the fixture through miniflare bindings like TEST_MIGRATIONS: add `miniflare: { bindings: { TEST_CAPTURE: <string> } }` loading in `vitest.config.ts` with `readFileSync` at config time, and read `env.TEST_CAPTURE` in the test. Implement whichever works first; the assertion block stays identical.

- [ ] **Step 3: Run to verify failure** — `npx vitest run test/replay.test.ts` → FAIL.

- [ ] **Step 4: Implement `src/replay-core.ts`**

```ts
// src/replay-core.ts — pure replay: capture lines → events. Used by tests and scripts/replay.ts.
import { parseAisStreamMessage } from "./aisstream";
import { CONFIG } from "./config";
import type { GeoContext } from "./geo/context";
import { Tracker } from "./pipeline";
import type { AnomalyEvent } from "./types";

export function replayCapture(lines: string[], geo: GeoContext, tickIntervalMs = CONFIG.alarmIntervalMs): {
  events: AnomalyEvent[]; vessels: number; messages: number;
} {
  const tracker = new Tracker(geo);
  const events: AnomalyEvent[] = [];
  let messages = 0;
  let lastTick = 0;

  const parsed = lines
    .map((l) => { try { return parseAisStreamMessage(JSON.parse(l)); } catch { return null; } })
    .filter((p): p is NonNullable<typeof p> => p !== null)
    .sort((a, b) => (a.pos?.ts ?? a.ident!.ts) - (b.pos?.ts ?? b.ident!.ts));

  for (const p of parsed) {
    const ts = p.pos?.ts ?? p.ident!.ts;
    if (lastTick === 0) lastTick = ts;
    // simulate the DO alarm between messages
    while (ts - lastTick >= tickIntervalMs) {
      lastTick += tickIntervalMs;
      events.push(...tracker.tick(lastTick));
    }
    if (p.pos) { events.push(...tracker.handlePosition(p.pos)); messages++; }
    if (p.ident) { events.push(...tracker.handleStatic(p.ident)); messages++; }
  }
  return { events, vessels: tracker.states.size, messages };
}
```

- [ ] **Step 5: Implement `scripts/replay.ts`**

```ts
// scripts/replay.ts — CLI: npm run replay -- path/to/capture.ndjson
import { readFileSync } from "node:fs";
import { GeoContext } from "../src/geo/context";
import { replayCapture } from "../src/replay-core";

const file = process.argv[2];
if (!file) { console.error("usage: npm run replay -- <capture.ndjson>"); process.exit(1); }

const lines = readFileSync(file, "utf8").trim().split("\n");
const { events, vessels, messages } = replayCapture(lines, new GeoContext());

console.error(`replayed ${messages} messages, ${vessels} vessels, ${events.length} events`);
for (const ev of events) console.log(JSON.stringify(ev));
```

- [ ] **Step 6: Run tests + CLI**

Run: `npx vitest run test/replay.test.ts` → PASS. Then `npm run replay -- test/fixtures/capture.ndjson` → summary on stderr, one loitering-event JSON line on stdout. Finally `npx tsc --noEmit && npm test` → entire suite green.

- [ ] **Step 7: Commit**

```bash
git add src/replay-core.ts scripts/replay.ts test/replay.test.ts test/fixtures/capture.ndjson
git commit -m "feat: replay harness piping captures through the full detect pipeline"
```

---

## Deployment checklist (post-plan, one-time manual)

1. `npx wrangler d1 create cable-guard` → paste ID into `wrangler.jsonc`.
2. `npx wrangler d1 migrations apply cable-guard --remote`
3. `npx wrangler secret put AISSTREAM_KEY` / `npx wrangler secret put GFW_TOKEN`
4. `npm run deploy` (requires Workers paid plan for the Durable Object).
5. Open the workers.dev URL: map + vessels live; `curl …/api/snapshot` sanity check.
6. Non-blocking (spec §9): submit MarineTraffic/Spire research applications; confirm Matsu/Penghu geometry with SeaLight; consider AISHub receiver.

## Self-review notes

- Spec coverage: detectors 1–4 → Tasks 4–7; score/config → Tasks 2, 8; DO/watchdog/backoff/batch-retry → Task 10; D1 schema/retention → Task 9; API routes + generatedAt → Task 11; GFW corroboration + distinct layer → Tasks 12, 14; cable geometry + "approximate" labeling → Tasks 3, 13; dossier/event feed/permalinks/staleness/embed (CORS) → Tasks 13–15, 11; all spec §7 test scenarios → Tasks 4 (loiterer, fishing fleet, transit), 5 (gap-and-teleport), 6 (identity swapper), 2 (geo on real routes), 16 (replay).
- Known deviation from spec diagram: Workers Static Assets instead of a separate Pages project (stated in header; same cost, one deploy).
- Type-consistency: detector signatures, `Tracker` methods, D1 column names, and API JSON shapes are quoted identically in consuming tasks (11, 14, 15 mirror Task 11's shapes via `web/src/api.ts`).
