# Taiwan Cable-Guard Map — Design Spec

**Date:** 2026-07-04
**Status:** Approved by user (brainstorming session)
**For:** SeaLight (sealight.live) — public OSINT real-time map of ships behaving suspiciously near Taiwan's submarine cables.

## 1. Background & Goal

Taiwan's submarine cables (14 international + Matsu/Penghu domestic links) are repeatedly damaged by vessels that loiter over cable corridors, disable AIS, or operate under manipulated identities (e.g., Shunxin-39: one hull, two flags, up to six MMSIs; Hong Tai 58: dark ship dragging anchor over TPKM-3).

SeaLight has no live map today — their vessel-tracking output is manual screenshots from Starboard (donated commercial access) embedded in blog posts. They are volunteer-run, near-zero budget, with one web developer. This project gives them a **public, embeddable, permalink-able real-time anomaly map** at near-zero running cost.

**Research findings that shaped this design:**
- Palantir's GitHub has **no** relevant open-source maritime/AIS/OSINT code (their dark-ship capability is closed-source Gotham/AIP). Not a foundation for this project. Optionally reuse: Blueprint React UI kit only.
- Free data tier is viable: AISStream.io (free terrestrial AIS websocket; Taiwan Strait has good shore-receiver coverage) + Global Fishing Watch research API (free; ready-made AIS-gap/loitering/dark-vessel events, ~72 h delayed).
- Paid satellite AIS: Datalastic €199–679/mo, VesselFinder credits €330+, Spire/MarineTraffic $1,000s/mo (quote-only). **Action item (non-blocking):** apply to MarineTraffic Research Network and Spire academic program via Stanford/SeaLight affiliation for free satellite AIS.

## 2. Decisions (from brainstorming)

| Question | Decision |
|---|---|
| Data feed | Free tier first (AISStream + GFW); user willing to pay later; research-license applications in parallel |
| Audience | Public live website, read-only |
| Coverage | All Taiwan cable corridors: international landings (Toucheng, Fangshan, Tamsui, etc.) + Matsu/Penghu domestic links |
| Hosting | **Approach A: Cloudflare-native** (Workers + Durable Object + D1 + Pages), ~$5/mo |
| Palantir repo | Rejected — nothing relevant exists |

## 3. Detection Engine

Per-vessel state machine fed by live AIS. Four detectors, each pure TypeScript (`(vesselState, newMessage, geoContext) → Event[]`):

1. **Loitering** — SOG < 2 kn continuously for > 2 h (tunable) inside a cable-corridor buffer (~1 km around route geometry). Exclusion polygons for known anchorages/port approaches suppress false positives.
2. **AIS gap ("going dark")** — vessel last seen inside AOI, silent > 1 h (tunable). Severity boosted if gap starts/ends within a cable corridor or reappearance implies impossible speed.
3. **Identity anomaly** — same MMSI broadcasting different name/callsign over time; MMSI MID (flag digits) vs. reported flag mismatch; positional teleport (one MMSI, two places).
4. **Anchor-drag signature** — SOG < ~3 kn with high heading/COG variance directly over a cable route.

Events carry: type, severity (1–5), vessel ref, geometry, start/end time, evidence snapshot. A vessel's **suspicion score** = decayed aggregate of recent event severities. Thresholds live in one config file.

**Corroboration layer:** daily cron pulls GFW events (AIS-off, loitering, SAR dark-vessel detections) for the AOI into a separate `gfw_events` table, rendered as a distinct "GFW-confirmed (delayed)" map layer.

## 4. Architecture (Cloudflare)

```
AISStream.io ws ──► TrackerDO (Durable Object)          GFW API ──► Cron Worker
                     • holds websocket, bbox-subscribed        │
                     • per-vessel hot state (position ring     ▼
                       buffer, identity history)            D1 (SQLite)
                     • runs detectors per message           vessels / positions /
                     • 30 s alarm: gap check + ws watchdog  events / gfw_events
                     • persists to D1                          ▲
                                                               │
Browser ◄── Pages (static MapLibre frontend) ◄── API Worker ──┘
            polls /api/* every ~15 s
```

- **TrackerDO** — single DO instance. Websocket reconnect with exponential backoff; alarm doubles as watchdog. On DO eviction, rehydrates state from D1.
- **D1 schema** — `vessels` (mmsi, latest identity, suspicion score), `positions` (downsampled track points, 30-day retention), `events`, `gfw_events`.
- **Cable geometry** — static GeoJSON: TeleGeography public data for international cables; Matsu/Penghu domestic routes digitized manually as approximate lines, labeled "approximate" in the UI.
- **API Worker routes** — `GET /api/snapshot` (current vessels, GeoJSON), `GET /api/events?since=`, `GET /api/vessel/:mmsi` (dossier: track, identity history, event timeline).
- **Cost** — Workers paid plan (~$5/mo, required for DOs); D1 and Pages free tiers suffice.

## 5. Frontend (public map)

- **MapLibre GL JS** + free OpenFreeMap vector tiles. Dark-first design.
- Layers: cable corridors (lines + buffer glow), live vessels colored by suspicion (grey → amber → red), GFW-confirmed events (distinct style), exclusion zones (toggleable, off by default).
- **Vessel dossier panel** on click: track trail, identity-change history, event timeline.
- **Event feed sidebar**: reverse-chron live events, click-to-fly-to.
- **Shareable permalinks**: URL hash encodes map view + selected vessel/event (`#vessel=412345678`) — replaces SeaLight's screenshot workflow; page is embeddable via iframe.
- **Staleness banner**: if newest AIS message is older than 5 min, show "data stale since HH:MM".

## 6. Error Handling

- Websocket drop → backoff reconnect (1 s → 60 s cap); watchdog alarm forces reconnect if no message for 2 min.
- D1 writes batched; a failed batch retries on next alarm tick (hot state is source of truth between ticks).
- API returns `generatedAt` timestamps; frontend never silently shows stale data.
- Detector exceptions are caught per-vessel — one malformed message must not kill the stream handler.

## 7. Testing

- **Unit tests (Vitest)** for each detector with synthetic tracks: a loiterer over a cable, a gap-and-teleport vessel, an identity swapper, an innocent slow fishing fleet inside an exclusion zone (must NOT fire), a normal transit.
- **Replay harness**: pipe a recorded AISStream capture file through the full ingest → detect → persist pipeline locally (miniflare/wrangler dev) and assert emitted events.
- Geo helpers (point-in-buffer, distance) tested against known coordinates on real cable routes.

## 8. Out of Scope (v1)

User accounts/auth, satellite imagery or RF fusion, push alerting (Discord/email), historical analytics beyond 30 days, satellite AIS ingestion (adapter interface kept feed-agnostic so a Spire/Datalastic REST poller can be added later), multi-region coverage beyond the Taiwan AOI.

## 9. Open Items (non-blocking)

- Submit research-license applications (MarineTraffic Research Network, Spire academic) — free satellite AIS would materially improve offshore gap detection east of Taiwan.
- Confirm exact Matsu/Penghu cable route approximations with SeaLight before public launch.
- AISHub receiver contribution (~$100 hardware in Taiwan) as a redundancy hedge.
