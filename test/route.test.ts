// test/route.test.ts
import { describe, expect, it } from "vitest";
import { CONFIG } from "../src/config";
import { GeoContext } from "../src/geo/context";
import { newVesselState, type AisPosition } from "../src/types";
import { routeOnMessage } from "../src/detectors/route";

const cables = { type: "FeatureCollection", features: [{ type: "Feature", properties: { name: "C1", approximate: true }, geometry: { type: "LineString", coordinates: [[120.0, 22.0], [121.0, 22.0]] } }] };
const noExcl = { type: "FeatureCollection", features: [] };
const exclWithZone = { type: "FeatureCollection", features: [{ type: "Feature", properties: { name: "PORT" }, geometry: { type: "Polygon", coordinates: [[[118.9, 24.9], [119.1, 24.9], [119.1, 25.1], [118.9, 25.1], [118.9, 24.9]]] } }] };
const lanes = { type: "FeatureCollection", features: [{ type: "Feature", properties: { name: "MAIN-LANE" }, geometry: { type: "LineString", coordinates: [[119.5, 23.0], [120.5, 23.0]] } }] };
const T0 = 1_750_000_000_000;
const MIN = 60_000;

function makeGeo(excl: any = noExcl) {
  return new GeoContext(cables as any, excl as any, 1000, lanes as any, 5000);
}

function pos(mmsi: number, lon: number, lat: number, sog: number, cog: number, tMin: number): AisPosition {
  return { mmsi, lon, lat, sog, cog, heading: cog, ts: T0 + tMin * MIN };
}

function feedPositions(s: ReturnType<typeof newVesselState>, positions: AisPosition[], geo: GeoContext): any[] {
  const evs: any[] = [];
  for (const p of positions) {
    evs.push(...routeOnMessage(s, p, geo, CONFIG));
    s.ring.push(p);
    if (s.ring.length > CONFIG.ringSize) s.ring.shift();
    s.lastSeen = p.ts;
  }
  return evs;
}

