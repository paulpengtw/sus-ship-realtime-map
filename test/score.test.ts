// test/score.test.ts
import { describe, expect, it } from "vitest";
import { CONFIG } from "../src/config";
import { decayedScore } from "../src/score";

const T0 = 1_750_000_000_000;

describe("suspicion score", () => {
  it("halves over one half-life", () => {
    expect(decayedScore(8, T0, T0 + CONFIG.scoreHalfLifeMs, CONFIG.scoreHalfLifeMs)).toBeCloseTo(4, 5);
  });

  it("is stable when no time passes", () => {
    expect(decayedScore(8, T0, T0, CONFIG.scoreHalfLifeMs)).toBe(8);
  });
});
