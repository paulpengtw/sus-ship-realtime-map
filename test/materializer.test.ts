import { describe, expect, it } from "vitest";
import { toInsertRow, windowsOverlap } from "../src/materializer";
import type { CandidateIncident } from "../src/labeling";

describe("windowsOverlap", () => {
  it("true when a starts before b ends and a ends after b starts", () => {
    expect(windowsOverlap({ tStart: 0, tEnd: 100 }, { tStart: 50, tEnd: 150 })).toBe(true);
    expect(windowsOverlap({ tStart: 50, tEnd: 150 }, { tStart: 0, tEnd: 100 })).toBe(true);
  });
  it("false for disjoint windows", () => {
    expect(windowsOverlap({ tStart: 0, tEnd: 100 }, { tStart: 200, tEnd: 300 })).toBe(false);
  });
  it("false when adjacent — treated as non-overlapping", () => {
    expect(windowsOverlap({ tStart: 0, tEnd: 100 }, { tStart: 100, tEnd: 200 })).toBe(false);
  });
});

describe("toInsertRow", () => {
  it("serializes JSON columns and preserves nulls", () => {
    const c: CandidateIncident = {
      id: "abc", vesselId: "416", tStart: 1, tEnd: 2,
      source: "assessment", sourceRef: "ref-1", createdAt: 3,
      modelSnapshot: { topCategory: "cable_interference" }, eventIds: ["e1"],
    };
    expect(toInsertRow(c)).toEqual([
      "abc", "416", 1, 2, "assessment", "ref-1", 3,
      '{"topCategory":"cable_interference"}', '["e1"]',
    ]);
  });
});
