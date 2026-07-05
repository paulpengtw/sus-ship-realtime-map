// test/regions.test.ts
import { describe, expect, it } from "vitest";
import { CONFIG } from "../src/config";
import { regionForPoint } from "../src/geo/regions";

describe("regionForPoint", () => {
  it("tags Busan southern approaches as kr", () => {
    expect(regionForPoint(129.3, 34.7)).toBe("kr");
  });
  it("tags Yellow Sea landing corridor as kr", () => {
    expect(regionForPoint(125.2, 36.2)).toBe("kr");
  });
  it("tags the existing Taiwan box as tw", () => {
    expect(regionForPoint(121.5, 24.9)).toBe("tw");
    expect(regionForPoint(118.0, 21.0)).toBe("tw"); // bbox edges inclusive
  });
  it("tags Boso peninsula approaches as jp", () => {
    expect(regionForPoint(140.3, 34.7)).toBe("jp");
  });
  it("returns null outside all boxes", () => {
    expect(regionForPoint(150.0, 10.0)).toBeNull();
    expect(regionForPoint(0, 0)).toBeNull();
  });
  it("first match wins on the shared kr/jp edge (130.0 E)", () => {
    // kr is listed before jp in CONFIG.regions, so the shared meridian goes to kr
    expect(CONFIG.regions[0].id).toBe("kr");
    expect(regionForPoint(130.0, 34.0)).toBe("kr");
  });
});
