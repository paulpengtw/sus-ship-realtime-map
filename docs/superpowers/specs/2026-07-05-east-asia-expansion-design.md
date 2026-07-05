# East Asia Cable-Guard Expansion — Design

**Date:** 2026-07-05
**Status:** Approved by user (interactive brainstorming session)
**Context:** The project targets a Korean hackathon. Reference for UI richness: https://github.com/seadog007/smc.peering.tw

## Goals

1. Extend live AIS anomaly detection from Taiwan-only to three East Asia regions: Korea, Taiwan, Japan.
2. Give visitors a region switcher (Korea / Taiwan / Japan) that sets their default map view.
3. Enrich the UI with the kinds of information smc.peering.tw shows: legend, live stats, richer vessel/event detail, incident timeline, cable metadata.
4. Onboard first-time visitors with an intro modal and an optional guided tour. English only.

## Non-goals

- Multi-language support (deferred).
- ISP/topology dependency view from smc.peering.tw.
- Region-sharded Durable Objects (single pipeline chosen; revisit only if volume hurts).

## 1. Regions & backend

- Replace `CONFIG.bbox` with `CONFIG.regions`: array of `{ id: "kr" | "tw" | "jp", name, bbox, center, zoom }`. Boxes are tight around cable-landing corridors, not whole countries:
  - **kr** — Busan/Geoje southern approaches + Yellow Sea landing corridors.
  - **tw** — current Taiwan box (118.0–124.5 E, 21.0–26.5 N).
  - **jp** — Kitaibaraki/Chikura/Shima landing approaches (Boso peninsula area) + Kyushu–Korea strait.
- The tracker Durable Object keeps a single AISStream subscription and passes all three boxes in `BoundingBoxes` (already an array in `src/do/tracker.ts`).
- Migration `0002_regions.sql`: add nullable `region TEXT` to `vessels` and `events`. Region computed at ingest via point-in-bbox, first match wins; existing rows backfilled to `'tw'`. Also add nullable columns to `vessels` for richer static data: `ship_type INTEGER`, `destination TEXT`, `dim_bow INTEGER`, `dim_stern INTEGER`, `dim_port INTEGER`, `dim_starboard INTEGER`.
- `parseAisStreamMessage` additionally captures ship type, destination, and dimensions from `ShipStaticData`.
- API changes:
  - `/api/snapshot` and `/api/events` accept optional `?region=kr|tw|jp`.
  - New `/api/stats`: per-region counts (vessels tracked, active alerts, events last 24 h) + per-day event histogram (last 14 days, grouped by severity) for the timeline.
- Detectors and scoring are untouched (position-stream-local, region-agnostic).
- Error handling: if a position matches no region box (edge drift), `region` stays `NULL`, rendered as "—"; vessel still displays.
- Volume risk mitigation: shrink the kr/jp boxes further (config-only change) if the single DO struggles.

## 2. Map, region switcher & cable data

- Pill-style region switcher (Korea / Taiwan / Japan) in the top bar. Clicking:
  1. flies the camera to the region's `center`/`zoom` preset,
  2. sets the region filter for stats bar, timeline, and event feed,
  3. persists the choice to `localStorage` as the visitor's default view.
- URL hash (existing permalink mechanism) wins over the localStorage default when present.
- First-visit default region: **Korea** (Korean hackathon audience).
- `data/cables.json` grows KR and JP corridor features. Every feature gets `region`, `approximate: true`, and metadata properties: `systems` (array of cable system names), `landing_points` (array of names), `notes`.
- All corridors render at all times — switching regions moves the camera and filters panels; it never hides other regions' map data.

## 3. UI enrichments

- **Legend**: collapsible panel explaining the suspicion color ramp, cable line style, exclusion zones, and GFW markers.
- **Stats bar**: top strip fed by `/api/stats`, filtered by active region — vessels tracked, active alerts, events last 24 h.
- **Richer dossier**: flag (client-side lookup from MMSI MID prefix using a small static table), ship type (decoded from AIS type code), dimensions, destination, and per-detector score breakdown (that vessel's events grouped by type: count + last occurrence).
- **Event feed detail**: severity badge, nearest cable corridor name and distance (computed client-side against corridor GeoJSON).
- **Incident timeline**: slim SVG bar strip above the event feed — last 14 days, events per day colored by severity, for the active region. Clicking a day filters the feed to that day. No chart library.
- **Cable metadata panel**: clicking a corridor opens a panel with name, systems, landing points, notes, and the count of anomaly events within the corridor buffer over the last 30 days.

## 4. First-visit onboarding

- Intro modal on first visit (absence of a `localStorage` flag): what the tool is (real-time AIS anomaly detection near submarine cables), why it matters (East Asia cable-cutting incidents), data sources (AISStream, Global Fishing Watch), how to read the map. Ends with a region choice (Korea / Taiwan / Japan) that sets the default view and dismisses the modal.
- Optional "Take a tour" button: 5-step spotlight tour — region switcher, legend, live vessels, event feed + timeline, dossier (click a vessel). Hand-rolled overlay + positioned tooltip; no library.
- `?` button in the top bar reopens the modal/tour anytime.

## Testing

- Unit tests: region tagging (point-in-bbox, first-match, no-match → null), extended `ShipStaticData` parsing, `/api/stats` response shape, `?region=` filtering on snapshot/events.
- Replay harness: `--region` passthrough so KR/JP scenarios can be demoed from captures.

## Architecture decision record

Chosen: **single pipeline, region-tagged** (one DO, one 3-box subscription). Rejected: one-DO-per-region (3x socket management, API-side merge complexity — overkill for hackathon) and a hybrid two-DO split (most of the complexity, half the benefit).