describe("route deviation detector", () => {
  it("vessel reversing course 3 times in 15 positions fires course_reversals", () => {
    const s = newVesselState(1, T0);
    const geo = makeGeo();
    // COG sequence: 0, 180, 0, 180 (3 reversals of >= 90 deg)
    const cogs = [0, 180, 0, 180, 90, 90, 90, 90, 90, 90, 90, 90, 90, 90, 90];
    const positions = cogs.map((cog, i) => pos(1, 120.2, 22.5, 8, cog, i * 5));
    const evs = feedPositions(s, positions, geo);
    const reversals = evs.filter((e: any) => e.evidence.kind === "course_reversals");
    expect(reversals.length).toBeGreaterThanOrEqual(1);
    expect(reversals[0]).toMatchObject({ type: "route_deviation", severity: 3 });
  });

  it("vessel making one normal turn does NOT fire", () => {
    const s = newVesselState(2, T0);
    const geo = makeGeo();
    const cogs = [90, 90, 90, 90, 90, 180, 180, 180, 180, 180, 180, 180, 180, 180, 180];
    const positions = cogs.map((cog, i) => pos(2, 120.2, 22.5, 8, cog, i * 5));
    const evs = feedPositions(s, positions, geo);
    expect(evs.filter((e: any) => e.evidence?.kind === "course_reversals")).toHaveLength(0);
  });

  it("vessel circling (low displacement/distance ratio) fires circling", () => {
    const s = newVesselState(3, T0);
    const geo = makeGeo();
    // Create a circle: 12 positions around a point, each ~333m apart
    const cx = 120.3, cy = 22.5, r = 0.003; // ~333m radius
    const positions = Array.from({ length: 12 }, (_, i) => {
      const angle = (i / 12) * 2 * Math.PI;
      return pos(3, cx + r * Math.cos(angle), cy + r * Math.sin(angle), 3, (i * 30) % 360, i * 5);
    });
    const evs = feedPositions(s, positions, geo);
    const circling = evs.filter((e: any) => e.evidence?.kind === "circling");
    expect(circling.length).toBeGreaterThanOrEqual(1);
    expect(circling[0].type).toBe("route_deviation");
  });

  it("straight-line transit does NOT fire circling (ratio ~1.0)", () => {
    const s = newVesselState(4, T0);
    const geo = makeGeo();
    const positions = Array.from({ length: 12 }, (_, i) =>
      pos(4, 120.0 + i * 0.01, 22.5, 10, 90, i * 5));
    const evs = feedPositions(s, positions, geo);
    expect(evs.filter((e: any) => e.evidence?.kind === "circling")).toHaveLength(0);
  });

  it("stationary vessel with low displacement does NOT fire circling (minimum distance check)", () => {
    const s = newVesselState(5, T0);
    const geo = makeGeo();
    // 12 positions all at the same spot with negligible jitter
    const positions = Array.from({ length: 12 }, (_, i) =>
      pos(5, 120.3 + i * 0.000001, 22.5 + i * 0.000001, 0.1, i * 30, i * 5));
    const evs = feedPositions(s, positions, geo);
    expect(evs.filter((e: any) => e.evidence?.kind === "circling")).toHaveLength(0);
  });

  it("cargo vessel out of lane, over cable, at 10 kn for 6 positions fires lane_deviation at severity 4", () => {
    const s = newVesselState(6, T0);
    s.shipType = 70; // cargo
    const geo = makeGeo();
    // Position ON the cable (120.2, 22.0) but NOT in any lane
    const positions = Array.from({ length: 6 }, (_, i) =>
      pos(6, 120.2 + i * 0.001, 22.0, 10, 90, i * 5));
    const evs = feedPositions(s, positions, geo);
    const laneDevs = evs.filter((e: any) => e.evidence?.kind === "lane_deviation");
    expect(laneDevs.length).toBeGreaterThanOrEqual(1);
    expect(laneDevs[0].severity).toBe(4); // boosted because over cable corridor
  });

  it("same vessel in exclusion zone does NOT fire lane_deviation", () => {
    const s = newVesselState(7, T0);
    s.shipType = 70;
    const geo = makeGeo(exclWithZone);
    // Position inside the exclusion polygon
    const positions = Array.from({ length: 6 }, (_, i) =>
      pos(7, 119.0, 25.0, 10, 90, i * 5));
    const evs = feedPositions(s, positions, geo);
    expect(evs.filter((e: any) => e.evidence?.kind === "lane_deviation")).toHaveLength(0);
  });

  it("non-commercial vessel out of lane does NOT fire lane_deviation", () => {
    const s = newVesselState(8, T0);
    s.shipType = 30; // fishing — not commercial (70-79, 80-89)
    const geo = makeGeo();
    const positions = Array.from({ length: 6 }, (_, i) =>
      pos(8, 120.2, 22.0, 10, 90, i * 5));
    const evs = feedPositions(s, positions, geo);
    expect(evs.filter((e: any) => e.evidence?.kind === "lane_deviation")).toHaveLength(0);
  });

  it("cooldown: second event within 1 hour is suppressed", () => {
    const s = newVesselState(9, T0);
    const geo = makeGeo();
    const cogs = [0, 180, 0, 180, 90, 90, 90, 90, 90, 90, 90, 90, 90, 90, 90];
    const positions1 = cogs.map((cog, i) => pos(9, 120.2, 22.5, 8, cog, i * 5));
    const evs1 = feedPositions(s, positions1, geo);
    expect(evs1.length).toBeGreaterThanOrEqual(1);

    // second burst at T0 + 30 min
    const positions2 = cogs.map((cog, i) => pos(9, 120.2, 22.5, 8, cog, 90 + i * 1));
    const evs2 = feedPositions(s, positions2, geo);
    expect(evs2).toHaveLength(0);
  });
});
