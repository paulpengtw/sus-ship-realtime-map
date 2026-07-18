import { describe, expect, it } from "vitest";
import { GeoContext } from "../src/geo/context";

const cables = { type: "FeatureCollection", features: [] };
const exclusions = { type: "FeatureCollection", features: [] };
const lanes = {
  type: "FeatureCollection",
  features: [{
    type: "Feature",
    properties: { name: "TEST-LANE" },
    geometry: { type: "LineString", coordinates: [[119.5, 23.0], [120.5, 23.0]] },
  }],
};

describe("GeoContext lane support", () => {
  const geo = new GeoContext(cables as any, exclusions as any, 1000, lanes as any, 5000);

  it("point on the lane is in lane", () => {
    expect(geo.inLane([120.0, 23.0])).toBe(true);
    expect(geo.nearestLane([120.0, 23.0])?.name).toBe("TEST-LANE");
  });

  it("point 10 km off the lane is not in lane", () => {
    expect(geo.inLane([120.0, 23.09])).toBe(false); // ~0.09 deg lat ≈ 10 km
  });

  it("point ~3 km from lane is in lane (within 5 km buffer)", () => {
    expect(geo.inLane([120.0, 23.027])).toBe(true); // ~0.027 deg lat ≈ 3 km
  });

  it("default construction works without lanes (backward compatible)", () => {
    // 121.8, 23.9 is >150 km from every bundled lane in data/lanes.json —
    // note [120.0, 23.0] can't be used here as it collides with a real
    // vertex of the bundled "Taiwan Strait North-South (eastern)" lane.
    const geo2 = new GeoContext();
    expect(geo2.inLane([121.8, 23.9])).toBe(false);
  });

  it("inLaneCoverage is false when the FC has no coverage polygon", () => {
    expect(geo.inLaneCoverage([120.0, 23.0])).toBe(false);
  });

  it("inLaneCoverage respects a Polygon feature; lanes still resolve", () => {
    const withCoverage = {
      type: "FeatureCollection",
      features: [
        ...lanes.features,
        { type: "Feature", properties: { name: "coverage" }, geometry: { type: "Polygon", coordinates: [[[119.0, 22.5], [121.0, 22.5], [121.0, 23.5], [119.0, 23.5], [119.0, 22.5]]] } },
      ],
    };
    const g = new GeoContext(cables as any, exclusions as any, 1000, withCoverage as any, 5000);
    expect(g.inLaneCoverage([120.0, 23.0])).toBe(true);
    expect(g.inLaneCoverage([125.0, 30.0])).toBe(false);
    expect(g.nearestLane([120.0, 23.0])?.name).toBe("TEST-LANE"); // polygon ignored by lane matching
  });

  it("bundled lanes.json contains a coverage polygon over the Taiwan Strait", () => {
    const g = new GeoContext();
    expect(g.inLaneCoverage([120.0, 24.0])).toBe(true);   // mid-strait
    expect(g.inLaneCoverage([139.7, 35.4])).toBe(false);  // Tokyo Bay — the live false-positive site
  });
});
