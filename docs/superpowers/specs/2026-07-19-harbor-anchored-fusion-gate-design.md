# Harbor-anchored fusion gate — design

Date: 2026-07-19
Author: brainstorming session
Status: draft — pending user sign-off

## Context

The live map (`web/src/vessels.ts:13`) renders a vessel as "sus" when `maxConfidence > 0`, i.e. when the vessel has at least one open row in the `assessments` table. Users report ships that are visibly anchored inside declared harbor polygons still receive red pulsing halos on the public map.

The upstream cause was traced across all five pipeline layers (label surface, scorer/fusion, detectors, geo context, AIS status) in a parallel diagnosis session. Two detectors reach fusion without gating on harbor state:

- **`src/detectors/anchorDrag.ts:26`** — checks `geo.inCorridor` only. No `inExclusion`, no `activityFor`. Anchored swing motion (SOG 0.3–3 kn, wide COG spread, ≥ 150 m displacement) inside a harbor that overlaps a cable corridor produces `severity: 5` events.
- **`src/detectors/loitering.ts:11`** — excludes `activityFor === "moored"` but not `"anchored"`. The intent is codified: `test/loitering.test.ts:67` explicitly asserts *"anchored vessel (navStatus 1) in corridor STILL loiters — anchoring over cable IS the threat."* Loitering additionally checks `!geo.inExclusion(p)`, so it is already suppressed *inside* declared harbors — the gap it leaves is anchored vessels in corridors *outside* declared harbors, which by policy is intentional.

`fusion.ts::signalsFor` maps `anchor_drag → cable_interference: "strong"` (weight 1.0), which single-handedly clears `cfg.assessmentOpenScore = 0.6`. A row opens in `assessments`, the snapshot API exposes it, and the map paints a red halo.

## Goals

- Stop harbor-anchored vessels from opening threat assessments, so the live map, review queue, and DB all inherit the filter without further work.
- Preserve the "anchoring over cable IS the threat" policy for corridors *outside* declared harbors.
- Preserve raw event telemetry in the `events` table for audit and future model features.
- Do not touch data (`data/exclusions.json`), config, migrations, or client rendering.

## Non-goals

- Expanding harbor polygon coverage. Harbors outside `data/exclusions.json`'s seven polygons (Yokohama, Kobe, Shanghai, Ningbo, HK, Singapore, etc.) remain uncovered by this change. Follow-up ticket.
- Cleaning up stale legend copy at `web/index.html:41` (`grey 0 → amber 3 → red 8+`, which no longer matches the actual `maxConfidence > 0` predicate).
- Any change to the review queue, labeling policy, or `SUS_ACTIVE` predicate.
- Any change to detector-level tests or the declared loitering policy.

## Design

### Placement

The gate lives at the top of `signalsFor` in `src/fusion.ts` (currently line 52):

```ts
export function signalsFor(ev: AnomalyEvent, s: VesselState, geo: GeoContext, cfg: Config): {...}[] {
  // Harbor-anchored dampener: a vessel that is both geometrically inside a declared
  // harbor and reporting an anchored/moored activity never contributes category score,
  // regardless of which detector produced the event.
  const act = lastActivity(s, geo, cfg);
  if ((act === "moored" || act === "anchored") && geo.inExclusion([ev.lon, ev.lat])) {
    return [];
  }

  const hits = new Map<ThreatCategory, SignalClass>();
  // ...existing switch unchanged...
}
```

`lastActivity(s, geo, cfg)` is already imported (line 3) and used elsewhere in the same file (`fusion.ts:81`). `geo.inExclusion` is on `GeoContext`. No new dependencies.

### Why fusion, not the detectors

- One line of policy instead of five detector patches.
- Detectors keep firing and the `events` table still records raw telemetry — useful for audits and future model features.
- Assessments never open on those events → the DB, the map snapshot, and the review queue all inherit the filter without additional code.
- Works for every current detector and any future detector added later.
- The existing `identity_change` moored-dampener at `fusion.ts:80-82` becomes a strict subset: harbor-anchored → 0; anchored-outside-harbor → weak; else → medium.

### Semantics

For every incoming `AnomalyEvent`:

1. Compute `act = lastActivity(s, geo, cfg)` — uses the vessel's most recent ring fix (nav status + speed + geometry).
2. Compute `inHarbor = geo.inExclusion([ev.lon, ev.lat])` — uses the event's own coordinates.
3. If `(act === "moored" || act === "anchored") && inHarbor` → return no signals. The event still exists in the `events` table; it just never contributes to any category score, never opens an assessment, and never affects `maxConfidence`.
4. Otherwise → proceed with the existing per-type switch unchanged.

