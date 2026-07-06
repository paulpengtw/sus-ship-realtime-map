# Live Traffic Rendering + Sus-Ship Highlighting Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> Per the user's global delegation policy, code-writing steps go through the `codex:codex-rescue` subagent; the orchestrator owns test runs, git, and review.

**Goal:** Fix the silently-broken AIS ingest (binary WebSocket frames were never parsed) and redesign vessel rendering so all live traffic is visible and vessels with active detector events are aggressively highlighted.

**Architecture:** A pure `parseFrame` decoder in `src/aisstream.ts` fixes ingest and is unit-testable outside the Durable Object. `/api/snapshot` gains a LEFT JOIN against open `events` rows so each vessel feature carries `activeEvents`/`topType` (backend join — no client join, no new endpoints, no schema change). The web map replaces its single circle layer with a dot-fallback layer, a heading-rotated SDF-triangle layer, and a pulsing sus-halo layer; a pure `healthView` helper drives the fixed stale banner plus a new always-on status chip.

**Tech Stack:** Cloudflare Workers + Durable Objects + D1, vitest with `@cloudflare/vitest-pool-workers`, MapLibre GL JS 5, Vite, TypeScript strict.

**Spec:** `docs/superpowers/specs/2026-07-05-live-traffic-sus-highlight-design.md`

## Global Constraints

- Calm-traffic base grey is `#aab6c8`; score ramp stays grey → amber `#f0a83c` (score 3) → red `#e5484d` (score 8).
- Stationary/no-heading fallback threshold: `cog` missing **or `sog` < 0.5 kn** (pinned in spec).
- Sus halo pulse period ≈ **1.5 s**, sinusoidal, via `requestAnimationFrame`.
- Active-event flag comes from a **backend join in `/api/snapshot`** — never a client-side join or score-recency heuristic.
- No new endpoints, no D1 schema change; snapshot response changes are **additive properties only** (`activeEvents`, `topType`). The `region` filter keeps working.
- Open event = `end_ts IS NULL` **and** `start_ts` within the last 24 h.
- Triangle icon is an SDF generated in code — no asset files (only SDF icons can be tinted via `icon-color`).
- Sus triangles render ~1.5× larger and solid red, overriding the ramp.
- Out of scope: motion trails, clustering, server push, detector/scoring changes.
- Run tests with `npm test` (vitest run) from the repo root. All existing tests must stay green in every task.

## File Map

| File | Change |
|---|---|
| `src/aisstream.ts` | Add `FrameResult` type + `parseFrame()` (decode string/ArrayBuffer/view → JSON → existing `parseAisStreamMessage`) |
| `test/frame-decode.test.ts` | New — unit tests for `parseFrame` |
| `src/do/tracker.ts` | Use `parseFrame` in `onWsMessage`; aggregate parse-failure logging in `alarm()` |
| `src/worker.ts` | Snapshot query LEFT JOIN → `activeEvents`/`topType` feature properties |
| `test/api.test.ts` | New test for the snapshot join |
| `web/src/api.ts` | Extend `VesselProps` with `activeEvents`/`topType` |
| `web/src/vessels.ts` | Three-layer rendering (dots, triangles, pulsing halo), SDF triangle generator |
| `web/src/health.ts` | New — pure `healthView()` (banner + chip state) |
| `test/web-health.test.ts` | New — unit tests for `healthView` |
| `web/index.html` | Status-chip div + legend row for the sus halo |
| `web/style.css` | Status-chip + legend-swatch styles |

---

### Task 1: `parseFrame` — decode binary WebSocket frames

The root-cause bug: aisstream.io sends binary frames; `JSON.parse(String(ev.data))` turns an ArrayBuffer into `"[object ArrayBuffer]"` and throws on every message. Fix as a pure, unit-testable function.

**Files:**
- Modify: `src/aisstream.ts` (append after `parseAisStreamMessage`, which ends at line 58)
- Test: `test/frame-decode.test.ts` (create)

**Interfaces:**
- Consumes: existing `parseAisStreamMessage(raw: unknown)` in the same file (do not modify it).
- Produces (Task 2 relies on these exact names):
  ```ts
  export type FrameResult =
    | { kind: "ok"; pos?: AisPosition; ident?: AisIdentity }
    | { kind: "ignored" }   // decoded fine, but not a message type we use
    | { kind: "error" };    // frame could not be decoded or parsed
  export function parseFrame(data: unknown): FrameResult;
  ```

