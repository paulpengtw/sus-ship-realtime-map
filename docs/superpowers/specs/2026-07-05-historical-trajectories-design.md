# Historical Trajectories (up to 6 months) — Design

**Date:** 2026-07-05
**Status:** Approved by user (interactive brainstorming session)

## Goals

1. Show vessel trajectories for the three regions (kr / tw / jp) over selectable time windows: Day / Week / Month / 3 Months / 6 Months.
2. Default map view: suspicious vessels' trajectories for the last **month**, drawn automatically.
3. Any other vessel's trajectory available on demand (click → dossier).
4. Deep history beyond our own ingestion via **Global Fishing Watch event breadcrumbs** (the GFW public API exposes no raw per-vessel tracks — only events: port visits, AIS gaps, loitering, encounters, fishing).

## Non-goals

- Commercial historical AIS datasets (cost, out of hackathon scope).
- Synthetic/simulated history.
- Backfilling GFW history for every tracked vessel (rate limits; mostly wasted on innocuous ships).

## Decisions made during brainstorming

- **Data source:** hybrid — our own continuously accumulated AIS positions (retention extended to 180 days with tiered thinning) + GFW event breadcrumbs for the deep past.
- **Display:** sus ships' trajectories always on by default; any vessel's trajectory on demand when selected.
- **GFW fetch strategy:** on-demand only — fetched the first time a vessel's track is requested, cached in D1, refreshed if older than 24 h. No pre-warming cron.
- **Storage:** tiered thinning in-place in the single `positions` table.

## 1. Storage & retention

Replace `CONFIG.positionRetentionMs` with retention tiers:

| Age | Resolution kept |
|---|---|
| ≤ 48 h | raw (as ingested) |
| 48 h – 30 d | 1 point / 10 min |
| 30 d – 180 d | 1 point / hour |
| > 180 d | deleted |

- The tracker DO's hourly prune (`src/do/tracker.ts`) becomes a thinning pass: per tier, keep the earliest point per `(mmsi, time-bucket)` and delete the rest (`GROUP BY mmsi, ts / bucketMs`). One table, no `positions` schema change.
- Worst case per vessel over 6 months ≈ 4,300 points.

**Migration `0003_trajectories.sql`:**

- `ALTER TABLE vessels ADD COLUMN gfw_id TEXT` — cached GFW vessel id. The GFW Events API filters by GFW vessel id, not MMSI, so backfill is two-step: Vessels API search by `ssvid` (MMSI) → Events query by id.
- `CREATE TABLE gfw_backfill (mmsi INTEGER PRIMARY KEY, gfw_id TEXT, fetched_ts INTEGER NOT NULL)` — bookkeeping: refetch at most every 24 h; negative results (vessel unknown to GFW) stored with `gfw_id = NULL` and also honored for 24 h.
- Backfilled per-vessel events are stored in the existing `gfw_events` table (already has `mmsi`, `type`, position, timestamps, `raw`); datasets expanded to port visits, encounters, fishing, gaps, loitering; query range = last 180 days.

## 2. API

### `GET /api/trajectories?region=<kr|tw|jp>&window=<day|week|month|3m|6m>`

Always-on sus layer. Returns polylines for vessels in the region that are "sus": an open detector event OR decayed score ≥ 2 (new tunable `CONFIG.susScoreThreshold = 2`; score is a decayed sum of event severities, 24 h half-life):

```json
[{ "mmsi": 0, "name": "…", "score": 0, "topType": "…", "points": [[lon, lat, ts]] }]
```

Caps: top 50 vessels by score, ≤ 500 points per vessel (server-side simplification when over).

### `GET /api/vessel/:mmsi/track?window=<…>`

Any vessel on demand. Returns:

- `points` — our own positions for the window (replaces the fixed `LIMIT 500` track currently embedded in `/api/vessel/:mmsi`).
- `gfwEvents` — GFW breadcrumbs; triggers the on-demand GFW backfill if the `gfw_backfill` cache is missing or > 24 h old.
- `gfwError` flag when the GFW fetch fails — own points still return.

`/api/vessel/:mmsi` keeps serving dossier metadata; its track payload moves to the windowed sub-route.

## 3. Frontend

- **Window switcher:** pill group `Day / Week / Month / 3M / 6M` next to the region switcher. Default **Month**; persisted to `localStorage`; changing it refetches both trajectory layers.
- **Sus layer (default on):** thin, semi-transparent polylines colored by the existing suspicion ramp. Hover highlights the line and shows the vessel name; click selects the vessel.
- **Selected vessel:** bold solid line for our own positions plus a dashed line connecting GFW event breadcrumbs in time order, with typed markers (port visit, AIS gap, loitering, encounter, fishing). Clicking a marker shows the event details in the dossier.
- **Legend:** entries added for the solid own-track line, the dashed GFW breadcrumb line, and the breadcrumb marker types.

## 4. Error handling

- Missing/invalid GFW token or rate limiting → breadcrumbs skipped; dossier shows a subtle "deep history unavailable" note; `gfwError: true` in the response.
- Vessel not found in GFW → negative-cached for 24 h in `gfw_backfill`.
- Sparse windows (e.g. 6 M selected while the DB only holds days of data) → draw whatever exists; the existing health chip / stale banner already explains an empty DB.
- Position matching no region box behaves as today (vessel still displays; region `NULL`).

## 5. Testing

- **Unit tests:**
  - Tiered thinning keeps exactly one point per bucket per tier and deletes > 180 d.
  - `window` param parsing (all five values + bad input → 400).
  - Sus-filter query for `/api/trajectories` (open events OR decayed score ≥ `susScoreThreshold`; top-50 / 500-point caps).
  - GFW two-step backfill with mocked fetch: success, vessel unknown (negative cache), API error (graceful `gfwError`), cache-hit skips fetch.
- **Replay harness:** verify `/api/trajectories` serves plausible lines from a captured scenario.

## Architecture decision record

- **Tiered thinning in-place** chosen over a separate hourly-summary table (two-source merge complexity) and precomputed polyline blobs (staleness, invalidation complexity).
- **On-demand-only GFW backfill** chosen over sus-ship pre-warming cron and full-fleet backfill (rate limits, wasted calls). Consequence: the default sus layer draws only our own accumulated positions; GFW breadcrumbs appear per vessel once selected.
- **GFW breadcrumbs, not tracks:** verified against GFW API v3 documentation — no public endpoint returns raw per-vessel AIS positions; Events API is the deepest available history.