### Edge cases and interactions

1. **Off-by-one on `lastActivity`.** It reads `s.ring[len-1]`, which is one fix behind the message that triggered `ev` (pipeline pushes to the ring after detectors run). This matches the precedent set by `identity_change` at `fusion.ts:81`. On the first fix of a state transition (e.g. leaving a harbor mid-anchor-drag), the classification lags by one fix. Accepted; no realistic scenario turns a genuine moving-into-corridor case into a suppressed one — the detectors themselves require multi-fix aggregation to fire.
2. **`identity_change` interaction.** The existing dampener demotes moored/anchored to weak. Our top-of-function gate now suppresses *entirely* when the vessel is also in a declared harbor. Outside-harbor + anchored still gets weak. Strict tightening.
3. **`ais_gap` with `endTs === null`.** Already returns no signal at `fusion.ts:68`. The new gate runs first; result unchanged.
4. **`speed_anomaly` / `route_deviation`.** These only fire for moving vessels, so `lastActivity` returns `"underway"` and the gate is a no-op. No regression.
5. **Empty ring / cold state.** `lastActivity` returns `"underway"` when the ring is empty (`activity.ts:32`). Gate never triggers on the first fix.
6. **Deliberate residual coverage gap:** anchored in corridor *outside* a declared harbor still fires. That's `loitering`'s intentional policy per `test/loitering.test.ts:67`; unchanged.

## Testing

### New tests in `test/fusion.test.ts`

1. **anchor_drag inside declared harbor → no signal, no assessment.**
   Construct a `GeoContext` from `data/cables.json` + `data/exclusions.json`. Feed an `anchor_drag` event at a coord inside a declared anchorage polygon that also lies in a corridor (pick a pair with confirmed overlap — Kaohsiung anchorage / TPKM is one, or synthesize matching geometry if none overlap tightly enough), with state whose most recent ring fix has `navStatus=1`. Assert `signalsFor(...) === []` and after `applyEventToFusion` that `s.assessments.cable_interference === undefined`.

2. **anchor_drag outside any exclusion → normal signal (regression guard).**
   Same event geometry moved to a corridor point outside every exclusion polygon. Assert `signalsFor` returns exactly one signal `{ category: "cable_interference", cls: "strong" }` and an assessment opens. Proves the gate is scoped, not blanket.

3. **loitering inside harbor + anchored → no signal.**
   Documents the intentional intersection between fusion-layer suppression and detector-layer emission. Add an inline comment noting that `test/loitering.test.ts:67` (detector-level) remains valid for corridors outside declared harbors.

4. **identity_change inside harbor + anchored → no signal (tightens existing weak).**
   Add a positive-control sibling at "anchored outside harbor" that still returns weak, to lock the boundary between the two dampeners.

### Regression coverage that must stay green unchanged

- All of `test/anchorDrag.test.ts` — detector-level, unaffected.
- `test/loitering.test.ts:67` — detector still emits.
- Existing `test/fusion.test.ts` signal-mapping tests when NOT harbor-anchored.

## Rollout and verification

**Deployment shape:** single-file code change to `src/fusion.ts` plus new tests in `test/fusion.test.ts`. No migration, no config change, no data change.

**Pre-existing bad rows in `assessments`.** The gate only affects new fusion events. Any harbor-anchored `cable_interference` assessments already in D1 with `status='open'` stay open until their category score decays past `assessmentCloseScore` for `assessmentCloseAfterMs` (per `fusionTick`, `fusion.ts:185`). Default: **wait for natural decay**. Zero-touch; false positives clear on their own within one decay window. A one-shot backfill script is possible if the demo needs to clear faster, but not part of this change.

**Verification steps:**

1. `npm test -- test/fusion.test.ts` → four new tests pass, all existing green.
2. `npm test` → full suite green (regression proof).
3. `npm run dev` + `npm run materialize -- --source=all --lookback-days=30 --origin=http://127.0.0.1:8787` → materialize a fresh candidate set; spot-check that no `cable_interference` candidate has a vessel whose most recent fixes are inside a `data/exclusions.json` polygon with `navStatus=1`.
4. Open `http://localhost:8787` → visually confirm harbor-anchored ships render as grey dots, not red halos. Route this via the `verify` skill after the fix lands.

## Follow-ups (not in this change)

- **Harbor polygon coverage.** Expand `data/exclusions.json` to cover ports that generate the same false positive but are outside the current seven boxes.
- **Stale legend copy** at `web/index.html:41`.
- **Backfill script** to close pre-existing `cable_interference` assessments on harbor-anchored vessels, if the demo needs faster cleanup than natural decay.