// test/loitering.test.ts
import { describe, expect, it } from "vitest";
import { GeoContext } from "../src/geo/context";
import { CONFIG } from "../src/config";
import { newVesselState, type AisPosition } from "../src/types";
import { loiteringOnMessage } from "../src/detectors/loitering";

const cables = { type: "FeatureCollection", features: [{ type: "Feature", properties: { name: "C1", approximate: true }, geometry: { type: "LineString", coordinates: [[120.0, 22.0], [121.0, 22.0]] } }] };
const excl = { type: "FeatureCollection", features: [{ type: "Feature", properties: { name: "A1" }, geometry: { type: "Polygon", coordinates: [[[120.4, 21.99], [120.6, 21.99], [120.6, 22.01], [120.4, 22.01], [120.4, 21.99]]] } }] };
const geo = new GeoContext(cables as any, excl as any, 1000);
const T0 = 1_750_000_000_000;

function pos(mmsi: number, lon: number, lat: number, sog: number, tMin: number): AisPosition {
  return { mmsi, lon, lat, sog, cog: 90, heading: 90, ts: T0 + tMin * 60_000 };
}

describe("loitering detector", () => {
  it("fires after >2h slow in corridor, once, then closes on departure", () => {
    const s = newVesselState(1, T0);
    const evs: any[] = [];
    for (let m = 0; m <= 130; m += 10) evs.push(...loiteringOnMessage(s, pos(1, 120.2, 22.0, 0.5, m), geo, CONFIG));
    expect(evs).toHaveLength(1);
    expect(evs[0]).toMatchObject({ type: "loitering", severity: 3, mmsi: 1, endTs: null });
    expect(evs[0].evidence.corridor).toBe("C1");
    // speeds up and leaves → same id, closed
    const close = loiteringOnMessage(s, pos(1, 120.2, 22.0, 8, 140), geo, CONFIG);
    expect(close).toHaveLength(1);
    expect(close[0].id).toBe(evs[0].id);
    expect(close[0].endTs).toBe(T0 + 140 * 60_000);
  });

  it("does NOT fire inside an exclusion zone (slow fishing fleet)", () => {
    const s = newVesselState(2, T0);
    const evs: any[] = [];
    for (let m = 0; m <= 300; m += 10) evs.push(...loiteringOnMessage(s, pos(2, 120.5, 22.0, 0.5, m), geo, CONFIG));
    expect(evs).toHaveLength(0);
  });

  it("does NOT fire on a normal transit through the corridor", () => {
    const s = newVesselState(3, T0);
    const evs: any[] = [];
    for (let m = 0; m <= 30; m += 5) evs.push(...loiteringOnMessage(s, pos(3, 120.1 + m * 0.01, 22.0, 12, m), geo, CONFIG));
    expect(evs).toHaveLength(0);
  });

  it("timer resets when the vessel speeds up briefly", () => {
    const s = newVesselState(4, T0);
    const evs: any[] = [];
    for (let m = 0; m <= 110; m += 10) evs.push(...loiteringOnMessage(s, pos(4, 120.2, 22.0, 0.5, m), geo, CONFIG));
    evs.push(...loiteringOnMessage(s, pos(4, 120.2, 22.0, 6, 115), geo, CONFIG)); // burst of speed
    for (let m = 120; m <= 230; m += 10) evs.push(...loiteringOnMessage(s, pos(4, 120.2, 22.0, 0.5, m), geo, CONFIG));
    expect(evs).toHaveLength(0); // neither stretch alone reaches 2 h
  });
});
