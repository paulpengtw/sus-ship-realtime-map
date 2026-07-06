# Historical Trajectories (up to 6 months) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> Per the user's global delegation policy, code-writing steps go through the `codex:codex-rescue` subagent; the orchestrator owns test runs, git, and review.

**Goal:** Show vessel trajectories over selectable Day/Week/Month/3M/6M windows — suspicious vessels' lines always on, any vessel's track on demand — backed by 180-day tiered position retention and on-demand Global Fishing Watch event breadcrumbs for the deep past.

**Architecture:** The tracker DO's hourly prune becomes a tiered thinning pass over the single `positions` table (raw ≤ 48 h, 10-min buckets to 30 d, hourly to 180 d, deleted after). Two new read endpoints: `/api/trajectories` (top-50 sus vessels' polylines, sus = open event OR decayed score ≥ 2) and `/api/vessel/:mmsi/track` (windowed own points + GFW breadcrumbs, backfilled on demand via a two-step Vessels-search → Events query with a 24 h D1 cache). The web map adds a window pill group, an always-on sus-trajectory line layer, and per-selected-vessel solid own-track + dashed GFW breadcrumb rendering with typed markers.

**Tech Stack:** Cloudflare Workers + Durable Objects + D1, vitest with `@cloudflare/vitest-pool-workers`, MapLibre GL JS 5, Vite, TypeScript strict.

**Spec:** `docs/superpowers/specs/2026-07-05-historical-trajectories-design.md`

## Global Constraints

- Retention tiers (pinned in spec §1): ≤ 48 h raw; 48 h–30 d → 1 point / 10 min; 30 d–180 d → 1 point / hour; > 180 d deleted. Thinning keeps the **earliest** point per `(mmsi, ts / bucketMs)`. `CONFIG.positionRetentionMs` is **removed**, replaced by `CONFIG.retentionTiers`.
- No `positions` schema change. Migration `0003_trajectories.sql` only adds `vessels.gfw_id`, the `gfw_backfill` table, and an index on `gfw_events (mmsi)`.
- Sus = open detector event (`end_ts IS NULL` AND `start_ts` within 24 h — same rule as `/api/snapshot`) **OR** decayed score ≥ `CONFIG.susScoreThreshold = 2` (24 h half-life, existing `decayedScore`).
- Caps: top **50** vessels by decayed score (`CONFIG.trajectoryMaxVessels`), ≤ **500** points per vessel (`CONFIG.trajectoryMaxPoints`, first/last preserved by decimation).
- Window ids: `day | week | month | 3m | 6m`. Absent param → `month`; anything else → HTTP 400.
- GFW backfill is **on-demand only** — first track request triggers it; results cached in `gfw_backfill` for 24 h; vessel-unknown negative-cached (gfw_id NULL) for 24 h; **API errors are NOT cached** (retried next request) and surface as `gfwError: true` while own points still return.
- GFW is breadcrumbs (events), never raw tracks. Backfill datasets: gaps, loitering, encounters, port visits, fishing; query range 180 days.
- Web default window **Month**, persisted to `localStorage` key `cg-window`.
- Trajectory lines reuse the existing score ramp (grey `#aab6c8` → amber `#f0a83c` at 3 → red `#e5484d` at 8).
- The `/api/trajectories` response wraps the spec's array as `{ generatedAt, trajectories: [...] }` for consistency with every other endpoint (the spec's JSON sample defines the element shape).
- Out of scope: commercial historical AIS data, synthetic history, pre-warming cron, full-fleet backfill.
- Run tests with `npm test` (vitest run) from the repo root. All existing tests must stay green in every task.

## File Map

| File | Change |
|---|---|
| `src/config.ts` | Remove `positionRetentionMs`; add `retentionTiers`, `susScoreThreshold`, `trajectoryMaxVessels`, `trajectoryMaxPoints` |
| `src/db.ts` | Replace `pruneOldPositions` with `thinPositions(db, now, tiers)` |
| `src/do/tracker.ts` | Hourly prune → thinning pass |
| `src/trajectories.ts` | New — `WINDOWS`, `parseWindow`, `decimatePoints` (pure) |
| `src/worker.ts` | `/api/trajectories`, `/api/vessel/:mmsi/track`; dossier route loses its embedded track |
| `src/gfw.ts` | `gfwBackfillVessel` two-step on-demand backfill |
| `migrations/0003_trajectories.sql` | New — `vessels.gfw_id`, `gfw_backfill` table, `gfw_events(mmsi)` index |
| `web/src/api.ts` | `TrajectoriesResponse`/`TrackResponse` types, `fetchTrajectories`, `fetchVesselTrack`; `Dossier.track` removed |
| `web/src/windows.ts` | New — window store (mirrors `regions.ts`) |
| `web/src/switcher.ts` | `initWindowSwitcher` |
| `web/src/trajectories.ts` | New — sus trajectory layers + polling |
| `web/src/panels.ts` | Windowed track fetch, GFW breadcrumb layers, crumb detail, gfwError note |
| `web/src/main.ts` | Wire `initWindowSwitcher` + `initTrajectories` |
| `web/index.html` | Window pill group, legend rows |
| `web/style.css` | Window switcher, legend swatches, gfw-note/detail |
| `test/thinning.test.ts` | New — tier behavior (replaces the `pruneOldPositions` test in `test/db.test.ts`) |
| `test/trajectory-helpers.test.ts` | New — `parseWindow` + `decimatePoints` |
| `test/api-trajectories.test.ts` | New — sus filter, window bounds, region, top-50 cap |
| `test/replay-trajectories.test.ts` | New — replayed capture → `/api/trajectories` |
| `test/gfw-backfill.test.ts` | New — mocked two-step backfill |
| `test/api.test.ts` | Dossier-without-track + `/track` endpoint tests |
| `test/web-windows.test.ts` | New — window store (mirrors `test/web-regions.test.ts`) |

---

### Task 1: Tiered position thinning

The hourly `pruneOldPositions` (flat 30-day delete) becomes a tiered thinning pass. Pure D1 SQL, unit-tested directly against the test database.

**Files:**
- Modify: `src/config.ts` (remove `positionRetentionMs` at line 40; add tier config)
- Modify: `src/db.ts` (replace `pruneOldPositions` at lines 65–67)
- Modify: `src/do/tracker.ts` (imports at line 3; prune block at lines 139–143)
- Modify: `test/db.test.ts` (delete the `pruneOldPositions` test at lines 57–64)
- Test: `test/thinning.test.ts` (create)

**Interfaces:**
- Consumes: existing `positions` table (PK `(mmsi, ts)`).
- Produces (Task 10 relies on this running hourly in the DO):
  ```ts
  export interface RetentionTier { minAgeMs: number; maxAgeMs: number; bucketMs: number }
  export async function thinPositions(db: D1Database, now: number, tiers: readonly RetentionTier[]): Promise<void>;
  ```
  and `CONFIG.retentionTiers: RetentionTier[]`.

- [ ] **Step 1: Write the failing test**

Create `test/thinning.test.ts`:

```ts
// test/thinning.test.ts — spec §1: tiered thinning keeps one point per bucket per tier, deletes > 180 d.
import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { CONFIG } from "../src/config";
import { thinPositions } from "../src/db";

const NOW = 1_780_000_000_000;
const H = 3_600_000, D = 24 * H;

const insert = (mmsi: number, ts: number) =>
  env.DB.prepare(`INSERT OR REPLACE INTO positions VALUES (?1, ?2, 120.5, 22.5, 1, 90)`).bind(mmsi, ts).run();
const allTs = async () =>
  (await env.DB.prepare(`SELECT mmsi, ts FROM positions ORDER BY mmsi, ts`).all<any>()).results;

describe("thinPositions", () => {
  beforeEach(async () => { await env.DB.prepare("DELETE FROM positions").run(); });

  it("keeps raw points younger than 48 h untouched", async () => {
    await insert(1, NOW - 1000);
    await insert(1, NOW - 2000);
    await insert(1, NOW - 3000);
    await thinPositions(env.DB, NOW, CONFIG.retentionTiers);
    expect(await allTs()).toHaveLength(3);
  });

  it("keeps the earliest point per 10-min bucket in the 48 h – 30 d tier", async () => {
    const bucketStart = Math.floor((NOW - 3 * D) / 600_000) * 600_000;
    await insert(1, bucketStart + 10_000);
    await insert(1, bucketStart + 20_000);  // same bucket — dropped
    await insert(1, bucketStart + 30_000);  // same bucket — dropped
    await insert(1, bucketStart + 610_000); // next bucket — kept
    await thinPositions(env.DB, NOW, CONFIG.retentionTiers);
    expect((await allTs()).map((r: any) => r.ts)).toEqual([bucketStart + 10_000, bucketStart + 610_000]);
  });

  it("thins per vessel independently — one point per (mmsi, bucket)", async () => {
    const bucketStart = Math.floor((NOW - 3 * D) / 600_000) * 600_000;
    await insert(1, bucketStart + 10_000);
    await insert(2, bucketStart + 20_000); // other vessel, same bucket — kept
    await thinPositions(env.DB, NOW, CONFIG.retentionTiers);
    expect(await allTs()).toHaveLength(2);
  });

  it("thins to hourly buckets in the 30 d – 180 d tier", async () => {
    const bucketStart = Math.floor((NOW - 60 * D) / H) * H;
    await insert(1, bucketStart + 60_000);
    await insert(1, bucketStart + 120_000);    // same hour — dropped
    await insert(1, bucketStart + H + 60_000); // next hour — kept
    await thinPositions(env.DB, NOW, CONFIG.retentionTiers);
    expect((await allTs()).map((r: any) => r.ts)).toEqual([bucketStart + 60_000, bucketStart + H + 60_000]);
  });

  it("deletes points older than 180 d", async () => {
    await insert(1, NOW - 181 * D);
    await insert(1, NOW - 1000);
    await thinPositions(env.DB, NOW, CONFIG.retentionTiers);
    expect((await allTs()).map((r: any) => r.ts)).toEqual([NOW - 1000]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- test/thinning.test.ts`