- [ ] **Step 1: Write the failing test**

Create `test/frame-decode.test.ts`:

```ts
// test/frame-decode.test.ts
import { describe, expect, it } from "vitest";
import { parseFrame } from "../src/aisstream";

const POSITION_MSG = {
  MessageType: "PositionReport",
  MetaData: { MMSI: 412000001, latitude: 22.0, longitude: 120.2, time_utc: "2026-07-04 12:34:56.789101 +0000 UTC" },
  Message: { PositionReport: { Sog: 5, Cog: 90, TrueHeading: 90 } },
};
const JSON_TEXT = JSON.stringify(POSITION_MSG);

describe("parseFrame", () => {
  it("parses a string frame", () => {
    const r = parseFrame(JSON_TEXT);
    expect(r.kind).toBe("ok");
    expect(r.kind === "ok" && r.pos?.mmsi).toBe(412000001);
  });

  it("parses an ArrayBuffer frame (aisstream sends binary)", () => {
    const buf = new TextEncoder().encode(JSON_TEXT).buffer as ArrayBuffer;
    const r = parseFrame(buf);
    expect(r.kind).toBe("ok");
    expect(r.kind === "ok" && r.pos?.mmsi).toBe(412000001);
  });

  it("parses a Uint8Array view frame", () => {
    const r = parseFrame(new TextEncoder().encode(JSON_TEXT));
    expect(r.kind).toBe("ok");
  });

  it("counts garbage as a parse error without throwing", () => {
    expect(parseFrame("not json").kind).toBe("error");
    expect(parseFrame(new Uint8Array([0xff, 0x00, 0x01]).buffer).kind).toBe("error");
    expect(parseFrame(12345).kind).toBe("error");
  });

  it("treats valid-but-irrelevant JSON as ignored, not an error", () => {
    expect(parseFrame('{"error":"Api Key Is Not Valid"}').kind).toBe("ignored");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- test/frame-decode.test.ts`
Expected: FAIL — `parseFrame` is not exported from `../src/aisstream`.

- [ ] **Step 3: Write the implementation**

Append to `src/aisstream.ts`:

```ts
export type FrameResult =
  | { kind: "ok"; pos?: AisPosition; ident?: AisIdentity }
  | { kind: "ignored" }   // decoded fine, but not a message type we use
  | { kind: "error" };    // frame could not be decoded or parsed

// aisstream.io delivers frames as binary (ArrayBuffer) — decode before JSON.parse.
export function parseFrame(data: unknown): FrameResult {
  try {
    let text: string;
    if (typeof data === "string") text = data;
    else if (data instanceof ArrayBuffer || ArrayBuffer.isView(data)) text = new TextDecoder().decode(data);
    else return { kind: "error" };
    const parsed = parseAisStreamMessage(JSON.parse(text));
    return parsed ? { kind: "ok", ...parsed } : { kind: "ignored" };
  } catch {
    return { kind: "error" };
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- test/frame-decode.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Run full suite, then commit**

Run: `npm test` — expect all green.

```bash
git add src/aisstream.ts test/frame-decode.test.ts
git commit -m "fix: decode binary aisstream WebSocket frames before JSON.parse"
```

---

### Task 2: Wire `parseFrame` into the Tracker DO with aggregated failure logging

**Files:**
- Modify: `src/do/tracker.ts` (imports at line 6, `onWsMessage` at lines 71–91, `alarm()` at line 103)

**Interfaces:**
- Consumes: `parseFrame` / `FrameResult` from Task 1.
- Produces: nothing new — behavior change only. A summary line `console.error("ws: N unparseable frames since last alarm")` at most once per alarm window (30 s, `CONFIG.alarmIntervalMs`).

No new unit test: the decode/parse logic is covered by Task 1, and the DO wiring is exercised by the existing smoke test plus the live verification in Task 6.

- [ ] **Step 1: Update the import**

In `src/do/tracker.ts` line 6, change:

```ts
import { parseAisStreamMessage } from "../aisstream";
```

to:

```ts
import { parseFrame } from "../aisstream";
```

- [ ] **Step 2: Add the failure counter field**

After line 19 (`private lastPruneAt = 0;`) add:

```ts
  private parseFailures = 0; // logged as one summary line per alarm window
