import { describe, expect, it } from "vitest";
import { GeoContext } from "../src/geo/context";

const cables = {
  type: "FeatureCollection",
  features: [{
    type: "Feature",
    properties: { name: "TEST-CABLE", approximate: true },
    geometry: { type: "LineString", coordinates: [[120.0, 22.0], [121.0, 22.0]] },
  }],
};
const exclusions = {
  type: "FeatureCollection",
  features: [{
    type: "Feature",
    properties: { name: "TEST-ANCHORAGE" },
    geometry: { type: "Polygon", coordinates: [[[120.4, 21.95], [120.6, 21.95], [120.6, 22.05], [120.4, 22.05], [120.4, 21.95]]] },
  }],
};

describe("GeoContext", () => {
  const geo = new GeoContext(cables as any, exclusions as any, 1000);

  it("point on the cable is in corridor", () => {
    expect(geo.inCorridor([120.2, 22.0])).toBe(true);
    expect(geo.nearestCorridor([120.2, 22.0])?.name).toBe("TEST-CABLE");
  });

  it("point 5 km off the cable is not in corridor", () => {
    expect(geo.inCorridor([120.2, 22.045])).toBe(false); // 0.045 deg lat approx 5 km
  });

  it("exclusion polygon membership", () => {
    expect(geo.inExclusion([120.5, 22.0])).toBe(true);
    expect(geo.inExclusion([120.2, 22.0])).toBe(false);
  });

  it("default construction loads the bundled Taiwan data", () => {
    const real = new GeoContext();
    // Fangshan landing point sits on the bundled southern corridor.
    expect(real.inCorridor([120.593, 22.263])).toBe(true);
  });
});