Expected: FAIL — `thinPositions` is not exported from `../src/db` (and `retentionTiers` missing from CONFIG).

- [ ] **Step 3: Implement config + thinPositions**

In `src/config.ts`, replace line 40 (`positionRetentionMs: 30 * 24 * 60 * 60 * 1000,`) with:

```ts
  // Tiered position retention (trajectories spec §1): ≤48 h raw, then 1 pt/10 min to 30 d, 1 pt/h to 180 d.
  retentionTiers: [
    { minAgeMs: 48 * 3_600_000, maxAgeMs: 30 * 86_400_000, bucketMs: 10 * 60_000 },
    { minAgeMs: 30 * 86_400_000, maxAgeMs: 180 * 86_400_000, bucketMs: 3_600_000 },
  ],
```

In `src/db.ts`, replace `pruneOldPositions` (lines 65–67) with:

```ts
export interface RetentionTier { minAgeMs: number; maxAgeMs: number; bucketMs: number }

// Tiered thinning (trajectories spec §1): within each age tier keep the earliest point per
// (mmsi, time-bucket); everything older than the last tier is deleted outright.
export async function thinPositions(db: D1Database, now: number, tiers: readonly RetentionTier[]): Promise<void> {
  const stmts = tiers.map((t) => db.prepare(
    `DELETE FROM positions
     WHERE ts >= ?1 AND ts < ?2
       AND (mmsi, ts) NOT IN (
         SELECT mmsi, MIN(ts) FROM positions
         WHERE ts >= ?1 AND ts < ?2
         GROUP BY mmsi, ts / ?3
       )`,
  ).bind(now - t.maxAgeMs, now - t.minAgeMs, t.bucketMs));
  const oldestMs = Math.max(...tiers.map((t) => t.maxAgeMs));
  stmts.push(db.prepare(`DELETE FROM positions WHERE ts < ?1`).bind(now - oldestMs));
  await db.batch(stmts);
}
```

Note: D1's SQLite (3.40+) supports row-value `(mmsi, ts) NOT IN (...)`. If it were ever rejected, the equivalent correlated form is:

```sql
DELETE FROM positions WHERE ts >= ?1 AND ts < ?2
  AND ts != (SELECT MIN(p2.ts) FROM positions p2
             WHERE p2.mmsi = positions.mmsi AND p2.ts >= ?1 AND p2.ts < ?2
               AND p2.ts / ?3 = positions.ts / ?3)
```

- [ ] **Step 4: Wire into the tracker DO**

In `src/do/tracker.ts` line 3, change the import:

```ts
import { flushWrites, loadRecentVesselStates, newPendingWrites, thinPositions, type PendingWrites } from "../db";
```

Replace the prune block in `alarm()` (lines 139–143) with:

```ts
    // 4. Hourly tiered thinning (trajectories spec §1).
    if (now - this.lastPruneAt > 3_600_000) {
      this.lastPruneAt = now;
      try { await thinPositions(this.env.DB, now, CONFIG.retentionTiers); } catch (err) { console.error(err); }
    }
```

- [ ] **Step 5: Delete the obsolete pruneOldPositions test**

In `test/db.test.ts`: remove `pruneOldPositions` from the import on line 4 and delete the whole `it("pruneOldPositions deletes only old rows", ...)` block (lines 57–64).

- [ ] **Step 6: Run tests to verify they pass**

Run: `npm test -- test/thinning.test.ts test/db.test.ts`
Expected: PASS (5 new + 3 remaining db tests).

- [ ] **Step 7: Full suite + typecheck, then commit**

Run: `npm test` and `npx tsc --noEmit` — all green / no errors.

```bash
git add src/config.ts src/db.ts src/do/tracker.ts test/db.test.ts test/thinning.test.ts
git commit -m "feat: tiered position thinning — 180-day retention (raw/10min/hourly)"
```

---

### Task 2: Window and decimation helpers

Pure helpers shared by both new endpoints.

**Files:**
- Create: `src/trajectories.ts`
- Test: `test/trajectory-helpers.test.ts` (create)

**Interfaces:**
- Produces (Tasks 3 and 6 rely on these exact names):
  ```ts
  export const WINDOWS: { day: number; week: number; month: number; "3m": number; "6m": number };
  export function parseWindow(w: string | null): number | null; // null param → month; unknown id → null (caller 400s)
  export function decimatePoints<T>(points: T[], max: number): T[]; // uniform stride, keeps first & last
  ```

- [ ] **Step 1: Write the failing test**

Create `test/trajectory-helpers.test.ts`:

```ts
// test/trajectory-helpers.test.ts
import { describe, expect, it } from "vitest";
import { decimatePoints, parseWindow, WINDOWS } from "../src/trajectories";

describe("parseWindow", () => {
  it("maps the five window ids to milliseconds", () => {
    expect(parseWindow("day")).toBe(86_400_000);
    expect(parseWindow("week")).toBe(7 * 86_400_000);
    expect(parseWindow("month")).toBe(30 * 86_400_000);
    expect(parseWindow("3m")).toBe(90 * 86_400_000);
    expect(parseWindow("6m")).toBe(180 * 86_400_000);
  });
  it("defaults an absent param to month", () => {
    expect(parseWindow(null)).toBe(WINDOWS.month);
  });
  it("rejects junk (caller turns null into a 400)", () => {
    expect(parseWindow("year")).toBeNull();
    expect(parseWindow("")).toBeNull();
    expect(parseWindow("MONTH")).toBeNull();
  });
});

describe("decimatePoints", () => {
  const pts = Array.from({ length: 1200 }, (_, i) => [i, i, i] as [number, number, number]);
  it("returns short arrays untouched", () => {
    expect(decimatePoints(pts.slice(0, 500), 500)).toHaveLength(500);
    expect(decimatePoints([], 500)).toEqual([]);
  });
  it("caps long arrays at max, keeping first and last", () => {
    const out = decimatePoints(pts, 500);
    expect(out).toHaveLength(500);
    expect(out[0]).toEqual(pts[0]);
    expect(out[499]).toEqual(pts[1199]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- test/trajectory-helpers.test.ts`
Expected: FAIL — cannot resolve `../src/trajectories`.

- [ ] **Step 3: Implement `src/trajectories.ts`**

```ts
// src/trajectories.ts — pure window/decimation helpers for the trajectory endpoints.

export const WINDOWS = {
  day: 86_400_000,
  week: 7 * 86_400_000,
  month: 30 * 86_400_000,
  "3m": 90 * 86_400_000,
  "6m": 180 * 86_400_000,
} as const;
export type WindowId = keyof typeof WINDOWS;

// Absent param defaults to month (the UI default); unknown ids return null so the caller can 400.
export function parseWindow(w: string | null): number | null {
  if (w === null) return WINDOWS.month;
  return Object.prototype.hasOwnProperty.call(WINDOWS, w) ? WINDOWS[w as WindowId] : null;
}

// Uniform stride sampling that always keeps the first and last point.
export function decimatePoints<T>(points: T[], max: number): T[] {
  if (points.length <= max) return points;
  const step = (points.length - 1) / (max - 1);
  const out: T[] = [];
  for (let i = 0; i < max; i++) out.push(points[Math.round(i * step)]);
  return out;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- test/trajectory-helpers.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add src/trajectories.ts test/trajectory-helpers.test.ts
git commit -m "feat: window parsing + point decimation helpers for trajectories"
```

---

### Task 3: `GET /api/trajectories` — always-on sus polylines

**Files:**
- Modify: `src/config.ts` (append to CONFIG, after the `snapshotWindowMs` line)
- Modify: `src/worker.ts` (imports at lines 1–4; new route block after the `/api/snapshot` block, before `/api/events` at line 88)
- Test: `test/api-trajectories.test.ts` (create)

