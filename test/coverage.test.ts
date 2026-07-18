import { describe, expect, it } from "vitest";
import { nearCoverageEdge } from "../src/geo/regions";

describe("nearCoverageEdge", () => {
  it("deep inside the tw bbox is not near an edge", () => {
    expect(nearCoverageEdge(120.5, 23.5, 10_000)).toBe(false);
  });

  it("within 10 km of the outer western tw edge is near", () => {
    expect(nearCoverageEdge(118.05, 23.5, 10_000)).toBe(true); // tw minLon = 118.0, ~5 km away
  });

  it("outside all bboxes counts as near (no coverage at all)", () => {
    expect(nearCoverageEdge(150.0, 10.0, 10_000)).toBe(true);
  });

  it("the interior kr/jp boundary at lon 130 is NOT an outer edge", () => {
    expect(nearCoverageEdge(129.99, 34.5, 10_000)).toBe(false); // probe east lands in jp
  });
});
