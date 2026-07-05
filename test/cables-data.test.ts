import { describe, expect, it } from "vitest";
import cables from "../data/cables.json";
import { CONFIG } from "../src/config";

describe("cable corridor data", () => {
  const feats = (cables as any).features;

  it("covers all three regions", () => {
    const regions = new Set(feats.map((f: any) => f.properties.region));
    expect(regions).toEqual(new Set(["kr", "tw", "jp"]));
  });

  it("every feature carries full metadata", () => {
    for (const f of feats) {
      expect(f.properties.approximate).toBe(true);
      expect(["kr", "tw", "jp"]).toContain(f.properties.region);
      expect(Array.isArray(f.properties.systems) && f.properties.systems.length).toBeTruthy();
      expect(Array.isArray(f.properties.landing_points) && f.properties.landing_points.length).toBeTruthy();
      expect(typeof f.properties.notes).toBe("string");
    }
  });

  it("every corridor's first point lies inside its region's bbox", () => {
    for (const f of feats) {
      const b = CONFIG.regions.find((r) => r.id === f.properties.region)!.bbox;
      const [lon, lat] = f.geometry.coordinates[0];
      expect(lon).toBeGreaterThanOrEqual(b.minLon); expect(lon).toBeLessThanOrEqual(b.maxLon);
      expect(lat).toBeGreaterThanOrEqual(b.minLat); expect(lat).toBeLessThanOrEqual(b.maxLat);
    }
  });
});