```

- [ ] **Step 3: Replace `onWsMessage`**

Replace the whole method (lines 71–91) with:

```ts
  private onWsMessage(ev: MessageEvent): void {
    this.lastWsMessageAt = Date.now();
    // Per-message try/catch: one malformed message must not kill the handler (spec §6).
    try {
      const frame = parseFrame(ev.data);
      if (frame.kind === "error") { this.parseFailures++; return; }
      if (frame.kind === "ignored") return;
      if (frame.pos) {
        const events = this.tracker.handlePosition(frame.pos);
        this.pending.events.push(...events);
        this.pending.vessels.set(frame.pos.mmsi, this.tracker.states.get(frame.pos.mmsi)!);
        this.maybeQueuePosition(frame.pos);
      }
      if (frame.ident) {
        const events = this.tracker.handleStatic(frame.ident);
        this.pending.events.push(...events);
        this.pending.vessels.set(frame.ident.mmsi, this.tracker.states.get(frame.ident.mmsi)!);
      }
    } catch (err) {
      console.error("message handling error:", err);
    }
  }
```

- [ ] **Step 4: Log the summary in `alarm()`**

At the top of `alarm()`, right after `const now = Date.now();`, add:

```ts
    // 0. Aggregated parse-failure log: one line per window keeps `wrangler tail` readable.
    if (this.parseFailures > 0) {
      console.error(`ws: ${this.parseFailures} unparseable frames since last alarm`);
      this.parseFailures = 0;
    }
