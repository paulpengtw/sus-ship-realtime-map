# D1 Free-Tier Write Budget Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Spec:** [2026-09-05 D1 Free-Tier Write Budget](../specs/2026-09-05-d1-free-tier-write-budget-design.md)

**Goal:** Keep the live deployment inside the Cloudflare D1 free tier (100k rows_written/day, 5M rows_read/day) by serving the hot read path from Durable Object memory, writing the `vessels` registry only on change, persisting breadcrumbs only for tracked vessels, and metering every write against a daily budget.

**Architecture:** `TrackerDO` already holds every vessel's state in memory. Three new DO routes (`/snapshot`, `/vessel-counts`, `/vessel/:mmsi`) expose that state through pure read-model functions in `src/snapshot.ts`; the worker proxies to them instead of querying D1. On the write side, a pure policy module `src/persist-policy.ts` decides per flush which vessels and positions earn a D1 row, and `src/write-meter.ts` sums D1's reported `rows_written` per UTC day and pauses optional writes at a soft budget. Migration 0007 recreates `positions` `WITHOUT ROWID` with no secondary index and drops `idx_vessels_last_ts`, so one insert costs one row.

**Tech Stack:** TypeScript, Cloudflare Workers, D1 (SQLite), Durable Objects, Vitest with `@cloudflare/vitest-pool-workers` (`runInDurableObject` from `cloudflare:test`).

## Global Constraints

- Test command: `npm test` (runs `vitest run`). Every task ends with the full suite green.
- Migrations apply from scratch in tests via `test/apply-migrations.ts`; a new migration file is picked up automatically by `readD1Migrations`.
- **No frontend changes.** `web/src/api.ts` response shapes for `/api/snapshot`, `/api/stats`, `/api/vessel/:mmsi` are the contract; preserve every property name and type.
- **Detectors (`src/detectors/*`), fusion (`src/fusion.ts`), scoring, labeling, GFW are untouched.**
- Hot read paths (`/api/snapshot`, vessel counts in `/api/stats`, the dossier's live position) must not issue any D1 query.
- All SQL uses `env.DB.prepare().bind()` / `db.batch([...])`; never string interpolation of values.
- Timestamps are ms epoch integers. Region ids are `"kr" | "tw" | "jp"` (`RegionId` in `src/config.ts`).
- Config values live in `src/config.ts` only; new tunables get a one-line comment citing the spec section.
- Assumption stated for the user: **migration 0007 drops `positions` and its history** (spec §3). If the user objects, replace the `DROP TABLE` in Task 1 with a no-op and keep the old table; every other task is unaffected, but the first daily thinning will cost one day of quota per million existing rows.
- Test file naming follows the repo: `test/<module>.test.ts`; DO-backed tests import `env`, `SELF`, `runInDurableObject` from `cloudflare:test`.
- Commit prefixes: `feat:` new capability, `fix:` behavior correction, `test:` tests only, `docs:` docs only, `chore:` schema/config housekeeping.

---

### Task 1: Schema reset and cheaper `flushWrites`

**Files:**
- Create: `migrations/0007_write_budget.sql`
- Modify: `src/db.ts:16-58` (`flushWrites`), `src/db.ts:36-38` (positions statement)
- Test: `test/db.test.ts`

**Interfaces:**
- Produces: `flushWrites(db: D1Database, p: PendingWrites): Promise<number>` — returns the sum of `meta.rows_written` over every executed statement; `0` when nothing to write. Batches are sent in chunks of `D1_BATCH_CHUNK = 100` statements.
- Produces: `positions` table is `WITHOUT ROWID`, PK `(mmsi, ts)`, no other index; `vessels` keeps only `idx_vessels_region` (`idx_vessels_last_ts` dropped).

- [ ] **Step 1: Write the failing tests**

Append to the `describe("db persistence")` block in `test/db.test.ts`:

```ts
  it("flushWrites returns the number of rows D1 reports written", async () => {
    const n = await flushWrites(env.DB, samplePending());
    expect(n).toBeGreaterThanOrEqual(3); // ≥ 1 vessel + 1 position + 1 event
    expect(await flushWrites(env.DB, newPendingWrites())).toBe(0);
  });

  it("positions use INSERT OR IGNORE — a re-flushed (mmsi, ts) keeps the first row", async () => {
    const p = samplePending();
    await flushWrites(env.DB, p);
    p.positions[0] = { ...p.positions[0], lon: 999 };
    await flushWrites(env.DB, p);
    const row = await env.DB.prepare("SELECT lon FROM positions WHERE mmsi = 412000001").first<any>();
    expect(row.lon).toBeCloseTo(120.2);
  });

  it("flushWrites chunks large batches (more than 100 statements)", async () => {
    const p = newPendingWrites();
    for (let i = 0; i < 250; i++) p.positions.push({ mmsi: 412000001, lon: 120, lat: 22, sog: 1, cog: 0, heading: null, ts: T0 + i * 1000 });
    await flushWrites(env.DB, p);
    const n = await env.DB.prepare("SELECT COUNT(*) AS n FROM positions").first<any>();
    expect(n.n).toBe(250);
  });

  it("migration 0007 leaves positions WITHOUT ROWID with no secondary index, and drops idx_vessels_last_ts", async () => {
    const idx = await env.DB.prepare(
      `SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name IN ('positions', 'vessels') AND name NOT LIKE 'sqlite_autoindex%' ORDER BY name`,
    ).all<any>();
    expect(idx.results.map((r: any) => r.name)).toEqual(["idx_vessels_region"]); // region index (migration 0002) stays: /api/trajectories filters vessels by region
    const tbl = await env.DB.prepare(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'positions'`).first<any>();
    expect(tbl.sql).toMatch(/WITHOUT ROWID/i);
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/db.test.ts`
Expected: 4 new tests FAIL (`flushWrites` returns `undefined`; `lon` is `999`; index list non-empty; `sql` lacks `WITHOUT ROWID`).

- [ ] **Step 3: Write the migration**

Create `migrations/0007_write_budget.sql`:

```sql
-- migrations/0007_write_budget.sql — D1 free-tier write budget (spec 2026-09-05 §3).
-- positions is reset: only tracked vessels' breadcrumbs are persisted from now on, and deleting
-- the old rows one by one would itself cost more rows_written than a day's quota.
-- WITHOUT ROWID makes the (mmsi, ts) primary key the table itself: one insert = one row written.
-- No ts index: every reader filters by mmsi first (PK prefix) or scans a small table daily (thinning).
DROP INDEX IF EXISTS idx_positions_ts;
DROP TABLE positions;
CREATE TABLE positions (
  mmsi INTEGER NOT NULL,
  ts INTEGER NOT NULL,
  lon REAL NOT NULL,
  lat REAL NOT NULL,
  sog REAL NOT NULL,
  cog REAL NOT NULL,
  PRIMARY KEY (mmsi, ts)
) WITHOUT ROWID;
-- vessels.last_ts was only read by the snapshot/stats queries, which now come from DO memory.
DROP INDEX IF EXISTS idx_vessels_last_ts;
```

- [ ] **Step 4: Update `flushWrites`**

In `src/db.ts`, change the positions statement and the tail of `flushWrites`:

```ts
const D1_BATCH_CHUNK = 100; // statements per db.batch(); keeps each request well under D1's size limits

