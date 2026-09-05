# D1 Free-Tier Write Budget — Design Spec

**Date:** 2026-09-05
**Status:** Approved by user (discussion session, "stay on free tier, items 1–3")
**Builds on:** [Historical Trajectories](2026-07-05-historical-trajectories-design.md), [Threat Assessment Fusion](2026-07-17-threat-assessment-fusion-design.md)

## 1. Background: the outage

Cloudflare notice received 2026-09-03: *"You have exceeded the daily D1 free tier limit of 100000
rows_written … D1 requests that incur rows_written will return errors until the limit resets."*
The notice repeats daily: the deployment burns the whole day's quota shortly after 00:00 UTC and the
map then serves stale data for the rest of the day.

Where the writes come from today (`src/do/tracker.ts`, `src/db.ts`):

| Source | Mechanism | Order of magnitude |
|---|---|---|
| `vessels` upserts | Every AIS frame marks its vessel dirty; every 30 s alarm upserts every dirty vessel. `idx_vessels_last_ts` adds an index row on each upsert. | ~1,000 active vessels × 2,880 flushes/day ≈ millions/day |
| `positions` inserts | Downsample gate is 5 min **or** 100 m. A ship at 10 kn covers 100 m in 20 s, so every moving vessel gets a row per flush. `INSERT OR REPLACE` is delete+insert on conflict; composite PK autoindex + `idx_positions_ts` triple the row count. | comparable to vessels |
| `thinPositions` | Hourly `DELETE` — deletes count as rows_written, and the `NOT IN` subquery scans the whole tier. | thousands/day, unbounded on a large table |
| GFW sync, labels | daily / manual | negligible |

Two latent hazards the outage exposes:

1. **Unbounded retry backlog.** On flush failure `pending` is kept and retried next tick. Under a
   day-long quota rejection `pending.positions` grows without bound in DO memory; at the 00:00 UTC
   reset the first batch is enormous and either fails forever or burns the new day's quota at once.
2. **Rows read is a second cliff.** `/api/snapshot` joins every vessel seen in the last hour against
   open assessments and the frontend polls it every 15 s (`web/src/vessels.ts:7`). One open tab reads
   ~6M rows/day against a 5M/day free cap. Writes failed first, so this has not surfaced yet.

## 2. Free-tier constraints that bind

| Cap | Free tier | Design consequence |
|---|---|---|
| D1 rows written | 100,000 / day | Hard budget for everything below. Index rows and deletes count. |
| D1 rows read | 5,000,000 / day | Hot reads (snapshot, vessel counts, dossier position) must not touch D1. |
| Durable Object duration | 13,000 GB-s / day | One always-on 128 MB object ≈ 10,800 GB-s. Already used; no second always-on object. |
| Durable Object SQLite writes | 100,000 / day | Same cap as D1 — not an escape hatch for positions. |
| Workers CPU | 10 ms / request | Snapshot must be served from in-memory state, not rebuilt from storage. |

## 3. Decisions

