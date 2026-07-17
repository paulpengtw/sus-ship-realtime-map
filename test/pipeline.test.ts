// test/pipeline.test.ts
import { describe, expect, it } from "vitest";
import { CONFIG } from "../src/config";
import { GeoContext } from "../src/geo/context";
import { Tracker } from "../src/pipeline";
import type { AisPosition } from "../src/types";

const cables = { type: "FeatureCollection", features: [{ type: "Feature", properties: { name: "C1", approximate: true }, geometry: { type: "LineString", coordinates: [[120.0, 22.0], [121.0, 22.0]] } }] };
const geo = new GeoContext(cables as any, { type: "FeatureCollection", features: [] } as any, 1000, { type: "FeatureCollection", features: [] } as any, 5000);
const T0 = 1_750_000_000_000;
const pos = (mmsi: number, lon: number, lat: number, sog: number, tMin: number): AisPosition =>
  ({ mmsi, lon, lat, sog, cog: 90, heading: 90, ts: T0 + tMin * 60_000 });

describe("Tracker pipeline", () => {
  it("end-to-end: loiterer over cable raises event and score", () => {
    const t = new Tracker(geo, CONFIG);
    const evs: any[] = [];
    for (let m = 0; m <= 130; m += 10) evs.push(...t.handlePosition(pos(1, 120.2, 22.0, 0.5, m)));
    expect(evs.filter((e) => e.type === "loitering")).toHaveLength(1);
    const s = t.states.get(1)!;
    expect(s.score).toBeGreaterThanOrEqual(3);
    expect(s.ring.length).toBe(14);
    expect(s.lastSeen).toBe(T0 + 130 * 60_000);
  });

  it("tick() opens gaps for silent vessels with healthy prior cadence", () => {
    const t = new Tracker(geo, CONFIG);
    for (let m = 0; m <= 40; m += 10) t.handlePosition(pos(2, 120.5, 22.0, 5, m));
    const evs = t.tick(T0 + (40 + 90) * 60_000);
    expect(evs).toHaveLength(1);
    expect(evs[0].type).toBe("ais_gap");
  });

  it("ring is capped at cfg.ringSize", () => {
    const t = new Tracker(geo, CONFIG);
    for (let i = 0; i < CONFIG.ringSize + 30; i++) t.handlePosition(pos(3, 119.0, 23.0, 10, i));
    expect(t.states.get(3)!.ring.length).toBe(CONFIG.ringSize);
  });

  it("a throwing detector cannot kill ingest", () => {
    const badGeo = new GeoContext(cables as any, { type: "FeatureCollection", features: [] } as any, 1000);
    (badGeo as any).inCorridor = () => { throw new Error("boom"); };
    const t = new Tracker(badGeo, CONFIG);
    expect(() => t.handlePosition(pos(4, 120.2, 22.0, 0.5, 0))).not.toThrow();
    expect(t.states.get(4)!.ring.length).toBe(1); // state still updated
  });

  it("handleStatic records identity and fires on swap", () => {
    const t = new Tracker(geo, CONFIG);
    t.handleStatic({ mmsi: 5, name: "A", callsign: "BV111", shipType: null, ts: T0 });
    const evs = t.handleStatic({ mmsi: 5, name: "B", callsign: "BV111", shipType: null, ts: T0 + 3_600_000 });
    expect(evs.some((e) => e.type === "identity")).toBe(true);
  });

  it("handleStatic records shipType on VesselState", () => {
    const t = new Tracker(geo, CONFIG);
    t.handleStatic({ mmsi: 10, name: "CARGO SHIP", callsign: "BXYZ9", shipType: 70, ts: T0 });
    expect(t.states.get(10)!.shipType).toBe(70);
  });

  it("speed anomaly fires through pipeline for fishing vessel at excessive speed", () => {
    const t = new Tracker(geo, CONFIG);
    t.handleStatic({ mmsi: 11, name: "FAST FISHER", callsign: "BXYZ8", shipType: 30, ts: T0 });
    const evs: any[] = [];
    for (let i = 0; i < 5; i++) {
      evs.push(...t.handlePosition(pos(11, 120.2, 22.0, 15, i * 5)));
    }
    expect(evs.some((e) => e.type === "speed_anomaly")).toBe(true);
  });

  it("route deviation fires through pipeline for circling vessel", () => {
    const t = new Tracker(geo, CONFIG);
    const evs: any[] = [];
    const cx = 120.3, cy = 22.5, r = 0.003;
    // 10 points = cfg.routeCircleMinPositions, closing the loop (matches test/route.test.ts pattern).
    // 12 points would leave only a 300° arc in the 10-position window (slice(-10)), whose
    // displacement/distance ratio (~0.30-0.32) never dips under routeCircleMaxRatio (0.3).
    for (let i = 0; i < 10; i++) {
      const angle = (i / 10) * 2 * Math.PI;
      evs.push(...t.handlePosition({
        mmsi: 12, lon: cx + r * Math.cos(angle), lat: cy + r * Math.sin(angle),
        sog: 3, cog: (i * 36) % 360, heading: (i * 36) % 360, ts: T0 + i * 5 * 60_000,
      }));
    }
    expect(evs.some((e) => e.type === "route_deviation")).toBe(true);
  });
});