export async function flushWrites(db: D1Database, p: PendingWrites): Promise<number> {
  const stmts: D1PreparedStatement[] = [];
  // ... vessels loop unchanged ...

  for (const pos of p.positions) {
    stmts.push(db.prepare(
      `INSERT OR IGNORE INTO positions (mmsi, ts, lon, lat, sog, cog) VALUES (?1, ?2, ?3, ?4, ?5, ?6)`,
    ).bind(pos.mmsi, pos.ts, pos.lon, pos.lat, pos.sog, pos.cog));
  }

  // ... events and assessments loops unchanged ...

  let rowsWritten = 0;
  for (let i = 0; i < stmts.length; i += D1_BATCH_CHUNK) {
    const results = await db.batch(stmts.slice(i, i + D1_BATCH_CHUNK));
    for (const r of results) rowsWritten += r.meta?.rows_written ?? 0;
  }
  return rowsWritten;
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run test/db.test.ts test/thinning.test.ts test/db-regions.test.ts`
Expected: PASS. (`thinning.test.ts` inserts with `INSERT OR REPLACE` directly; that still works on a `WITHOUT ROWID` table.)

- [ ] **Step 6: Run the whole suite**

Run: `npm test`
Expected: PASS. If `test/api.test.ts` fails on `INSERT INTO positions VALUES (...)`, the column order in the new table is wrong — it must stay `mmsi, ts, lon, lat, sog, cog`.

- [ ] **Step 7: Commit**

```bash
git add migrations/0007_write_budget.sql src/db.ts test/db.test.ts
git commit -m "chore(db): reset positions WITHOUT ROWID, drop hot indexes, INSERT OR IGNORE; flushWrites reports rows_written"
```

---

### Task 2: Pure snapshot read models

**Files:**
- Create: `src/snapshot.ts`
- Test: `test/snapshot.test.ts`

**Interfaces:**
- Produces:
  - `buildSnapshot(states: Iterable<VesselState>, now: number, region?: string, windowMs?: number): SnapshotResponse` — `region` `""` means all regions; default `windowMs` is `CONFIG.snapshotWindowMs`. Output is structurally identical to today's `/api/snapshot` body.
  - `vesselCounts(states: Iterable<VesselState>, now: number, windowMs?: number): Record<RegionId, number>`
  - `liveVessel(s: VesselState | undefined): LiveVessel | null` — the dossier's `vessel` block minus `score`.
  - `openAssessments(s: VesselState): SnapshotAssessment[]` — open ones, sorted by confidence desc.
  - Types `SnapshotResponse`, `SnapshotFeature`, `SnapshotAssessment`, `LiveVessel`.

- [ ] **Step 1: Write the failing tests**

Create `test/snapshot.test.ts`:

```ts
// test/snapshot.test.ts — read models built from in-memory VesselState (spec 2026-09-05 §3).
import { describe, expect, it } from "vitest";
import { buildSnapshot, liveVessel, vesselCounts } from "../src/snapshot";
import { newVesselState, type ThreatAssessment, type VesselState } from "../src/types";

const NOW = 1_800_000_000_000;
const H = 3_600_000;

function vessel(mmsi: number, lon: number, lat: number, ts: number, extra: Partial<VesselState> = {}): VesselState {
  const s = newVesselState(mmsi, ts);
  s.ring.push({ mmsi, lon, lat, sog: 0.5, cog: 90, heading: null, ts });
  s.lastSeen = ts;
  return Object.assign(s, extra);
}
function open(mmsi: number, category: ThreatAssessment["category"], confidence: number, ts: number): ThreatAssessment {
  return { id: `${category}-${mmsi}-${ts}`, mmsi, category, status: "open", confidence, openedTs: ts, updatedTs: ts, closedTs: null, region: "tw", narrative: "x", evidence: [], lastLon: 120.2, lastLat: 22.0 };
}

describe("buildSnapshot", () => {
  it("emits GeoJSON for vessels inside the window and drops older ones", () => {
    const fresh = vessel(1, 120.2, 22.0, NOW - 10 * 60_000);
    const stale = vessel(2, 121.0, 23.0, NOW - 2 * H);
    const snap = buildSnapshot([fresh, stale], NOW, "", H);
    expect(snap.generatedAt).toBe(NOW);
    expect(snap.vessels.type).toBe("FeatureCollection");
    expect(snap.vessels.features.map((f) => f.properties.mmsi)).toEqual([1]);
    expect(snap.vessels.features[0].geometry).toEqual({ type: "Point", coordinates: [120.2, 22.0] });
    expect(snap.vessels.features[0].properties).toMatchObject({ sog: 0.5, cog: 90, lastTs: NOW - 10 * 60_000 });
    expect(snap.newestTs).toBe(NOW - 10 * 60_000);
  });

  it("skips vessels with no position fix and returns newestTs null when empty", () => {
    const s = newVesselState(3, NOW);
    s.name = "STATIC ONLY";
    const snap = buildSnapshot([s], NOW, "", H);
    expect(snap.vessels.features).toEqual([]);
    expect(snap.newestTs).toBeNull();
  });

  it("filters by region when given, all regions when empty string", () => {
    const kr = vessel(1, 129.3, 34.7, NOW, { region: "kr", shipType: 70 });
    const tw = vessel(2, 121.5, 24.9, NOW, { region: "tw" });
    expect(buildSnapshot([kr, tw], NOW, "kr", H).vessels.features).toHaveLength(1);
    expect(buildSnapshot([kr, tw], NOW, "", H).vessels.features).toHaveLength(2);
    expect(buildSnapshot([kr, tw], NOW, "kr", H).vessels.features[0].properties).toMatchObject({ mmsi: 1, region: "kr", shipType: 70 });
  });

  it("lists open assessments by confidence, sorts vessels by maxConfidence, keeps the legacy score", () => {
    const quiet = vessel(1, 120, 22, NOW);
    const sus = vessel(2, 120, 22, NOW);
    sus.assessments.dark_activity = open(2, "dark_activity", 0.3, NOW);
    sus.assessments.cable_interference = open(2, "cable_interference", 0.62, NOW);
    sus.assessments.identity_deception = { ...open(2, "identity_deception", 0.9, NOW), status: "closed", closedTs: NOW };
    const [first, second] = buildSnapshot([quiet, sus], NOW, "", H).vessels.features;
    expect(first.properties.mmsi).toBe(2);
    expect(first.properties.assessments).toEqual([
      { category: "cable_interference", confidence: 0.62 },
      { category: "dark_activity", confidence: 0.3 },
    ]);
    expect(first.properties.topCategory).toBe("cable_interference");
    expect(first.properties.maxConfidence).toBeCloseTo(0.62);
    expect(first.properties.score).toBeCloseTo(3.1);
    expect(second.properties).toMatchObject({ mmsi: 1, assessments: [], topCategory: null, maxConfidence: 0, score: 0 });
  });
});

describe("vesselCounts", () => {
  it("counts in-window vessels per region; ignores null regions and stale vessels", () => {
    const counts = vesselCounts([
      vessel(1, 129.3, 34.7, NOW, { region: "kr" }),
      vessel(2, 129.3, 34.7, NOW - 2 * H, { region: "kr" }),
      vessel(3, 0, 0, NOW, { region: null }),
    ], NOW, H);
    expect(counts).toEqual({ kr: 1, tw: 0, jp: 0 });
  });
});

describe("liveVessel", () => {
  it("returns the dossier vessel block from the last fix; null without a fix", () => {
    const s = vessel(440000001, 129.3, 34.7, NOW, {
      name: "KR SHIP", callsign: "DS1", region: "kr", shipType: 70, destination: "BUSAN",
      dimBow: 100, dimStern: 20, dimPort: 10, dimStarboard: 12,
    });
    expect(liveVessel(s)).toEqual({
      mmsi: 440000001, name: "KR SHIP", callsign: "DS1", lon: 129.3, lat: 34.7, sog: 0.5, cog: 90, lastTs: NOW,
      region: "kr", shipType: 70, destination: "BUSAN", dimBow: 100, dimStern: 20, dimPort: 10, dimStarboard: 12,
    });
    expect(liveVessel(newVesselState(1, NOW))).toBeNull();
    expect(liveVessel(undefined)).toBeNull();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/snapshot.test.ts`
Expected: FAIL — `Cannot find module '../src/snapshot'`.

- [ ] **Step 3: Implement `src/snapshot.ts`**

```ts
// src/snapshot.ts — live-map read models built from TrackerDO in-memory state (spec 2026-09-05 §3).
// Pure functions: no D1, no DO. TrackerDO wraps them in routes; the worker proxies to those routes.
import { CONFIG, type RegionId } from "./config";
import type { VesselState } from "./types";

export interface SnapshotAssessment { category: string; confidence: number }

export interface SnapshotFeature {
  type: "Feature";
  geometry: { type: "Point"; coordinates: [number, number] };
  properties: {
    mmsi: number; name: string | null; sog: number; cog: number; lastTs: number;
    region: string | null; shipType: number | null;
    assessments: SnapshotAssessment[]; topCategory: string | null; maxConfidence: number;
    score: number; // legacy, remove next release
  };
}

export interface SnapshotResponse {
  generatedAt: number;
  newestTs: number | null;
  vessels: { type: "FeatureCollection"; features: SnapshotFeature[] };
}

export interface LiveVessel {
  mmsi: number; name: string | null; callsign: string | null;
  lon: number; lat: number; sog: number; cog: number; lastTs: number;
  region: string | null; shipType: number | null; destination: string | null;
  dimBow: number | null; dimStern: number | null; dimPort: number | null; dimStarboard: number | null;
}

export function openAssessments(s: VesselState): SnapshotAssessment[] {
  const out: SnapshotAssessment[] = [];
  for (const a of Object.values(s.assessments)) {
    if (a && a.status === "open") out.push({ category: a.category, confidence: a.confidence });
  }
  return out.sort((a, b) => b.confidence - a.confidence);
}

function inWindow(s: VesselState, now: number, windowMs: number, region: string): boolean {
  return s.ring.length > 0 && s.lastSeen >= now - windowMs && (region === "" || s.region === region);
}

export function buildSnapshot(
  states: Iterable<VesselState>, now: number, region = "", windowMs: number = CONFIG.snapshotWindowMs,
): SnapshotResponse {
  const features: SnapshotFeature[] = [];
  let newestTs = 0;
  for (const s of states) {
    if (!inWindow(s, now, windowMs, region)) continue;
    const lp = s.ring[s.ring.length - 1];
    const assessments = openAssessments(s);
    const maxConfidence = assessments[0]?.confidence ?? 0;
    newestTs = Math.max(newestTs, s.lastSeen);
    features.push({
      type: "Feature",
      geometry: { type: "Point", coordinates: [lp.lon, lp.lat] },
      properties: {
        mmsi: s.mmsi, name: s.name, sog: lp.sog, cog: lp.cog, lastTs: s.lastSeen,
        region: s.region ?? null, shipType: s.shipType ?? null,
        assessments, topCategory: assessments[0]?.category ?? null, maxConfidence,
        score: Math.round(maxConfidence * 5 * 10) / 10,
      },
    });
  }
  features.sort((a, b) => b.properties.maxConfidence - a.properties.maxConfidence);
  return { generatedAt: now, newestTs: newestTs || null, vessels: { type: "FeatureCollection", features } };
}

export function vesselCounts(
  states: Iterable<VesselState>, now: number, windowMs: number = CONFIG.snapshotWindowMs,
): Record<RegionId, number> {
  const counts = Object.fromEntries(CONFIG.regions.map((r) => [r.id, 0])) as Record<RegionId, number>;
  for (const s of states) {
    if (s.region !== null && inWindow(s, now, windowMs, "")) counts[s.region]++;
  }
  return counts;
}

export function liveVessel(s: VesselState | undefined): LiveVessel | null {
  if (!s || s.ring.length === 0) return null;
  const lp = s.ring[s.ring.length - 1];
  return {
    mmsi: s.mmsi, name: s.name, callsign: s.callsign,
    lon: lp.lon, lat: lp.lat, sog: lp.sog, cog: lp.cog, lastTs: s.lastSeen,
    region: s.region ?? null, shipType: s.shipType ?? null, destination: s.destination ?? null,
    dimBow: s.dimBow ?? null, dimStern: s.dimStern ?? null, dimPort: s.dimPort ?? null, dimStarboard: s.dimStarboard ?? null,
  };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run test/snapshot.test.ts`
Expected: PASS (7 tests).

- [ ] **Step 5: Commit**

```bash
git add src/snapshot.ts test/snapshot.test.ts
git commit -m "feat(snapshot): pure read models (snapshot, vessel counts, live vessel) from in-memory state"
```

---

### Task 3: Serve snapshot, vessel counts, live dossier position and health from the DO

**Files:**
- Modify: `src/do/tracker.ts:11-70` (fields, `fetch`, split `ensureRunning` into `hydrate` + connect)
- Modify: `src/worker.ts:20-24` (`ensureTracker`), `:66-98` (`/api/snapshot`), `:161-192` (`/api/stats`), `:387-410` (dossier); add `/api/health`
- Create: `test/helpers/tracker.ts`
- Modify: `test/api.test.ts`, `test/api-regions.test.ts`, `test/stats.test.ts`
- Test: `test/api.test.ts`, `test/api-regions.test.ts`, `test/stats.test.ts`, `test/api-health.test.ts` (new)

**Interfaces:**
- Consumes: `buildSnapshot`, `vesselCounts`, `liveVessel`, `LiveVessel` from Task 2.
- Produces (DO, all `GET`, all side-effect-free except `/ensure`):
  - `GET https://do/ensure` — unchanged behavior (hydrate + alarm + connect), returns `status()`.
  - `GET https://do/status` — returns `{ connected: boolean; vessels: number; lastWsMessageAt: number }` without connecting. Task 6 adds `writes`.
  - `GET https://do/snapshot?region=<""|kr|tw|jp>` — `SnapshotResponse` JSON.
  - `GET https://do/vessel-counts` — `Record<RegionId, number>`.
  - `GET https://do/vessel/<mmsi>` — `LiveVessel` JSON or 404.
- Produces (worker): `GET /api/health` → `{ generatedAt, ...status }`.
- Produces (DO class surface used by tests): public `tracker: Tracker`, public `hydrated: boolean`, public `status(): {...}`, public `resetForTests(): void`.
- Produces (test helper `test/helpers/tracker.ts`): `trackerStub()`, `seedTracker(states: VesselState[])`, `vesselAt(mmsi, lon, lat, ts, extra?)`.

- [ ] **Step 1: Write the test helper**

Create `test/helpers/tracker.ts`:

```ts
// test/helpers/tracker.ts — seed TrackerDO in-memory state for API tests.
// seedTracker resets the singleton instance and marks it hydrated so DO routes never read D1
// for vessels. Correct whether or not the pool reuses the DO instance between tests.
import { env, runInDurableObject } from "cloudflare:test";
import type { TrackerDO } from "../../src/do/tracker";
import { newVesselState, type VesselState } from "../../src/types";

export function trackerStub(): DurableObjectStub<TrackerDO> {
  return env.TRACKER.get(env.TRACKER.idFromName("singleton")) as DurableObjectStub<TrackerDO>;
}

export async function seedTracker(states: VesselState[]): Promise<void> {
  await runInDurableObject(trackerStub(), (inst: TrackerDO) => {
    inst.resetForTests();
    for (const s of states) inst.tracker.states.set(s.mmsi, s);
  });
}

export function vesselAt(mmsi: number, lon: number, lat: number, ts: number, extra: Partial<VesselState> = {}): VesselState {
  const s = newVesselState(mmsi, ts);
  s.ring.push({ mmsi, lon, lat, sog: 0.5, cog: 90, heading: null, ts });
  s.lastSeen = ts;
  return Object.assign(s, extra);
}
```

- [ ] **Step 2: Rewrite the affected API tests to seed the DO**

`test/api.test.ts` — add imports and extend `seed()`; the existing assertions stay unchanged:

```ts
import type { ThreatAssessment } from "../src/types";
import { seedTracker, vesselAt } from "./helpers/tracker";

const OPEN_CABLE: ThreatAssessment = {
  id: "cable_interference-412000001-1", mmsi: 412000001, category: "cable_interference", status: "open",
  confidence: 0.62, openedTs: T0, updatedTs: T0, closedTs: null, region: "tw",
  narrative: "Loitered 3.0 h over C1 corridor.", evidence: [], lastLon: 120.2, lastLat: 22.0,
};

async function seed() {
  await env.DB.batch([ /* existing statements unchanged */ ]);
  await seedTracker([
    vesselAt(412000001, 120.2, 22.0, T0, { name: "TEST SHIP", callsign: "BXYZ1", region: "tw", assessments: { cable_interference: OPEN_CABLE } }),
    vesselAt(412000002, 121.0, 23.0, T0 - 2 * 3_600_000, { name: "OLD SHIP" }),
  ]);
}
```

`test/api-regions.test.ts` — extend `seed()` after the D1 batch:

```ts
import { seedTracker, vesselAt } from "./helpers/tracker";
// inside seed(), after the batch:
  await seedTracker([
    vesselAt(440000001, 129.3, 34.7, T0, { name: "KR SHIP", callsign: "DS1", region: "kr", shipType: 70, destination: "BUSAN", dimBow: 100, dimStern: 20, dimPort: 10, dimStarboard: 12 }),
    vesselAt(416000001, 121.5, 24.9, T0, { name: "TW SHIP", callsign: "BV1", region: "tw" }),
  ]);
```

`test/stats.test.ts` — inside `beforeEach`, after the D1 batch (the two `INSERT INTO vessels` statements may stay; they are now ignored by `/api/stats`):

```ts
import { seedTracker, vesselAt } from "./helpers/tracker";
// after the batch:
    await seedTracker([
      vesselAt(440000001, 129.3, 34.7, T0, { name: "KR", region: "kr" }),
      vesselAt(440000002, 129.3, 34.7, T0 - 2 * 3_600_000, { name: "KR OLD", region: "kr" }),
    ]);
```

Create `test/api-health.test.ts`:

```ts
// test/api-health.test.ts — /api/health proxies the DO's side-effect-free status.
import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { seedTracker, vesselAt } from "./helpers/tracker";

describe("/api/health", () => {
  it("reports connection state and in-memory vessel count", async () => {
    await seedTracker([vesselAt(1, 120, 22, Date.now()), vesselAt(2, 121, 23, Date.now())]);
    const res = await SELF.fetch("https://x/api/health");
    expect(res.status).toBe(200);
    const body = await res.json<any>();
    expect(body.generatedAt).toBeGreaterThan(0);
    expect(body.connected).toBe(false);
    expect(body.vessels).toBe(2);
  });
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `npx vitest run test/api.test.ts test/api-regions.test.ts test/stats.test.ts test/api-health.test.ts`
Expected: FAIL — `inst.resetForTests is not a function`; `/api/health` returns 404.

- [ ] **Step 4: Refactor `TrackerDO`: public surface, `hydrate()`, read routes**

In `src/do/tracker.ts`:

```ts
import { buildSnapshot, liveVessel, vesselCounts } from "../snapshot";
// ...
export class TrackerDO implements DurableObject {
  // Public for tests (cloudflare:test runInDurableObject); production code only touches them from inside this class.
  readonly tracker = new Tracker(new GeoContext());
  hydrated = false;
  private pending: PendingWrites = newPendingWrites();
  private ws: WebSocket | null = null;
  private lastWsMessageAt = 0;
  private backoffMs: number = CONFIG.backoffMinMs;
  private lastPersisted = new Map<number, AisPosition>();
  private lastPruneAt = 0;
  private parseFailures = 0;

  constructor(private ctx: DurableObjectState, private env: Env) {}

  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const now = Date.now();
    if (url.pathname === "/ensure") { await this.ensureRunning(); return Response.json(this.status()); }
    if (url.pathname === "/status") return Response.json(this.status());
    if (url.pathname === "/snapshot") {
      await this.hydrate();
      return Response.json(buildSnapshot(this.tracker.states.values(), now, url.searchParams.get("region") ?? ""));
    }
    if (url.pathname === "/vessel-counts") {
      await this.hydrate();
      return Response.json(vesselCounts(this.tracker.states.values(), now));
    }
    const vesselMatch = /^\/vessel\/(\d{1,9})$/.exec(url.pathname);
    if (vesselMatch) {
      await this.hydrate();
      const v = liveVessel(this.tracker.states.get(Number(vesselMatch[1])));
      return v ? Response.json(v) : new Response("unknown vessel", { status: 404 });
    }
    return new Response("not found", { status: 404 });
  }

  status() {
    return {
      connected: this.ws !== null && this.ws.readyState === WebSocket.READY_STATE_OPEN,
      vessels: this.tracker.states.size,
      lastWsMessageAt: this.lastWsMessageAt,
    };
  }

  /** Test hook: forget all in-memory state and skip D1 hydration. */
  resetForTests(): void {
    this.hydrated = true;
    this.tracker.states.clear();
    this.tracker.drainChangedAssessments();
    this.pending = newPendingWrites();
    this.lastPersisted.clear();
    this.lastPruneAt = 0;
  }

  /** Load recent vessels + open assessments from D1 once per instance lifetime. */
  private async hydrate(): Promise<void> {
    if (this.hydrated) return;
    this.hydrated = true;
    // ← move the existing body of the `if (!this.hydrated) { ... }` block from ensureRunning here, verbatim
  }

  private async ensureRunning(): Promise<void> {
    await this.hydrate();
    if ((await this.ctx.storage.getAlarm()) === null) {
      await this.ctx.storage.setAlarm(Date.now() + CONFIG.alarmIntervalMs);
    }
    this.connectStream();
  }
```

Keep the existing `/ensure` response keys (`connected`, `vessels`, `lastWsMessageAt`) — `status()` reproduces them.

- [ ] **Step 5: Proxy from the worker**

In `src/worker.ts`:

```ts
import type { LiveVessel } from "./snapshot";

function trackerFetch(env: Env, path: string): Promise<Response> {
  return env.TRACKER.get(env.TRACKER.idFromName("singleton")).fetch(`https://do${path}`);
}

function ensureTracker(env: Env, ctx: ExecutionContext): void {
  if (env.TEST_MIGRATIONS) return;
  ctx.waitUntil(trackerFetch(env, "/ensure").catch((e) => console.error("ensure failed:", e)));
}
```

Replace the `/api/snapshot` handler body (keep the `regionParam` validation):

```ts
    if (url.pathname === "/api/snapshot") {
      const region = regionParam(url);
      if (region === null) return json({ error: "bad region" }, 400);
      const res = await trackerFetch(env, `/snapshot?region=${region}`);
      if (!res.ok) return json({ error: "tracker unavailable" }, 503);
      return new Response(res.body, { status: 200, headers: CORS });
    }
```

Add `/api/health` next to it:

```ts
    if (url.pathname === "/api/health") {
      const res = await trackerFetch(env, "/status");
      if (!res.ok) return json({ error: "tracker unavailable" }, 503);
      return json({ generatedAt: now, ...(await res.json<Record<string, unknown>>()) });
    }
```

In `/api/stats`, drop the `vessels` count query from the D1 batch and take counts from the DO:

```ts
      const countsRes = await trackerFetch(env, "/vessel-counts");
      const counts = countsRes.ok ? await countsRes.json<Record<string, number>>() : {};
      const [ac, e24, hist] = await env.DB.batch([
        /* the three remaining statements, unchanged */
      ]);
      // ...
      for (const r of CONFIG.regions) {
        regions[r.id] = { vessels: counts[r.id] ?? 0, activeAlerts: 0, events24h: 0 };
        // histogram init unchanged
      }
      // delete the `for (const row of vc.results ...)` loop; keep the ac / e24 / hist loops
```

In the dossier handler (`/api/vessel/:mmsi`), prefer live state and fall back to the D1 row:

```ts
      const [row, liveRes] = await Promise.all([
        env.DB.prepare(`SELECT * FROM vessels WHERE mmsi = ?1`).bind(mmsi).first<any>(),
        trackerFetch(env, `/vessel/${mmsi}`),
      ]);
      const live: LiveVessel | null = liveRes.ok ? await liveRes.json<LiveVessel>() : null;
      if (!row && !live) return json({ error: "unknown vessel" }, 404);
      const base: LiveVessel = live ?? {
        mmsi: row.mmsi, name: row.name, callsign: row.callsign,
        lon: row.last_lon, lat: row.last_lat, sog: row.last_sog, cog: row.last_cog, lastTs: row.last_ts,
        region: row.region ?? null, shipType: row.ship_type ?? null, destination: row.destination ?? null,
        dimBow: row.dim_bow ?? null, dimStern: row.dim_stern ?? null, dimPort: row.dim_port ?? null, dimStarboard: row.dim_starboard ?? null,
      };
      // events / assessments queries unchanged
      return json({
        generatedAt: now,
        vessel: { ...base, score: Math.round(maxConfidence * 5 * 10) / 10 },
        events: events.results.map(rowToEvent),
        assessments,
      });
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npx vitest run test/api.test.ts test/api-regions.test.ts test/stats.test.ts test/api-health.test.ts test/api-vessel-track-range.test.ts`
Expected: PASS. If `/api/snapshot` returns 2 features when 1 is expected, `seedTracker` did not reset — check `resetForTests()` clears `tracker.states`.

- [ ] **Step 7: Confirm no D1 read remains on the hot path**

Run: `grep -n "FROM vessels" src/worker.ts`
Expected: exactly two hits — the `/api/vessel/:mmsi/track` existence check and the dossier fallback. None inside `/api/snapshot` or `/api/stats`.

- [ ] **Step 8: Run the whole suite and commit**

Run: `npm test`
Expected: PASS.

```bash
git add src/do/tracker.ts src/worker.ts test/helpers/tracker.ts test/api.test.ts test/api-regions.test.ts test/stats.test.ts test/api-health.test.ts
git commit -m "feat(api): serve snapshot, vessel counts and live dossier position from TrackerDO memory; add /api/health"
```

---

### Task 4: Persistence policy (pure) and config

**Files:**
- Modify: `src/config.ts:56-57` (`persistMinIntervalMs`, `persistMinMoveM`) and add new keys after them
- Create: `src/persist-policy.ts`
- Test: `test/persist-policy.test.ts`

**Interfaces:**
- Produces config keys (exact names, used in Task 6):
  `persistMinIntervalMs = 600_000`, `persistMinMoveM = 2000`, `trackPersistMinScore = 0.4`, `trackBackfillWindowMs = 86_400_000`, `trackBackfillBucketMs = 600_000`, `vesselRefreshMs = 21_600_000`, `pruneIntervalMs = 86_400_000`, `d1DailyWriteBudget = 80_000`, `pendingPositionsCap = 2000`.
- Produces from `src/persist-policy.ts`:
  - `interface PendingQueue { positions: AisPosition[]; events: Map<string, AnomalyEvent>; dirtyVessels: Set<number>; assessments: Map<string, ThreatAssessment> }` and `newPendingQueue(): PendingQueue`
  - `interface VesselWriteRecord { ts: number; fp: string }`
  - `vesselFingerprint(s: VesselState): string`
  - `type VesselWriteKind = "essential" | "optional" | "skip"`
  - `vesselWriteKind(s: VesselState, prev: VesselWriteRecord | undefined, now: number, touched: boolean, cfg?: Config): VesselWriteKind`
  - `isTracked(s: VesselState, cfg?: Config): boolean`
  - `shouldPersistPosition(pos: AisPosition, prev: AisPosition | undefined, cfg?: Config): boolean`
  - `ringBackfill(s: VesselState, now: number, cfg?: Config): AisPosition[]`
  - `truncatePositions(positions: AisPosition[], cap: number): AisPosition[]`

- [ ] **Step 1: Write the failing tests**

Create `test/persist-policy.test.ts`:

```ts
// test/persist-policy.test.ts — which state earns a D1 write (spec 2026-09-05 §3–4).
import { describe, expect, it } from "vitest";
import { CONFIG } from "../src/config";
import { isTracked, ringBackfill, shouldPersistPosition, truncatePositions, vesselFingerprint, vesselWriteKind } from "../src/persist-policy";
import { newVesselState, type AisPosition, type VesselState } from "../src/types";

const NOW = 1_800_000_000_000; // aligned to the 10-min bucket grid
const MIN = 60_000, H = 3_600_000;
const fix = (ts: number, lon = 120, lat = 22): AisPosition => ({ mmsi: 1, lon, lat, sog: 5, cog: 0, heading: null, ts });
function vessel(ts = NOW): VesselState {
  const s = newVesselState(1, ts);
  s.ring.push(fix(ts));
  s.lastSeen = ts;
  return s;
}

describe("vesselWriteKind", () => {
  it("first sight is essential", () => {
    expect(vesselWriteKind(vessel(), undefined, NOW, false)).toBe("essential");
  });
  it("skips a vessel that has no position fix yet", () => {
    expect(vesselWriteKind(newVesselState(1, NOW), undefined, NOW, false)).toBe("skip");
  });
  it("unchanged and fresh is skip; identity change is essential", () => {
    const s = vessel();
    const prev = { ts: NOW - MIN, fp: vesselFingerprint(s) };
    expect(vesselWriteKind(s, prev, NOW, false)).toBe("skip");
    s.name = "RENAMED";
    expect(vesselWriteKind(s, prev, NOW, false)).toBe("essential");
  });
  it("a vessel touched by an event or assessment this flush is essential", () => {
    const s = vessel();
    expect(vesselWriteKind(s, { ts: NOW - MIN, fp: vesselFingerprint(s) }, NOW, true)).toBe("essential");
  });
  it("a row older than vesselRefreshMs is an optional refresh", () => {
    const s = vessel();
    const fp = vesselFingerprint(s);
    expect(vesselWriteKind(s, { ts: NOW - CONFIG.vesselRefreshMs + 1, fp }, NOW, false)).toBe("skip");
    expect(vesselWriteKind(s, { ts: NOW - CONFIG.vesselRefreshMs, fp }, NOW, false)).toBe("optional");
  });
});

describe("isTracked", () => {
  it("is false for a quiet vessel", () => expect(isTracked(vessel())).toBe(false));
  it("is true with an open assessment, false once it closes", () => {
    const s = vessel();
    s.assessments.dark_activity = {
      id: "a", mmsi: 1, category: "dark_activity", status: "open", confidence: 0.6,
      openedTs: NOW, updatedTs: NOW, closedTs: null, region: "tw", narrative: "", evidence: [], lastLon: 0, lastLat: 0,
    };
    expect(isTracked(s)).toBe(true);
    s.assessments.dark_activity.status = "closed";
    expect(isTracked(s)).toBe(false);
  });
  it("is true once any category score reaches trackPersistMinScore", () => {
    const s = vessel();
    s.categories.cable_interference.score = CONFIG.trackPersistMinScore - 0.01;
    expect(isTracked(s)).toBe(false);
    s.categories.cable_interference.score = CONFIG.trackPersistMinScore;
    expect(isTracked(s)).toBe(true);
  });
});

describe("shouldPersistPosition", () => {
  it("always persists the first fix", () => expect(shouldPersistPosition(fix(NOW), undefined)).toBe(true));
  it("holds a slow vessel until persistMinIntervalMs", () => {
    expect(shouldPersistPosition(fix(NOW + CONFIG.persistMinIntervalMs - 1), fix(NOW))).toBe(false);
    expect(shouldPersistPosition(fix(NOW + CONFIG.persistMinIntervalMs), fix(NOW))).toBe(true);
  });
  it("persists early once the vessel moved persistMinMoveM", () => {
    expect(shouldPersistPosition(fix(NOW + MIN, 120, 22.02), fix(NOW, 120, 22))).toBe(true);   // ≈ 2.2 km
    expect(shouldPersistPosition(fix(NOW + MIN, 120, 22.005), fix(NOW, 120, 22))).toBe(false); // ≈ 0.56 km
  });
});

describe("ringBackfill", () => {
  it("keeps one point per bucket inside the backfill window, oldest first", () => {
    const s = newVesselState(1, NOW);
    const b = CONFIG.trackBackfillBucketMs;
    s.ring.push(fix(NOW - 2 * 24 * H), fix(NOW - 3 * b), fix(NOW - 3 * b + 1000), fix(NOW - 2 * b), fix(NOW));
    expect(ringBackfill(s, NOW).map((p) => p.ts)).toEqual([NOW - 3 * b, NOW - 2 * b, NOW]);
  });
});

describe("truncatePositions", () => {
  it("keeps the newest `cap` entries and returns the same array when under cap", () => {
    const ps = [fix(1), fix(2), fix(3)];
    expect(truncatePositions(ps, 2).map((p) => p.ts)).toEqual([2, 3]);
    expect(truncatePositions(ps, 5)).toBe(ps);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/persist-policy.test.ts`
Expected: FAIL — `Cannot find module '../src/persist-policy'`.

- [ ] **Step 3: Update `src/config.ts`**

Replace the two existing lines and add the new keys directly below them:

```ts
  // Write budget (spec 2026-09-05 §3–4). Breadcrumbs persist for tracked vessels only.
  persistMinIntervalMs: 10 * 60 * 1000,
  persistMinMoveM: 2000,
  trackPersistMinScore: 0.4,              // category score (= confidence 0.2, the close threshold) at/above which breadcrumbs persist
  trackBackfillWindowMs: 24 * 3_600_000,  // ring backfill span when a vessel becomes tracked
  trackBackfillBucketMs: 10 * 60_000,     // one backfilled point per bucket
  vesselRefreshMs: 6 * 3_600_000,         // max age of a vessels row before an optional refresh write; hydration window derives from it
  pruneIntervalMs: 86_400_000,            // thinPositions cadence (was hourly)
  d1DailyWriteBudget: 80_000,             // soft cap on rows_written per UTC day; optional writes pause above it
  pendingPositionsCap: 2000,              // positions kept for retry after a failed flush
```

- [ ] **Step 4: Implement `src/persist-policy.ts`**

```ts
// src/persist-policy.ts — which in-memory state earns a D1 write (spec 2026-09-05 §3–4). Pure functions.
import { CONFIG, type Config } from "./config";
import { haversineM } from "./geo/geo";
import { THREAT_CATEGORIES, type AisPosition, type AnomalyEvent, type ThreatAssessment, type VesselState } from "./types";

/** What TrackerDO accumulates between flushes. Vessels are tracked by mmsi; their state is read at flush time. */
export interface PendingQueue {
  positions: AisPosition[];
  events: Map<string, AnomalyEvent>;          // keyed by id so a retried flush cannot duplicate
  dirtyVessels: Set<number>;
  assessments: Map<string, ThreatAssessment>;
}

export function newPendingQueue(): PendingQueue {
  return { positions: [], events: new Map(), dirtyVessels: new Set(), assessments: new Map() };
}

export interface VesselWriteRecord { ts: number; fp: string }

/** Identity and static data that, when changed, must reach the vessels registry promptly. */
export function vesselFingerprint(s: VesselState): string {
  return JSON.stringify([s.name, s.callsign, s.region, s.shipType, s.destination, s.dimBow, s.dimStern, s.dimPort, s.dimStarboard]);
}

export type VesselWriteKind = "essential" | "optional" | "skip";

/**
 * essential — first sight, identity/static change, or touched by an event/assessment this flush.
 * optional  — unchanged but the row is older than vesselRefreshMs (keeps the hydration window valid).
 * skip      — nothing to do.
 */
export function vesselWriteKind(
  s: VesselState, prev: VesselWriteRecord | undefined, now: number, touched: boolean, cfg: Config = CONFIG,
): VesselWriteKind {
  if (s.ring.length === 0) return "skip"; // flushWrites has no last fix to bind
  if (!prev || touched || prev.fp !== vesselFingerprint(s)) return "essential";
  if (now - prev.ts >= cfg.vesselRefreshMs) return "optional";
  return "skip";
}

export function isTracked(s: VesselState, cfg: Config = CONFIG): boolean {
  for (const c of THREAT_CATEGORIES) {
    if (s.assessments[c]?.status === "open") return true;
    if (s.categories[c].score >= cfg.trackPersistMinScore) return true;
  }
  return false;
}

export function shouldPersistPosition(pos: AisPosition, prev: AisPosition | undefined, cfg: Config = CONFIG): boolean {
  if (!prev) return true;
  return pos.ts - prev.ts >= cfg.persistMinIntervalMs
    || haversineM([prev.lon, prev.lat], [pos.lon, pos.lat]) >= cfg.persistMinMoveM;
}

/** One ring point per bucket inside the backfill window — queued once when a vessel becomes tracked. */
export function ringBackfill(s: VesselState, now: number, cfg: Config = CONFIG): AisPosition[] {
  const out: AisPosition[] = [];
  let lastBucket = Number.NaN;
  for (const p of s.ring) {
    if (p.ts < now - cfg.trackBackfillWindowMs) continue;
    const bucket = Math.floor(p.ts / cfg.trackBackfillBucketMs);
    if (bucket === lastBucket) continue;
    lastBucket = bucket;
    out.push(p);
  }
  return out;
}

export function truncatePositions(positions: AisPosition[], cap: number): AisPosition[] {
  return positions.length <= cap ? positions : positions.slice(positions.length - cap);
}
```

- [ ] **Step 5: Run the tests**

Run: `npx vitest run test/persist-policy.test.ts`
Expected: PASS (11 tests).

- [ ] **Step 6: Run the whole suite**

Run: `npm test`
Expected: PASS. `persistMinIntervalMs` / `persistMinMoveM` are read only by `src/do/tracker.ts`, which no test drives yet; nothing else should move.

- [ ] **Step 7: Commit**

```bash
git add src/config.ts src/persist-policy.ts test/persist-policy.test.ts
git commit -m "feat(persist): write policy — tracked-only breadcrumbs, on-change vessel registry, budget config"
```

---

### Task 5: Write meter

**Files:**
- Create: `src/write-meter.ts`
- Test: `test/write-meter.test.ts`

**Interfaces:**
- Produces:
  - `utcDay(now: number): string` — `"YYYY-MM-DD"` in UTC.
  - `interface WriteMeterStatus { day: string; usedToday: number; budget: number; optionalWritesPaused: boolean }`
  - `class WriteMeter { constructor(budget: number); record(rowsWritten: number, now: number): void; usedToday(now: number): number; optionalAllowed(now: number): boolean; status(now: number): WriteMeterStatus; reset(): void }`

- [ ] **Step 1: Write the failing tests**

Create `test/write-meter.test.ts`:

```ts
// test/write-meter.test.ts — per-UTC-day rows_written accounting (spec 2026-09-05 §3).
import { describe, expect, it } from "vitest";
import { WriteMeter, utcDay } from "../src/write-meter";

const NOON = Date.UTC(2026, 8, 5, 12); // 2026-09-05T12:00:00Z

describe("WriteMeter", () => {
  it("accumulates within a UTC day and pauses optional writes at the budget", () => {
    const m = new WriteMeter(100);
    m.record(60, NOON);
    expect(m.optionalAllowed(NOON)).toBe(true);
    m.record(40, NOON + 1000);
    expect(m.usedToday(NOON + 1000)).toBe(100);
    expect(m.optionalAllowed(NOON + 1000)).toBe(false);
    expect(m.status(NOON + 1000)).toEqual({ day: "2026-09-05", usedToday: 100, budget: 100, optionalWritesPaused: true });
  });

  it("resets when the UTC day rolls over", () => {
    const m = new WriteMeter(100);
    m.record(100, NOON);
    const next = Date.UTC(2026, 8, 6, 0, 0, 1);
    expect(utcDay(next)).toBe("2026-09-06");
    expect(m.usedToday(next)).toBe(0);
    expect(m.optionalAllowed(next)).toBe(true);
  });

  it("ignores negative counts", () => {
    const m = new WriteMeter(10);
    m.record(-5, NOON);
    expect(m.usedToday(NOON)).toBe(0);
  });

  it("reset() forgets the day and the count", () => {
    const m = new WriteMeter(10);
    m.record(5, NOON);
    m.reset();
    expect(m.usedToday(NOON)).toBe(0);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/write-meter.test.ts`
Expected: FAIL — `Cannot find module '../src/write-meter'`.

- [ ] **Step 3: Implement `src/write-meter.ts`**

```ts
// src/write-meter.ts — per-UTC-day rows_written accounting for the D1 free tier (spec 2026-09-05 §3).
// In-memory only: a DO restart resets the counter to 0 (accepted — see spec §3 "Write meter").
export interface WriteMeterStatus { day: string; usedToday: number; budget: number; optionalWritesPaused: boolean }

export function utcDay(now: number): string {
  return new Date(now).toISOString().slice(0, 10);
}

export class WriteMeter {
  private day = "";
  private used = 0;

  constructor(private readonly budget: number) {}

  private roll(now: number): void {
    const d = utcDay(now);
    if (d !== this.day) { this.day = d; this.used = 0; }
  }

  record(rowsWritten: number, now: number): void {
    this.roll(now);
    this.used += Math.max(0, rowsWritten);
  }

  usedToday(now: number): number {
    this.roll(now);
    return this.used;
  }

  optionalAllowed(now: number): boolean {
    return this.usedToday(now) < this.budget;
  }

  status(now: number): WriteMeterStatus {
    this.roll(now);
    return { day: this.day, usedToday: this.used, budget: this.budget, optionalWritesPaused: !this.optionalAllowed(now) };
  }

  /** Test hook (TrackerDO.resetForTests). */
  reset(): void {
    this.day = "";
    this.used = 0;
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run test/write-meter.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/write-meter.ts test/write-meter.test.ts
git commit -m "feat(write-meter): per-UTC-day rows_written budget"
```

---

### Task 6: Wire the policy and meter into `TrackerDO`

**Files:**
- Modify: `src/do/tracker.ts` (fields, `hydrate` window, `onWsMessage` → `ingest`, `maybeQueuePosition`, `alarm`, new `flushPending`, `status`, `resetForTests`)
- Test: `test/tracker-do.test.ts` (new)

**Interfaces:**
- Consumes: `PendingQueue`, `newPendingQueue`, `VesselWriteRecord`, `vesselFingerprint`, `vesselWriteKind`, `isTracked`, `shouldPersistPosition`, `ringBackfill`, `truncatePositions` (Task 4); `WriteMeter` (Task 5); `flushWrites(): Promise<number>` (Task 1); `FrameResult` from `src/aisstream.ts:62-66`.
- Produces (public on `TrackerDO`, for tests): `pending: PendingQueue`, `readonly meter: WriteMeter`, `ingest(frame: FrameResult): void`, `flushPending(now: number, db?: D1Database): Promise<void>`, `status(now?: number)` now includes `writes: WriteMeterStatus`.

- [ ] **Step 1: Write the failing tests**

Create `test/tracker-do.test.ts`:

```ts
// test/tracker-do.test.ts — TrackerDO write policy end-to-end against the test D1 (spec 2026-09-05 §3).
import { env, runInDurableObject } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { CONFIG } from "../src/config";
import type { TrackerDO } from "../src/do/tracker";
import type { AisPosition } from "../src/types";
import { seedTracker, trackerStub, vesselAt } from "./helpers/tracker";

const T0 = 1_800_000_000_000; // 2027-01-15T08:00Z — +6 h stays inside the same UTC day
const MIN = 60_000, H = 3_600_000;
const fix = (mmsi: number, ts: number, lon = 120, lat = 22): AisPosition => ({ mmsi, lon, lat, sog: 5, cog: 0, heading: null, ts });

const inDO = <R>(fn: (inst: TrackerDO) => R | Promise<R>) => runInDurableObject(trackerStub(), (inst: TrackerDO) => fn(inst));
const vesselRows = async () => (await env.DB.prepare("SELECT mmsi FROM vessels ORDER BY mmsi").all<any>()).results.map((r) => r.mmsi);
const positionTs = async () => (await env.DB.prepare("SELECT ts FROM positions ORDER BY mmsi, ts").all<any>()).results.map((r) => r.ts);

describe("TrackerDO write policy", () => {
  beforeEach(async () => {
    await env.DB.batch([
      env.DB.prepare("DELETE FROM vessels"), env.DB.prepare("DELETE FROM positions"),
      env.DB.prepare("DELETE FROM events"), env.DB.prepare("DELETE FROM assessments"),
    ]);
    await seedTracker([]);
  });

  it("first sight writes the vessel row; an unchanged re-flush writes nothing", async () => {
    await inDO(async (inst) => {
      inst.ingest({ kind: "ok", pos: fix(1, T0) });
      await inst.flushPending(T0);
      expect(await vesselRows()).toEqual([1]);
      const used = inst.status(T0).writes.usedToday;
      expect(used).toBeGreaterThan(0);
      inst.ingest({ kind: "ok", pos: fix(1, T0 + 30_000) });
      await inst.flushPending(T0 + 30_000);
      expect(inst.status(T0 + 30_000).writes.usedToday).toBe(used);
      expect(inst.pending.dirtyVessels.size).toBe(0);
    });
  });

  it("identity change re-writes at once; an unchanged row refreshes after vesselRefreshMs", async () => {
    await inDO(async (inst) => {
      inst.ingest({ kind: "ok", pos: fix(1, T0) });
      await inst.flushPending(T0);
      inst.ingest({ kind: "ok", ident: { mmsi: 1, name: "RENAMED", callsign: "BXYZ1", shipType: 70, ts: T0 + MIN } });
      await inst.flushPending(T0 + MIN);
      expect((await env.DB.prepare("SELECT name FROM vessels WHERE mmsi = 1").first<any>()).name).toBe("RENAMED");

      const t2 = T0 + CONFIG.vesselRefreshMs - MIN;
      inst.ingest({ kind: "ok", pos: fix(1, t2) });
      await inst.flushPending(t2);
      expect((await env.DB.prepare("SELECT last_ts FROM vessels WHERE mmsi = 1").first<any>()).last_ts).toBe(T0); // lastSeen only moves on positions; row not refreshed yet

      const t3 = T0 + MIN + CONFIG.vesselRefreshMs;
      inst.ingest({ kind: "ok", pos: fix(1, t3) });
      await inst.flushPending(t3);
      expect((await env.DB.prepare("SELECT last_ts FROM vessels WHERE mmsi = 1").first<any>()).last_ts).toBe(t3);
    });
  });

  it("breadcrumbs persist only for tracked vessels, with a one-time ring backfill on track start", async () => {
    await inDO(async (inst) => {
      for (let i = 0; i < 4; i++) inst.ingest({ kind: "ok", pos: fix(1, T0 + i * 15 * MIN, 120 + i * 0.05, 22) });
      await inst.flushPending(T0 + H);
      expect(await positionTs()).toEqual([]); // untracked: nothing persisted

      inst.tracker.states.get(1)!.categories.dark_activity.score = CONFIG.trackPersistMinScore; // becomes tracked
      inst.ingest({ kind: "ok", pos: fix(1, T0 + H + MIN, 120.25, 22) });
      await inst.flushPending(T0 + H + MIN);
      expect(await positionTs()).toEqual([T0, T0 + 15 * MIN, T0 + 30 * MIN, T0 + 45 * MIN, T0 + H + MIN]);

      inst.ingest({ kind: "ok", pos: fix(1, T0 + H + 2 * MIN, 120.25, 22) }); // 1 min later, no movement → gated
      await inst.flushPending(T0 + H + 2 * MIN);
      expect(await positionTs()).toHaveLength(5);
    });
  });

  it("at the daily budget, optional writes are dropped and essentials still land", async () => {
    await inDO(async (inst) => {
      inst.meter.record(CONFIG.d1DailyWriteBudget, T0);
      const s = vesselAt(1, 120, 22, T0);
      s.categories.dark_activity.score = 1; // tracked from the start
      inst.tracker.states.set(1, s);
      inst.ingest({ kind: "ok", pos: fix(1, T0 + 1000) });
      await inst.flushPending(T0 + 1000);
      expect(await vesselRows()).toEqual([1]);   // first sight = essential
      expect(await positionTs()).toEqual([]);    // breadcrumbs = optional, dropped
      expect(inst.pending.positions).toEqual([]); // dropped, not deferred
      expect(inst.status(T0 + 1000).writes.optionalWritesPaused).toBe(true);
    });
  });

  it("a failed flush keeps essentials for retry and caps queued positions", async () => {
    await inDO(async (inst) => {
      const s = vesselAt(1, 120, 22, T0);
      s.categories.dark_activity.score = 1;
      inst.tracker.states.set(1, s);
      for (let i = 1; i <= CONFIG.pendingPositionsCap + 50; i++) {
        inst.ingest({ kind: "ok", pos: fix(1, T0 + i * CONFIG.persistMinIntervalMs) });
      }
      const failing = {
        prepare: () => ({ bind: () => ({}) }),
        batch: async () => { throw new Error("D1_ERROR: rows_written quota exceeded"); },
      } as unknown as D1Database;
      const tEnd = T0 + (CONFIG.pendingPositionsCap + 50) * CONFIG.persistMinIntervalMs;
      await inst.flushPending(tEnd, failing);
      expect(inst.pending.positions).toHaveLength(CONFIG.pendingPositionsCap);
      expect(inst.pending.dirtyVessels.has(1)).toBe(true);

      await inst.flushPending(tEnd); // real D1: retry succeeds
      expect(await vesselRows()).toEqual([1]);
      expect(await positionTs()).toHaveLength(CONFIG.pendingPositionsCap);
      expect(inst.pending.positions).toEqual([]);
    });
  });

  it("/status exposes the write meter", async () => {
    const res = await trackerStub().fetch("https://do/status");
    const body = await res.json<any>();
    expect(body.writes).toMatchObject({ budget: CONFIG.d1DailyWriteBudget, optionalWritesPaused: false });
    expect(body.writes.usedToday).toBeGreaterThanOrEqual(0);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/tracker-do.test.ts`
Expected: FAIL — `inst.ingest is not a function` / `inst.flushPending is not a function`.

- [ ] **Step 3: Rewrite the DO's write side**

In `src/do/tracker.ts` replace the imports, fields, message handling, and alarm with the following (the websocket lifecycle in `connectStream`, the watchdog, and the read routes from Task 3 stay as they are):

```ts
// src/do/tracker.ts — websocket lifecycle, alarms, batching under the D1 write budget. Logic lives in pipeline.ts.
import { CONFIG } from "../config";
import { flushWrites, loadOpenAssessments, loadRecentVesselStates, newPendingWrites, thinPositions } from "../db";
import { GeoContext } from "../geo/context";
import { Tracker } from "../pipeline";
import { parseFrame, type FrameResult } from "../aisstream";
import {
  isTracked, newPendingQueue, ringBackfill, shouldPersistPosition, truncatePositions,
  vesselFingerprint, vesselWriteKind, type PendingQueue, type VesselWriteRecord,
} from "../persist-policy";
import { buildSnapshot, liveVessel, vesselCounts } from "../snapshot";
import { WriteMeter } from "../write-meter";
import { newVesselState, type AisPosition } from "../types";
import type { Env } from "../worker";

export class TrackerDO implements DurableObject {
  // Public for tests (cloudflare:test runInDurableObject); production code only touches them from inside this class.
  readonly tracker = new Tracker(new GeoContext());
  readonly meter = new WriteMeter(CONFIG.d1DailyWriteBudget);
  pending: PendingQueue = newPendingQueue();
  hydrated = false;

  private ws: WebSocket | null = null;
  private lastWsMessageAt = 0;
  private backoffMs: number = CONFIG.backoffMinMs;
  private lastPersisted = new Map<number, AisPosition>();   // breadcrumb downsampling reference
  private lastVesselWrite = new Map<number, VesselWriteRecord>(); // registry write-on-change reference
  private trackedMmsi = new Set<number>();                  // vessels whose ring was already backfilled
  private lastPruneAt = 0;
  private parseFailures = 0;

  constructor(private ctx: DurableObjectState, private env: Env) {}

  // fetch(): unchanged from Task 3

  status(now: number = Date.now()) {
    return {
      connected: this.ws !== null && this.ws.readyState === WebSocket.READY_STATE_OPEN,
      vessels: this.tracker.states.size,
      lastWsMessageAt: this.lastWsMessageAt,
      writes: this.meter.status(now),
    };
  }

  /** Test hook: forget all in-memory state and skip D1 hydration. */
  resetForTests(): void {
    this.hydrated = true;
    this.tracker.states.clear();
    this.tracker.drainChangedAssessments();
    this.pending = newPendingQueue();
    this.lastPersisted.clear();
    this.lastVesselWrite.clear();
    this.trackedMmsi.clear();
    this.lastPruneAt = 0;
    this.meter.reset();
  }

  private async hydrate(): Promise<void> {
    if (this.hydrated) return;
    this.hydrated = true;
    const now = Date.now();
    // Window must exceed vesselRefreshMs: every active vessel's row is at most that old (spec §3).
    const states = await loadRecentVesselStates(this.env.DB, now - (CONFIG.vesselRefreshMs + CONFIG.snapshotWindowMs));
    for (const s of states) {
      this.tracker.states.set(s.mmsi, s);
      this.lastVesselWrite.set(s.mmsi, { ts: now, fp: vesselFingerprint(s) }); // row is current; next refresh in vesselRefreshMs
    }
    // open assessments block: unchanged from the original ensureRunning
  }

  private async onWsMessage(ev: MessageEvent): Promise<void> {
    this.lastWsMessageAt = Date.now();
    try {
      this.ingest(await parseFrame(ev.data));
    } catch (err) {
      console.error("message handling error:", err);
    }
  }

  /** Apply one decoded frame to in-memory state and queue what may need persisting. Public for tests. */
  ingest(frame: FrameResult): void {
    if (frame.kind === "error") { this.parseFailures++; return; }
    if (frame.kind === "ignored") return;
    if (frame.pos) {
      for (const ev of this.tracker.handlePosition(frame.pos)) this.pending.events.set(ev.id, ev);
      this.pending.dirtyVessels.add(frame.pos.mmsi);
      this.maybeQueuePosition(frame.pos);
    }
    if (frame.ident) {
      for (const ev of this.tracker.handleStatic(frame.ident)) this.pending.events.set(ev.id, ev);
      this.pending.dirtyVessels.add(frame.ident.mmsi);
    }
  }

  // Breadcrumbs only for tracked vessels (spec §3). On the transition to tracked, backfill the ring once.
  private maybeQueuePosition(pos: AisPosition): void {
    const s = this.tracker.states.get(pos.mmsi);
    if (!s || !isTracked(s)) return;
    if (!this.trackedMmsi.has(pos.mmsi)) {
      this.trackedMmsi.add(pos.mmsi);
      this.pending.positions.push(...ringBackfill(s, pos.ts)); // ring already contains pos
      this.lastPersisted.set(pos.mmsi, pos);
      return;
    }
    if (!shouldPersistPosition(pos, this.lastPersisted.get(pos.mmsi))) return;
    this.lastPersisted.set(pos.mmsi, pos);
    this.pending.positions.push(pos);
  }

  async alarm(): Promise<void> {
    const now = Date.now();

    // 0. Aggregated parse-failure log — unchanged.
    // 1. Watchdog — unchanged.

    // 2. Gap detection + fusion tick.
    for (const ev of this.tracker.tick(now)) {
      this.pending.events.set(ev.id, ev);
      this.pending.dirtyVessels.add(ev.mmsi);
    }
    for (const a of this.tracker.drainChangedAssessments()) {
      this.pending.assessments.set(a.id, a);
      this.pending.dirtyVessels.add(a.mmsi);
    }

    // 3. Flush under the write budget.
    await this.flushPending(now);

    // 4. Daily tiered thinning (spec §3: was hourly; deletes count as rows_written).
    if (now - this.lastPruneAt > CONFIG.pruneIntervalMs) {
      this.lastPruneAt = now;
      try { await thinPositions(this.env.DB, now, CONFIG.retentionTiers); } catch (err) { console.error(err); }
    }

    await this.ctx.storage.setAlarm(now + CONFIG.alarmIntervalMs);
  }

  /**
   * Decide what earns a D1 write this tick (spec §3), flush it, account for it.
   * Essential: events, assessments, vessels that are new / changed identity / touched by an event or assessment.
   * Optional: breadcrumbs and vesselRefreshMs refreshes — dropped (not deferred) once the daily budget is spent.
   * `db` is injectable so tests can simulate a D1 rejection.
   */
  async flushPending(now: number, db: D1Database = this.env.DB): Promise<void> {
    const q = this.pending;
    if (!q.events.size && !q.positions.length && !q.dirtyVessels.size && !q.assessments.size) return;

    const optional = this.meter.optionalAllowed(now);
    const touched = new Set<number>();
    for (const ev of q.events.values()) touched.add(ev.mmsi);
    for (const a of q.assessments.values()) touched.add(a.mmsi);

    const batch = newPendingWrites();
    batch.events = [...q.events.values()];
    batch.assessments = new Map(q.assessments);
    for (const mmsi of q.dirtyVessels) {
      const s = this.tracker.states.get(mmsi);
      if (!s) continue;
      const kind = vesselWriteKind(s, this.lastVesselWrite.get(mmsi), now, touched.has(mmsi));
      if (kind === "essential" || (kind === "optional" && optional)) batch.vessels.set(mmsi, s);
    }
    if (optional) batch.positions = q.positions;
    else if (q.positions.length) console.warn(`write budget spent (${this.meter.usedToday(now)} rows today); dropping ${q.positions.length} breadcrumbs`);

    try {
      const rows = await flushWrites(db, batch);
      this.meter.record(rows, now);
      for (const s of batch.vessels.values()) this.lastVesselWrite.set(s.mmsi, { ts: now, fp: vesselFingerprint(s) });
      this.pending = newPendingQueue();
    } catch (err) {
      console.error("flush failed; retrying next tick:", err);
      q.positions = truncatePositions(q.positions, CONFIG.pendingPositionsCap);
    }
  }
}
```

Delete the old `PendingWrites`-typed `pending` field, the old `onWsMessage` body, the old `maybeQueuePosition`, and the old flush block in `alarm`. `newVesselState` stays imported for the open-assessments hydration block.

- [ ] **Step 4: Run the DO tests**

Run: `npx vitest run test/tracker-do.test.ts`
Expected: PASS (6 tests). If the ring-backfill test sees 4 rows instead of 5, `maybeQueuePosition` ran before `handlePosition` pushed the fix into the ring — the order in `ingest` must be handlePosition first.

- [ ] **Step 5: Type-check and run the whole suite**

Run: `npx tsc --noEmit && npm test`
Expected: both clean. Typical failure: `test/helpers/tracker.ts` still references a field removed in this task — it only needs `resetForTests()` and `tracker`.

- [ ] **Step 6: Commit**

```bash
git add src/do/tracker.ts test/tracker-do.test.ts
git commit -m "feat(tracker): flush under the D1 write budget — on-change registry, tracked-only breadcrumbs, capped retry, daily thinning"
```

---

### Task 7: Docs, memory note, and deployment runbook

**Files:**
- Modify: `README.md`
- Create: `MEMORY.md` (repo root) if absent, else append
- Modify: `docs/roadmap.md` (one line under the current phase, if the file has a "now" section; otherwise skip)

- [ ] **Step 1: README section**

Append to `README.md`:

```markdown
## Free-tier write budget

The worker runs on the Cloudflare free tier (D1: 100k rows written / 5M rows read per day). Design
and numbers: `docs/superpowers/specs/2026-09-05-d1-free-tier-write-budget-design.md`.

- The live map (`/api/snapshot`), per-region vessel counts and the dossier's live position are served
  from Durable Object memory. D1 is not read on the 15 s poll path.
- `vessels` rows are written on change (first sight, identity change, event/assessment touch) or at
  most every `vesselRefreshMs` (6 h). `positions` rows are written only for tracked vessels (open
  assessment or category score ≥ `trackPersistMinScore`), gated at 10 min / 2 km.
- `GET /api/health` shows `writes: { day, usedToday, budget, optionalWritesPaused }`. Above
  `d1DailyWriteBudget` (80k) breadcrumbs and refreshes are dropped for the rest of the UTC day;
  assessments and events keep flowing.

### Deploying migration 0007

Migration 0007 drops and recreates `positions` (history reset — see the spec). Apply it while
quota is available, i.e. shortly after 00:00 UTC:

    npx wrangler d1 migrations apply cable-guard --remote
    npm run deploy
    curl -s https://<worker>/api/health | jq .writes

Watch `usedToday` for a day; expected 20k–40k at 23:59 UTC.
```

- [ ] **Step 2: MEMORY.md note**

Create or append to `MEMORY.md`:

```markdown
## 2026-09-05 — D1 free tier

- D1 free tier caps: 100k rows_written/day, 5M rows_read/day. Index rows and DELETEs count as writes.
- Never add a per-flush or per-poll D1 query. Hot reads come from TrackerDO memory (`/snapshot`,
  `/vessel-counts`, `/vessel/:mmsi`); hot writes go through `flushPending` under `WriteMeter`.
- Do not add secondary indexes to `positions` or `vessels` without re-running the budget in
  `docs/superpowers/specs/2026-09-05-d1-free-tier-write-budget-design.md` §4.
- A single always-on Durable Object uses ~83% of the free 13k GB-s/day. No second always-on DO.
```

- [ ] **Step 3: Commit**

```bash
git add README.md MEMORY.md docs/roadmap.md
git commit -m "docs: free-tier write budget — README runbook and MEMORY notes"
```

- [ ] **Step 4: Hand off deployment to the human operator**

The remote migration and `npm run deploy` need Cloudflare credentials and a quota window; they are
not run by the executor. Report to the user: branch name, that `npm test` passed, and the three
commands from the README section above.

---

## Self-review

**Spec coverage.** §3 "Live map source" → Task 3. "vessels table role" → Tasks 4, 6. "positions
scope" incl. ring backfill → Tasks 4, 6. "positions schema" and INSERT OR IGNORE → Task 1.
"Thinning daily" → Task 6 (`pruneIntervalMs`). "Write meter" → Tasks 5, 6. "Flush failure" → Task 6
(`truncatePositions`, events map). "Observability" → Task 3 (`/api/health`, `/status`) and Task 6
(`writes`). "Frontend: no change" → Global Constraints; response shapes asserted by the unchanged
`test/api*.test.ts` assertions. §6 deployment → Task 7.

**Type consistency.** `flushWrites` returns `Promise<number>` (Task 1) and is consumed as such in
Task 6. `PendingQueue` / `newPendingQueue` (Task 4) are the DO's queue type (Task 6); `PendingWrites`
/ `newPendingWrites` (existing, `src/db.ts`) remain the flush input built inside `flushPending`.
`status()` gains a `now` parameter in Task 6; Task 3's `fetch` calls it with no argument, which the
default covers. `resetForTests()` is introduced in Task 3 and extended in Task 6 to call `WriteMeter.reset()`
from Task 5.

**Known trade-off left in the plan.** `resetForTests`, `ingest`, `flushPending`, `pending`, `meter`,
`tracker`, `hydrated` are public on the DO purely for `runInDurableObject` tests. This mirrors how the
pool's own docs seed DO state; it is preferable to duplicating the flush logic in a test double.