```

- [ ] **Step 5: Verify and commit**

Run: `npm test` — expect all green.
Run: `npx tsc --noEmit` — expect no errors.

```bash
git add src/do/tracker.ts
git commit -m "fix: use parseFrame in tracker DO; aggregate parse-failure logging"
```

---

### Task 3: Snapshot API — `activeEvents` / `topType` via backend join

**Files:**
- Modify: `src/worker.ts` (the `/api/snapshot` block, lines 45–71)
- Modify: `web/src/api.ts` (`VesselProps`, line 2)
- Test: `test/api.test.ts` (append a test to the existing `describe`)

**Interfaces:**
- Consumes: existing `events` table (`end_ts IS NULL` = open; `severity` INTEGER; `start_ts` ms epoch).
- Produces (Task 4 renders from these exact property names): every vessel feature's `properties` gains
  - `activeEvents: number` — count of open events (last 24 h) for that MMSI, `0` when none.
  - `topType: string | null` — `type` of the most severe open event, ties broken by most recent `start_ts`.

- [ ] **Step 1: Write the failing test**

Append inside the `describe("API worker", ...)` block of `test/api.test.ts` (the existing seed already gives 412000001 an open `loitering` event with severity 3 at `T0`):

```ts
  it("/api/snapshot joins open events into activeEvents/topType", async () => {
    await env.DB.batch([
      env.DB.prepare(`INSERT INTO vessels (mmsi, name, callsign, last_lon, last_lat, last_sog, last_cog, last_ts, score, score_ts)
                      VALUES (412000003, 'CALM SHIP', NULL, 121.5, 24.0, 8, 45, ?1, 0, ?1)`).bind(T0),
      // higher-severity open event for 412000001 — must win topType over the seeded loitering (sev 3)
      env.DB.prepare(`INSERT INTO events (id, type, severity, mmsi, lon, lat, start_ts, end_ts, evidence)
                      VALUES ('gap-412000001-1', 'gap', 4, 412000001, 120.2, 22.0, ?1, NULL, '{}')`).bind(T0 - 1000),
      // closed event for 412000003 — must not count
      env.DB.prepare(`INSERT INTO events (id, type, severity, mmsi, lon, lat, start_ts, end_ts, evidence)
                      VALUES ('speed-412000003-1', 'speed_anomaly', 2, 412000003, 121.5, 24.0, ?1, ?2, '{}')`).bind(T0 - 5000, T0 - 4000),
      // open but older than 24 h — must not count either
      env.DB.prepare(`INSERT INTO events (id, type, severity, mmsi, lon, lat, start_ts, end_ts, evidence)
                      VALUES ('loitering-412000003-old', 'loitering', 3, 412000003, 121.5, 24.0, ?1, NULL, '{}')`).bind(Date.now() - 25 * 3_600_000),
    ]);
    const body = await (await SELF.fetch("https://x/api/snapshot")).json<any>();
    const props = Object.fromEntries(body.vessels.features.map((f: any) => [f.properties.mmsi, f.properties]));
    expect(props[412000001].activeEvents).toBe(2);   // seeded loitering + gap
    expect(props[412000001].topType).toBe("gap");    // severity 4 beats 3
    expect(props[412000003].activeEvents).toBe(0);   // closed + stale-open events excluded
    expect(props[412000003].topType).toBeNull();
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- test/api.test.ts`
Expected: FAIL — `activeEvents` is `undefined`, not `2`.

- [ ] **Step 3: Implement the join**

In `src/worker.ts`, replace the query block inside `/api/snapshot` (currently lines 48–52):

```ts
      const eventsSince = now - 86_400_000; // open events older than 24 h don't flag a vessel
      const baseSelect = `
        SELECT v.*, COALESCE(ev.active_events, 0) AS active_events, ev.top_type
        FROM vessels v
        LEFT JOIN (
          SELECT e.mmsi, COUNT(*) AS active_events,
                 (SELECT e2.type FROM events e2
                  WHERE e2.mmsi = e.mmsi AND e2.end_ts IS NULL AND e2.start_ts >= ?2
                  ORDER BY e2.severity DESC, e2.start_ts DESC LIMIT 1) AS top_type
          FROM events e
          WHERE e.end_ts IS NULL AND e.start_ts >= ?2
          GROUP BY e.mmsi
        ) ev ON ev.mmsi = v.mmsi`;
      const { results } = region
        ? await env.DB.prepare(`${baseSelect} WHERE v.last_ts >= ?1 AND v.region = ?3 ORDER BY v.score DESC`)
            .bind(now - CONFIG.snapshotWindowMs, eventsSince, region).all<any>()
        : await env.DB.prepare(`${baseSelect} WHERE v.last_ts >= ?1 ORDER BY v.score DESC`)
            .bind(now - CONFIG.snapshotWindowMs, eventsSince).all<any>();
```

Then in the feature-mapping `properties` object (currently lines 62–67), add two properties after `shipType`:

```ts
              activeEvents: r.active_events,
              topType: r.top_type ?? null,
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- test/api.test.ts`
Expected: PASS (all 6 tests, including the new one).

- [ ] **Step 5: Mirror the types in the web client**

In `web/src/api.ts` line 2, change `VesselProps` to:

```ts
export interface VesselProps { mmsi: number; name: string | null; sog: number; cog: number; score: number; lastTs: number; region: string | null; shipType: number | null; activeEvents: number; topType: string | null }
```

- [ ] **Step 6: Verify and commit**

Run: `npm test` and `npx tsc --noEmit` — expect all green / no errors.

```bash
git add src/worker.ts web/src/api.ts test/api.test.ts
git commit -m "feat: snapshot vessels carry activeEvents/topType via open-events join"
```

---

### Task 4: Three-layer vessel rendering with SDF triangles and pulsing halo

Pure rendering — no unit tests are practical here; verification is typecheck + build in this task and visual/e2e in Task 6.

**Files:**
- Modify: `web/src/vessels.ts` (full rewrite, contents below)
- Modify: `web/index.html` (legend, line 33 area)
- Modify: `web/style.css` (legend swatch)

**Interfaces:**
- Consumes: `activeEvents` feature property from Task 3 (`["coalesce", ["get", "activeEvents"], 0]` so pre-deploy caches don't break); existing `score`, `cog`, `sog` properties; `map` from `./main`; `fetchSnapshot`/`fetchGfw` from `./api`.
- Produces: layer ids `vessels-dot`, `vessels`, `sus-halo` (Task 5 leaves them untouched); `initVessels(onSelect)` signature unchanged so `main.ts` needs no edit. `setStaleBanner` behavior unchanged in this task (Task 5 replaces it).

- [ ] **Step 1: Rewrite `web/src/vessels.ts`**

Replace the entire file with:

```ts
// web/src/vessels.ts
import type { GeoJSONSource } from "maplibre-gl";
import { fetchGfw, fetchSnapshot } from "./api";
import { map } from "./main";

const POLL_MS = 15_000;
const STALE_MS = 5 * 60_000; // keep in sync with CONFIG.staleAfterMs
const PULSE_MS = 1500;       // sus-halo pulse period (spec: ~1.5 s)

// A vessel is "sus" when the backend reports an open detector event.
// coalesce keeps old cached snapshots (no activeEvents property) rendering as calm.
const SUS_ACTIVE = [">", ["coalesce", ["get", "activeEvents"], 0], 0] as any;
// grey → amber → red by suspicion score; solid red overrides the ramp while an event is open.
const COLOR = ["case", SUS_ACTIVE, "#ff2b2b",
  ["interpolate", ["linear"], ["get", "score"], 0, "#aab6c8", 3, "#f0a83c", 8, "#e5484d"]] as any;
// Heading is only trustworthy when the vessel is actually moving (spec: sog >= 0.5 kn).
const HAS_HEADING = ["all", ["has", "cog"], [">=", ["coalesce", ["get", "sog"], 0], 0.5]] as any;

function setStaleBanner(newestTs: number | null): void {
  const el = document.getElementById("stale-banner")!;
  if (newestTs !== null && Date.now() - newestTs > STALE_MS) {
    const t = new Date(newestTs);
    el.textContent = `⚠ data stale since ${String(t.getHours()).padStart(2, "0")}:${String(t.getMinutes()).padStart(2, "0")}`;
    el.hidden = false;
  } else {
    el.hidden = true;
  }
}

// Generated SDF so MapLibre can tint the icon via icon-color (only SDF icons are tintable).
// TinySDF-style encoding: alpha ≈ 191 (0.75) at the shape edge, higher inside, lower outside.
function triangleSdfImage(size = 64): { width: number; height: number; data: Uint8Array } {
  const v: [number, number][] = [
    [0.5 * size, 0.06 * size],  // tip — points up = direction of travel at icon-rotate 0
    [0.88 * size, 0.94 * size], // starboard base corner
    [0.12 * size, 0.94 * size], // port base corner
  ];
  const segDist = (px: number, py: number, [ax, ay]: [number, number], [bx, by]: [number, number]): number => {
    const dx = bx - ax, dy = by - ay;
    const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)));
    return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
  };
  const data = new Uint8Array(size * size * 4);
  const radius = size / 8; // distance-field falloff
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const px = x + 0.5, py = y + 0.5;
      let inside = true;
      let d = Infinity;
      for (let i = 0; i < 3; i++) {
        const a = v[i], b = v[(i + 1) % 3];
        d = Math.min(d, segDist(px, py, a, b));
        // with this winding, interior points have a positive cross product on every edge
        if ((b[0] - a[0]) * (py - a[1]) - (b[1] - a[1]) * (px - a[0]) < 0) inside = false;
      }
      const signedOutside = inside ? -d : d;
      const alpha = Math.max(0, Math.min(255, Math.round(255 - 255 * (signedOutside / radius + 0.25))));
      data[(y * size + x) * 4 + 3] = alpha;
    }
  }
  return { width: size, height: size, data };
}

