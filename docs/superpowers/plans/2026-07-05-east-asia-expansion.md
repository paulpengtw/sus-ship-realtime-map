# East Asia Cable-Guard Expansion Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extend the live AIS anomaly map from Taiwan-only to Korea/Taiwan/Japan with a region switcher, richer UI (legend, stats, timeline, enriched dossier, cable metadata), and first-visit onboarding.

**Architecture:** Single ingest pipeline (one Durable Object, one AISStream subscription carrying three bounding boxes); every position/event is tagged with a region id at ingest via point-in-bbox. The API grows `?region=` filters and a `/api/stats` endpoint; the frontend adds a top bar (switcher + stats), legend, SVG timeline, enriched panels, and a hand-rolled onboarding modal/tour. No new libraries.

**Tech Stack:** Cloudflare Workers + Durable Objects + D1, vitest (`@cloudflare/vitest-pool-workers`), MapLibre GL, Vite vanilla-TS frontend.

**Spec:** `docs/superpowers/specs/2026-07-05-east-asia-expansion-design.md`

## Global Constraints

- Region ids are exactly `"kr" | "tw" | "jp"`; region tagging is point-in-bbox, **first match wins**, no match → `NULL` (rendered as "—"; vessel still displays).
- First-visit default region is **Korea** (`"kr"`). URL hash wins over the localStorage default when present.
- All cable corridors render at all times — region switching moves the camera and filters panels, never hides map data.
- English only. No chart library, no tour library — hand-rolled SVG/DOM only.
- Detectors and scoring logic are untouched.
- Migration is additive only: `0002_regions.sql` adds nullable columns; existing rows backfill to `'tw'`.
- `data/*.json` is the source of truth for cables/exclusions; `web/public/data/` is a copy synced by `npm run sync-data`. Never edit only one of the two.
- Run tests with `npm test` (vitest run). Build frontend with `npm run build:web`.

## File Structure

New files:
- `migrations/0002_regions.sql` — additive schema migration
- `src/geo/regions.ts` — `regionForPoint` (backend region tagging)
- `web/src/regions.ts` — region defs, active-region store, localStorage persistence
- `web/src/switcher.ts` — region pill UI + camera fly
- `web/src/stats.ts` — stats bar fed by `/api/stats`
- `web/src/timeline.ts` — 14-day SVG severity histogram + day filter
- `web/src/geo.ts` — client-side point→polyline distance (small copy of backend math)
- `web/src/cables.ts` — client cable-corridor lookup (nearest corridor, metadata)
- `web/src/mid.ts` — MMSI MID prefix → flag emoji/country
- `web/src/shiptype.ts` — AIS ship type code → label
- `web/src/cablepanel.ts` — cable metadata panel
- `web/src/onboarding.ts` — intro modal + 5-step tour
- Tests: `test/regions.test.ts`, `test/db-regions.test.ts`, `test/aisstream-static.test.ts`, `test/pipeline-regions.test.ts`, `test/api-regions.test.ts`, `test/stats.test.ts`, `test/cables-data.test.ts`, `test/replay-region.test.ts`, `test/web-regions.test.ts`, `test/web-dossier.test.ts`

Modified: `src/config.ts`, `src/types.ts`, `src/db.ts`, `src/aisstream.ts`, `src/pipeline.ts`, `src/do/tracker.ts`, `src/worker.ts`, `src/replay-core.ts`, `scripts/replay.ts`, `data/cables.json`, `data/exclusions.json`, `web/public/data/*` (synced copies), `package.json`, `web/index.html`, `web/style.css`, `web/src/main.ts`, `web/src/api.ts`, `web/src/panels.ts`.

---

### Task 1: Region config + `regionForPoint`

**Files:**
- Modify: `src/config.ts`
- Create: `src/geo/regions.ts`
- Test: `test/regions.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces: `CONFIG.regions: readonly Region[]` where `Region = { id: RegionId; name: string; bbox: { minLon; minLat; maxLon; maxLat }; center: [number, number]; zoom: number }`; `type RegionId = "kr" | "tw" | "jp"` and `regionForPoint(lon: number, lat: number): RegionId | null` from `src/geo/regions.ts`. `CONFIG.bbox` is **removed** (Task 4 removes its last consumer, `src/do/tracker.ts` — until Task 4 lands, keep `bbox` in place; delete it in Task 4).

- [ ] **Step 1: Write the failing test**

Create `test/regions.test.ts`:

```ts
// test/regions.test.ts
import { describe, expect, it } from "vitest";
import { CONFIG } from "../src/config";
import { regionForPoint } from "../src/geo/regions";

