// test/web-regions.test.ts
import { describe, expect, it } from "vitest";
import { DEFAULT_REGION, REGIONS, resolveInitialRegion } from "../web/src/regions";

describe("web region store", () => {
  it("defaults first-time visitors to Korea", () => {
    expect(DEFAULT_REGION).toBe("kr");
    expect(resolveInitialRegion(null)).toBe("kr");
  });
  it("accepts stored valid regions, rejects junk", () => {
    expect(resolveInitialRegion("jp")).toBe("jp");
    expect(resolveInitialRegion("tw")).toBe("tw");
    expect(resolveInitialRegion("zz")).toBe("kr");
    expect(resolveInitialRegion("")).toBe("kr");
  });
  it("exposes all three regions with camera presets", () => {
    expect(REGIONS.map((r) => r.id)).toEqual(["kr", "tw", "jp"]);
    for (const r of REGIONS) {
      expect(r.center).toHaveLength(2);
      expect(r.zoom).toBeGreaterThan(4);
    }
  });
});
