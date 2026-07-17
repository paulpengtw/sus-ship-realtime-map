// test/gap.test.ts
import { describe, expect, it } from "vitest";
import { GeoContext } from "../src/geo/context";
import { CONFIG } from "../src/config";
import { newVesselState, type AisPosition } from "../src/types";
import { gapOnMessage, gapOnTick } from "../src/detectors/gap";

const cables = { type: "FeatureCollection", features: [{ type: "Feature", properties: { name: "C1", approximate: true }, geometry: { type: "LineString", coordinates: [[120.0, 22.0], [121.0, 22.0]] } }] };
const noExcl = { type: "FeatureCollection", features: [] };
const geo = new GeoContext(cables as any, noExcl as any, 1000);
const T0 = 1_750_000_000_000;
const HOUR = 3_600_000;

function seed(mmsi: number, lon: number, lat: number) {
  const s = newVesselState(mmsi, T0);
  for (let i = 4; i >= 0; i--) {
    s.ring.push({ mmsi, lon, lat, sog: 5, cog: 90, heading: 90, ts: T0 - i * 10 * 60_000 });
  }
  s.lastSeen = T0;
  return s;
}

describe("AIS gap detector", () => {
  it("opens severity-4 gap when silent >1h with last fix in a corridor", () => {
    const s = seed(1, 120.5, 22.0);
    expect(gapOnTick(s, geo, CONFIG, T0 + HOUR - 60_000)).toHaveLength(0);
    const evs = gapOnTick(s, geo, CONFIG, T0 + HOUR + 60_000);
    expect(evs).toHaveLength(1);
    expect(evs[0]).toMatchObject({ type: "ais_gap", severity: 4, mmsi: 1, startTs: T0, endTs: null });
    expect(gapOnTick(s, geo, CONFIG, T0 + 2 * HOUR)).toHaveLength(0); // fires once
  });

  it("opens severity-2 gap when last fix was outside corridors", () => {
    const s = seed(2, 120.5, 23.5);
    const evs = gapOnTick(s, geo, CONFIG, T0 + HOUR + 60_000);
    expect(evs[0].severity).toBe(2);
  });

  it("closes with severity 5 on impossible-speed reappearance (gap-and-teleport)", () => {
    const s = seed(3, 120.5, 22.0);
    gapOnTick(s, geo, CONFIG, T0 + HOUR + 60_000);
    // reappears 2 h later, ~200 km away → ~54 kn implied
    const back: AisPosition = { mmsi: 3, lon: 122.45, lat: 22.0, sog: 10, cog: 90, heading: 90, ts: T0 + 2 * HOUR };
    const evs = gapOnMessage(s, back, geo, CONFIG);
    expect(evs).toHaveLength(1);
    expect(evs[0]).toMatchObject({ severity: 5, endTs: T0 + 2 * HOUR });
    expect((evs[0].evidence as any).impliedSpeedKn).toBeGreaterThan(CONFIG.impossibleSpeedKn);
    expect(s.gapOpenSince).toBeNull();
  });

  it("plausible reappearance outside corridor keeps opening severity", () => {
    const s = seed(4, 120.5, 23.5);
    gapOnTick(s, geo, CONFIG, T0 + HOUR + 60_000);
    const back: AisPosition = { mmsi: 4, lon: 120.6, lat: 23.55, sog: 5, cog: 90, heading: 90, ts: T0 + 2 * HOUR };
    const evs = gapOnMessage(s, back, geo, CONFIG);
    expect(evs[0].severity).toBe(2);
  });

  it("no-op close when no gap is open", () => {
    const s = seed(5, 120.5, 22.0);
    const p: AisPosition = { mmsi: 5, lon: 120.51, lat: 22.0, sog: 5, cog: 90, heading: 90, ts: T0 + 60_000 };
    expect(gapOnMessage(s, p, geo, CONFIG)).toHaveLength(0);
  });

  it("does NOT open for a moored vessel (navStatus 5)", () => {
    const s = seed(6, 120.5, 22.0);
    for (const p of s.ring) p.navStatus = 5;
    expect(gapOnTick(s, geo, CONFIG, T0 + 2 * HOUR)).toHaveLength(0);
  });

  it("does NOT open near the outer coverage edge; marks leftCoverage", () => {
    const s = seed(7, 118.05, 22.0); // ~5 km from tw minLon 118.0
    expect(gapOnTick(s, geo, CONFIG, T0 + 2 * HOUR)).toHaveLength(0);
    expect(s.leftCoverage).toBe(true);
  });

  it("does NOT open when prior cadence was sparse (reception was already bad)", () => {
    const s = newVesselState(8, T0);
    s.ring.push({ mmsi: 8, lon: 120.5, lat: 22.0, sog: 5, cog: 90, heading: 90, ts: T0 - 2 * HOUR });
    s.ring.push({ mmsi: 8, lon: 120.5, lat: 22.0, sog: 5, cog: 90, heading: 90, ts: T0 });
    s.lastSeen = T0;
    expect(gapOnTick(s, geo, CONFIG, T0 + 2 * HOUR)).toHaveLength(0);
  });

  it("does NOT open when the last fix was inside an exclusion zone", () => {
    const exclGeo = new GeoContext(cables as any, {
      type: "FeatureCollection",
      features: [{ type: "Feature", properties: { name: "PORT" }, geometry: { type: "Polygon", coordinates: [[[120.4, 21.9], [120.6, 21.9], [120.6, 22.1], [120.4, 22.1], [120.4, 21.9]]] } }],
    } as any, 1000);
    const s = seed(9, 120.5, 22.0);
    expect(gapOnTick(s, exclGeo, CONFIG, T0 + 2 * HOUR)).toHaveLength(0);
  });
});
