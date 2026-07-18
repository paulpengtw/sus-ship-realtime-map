// test/speed.test.ts
import { describe, expect, it } from "vitest";
import { CONFIG } from "../src/config";
import { GeoContext } from "../src/geo/context";
import { newVesselState, type AisPosition } from "../src/types";
import { SHIP_TYPE_MAX_SOG, speedOnMessage } from "../src/detectors/speed";

const cables = { type: "FeatureCollection", features: [{ type: "Feature", properties: { name: "C1", approximate: true }, geometry: { type: "LineString", coordinates: [[120.0, 22.0], [121.0, 22.0]] } }] };
const noExcl = { type: "FeatureCollection", features: [] };
const noLanes = { type: "FeatureCollection", features: [] };
const geo = new GeoContext(cables as any, noExcl as any, 1000, noLanes as any, 5000);
const T0 = 1_750_000_000_000;
const MIN = 60_000;

function pos(mmsi: number, lon: number, lat: number, sog: number, tMin: number): AisPosition {
  return { mmsi, lon, lat, sog, cog: 90, heading: 90, ts: T0 + tMin * MIN };
}

function feedPositions(s: ReturnType<typeof newVesselState>, positions: AisPosition[]): any[] {
  const evs: any[] = [];
  for (const p of positions) {
    evs.push(...speedOnMessage(s, p, geo, CONFIG));
    s.ring.push(p);
    if (s.ring.length > CONFIG.ringSize) s.ring.shift();
    s.lastSeen = p.ts;
  }
  return evs;
}

describe("speed anomaly detector", () => {
  it("SHIP_TYPE_MAX_SOG has the expected entries", () => {
    expect(SHIP_TYPE_MAX_SOG[30]).toBe(12);  // fishing
    expect(SHIP_TYPE_MAX_SOG[70]).toBe(18);  // cargo
    expect(SHIP_TYPE_MAX_SOG[80]).toBe(16);  // tanker
  });

  it("fishing vessel doing 15 kn for 5 consecutive positions fires type_mismatch", () => {
    const s = newVesselState(1, T0);
    s.shipType = 30; // fishing
    const positions = Array.from({ length: 5 }, (_, i) => pos(1, 120.2, 22.0, 15, i * 5));
    const evs = feedPositions(s, positions);
    expect(evs).toHaveLength(1);
    expect(evs[0]).toMatchObject({
      type: "speed_anomaly", severity: 4, mmsi: 1,
    });
    expect(evs[0].evidence).toMatchObject({
      kind: "type_mismatch", shipType: 30, expectedMaxKn: 12,
    });
  });

  it("cargo vessel doing 15 kn does NOT fire (within range)", () => {
    const s = newVesselState(2, T0);
    s.shipType = 70; // cargo, max 18
    const positions = Array.from({ length: 5 }, (_, i) => pos(2, 120.2, 22.0, 15, i * 5));
    const evs = feedPositions(s, positions);
    expect(evs).toHaveLength(0);
  });

  it("vessel with unknown shipType does NOT fire type_mismatch", () => {
    const s = newVesselState(3, T0);
    s.shipType = null;
    const positions = Array.from({ length: 5 }, (_, i) => pos(3, 120.2, 22.0, 25, i * 5));
    const evs = feedPositions(s, positions);
    expect(evs).toHaveLength(0);
  });

  it("vessel with 4 speed changes of 7 kn delta in 20 positions fires sudden_changes", () => {
    const s = newVesselState(4, T0);
    // create a zigzag pattern: alternate 3 kn and 10 kn every 3 minutes
    const sogs = [3, 10, 3, 10, 3, 10, 3, 10, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3];
    const positions = sogs.map((sog, i) => pos(4, 120.2, 22.0, sog, i * 3));
    const evs = feedPositions(s, positions);
    expect(evs.length).toBeGreaterThanOrEqual(1);
    const sudden = evs.find((e: any) => e.evidence.kind === "sudden_changes");
    expect(sudden).toBeDefined();
    expect(sudden!.type).toBe("speed_anomaly");
  });

  it("vessel with 1 speed change does NOT fire", () => {
    const s = newVesselState(5, T0);
    const positions = [
      pos(5, 120.2, 22.0, 3, 0),
      pos(5, 120.2, 22.0, 10, 3),
      pos(5, 120.2, 22.0, 10, 6),
      pos(5, 120.2, 22.0, 10, 9),
    ];
    const evs = feedPositions(s, positions);
    expect(evs).toHaveLength(0);
  });

  it("cooldown: second event within 1 hour is suppressed", () => {
    const s = newVesselState(6, T0);
    s.shipType = 30;
    const positions1 = Array.from({ length: 5 }, (_, i) => pos(6, 120.2, 22.0, 15, i * 5));
    const evs1 = feedPositions(s, positions1);
    expect(evs1).toHaveLength(1);

    // second burst at T0 + 30 min — within cooldown
    const positions2 = Array.from({ length: 5 }, (_, i) => pos(6, 120.2, 22.0, 15, 30 + i * 5));
    const evs2 = feedPositions(s, positions2);
    expect(evs2).toHaveLength(0);
  });

  it("severity boosted to 4 inside cable corridor", () => {
    const s = newVesselState(7, T0);
    s.shipType = 30;
    // position ON the cable (120.2, 22.0 is on the C1 line)
    const positions = Array.from({ length: 5 }, (_, i) => pos(7, 120.2, 22.0, 15, i * 5));
    const evs = feedPositions(s, positions);
    expect(evs[0].severity).toBe(4);
  });

  it("severity 3 outside cable corridor", () => {
    const s = newVesselState(8, T0);
    s.shipType = 30;
    // position OFF the cable (lat 23.5 is far from C1)
    const positions = Array.from({ length: 5 }, (_, i) => pos(8, 120.2, 23.5, 15, i * 5));
    const evs = feedPositions(s, positions);
    expect(evs[0].severity).toBe(3);
  });

  it("moored vessel (navStatus 5) does NOT fire even at type-mismatch speed", () => {
    const s = newVesselState(9, T0);
    s.shipType = 30;
    const positions = Array.from({ length: 5 }, (_, i) => {
      const p = pos(9, 120.2, 22.0, 15, i * 5);
      (p as any).navStatus = 5;
      return p;
    });
    expect(feedPositions(s, positions)).toHaveLength(0);
  });

  it("vessel inside an exclusion zone does NOT fire", () => {
    const exclGeo = new GeoContext(cables as any, {
      type: "FeatureCollection",
      features: [{ type: "Feature", properties: { name: "PORT" }, geometry: { type: "Polygon", coordinates: [[[120.1, 21.9], [120.3, 21.9], [120.3, 22.1], [120.1, 22.1], [120.1, 21.9]]] } }],
    } as any, 1000, noLanes as any, 5000);
    const s = newVesselState(10, T0);
    s.shipType = 30;
    const positions = Array.from({ length: 5 }, (_, i) => pos(10, 120.2, 22.0, 15, i * 5));
    const evs: any[] = [];
    for (const p of positions) {
      evs.push(...speedOnMessage(s, p, exclGeo, CONFIG));
      s.ring.push(p); s.lastSeen = p.ts;
    }
    expect(evs).toHaveLength(0);
  });
});
