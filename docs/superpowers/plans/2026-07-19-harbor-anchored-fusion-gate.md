# Harbor-anchored fusion gate — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop harbor-anchored vessels from opening threat assessments by adding a single dampener at the top of `signalsFor` in `src/fusion.ts`, so the live map stops flagging anchored ships in declared harbors.

**Architecture:** Fusion-layer gate that returns `[]` when `lastActivity(s, geo, cfg) ∈ {moored, anchored}` AND `geo.inExclusion([ev.lon, ev.lat])`. Detectors keep firing; only the mapping from event → category signal is suppressed. Assessments never open on those events, so the DB, `/api/snapshot`, and the review queue all inherit the filter.

**Tech Stack:** TypeScript, Vitest, Cloudflare Workers (D1), no runtime deps added.

**Reference:** `docs/superpowers/specs/2026-07-19-harbor-anchored-fusion-gate-design.md` (commit `6675b13`).

## Global Constraints

- Change only `src/fusion.ts` (production) and `test/fusion.test.ts` (tests). No changes to detectors, `data/exclusions.json`, config, migrations, or client code.
- Preserve existing behavior for every event outside the (harbor ∧ anchored/moored) intersection. Regression coverage in Task 2 exists to prove this.
- No new runtime dependencies. `lastActivity` is already imported at `src/fusion.ts:3`.
- Use `newVesselState(mmsi, T0)` and mutate `ring` directly to set up state, matching the pattern already used in `test/fusion.test.ts` and `test/anchorDrag.test.ts`.
- Commits: one per task, imperative present tense, no attribution trailer (project style — inspect `git log` if unsure).

---

### Task 1: Add the fusion-layer harbor-anchored gate (TDD)

**Files:**
- Modify: `src/fusion.ts:52` (top of `signalsFor` body)
- Test: `test/fusion.test.ts` — new describe block appended at end of file

**Interfaces:**
- Consumes: `lastActivity(s: VesselState, geo: GeoContext, cfg: Config): "moored" | "anchored" | "stationary" | "underway"` from `src/activity.ts` (already imported at `src/fusion.ts:3`).
- Consumes: `GeoContext.inExclusion(p: LngLat): boolean` from `src/geo/context.ts:43`.
- Produces: `signalsFor(...)` returns `[]` for the (harbor ∧ anchored/moored) case; existing signature unchanged.

- [ ] **Step 1: Write the failing test**

Append the following describe block to the end of `test/fusion.test.ts`:

```ts
describe("fusion: harbor-anchored dampener", () => {
  // Exclusion polygon covers ~(120.15..120.25, 21.99..22.01) — overlaps the C1 corridor
  // (LineString [[120.0,22.0],[121.0,22.0]]) exactly where the shared `ev()` helper places events.
  const harbor = {
    type: "FeatureCollection",
    features: [{
      type: "Feature",
      properties: { name: "test-harbor" },
      geometry: {
        type: "Polygon",
        coordinates: [[[120.15, 21.99], [120.25, 21.99], [120.25, 22.01], [120.15, 22.01], [120.15, 21.99]]],
      },
    }],
  };
  const geoWithHarbor = new GeoContext(cables as any, harbor as any, 1000, noFc as any, 5000);

  // Ring fix at the event location with navStatus=1 so lastActivity classifies "anchored".
  function anchoredState(mmsi: number) {
    const s = newVesselState(mmsi, T0);
    s.ring.push({ mmsi, lon: 120.2, lat: 22.0, sog: 0.5, cog: 0, heading: 0, navStatus: 1, ts: T0 });
    s.lastSeen = T0;
    return s;
  }

  it("anchor_drag inside declared harbor produces no signal and opens no assessment", () => {
    const s = anchoredState(101);
    const anchorDragEv = ev({
      type: "anchor_drag",
      id: "anchor_drag-101-1",
      evidence: { corridor: "C1", cogStdDeg: 80, meanSogKn: 1.2, displacementM: 200 },
    });
    expect(signalsFor(anchorDragEv, s, geoWithHarbor, CONFIG)).toEqual([]);
    const changed = applyEventToFusion(s, anchorDragEv, geoWithHarbor, CONFIG, T0);
    expect(changed).toEqual([]);
    expect(s.assessments.cable_interference).toBeUndefined();
    expect(s.categories.cable_interference.score).toBe(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- test/fusion.test.ts -t "harbor-anchored dampener"`
