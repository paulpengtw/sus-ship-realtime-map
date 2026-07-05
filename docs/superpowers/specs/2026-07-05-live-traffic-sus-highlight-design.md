# Design: Live Traffic Rendering + Sus-Ship Highlighting

**Date:** 2026-07-05
**Status:** Approved by user

## Problem

The deployed map has looked completely empty since at least 2026-06-22. Two distinct causes:

1. **Ingest has been silently broken.** aisstream.io delivers WebSocket frames as binary (`ArrayBuffer`/Blob). `Tracker.onWsMessage` in `src/do/tracker.ts` does `JSON.parse(String(ev.data))`, which stringifies a Blob to `"[object Blob]"` — every single message fails with a `SyntaxError` and is dropped. Zero rows were ever written to D1. (The missing `AISSTREAM_KEY` secret was a second blocker; it has already been set on the deployed worker.)
2. **Even with data, calm traffic is nearly invisible.** Non-suspicious vessels render as 3.5 px dark-grey dots on a dark basemap, and a quiet ocean is indistinguishable from a dead system. The stale banner hides when `newestTs` is `null`, so a completely empty database shows no warning at all.

Goal: the map should always show all live AIS traffic so the system visibly works, and vessels with active detector events should be highlighted aggressively.

## Decisions (made with user)

- **Scope:** both the ingest fix and the visual redesign (option A).
- **Sus definition:** hybrid (option C) — the suspicion score keeps driving the continuous grey→amber→red color ramp, and an *active event* additionally triggers the alarm treatment.
- **Normal traffic style:** heading-rotated triangle icons (option A), MarineTraffic-style.
- **Active-event flag source:** backend join in `/api/snapshot` (Approach 1), not a client-side join and not a score-recency heuristic.

## 1. Ingest fix (src/do/tracker.ts)

- In `onWsMessage`, decode `ev.data` before parsing: if it is an `ArrayBuffer` (or Blob), decode to text with `TextDecoder`, then `JSON.parse`. String frames continue to work unchanged.
- Aggregate parse-failure logging: count consecutive parse failures and log one summary line per alarm window instead of one error per message, so `wrangler tail` stays readable.

## 2. Snapshot API: active-event properties (src/worker.ts)

`/api/snapshot`'s vessel query gains a LEFT JOIN against `events` rows that are open (`end_ts IS NULL`) and started within the last 24 h. Each vessel GeoJSON feature gains:

- `activeEvents` (number) — count of open events for that MMSI.
- `topType` (string | null) — event type of the most severe open event; ties broken by most recent `start_ts`.

No new endpoints. No schema change. Response is backward-compatible (additive properties only). The optional `region` filter continues to apply as today.

## 3. Rendering (web/src/vessels.ts)

Replace the single circle layer with three layers, bottom to top:

1. **Traffic layer** — symbol layer using a small SDF triangle generated in code (no asset file), `icon-rotate` bound to `cog`, `icon-color` bound to the existing score ramp with a brighter base grey (≈ `#aab6c8`) so calm traffic is clearly visible. Vessels with no usable heading (`cog` null, or effectively stationary) fall back to a dot rendering.
2. **Sus halo layer** — circle layer filtered to `activeEvents > 0`; a pulsing red halo animated via `requestAnimationFrame` driving `circle-radius` and `circle-opacity` sinusoidally with a ~1.5 s period. Drawn above all traffic.
3. **Sus icon emphasis** — highlighted vessels' triangles render ~1.5× larger and solid red, overriding the ramp.

Click/hover handlers, the vessel detail panel, filter chips, and the GFW layer are unchanged.

## 4. System-health visibility

- Fix the stale banner: `newestTs === null` must show "no vessel data received yet — ingest may be down" instead of hiding (current behavior hides the banner exactly when the system is most broken).
- Add a small always-on status chip on the map: `● live — N vessels`, green when data is fresh, amber when stale. The map communicates health even when the ocean is genuinely quiet.

## 5. Testing

- Unit test for frame decoding: string frame parses; ArrayBuffer frame parses; garbage frame does not throw and is counted as a parse failure.
- Unit test for the snapshot join: seeded vessels with one open event carry `activeEvents`/`topType`; vessels with only closed events carry `activeEvents: 0`.
- End-to-end verification against the live deployment after the ingest fix (real traffic should appear within minutes), plus the replay path (`src/replay-core.ts`) to synthesize a sus vessel if no real active events exist at verification time.

## Out of scope

Motion trails, low-zoom clustering, pushing events to the browser (polling stays), and any detector or scoring changes.