describe("regionForPoint", () => {
  it("tags Busan southern approaches as kr", () => {
    expect(regionForPoint(129.3, 34.7)).toBe("kr");
  });
  it("tags Yellow Sea landing corridor as kr", () => {
    expect(regionForPoint(125.2, 36.2)).toBe("kr");
  });
  it("tags the existing Taiwan box as tw", () => {
    expect(regionForPoint(121.5, 24.9)).toBe("tw");
    expect(regionForPoint(118.0, 21.0)).toBe("tw"); // bbox edges inclusive
  });
  it("tags Boso peninsula approaches as jp", () => {
    expect(regionForPoint(140.3, 34.7)).toBe("jp");
  });
  it("returns null outside all boxes", () => {
    expect(regionForPoint(150.0, 10.0)).toBeNull();
    expect(regionForPoint(0, 0)).toBeNull();
  });
  it("first match wins on the shared kr/jp edge (130.0 E)", () => {
    // kr is listed before jp in CONFIG.regions, so the shared meridian goes to kr
    expect(CONFIG.regions[0].id).toBe("kr");
    expect(regionForPoint(130.0, 34.0)).toBe("kr");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/regions.test.ts`
Expected: FAIL — `Cannot find module '../src/geo/regions'` (and `CONFIG.regions` undefined).

- [ ] **Step 3: Implement**

In `src/config.ts`, add above the `CONFIG` object:

```ts
export type RegionId = "kr" | "tw" | "jp";
export interface Region {
  id: RegionId;
  name: string;
  bbox: { minLon: number; minLat: number; maxLon: number; maxLat: number };
  center: [number, number]; // [lon, lat]
  zoom: number;
}
```

Inside `CONFIG`, keep `bbox` for now (Task 4 deletes it) and add a `regions` key directly below it:

```ts
  // Order matters: region tagging is first-match-wins (spec §1).
  regions: [
    { id: "kr", name: "Korea",
      bbox: { minLon: 124.5, minLat: 33.0, maxLon: 130.0, maxLat: 37.0 }, // Busan/Geoje approaches + Yellow Sea corridors
      center: [127.5, 35.0], zoom: 6.3 },
    { id: "tw", name: "Taiwan",
      bbox: { minLon: 118.0, minLat: 21.0, maxLon: 124.5, maxLat: 26.5 },
      center: [120.9, 23.7], zoom: 6.3 },
    { id: "jp", name: "Japan",
      bbox: { minLon: 130.0, minLat: 32.5, maxLon: 141.5, maxLat: 36.9 }, // Kyushu strait → Shima/Chikura/Kitaibaraki landings
      center: [135.5, 34.5], zoom: 5.8 },
  ] as Region[],
```

Note: `as Region[]` inside the `as const` object keeps the array mutable-typed and correctly typed as `Region[]`.

Create `src/geo/regions.ts`:

```ts
// src/geo/regions.ts — point-in-bbox region tagging, first match wins (spec §1).
import { CONFIG, type RegionId } from "../config";

export function regionForPoint(lon: number, lat: number): RegionId | null {
  for (const r of CONFIG.regions) {
    const b = r.bbox;
    if (lon >= b.minLon && lon <= b.maxLon && lat >= b.minLat && lat <= b.maxLat) return r.id;
  }
  return null;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/regions.test.ts` → PASS (6 tests). Then `npm test` → all existing tests still PASS.

- [ ] **Step 5: Commit**

```bash
git add src/config.ts src/geo/regions.ts test/regions.test.ts
git commit -m "feat: three-region config (kr/tw/jp) and point-in-bbox region tagging"
```

---

### Task 2: Migration 0002, extended types, db read/write

**Files:**
- Create: `migrations/0002_regions.sql`
- Modify: `src/types.ts`, `src/db.ts`
- Test: `test/db-regions.test.ts`

**Interfaces:**
- Consumes: `RegionId` from `src/config.ts` (Task 1).
- Produces:
  - `vessels` table gains nullable `region TEXT, ship_type INTEGER, destination TEXT, dim_bow INTEGER, dim_stern INTEGER, dim_port INTEGER, dim_starboard INTEGER`; `events` gains nullable `region TEXT`.
  - `VesselState` gains `region: RegionId | null; shipType: number | null; destination: string | null; dimBow: number | null; dimStern: number | null; dimPort: number | null; dimStarboard: number | null` (all defaulted to `null` in `newVesselState`).
  - `AisIdentity` gains **optional** `shipType?: number | null; destination?: string | null; dimBow?: number | null; dimStern?: number | null; dimPort?: number | null; dimStarboard?: number | null`.
  - `AnomalyEvent` gains **optional** `region?: RegionId | null` (detectors don't set it; the Tracker stamps it — Task 4).
  - `flushWrites` persists and `loadRecentVesselStates` restores all new vessel fields; events persist `region`.

- [ ] **Step 1: Write the failing test**

Create `test/db-regions.test.ts`:

```ts
// test/db-regions.test.ts
import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { flushWrites, loadRecentVesselStates, newPendingWrites } from "../src/db";
import { newVesselState } from "../src/types";

const T0 = 1_750_000_000_000;

function pendingWithRegion() {
  const p = newPendingWrites();
  const s = newVesselState(440000001, T0);
  s.name = "KR SHIP"; s.callsign = "DS1234"; s.score = 2; s.scoreTs = T0; s.lastSeen = T0;
  s.region = "kr"; s.shipType = 70; s.destination = "BUSAN";
  s.dimBow = 100; s.dimStern = 20; s.dimPort = 10; s.dimStarboard = 10;
  s.ring.push({ mmsi: 440000001, lon: 129.3, lat: 34.7, sog: 1, cog: 0, heading: null, ts: T0 });
  p.vessels.set(s.mmsi, s);
  p.events.push({ id: `loitering-440000001-${T0}`, type: "loitering", severity: 3, mmsi: 440000001,
    lon: 129.3, lat: 34.7, startTs: T0, endTs: null, evidence: {}, region: "kr" });
  return p;
}

describe("db region + static-data persistence", () => {
  beforeEach(async () => {
    await env.DB.batch([env.DB.prepare("DELETE FROM vessels"), env.DB.prepare("DELETE FROM events")]);
  });

  it("flushWrites persists region and static data on vessels and events", async () => {
    await flushWrites(env.DB, pendingWithRegion());
    const v = await env.DB.prepare("SELECT * FROM vessels WHERE mmsi = 440000001").first<any>();
    expect(v.region).toBe("kr");
    expect(v.ship_type).toBe(70);
    expect(v.destination).toBe("BUSAN");
    expect(v.dim_bow).toBe(100);
    const e = await env.DB.prepare("SELECT region FROM events").first<any>();
    expect(e.region).toBe("kr");
  });

  it("null region persists as NULL", async () => {
    const p = pendingWithRegion();
    p.vessels.get(440000001)!.region = null;
    p.events[0] = { ...p.events[0], region: null };
    await flushWrites(env.DB, p);
    const v = await env.DB.prepare("SELECT region FROM vessels").first<any>();
    expect(v.region).toBeNull();
  });

  it("loadRecentVesselStates restores region and static data", async () => {
    await flushWrites(env.DB, pendingWithRegion());
    const [s] = await loadRecentVesselStates(env.DB, T0 - 1);
    expect(s.region).toBe("kr");
    expect(s.shipType).toBe(70);
    expect(s.destination).toBe("BUSAN");
    expect(s.dimBow).toBe(100); expect(s.dimStern).toBe(20);
    expect(s.dimPort).toBe(10); expect(s.dimStarboard).toBe(10);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/db-regions.test.ts`
Expected: FAIL — TS/property errors (`region` not on `VesselState`) and/or SQL `no such column: region`.

- [ ] **Step 3: Implement**

Create `migrations/0002_regions.sql`:

```sql
-- migrations/0002_regions.sql — region tagging + richer vessel static data (spec §1).
ALTER TABLE vessels ADD COLUMN region TEXT;
ALTER TABLE vessels ADD COLUMN ship_type INTEGER;
ALTER TABLE vessels ADD COLUMN destination TEXT;
ALTER TABLE vessels ADD COLUMN dim_bow INTEGER;
ALTER TABLE vessels ADD COLUMN dim_stern INTEGER;
ALTER TABLE vessels ADD COLUMN dim_port INTEGER;
ALTER TABLE vessels ADD COLUMN dim_starboard INTEGER;
ALTER TABLE events ADD COLUMN region TEXT;

-- Backfill: everything ingested before this migration was Taiwan-only.
UPDATE vessels SET region = 'tw';
UPDATE events SET region = 'tw';

CREATE INDEX idx_vessels_region ON vessels (region);
CREATE INDEX idx_events_region ON events (region);
```

In `src/types.ts`:
- Add at top: `import type { RegionId } from "./config";`
- In `AisIdentity`, after `callsign: string;` add:

```ts
  // From ShipStaticData; optional so existing constructors stay valid.
  shipType?: number | null;
  destination?: string | null;
  dimBow?: number | null;
  dimStern?: number | null;
  dimPort?: number | null;
  dimStarboard?: number | null;
```

- In `AnomalyEvent`, after `evidence: ...` add: `region?: RegionId | null; // stamped by Tracker, not by detectors`
- In `VesselState`, after `callsign: string | null;` add:

```ts
  region: RegionId | null;
  shipType: number | null;
  destination: string | null;
  dimBow: number | null;
  dimStern: number | null;
  dimPort: number | null;
  dimStarboard: number | null;
```

- In `newVesselState`, extend the returned object (after `name: null, callsign: null,`):

```ts
    region: null, shipType: null, destination: null,
    dimBow: null, dimStern: null, dimPort: null, dimStarboard: null,
```

In `src/db.ts`, replace the vessels upsert inside `flushWrites` with:

```ts
    stmts.push(db.prepare(
      `INSERT INTO vessels (mmsi, name, callsign, last_lon, last_lat, last_sog, last_cog, last_ts, score, score_ts,
                            region, ship_type, destination, dim_bow, dim_stern, dim_port, dim_starboard)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17)
       ON CONFLICT (mmsi) DO UPDATE SET name = ?2, callsign = ?3, last_lon = ?4, last_lat = ?5,
         last_sog = ?6, last_cog = ?7, last_ts = ?8, score = ?9, score_ts = ?10,
         region = ?11, ship_type = ?12, destination = ?13, dim_bow = ?14, dim_stern = ?15, dim_port = ?16, dim_starboard = ?17`,
    ).bind(s.mmsi, s.name, s.callsign, lp.lon, lp.lat, lp.sog, lp.cog, s.lastSeen, s.score, s.scoreTs,
           s.region, s.shipType, s.destination, s.dimBow, s.dimStern, s.dimPort, s.dimStarboard));
```

Replace the events insert with:

```ts
    stmts.push(db.prepare(
      `INSERT INTO events (id, type, severity, mmsi, lon, lat, start_ts, end_ts, evidence, region)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)
       ON CONFLICT (id) DO UPDATE SET severity = ?3, lon = ?5, lat = ?6, end_ts = ?8, evidence = ?9, region = ?10`,
    ).bind(ev.id, ev.type, ev.severity, ev.mmsi, ev.lon, ev.lat, ev.startTs, ev.endTs, JSON.stringify(ev.evidence), ev.region ?? null));
```

In `loadRecentVesselStates`, after `s.name = r.name; s.callsign = r.callsign;` add:

```ts
    s.region = r.region ?? null;
    s.shipType = r.ship_type ?? null;
    s.destination = r.destination ?? null;
    s.dimBow = r.dim_bow ?? null; s.dimStern = r.dim_stern ?? null;
    s.dimPort = r.dim_port ?? null; s.dimStarboard = r.dim_starboard ?? null;
```

(The vitest config auto-loads all files in `migrations/`, so 0002 applies in tests with no config change.)

**Also fix `test/api.test.ts`:** its seeds use positional inserts (`INSERT INTO vessels VALUES (10 values)`), which break once `vessels` has 17 columns. Change its two vessel inserts and its events insert to name their columns explicitly — same values:

```ts
    env.DB.prepare(`INSERT INTO vessels (mmsi, name, callsign, last_lon, last_lat, last_sog, last_cog, last_ts, score, score_ts)
                    VALUES (412000001, 'TEST SHIP', 'BXYZ1', 120.2, 22.0, 0.5, 90, ?1, 6.5, ?1)`).bind(T0),
    env.DB.prepare(`INSERT INTO vessels (mmsi, name, callsign, last_lon, last_lat, last_sog, last_cog, last_ts, score, score_ts)
                    VALUES (412000002, 'OLD SHIP', NULL, 121.0, 23.0, 5, 0, ?1, 0, ?1)`).bind(T0 - 2 * 3_600_000),
    // ...positions inserts are unaffected (positions table is unchanged)...
    env.DB.prepare(`INSERT INTO events (id, type, severity, mmsi, lon, lat, start_ts, end_ts, evidence)
                    VALUES ('loitering-412000001-1', 'loitering', 3, 412000001, 120.2, 22.0, ?1, NULL, '{"corridor":"C1"}')`).bind(T0),
```

(`gfw_events` is unchanged; its positional insert still works.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/db-regions.test.ts` → PASS. Then `npm test` → all PASS (including the fixed `api.test.ts`; other tests are unaffected because the new columns are nullable).

- [ ] **Step 5: Commit**

```bash
git add migrations/0002_regions.sql src/types.ts src/db.ts test/db-regions.test.ts test/api.test.ts
git commit -m "feat: region + ship static-data columns (migration 0002), types, db round-trip"
```

---

### Task 3: Extended ShipStaticData parsing

**Files:**
- Modify: `src/aisstream.ts`
- Test: `test/aisstream-static.test.ts`

**Interfaces:**
- Consumes: extended `AisIdentity` (Task 2).
- Produces: `parseAisStreamMessage` fills `ident.shipType` (AIS type code, `null` when 0/absent), `ident.destination` (trimmed, `null` when empty), `ident.dimBow/dimStern/dimPort/dimStarboard` (from `Message.ShipStaticData.Dimension.{A,B,C,D}`, `null` when 0/absent).

- [ ] **Step 1: Write the failing test**

Create `test/aisstream-static.test.ts`:

```ts
// test/aisstream-static.test.ts
import { describe, expect, it } from "vitest";
import { parseAisStreamMessage } from "../src/aisstream";

const TS = "2026-07-05 12:00:00.000000 +0000 UTC";

describe("extended ShipStaticData parsing", () => {
  it("captures ship type, destination and dimensions", () => {
    const raw = {
      MessageType: "ShipStaticData",
      MetaData: { MMSI: 440123456, time_utc: TS },
      Message: { ShipStaticData: {
        Name: "KR CARGO ", CallSign: "DS1234",
        Type: 70, Destination: " BUSAN ",
        Dimension: { A: 100, B: 20, C: 10, D: 12 },
      } },
    };
    const out = parseAisStreamMessage(raw)!;
    expect(out.ident).toMatchObject({
      mmsi: 440123456, name: "KR CARGO", callsign: "DS1234",
      shipType: 70, destination: "BUSAN",
      dimBow: 100, dimStern: 20, dimPort: 10, dimStarboard: 12,
    });
  });

  it("maps unavailable values (Type 0, empty Destination, 0 dims, missing Dimension) to null", () => {
    const raw = {
      MessageType: "ShipStaticData",
      MetaData: { MMSI: 440123456, time_utc: TS },
      Message: { ShipStaticData: { Name: "X", CallSign: "Y", Type: 0, Destination: "" } },
    };
    const ident = parseAisStreamMessage(raw)!.ident!;
    expect(ident.shipType).toBeNull();
    expect(ident.destination).toBeNull();
    expect(ident.dimBow).toBeNull();
    expect(ident.dimStarboard).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/aisstream-static.test.ts`
Expected: FAIL — `ident.shipType` is `undefined`, not `70`/`null`.

- [ ] **Step 3: Implement**

In `src/aisstream.ts`, replace the `ShipStaticData` branch with:

```ts
    if (r.MessageType === "ShipStaticData" && r.Message?.ShipStaticData) {
      const sd = r.Message.ShipStaticData;
      const dim = sd.Dimension ?? {};
      // AIS uses 0 as "not available" for type and dimensions.
      const posInt = (v: unknown) => { const n = Number(v); return Number.isInteger(n) && n > 0 ? n : null; };
      return { ident: {
        mmsi,
        name: String(sd.Name ?? "").trim(),
        callsign: String(sd.CallSign ?? "").trim(),
        ts,
        shipType: posInt(sd.Type),
        destination: String(sd.Destination ?? "").trim() || null,
        dimBow: posInt(dim.A), dimStern: posInt(dim.B),
        dimPort: posInt(dim.C), dimStarboard: posInt(dim.D),
      } };
    }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/aisstream-static.test.ts test/aisstream.test.ts` → PASS.

- [ ] **Step 5: Commit**

```bash
git add src/aisstream.ts test/aisstream-static.test.ts
git commit -m "feat: parse ship type, destination and dimensions from ShipStaticData"
```

---

### Task 4: Pipeline region tagging + static enrichment; DO subscribes to all three boxes

**Files:**
- Modify: `src/pipeline.ts`, `src/do/tracker.ts` (lines 56–61, the `BoundingBoxes` payload), `src/config.ts` (delete `bbox`)
- Test: `test/pipeline-regions.test.ts`

**Interfaces:**
- Consumes: `regionForPoint` (Task 1), extended types (Task 2).
- Produces: `Tracker.handlePosition` sets `state.region` from the position and stamps every returned event's `region`; `Tracker.tick` stamps gap events with the vessel's current `state.region`; `Tracker.handleStatic` copies `shipType/destination/dim*` onto state when present. The DO subscription sends one `BoundingBoxes` array with all three region boxes. `CONFIG.bbox` no longer exists.

- [ ] **Step 1: Write the failing test**

Create `test/pipeline-regions.test.ts`:

```ts
// test/pipeline-regions.test.ts
import { describe, expect, it } from "vitest";
import { CONFIG } from "../src/config";
import { GeoContext } from "../src/geo/context";
import { Tracker } from "../src/pipeline";
import type { AisPosition } from "../src/types";

const geo = new GeoContext({ type: "FeatureCollection", features: [] } as any,
                            { type: "FeatureCollection", features: [] } as any, 1000);
const T0 = 1_750_000_000_000;
const pos = (mmsi: number, lon: number, lat: number, tMin: number): AisPosition =>
  ({ mmsi, lon, lat, sog: 10, cog: 0, heading: null, ts: T0 + tMin * 60_000 });

describe("pipeline region tagging", () => {
  it("sets state.region from the latest position", () => {
    const t = new Tracker(geo, CONFIG);
    t.handlePosition(pos(1, 129.3, 34.7, 0)); // Busan approaches
    expect(t.states.get(1)!.region).toBe("kr");
    t.handlePosition(pos(1, 150.0, 10.0, 1)); // outside all boxes
    expect(t.states.get(1)!.region).toBeNull();
  });

  it("stamps region onto events emitted by handlePosition", () => {
    const t = new Tracker(geo, CONFIG);
    t.handlePosition(pos(2, 129.3, 34.7, 0));
    // ~110 km in 5 min → teleport (identity) event
    const evs = t.handlePosition(pos(2, 129.3, 33.7, 5));
    expect(evs.length).toBeGreaterThan(0);
    expect(evs.every((e) => e.region === "kr")).toBe(true);
  });

  it("stamps region onto tick (gap) events", () => {
    const t = new Tracker(geo, CONFIG);
    t.handlePosition(pos(3, 121.5, 24.9, 0)); // tw
    const evs = t.tick(T0 + 90 * 60_000);
    expect(evs).toHaveLength(1);
    expect(evs[0].region).toBe("tw");
  });

  it("handleStatic copies ship static data onto state", () => {
    const t = new Tracker(geo, CONFIG);
    t.handleStatic({ mmsi: 4, name: "A", callsign: "DS1", ts: T0,
      shipType: 80, destination: "ULSAN", dimBow: 200, dimStern: 50, dimPort: 20, dimStarboard: 20 });
    const s = t.states.get(4)!;
    expect(s.shipType).toBe(80);
    expect(s.destination).toBe("ULSAN");
    expect(s.dimBow).toBe(200);
    // a later static message without extras must not wipe known values
    t.handleStatic({ mmsi: 4, name: "A", callsign: "DS1", ts: T0 + 1000 });
    expect(t.states.get(4)!.shipType).toBe(80);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/pipeline-regions.test.ts`
Expected: FAIL — `region` is `null`/`undefined` on state and events; static extras not copied.

- [ ] **Step 3: Implement**

In `src/pipeline.ts`:
- Add import: `import { regionForPoint } from "./geo/regions";`
- In `handlePosition`, replace the block from `for (const ev of events) applyEventToScore(...)` to the end with:

```ts
    const region = regionForPoint(msg.lon, msg.lat);
    s.region = region;
    for (const ev of events) {
      ev.region = region;
      applyEventToScore(s, ev, this.cfg, msg.ts);
    }

    s.ring.push(msg);
    if (s.ring.length > this.cfg.ringSize) s.ring.shift();
    s.lastSeen = msg.ts;
    return events;
```

- In `handleStatic`, after `const events = this.guard(...)` add:

```ts
    if (ident.shipType != null) s.shipType = ident.shipType;
    if (ident.destination != null) s.destination = ident.destination;
    if (ident.dimBow != null) s.dimBow = ident.dimBow;
    if (ident.dimStern != null) s.dimStern = ident.dimStern;
    if (ident.dimPort != null) s.dimPort = ident.dimPort;
    if (ident.dimStarboard != null) s.dimStarboard = ident.dimStarboard;
    for (const ev of events) { ev.region = s.region; applyEventToScore(s, ev, this.cfg, ident.ts); }
    return events;
```

(and delete the old `for (const ev of events) applyEventToScore(...)` line there).

- In `tick`, stamp the region before scoring:

```ts
      const evs = this.guard(s, () => gapOnTick(s, this.geo, this.cfg, now));
      for (const ev of evs) { ev.region = s.region; applyEventToScore(s, ev, this.cfg, now); }
```

In `src/do/tracker.ts`, replace the `open` listener body's bbox lines:

```ts
        const boxes = CONFIG.regions.map((r) =>
          [[r.bbox.minLat, r.bbox.minLon], [r.bbox.maxLat, r.bbox.maxLon]]); // AISStream expects [lat, lon]
        ws.send(JSON.stringify({
          APIKey: this.env.AISSTREAM_KEY,
          BoundingBoxes: boxes,
          FilterMessageTypes: ["PositionReport", "ShipStaticData"],
        }));
```

(delete the `const b = CONFIG.bbox;` line). Then delete the `bbox:` line from `src/config.ts` and grep to confirm no consumer remains: `grep -rn "CONFIG.bbox" src test scripts` → no matches.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test` → all PASS (including the existing pipeline/replay tests).

- [ ] **Step 5: Commit**

```bash
git add src/pipeline.ts src/do/tracker.ts src/config.ts test/pipeline-regions.test.ts
git commit -m "feat: tag regions at ingest, enrich state from static data, subscribe to 3 region boxes"
```

---

### Task 5: API `?region=` filters, richer payloads, `limit` param

**Files:**
- Modify: `src/worker.ts`
- Test: `test/api-regions.test.ts`

**Interfaces:**
- Consumes: `CONFIG.regions` (Task 1), migrated schema (Task 2).
- Produces:
  - `/api/snapshot?region=kr|tw|jp` — optional filter; invalid value → `400 {"error":"bad region"}`. Feature `properties` gain `region: string | null` and `shipType: number | null`.
  - `/api/events?region=...&limit=N` — same region filter; `limit` clamped to 1–1000, default 200 (the cable panel needs up to 1000 — Task 15).
  - `/api/vessel/:mmsi` — `vessel` object gains `region`, `shipType`, `destination`, `dimBow`, `dimStern`, `dimPort`, `dimStarboard`; `rowToEvent` gains `region`.

- [ ] **Step 1: Write the failing test**

Create `test/api-regions.test.ts`:

```ts
// test/api-regions.test.ts
import { env, SELF } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";

const T0 = Date.now() - 10 * 60_000;

async function seed() {
  await env.DB.batch([
    env.DB.prepare("DELETE FROM vessels"), env.DB.prepare("DELETE FROM events"),
    env.DB.prepare(`INSERT INTO vessels (mmsi, name, callsign, last_lon, last_lat, last_sog, last_cog, last_ts, score, score_ts,
                                         region, ship_type, destination, dim_bow, dim_stern, dim_port, dim_starboard)
                    VALUES (440000001, 'KR SHIP', 'DS1', 129.3, 34.7, 1, 0, ?1, 2, ?1, 'kr', 70, 'BUSAN', 100, 20, 10, 12)`).bind(T0),
    env.DB.prepare(`INSERT INTO vessels (mmsi, name, callsign, last_lon, last_lat, last_sog, last_cog, last_ts, score, score_ts, region)
                    VALUES (416000001, 'TW SHIP', 'BV1', 121.5, 24.9, 1, 0, ?1, 1, ?1, 'tw')`).bind(T0),
    env.DB.prepare(`INSERT INTO events (id, type, severity, mmsi, lon, lat, start_ts, end_ts, evidence, region)
                    VALUES ('e-kr', 'loitering', 3, 440000001, 129.3, 34.7, ?1, NULL, '{}', 'kr')`).bind(T0),
    env.DB.prepare(`INSERT INTO events (id, type, severity, mmsi, lon, lat, start_ts, end_ts, evidence, region)
                    VALUES ('e-tw', 'ais_gap', 2, 416000001, 121.5, 24.9, ?1, NULL, '{}', 'tw')`).bind(T0),
  ]);
}

describe("region-aware API", () => {
  beforeEach(seed);

  it("snapshot filters by region and exposes region/shipType properties", async () => {
    const all = await (await SELF.fetch("https://x/api/snapshot")).json<any>();
    expect(all.vessels.features).toHaveLength(2);
    const kr = await (await SELF.fetch("https://x/api/snapshot?region=kr")).json<any>();
    expect(kr.vessels.features).toHaveLength(1);
    expect(kr.vessels.features[0].properties).toMatchObject({ mmsi: 440000001, region: "kr", shipType: 70 });
  });

  it("events filter by region; bad region → 400", async () => {
    const kr = await (await SELF.fetch(`https://x/api/events?since=0&region=kr`)).json<any>();
    expect(kr.events).toHaveLength(1);
    expect(kr.events[0]).toMatchObject({ id: "e-kr", region: "kr" });
    expect((await SELF.fetch("https://x/api/events?region=zz")).status).toBe(400);
    expect((await SELF.fetch("https://x/api/snapshot?region=zz")).status).toBe(400);
  });

  it("events honour limit (clamped to 1000)", async () => {
    const one = await (await SELF.fetch(`https://x/api/events?since=0&limit=1`)).json<any>();
    expect(one.events).toHaveLength(1);
    const huge = await (await SELF.fetch(`https://x/api/events?since=0&limit=99999`)).json<any>();
    expect(huge.events).toHaveLength(2); // clamp doesn't error, just caps
  });

  it("vessel dossier exposes region and static data", async () => {
    const body = await (await SELF.fetch("https://x/api/vessel/440000001")).json<any>();
    expect(body.vessel).toMatchObject({
      region: "kr", shipType: 70, destination: "BUSAN",
      dimBow: 100, dimStern: 20, dimPort: 10, dimStarboard: 12,
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/api-regions.test.ts`
Expected: FAIL — region filter ignored (2 features returned), no `region` property, `?region=zz` returns 200.

- [ ] **Step 3: Implement**

In `src/worker.ts`:
- Add a helper above `export default`:

```ts
// Returns the validated region filter, "" for none, or null for an invalid value.
function regionParam(url: URL): string | null {
  const r = url.searchParams.get("region");
  if (r === null) return "";
  return CONFIG.regions.some((x) => x.id === r) ? r : null;
}
```

- Extend `rowToEvent` with `region: r.region ?? null,`.
- Replace the `/api/snapshot` handler's query with:

```ts
      const region = regionParam(url);
      if (region === null) return json({ error: "bad region" }, 400);
      const { results } = region
        ? await env.DB.prepare(`SELECT * FROM vessels WHERE last_ts >= ?1 AND region = ?2 ORDER BY score DESC`)
            .bind(now - CONFIG.snapshotWindowMs, region).all<any>()
        : await env.DB.prepare(`SELECT * FROM vessels WHERE last_ts >= ?1 ORDER BY score DESC`)
            .bind(now - CONFIG.snapshotWindowMs).all<any>();
```

and add to each feature's `properties`: `region: r.region ?? null, shipType: r.ship_type ?? null,`.

- Replace the `/api/events` handler with:

```ts
    if (url.pathname === "/api/events") {
      const region = regionParam(url);
      if (region === null) return json({ error: "bad region" }, 400);
      const since = Number(url.searchParams.get("since") ?? 0);
      const limit = Math.min(Math.max(Math.trunc(Number(url.searchParams.get("limit")) || 200), 1), 1000);
      const { results } = region
        ? await env.DB.prepare(`SELECT * FROM events WHERE start_ts >= ?1 AND region = ?2 ORDER BY start_ts DESC LIMIT ?3`)
            .bind(Number.isFinite(since) ? since : 0, region, limit).all<any>()
        : await env.DB.prepare(`SELECT * FROM events WHERE start_ts >= ?1 ORDER BY start_ts DESC LIMIT ?2`)
            .bind(Number.isFinite(since) ? since : 0, limit).all<any>();
      return json({ generatedAt: now, events: results.map(rowToEvent) });
    }
```

- In the `/api/vessel/:mmsi` handler, extend the returned `vessel` object with:

```ts
          region: vessel.region ?? null, shipType: vessel.ship_type ?? null,
          destination: vessel.destination ?? null,
          dimBow: vessel.dim_bow ?? null, dimStern: vessel.dim_stern ?? null,
          dimPort: vessel.dim_port ?? null, dimStarboard: vessel.dim_starboard ?? null,
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test` → all PASS (`test/api.test.ts` was already switched to explicit column lists in Task 2, so it is unaffected).

- [ ] **Step 5: Commit**

```bash
git add src/worker.ts test/api-regions.test.ts
git commit -m "feat: region filters + limit on API, richer snapshot/dossier payloads"
```

---

### Task 6: `/api/stats`

**Files:**
- Modify: `src/worker.ts`
- Test: `test/stats.test.ts`

**Interfaces:**
- Consumes: schema from Task 2, `CONFIG.regions`.
- Produces `GET /api/stats` →

```json
{
  "generatedAt": 1234,
  "regions": {
    "kr": { "vessels": 1, "activeAlerts": 1, "events24h": 1 },
    "tw": { "vessels": 0, "activeAlerts": 0, "events24h": 0 },
    "jp": { "vessels": 0, "activeAlerts": 0, "events24h": 0 }
  },
  "histogram": {
    "kr": [ { "day": "2026-06-22", "counts": [0, 0, 2, 0, 0] }, /* …14 entries, oldest→newest, UTC days */ ],
    "tw": [ /* 14 */ ], "jp": [ /* 14 */ ]
  }
}
```

`counts[i]` = events of severity `i+1` that day. `vessels` = rows with `last_ts` within `CONFIG.snapshotWindowMs`; `activeAlerts` = events with `end_ts IS NULL`; `events24h` = events with `start_ts >= now − 24 h`. NULL-region rows are excluded from stats.

- [ ] **Step 1: Write the failing test**

Create `test/stats.test.ts`:

```ts
// test/stats.test.ts
import { env, SELF } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";

const NOW = Date.now();
const T0 = NOW - 10 * 60_000;
const DAY = 86_400_000;

describe("/api/stats", () => {
  beforeEach(async () => {
    await env.DB.batch([
      env.DB.prepare("DELETE FROM vessels"), env.DB.prepare("DELETE FROM events"),
      env.DB.prepare(`INSERT INTO vessels (mmsi, name, callsign, last_lon, last_lat, last_sog, last_cog, last_ts, score, score_ts, region)
                      VALUES (440000001, 'KR', NULL, 129.3, 34.7, 1, 0, ?1, 0, ?1, 'kr')`).bind(T0),
      env.DB.prepare(`INSERT INTO vessels (mmsi, name, callsign, last_lon, last_lat, last_sog, last_cog, last_ts, score, score_ts, region)
                      VALUES (440000002, 'KR OLD', NULL, 129.3, 34.7, 1, 0, ?1, 0, ?1, 'kr')`).bind(T0 - 2 * 3_600_000),
      env.DB.prepare(`INSERT INTO events (id, type, severity, mmsi, lon, lat, start_ts, end_ts, evidence, region)
                      VALUES ('open-kr', 'loitering', 3, 440000001, 129.3, 34.7, ?1, NULL, '{}', 'kr')`).bind(T0),
      env.DB.prepare(`INSERT INTO events (id, type, severity, mmsi, lon, lat, start_ts, end_ts, evidence, region)
                      VALUES ('old-kr', 'ais_gap', 5, 440000001, 129.3, 34.7, ?1, ?1, '{}', 'kr')`).bind(NOW - 3 * DAY),
      env.DB.prepare(`INSERT INTO events (id, type, severity, mmsi, lon, lat, start_ts, end_ts, evidence, region)
                      VALUES ('null-region', 'ais_gap', 2, 1, 0, 0, ?1, NULL, '{}', NULL)`).bind(T0),
    ]);
  });

  it("returns per-region counts and a 14-day severity histogram", async () => {
    const res = await SELF.fetch("https://x/api/stats");
    expect(res.status).toBe(200);
    const body = await res.json<any>();
    expect(body.regions.kr).toEqual({ vessels: 1, activeAlerts: 1, events24h: 1 });
    expect(body.regions.tw).toEqual({ vessels: 0, activeAlerts: 0, events24h: 0 });
    expect(body.regions.jp).toEqual({ vessels: 0, activeAlerts: 0, events24h: 0 });

    const kr = body.histogram.kr;
    expect(kr).toHaveLength(14);
    expect(kr.every((b: any) => /^\d{4}-\d{2}-\d{2}$/.test(b.day) && b.counts.length === 5)).toBe(true);
    // the bucket for T0's UTC day has the sev-3 loitering event
    // (T0 is 10 min ago — right after UTC midnight that can be "yesterday", so look the day up)
    const t0Day = new Date(T0).toISOString().slice(0, 10);
    expect(kr.find((b: any) => b.day === t0Day)!.counts[2]).toBe(1);
    // three days ago has the sev-5 gap event
    const threeAgo = new Date(NOW - 3 * DAY).toISOString().slice(0, 10);
    expect(kr.find((b: any) => b.day === threeAgo)!.counts[4]).toBe(1);
    // 14 buckets for every region even with no data
    expect(body.histogram.jp).toHaveLength(14);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/stats.test.ts`
Expected: FAIL — 404 `{"error":"not found"}`.

- [ ] **Step 3: Implement**

In `src/worker.ts`, add before the `/api/gfw` handler:

```ts
    if (url.pathname === "/api/stats") {
      const DAY = 86_400_000;
      const [vc, ac, e24, hist] = await env.DB.batch([
        env.DB.prepare(`SELECT region, COUNT(*) AS c FROM vessels WHERE last_ts >= ?1 AND region IS NOT NULL GROUP BY region`)
          .bind(now - CONFIG.snapshotWindowMs),
        env.DB.prepare(`SELECT region, COUNT(*) AS c FROM events WHERE end_ts IS NULL AND region IS NOT NULL GROUP BY region`),
        env.DB.prepare(`SELECT region, COUNT(*) AS c FROM events WHERE start_ts >= ?1 AND region IS NOT NULL GROUP BY region`)
          .bind(now - DAY),
        env.DB.prepare(`SELECT region, severity, date(start_ts / 1000, 'unixepoch') AS d, COUNT(*) AS c
                        FROM events WHERE start_ts >= ?1 AND region IS NOT NULL GROUP BY region, severity, d`)
          .bind(now - 13 * DAY - (now % DAY)), // from the start of the UTC day 13 days ago
      ]);
      const regions: Record<string, { vessels: number; activeAlerts: number; events24h: number }> = {};
      const histogram: Record<string, { day: string; counts: number[] }[]> = {};
      for (const r of CONFIG.regions) {
        regions[r.id] = { vessels: 0, activeAlerts: 0, events24h: 0 };
        histogram[r.id] = Array.from({ length: 14 }, (_, i) => ({
          day: new Date(now - (13 - i) * DAY).toISOString().slice(0, 10),
          counts: [0, 0, 0, 0, 0],
        }));
      }
      for (const row of vc.results as any[]) if (regions[row.region]) regions[row.region].vessels = row.c;
      for (const row of ac.results as any[]) if (regions[row.region]) regions[row.region].activeAlerts = row.c;
      for (const row of e24.results as any[]) if (regions[row.region]) regions[row.region].events24h = row.c;
      for (const row of hist.results as any[]) {
        const bucket = histogram[row.region]?.find((b) => b.day === row.d);
        if (bucket) bucket.counts[row.severity - 1] = row.c;
      }
      return json({ generatedAt: now, regions, histogram });
    }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test` → all PASS.

- [ ] **Step 5: Commit**

```bash
git add src/worker.ts test/stats.test.ts
git commit -m "feat: /api/stats — per-region counts and 14-day severity histogram"
```

---

### Task 7: KR/JP cable corridors, metadata properties, exclusion zones, data sync

**Files:**
- Modify: `data/cables.json`, `data/exclusions.json`, `package.json`
- Delete-and-replace (synced copies): `web/public/data/cables.json`, `web/public/data/exclusions.json`
- Test: `test/cables-data.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: every cable feature has properties `{ name: string, approximate: true, region: "kr"|"tw"|"jp", systems: string[], landing_points: string[], notes: string }`. New npm script `sync-data` copies `data/*.json` → `web/public/data/`; `build:web` runs it first. `GeoContext` (which only reads `name` and `coordinates`) is unaffected.

- [ ] **Step 1: Write the failing test**

Create `test/cables-data.test.ts`:

```ts
// test/cables-data.test.ts
import { describe, expect, it } from "vitest";
import cables from "../data/cables.json";
import { CONFIG } from "../src/config";

describe("cable corridor data", () => {
  const feats = (cables as any).features;

  it("covers all three regions", () => {
    const regions = new Set(feats.map((f: any) => f.properties.region));
    expect(regions).toEqual(new Set(["kr", "tw", "jp"]));
  });

  it("every feature carries full metadata", () => {
    for (const f of feats) {
      expect(f.properties.approximate).toBe(true);
      expect(["kr", "tw", "jp"]).toContain(f.properties.region);
      expect(Array.isArray(f.properties.systems) && f.properties.systems.length).toBeTruthy();
      expect(Array.isArray(f.properties.landing_points) && f.properties.landing_points.length).toBeTruthy();
      expect(typeof f.properties.notes).toBe("string");
    }
  });

  it("every corridor's first point lies inside its region's bbox", () => {
    for (const f of feats) {
      const b = CONFIG.regions.find((r) => r.id === f.properties.region)!.bbox;
      const [lon, lat] = f.geometry.coordinates[0];
      expect(lon).toBeGreaterThanOrEqual(b.minLon); expect(lon).toBeLessThanOrEqual(b.maxLon);
      expect(lat).toBeGreaterThanOrEqual(b.minLat); expect(lat).toBeLessThanOrEqual(b.maxLat);
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/cables-data.test.ts`
Expected: FAIL — existing features have no `region`/`systems`/`landing_points`.

- [ ] **Step 3: Implement**

Replace `data/cables.json` with (existing 5 TW corridors enriched + 3 KR + 4 JP):

```json
{
  "type": "FeatureCollection",
  "features": [
    { "type": "Feature", "properties": { "name": "Toucheng East Corridor (intl. landings)", "approximate": true, "region": "tw", "systems": ["APG", "FASTER", "SJC2", "EAC-C2C"], "landing_points": ["Toucheng"], "notes": "Main international landing cluster on Taiwan's northeast coast." },
      "geometry": { "type": "LineString", "coordinates": [[121.882, 24.855], [122.4, 24.9], [123.2, 25.0]] } },
    { "type": "Feature", "properties": { "name": "Tamsui North Corridor (intl. landings)", "approximate": true, "region": "tw", "systems": ["TSE-1", "TPE"], "landing_points": ["Tamsui"], "notes": "Northern approaches; crosses the Taiwan–Matsu ferry lanes." },
      "geometry": { "type": "LineString", "coordinates": [[121.41, 25.19], [121.3, 25.6], [121.1, 26.1]] } },
    { "type": "Feature", "properties": { "name": "Fangshan Southwest Corridor (SMW3/FLAG/APG)", "approximate": true, "region": "tw", "systems": ["SMW3", "FLAG", "APG"], "landing_points": ["Fangshan"], "notes": "Southwest corridor toward the South China Sea and Luzon Strait." },
      "geometry": { "type": "LineString", "coordinates": [[120.593, 22.263], [119.8, 21.7], [118.8, 21.3]] } },
    { "type": "Feature", "properties": { "name": "Taiwan-Matsu No.2/3 (domestic)", "approximate": true, "region": "tw", "systems": ["Taiwan-Matsu No.2", "Taiwan-Matsu No.3"], "landing_points": ["Tamsui", "Matsu"], "notes": "Domestic link repeatedly damaged in 2023–2025 incidents." },
      "geometry": { "type": "LineString", "coordinates": [[121.41, 25.19], [120.7, 25.7], [119.97, 26.15]] } },
    { "type": "Feature", "properties": { "name": "Taiwan-Penghu No.3 (domestic)", "approximate": true, "region": "tw", "systems": ["Taiwan-Penghu No.3"], "landing_points": ["Chiayi", "Penghu"], "notes": "Domestic link across the Taiwan Strait shallows." },
      "geometry": { "type": "LineString", "coordinates": [[120.18, 23.35], [119.9, 23.4], [119.6, 23.55]] } },

    { "type": "Feature", "properties": { "name": "Busan South Corridor (intl. landings)", "approximate": true, "region": "kr", "systems": ["APG", "APCN-2", "SJC2"], "landing_points": ["Busan Songjeong"], "notes": "Korea's main international landing cluster; heavy anchorage traffic nearby." },
      "geometry": { "type": "LineString", "coordinates": [[129.2, 35.17], [129.5, 34.7], [130.0, 34.1]] } },
    { "type": "Feature", "properties": { "name": "Geoje South Corridor (intl. landings)", "approximate": true, "region": "kr", "systems": ["SJC", "FASTER", "NCP"], "landing_points": ["Geoje"], "notes": "Southern approaches shared with Busan-bound shipping lanes." },
      "geometry": { "type": "LineString", "coordinates": [[128.62, 34.85], [128.8, 34.3], [129.1, 33.7]] } },
    { "type": "Feature", "properties": { "name": "Taean West Corridor (Yellow Sea)", "approximate": true, "region": "kr", "systems": ["C2C", "EAC", "KJCN West"], "landing_points": ["Taean Sinduri"], "notes": "Yellow Sea landing corridor; shallow water, dense fishing activity." },
      "geometry": { "type": "LineString", "coordinates": [[126.18, 36.85], [125.5, 36.4], [124.8, 35.9]] } },

    { "type": "Feature", "properties": { "name": "Kitaibaraki North Corridor (intl. landings)", "approximate": true, "region": "jp", "systems": ["PC-1", "FASTER"], "landing_points": ["Kitaibaraki"], "notes": "Trans-Pacific landings on the Ibaraki coast." },
      "geometry": { "type": "LineString", "coordinates": [[140.78, 36.82], [141.2, 36.7], [141.5, 36.5]] } },
    { "type": "Feature", "properties": { "name": "Chikura Corridor (Boso peninsula)", "approximate": true, "region": "jp", "systems": ["APG", "JUPITER", "Unity"], "landing_points": ["Chikura", "Maruyama"], "notes": "Dense trans-Pacific landing cluster at the tip of the Boso peninsula." },
      "geometry": { "type": "LineString", "coordinates": [[139.95, 34.95], [140.4, 34.6], [140.9, 34.2]] } },
    { "type": "Feature", "properties": { "name": "Shima Corridor (intl. landings)", "approximate": true, "region": "jp", "systems": ["SJC2", "JGA-N", "SEA-US"], "landing_points": ["Shima"], "notes": "Landing cluster on the Kii/Ise coast south of Nagoya." },
      "geometry": { "type": "LineString", "coordinates": [[136.86, 34.28], [137.2, 33.8], [137.6, 33.4]] } },
    { "type": "Feature", "properties": { "name": "Kyushu–Korea Strait Corridor", "approximate": true, "region": "jp", "systems": ["KJCN", "Korea–Japan segments"], "landing_points": ["Fukuoka", "Kitakyushu"], "notes": "Korea–Japan strait crossing; ferry and cargo lanes overhead." },
      "geometry": { "type": "LineString", "coordinates": [[130.35, 33.68], [130.15, 33.95], [130.0, 34.2]] } }
  ]
}
```

Append to `data/exclusions.json`'s `features` array (anchorage/port zones so the loitering detector doesn't spam KR/JP ports):

```json
    { "type": "Feature", "properties": { "name": "Busan anchorage" },
      "geometry": { "type": "Polygon", "coordinates": [[[129.00, 35.00], [129.20, 35.00], [129.20, 35.12], [129.00, 35.12], [129.00, 35.00]]] } },
    { "type": "Feature", "properties": { "name": "Kanmon/Hakata anchorage" },
      "geometry": { "type": "Polygon", "coordinates": [[[130.30, 33.60], [130.55, 33.60], [130.55, 33.75], [130.30, 33.75], [130.30, 33.60]]] } },
    { "type": "Feature", "properties": { "name": "Tokyo Bay entrance anchorage" },
      "geometry": { "type": "Polygon", "coordinates": [[[139.65, 35.15], [139.90, 35.15], [139.90, 35.40], [139.65, 35.40], [139.65, 35.15]]] } },
    { "type": "Feature", "properties": { "name": "Ise Bay anchorage" },
      "geometry": { "type": "Polygon", "coordinates": [[[136.70, 34.80], [136.95, 34.80], [136.95, 35.00], [136.70, 35.00], [136.70, 34.80]]] } }
```

In `package.json` `scripts`, add `sync-data` and chain it into `build:web`:

```json
    "sync-data": "cp data/cables.json data/exclusions.json web/public/data/",
    "build:web": "npm run sync-data && vite build web",
```

Run `npm run sync-data` now so the `web/public/data/` copies match.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test` → all PASS. **Watch `test/context.test.ts` and `test/replay.test.ts`:** the new KR/JP corridors don't overlap Taiwan waters, and the added exclusion polygons are outside the TW fixtures' coordinates, so they should pass unchanged. If a fixture assertion breaks, the data overlaps a fixture point — adjust the new polygon/corridor coordinates, not the test.
Also run: `diff data/cables.json web/public/data/cables.json` → no output.

- [ ] **Step 5: Commit**

```bash
git add data/cables.json data/exclusions.json web/public/data/ package.json test/cables-data.test.ts
git commit -m "feat: KR/JP cable corridors + metadata, port exclusion zones, data sync script"
```

---

### Task 8: Replay harness `--region` passthrough

**Files:**
- Modify: `src/replay-core.ts`, `scripts/replay.ts`
- Test: `test/replay-region.test.ts`

**Interfaces:**
- Consumes: region-stamped events from the pipeline (Task 4).
- Produces: `replayCapture(lines, geo, tickIntervalMs?, region?)` — when `region` is given, `events` contains only events whose `region` matches. CLI: `npm run replay -- capture.ndjson --region kr`.

- [ ] **Step 1: Write the failing test**

Create `test/replay-region.test.ts`:

```ts
// test/replay-region.test.ts
/// <reference types="vite/client" />
import { describe, expect, it } from "vitest";
import { GeoContext } from "../src/geo/context";
import { replayCapture } from "../src/replay-core";
import capture from "./fixtures/capture.ndjson?raw";

const lines = capture.trim().split("\n");

describe("replay --region", () => {
  it("stamps regions on replayed events (fixture is Taiwan waters)", () => {
    const all = replayCapture(lines, new GeoContext());
    expect(all.events.length).toBeGreaterThan(0);
    expect(all.events.every((e) => e.region === "tw")).toBe(true);
  });

  it("filters events by region without changing message/vessel counts", () => {
    const tw = replayCapture(lines, new GeoContext(), undefined, "tw");
    const kr = replayCapture(lines, new GeoContext(), undefined, "kr");
    expect(tw.events.length).toBeGreaterThan(0);
    expect(kr.events).toHaveLength(0);
    expect(kr.messages).toBe(tw.messages); // filter applies to output, not ingest
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/replay-region.test.ts`
Expected: FAIL — 4th argument ignored, `kr.events` not empty.

- [ ] **Step 3: Implement**

In `src/replay-core.ts`, change the signature and return:

```ts
export function replayCapture(lines: string[], geo: GeoContext, tickIntervalMs = CONFIG.alarmIntervalMs, region?: string): {
  events: AnomalyEvent[]; vessels: number; messages: number;
} {
```

and the final line:

```ts
  return { events: region ? events.filter((e) => e.region === region) : events, vessels: tracker.states.size, messages };
```

Replace `scripts/replay.ts` argument handling:

```ts
// scripts/replay.ts - CLI: npm run replay -- path/to/capture.ndjson [--region kr|tw|jp]
import { readFileSync } from "node:fs";

import { GeoContext } from "../src/geo/context";
import { replayCapture } from "../src/replay-core";

const args = process.argv.slice(2);
const rIdx = args.indexOf("--region");
const region = rIdx >= 0 ? args[rIdx + 1] : undefined;
const rest = rIdx >= 0 ? args.filter((_, i) => i !== rIdx && i !== rIdx + 1) : args;
const file = rest[0];
if (!file || (rIdx >= 0 && !region)) { console.error("usage: npm run replay -- <capture.ndjson> [--region kr|tw|jp]"); process.exit(1); }

const lines = readFileSync(file, "utf8").trim().split("\n");
const { events, vessels, messages } = replayCapture(lines, new GeoContext(), undefined, region);

console.error(`replayed ${messages} messages, ${vessels} vessels, ${events.length} events${region ? ` (region ${region})` : ""}`);
for (const ev of events) console.log(JSON.stringify(ev));
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test` → all PASS. Also sanity-check the CLI:
`npm run replay -- test/fixtures/capture.ndjson --region kr` → stderr ends with `0 events (region kr)`.

- [ ] **Step 5: Commit**

```bash
git add src/replay-core.ts scripts/replay.ts test/replay-region.test.ts
git commit -m "feat: --region passthrough on the replay harness"
```

---

### Task 9: Frontend region store, top bar with switcher, hash precedence, feed filtering

**Files:**
- Create: `web/src/regions.ts`, `web/src/switcher.ts`
- Modify: `web/index.html`, `web/style.css`, `web/src/main.ts`, `web/src/api.ts`, `web/src/panels.ts`
- Test: `test/web-regions.test.ts`

**Interfaces:**
- Consumes: `/api/events?region=` (Task 5).
- Produces (`web/src/regions.ts`):
  - `REGIONS: { id: string; name: string; center: [number, number]; zoom: number }[]` (kr/tw/jp, same centers/zooms as `CONFIG.regions`)
  - `DEFAULT_REGION = "kr"`, `STORE_KEY = "cg-region"`
  - `resolveInitialRegion(stored: string | null): string` — pure, validates against REGIONS, falls back to `DEFAULT_REGION`
  - `getRegion(): string`, `setRegion(id: string): void` (persists to localStorage; notifies listeners only on change), `onRegionChange(fn: (id: string) => void): void`, `regionDef(id: string)`
- Produces (`web/src/switcher.ts`): `initRegionSwitcher(): void` and `activateRegion(id: string): void` (setRegion + `map.flyTo` — used by onboarding in Task 16).
- Produces (`web/src/api.ts`): `fetchEvents(since: number, region?: string, limit?: number)`.
- The event feed re-polls on region change and passes the active region.

- [ ] **Step 1: Write the failing test**

Create `test/web-regions.test.ts`:

```ts
// test/web-regions.test.ts
import { describe, expect, it } from "vitest";
import { DEFAULT_REGION, REGIONS, resolveInitialRegion } from "../web/src/regions";

describe("web region store", () => {
  it("defaults first-time visitors to Korea", () => {
    expect(DEFAULT_REGION).toBe("kr");
    expect(resolveInitialRegion(null)).toBe("kr");
  });
  it("accepts stored valid regions, rejects junk", () => {
    expect(resolveInitialRegion("jp")).toBe("jp");
    expect(resolveInitialRegion("tw")).toBe("tw");
    expect(resolveInitialRegion("zz")).toBe("kr");
    expect(resolveInitialRegion("")).toBe("kr");
  });
  it("exposes all three regions with camera presets", () => {
    expect(REGIONS.map((r) => r.id)).toEqual(["kr", "tw", "jp"]);
    for (const r of REGIONS) {
      expect(r.center).toHaveLength(2);
      expect(r.zoom).toBeGreaterThan(4);
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/web-regions.test.ts`
Expected: FAIL — `Cannot find module '../web/src/regions'`.

- [ ] **Step 3: Implement the region store**

Create `web/src/regions.ts`:

```ts
// web/src/regions.ts — active region: mirror of CONFIG.regions camera presets + localStorage persistence.
export interface RegionDef { id: string; name: string; center: [number, number]; zoom: number }

export const REGIONS: RegionDef[] = [
  { id: "kr", name: "Korea", center: [127.5, 35.0], zoom: 6.3 },
  { id: "tw", name: "Taiwan", center: [120.9, 23.7], zoom: 6.3 },
  { id: "jp", name: "Japan", center: [135.5, 34.5], zoom: 5.8 },
];
export const DEFAULT_REGION = "kr"; // Korean hackathon audience (spec §2)
export const STORE_KEY = "cg-region";

export function resolveInitialRegion(stored: string | null): string {
  return REGIONS.some((r) => r.id === stored) ? (stored as string) : DEFAULT_REGION;
}

// localStorage is absent under vitest workers; guard so pure exports stay importable.
let current = resolveInitialRegion(typeof localStorage === "undefined" ? null : localStorage.getItem(STORE_KEY));
const listeners = new Set<(id: string) => void>();

export const getRegion = (): string => current;
export const regionDef = (id: string): RegionDef => REGIONS.find((r) => r.id === id)!;

export function setRegion(id: string): void {
  if (!REGIONS.some((r) => r.id === id)) return;
  localStorage.setItem(STORE_KEY, id); // persist even when unchanged (spec §2: clicking persists the choice)
  if (id === current) return;
  current = id;
  for (const fn of listeners) fn(id);
}

export function onRegionChange(fn: (id: string) => void): void { listeners.add(fn); }
```

- [ ] **Step 4: Run the store test**

Run: `npx vitest run test/web-regions.test.ts` → PASS.

- [ ] **Step 5: Add the top bar to `web/index.html`**

Replace `<title>` with `<title>East Asia Cable Guard — live vessel anomaly map</title>` and insert directly after `<body>`:

```html
  <header id="topbar">
    <h1>East Asia Cable Guard</h1>
    <nav id="region-switcher" aria-label="Region">
      <button data-region="kr">Korea</button>
      <button data-region="tw">Taiwan</button>
      <button data-region="jp">Japan</button>
    </nav>
    <div id="stats-bar" hidden></div>
    <button id="help-btn" title="About &amp; tour" aria-label="About and tour">?</button>
  </header>
```

- [ ] **Step 6: Style the top bar in `web/style.css`**

Append:

```css
#topbar {
  position: absolute; top: 0; left: 0; right: 0; z-index: 25; height: 44px;
  display: flex; align-items: center; gap: 16px; padding: 0 12px;
  background: var(--panel); backdrop-filter: blur(6px);
}
#topbar h1 { font-size: 14px; font-weight: 600; white-space: nowrap; }
#region-switcher { display: flex; gap: 4px; background: #ffffff10; border-radius: 999px; padding: 3px; }
#region-switcher button {
  border: 0; background: none; color: var(--muted); font: inherit; font-size: 13px;
  padding: 4px 14px; border-radius: 999px; cursor: pointer;
}
#region-switcher button.active { background: var(--accent); color: #06121f; font-weight: 600; }
#help-btn {
  margin-left: auto; width: 26px; height: 26px; border-radius: 50%; border: 1px solid var(--muted);
  background: none; color: var(--muted); font-size: 14px; cursor: pointer;
}
#stats-bar { display: flex; gap: 14px; font-size: 12px; color: var(--muted); white-space: nowrap; }
#stats-bar b { color: var(--text); font-size: 13px; }
@media (max-width: 720px) { #topbar h1, #stats-bar { display: none; } }
```

And adjust panels for the bar — change the existing rules:
- `#stale-banner` → `top: 44px;` (was `top: 0`)
- `#event-feed` → `top: 56px;` (was `top: 12px`)
- `#dossier` → `top: 56px;` (was `top: 12px`)

- [ ] **Step 7: Implement the switcher**

Create `web/src/switcher.ts`:

```ts
// web/src/switcher.ts — region pills: camera preset + region filter + persistence.
import { map } from "./main";
import { getRegion, onRegionChange, regionDef, setRegion } from "./regions";

export function activateRegion(id: string): void {
  setRegion(id);
  const r = regionDef(id);
  map.flyTo({ center: r.center, zoom: r.zoom });
}

export function initRegionSwitcher(): void {
  const nav = document.getElementById("region-switcher")!;
  const paint = () => nav.querySelectorAll<HTMLButtonElement>("button[data-region]")
    .forEach((b) => b.classList.toggle("active", b.dataset.region === getRegion()));
  nav.addEventListener("click", (e) => {
    const btn = (e.target as HTMLElement).closest<HTMLElement>("button[data-region]");
    if (btn) activateRegion(btn.dataset.region!); // re-clicking the active pill still recenters
  });
  onRegionChange(paint);
  paint();
}
```

- [ ] **Step 8: Wire into `web/src/main.ts` (hash precedence)**

Add imports: `import { getRegion, regionDef } from "./regions";` and `import { initRegionSwitcher } from "./switcher";`.
Replace the map construction's center/zoom lines with:

```ts
const home = regionDef(getRegion()); // localStorage default (Korea on first visit)…
export const map = new maplibregl.Map({
  container: "map",
  style: "https://tiles.openfreemap.org/styles/dark",
  center: hashState.view ? [hashState.view.lon, hashState.view.lat] : home.center, // …but the URL hash wins (spec §2)
  zoom: hashState.view?.zoom ?? home.zoom,
  attributionControl: { compact: true },
});
```

Inside `map.on("load", ...)`, after `initEventFeed();` add `initRegionSwitcher();`.

- [ ] **Step 9: Region-filter the event feed**

In `web/src/api.ts`, replace `fetchEvents`:

```ts
export const fetchEvents = (since: number, region?: string, limit?: number) =>
  get<EventsResponse>(`/api/events?since=${since}${region ? `&region=${region}` : ""}${limit ? `&limit=${limit}` : ""}`);
```

Also add `region: string | null; shipType: number | null;` to `VesselProps` and `region: string | null;` to `ApiEvent` (mirrors Task 5).

In `web/src/panels.ts`, add `import { getRegion, onRegionChange } from "./regions";` and inside `initEventFeed` change the poll to pass the region and re-poll on switch:

```ts
  const poll = async () => {
    try {
      const res = await fetchEvents(Date.now() - 24 * 3_600_000, getRegion());
      list.innerHTML = res.events.map(renderEvent).join("") || "<li>No events in the last 24 h</li>";
    } catch (err) { console.error("event feed failed:", err); }
  };
```

and after `void poll(); setInterval(poll, 15_000);` add:

```ts
  onRegionChange(() => void poll());
```

- [ ] **Step 10: Verify build + behavior**

Run: `npm test` → PASS. Run: `npm run build:web` → builds with no TS errors.
Manual check (`npm run build:web && npm run dev`, open http://localhost:8787): pills render, Korea active on a fresh profile (clear localStorage), clicking Japan flies the camera and persists across reload, a `#v=...` hash URL overrides the stored region's camera.

- [ ] **Step 11: Commit**

```bash
git add web/src/regions.ts web/src/switcher.ts web/src/main.ts web/src/api.ts web/src/panels.ts web/index.html web/style.css test/web-regions.test.ts
git commit -m "feat: region switcher top bar with localStorage default and hash precedence"
```

---

### Task 10: Legend panel

**Files:**
- Modify: `web/index.html`, `web/style.css`

**Interfaces:**
- Consumes: nothing (static HTML/CSS; colors mirror `web/src/vessels.ts` ramp: `#8b96a5` → `#f0a83c` → `#e5484d`, cables `#4cc3ff`, GFW `#b18cff`).
- Produces: a collapsible `<details id="legend">` element, bottom-left — Task 16's tour targets `#legend`.

- [ ] **Step 1: Add the markup**

In `web/index.html`, insert before `<div id="attribution">`:

```html
  <details id="legend">
    <summary>Legend</summary>
    <div class="legend-row"><span class="swatch ramp"></span> Vessel suspicion score (grey 0 → amber 3 → red 8+)</div>
    <div class="legend-row"><span class="swatch cable"></span> Cable corridor (dashed = approximate route)</div>
    <div class="legend-row"><span class="swatch zone"></span> Exclusion zone (anchorage; toggle with ⚓)</div>
    <div class="legend-row"><span class="swatch gfw"></span> GFW-confirmed event (delayed ~72 h)</div>
    <div class="legend-row"><span class="swatch track"></span> Selected vessel track</div>
  </details>
```

- [ ] **Step 2: Style it**

Append to `web/style.css`:

```css
#legend {
  position: absolute; bottom: 24px; left: 8px; z-index: 20; width: 280px;
  background: var(--panel); backdrop-filter: blur(6px); border-radius: 8px; padding: 8px 12px; font-size: 12px;
}
#legend summary { cursor: pointer; font-size: 12px; text-transform: uppercase; letter-spacing: .08em; color: var(--muted); }
.legend-row { display: flex; align-items: center; gap: 8px; padding: 4px 0; }
.swatch { flex: 0 0 22px; height: 10px; border-radius: 3px; }
.swatch.ramp { background: linear-gradient(90deg, var(--grey), var(--amber), var(--red)); border-radius: 5px; }
.swatch.cable { height: 0; border-top: 2px dashed var(--accent); }
.swatch.zone { background: #8b96a533; border: 1px solid #8b96a5; }
.swatch.gfw { width: 10px; flex-basis: 10px; height: 10px; border-radius: 50%; border: 1.5px solid #b18cff; margin: 0 6px; background: transparent; }
.swatch.track { height: 0; border-top: 2px solid var(--accent); }
@media (max-width: 720px) { #legend { display: none; } }
```

- [ ] **Step 3: Verify**

Run: `npm run build:web` → success. Manual: legend collapses/expands; rows match map styling.

- [ ] **Step 4: Commit**

```bash
git add web/index.html web/style.css
git commit -m "feat: collapsible map legend"
```

---

### Task 11: Stats bar

**Files:**
- Create: `web/src/stats.ts`
- Modify: `web/src/api.ts`, `web/src/main.ts`

**Interfaces:**
- Consumes: `/api/stats` (Task 6), `getRegion`/`onRegionChange` (Task 9), the `#stats-bar` element (Task 9).
- Produces (`web/src/api.ts`):

```ts
export interface RegionStats { vessels: number; activeAlerts: number; events24h: number }
export interface DayBucket { day: string; counts: number[] } // counts[i] = severity i+1
export interface StatsResponse { generatedAt: number; regions: Record<string, RegionStats>; histogram: Record<string, DayBucket[]> }
export const fetchStats = () => get<StatsResponse>("/api/stats");
```

- Produces (`web/src/stats.ts`): `initStatsBar(): void` and `onStats(fn: (s: StatsResponse) => void): void` — Task 12's timeline subscribes to `onStats` instead of polling separately.

- [ ] **Step 1: Implement**

Add the four `api.ts` declarations above to `web/src/api.ts`.

Create `web/src/stats.ts`:

```ts
// web/src/stats.ts — top-bar live stats for the active region; shares /api/stats with the timeline.
import { fetchStats, type StatsResponse } from "./api";
import { getRegion, onRegionChange } from "./regions";

let last: StatsResponse | null = null;
const listeners = new Set<(s: StatsResponse) => void>();

export function onStats(fn: (s: StatsResponse) => void): void {
  listeners.add(fn);
  if (last) fn(last);
}

function render(): void {
  const el = document.getElementById("stats-bar")!;
  const s = last?.regions[getRegion()];
  if (!s) { el.hidden = true; return; }
  el.hidden = false;
  el.innerHTML = `<span><b>${s.vessels}</b> vessels tracked</span>` +
    `<span><b>${s.activeAlerts}</b> active alerts</span>` +
    `<span><b>${s.events24h}</b> events / 24 h</span>`;
}

export function initStatsBar(): void {
  const poll = async () => {
    try {
      last = await fetchStats();
      render();
      for (const fn of listeners) fn(last);
    } catch (err) { console.error("stats failed:", err); }
  };
  onRegionChange(render);
  void poll();
  setInterval(poll, 30_000);
}
```

In `web/src/main.ts`: `import { initStatsBar } from "./stats";` and call `initStatsBar();` inside `map.on("load", ...)` after `initRegionSwitcher();`.

- [ ] **Step 2: Verify**

Run: `npm run build:web` → success. `npm test` → PASS. Manual: stats bar shows three numbers and changes when switching regions.

- [ ] **Step 3: Commit**

```bash
git add web/src/stats.ts web/src/api.ts web/src/main.ts
git commit -m "feat: per-region live stats bar"
```

---

### Task 12: Incident timeline (14-day SVG strip + day filter)

**Files:**
- Create: `web/src/timeline.ts`
- Modify: `web/index.html`, `web/style.css`, `web/src/main.ts`, `web/src/panels.ts`

**Interfaces:**
- Consumes: `onStats` (Task 11), `getRegion`/`onRegionChange` (Task 9), `DayBucket` (Task 11).
- Produces (`web/src/timeline.ts`):
  - `initTimeline(): void`
  - `getDayFilter(): { day: string; startTs: number; endTs: number } | null`
  - `onDayFilter(fn: () => void): void`
- The event feed (panels.ts) consumes `getDayFilter`/`onDayFilter`: when a day is selected it fetches `since = startTs` and client-filters `startTs < endTs`.

- [ ] **Step 1: Markup + style**

In `web/index.html`, inside `<aside id="event-feed">` directly after `<h2>Live events</h2>` add:

```html
    <div id="timeline" title="Events per day (last 14 days) — click a day to filter"></div>
```

Append to `web/style.css`:

```css
#timeline { margin-bottom: 8px; }
#timeline svg { display: block; width: 100%; height: 44px; }
#timeline rect.day-hit { fill: transparent; cursor: pointer; }
#timeline rect.day-hit:hover { fill: #ffffff14; }
#timeline rect.selected-outline { fill: none; stroke: var(--accent); stroke-width: 1; }
#timeline .tl-caption { font-size: 10px; color: var(--muted); display: flex; justify-content: space-between; }
```

- [ ] **Step 2: Implement**

Create `web/src/timeline.ts`:

```ts
// web/src/timeline.ts — hand-rolled SVG severity histogram, last 14 days, active region (spec §3).
import type { DayBucket } from "./api";
import { getRegion, onRegionChange } from "./regions";
import { onStats } from "./stats";

const SEV_COLOR = ["#8b96a5", "#8b96a5", "#f0a83c", "#e5484d", "#e5484d"]; // sev 1..5, mirrors feed classes
const W = 276, H = 36, GAP = 2;

let buckets: DayBucket[] = [];
let selected: string | null = null;
const listeners = new Set<() => void>();

export function getDayFilter(): { day: string; startTs: number; endTs: number } | null {
  if (!selected) return null;
  const startTs = Date.parse(`${selected}T00:00:00Z`);
  return { day: selected, startTs, endTs: startTs + 86_400_000 };
}

export function onDayFilter(fn: () => void): void { listeners.add(fn); }

function render(): void {
  const el = document.getElementById("timeline")!;
  if (!buckets.length) { el.innerHTML = ""; return; }
  const bw = (W - GAP * 13) / 14;
  const max = Math.max(1, ...buckets.map((b) => b.counts.reduce((a, c) => a + c, 0)));
  let bars = "";
  buckets.forEach((b, i) => {
    const x = i * (bw + GAP);
    let y = H;
    b.counts.forEach((c, sev) => {
      if (!c) return;
      const h = (c / max) * (H - 2);
      y -= h;
      bars += `<rect x="${x}" y="${y}" width="${bw}" height="${h}" fill="${SEV_COLOR[sev]}" rx="1"></rect>`;
    });
    if (b.day === selected) bars += `<rect class="selected-outline" x="${x - 0.5}" y="0.5" width="${bw + 1}" height="${H - 1}" rx="2"></rect>`;
    bars += `<rect class="day-hit" data-day="${b.day}" x="${x}" y="0" width="${bw}" height="${H}"><title>${b.day}: ${b.counts.reduce((a, c) => a + c, 0)} events</title></rect>`;
  });
  el.innerHTML = `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none">${bars}</svg>` +
    `<div class="tl-caption"><span>${buckets[0].day.slice(5)}</span><span>${selected ? `filtering ${selected} · click again to clear` : "last 14 days"}</span><span>${buckets[13].day.slice(5)}</span></div>`;
}

export function initTimeline(): void {
  const el = document.getElementById("timeline")!;
  el.addEventListener("click", (e) => {
    const hit = (e.target as Element).closest<SVGRectElement>("rect.day-hit");
    if (!hit) return;
    selected = selected === hit.dataset.day ? null : hit.dataset.day!; // click again to clear
    render();
    for (const fn of listeners) fn();
  });
  onStats((s) => { buckets = s.histogram[getRegion()] ?? []; render(); });
  onRegionChange(() => { selected = null; for (const fn of listeners) fn(); });
}
```

**One supporting change in `web/src/stats.ts`:** a region switch must re-feed the cached histogram to `onStats` subscribers immediately (the timeline can't wait for the next 30 s poll). Change the `onRegionChange(render);` line in `initStatsBar` to:

```ts
  onRegionChange(() => { render(); if (last) for (const fn of listeners) fn(last); });
```

- [ ] **Step 3: Wire the day filter into the event feed**

In `web/src/panels.ts` add `import { getDayFilter, onDayFilter } from "./timeline";` and change the poll body to:

```ts
  const poll = async () => {
    try {
      const f = getDayFilter();
      const since = f ? f.startTs : Date.now() - 24 * 3_600_000;
      const res = await fetchEvents(since, getRegion());
      const events = f ? res.events.filter((e) => e.startTs < f.endTs) : res.events;
      list.innerHTML = events.map(renderEvent).join("") ||
        `<li>${f ? `No events on ${f.day}` : "No events in the last 24 h"}</li>`;
    } catch (err) { console.error("event feed failed:", err); }
  };
```

and add `onDayFilter(() => void poll());` next to the existing `onRegionChange(() => void poll());`.

In `web/src/main.ts`: `import { initTimeline } from "./timeline";` and call `initTimeline();` after `initStatsBar();`.

- [ ] **Step 4: Verify**

Run: `npm run build:web` → success. `npm test` → PASS. Manual: bars render (seed events via replay or wait for live data); clicking a day filters the feed and shows the "filtering" caption; clicking again clears; switching regions clears the day filter.

- [ ] **Step 5: Commit**

```bash
git add web/src/timeline.ts web/src/stats.ts web/src/panels.ts web/src/main.ts web/index.html web/style.css
git commit -m "feat: 14-day incident timeline with day filtering"
```

---

### Task 13: Client cable module + event feed corridor detail

**Files:**
- Create: `web/src/geo.ts`, `web/src/cables.ts`
- Modify: `web/src/panels.ts`, `web/style.css`, `web/src/main.ts`

**Interfaces:**
- Consumes: `/data/cables.json` (Task 7 shape), `ApiEvent` (has `region` since Task 9).
- Produces (`web/src/geo.ts`): `pointToPolylineM(p: [number, number], line: [number, number][]): number` — small copy of `src/geo/geo.ts` math (kept separate: the web build must not import across the Vite root).
- Produces (`web/src/cables.ts`):
  - `loadCables(): Promise<void>` — fetches `/data/cables.json` once and caches
  - `interface CableInfo { name: string; region: string; systems: string[]; landing_points: string[]; notes: string; coordinates: [number, number][] }`
  - `nearestCorridor(p: [number, number]): { cable: CableInfo; distanceM: number } | null` (null until loaded)
  - `cableByName(name: string): CableInfo | null`
- The event feed shows `severity badge · nearest corridor name · distance` per event.

- [ ] **Step 1: Implement the geo copy**

Create `web/src/geo.ts`:

```ts
// web/src/geo.ts — client copy of src/geo/geo.ts distance math (web must not import outside the Vite root).
export type LngLat = [number, number];

const D2R = Math.PI / 180;

function pointToSegmentM(p: LngLat, a: LngLat, b: LngLat): number {
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
  for (let i = 0; i < line.length - 1; i++) min = Math.min(min, pointToSegmentM(p, line[i], line[i + 1]));
  return min;
}
```

- [ ] **Step 2: Implement the cable cache**

Create `web/src/cables.ts`:

```ts
// web/src/cables.ts — client-side corridor metadata + nearest-corridor lookup (spec §3).
import { pointToPolylineM, type LngLat } from "./geo";

export interface CableInfo {
  name: string; region: string; systems: string[]; landing_points: string[]; notes: string;
  coordinates: LngLat[];
}

let cables: CableInfo[] = [];

export async function loadCables(): Promise<void> {
  if (cables.length) return;
  const res = await fetch("/data/cables.json");
  if (!res.ok) throw new Error(`cables.json → ${res.status}`);
  const fc = await res.json();
  cables = fc.features.map((f: any) => ({
    name: f.properties.name,
    region: f.properties.region,
    systems: f.properties.systems ?? [],
    landing_points: f.properties.landing_points ?? [],
    notes: f.properties.notes ?? "",
    coordinates: f.geometry.coordinates,
  }));
}

export function nearestCorridor(p: LngLat): { cable: CableInfo; distanceM: number } | null {
  let best: { cable: CableInfo; distanceM: number } | null = null;
  for (const c of cables) {
    const d = pointToPolylineM(p, c.coordinates);
    if (!best || d < best.distanceM) best = { cable: c, distanceM: d };
  }
  return best;
}

export function cableByName(name: string): CableInfo | null {
  return cables.find((c) => c.name === name) ?? null;
}
```

In `web/src/main.ts`: `import { loadCables } from "./cables";` and inside `map.on("load", ...)` add `void loadCables().catch((err) => console.error("cables load failed:", err));`.

- [ ] **Step 3: Enrich the event feed rows**

In `web/src/panels.ts`, add `import { nearestCorridor } from "./cables";` and replace `renderEvent`:

```ts
function renderEvent(ev: ApiEvent): string {
  const sevClass = ev.severity >= 4 ? "sev-high" : ev.severity === 3 ? "sev-mid" : "sev-low";
  const hit = nearestCorridor([ev.lon, ev.lat]);
  const corridor = hit
    ? `<span class="corridor">${esc(hit.cable.name)} · ${(hit.distanceM / 1000).toFixed(1)} km</span>`
    : "";
  return `<li data-lon="${ev.lon}" data-lat="${ev.lat}" data-mmsi="${ev.mmsi}">
    <span class="sev ${sevClass}">sev ${ev.severity}</span> ${TYPE_LABEL[ev.type] ?? ev.type} — MMSI ${ev.mmsi}${ev.endTs === null ? " · ongoing" : ""}
    ${corridor}<time>${fmtTime(ev.startTs)}</time></li>`;
}
```

Append to `web/style.css`:

```css
#event-list .corridor { display: block; color: var(--accent); font-size: 11px; }
```

- [ ] **Step 4: Verify**

Run: `npm run build:web` → success. Manual: each feed row shows the nearest corridor and distance in km (e.g. "Busan South Corridor (intl. landings) · 3.2 km").

- [ ] **Step 5: Commit**

```bash
git add web/src/geo.ts web/src/cables.ts web/src/panels.ts web/src/main.ts web/style.css
git commit -m "feat: event feed shows nearest cable corridor and distance"
```

---

### Task 14: Dossier enrichment — flag, ship type, dimensions, destination, detector breakdown

**Files:**
- Create: `web/src/mid.ts`, `web/src/shiptype.ts`
- Modify: `web/src/api.ts`, `web/src/panels.ts`
- Test: `test/web-dossier.test.ts`

**Interfaces:**
- Consumes: `/api/vessel/:mmsi` extended payload (Task 5).
- Produces (`web/src/mid.ts`): `flagForMmsi(mmsi: number): { country: string; flag: string } | null` — MID = first 3 digits of the 9-digit MMSI.
- Produces (`web/src/shiptype.ts`): `shipTypeLabel(t: number | null | undefined): string` — never throws, unknown → `"Unknown type"` / `"Other (N)"`.
- Produces (`web/src/api.ts`): `Dossier["vessel"]` gains `region: string | null; shipType: number | null; destination: string | null; dimBow: number | null; dimStern: number | null; dimPort: number | null; dimStarboard: number | null`.

- [ ] **Step 1: Write the failing test**

Create `test/web-dossier.test.ts`:

```ts
// test/web-dossier.test.ts
import { describe, expect, it } from "vitest";
import { flagForMmsi } from "../web/src/mid";
import { shipTypeLabel } from "../web/src/shiptype";

describe("MID flag lookup", () => {
  it("resolves East Asia MIDs", () => {
    expect(flagForMmsi(440123456)!.country).toBe("South Korea");
    expect(flagForMmsi(416123456)!.country).toBe("Taiwan");
    expect(flagForMmsi(431123456)!.country).toBe("Japan");
    expect(flagForMmsi(412123456)!.country).toBe("China");
    expect(flagForMmsi(440123456)!.flag).toBe("🇰🇷");
  });
  it("returns null for unknown MIDs and short MMSIs", () => {
    expect(flagForMmsi(999123456)).toBeNull();
    expect(flagForMmsi(1234)).toBeNull();
  });
});

describe("ship type labels", () => {
  it("decodes common codes", () => {
    expect(shipTypeLabel(30)).toBe("Fishing");
    expect(shipTypeLabel(52)).toBe("Tug");
    expect(shipTypeLabel(65)).toBe("Passenger");
    expect(shipTypeLabel(70)).toBe("Cargo");
    expect(shipTypeLabel(84)).toBe("Tanker");
  });
  it("handles null and oddballs", () => {
    expect(shipTypeLabel(null)).toBe("Unknown type");
    expect(shipTypeLabel(undefined)).toBe("Unknown type");
    expect(shipTypeLabel(99)).toBe("Other (99)");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/web-dossier.test.ts`
Expected: FAIL — modules don't exist.

- [ ] **Step 3: Implement**

Create `web/src/mid.ts`:

```ts
// web/src/mid.ts — MMSI MID prefix → flag. Static subset: East Asia + majors + common flags of convenience.
const MID: Record<number, { country: string; flag: string }> = {
  201: { country: "Albania", flag: "🇦🇱" }, 209: { country: "Cyprus", flag: "🇨🇾" }, 210: { country: "Cyprus", flag: "🇨🇾" },
  211: { country: "Germany", flag: "🇩🇪" }, 219: { country: "Denmark", flag: "🇩🇰" }, 220: { country: "Denmark", flag: "🇩🇰" },
  224: { country: "Spain", flag: "🇪🇸" }, 225: { country: "Spain", flag: "🇪🇸" },
  226: { country: "France", flag: "🇫🇷" }, 227: { country: "France", flag: "🇫🇷" }, 228: { country: "France", flag: "🇫🇷" },
  232: { country: "United Kingdom", flag: "🇬🇧" }, 233: { country: "United Kingdom", flag: "🇬🇧" }, 234: { country: "United Kingdom", flag: "🇬🇧" }, 235: { country: "United Kingdom", flag: "🇬🇧" },
  237: { country: "Greece", flag: "🇬🇷" }, 239: { country: "Greece", flag: "🇬🇷" }, 240: { country: "Greece", flag: "🇬🇷" }, 241: { country: "Greece", flag: "🇬🇷" },
  244: { country: "Netherlands", flag: "🇳🇱" }, 245: { country: "Netherlands", flag: "🇳🇱" }, 246: { country: "Netherlands", flag: "🇳🇱" },
  247: { country: "Italy", flag: "🇮🇹" }, 248: { country: "Malta", flag: "🇲🇹" }, 249: { country: "Malta", flag: "🇲🇹" }, 256: { country: "Malta", flag: "🇲🇹" },
  257: { country: "Norway", flag: "🇳🇴" }, 258: { country: "Norway", flag: "🇳🇴" }, 259: { country: "Norway", flag: "🇳🇴" },
  263: { country: "Portugal", flag: "🇵🇹" }, 271: { country: "Türkiye", flag: "🇹🇷" }, 272: { country: "Ukraine", flag: "🇺🇦" },
  273: { country: "Russia", flag: "🇷🇺" },
  303: { country: "United States", flag: "🇺🇸" }, 304: { country: "Antigua & Barbuda", flag: "🇦🇬" }, 305: { country: "Antigua & Barbuda", flag: "🇦🇬" },
  308: { country: "Bahamas", flag: "🇧🇸" }, 309: { country: "Bahamas", flag: "🇧🇸" }, 311: { country: "Bahamas", flag: "🇧🇸" },
  312: { country: "Belize", flag: "🇧🇿" }, 338: { country: "United States", flag: "🇺🇸" },
  351: { country: "Panama", flag: "🇵🇦" }, 352: { country: "Panama", flag: "🇵🇦" }, 353: { country: "Panama", flag: "🇵🇦" },
  354: { country: "Panama", flag: "🇵🇦" }, 355: { country: "Panama", flag: "🇵🇦" }, 356: { country: "Panama", flag: "🇵🇦" }, 357: { country: "Panama", flag: "🇵🇦" },
  366: { country: "United States", flag: "🇺🇸" }, 367: { country: "United States", flag: "🇺🇸" }, 368: { country: "United States", flag: "🇺🇸" }, 369: { country: "United States", flag: "🇺🇸" },
  370: { country: "Panama", flag: "🇵🇦" }, 371: { country: "Panama", flag: "🇵🇦" }, 372: { country: "Panama", flag: "🇵🇦" }, 373: { country: "Panama", flag: "🇵🇦" },
  375: { country: "St. Vincent & Grenadines", flag: "🇻🇨" }, 376: { country: "St. Vincent & Grenadines", flag: "🇻🇨" }, 377: { country: "St. Vincent & Grenadines", flag: "🇻🇨" },
  412: { country: "China", flag: "🇨🇳" }, 413: { country: "China", flag: "🇨🇳" }, 414: { country: "China", flag: "🇨🇳" },
  416: { country: "Taiwan", flag: "🇹🇼" }, 419: { country: "India", flag: "🇮🇳" }, 422: { country: "Iran", flag: "🇮🇷" },
  431: { country: "Japan", flag: "🇯🇵" }, 432: { country: "Japan", flag: "🇯🇵" },
  440: { country: "South Korea", flag: "🇰🇷" }, 441: { country: "South Korea", flag: "🇰🇷" }, 445: { country: "North Korea", flag: "🇰🇵" },
  457: { country: "Mongolia", flag: "🇲🇳" }, 470: { country: "UAE", flag: "🇦🇪" }, 471: { country: "UAE", flag: "🇦🇪" },
  477: { country: "Hong Kong", flag: "🇭🇰" }, 511: { country: "Palau", flag: "🇵🇼" },
  514: { country: "Cambodia", flag: "🇰🇭" }, 515: { country: "Cambodia", flag: "🇰🇭" }, 518: { country: "Cook Islands", flag: "🇨🇰" },
  525: { country: "Indonesia", flag: "🇮🇩" }, 533: { country: "Malaysia", flag: "🇲🇾" }, 538: { country: "Marshall Islands", flag: "🇲🇭" },
  548: { country: "Philippines", flag: "🇵🇭" },
  563: { country: "Singapore", flag: "🇸🇬" }, 564: { country: "Singapore", flag: "🇸🇬" }, 565: { country: "Singapore", flag: "🇸🇬" }, 566: { country: "Singapore", flag: "🇸🇬" },
  567: { country: "Thailand", flag: "🇹🇭" }, 572: { country: "Tuvalu", flag: "🇹🇻" }, 574: { country: "Vietnam", flag: "🇻🇳" },
  620: { country: "Gabon", flag: "🇬🇦" }, 636: { country: "Liberia", flag: "🇱🇷" },
  667: { country: "Sierra Leone", flag: "🇸🇱" }, 671: { country: "Togo", flag: "🇹🇬" },
  674: { country: "Tanzania", flag: "🇹🇿" }, 677: { country: "Tanzania", flag: "🇹🇿" },
};

export function flagForMmsi(mmsi: number): { country: string; flag: string } | null {
  if (!Number.isInteger(mmsi) || mmsi < 100_000_000) return null; // MID only defined for 9-digit MMSIs
  return MID[Math.floor(mmsi / 1_000_000)] ?? null;
}
```

Create `web/src/shiptype.ts`:

```ts
// web/src/shiptype.ts — AIS ship-and-cargo type code → label (ITU-R M.1371 table).
export function shipTypeLabel(t: number | null | undefined): string {
  if (t == null) return "Unknown type";
  if (t === 30) return "Fishing";
  if (t === 31 || t === 32) return "Towing";
  if (t === 33) return "Dredging";
  if (t === 34) return "Diving ops";
  if (t === 35) return "Military";
  if (t === 36) return "Sailing";
  if (t === 37) return "Pleasure craft";
  if (t >= 40 && t <= 49) return "High-speed craft";
  if (t === 50) return "Pilot vessel";
  if (t === 51) return "Search & rescue";
  if (t === 52) return "Tug";
  if (t === 53) return "Port tender";
  if (t === 55) return "Law enforcement";
  if (t >= 60 && t <= 69) return "Passenger";
  if (t >= 70 && t <= 79) return "Cargo";
  if (t >= 80 && t <= 89) return "Tanker";
  return `Other (${t})`;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/web-dossier.test.ts` → PASS.

- [ ] **Step 5: Render the enriched dossier**

In `web/src/api.ts`, extend `Dossier`'s `vessel` type with:

```ts
    region: string | null; shipType: number | null; destination: string | null;
    dimBow: number | null; dimStern: number | null; dimPort: number | null; dimStarboard: number | null;
```

In `web/src/panels.ts`, add imports:

```ts
import { flagForMmsi } from "./mid";
import { shipTypeLabel } from "./shiptype";
```

and a region-name map + detector-breakdown helper above `selectVessel`:

```ts
const REGION_LABEL: Record<string, string> = { kr: "Korea", tw: "Taiwan", jp: "Japan" };

function detectorBreakdown(events: ApiEvent[]): string {
  const byType = new Map<string, { count: number; last: number }>();
  for (const e of events) {
    const b = byType.get(e.type) ?? { count: 0, last: 0 };
    b.count++; b.last = Math.max(b.last, e.startTs);
    byType.set(e.type, b);
  }
  if (!byType.size) return "<li>No detector hits</li>";
  return [...byType].map(([type, b]) =>
    `<li>${TYPE_LABEL[type] ?? type} — ${b.count}× · last ${fmtTime(b.last)}</li>`).join("");
}
```

Then in `selectVessel`, replace the `body.innerHTML = ...` template with:

```ts
    const flag = flagForMmsi(d.vessel.mmsi);
    const v = d.vessel;
    const size = v.dimBow != null && v.dimStern != null && v.dimPort != null && v.dimStarboard != null
      ? `${v.dimBow + v.dimStern} × ${v.dimPort + v.dimStarboard} m` : "—";
    body.innerHTML = `
      <h2>${flag ? flag.flag + " " : ""}${esc(v.name) || "Unknown vessel"}</h2>
      <div class="score">${v.score}</div>
      <div>MMSI ${v.mmsi} · ${esc(v.callsign) || "no callsign"} · ${v.sog} kn</div>
      <div>${flag ? esc(flag.country) : "Unknown flag"} · ${shipTypeLabel(v.shipType)} · ${REGION_LABEL[v.region ?? ""] ?? "—"}</div>
      <div>Destination: ${esc(v.destination) || "—"} · Size: ${size}</div>
      <div>Last seen ${fmtTime(v.lastTs)}</div>
      <h3>Detector breakdown</h3>
      <ul>${detectorBreakdown(d.events)}</ul>
      <h3>Identity history</h3>
      <ul>${identityEvents.length ? identityEvents.map((e) => `<li>${fmtTime(e.startTs)} — ${esc(JSON.stringify(e.evidence))}</li>`).join("") : "<li>No identity changes observed</li>"}</ul>
      <h3>Event timeline</h3>
      <ul>${d.events.length ? d.events.map((e) => `<li>${fmtTime(e.startTs)} — ${TYPE_LABEL[e.type] ?? e.type} (sev ${e.severity})${e.endTs === null ? " · ongoing" : ""}</li>`).join("") : "<li>No events</li>"}</ul>`;
```

- [ ] **Step 6: Verify + commit**

Run: `npm test` → PASS. `npm run build:web` → success. Manual: dossier shows flag emoji, country, type, region name (or "—"), destination, size, and a per-detector count/last-seen list.

```bash
git add web/src/mid.ts web/src/shiptype.ts web/src/api.ts web/src/panels.ts test/web-dossier.test.ts
git commit -m "feat: enriched dossier — flag, ship type, dimensions, destination, detector breakdown"
```

---

### Task 15: Cable metadata panel

**Files:**
- Create: `web/src/cablepanel.ts`
- Modify: `web/index.html`, `web/style.css`, `web/src/main.ts`

**Interfaces:**
- Consumes: `cableByName`/`pointToPolylineM` (Task 13), `fetchEvents(since, region?, limit?)` (Task 9), the `cable-glow`/`cable-line` map layers (existing `web/src/main.ts`).
- Produces: `initCablePanel(): void` — clicking a corridor opens `#cable-panel` with name, systems, landing points, notes, and the count of anomaly events within `1000 m` (mirror of `CONFIG.corridorBufferM`) over the last 30 days (fetched with `limit=1000`; counts are "up to the API cap").

- [ ] **Step 1: Markup + style**

In `web/index.html`, after the `#dossier` aside add:

```html
  <aside id="cable-panel" hidden>
    <button id="cable-panel-close" aria-label="Close">×</button>
    <div id="cable-panel-body"></div>
  </aside>
```

Append to `web/style.css`:

```css
#cable-panel {
  position: absolute; bottom: 24px; right: 12px; z-index: 21; width: 320px; max-height: 50vh;
  overflow-y: auto; background: var(--panel); backdrop-filter: blur(6px); border-radius: 8px; padding: 16px;
}
#cable-panel-close { position: absolute; top: 8px; right: 10px; background: none; border: 0; color: var(--muted); font-size: 20px; cursor: pointer; }
#cable-panel h2 { font-size: 15px; padding-right: 20px; }
#cable-panel h3 { font-size: 11px; text-transform: uppercase; color: var(--muted); margin: 10px 0 4px; }
#cable-panel ul { list-style: none; font-size: 13px; }
#cable-panel .notes { font-size: 12px; color: var(--muted); }
#cable-panel .buffer-count { font-size: 13px; margin-top: 10px; }
@media (max-width: 720px) { #cable-panel { width: calc(100vw - 24px); } }
```

- [ ] **Step 2: Implement**

Create `web/src/cablepanel.ts`:

```ts
// web/src/cablepanel.ts — corridor metadata + 30-day anomaly count within the corridor buffer (spec §3).
import { fetchEvents } from "./api";
import { cableByName, type CableInfo } from "./cables";
import { pointToPolylineM } from "./geo";
import { map } from "./main";

const BUFFER_M = 1000; // mirror of CONFIG.corridorBufferM
const esc = (s: unknown) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]!));

function render(cable: CableInfo, bufferCount: number | null): void {
  const body = document.getElementById("cable-panel-body")!;
  body.innerHTML = `
    <h2>${esc(cable.name)}</h2>
    <div class="notes">Route approximate · region ${esc(cable.region.toUpperCase())}</div>
    <h3>Cable systems</h3>
    <ul>${cable.systems.map((s) => `<li>${esc(s)}</li>`).join("") || "<li>—</li>"}</ul>
    <h3>Landing points</h3>
    <ul>${cable.landing_points.map((s) => `<li>${esc(s)}</li>`).join("") || "<li>—</li>"}</ul>
    ${cable.notes ? `<h3>Notes</h3><div class="notes">${esc(cable.notes)}</div>` : ""}
    <div class="buffer-count">${bufferCount === null ? "Counting nearby anomalies…"
      : `<b>${bufferCount}</b> anomaly event${bufferCount === 1 ? "" : "s"} within ${BUFFER_M / 1000} km · last 30 days`}</div>`;
  document.getElementById("cable-panel")!.hidden = false;
}

async function open(name: string): Promise<void> {
  const cable = cableByName(name);
  if (!cable) return;
  render(cable, null);
  try {
    // No region filter: a corridor's buffer is fixed geography regardless of the active region.
    const res = await fetchEvents(Date.now() - 30 * 86_400_000, undefined, 1000);
    const n = res.events.filter((e) => pointToPolylineM([e.lon, e.lat], cable.coordinates) <= BUFFER_M).length;
    render(cable, n);
  } catch (err) { console.error("cable panel count failed:", err); }
}

export function initCablePanel(): void {
  document.getElementById("cable-panel-close")!.addEventListener("click", () => {
    document.getElementById("cable-panel")!.hidden = true;
  });
  // The 14px glow layer is the generous hit target; skip when a vessel dot is under the cursor.
  map.on("click", "cable-glow", (e) => {
    if (map.queryRenderedFeatures(e.point, { layers: ["vessels"] }).length) return;
    const name = e.features?.[0]?.properties?.name;
    if (name) void open(String(name));
  });
  map.on("mouseenter", "cable-glow", () => { map.getCanvas().style.cursor = "pointer"; });
  map.on("mouseleave", "cable-glow", () => { map.getCanvas().style.cursor = ""; });
}
```

In `web/src/main.ts`: `import { initCablePanel } from "./cablepanel";` and call `initCablePanel();` inside `map.on("load", ...)` after `initTimeline();`.

- [ ] **Step 3: Verify + commit**

Run: `npm run build:web` → success. `npm test` → PASS. Manual: clicking a corridor opens the panel with systems/landings/notes and an anomaly count; clicking a vessel on top of a corridor opens the dossier, not the cable panel.

```bash
git add web/src/cablepanel.ts web/src/main.ts web/index.html web/style.css
git commit -m "feat: cable metadata panel with 30-day buffer anomaly count"
```

---

### Task 16: First-visit onboarding — intro modal + 5-step tour

**Files:**
- Create: `web/src/onboarding.ts`
- Modify: `web/index.html` (nothing — `#help-btn` exists since Task 9), `web/style.css`, `web/src/main.ts`

**Interfaces:**
- Consumes: `activateRegion` (Task 9), `REGIONS` (Task 9), `#help-btn`, `#region-switcher`, `#legend`, `#event-feed`, `#map` elements.
- Produces: `initOnboarding(): void`. localStorage flag `"cg-intro-seen"` marks a returning visitor. The modal ends with a region choice that calls `activateRegion(id)`, sets the flag, and dismisses. "Take a tour" runs a 5-step spotlight tour (region switcher → legend → live vessels → event feed + timeline → dossier hint). `?` reopens the modal anytime.

- [ ] **Step 1: Implement**

Create `web/src/onboarding.ts`:

```ts
// web/src/onboarding.ts — first-visit intro modal + hand-rolled 5-step spotlight tour (spec §4).
import { REGIONS } from "./regions";
import { activateRegion } from "./switcher";

const SEEN_KEY = "cg-intro-seen";

const TOUR: { sel: string; title: string; text: string }[] = [
  { sel: "#region-switcher", title: "Pick your region",
    text: "Korea, Taiwan and Japan are monitored simultaneously. Switching regions moves the map and filters the stats, timeline and event feed — the choice is remembered for next time." },
  { sel: "#legend", title: "Reading the map",
    text: "Vessel dots are colored by suspicion score. Dashed cyan lines are approximate cable corridors; purple hollow circles are delayed Global Fishing Watch confirmations." },
  { sel: "#map", title: "Live vessels",
    text: "Every dot is a live AIS position near a cable-landing corridor, refreshed every 15 seconds. Grey is normal; amber and red vessels have triggered anomaly detectors." },
  { sel: "#event-feed", title: "Events & timeline",
    text: "Anomalies (loitering, AIS gaps, identity changes, anchor dragging) appear here as they happen. The bar strip shows the last 14 days — click a day to filter." },
  { sel: "#map", title: "Vessel dossier",
    text: "Click any vessel dot to open its dossier: flag, ship type, destination, track history and every detector hit. Try it once the tour ends!" },
];

function el(html: string): HTMLElement {
  const t = document.createElement("template");
  t.innerHTML = html.trim();
  return t.content.firstElementChild as HTMLElement;
}

function showTourStep(i: number): void {
  document.getElementById("tour-overlay")?.remove();
  if (i >= TOUR.length) return;
  const step = TOUR[i];
  const target = document.querySelector(step.sel);
  if (!target) { showTourStep(i + 1); return; }
  const r = target.getBoundingClientRect();
  const overlay = el(`<div id="tour-overlay">
      <div class="tour-spot" style="left:${r.left - 6}px;top:${r.top - 6}px;width:${r.width + 12}px;height:${r.height + 12}px"></div>
      <div class="tour-tip">
        <h3>${step.title}</h3><p>${step.text}</p>
        <div class="tour-nav">
          <span>${i + 1} / ${TOUR.length}</span>
          <button class="tour-skip">Skip</button>
          <button class="tour-next">${i === TOUR.length - 1 ? "Done" : "Next"}</button>
        </div>
      </div>
    </div>`);
  const tip = overlay.querySelector<HTMLElement>(".tour-tip")!;
  // Place the tip below the spotlight when there's room, otherwise above.
  const below = r.bottom + 12 + 160 < innerHeight;
  tip.style.top = below ? `${r.bottom + 12}px` : "auto";
  if (!below) tip.style.bottom = `${innerHeight - r.top + 12}px`;
  tip.style.left = `${Math.max(12, Math.min(r.left, innerWidth - 332))}px`;
  overlay.querySelector(".tour-next")!.addEventListener("click", () => showTourStep(i + 1));
  overlay.querySelector(".tour-skip")!.addEventListener("click", () => overlay.remove());
  document.body.appendChild(overlay);
}

function showIntro(): void {
  document.getElementById("intro-modal")?.remove();
  const modal = el(`<div id="intro-modal">
      <div class="intro-card">
        <h2>East Asia Cable Guard</h2>
        <p>Real-time detection of suspicious ship behavior near submarine cable corridors in Korea, Taiwan and Japan.</p>
        <p><b>Why it matters:</b> East Asia has seen a string of cable-cutting incidents — anchors dragged across corridors,
        ships loitering over landing approaches, vessels going dark. This map watches live AIS traffic for exactly those patterns.</p>
        <p><b>Data:</b> live AIS via AISStream.io; delayed corroboration from Global Fishing Watch; cable routes are approximate public corridors.</p>
        <p><b>Reading the map:</b> grey dots are normal vessels; amber and red have triggered anomaly detectors. Dashed lines are cable corridors.</p>
        <h3>Start in your region</h3>
        <div class="intro-regions">${REGIONS.map((r) => `<button data-region="${r.id}">${r.name}</button>`).join("")}</div>
        <button class="intro-tour">Take a tour</button>
      </div>
    </div>`);
  modal.querySelectorAll<HTMLElement>(".intro-regions button").forEach((b) =>
    b.addEventListener("click", () => {
      localStorage.setItem(SEEN_KEY, "1");
      activateRegion(b.dataset.region!);
      modal.remove();
    }));
  modal.querySelector(".intro-tour")!.addEventListener("click", () => {
    localStorage.setItem(SEEN_KEY, "1");
    modal.remove();
    showTourStep(0);
  });
  document.body.appendChild(modal);
}

export function initOnboarding(): void {
  document.getElementById("help-btn")!.addEventListener("click", showIntro);
  if (!localStorage.getItem(SEEN_KEY)) showIntro();
}
```

- [ ] **Step 2: Style it**

Append to `web/style.css`:

```css
#intro-modal {
  position: fixed; inset: 0; z-index: 50; display: flex; align-items: center; justify-content: center;
  background: #000000a0;
}
.intro-card {
  width: min(480px, calc(100vw - 32px)); max-height: 85vh; overflow-y: auto;
  background: var(--bg); border: 1px solid #ffffff20; border-radius: 12px; padding: 24px;
}
.intro-card h2 { margin-bottom: 10px; }
.intro-card h3 { margin: 14px 0 8px; font-size: 13px; text-transform: uppercase; color: var(--muted); }
.intro-card p { font-size: 14px; line-height: 1.5; margin-bottom: 8px; }
.intro-regions { display: flex; gap: 8px; }
.intro-regions button {
  flex: 1; padding: 10px; border-radius: 8px; border: 1px solid var(--accent);
  background: none; color: var(--accent); font: inherit; font-weight: 600; cursor: pointer;
}
.intro-regions button:hover { background: var(--accent); color: #06121f; }
.intro-card .intro-tour {
  margin-top: 12px; width: 100%; padding: 8px; border-radius: 8px; border: 0;
  background: #ffffff14; color: var(--muted); font: inherit; cursor: pointer;
}
#tour-overlay { position: fixed; inset: 0; z-index: 60; }
#tour-overlay .tour-spot {
  position: fixed; border-radius: 10px; pointer-events: none;
  box-shadow: 0 0 0 9999px #000000a0; border: 2px solid var(--accent);
}
#tour-overlay .tour-tip {
  position: fixed; width: 320px; background: var(--bg); border: 1px solid #ffffff20;
  border-radius: 10px; padding: 14px;
}
#tour-overlay .tour-tip h3 { font-size: 14px; margin-bottom: 6px; }
#tour-overlay .tour-tip p { font-size: 13px; line-height: 1.5; color: var(--text); }
#tour-overlay .tour-nav { display: flex; align-items: center; gap: 8px; margin-top: 10px; font-size: 12px; color: var(--muted); }
#tour-overlay .tour-nav button { margin-left: auto; padding: 5px 14px; border-radius: 6px; border: 0; font: inherit; cursor: pointer; }
#tour-overlay .tour-nav .tour-skip { margin-left: auto; background: none; color: var(--muted); }
#tour-overlay .tour-nav .tour-next { margin-left: 0; background: var(--accent); color: #06121f; font-weight: 600; }
```

- [ ] **Step 3: Wire in**

In `web/src/main.ts`: `import { initOnboarding } from "./onboarding";` and call `initOnboarding();` inside `map.on("load", ...)` after `initCablePanel();`.

- [ ] **Step 4: Verify + commit**

Run: `npm run build:web` → success. `npm test` → PASS. Manual (fresh profile / cleared localStorage): modal appears on load; choosing "Japan" flies there, persists, and never re-shows on reload; `?` reopens it; "Take a tour" walks all 5 spotlights; Skip exits early.

```bash
git add web/src/onboarding.ts web/src/main.ts web/style.css
git commit -m "feat: first-visit intro modal and 5-step guided tour"
```

---

## Deployment notes (post-implementation)

- Apply the migration remotely before deploying the new worker: `npx wrangler d1 migrations apply <DB name from wrangler.jsonc> --remote`.
- Deploy with `npm run deploy` (runs `sync-data` via `build:web`).
- The AISStream subscription only refreshes on reconnect; after deploy, hit `/api/snapshot` once and the DO's watchdog will pick up the new 3-box subscription within its reconnect cycle.

## Self-review checklist (run after writing, already applied)

- Spec coverage: regions/backend §1 → Tasks 1–6; switcher & cables §2 → Tasks 7, 9; UI enrichments §3 → Tasks 10–15; onboarding §4 → Task 16; testing section → per-task tests + Task 8 (`--region` replay).
- Known deliberate deviations: none. NULL-region vessels are excluded from `/api/stats` but shown on the map and in the unfiltered dossier ("—"), per spec §1 error handling.