Expected: FAIL. The current `signalsFor` will return `[{ category: "cable_interference", cls: "strong", ... }]` and the assertion `.toEqual([])` will fail. An assessment will also open (`changed.length === 1`), and `s.categories.cable_interference.score` will be 1.

- [ ] **Step 3: Write minimal implementation**

Edit `src/fusion.ts`. At the top of the `signalsFor` function body (currently line 53, immediately after the opening brace at line 52), insert the gate — the final function should look like:

```ts
export function signalsFor(ev: AnomalyEvent, s: VesselState, geo: GeoContext, cfg: Config): { category: ThreatCategory; cls: SignalClass; summary: string }[] {
  // Harbor-anchored dampener: a vessel that is both geometrically inside a declared
  // harbor and reporting an anchored/moored activity never contributes category score,
  // regardless of which detector produced the event.
  const act = lastActivity(s, geo, cfg);
  if ((act === "moored" || act === "anchored") && geo.inExclusion([ev.lon, ev.lat])) {
    return [];
  }

  const hits = new Map<ThreatCategory, SignalClass>();
  const raise = (cat: ThreatCategory, cls: SignalClass) => {
    const cur = hits.get(cat);
    if (!cur || CLASS_WEIGHT[cls] > CLASS_WEIGHT[cur]) hits.set(cat, cls);
  };
  const e = ev.evidence as Record<string, unknown>;

  switch (ev.type) {
    // ...existing switch body UNCHANGED — do NOT re-write, only prepend the gate above...
```

Do not touch anything below the switch. Do not re-order imports. `lastActivity` is already imported at line 3.

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- test/fusion.test.ts -t "harbor-anchored dampener"`
Expected: PASS (1 test).

- [ ] **Step 5: Run the full test suite for regression**

Run: `npm test`
Expected: All tests green, including the pre-existing "anchor drag is a strong cable signal" at `test/fusion.test.ts:29` — that test uses `noFc` (empty exclusions), so the gate is a no-op for it.

- [ ] **Step 6: Commit**

```bash
git add src/fusion.ts test/fusion.test.ts
git commit -m "fix(fusion): dampen signals for harbor-anchored vessels

signalsFor now returns [] when lastActivity is moored/anchored and
the event coord is inside a declared exclusion polygon. Stops anchor
swing motion in harbors that overlap cable corridors from opening
cable_interference assessments and painting red halos on the map.