| Question | Decision |
|---|---|
| Plan | Stay on the free tier. Design to a **soft budget of 80,000 rows_written / UTC day** with headroom. |
| Live map source | `/api/snapshot`, per-region vessel counts for `/api/stats`, and the dossier's live position are served from the **TrackerDO's in-memory state** via new DO routes. D1 is never read on the 15 s poll path. |
| `vessels` table role | A slow-changing registry, **written on change**: first seen, identity fingerprint changed, vessel touched by an event or assessment change in this flush, or `vesselRefreshMs` (6 h) elapsed since its last write. Never on a timer per flush. |
| `positions` scope | Breadcrumbs persist **only for tracked vessels**: any open assessment, or any category score ≥ `trackPersistMinScore` (0.4, i.e. confidence 0.2 = the close threshold). Downsample gate becomes 10 min **or** 2,000 m. When a vessel becomes tracked, its in-memory ring (last 24 h, 10-min buckets) is backfilled once so the approach is visible. |
| `positions` schema | Table is **dropped and recreated** `WITHOUT ROWID`, no `ts` index (PK `(mmsi, ts)` serves every query). `INSERT OR IGNORE` replaces `INSERT OR REPLACE`. `idx_vessels_last_ts` is dropped. History is reset — deleting millions of old rows would itself cost more than a day of quota, and they are untracked-vessel breadcrumbs the new policy would not have kept. |
| Thinning | Daily instead of hourly. |
| Write meter | The DO sums `meta.rows_written` from every batch into a per-UTC-day counter. At the soft budget, **optional** writes (positions, 6-h refreshes) are dropped, not deferred; **essential** writes (assessments, events, first-seen / identity-changed / event-touched vessels) continue. Counter is in-memory; a DO restart resets it to 0 (accepted: conservative in the common case, and the worst case is one extra day of optional writes). |
| Flush failure | Vessels, assessments, and events are kept for retry (bounded by their maps). Pending positions are truncated to the newest `pendingPositionsCap` (2,000). Events become a map keyed by id so retries do not duplicate. |
| Observability | `GET /api/health` proxies a side-effect-free DO `/status` route: websocket state, vessel count, last message time, and `{ day, usedToday, budget, optionalWritesPaused }`. |
| Frontend | No change. Response shapes of `/api/snapshot`, `/api/stats`, `/api/vessel/:mmsi` are preserved byte-for-byte in structure. |

## 4. Write budget (per UTC day, rows_written including index rows)

Assumptions: ~2,000 distinct vessels/day across three regions, ~50 tracked vessels, positions table
`WITHOUT ROWID` with no secondary index (1 row per insert), vessels table with no secondary index
(1 row per upsert).

| Stream | Estimate | Notes |
|---|---|---|
| Tracked positions | 50 vessels × ~150 pts/day ≈ 7,500 | 10-min / 2-km gate; decimated to 500 pts/vessel on read anyway |
| Ring backfill on track start | ≤ 144 per transition × ~20/day ≈ 3,000 | one-off per vessel |
| Vessel first-seen + identity change | ~1,500 | arrivals into coverage, name/dest changes |
| Vessel 6-h refresh | 2,000 × 4 ≈ 8,000 | keeps `loadRecentVesselStates` hydration window valid |
| Event-touched vessels | ~2,000 | events are rare post-fusion |
| Assessments (2 index rows each) | ~1,000 | |
| Events (2 index rows each) | ~3,000 | |
| Daily thinning deletes | ~5,000 | positions older than 48 h thinned to 10-min buckets |
| GFW sync | ~500 | |
| **Total** | **≈ 31,000** | ~3× headroom under the 80k soft budget, 100k hard cap |

## 5. Non-goals

- No R2 / Parquet archive of raw positions (deferred; see discussion — fits R2 caps but strains the
  10 ms CPU budget on read).
- No change to detectors, fusion, scoring, labeling, or GFW.
- No frontend change.
- No second Durable Object.

## 6. Deployment notes

- `wrangler d1 migrations apply cable-guard --remote` must run **after** a 00:00 UTC reset while
  quota is available: DDL writes a handful of `sqlite_master` rows. `DROP TABLE` is expected not to
  count per-row; verify in the D1 dashboard after applying.
- Deploying replaces the DO code; the running instance with its multi-day pending backlog is evicted
  and the backlog discarded. This is desired.
- Watch `/api/health` for a full day after deploy. Expected `usedToday` at 23:59 UTC: 20k–40k.

## 7. Open risks

- **DO WebSocket message metering.** Whether messages received on an outbound WebSocket count as DO
  requests (20:1) is unconfirmed. Check the DO request graph in the dashboard; the free cap is
  100k/day.
- **Hydration after restart** loses untracked vessels' positions until the stream repopulates
  (minutes). Accepted, same as today.
- **`meta.rows_written` under Miniflare** may not match production accounting exactly. Tests assert
  presence and monotonicity, not exact values.