async function poll(): Promise<void> {
  try {
    const snap = await fetchSnapshot();
    (map.getSource("vessels") as GeoJSONSource | undefined)?.setData(snap.vessels as any);
    setStaleBanner(snap.newestTs);
  } catch (err) {
    console.error("snapshot poll failed:", err);
    setStaleBanner(0); // unreachable API = stale (spec §6: never silently show stale data)
  }
}

function startPulse(): void {
  const frame = (t: number): void => {
    const s = (Math.sin(((t % PULSE_MS) / PULSE_MS) * 2 * Math.PI) + 1) / 2; // 0→1 sinusoid
    if (map.getLayer("sus-halo")) {
      map.setPaintProperty("sus-halo", "circle-radius", 10 + 8 * s);
      map.setPaintProperty("sus-halo", "circle-stroke-opacity", 0.9 - 0.6 * s);
    }
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
}

export function initVessels(onSelect: (mmsi: number) => void): void {
  map.addImage("vessel-triangle", triangleSdfImage(), { sdf: true });

  map.addSource("vessels", { type: "geojson", data: { type: "FeatureCollection", features: [] } });
  map.addSource("gfw", { type: "geojson", data: { type: "FeatureCollection", features: [] } });

  // GFW-confirmed (delayed) — distinct hollow diamond style under the live layers.
  map.addLayer({ id: "gfw-events", type: "circle", source: "gfw",
    paint: { "circle-radius": 7, "circle-color": "transparent", "circle-stroke-color": "#b18cff", "circle-stroke-width": 1.5 } });

  // Dot fallback: stationary vessels or no usable heading.
  map.addLayer({
    id: "vessels-dot", type: "circle", source: "vessels",
    filter: ["!", HAS_HEADING],
    paint: {
      "circle-color": COLOR,
      "circle-radius": ["case", SUS_ACTIVE, 5.5, 3.5],
      "circle-stroke-color": "#0b1220", "circle-stroke-width": 1,
      "circle-opacity": 0.95,
    },
  });

  // Heading-rotated triangles, MarineTraffic-style. Sus icons render ~1.5× larger.
  map.addLayer({
    id: "vessels", type: "symbol", source: "vessels",
    filter: HAS_HEADING,
    layout: {
      "icon-image": "vessel-triangle",
      "icon-size": ["case", SUS_ACTIVE, 0.3, 0.2], // 64 px SDF → ~13 px calm, ~19 px sus
      "icon-rotate": ["get", "cog"],
      "icon-rotation-alignment": "map",
      "icon-allow-overlap": true,
      "icon-ignore-placement": true,
    },
    paint: { "icon-color": COLOR, "icon-halo-color": "#0b1220", "icon-halo-width": 0.5 },
  });

  // Pulsing red halo for vessels with open events — drawn above all traffic.
  map.addLayer({
    id: "sus-halo", type: "circle", source: "vessels",
    filter: SUS_ACTIVE,
    paint: {
      "circle-radius": 10, "circle-color": "transparent",
      "circle-stroke-color": "#ff2b2b", "circle-stroke-width": 2, "circle-stroke-opacity": 0.9,
    },
  });

  for (const layer of ["vessels", "vessels-dot"]) {
    map.on("click", layer, (e) => {
      const f = e.features?.[0];
      if (f) onSelect((f.properties as any).mmsi);
    });
    map.on("mouseenter", layer, () => { map.getCanvas().style.cursor = "pointer"; });
    map.on("mouseleave", layer, () => { map.getCanvas().style.cursor = ""; });
  }

  startPulse();
  void poll();
  setInterval(poll, POLL_MS);

  void fetchGfw().then((g) => {
    (map.getSource("gfw") as GeoJSONSource).setData({
      type: "FeatureCollection",
      features: g.events.map((ev) => ({
        type: "Feature", geometry: { type: "Point", coordinates: [ev.lon, ev.lat] },
        properties: { id: ev.id, type: ev.type, gfw: true },
      })),
    } as any);
  }).catch((err) => console.error("gfw layer failed:", err));
}
```

- [ ] **Step 2: Add a legend row for the halo**

In `web/index.html`, after the score-ramp legend row (line 33), add:

```html
    <div class="legend-row"><span class="swatch sus"></span> Pulsing red ring = active detector event</div>
```

In `web/style.css`, next to the other `.swatch` rules, add:

```css
.swatch.sus { background: transparent; border: 2px solid #ff2b2b; border-radius: 50%; }
```

- [ ] **Step 3: Verify typecheck, build, and tests**

Run: `npx tsc --noEmit` — expect no errors (web files are built by vite; the root tsconfig covers src/test/scripts only, so also run the build).
Run: `npm run build:web` — expect a successful vite build.
Run: `npm test` — expect all green.

- [ ] **Step 4: Commit**

```bash
git add web/src/vessels.ts web/index.html web/style.css
git commit -m "feat: triangle traffic layer + pulsing red halo for vessels with open events"
```

---

### Task 5: System-health visibility — fixed banner + status chip

**Files:**
- Create: `web/src/health.ts`
- Test: `test/web-health.test.ts` (create; pure-function test like `test/web-dossier.test.ts`)
- Modify: `web/src/vessels.ts` (replace `setStaleBanner` with `applyHealth`)
- Modify: `web/index.html` (chip element, after line 21's `#stale-banner`)
- Modify: `web/style.css` (chip styles)

**Interfaces:**
- Consumes: `snap.newestTs` and `snap.vessels.features.length` inside `poll()` (Task 4's version of `vessels.ts`).
- Produces:
  ```ts
  export interface HealthView {
    bannerHidden: boolean;
    bannerText: string;
    chipLive: boolean;  // true → green "live" styling, false → amber "stale" styling
    chipText: string;
  }
  export function healthView(newestTs: number | null, vesselCount: number, now: number, staleMs: number): HealthView;
  ```

- [ ] **Step 1: Write the failing test**

Create `test/web-health.test.ts`:

```ts
// test/web-health.test.ts
import { describe, expect, it } from "vitest";
import { healthView } from "../web/src/health";

const NOW = 1_800_000_000_000;
const STALE = 5 * 60_000;

describe("healthView", () => {
  it("null newestTs shows ingest-down banner and amber no-data chip", () => {
    const h = healthView(null, 0, NOW, STALE);
    expect(h.bannerHidden).toBe(false);
    expect(h.bannerText).toContain("no vessel data received yet");
    expect(h.chipLive).toBe(false);
    expect(h.chipText).toBe("● no data");
  });

  it("fresh data hides the banner and shows a green live chip with count", () => {
    const h = healthView(NOW - 10_000, 42, NOW, STALE);
    expect(h.bannerHidden).toBe(true);
    expect(h.chipLive).toBe(true);
    expect(h.chipText).toBe("● live — 42 vessels");
  });

  it("stale data shows a time-stamped banner and amber chip", () => {
    const h = healthView(NOW - 10 * 60_000, 7, NOW, STALE);
    expect(h.bannerHidden).toBe(false);
    expect(h.bannerText).toMatch(/^⚠ data stale since \d{2}:\d{2}$/);
    expect(h.chipLive).toBe(false);
    expect(h.chipText).toBe("● stale — 7 vessels");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- test/web-health.test.ts`
Expected: FAIL — cannot resolve `../web/src/health`.

- [ ] **Step 3: Implement `web/src/health.ts`**

```ts
// web/src/health.ts — pure state derivation so it is unit-testable; DOM writes live in vessels.ts.
export interface HealthView {
  bannerHidden: boolean;
  bannerText: string;
  chipLive: boolean;  // true → green "live" styling, false → amber "stale" styling
  chipText: string;
}

export function healthView(newestTs: number | null, vesselCount: number, now: number, staleMs: number): HealthView {
  if (newestTs === null) {
    // An empty database is the system at its most broken — never hide the warning (spec §4).
    return { bannerHidden: false, bannerText: "⚠ no vessel data received yet — ingest may be down",
             chipLive: false, chipText: "● no data" };
  }
  if (now - newestTs > staleMs) {
    const t = new Date(newestTs);
    const hhmm = `${String(t.getHours()).padStart(2, "0")}:${String(t.getMinutes()).padStart(2, "0")}`;
    return { bannerHidden: false, bannerText: `⚠ data stale since ${hhmm}`,
             chipLive: false, chipText: `● stale — ${vesselCount} vessels` };
  }
  return { bannerHidden: true, bannerText: "", chipLive: true, chipText: `● live — ${vesselCount} vessels` };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- test/web-health.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Wire into `vessels.ts`**

In `web/src/vessels.ts` (Task 4 version): add the import, delete `setStaleBanner`, add `applyHealth`, and update `poll()`.

Add to imports:

```ts
import { healthView } from "./health";
```

Replace the `setStaleBanner` function with:

```ts
function applyHealth(newestTs: number | null, vesselCount: number): void {
  const h = healthView(newestTs, vesselCount, Date.now(), STALE_MS);
  const banner = document.getElementById("stale-banner")!;
  banner.hidden = h.bannerHidden;
  banner.textContent = h.bannerText;
  const chip = document.getElementById("status-chip")!;
  chip.textContent = h.chipText;
  chip.classList.toggle("live", h.chipLive);
  chip.classList.toggle("stale", !h.chipLive);
}
```

Replace `poll()` with:

```ts
async function poll(): Promise<void> {
  try {
    const snap = await fetchSnapshot();
    (map.getSource("vessels") as GeoJSONSource | undefined)?.setData(snap.vessels as any);
    applyHealth(snap.newestTs, snap.vessels.features.length);
  } catch (err) {
    console.error("snapshot poll failed:", err);
    applyHealth(0, 0); // unreachable API = stale (spec §6: never silently show stale data)
  }
}
```

- [ ] **Step 6: Add the chip element and styles**

In `web/index.html`, directly after `<div id="stale-banner" hidden></div>` (line 21), add:

```html
  <div id="status-chip" class="stale">● connecting…</div>
```

In `web/style.css`, after the `#stale-banner` rule, add:

```css
#status-chip {
  position: absolute; bottom: 40px; left: 12px; z-index: 20;
  background: var(--panel); backdrop-filter: blur(6px);
  border-radius: 12px; padding: 4px 10px; font-size: 12px;
}
#status-chip.live { color: #4ade80; }
#status-chip.stale { color: var(--amber); }
```

- [ ] **Step 7: Verify and commit**

Run: `npm test` — all green.
Run: `npm run build:web` — successful build.

```bash
git add web/src/health.ts web/src/vessels.ts web/index.html web/style.css test/web-health.test.ts
git commit -m "feat: always-on health chip; stale banner warns when DB is empty"
```

---

### Task 6: Deploy and end-to-end verification against live traffic

The ingest fix can only be proven against the real aisstream feed. `AISSTREAM_KEY` is already set on the deployed worker (`cable-guard` in `wrangler.jsonc`).

**Files:** none (verification only; no code changes expected).

- [ ] **Step 1: Final local gate**

Run: `npm test` and `npx tsc --noEmit` — all green before deploying.

- [ ] **Step 2: Deploy**

Run: `npm run deploy`
Expected: vite build then `wrangler deploy` succeed; note the printed `https://cable-guard.<subdomain>.workers.dev` URL (call it `$URL` below).

- [ ] **Step 3: Confirm ingest is alive**

Run (background, ~3 minutes): `npx wrangler tail cable-guard --format pretty`
Expected: NO stream of `message handling error: SyntaxError` lines. At most occasional `ws: N unparseable frames since last alarm` summaries.

Then poll the API a few times over ~5 minutes:

```bash
curl -s "$URL/api/snapshot" | jq '{newestTs, count: (.vessels.features | length)}'
```

Expected: `count` climbs above 0 and `newestTs` is recent (within the last few minutes). East Asian shipping lanes are busy; hundreds of vessels within 10 minutes is normal.

- [ ] **Step 4: Confirm the new properties**

```bash
curl -s "$URL/api/snapshot" | jq '.vessels.features[0].properties | {mmsi, activeEvents, topType}'
```

Expected: `activeEvents` is a number (usually `0`), `topType` present (usually `null`).

- [ ] **Step 5: Visual check**

Open `$URL` in a browser (or via Playwright screenshot if headless):
- Bright grey triangles/dots visible over the sea lanes; triangles point along the direction of travel.
- Status chip bottom-left reads `● live — N vessels` in green.
- Stale banner hidden.

- [ ] **Step 6: Verify the sus treatment**

If `curl -s "$URL/api/events" | jq '[.events[] | select(.endTs == null)] | length'` is `0` (no real open events right now), synthesize one on the most recently seen vessel:

```bash
npx wrangler d1 execute cable-guard --remote --command "INSERT INTO events (id, type, severity, mmsi, lon, lat, start_ts, end_ts, evidence) SELECT 'verify-' || mmsi, 'loitering', 3, mmsi, last_lon, last_lat, last_ts, NULL, '{}' FROM vessels ORDER BY last_ts DESC LIMIT 1"
```

Reload the map. Expected: that vessel renders solid red, ~1.5× larger, with a pulsing red ring (~1.5 s period). Then clean up:

```bash
npx wrangler d1 execute cable-guard --remote --command "DELETE FROM events WHERE id LIKE 'verify-%'"
```

- [ ] **Step 7: Verify empty-DB banner logic (local)**

Run `npx wrangler dev` against a fresh local D1 (no seed), open the local URL.
Expected: banner reads "⚠ no vessel data received yet — ingest may be down" and the chip shows amber `● no data`. Stop the dev server.

- [ ] **Step 8: Commit any verification fixes and push**

If Steps 3–7 forced code changes, re-run `npm test` and commit them individually. Then:

```bash
git push origin main
```

---

## Self-Review Notes

- Spec §1 (ingest fix + aggregated logging) → Tasks 1–2. §2 (snapshot join) → Task 3. §3 (three layers, SDF triangle, 0.5 kn fallback, 1.5× red emphasis, pulse) → Task 4. §4 (banner fix + status chip) → Task 5. §5 (frame-decode tests, join tests, live e2e + synthetic sus vessel) → Tasks 1, 3, 6.
- `activeEvents`/`topType` names are identical in Task 3 (API), Task 3 Step 5 (client types), and Task 4 (layer expressions). Layer ids `vessels`, `vessels-dot`, `sus-halo` are consistent between Task 4 and the pulse loop.
- Click/hover handlers, dossier panel, filter chips, and the GFW layer are preserved exactly (spec: unchanged).
- The spec's "Blob" case cannot occur on Workers WebSockets (frames arrive as `string | ArrayBuffer`); `parseFrame` additionally accepts `ArrayBufferView` defensively, which covers every runtime shape.
