# Merge PR #1: Speed Anomaly + Route Deviation Threat Detectors

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Resolve merge conflicts in PR #1 (`feat/threat-typology-expansion`) and merge it into `main`.

**Architecture:** The PR adds speed anomaly and route deviation detectors (backend) plus filter chips (frontend). Since the PR was opened, `main` has diverged significantly with the East Asia expansion (regions, enriched dossier, timeline, intro modal). The conflicts are all cases where both branches modified the same lines — resolutions keep all features from both sides.

**Tech Stack:** TypeScript, MapLibre GL, Vite

## Global Constraints

- All 82+ tests must pass after merge
- Both day-filter (from main) and type-filter chips (from PR) must work in the event feed
- Region support (from main) must be preserved alongside new detector types

---

### Task 1: Resolve Conflicts and Complete Merge

**Files:**
- Modify: `src/aisstream.ts:39-56` (conflict)
- Modify: `src/pipeline.ts:62-73` (conflict)
- Modify: `src/types.ts:47-57, 73-79` (two conflicts)
- Modify: `web/index.html:22-26` (conflict)
- Modify: `web/src/panels.ts:126-137` (conflict)

**Interfaces:**
- Consumes: All existing code on both `main` and `feat/threat-typology-expansion`
- Produces: Clean merge combining all features from both branches

#### Conflict 1: `src/aisstream.ts` — Static data parsing

HEAD (main) already parses `shipType` plus `destination` and dimensions. The PR only adds `shipType`. **Resolution: keep HEAD entirely** — it's a strict superset.

- [ ] **Step 1: Resolve aisstream.ts**

Replace the conflict block (lines 39-56) with HEAD's version only:

```typescript
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
```

#### Conflict 2: `src/types.ts` — VesselState interface (two conflicts)

HEAD has `region`, `shipType`, `destination`, `dimBow/Stern/Port/Starboard`. PR only has `shipType`. **Resolution: keep HEAD** — it's a superset that already includes `shipType`.

- [ ] **Step 2: Resolve types.ts VesselState interface**

Replace the first conflict block (lines 47-57) with:

```typescript
  region: RegionId | null;
  shipType: number | null;
  destination: string | null;
  dimBow: number | null;
  dimStern: number | null;
  dimPort: number | null;
  dimStarboard: number | null;
```

- [ ] **Step 3: Resolve types.ts newVesselState factory**

Replace the second conflict block (lines 73-79) with:

```typescript
    mmsi, name: null, callsign: null,
    region: null, shipType: null, destination: null,
    dimBow: null, dimStern: null, dimPort: null, dimStarboard: null,
```

#### Conflict 3: `src/pipeline.ts` — handleStatic method

HEAD stores all enriched fields (shipType, destination, dimensions) and sets region on events. PR only stores shipType. **Resolution: keep HEAD** — it's a superset.

- [ ] **Step 4: Resolve pipeline.ts**

Replace the conflict block (lines 62-73) with:

```typescript
    if (ident.shipType != null) s.shipType = ident.shipType;
    if (ident.destination != null) s.destination = ident.destination;
    if (ident.dimBow != null) s.dimBow = ident.dimBow;
    if (ident.dimStern != null) s.dimStern = ident.dimStern;
    if (ident.dimPort != null) s.dimPort = ident.dimPort;
    if (ident.dimStarboard != null) s.dimStarboard = ident.dimStarboard;
    for (const ev of events) { ev.region = s.region; applyEventToScore(s, ev, this.cfg, ident.ts); }
```

#### Conflict 4: `web/index.html` — Event feed aside

HEAD has the 14-day timeline div. PR has filter-chips div. **Resolution: include both** — timeline first, then filter chips, then the event list.

- [ ] **Step 5: Resolve index.html**

Replace the conflict block (lines 22-26) with:

```html
  <aside id="event-feed"><h2>Live events</h2><div id="timeline" title="Events per day (last 14 days) — click a day to filter"></div><div id="filter-chips"></div><ol id="event-list"></ol></aside>
```

#### Conflict 5: `web/src/panels.ts` — Event polling

HEAD uses day-filter + region. PR uses type-filter (activeFilter). **Resolution: combine both filters** — apply day filter, region, AND type filter.

- [ ] **Step 6: Resolve panels.ts poll function**

Replace the conflict block (lines 126-137) with:

```typescript
      const f = getDayFilter();
      const since = f ? f.startTs : Date.now() - 24 * 3_600_000;
      const res = await fetchEvents(since, getRegion());
      let events = f ? res.events.filter((e) => e.startTs < f.endTs) : res.events;
      if (activeFilter) events = events.filter((e) => e.type === activeFilter);
      list.innerHTML = events.map(renderEvent).join("") ||
        `<li>${f ? `No events on ${f.day}` : "No events in the last 24 h"}</li>`;
```

### Task 2: Run Tests and Complete Merge

- [ ] **Step 7: Run the full test suite**

Run: `npx vitest run`
Expected: All tests pass (82+)

- [ ] **Step 8: Build the frontend**

Run: `cd web && npx vite build`
Expected: Build succeeds with no TypeScript errors

- [ ] **Step 9: Commit the merge**

```bash
git add -A
git commit -m "merge: resolve conflicts for PR #1 threat-typology-expansion

Combines speed anomaly + route deviation detectors with East Asia
expansion features. Conflict resolutions keep all features from both
branches: enriched static data, region support, day-filter timeline,
AND type-filter chips in the event feed."
```

- [ ] **Step 10: Push and close PR**

```bash
git push origin main
```

Then verify the PR is auto-closed by GitHub.
