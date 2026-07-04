// test/score.test.ts
import { describe, expect, it } from "vitest";
import { CONFIG } from "../src/config";
import { newVesselState } from "../src/types";
import { applyEventToScore, decayedScore } from "../src/score";

const T0 = 1_750_000_000_000;
const DAY = 24 * 3_600_000;

describe("suspicion score", () => {
  it("halves over one half-life", () => {
    expect(decayedScore(8, T0, T0 + CONFIG.scoreHalfLifeMs, CONFIG.scoreHalfLifeMs)).toBeCloseTo(4, 5);
  });

  it("is stable when no time passes", () => {
    expect(decayedScore(8, T0, T0, CONFIG.scoreHalfLifeMs)).toBe(8);
  });

  it("applyEventToScore decays then adds severity", () => {
    const s = newVesselState(1, T0);
    s.score = 4; s.scoreTs = T0;
    applyEventToScore(s, { id: "x", type: "loitering", severity: 3, mmsi: 1, lon: 0, lat: 0, startTs: T0, endTs: null, evidence: {} }, CONFIG, T0 + DAY);
    expect(s.score).toBeCloseTo(2 + 3, 5); // 4 halved + severity 3
    expect(s.scoreTs).toBe(T0 + DAY);
  });
});