Refs docs/superpowers/specs/2026-07-19-harbor-anchored-fusion-gate-design.md."
```

---

### Task 2: Add regression and boundary tests (lock the gate's scope)

**Files:**
- Test: `test/fusion.test.ts` — extend the "fusion: harbor-anchored dampener" describe block from Task 1

**Interfaces:**
- Consumes: `geoWithHarbor`, `anchoredState`, `harbor` helpers from Task 1's describe block.
- Produces: no new exports — test-only extension.

- [ ] **Step 1: Add three coverage tests inside the same describe block**

Inside the `describe("fusion: harbor-anchored dampener", () => { ... })` block from Task 1, append these three `it(...)` cases immediately after the first one:

```ts
  it("anchor_drag outside every exclusion still fires normally (regression guard)", () => {
    // No exclusions — proves the gate is scoped, not blanket.
    const geoNoHarbor = new GeoContext(cables as any, noFc as any, 1000, noFc as any, 5000);
    const s = anchoredState(102);
    const anchorDragEv = ev({
      type: "anchor_drag",
      id: "anchor_drag-102-1",
      evidence: { corridor: "C1", cogStdDeg: 80, meanSogKn: 1.2, displacementM: 200 },
    });
    const sig = signalsFor(anchorDragEv, s, geoNoHarbor, CONFIG);
    expect(sig).toEqual([expect.objectContaining({ category: "cable_interference", cls: "strong" })]);
    const changed = applyEventToFusion(s, anchorDragEv, geoNoHarbor, CONFIG, T0);
    expect(changed).toHaveLength(1);
    expect(changed[0]).toMatchObject({ category: "cable_interference", status: "open" });
  });

  it("loitering inside harbor + anchored produces no signal (fusion-layer symmetry)", () => {
    // The loitering detector already guards on !inExclusion, so this scenario cannot arise
    // in production for loitering. This test locks the fusion gate's symmetry across every
    // detector — if a future detector emits without a harbor guard, fusion still filters it.
    // The detector-level declaration at test/loitering.test.ts:67 (anchoring over a cable
    // OUTSIDE a declared harbor IS the threat) remains valid; the fusion gate only fires
    // when both harbor AND anchored hold.
    const s = anchoredState(103);
    expect(signalsFor(loiterEv("h1"), s, geoWithHarbor, CONFIG)).toEqual([]);
  });

  it("identity_change inside harbor + anchored suppresses entirely (tightens weak dampener)", () => {
    // Positive control below proves the OUTSIDE-harbor path still hits the existing weak
    // demotion at fusion.ts:80-82 (moored/anchored → weak, not medium).
    const idChangeEv = (mmsi: number) => ev({
      type: "identity",
      mmsi,
      id: `identity-${mmsi}-change`,
      evidence: { kind: "identity_change", prevName: "OLD", newName: "NEW", prevCallsign: "X1", newCallsign: "X2" },
    });

    // Inside harbor + anchored → suppressed.
    const sInside = anchoredState(104);
    expect(signalsFor(idChangeEv(104), sInside, geoWithHarbor, CONFIG)).toEqual([]);

    // Outside harbor + anchored → existing weak demotion still applies.
    const geoNoHarbor = new GeoContext(cables as any, noFc as any, 1000, noFc as any, 5000);
    const sOutside = anchoredState(105);
    const sigOutside = signalsFor(idChangeEv(105), sOutside, geoNoHarbor, CONFIG);
    expect(sigOutside).toEqual([expect.objectContaining({ category: "identity_deception", cls: "weak" })]);
  });
```

- [ ] **Step 2: Run the new tests**

Run: `npm test -- test/fusion.test.ts -t "harbor-anchored dampener"`
Expected: PASS (4 tests total — the original plus three new).

- [ ] **Step 3: Run the full test suite for regression**

Run: `npm test`
Expected: All tests green.

- [ ] **Step 4: Commit**

```bash
git add test/fusion.test.ts
git commit -m "test(fusion): lock harbor-anchored gate scope

Three coverage tests around the harbor-anchored dampener:
- anchor_drag OUTSIDE every exclusion still fires (scope proof)
- loitering INSIDE harbor + anchored is suppressed at fusion (documents
  symmetry across detectors; loitering detector's own guard makes this
  unreachable in production, but the fusion gate is the safety net)
- identity_change tightens: INSIDE harbor + anchored suppresses entirely
  while OUTSIDE harbor + anchored keeps the existing weak demotion"
```

---

### Task 3: Manual verification against the live pipeline

**Files:** none — this task exercises the running app, no source changes.

**Interfaces:** none.

- [ ] **Step 1: Start the worker**

Run: `npm run dev`
Expected: `wrangler dev` starts and binds `http://127.0.0.1:8787`. Leave it running in another terminal or as a backgrounded process.

- [ ] **Step 2: Materialize a fresh candidate set from the last 30 days**

Run: `npm run materialize -- --source=all --lookback-days=30 --origin=http://127.0.0.1:8787`
Expected: The command completes without error and prints a candidate count.

- [ ] **Step 3: Spot-check the live map**

Open `http://localhost:8787` in a browser. Zoom to any declared anchorage in `data/exclusions.json` (Kaohsiung, Keelung, Taichung, Busan, Kanmon/Hakata, Tokyo Bay, or Ise Bay). Ships whose most recent fixes fall inside the polygon should render as grey dots, not red pulsing halos.

Note: Pre-existing `cable_interference` assessments opened before this fix stay `open` until they decay past `assessmentCloseScore` for `assessmentCloseAfterMs` (per `fusion.ts:185`). If halos persist on the demo map, that is the natural-decay window described in the spec's Rollout section, not a broken fix.

- [ ] **Step 4: Invoke the verify skill**

Route the end-to-end check through the project's `verify` skill (or equivalent). Report the outcome.

- [ ] **Step 5: No commit for this task** — verification only.