**Interfaces:**
- Consumes: `parseWindow`/`decimatePoints` (Task 2), existing `decayedScore`, `regionParam`, snapshot's open-events join shape.
- Produces (Task 8 renders from these exact names): `{ generatedAt: number, trajectories: [{ mmsi: number, name: string | null, score: number, topType: string | null, points: [lon, lat, ts][] }] }`. Vessels with fewer than 2 in-window points are omitted (a single point can't draw a line). Bad `window` or `region` → 400.

- [ ] **Step 1: Write the failing test**

Create `test/api-trajectories.test.ts`:

```ts
// test/api-trajectories.test.ts
import { env, SELF } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";

const NOW = Date.now();
const H = 3_600_000, D = 24 * H;

const vessel = (mmsi: number, name: string, score: number, scoreTs: number, region = "tw") =>
  env.DB.prepare(`INSERT INTO vessels (mmsi, name, callsign, last_lon, last_lat, last_sog, last_cog, last_ts, score, score_ts, region)
                  VALUES (?1, ?2, NULL, 120.5, 22.5, 5, 90, ?3, ?4, ?5, ?6)`)
    .bind(mmsi, name, NOW - 60_000, score, scoreTs, region);
const pos = (mmsi: number, ts: number, lon = 120.5, lat = 22.5) =>
  env.DB.prepare(`INSERT OR REPLACE INTO positions VALUES (?1, ?2, ?3, ?4, 5, 90)`).bind(mmsi, ts, lon, lat);

describe("/api/trajectories", () => {
  beforeEach(async () => {
    await env.DB.batch([
      env.DB.prepare("DELETE FROM vessels"), env.DB.prepare("DELETE FROM positions"), env.DB.prepare("DELETE FROM events"),
      // A: open event, score 0 → sus via event
      vessel(500000001, "EVENT SHIP", 0, NOW),
      env.DB.prepare(`INSERT INTO events (id, type, severity, mmsi, lon, lat, start_ts, end_ts, evidence, region)
                      VALUES ('loitering-500000001-1', 'loitering', 3, 500000001, 120.5, 22.5, ?1, NULL, '{}', 'tw')`).bind(NOW - H),
      // B: fresh score 5 → decayed ≈ 5 ≥ 2 → sus via score
      vessel(500000002, "SCORE SHIP", 5, NOW),
      // C: stored score 5 but 3 days old → decayed ≈ 0.6 < 2 → calm
      vessel(500000003, "FADED SHIP", 5, NOW - 3 * D),
      // D: nothing → calm
      vessel(500000004, "CALM SHIP", 0, NOW),
      pos(500000001, NOW - 2 * D, 120.1, 22.1), pos(500000001, NOW - 20 * H, 120.2, 22.2), pos(500000001, NOW - H, 120.3, 22.3),
      pos(500000002, NOW - 2 * H, 121.0, 23.0), pos(500000002, NOW - H, 121.1, 23.1),
      pos(500000003, NOW - 2 * H), pos(500000003, NOW - H),
      pos(500000004, NOW - 2 * H), pos(500000004, NOW - H),
    ]);
  });

  it("returns only sus vessels (open event OR decayed score ≥ 2) with ascending points", async () => {
    const body = await (await SELF.fetch("https://x/api/trajectories?window=week")).json<any>();
    const byMmsi = Object.fromEntries(body.trajectories.map((t: any) => [t.mmsi, t]));
    expect(Object.keys(byMmsi).map(Number).sort()).toEqual([500000001, 500000002]);
    expect(byMmsi[500000001].topType).toBe("loitering");
    expect(byMmsi[500000001].points).toHaveLength(3);
    const ts = byMmsi[500000001].points.map((p: number[]) => p[2]);
    expect(ts).toEqual([...ts].sort((a: number, b: number) => a - b));
    expect(byMmsi[500000002].score).toBeCloseTo(5, 0);
  });

  it("window bounds the points returned", async () => {
    const body = await (await SELF.fetch("https://x/api/trajectories?window=day")).json<any>();
    const a = body.trajectories.find((t: any) => t.mmsi === 500000001);
    expect(a.points).toHaveLength(2); // the NOW-2d point falls outside the day window
  });

  it("filters by region and rejects bad params", async () => {
    const jp = await (await SELF.fetch("https://x/api/trajectories?region=jp")).json<any>();
    expect(jp.trajectories).toHaveLength(0);
    expect((await SELF.fetch("https://x/api/trajectories?window=year")).status).toBe(400);
    expect((await SELF.fetch("https://x/api/trajectories?region=zz")).status).toBe(400);
  });

  it("caps at the top 50 vessels by decayed score, highest first", async () => {
    const stmts = [];
    for (let i = 0; i < 60; i++) {
      const mmsi = 600000000 + i;
      stmts.push(vessel(mmsi, `BULK ${i}`, 3 + i * 0.1, NOW));
      stmts.push(pos(mmsi, NOW - 2 * H, 122 + i * 0.01, 24), pos(mmsi, NOW - H, 122 + i * 0.01, 24.1));
    }
    await env.DB.batch(stmts);
    const body = await (await SELF.fetch("https://x/api/trajectories")).json<any>();
    expect(body.trajectories).toHaveLength(50);
    const scores = body.trajectories.map((t: any) => t.score);
    expect(scores).toEqual([...scores].sort((a: number, b: number) => b - a));
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- test/api-trajectories.test.ts`
Expected: FAIL — `/api/trajectories` returns `{ error: "not found" }` (404).

- [ ] **Step 3: Add the config knobs**

In `src/config.ts`, after the `snapshotWindowMs: 60 * 60 * 1000,` line, add:

```ts
  // Trajectories (spec §2)
  susScoreThreshold: 2,      // decayed score at/above which a vessel's trajectory is always drawn
  trajectoryMaxVessels: 50,  // top-N by decayed score in /api/trajectories
  trajectoryMaxPoints: 500,  // per-vessel point cap (server-side decimation)
```

- [ ] **Step 4: Implement the route**

In `src/worker.ts`, add to the imports (top of file, after line 3):

```ts
import { decimatePoints, parseWindow } from "./trajectories";
```

Insert this block after the `/api/snapshot` block's closing `}` (currently line 86) and before the `/api/events` block:

```ts
    if (url.pathname === "/api/trajectories") {
      const region = regionParam(url);
      if (region === null) return json({ error: "bad region" }, 400);
      const winMs = parseWindow(url.searchParams.get("window"));
      if (winMs === null) return json({ error: "bad window" }, 400);
      const eventsSince = now - 86_400_000; // same open-event rule as /api/snapshot
      // SQL prefilter only (decayed score can never exceed the stored score); exact decay,
      // the sus test, and the top-50 cap happen in JS with the shared decayedScore().
      const susSelect = `
        SELECT v.mmsi, v.name, v.score, v.score_ts, COALESCE(ev.active_events, 0) AS active_events, ev.top_type
        FROM vessels v
        LEFT JOIN (
          SELECT e.mmsi, COUNT(*) AS active_events,
                 (SELECT e2.type FROM events e2
                  WHERE e2.mmsi = e.mmsi AND e2.end_ts IS NULL AND e2.start_ts >= ?1
                  ORDER BY e2.severity DESC, e2.start_ts DESC LIMIT 1) AS top_type
          FROM events e
          WHERE e.end_ts IS NULL AND e.start_ts >= ?1
          GROUP BY e.mmsi
        ) ev ON ev.mmsi = v.mmsi
        WHERE (COALESCE(ev.active_events, 0) > 0 OR v.score >= ?2)`;
      const { results } = region
        ? await env.DB.prepare(`${susSelect} AND v.region = ?3`).bind(eventsSince, CONFIG.susScoreThreshold, region).all<any>()
        : await env.DB.prepare(susSelect).bind(eventsSince, CONFIG.susScoreThreshold).all<any>();
      const sus = results
        .map((r) => ({ ...r, decayed: decayedScore(r.score, r.score_ts, now, CONFIG.scoreHalfLifeMs) }))
        .filter((r) => r.active_events > 0 || r.decayed >= CONFIG.susScoreThreshold)
        .sort((a, b) => b.decayed - a.decayed)
        .slice(0, CONFIG.trajectoryMaxVessels);
      if (!sus.length) return json({ generatedAt: now, trajectories: [] });
      const marks = sus.map((_, i) => `?${i + 2}`).join(",");
      const { results: pts } = await env.DB.prepare(
        `SELECT mmsi, ts, lon, lat FROM positions WHERE ts >= ?1 AND mmsi IN (${marks}) ORDER BY mmsi, ts`,
      ).bind(now - winMs, ...sus.map((s) => s.mmsi)).all<any>();
      const byMmsi = new Map<number, [number, number, number][]>();
      for (const p of pts) {
        let arr = byMmsi.get(p.mmsi);
        if (!arr) byMmsi.set(p.mmsi, (arr = []));
        arr.push([p.lon, p.lat, p.ts]);
      }
      return json({
        generatedAt: now,
        trajectories: sus.map((s) => ({
          mmsi: s.mmsi, name: s.name,
          score: Math.round(s.decayed * 10) / 10,
          topType: s.top_type ?? null,
          points: decimatePoints(byMmsi.get(s.mmsi) ?? [], CONFIG.trajectoryMaxPoints),
        })).filter((t) => t.points.length >= 2), // a single point can't draw a line
      });
    }
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npm test -- test/api-trajectories.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 6: Full suite + typecheck, then commit**

Run: `npm test` and `npx tsc --noEmit` — all green / no errors.

```bash
git add src/config.ts src/worker.ts test/api-trajectories.test.ts
git commit -m "feat: /api/trajectories — top-50 sus-vessel polylines per region+window"
```

---

### Task 4: Replay-driven trajectory test

Spec §5: verify `/api/trajectories` serves plausible lines from a captured scenario. The fixture's timestamps are fixed (2026-07-01), so the test rebases them to "now".

**Files:**
- Test: `test/replay-trajectories.test.ts` (create; no source changes)

**Interfaces:**
- Consumes: `/api/trajectories` (Task 3), existing `replayCapture`, `parseAisStreamMessage`, `test/fixtures/capture.ndjson` (23 messages, 2 vessels; 999000001 loiters over a few hours and gets one open loitering event).

- [ ] **Step 1: Write the test**

Create `test/replay-trajectories.test.ts`:

```ts
// test/replay-trajectories.test.ts — spec §5: replayed capture produces plausible trajectory lines.
import { env, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { parseAisStreamMessage } from "../src/aisstream";
import { GeoContext } from "../src/geo/context";
import { replayCapture } from "../src/replay-core";
import capture from "./fixtures/capture.ndjson?raw";

describe("replayed capture → /api/trajectories", () => {
  it("draws the loiterer's line and nothing for the calm vessel", async () => {
    const lines = capture.trim().split("\n");
    const positions = lines
      .map((l) => parseAisStreamMessage(JSON.parse(l)))
      .flatMap((p) => (p?.pos ? [p.pos] : []));
    const { events } = replayCapture(lines, new GeoContext());
    const loiter = events.find((e) => e.type === "loitering" && e.endTs === null)!;
    expect(loiter).toBeDefined();
    // Rebase the capture's fixed timestamps so the newest point is "now" (the capture spans
    // only a few hours, so the shifted open event stays inside the 24 h open-event rule).
    const shift = Date.now() - Math.max(...positions.map((p) => p.ts));

    const stmts = [
      env.DB.prepare("DELETE FROM vessels"), env.DB.prepare("DELETE FROM positions"), env.DB.prepare("DELETE FROM events"),
      env.DB.prepare(`INSERT INTO events (id, type, severity, mmsi, lon, lat, start_ts, end_ts, evidence, region)
                      VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, NULL, '{}', ?8)`)
        .bind(loiter.id, loiter.type, loiter.severity, loiter.mmsi, loiter.lon, loiter.lat, loiter.startTs + shift, loiter.region ?? null),
    ];
    const seen = new Set<number>();
    for (const p of positions) {
      stmts.push(env.DB.prepare(`INSERT OR REPLACE INTO positions VALUES (?1, ?2, ?3, ?4, ?5, ?6)`)
        .bind(p.mmsi, p.ts + shift, p.lon, p.lat, p.sog, p.cog));
      if (!seen.has(p.mmsi)) {
        seen.add(p.mmsi);
        stmts.push(env.DB.prepare(
          `INSERT OR REPLACE INTO vessels (mmsi, name, callsign, last_lon, last_lat, last_sog, last_cog, last_ts, score, score_ts)
           VALUES (?1, NULL, NULL, ?2, ?3, ?4, ?5, ?6, 0, ?6)`,
        ).bind(p.mmsi, p.lon, p.lat, p.sog, p.cog, p.ts + shift));
      }
    }
    await env.DB.batch(stmts);

    const body = await (await SELF.fetch("https://x/api/trajectories?window=week")).json<any>();
    expect(body.trajectories).toHaveLength(1); // calm 999000002 must not appear
    const t = body.trajectories[0];
    expect(t.mmsi).toBe(loiter.mmsi);
    expect(t.topType).toBe("loitering");
    expect(t.points).toHaveLength(positions.filter((p) => p.mmsi === loiter.mmsi).length);
    const ts = t.points.map((p: number[]) => p[2]);
    expect(ts).toEqual([...ts].sort((a: number, b: number) => a - b));
  });
});
```

- [ ] **Step 2: Run test to verify it passes**

Run: `npm test -- test/replay-trajectories.test.ts`
Expected: PASS (1 test). If it fails, the endpoint (not the test) is wrong — debug Task 3.

- [ ] **Step 3: Full suite, then commit**

Run: `npm test` — all green.

```bash
git add test/replay-trajectories.test.ts
git commit -m "test: replayed capture produces a trajectory line for the loiterer only"
```

---

### Task 5: Migration 0003 + on-demand GFW backfill

The GFW Events API filters by GFW vessel id, not MMSI, so backfill is two-step: Vessels API search by `ssvid` → Events query by id. Results land in the existing `gfw_events` table; `gfw_backfill` is the 24 h cache bookkeeping.

**Files:**
- Create: `migrations/0003_trajectories.sql`
- Modify: `src/gfw.ts` (append after `gfwSync`)
- Test: `test/gfw-backfill.test.ts` (create)

**Interfaces:**
- Consumes: existing `GFW_URL` const and `gfw_events` upsert pattern in the same file; `env.GFW_TOKEN`.
- Produces (Task 6 relies on this exact signature):
  ```ts
  export async function gfwBackfillVessel(env: Env, mmsi: number, now: number, fetchImpl?: typeof fetch): Promise<{ error: boolean }>;
  ```
  Side effects: upserts breadcrumbs into `gfw_events` (with `mmsi` set), upserts `gfw_backfill (mmsi, gfw_id, fetched_ts)`, caches `vessels.gfw_id`. Errors return `{ error: true }` and write NO cache row.

- [ ] **Step 1: Write the migration**

Create `migrations/0003_trajectories.sql`:

```sql
-- migrations/0003_trajectories.sql — historical trajectories (spec §1): GFW on-demand backfill bookkeeping.
ALTER TABLE vessels ADD COLUMN gfw_id TEXT;

CREATE TABLE gfw_backfill (
  mmsi INTEGER PRIMARY KEY,
  gfw_id TEXT,               -- NULL = vessel unknown to GFW (negative cache, honored for 24 h too)
  fetched_ts INTEGER NOT NULL
);

-- /api/vessel/:mmsi/track reads breadcrumbs by vessel.
CREATE INDEX idx_gfw_events_mmsi ON gfw_events (mmsi);
```

(The vitest config auto-applies `migrations/` via `readD1Migrations` — no test wiring needed.)

- [ ] **Step 2: Write the failing test**

Create `test/gfw-backfill.test.ts`:

```ts
// test/gfw-backfill.test.ts — mocked two-step backfill: vessels search → events query.
import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { gfwBackfillVessel } from "../src/gfw";

const NOW = Date.now();
const MMSI = 412000009;

function mockFetch(responses: { search?: unknown; searchStatus?: number; events?: unknown; eventsStatus?: number }) {
  const calls: string[] = [];
  const impl = (async (input: RequestInfo | URL) => {
    const u = String(input);
    calls.push(u);
    if (u.includes("/vessels/search")) {
      return new Response(JSON.stringify(responses.search ?? {}), { status: responses.searchStatus ?? 200 });
    }
    return new Response(JSON.stringify(responses.events ?? {}), { status: responses.eventsStatus ?? 200 });
  }) as typeof fetch;
  return { impl, calls };
}

const SEARCH_HIT = { entries: [{ selfReportedInfo: [{ id: "gfw-vessel-1" }] }] };
const EVENTS = { entries: [
  { id: "bf-1", type: "port_visit", start: new Date(NOW - 100 * 86_400_000).toISOString(), end: null, position: { lon: 121, lat: 23 } },
  { id: "bf-2", type: "gap", start: new Date(NOW - 50 * 86_400_000).toISOString(), end: new Date(NOW - 49 * 86_400_000).toISOString(), position: { lon: 122, lat: 24 } },
] };

describe("gfwBackfillVessel", () => {
  beforeEach(async () => {
    await env.DB.batch([
      env.DB.prepare("DELETE FROM gfw_events"), env.DB.prepare("DELETE FROM gfw_backfill"), env.DB.prepare("DELETE FROM vessels"),
      env.DB.prepare(`INSERT INTO vessels (mmsi, name, callsign, last_lon, last_lat, last_sog, last_cog, last_ts, score, score_ts)
                      VALUES (?1, 'GFW SHIP', NULL, 121, 23, 1, 0, ?2, 0, ?2)`).bind(MMSI, NOW),
    ]);
  });

  it("two-step backfill stores events, cache row, and vessels.gfw_id", async () => {
    const { impl, calls } = mockFetch({ search: SEARCH_HIT, events: EVENTS });
    const r = await gfwBackfillVessel({ ...env, GFW_TOKEN: "tok" } as any, MMSI, NOW, impl);
    expect(r.error).toBe(false);
    expect(calls).toHaveLength(2);
    const evs = await env.DB.prepare("SELECT * FROM gfw_events ORDER BY id").all<any>();
    expect(evs.results).toHaveLength(2);
    expect(evs.results[0]).toMatchObject({ id: "bf-1", type: "port_visit", mmsi: MMSI, lon: 121, lat: 23 });
    expect((await env.DB.prepare("SELECT gfw_id FROM gfw_backfill WHERE mmsi = ?1").bind(MMSI).first<any>()).gfw_id).toBe("gfw-vessel-1");
    expect((await env.DB.prepare("SELECT gfw_id FROM vessels WHERE mmsi = ?1").bind(MMSI).first<any>()).gfw_id).toBe("gfw-vessel-1");
  });

  it("vessel unknown to GFW → negative cache, no refetch within 24 h", async () => {
    const { impl, calls } = mockFetch({ search: { entries: [] } });
    expect((await gfwBackfillVessel({ ...env, GFW_TOKEN: "tok" } as any, MMSI, NOW, impl)).error).toBe(false);
    expect(calls).toHaveLength(1); // search only — no events call
    expect((await env.DB.prepare("SELECT gfw_id FROM gfw_backfill WHERE mmsi = ?1").bind(MMSI).first<any>()).gfw_id).toBeNull();
    expect((await gfwBackfillVessel({ ...env, GFW_TOKEN: "tok" } as any, MMSI, NOW + 60_000, impl)).error).toBe(false);
    expect(calls).toHaveLength(1); // negative cache honored
  });

  it("API error → error: true and NO cache row (retried next request)", async () => {
    const { impl } = mockFetch({ search: SEARCH_HIT, events: { error: "rate limited" }, eventsStatus: 429 });
    expect((await gfwBackfillVessel({ ...env, GFW_TOKEN: "tok" } as any, MMSI, NOW, impl)).error).toBe(true);
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM gfw_backfill").first<any>()).n).toBe(0);
  });

  it("fresh cache row skips fetch entirely", async () => {
    await env.DB.prepare(`INSERT INTO gfw_backfill (mmsi, gfw_id, fetched_ts) VALUES (?1, 'gfw-vessel-1', ?2)`).bind(MMSI, NOW - 60_000).run();
    const { impl, calls } = mockFetch({ search: SEARCH_HIT, events: EVENTS });
    expect((await gfwBackfillVessel({ ...env, GFW_TOKEN: "tok" } as any, MMSI, NOW, impl)).error).toBe(false);
    expect(calls).toHaveLength(0);
  });

  it("stale cache row (> 24 h) refetches", async () => {
    await env.DB.prepare(`INSERT INTO gfw_backfill (mmsi, gfw_id, fetched_ts) VALUES (?1, 'gfw-vessel-1', ?2)`).bind(MMSI, NOW - 25 * 3_600_000).run();
    const { impl, calls } = mockFetch({ search: SEARCH_HIT, events: EVENTS });
    await gfwBackfillVessel({ ...env, GFW_TOKEN: "tok" } as any, MMSI, NOW, impl);
    expect(calls).toHaveLength(2);
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npm test -- test/gfw-backfill.test.ts`
Expected: FAIL — `gfwBackfillVessel` is not exported from `../src/gfw`.

- [ ] **Step 4: Implement `gfwBackfillVessel`**

Append to `src/gfw.ts`:

```ts
// On-demand deep-history backfill (trajectories spec §1). Dataset ids follow the same
// convention as GFW_DATASETS above — verify against GFW v3 docs if the API ever 404s them.
export const GFW_BACKFILL_DATASETS = [
  "public-global-gaps-events:latest",
  "public-global-loitering-events:latest",
  "public-global-encounters-events:latest",
  "public-global-port-visits-events:latest",
  "public-global-fishing-events:latest",
];
const GFW_VESSEL_SEARCH_URL = "https://gateway.api.globalfishingwatch.org/v3/vessels/search";
const GFW_BACKFILL_TTL_MS = 24 * 3_600_000;
const GFW_BACKFILL_RANGE_MS = 180 * 86_400_000;

// Two-step: Vessels API search by ssvid (MMSI) → Events query by GFW vessel id.
// Success and vessel-unknown are cached for 24 h; API errors are NOT cached so the next
// request retries (spec §4).
export async function gfwBackfillVessel(env: Env, mmsi: number, now: number, fetchImpl: typeof fetch = fetch): Promise<{ error: boolean }> {
  const cached = await env.DB.prepare(`SELECT gfw_id, fetched_ts FROM gfw_backfill WHERE mmsi = ?1`).bind(mmsi).first<any>();
  if (cached && now - cached.fetched_ts < GFW_BACKFILL_TTL_MS) return { error: false };
  try {
    const sres = await fetchImpl(
      `${GFW_VESSEL_SEARCH_URL}?query=${mmsi}&datasets[0]=public-global-vessel-identity:latest`,
      { headers: { Authorization: `Bearer ${env.GFW_TOKEN}` } },
    );
    if (!sres.ok) throw new Error(`GFW vessel search ${sres.status}`);
    const sdata = await sres.json<any>();
    const gfwId: string | null = sdata.entries?.[0]?.selfReportedInfo?.[0]?.id ?? null;
    if (gfwId === null) {
      await env.DB.prepare(`INSERT OR REPLACE INTO gfw_backfill (mmsi, gfw_id, fetched_ts) VALUES (?1, NULL, ?2)`).bind(mmsi, now).run();
      return { error: false };
    }
    const eres = await fetchImpl(GFW_URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${env.GFW_TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify({
        datasets: GFW_BACKFILL_DATASETS,
        vessels: [gfwId],
        startDate: new Date(now - GFW_BACKFILL_RANGE_MS).toISOString().slice(0, 10),
        endDate: new Date(now).toISOString().slice(0, 10),
      }),
    });
    if (!eres.ok) throw new Error(`GFW events ${eres.status}`);
    const edata = await eres.json<any>();
    const entries: any[] = edata.entries ?? [];
    const stmts = entries
      .filter((e) => e.id && e.position && Number.isFinite(e.position.lon) && Number.isFinite(e.position.lat))
      .map((e) => env.DB.prepare(
        `INSERT OR REPLACE INTO gfw_events (id, type, mmsi, lon, lat, start_ts, end_ts, raw) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)`,
      ).bind(String(e.id), String(e.type ?? "unknown"), mmsi, e.position.lon, e.position.lat,
             Date.parse(e.start), e.end ? Date.parse(e.end) : null, JSON.stringify(e)));
    stmts.push(env.DB.prepare(`INSERT OR REPLACE INTO gfw_backfill (mmsi, gfw_id, fetched_ts) VALUES (?1, ?2, ?3)`).bind(mmsi, gfwId, now));
    stmts.push(env.DB.prepare(`UPDATE vessels SET gfw_id = ?2 WHERE mmsi = ?1`).bind(mmsi, gfwId));
    await env.DB.batch(stmts);
    return { error: false };
  } catch (err) {
    console.error(`gfw backfill mmsi=${mmsi} failed:`, err);
    return { error: true };
  }
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npm test -- test/gfw-backfill.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 6: Full suite + typecheck, then commit**

Run: `npm test` and `npx tsc --noEmit` — all green / no errors.

```bash
git add migrations/0003_trajectories.sql src/gfw.ts test/gfw-backfill.test.ts
git commit -m "feat: on-demand GFW backfill — two-step vessel search + 24h D1 cache"
```

---

### Task 6: `GET /api/vessel/:mmsi/track` + slim dossier route

The dossier's fixed `LIMIT 500` track moves to a windowed sub-route that also serves GFW breadcrumbs. The web client is patched minimally so it keeps compiling; full breadcrumb rendering lands in Task 9.

**Files:**
- Modify: `src/worker.ts` (import at line ~4; new route before the existing `vesselMatch` at line 142; slim the dossier block at lines 147–164)
- Modify: `web/src/api.ts` (types + fetchers)
- Modify: `web/src/panels.ts` (lines 44 & 66–73: fetch track from the new endpoint)
- Modify: `test/api.test.ts` (seed + dossier test + new track test)

**Interfaces:**
- Consumes: `parseWindow` (Task 2), `gfwBackfillVessel` (Task 5).
- Produces (Task 9 renders from these exact names):
  - `GET /api/vessel/:mmsi/track?window=<id>` → `{ generatedAt: number, points: { ts, lon, lat, sog, cog }[], gfwEvents: { id, type, lon, lat, startTs, endTs }[], gfwError: boolean }` — points and gfwEvents both ascending by time and bounded by the window; 400 on bad window; 404 on unknown vessel.
  - `web/src/api.ts` exports `fetchVesselTrack(mmsi: number, window: string): Promise<TrackResponse>` and `fetchTrajectories(region: string, window: string): Promise<TrajectoriesResponse>`; `Dossier` loses `track`.

- [ ] **Step 1: Write the failing tests**

In `test/api.test.ts`:

(a) Add `env.DB.prepare("DELETE FROM gfw_backfill"),` to the `seed()` batch (after the `DELETE FROM gfw_events` entry on line 10).

(b) Replace the `it("/api/vessel/:mmsi returns dossier with ascending track", ...)` block (lines 57–63) with:

```ts
  it("/api/vessel/:mmsi returns dossier metadata (track moved to /track)", async () => {
    const body = await (await SELF.fetch("https://x/api/vessel/412000001")).json<any>();
    expect(body.vessel.name).toBe("TEST SHIP");
    expect(body.track).toBeUndefined();
    expect(body.events).toHaveLength(1);
  });

  it("/api/vessel/:mmsi/track returns windowed points + GFW breadcrumbs", async () => {
    // Fresh gfw_backfill row → the endpoint's on-demand backfill is a cache hit (no live fetch in tests).
    await env.DB.prepare(`INSERT OR REPLACE INTO gfw_backfill (mmsi, gfw_id, fetched_ts) VALUES (412000001, 'g1', ?1)`)
      .bind(Date.now()).run();
    const body = await (await SELF.fetch("https://x/api/vessel/412000001/track?window=day")).json<any>();
    expect(body.points).toHaveLength(2);
    expect(body.points[0].ts).toBeLessThan(body.points[1].ts);
    expect(body.gfwEvents).toHaveLength(1); // seeded gfw-1 (mmsi 412000001, 1 h before T0)
    expect(body.gfwEvents[0].id).toBe("gfw-1");
    expect(body.gfwError).toBe(false);
    expect((await SELF.fetch("https://x/api/vessel/412000001/track?window=year")).status).toBe(400);
    expect((await SELF.fetch("https://x/api/vessel/999999999/track")).status).toBe(404);
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- test/api.test.ts`
Expected: FAIL — dossier still returns `track`; `/track` route 400s ("bad mmsi" catch-all).

- [ ] **Step 3: Implement the route and slim the dossier**

In `src/worker.ts`, extend the gfw import (line 4):

```ts
import { gfwBackfillVessel, gfwSync } from "./gfw";
```

Insert this block **before** the existing `const vesselMatch = ...` line (order matters — the catch-all `startsWith("/api/vessel/")` 400 must stay last):

```ts
    const trackMatch = /^\/api\/vessel\/(\d{1,9})\/track$/.exec(url.pathname);
    if (trackMatch) {
      const mmsi = Number(trackMatch[1]);
      const winMs = parseWindow(url.searchParams.get("window"));
      if (winMs === null) return json({ error: "bad window" }, 400);
      const vessel = await env.DB.prepare(`SELECT mmsi FROM vessels WHERE mmsi = ?1`).bind(mmsi).first<any>();
      if (!vessel) return json({ error: "unknown vessel" }, 404);
      // On-demand GFW backfill (24 h cache). A GFW failure must not block our own points (spec §4).
      const { error: gfwError } = await gfwBackfillVessel(env, mmsi, now);
      const [points, gfw] = await Promise.all([
        env.DB.prepare(`SELECT ts, lon, lat, sog, cog FROM positions WHERE mmsi = ?1 AND ts >= ?2 ORDER BY ts ASC`)
          .bind(mmsi, now - winMs).all<any>(),
        env.DB.prepare(`SELECT id, type, lon, lat, start_ts, end_ts FROM gfw_events WHERE mmsi = ?1 AND start_ts >= ?2 ORDER BY start_ts ASC`)
          .bind(mmsi, now - winMs).all<any>(),
      ]);
      return json({
        generatedAt: now,
        points: points.results,
        gfwEvents: gfw.results.map((r: any) => ({ id: r.id, type: r.type, lon: r.lon, lat: r.lat, startTs: r.start_ts, endTs: r.end_ts })),
        gfwError,
      });
    }
```

Then slim the dossier block: replace the `Promise.all` track+events query (lines 147–150) with a single events query:

```ts
      const events = await env.DB.prepare(`SELECT * FROM events WHERE mmsi = ?1 ORDER BY start_ts DESC LIMIT 100`).bind(mmsi).all<any>();
```

and in the returned object delete the `track: track.results.reverse(),` line (`events: events.results.map(rowToEvent)` stays as is).

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- test/api.test.ts`
Expected: PASS (7 tests).

- [ ] **Step 5: Mirror types in the web client and patch panels minimally**

In `web/src/api.ts`: remove the `track: { ts: number; lon: number; lat: number; sog: number; cog: number }[];` line from `Dossier`, and append:

```ts
export interface TrajectoryVessel { mmsi: number; name: string | null; score: number; topType: string | null; points: [number, number, number][] }
export interface TrajectoriesResponse { generatedAt: number; trajectories: TrajectoryVessel[] }
export interface TrackPoint { ts: number; lon: number; lat: number; sog: number; cog: number }
export interface GfwBreadcrumb { id: string; type: string; lon: number; lat: number; startTs: number; endTs: number | null }
export interface TrackResponse { generatedAt: number; points: TrackPoint[]; gfwEvents: GfwBreadcrumb[]; gfwError: boolean }
export const fetchTrajectories = (region: string, window: string) =>
  get<TrajectoriesResponse>(`/api/trajectories?region=${region}&window=${window}`);
export const fetchVesselTrack = (mmsi: number, window: string) =>
  get<TrackResponse>(`/api/vessel/${mmsi}/track?window=${window}`);
```

In `web/src/panels.ts`: add `fetchVesselTrack` to the `./api` import (line 3), and replace the track-drawing block at the end of the `fetchVessel(mmsi).then((d) => { ... })` callback (lines 66–73) with:

```ts
    void fetchVesselTrack(mmsi, "month").then((t) => {   // "month" literal until Task 9 wires the window store
      const track = map.getSource("track") as GeoJSONSource | undefined;
      if (!track) return;
      if (t.points.length > 1) {
        track.setData({ type: "Feature", properties: {},
          geometry: { type: "LineString", coordinates: t.points.map((p) => [p.lon, p.lat]) } } as any);
      } else {
        track.setData({ type: "FeatureCollection", features: [] } as any);
      }
    }).catch((err) => console.error("track failed:", err));
```

- [ ] **Step 6: Verify and commit**

Run: `npm test`, `npx tsc --noEmit`, `npm run build:web` — all green / no errors / build succeeds.

```bash
git add src/worker.ts web/src/api.ts web/src/panels.ts test/api.test.ts
git commit -m "feat: windowed /api/vessel/:mmsi/track with GFW breadcrumbs; slim dossier"
```

---

### Task 7: Window switcher UI

Pill group `Day / Week / Month / 3M / 6M` next to the region switcher, default Month, persisted to `localStorage` — an exact structural mirror of the region store/switcher pair.

**Files:**
- Create: `web/src/windows.ts`
- Test: `test/web-windows.test.ts` (create)
- Modify: `web/src/switcher.ts` (append `initWindowSwitcher`)
- Modify: `web/src/main.ts` (import + call)
- Modify: `web/index.html` (nav after `#region-switcher`, line 16)
- Modify: `web/style.css` (share the switcher rules)

**Interfaces:**
- Consumes: nothing new.
- Produces (Tasks 8–9 rely on these exact names): `getWindow(): string`, `setWindow(id: string): void`, `onWindowChange(fn: (id: string) => void): void`, `DEFAULT_WINDOW = "month"`, ids `"day" | "week" | "month" | "3m" | "6m"` (matching the API's window ids exactly).

- [ ] **Step 1: Write the failing test**

Create `test/web-windows.test.ts`:

```ts
// test/web-windows.test.ts
import { describe, expect, it } from "vitest";
import { DEFAULT_WINDOW, resolveInitialWindow, WINDOWS } from "../web/src/windows";

describe("web window store", () => {
  it("defaults first-time visitors to Month", () => {
    expect(DEFAULT_WINDOW).toBe("month");
    expect(resolveInitialWindow(null)).toBe("month");
  });
  it("accepts stored valid windows, rejects junk", () => {
    expect(resolveInitialWindow("day")).toBe("day");
    expect(resolveInitialWindow("6m")).toBe("6m");
    expect(resolveInitialWindow("zz")).toBe("month");
    expect(resolveInitialWindow("")).toBe("month");
  });
  it("exposes exactly the five API window ids", () => {
    expect(WINDOWS.map((w) => w.id)).toEqual(["day", "week", "month", "3m", "6m"]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- test/web-windows.test.ts`
Expected: FAIL — cannot resolve `../web/src/windows`.

- [ ] **Step 3: Implement `web/src/windows.ts`**

```ts
// web/src/windows.ts — active history window: mirrors regions.ts (localStorage persistence + listeners).
export interface WindowDef { id: string; label: string }

export const WINDOWS: WindowDef[] = [
  { id: "day", label: "Day" },
  { id: "week", label: "Week" },
  { id: "month", label: "Month" },
  { id: "3m", label: "3M" },
  { id: "6m", label: "6M" },
];
export const DEFAULT_WINDOW = "month";
export const WINDOW_STORE_KEY = "cg-window";

export function resolveInitialWindow(stored: string | null): string {
  return WINDOWS.some((w) => w.id === stored) ? (stored as string) : DEFAULT_WINDOW;
}

let current = resolveInitialWindow(typeof localStorage === "undefined" ? null : localStorage.getItem(WINDOW_STORE_KEY));
const listeners = new Set<(id: string) => void>();

export const getWindow = (): string => current;

export function setWindow(id: string): void {
  if (!WINDOWS.some((w) => w.id === id)) return;
  localStorage.setItem(WINDOW_STORE_KEY, id);
  if (id === current) return;
  current = id;
  for (const fn of listeners) fn(id);
}

export function onWindowChange(fn: (id: string) => void): void { listeners.add(fn); }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- test/web-windows.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Add the pill group, switcher wiring, and styles**

In `web/index.html`, directly after the `</nav>` of `#region-switcher` (line 16), add:

```html
    <nav id="window-switcher" aria-label="History window" title="Trajectory history window">
      <button data-window="day">Day</button>
      <button data-window="week">Week</button>
      <button data-window="month">Month</button>
      <button data-window="3m">3M</button>
      <button data-window="6m">6M</button>
    </nav>
```

In `web/src/switcher.ts`, add the import and append the function:

```ts
import { getWindow, onWindowChange, setWindow } from "./windows";
```

```ts
export function initWindowSwitcher(): void {
  const nav = document.getElementById("window-switcher")!;
  const paint = () => nav.querySelectorAll<HTMLButtonElement>("button[data-window]")
    .forEach((b) => b.classList.toggle("active", b.dataset.window === getWindow()));
  nav.addEventListener("click", (e) => {
    const btn = (e.target as HTMLElement).closest<HTMLElement>("button[data-window]");
    if (btn) setWindow(btn.dataset.window!);
  });
  onWindowChange(paint);
  paint();
}
```

In `web/src/main.ts`: extend the switcher import to `import { initRegionSwitcher, initWindowSwitcher } from "./switcher";` and call `initWindowSwitcher();` right after `initRegionSwitcher();` in the `load` handler.

In `web/style.css`, widen the three region-switcher rules (lines 70–75) to cover both navs, replacing them with:

```css
#region-switcher, #window-switcher { display: flex; gap: 4px; background: #ffffff10; border-radius: 999px; padding: 3px; }
#region-switcher button, #window-switcher button {
  border: 0; background: none; color: var(--muted); font: inherit; font-size: 13px;
  padding: 4px 14px; border-radius: 999px; cursor: pointer;
}
#region-switcher button.active, #window-switcher button.active { background: var(--accent); color: #06121f; font-weight: 600; }
#window-switcher button { padding: 4px 10px; }
```

(the last rule tightens padding so five pills fit the topbar).

- [ ] **Step 6: Verify and commit**

Run: `npm test` and `npm run build:web` — all green / build succeeds.

```bash
git add web/src/windows.ts web/src/switcher.ts web/src/main.ts web/index.html web/style.css test/web-windows.test.ts
git commit -m "feat: Day/Week/Month/3M/6M window switcher with localStorage persistence"
```

---

### Task 8: Always-on sus-trajectory layer

Pure rendering — verification is typecheck + build here and visual in Task 10.

**Files:**
- Create: `web/src/trajectories.ts`
- Modify: `web/src/main.ts` (import + call)
- Modify: `web/index.html` (legend row)
- Modify: `web/style.css` (legend swatch)

**Interfaces:**
- Consumes: `fetchTrajectories` (Task 6), `getWindow`/`onWindowChange` (Task 7), `getRegion`/`onRegionChange`, `map` from `./main`; layer id `vessels-dot` (existing) as the insert-below anchor.
- Produces: layer ids `sus-trajectories` and `sus-trajectories-hover`; `initTrajectories(onSelect: (mmsi: number) => void): void`.

- [ ] **Step 1: Implement `web/src/trajectories.ts`**

```ts
// web/src/trajectories.ts — always-on suspicious-vessel trajectory lines (trajectories spec §3).
import type { GeoJSONSource } from "maplibre-gl";
import maplibregl from "maplibre-gl";
import { fetchTrajectories } from "./api";
import { map } from "./main";
import { getRegion, onRegionChange } from "./regions";
import { getWindow, onWindowChange } from "./windows";

const POLL_MS = 60_000; // sus set changes as events open/close; cheaper than the 15 s snapshot poll
const SCORE_RAMP = ["interpolate", ["linear"], ["get", "score"], 0, "#aab6c8", 3, "#f0a83c", 8, "#e5484d"] as any;
const NO_HOVER = ["==", ["get", "mmsi"], -1] as any;

async function refresh(): Promise<void> {
  try {
    const res = await fetchTrajectories(getRegion(), getWindow());
    (map.getSource("sus-trajectories") as GeoJSONSource | undefined)?.setData({
      type: "FeatureCollection",
      features: res.trajectories.map((t) => ({
        type: "Feature",
        geometry: { type: "LineString", coordinates: t.points.map((p) => [p[0], p[1]]) },
        properties: { mmsi: t.mmsi, name: t.name ?? `MMSI ${t.mmsi}`, score: t.score, topType: t.topType },
      })),
    } as any);
  } catch (err) {
    console.error("trajectories failed:", err);
  }
}

export function initTrajectories(onSelect: (mmsi: number) => void): void {
  map.addSource("sus-trajectories", { type: "geojson", data: { type: "FeatureCollection", features: [] } });

  // Thin semi-transparent lines under the live traffic; hover layer re-draws one line bold.
  map.addLayer({ id: "sus-trajectories", type: "line", source: "sus-trajectories",
    paint: { "line-color": SCORE_RAMP, "line-width": 1.5, "line-opacity": 0.55 } }, "vessels-dot");
  map.addLayer({ id: "sus-trajectories-hover", type: "line", source: "sus-trajectories",
    filter: NO_HOVER,
    paint: { "line-color": SCORE_RAMP, "line-width": 3, "line-opacity": 0.95 } }, "vessels-dot");

  const popup = new maplibregl.Popup({ closeButton: false, closeOnClick: false });
  map.on("mousemove", "sus-trajectories", (e) => {
    const f = e.features?.[0];
    if (!f) return;
    map.setFilter("sus-trajectories-hover", ["==", ["get", "mmsi"], (f.properties as any).mmsi]);
    popup.setLngLat(e.lngLat).setText(String((f.properties as any).name)).addTo(map);
    map.getCanvas().style.cursor = "pointer";
  });
  map.on("mouseleave", "sus-trajectories", () => {
    map.setFilter("sus-trajectories-hover", NO_HOVER);
    popup.remove();
    map.getCanvas().style.cursor = "";
  });
  map.on("click", "sus-trajectories", (e) => {
    const f = e.features?.[0];
    if (f) onSelect((f.properties as any).mmsi);
  });

  void refresh();
  setInterval(refresh, POLL_MS);
  onRegionChange(() => void refresh());
  onWindowChange(() => void refresh());
}
```

- [ ] **Step 2: Wire into `main.ts` and the legend**

In `web/src/main.ts`: add `import { initTrajectories } from "./trajectories";` and call `initTrajectories(selectVessel);` in the `load` handler directly after `initVessels(selectVessel);` (the layer inserts below `vessels-dot`, which must already exist).

In `web/index.html`, after the score-ramp legend row (line 34), add:

```html
    <div class="legend-row"><span class="swatch sus-line"></span> Suspicious-vessel trajectory (selected window)</div>
```

In `web/style.css`, next to the other `.swatch` rules, add:

```css
.swatch.sus-line { height: 0; border-top: 2px solid var(--amber); opacity: .8; }
```

- [ ] **Step 3: Verify typecheck, build, tests**

Run: `npx tsc --noEmit`, `npm run build:web`, `npm test` — no errors, successful build, all green.

- [ ] **Step 4: Commit**

```bash
git add web/src/trajectories.ts web/src/main.ts web/index.html web/style.css
git commit -m "feat: always-on sus trajectory layer with hover highlight + click-to-select"
```

---

### Task 9: Selected-vessel track + GFW breadcrumbs

Bold own-track line (the existing `track` layer), plus a dashed line through GFW breadcrumbs in time order with typed letter markers (P/G/L/E/F), crumb-click detail in the dossier, a "deep history unavailable" note on `gfwError`, and window reactivity.

**Files:**
- Modify: `web/src/panels.ts` (imports; `selectVessel` rewrite; new sources/layers + handlers in `initEventFeed`)
- Modify: `web/index.html` (legend row)
- Modify: `web/style.css` (gfw swatch, note, detail)

**Interfaces:**
- Consumes: `fetchVesselTrack`/`GfwBreadcrumb` (Task 6), `getWindow`/`onWindowChange` (Task 7); existing `track` source/layer, `esc`, `fmtTime`.
- Produces: source/layer ids `gfw-track`, `gfw-crumbs`, `gfw-crumb-dots`, `gfw-crumb-letters`; dossier elements `#gfw-note`, `#gfw-detail`.

- [ ] **Step 1: Rewrite the selection/track code in `web/src/panels.ts`**

Change the api import (line 3) to:

```ts
import { fetchEvents, fetchVessel, fetchVesselTrack, type ApiEvent, type GfwBreadcrumb } from "./api";
```

and add:

```ts
import { getWindow, onWindowChange } from "./windows";
```

Below the `REGION_LABEL` const, add:

```ts
const CRUMB_LETTER: Record<string, string> = { port_visit: "P", gap: "G", loitering: "L", encounter: "E", fishing: "F" };
const CRUMB_LABEL: Record<string, string> = { port_visit: "Port visit", gap: "AIS gap", loitering: "Loitering", encounter: "Encounter", fishing: "Fishing" };

let selectedMmsi: number | null = null;
const EMPTY_FC = { type: "FeatureCollection", features: [] } as any;

function clearTrackSources(): void {
  for (const id of ["track", "gfw-track", "gfw-crumbs"]) {
    (map.getSource(id) as GeoJSONSource | undefined)?.setData(EMPTY_FC);
  }
}

function showCrumbDetail(p: { type: string; startTs: number; endTs: number | null }): void {
  const el = document.getElementById("gfw-detail");
  if (!el) return;
  el.innerHTML = `<b>${esc(CRUMB_LABEL[p.type] ?? p.type)}</b> — ${fmtTime(Number(p.startTs))}` +
    `${p.endTs ? ` → ${fmtTime(Number(p.endTs))}` : " · open"} <span class="gfw-src">(GFW)</span>`;
}
```

Replace the whole `selectVessel` function with:

```ts
export function selectVessel(mmsi: number | null): void {
  const panel = document.getElementById("dossier")!;
  hashState.vessel = mmsi ?? undefined;
  writeHash(hashState);
  selectedMmsi = mmsi;

  if (mmsi === null) {
    panel.hidden = true;
    clearTrackSources();
    return;
  }

  void Promise.all([fetchVessel(mmsi), fetchVesselTrack(mmsi, getWindow())]).then(([d, t]) => {
    if (selectedMmsi !== mmsi) return; // user selected another vessel while loading
    const body = document.getElementById("dossier-body")!;
    const identityEvents = d.events.filter((e) => e.type === "identity");
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
      <ul>${d.events.length ? d.events.map((e) => `<li>${fmtTime(e.startTs)} — ${TYPE_LABEL[e.type] ?? e.type} (sev ${e.severity})${e.endTs === null ? " · ongoing" : ""}</li>`).join("") : "<li>No events</li>"}</ul>
      <div id="gfw-note" ${t.gfwError ? "" : "hidden"}>Deep history unavailable — GFW fetch failed</div>
      <div id="gfw-detail"></div>`;
    panel.hidden = false;

    clearTrackSources();
    const track = map.getSource("track") as GeoJSONSource | undefined;
    if (track && t.points.length > 1) {
      track.setData({ type: "Feature", properties: {},
        geometry: { type: "LineString", coordinates: t.points.map((p) => [p.lon, p.lat]) } } as any);
    }
    const crumbs: GfwBreadcrumb[] = t.gfwEvents; // already ascending by startTs
    (map.getSource("gfw-crumbs") as GeoJSONSource | undefined)?.setData({
      type: "FeatureCollection",
      features: crumbs.map((c) => ({
        type: "Feature", geometry: { type: "Point", coordinates: [c.lon, c.lat] },
        properties: { type: c.type, letter: CRUMB_LETTER[c.type] ?? "•", startTs: c.startTs, endTs: c.endTs },
      })),
    } as any);
    if (crumbs.length > 1) {
      (map.getSource("gfw-track") as GeoJSONSource | undefined)?.setData({
        type: "Feature", properties: {},
        geometry: { type: "LineString", coordinates: crumbs.map((c) => [c.lon, c.lat]) },
      } as any);
    }
  }).catch((err) => console.error("dossier failed:", err));
}
```

- [ ] **Step 2: Add the breadcrumb sources, layers, and handlers**

In `initEventFeed`, directly after the existing `track` source/layer setup (lines 89–91), add:

```ts
  // GFW breadcrumb trail for the selected vessel: dashed connector + typed letter markers.
  map.addSource("gfw-track", { type: "geojson", data: { type: "FeatureCollection", features: [] } });
  map.addSource("gfw-crumbs", { type: "geojson", data: { type: "FeatureCollection", features: [] } });
  map.addLayer({ id: "gfw-track", type: "line", source: "gfw-track",
    paint: { "line-color": "#b18cff", "line-width": 1.5, "line-dasharray": [2, 2], "line-opacity": 0.8 } }, "vessels");
  map.addLayer({ id: "gfw-crumb-dots", type: "circle", source: "gfw-crumbs",
    paint: { "circle-radius": 8, "circle-color": "#0b1220", "circle-stroke-color": "#b18cff", "circle-stroke-width": 1.5 } });
  map.addLayer({ id: "gfw-crumb-letters", type: "symbol", source: "gfw-crumbs",
    layout: { "text-field": ["get", "letter"], "text-size": 10, "text-allow-overlap": true },
    paint: { "text-color": "#b18cff" } });
  map.on("click", "gfw-crumb-dots", (e) => {
    const f = e.features?.[0];
    if (f) showCrumbDetail(f.properties as any);
  });
  map.on("mouseenter", "gfw-crumb-dots", () => { map.getCanvas().style.cursor = "pointer"; });
  map.on("mouseleave", "gfw-crumb-dots", () => { map.getCanvas().style.cursor = ""; });

  // Window switch refetches the selected vessel's track at the new depth.
  onWindowChange(() => { if (selectedMmsi !== null) selectVessel(selectedMmsi); });
```

- [ ] **Step 3: Legend + styles**

In `web/index.html`, after the "Selected vessel track" legend row (line 39), add:

```html
    <div class="legend-row"><span class="swatch gfw-track"></span> GFW breadcrumb trail — P port · G gap · L loiter · E encounter · F fishing</div>
```

In `web/style.css`, add next to the other swatch rules and after the `#dossier` rules:

```css
.swatch.gfw-track { height: 0; border-top: 2px dashed #b18cff; }
#gfw-note { color: var(--muted); font-size: 12px; margin-top: 10px; }
#gfw-detail { font-size: 12px; margin-top: 6px; }
#gfw-detail .gfw-src { color: var(--muted); }
```

- [ ] **Step 4: Verify typecheck, build, tests**

Run: `npx tsc --noEmit`, `npm run build:web`, `npm test` — no errors, successful build, all green.

- [ ] **Step 5: Commit**

```bash
git add web/src/panels.ts web/index.html web/style.css
git commit -m "feat: selected-vessel windowed track + dashed GFW breadcrumb trail with typed markers"
```

---

### Task 10: Deploy and end-to-end verification

**Files:** none (verification only; no code changes expected).

- [ ] **Step 1: Final local gate**

Run: `npm test` and `npx tsc --noEmit` — all green before deploying.

- [ ] **Step 2: Apply the migration remotely, then deploy**

```bash
npx wrangler d1 migrations apply cable-guard --remote
npm run deploy
```

Expected: migration `0003_trajectories.sql` applies cleanly; vite build then `wrangler deploy` succeed. Note the printed `https://cable-guard.<subdomain>.workers.dev` URL (call it `$URL`).

- [ ] **Step 3: Verify `/api/trajectories`**

```bash
curl -s "$URL/api/trajectories?region=tw&window=month" | jq '{n: (.trajectories | length), first: .trajectories[0] | {mmsi, score, topType, points: (.points | length)}}'
curl -s -o /dev/null -w "%{http_code}\n" "$URL/api/trajectories?window=year"
```

Expected: a JSON object (possibly `n: 0` if no vessel is currently sus — that's valid) and `400` for the bad window. If `n` is 0, synthesize a sus vessel exactly as in the previous plan's verification:

```bash
npx wrangler d1 execute cable-guard --remote --command "INSERT INTO events (id, type, severity, mmsi, lon, lat, start_ts, end_ts, evidence) SELECT 'verify-' || mmsi, 'loitering', 3, mmsi, last_lon, last_lat, last_ts, NULL, '{}' FROM vessels ORDER BY last_ts DESC LIMIT 1"
```

re-run the curl (expect `n ≥ 1` once that vessel has ≥ 2 stored positions), and clean up afterwards:

```bash
npx wrangler d1 execute cable-guard --remote --command "DELETE FROM events WHERE id LIKE 'verify-%'"
```

- [ ] **Step 4: Verify `/api/vessel/:mmsi/track` and the GFW backfill**

Pick a live MMSI: `curl -s "$URL/api/snapshot" | jq '.vessels.features[0].properties.mmsi'`, then:

```bash
curl -s "$URL/api/vessel/<MMSI>/track?window=week" | jq '{points: (.points | length), gfw: (.gfwEvents | length), gfwError}'
npx wrangler d1 execute cable-guard --remote --command "SELECT * FROM gfw_backfill LIMIT 5"
```

Expected: `points > 0`, `gfwError` false with a valid `GFW_TOKEN` (a `gfw_backfill` row appears; `gfwEvents` may legitimately be 0 for an innocuous ship). If the token is missing/invalid: `gfwError: true`, points still returned, NO `gfw_backfill` row — that is the specified degradation, not a failure. Repeat the curl: the second call must be served from cache (`wrangler tail` shows no second GFW fetch).

- [ ] **Step 5: Visual check**

Open `$URL` in a browser (or Playwright screenshot if headless):
- Window pill group next to the region pills; **Month** active by default; choice survives a reload (localStorage).
- Thin score-colored trajectory lines visible for sus vessels (use the synthetic event from Step 3 if none are live); hovering bolds the line and shows the vessel name; clicking opens the dossier.
- Selecting any vessel draws its solid track for the window; switching the window pill refetches both the sus layer and the selected track.
- If the selected vessel has GFW history: dashed purple line + lettered markers; clicking a marker shows type/time detail at the bottom of the dossier.
- Legend shows the two new rows.

- [ ] **Step 6: Verify thinning in production**

The DO thins hourly; after deployment confirm no errors and sane counts:

```bash
npx wrangler tail cable-guard --format pretty   # watch ~2 min: no thinning/SQL errors
npx wrangler d1 execute cable-guard --remote --command "SELECT COUNT(*) AS total, MIN(ts) AS oldest FROM positions"
```

Expected: no `alarm` errors mentioning positions; `oldest` never older than 180 days (on a young database this is trivially true — the real assertion is the absence of SQL errors from `thinPositions`).

- [ ] **Step 7: Commit any verification fixes and push**

If Steps 3–6 forced code changes, re-run `npm test` and commit them individually. Then:

```bash
git push origin main
```

---

## Self-Review Notes

- Spec §1 (tiers, migration 0003, thinning in the DO prune) → Tasks 1 and 5. §2 (`/api/trajectories` with sus filter + caps; `/api/vessel/:mmsi/track` with on-demand backfill and `gfwError`; dossier keeps metadata) → Tasks 3 and 6. §3 (window pills with persistence, sus layer default-on with hover/click, selected-vessel solid + dashed breadcrumbs with typed markers and crumb-click detail, legend) → Tasks 7–9. §4 (gfwError note, negative cache, sparse windows draw what exists — health chip already covers empty DB, region-NULL vessels unchanged) → Tasks 5, 6, 9. §5 (thinning tests, window parsing, sus-filter query + caps, mocked GFW backfill incl. negative cache/error/cache-hit, replay harness) → Tasks 1–5.
- Name/type consistency: `parseWindow`/`decimatePoints` defined in Task 2, consumed in Tasks 3 and 6 with identical signatures. `gfwBackfillVessel(env, mmsi, now, fetchImpl?)` defined in Task 5, called in Task 6. Window ids `day/week/month/3m/6m` are byte-identical across `src/trajectories.ts` (Task 2), `web/src/windows.ts` (Task 7), and both fetchers (Task 6). `trajectories[].points` is `[lon, lat, ts][]` in Task 3 and rendered as such in Task 8. `TrackResponse.points/gfwEvents/gfwError` names match between Task 6 (server + client types) and Task 9 (rendering). `retentionTiers` shape matches between `src/config.ts` and `thinPositions` (Task 1).
- Route ordering: `/api/vessel/:mmsi/track` regex is checked before the plain `:mmsi` route and before the `startsWith` 400 catch-all (Task 6 Step 3 says so explicitly).
- Build stays green between tasks: Task 6 patches `panels.ts` with a `"month"` literal the moment `Dossier.track` disappears; Task 9 replaces it with the window store.
- The top-50/500-point caps are tested (Task 3 bulk test + Task 2 decimation test); the 500-point cap is not re-tested through the HTTP layer to keep the seed size sane — `decimatePoints` is the single shared code path.
