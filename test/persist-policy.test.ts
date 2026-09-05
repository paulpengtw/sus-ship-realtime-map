// test/persist-policy.test.ts — which state earns a D1 write (spec 2026-09-05 §3–4).
import { describe, expect, it } from "vitest";
import { CONFIG } from "../src/config";
import { isTracked, ringBackfill, shouldPersistPosition, truncatePositions, vesselFingerprint, vesselWriteKind } from "../src/persist-policy";
import { newVesselState, type AisPosition, type VesselState } from "../src/types";

const NOW = 1_800_000_000_000; // aligned to the 10-min bucket grid
const MIN = 60_000, H = 3_600_000;
const fix = (ts: number, lon = 120, lat = 22): AisPosition => ({ mmsi: 1, lon, lat, sog: 5, cog: 0, heading: null, ts });
function vessel(ts = NOW): VesselState {
  const s = newVesselState(1, ts);
  s.ring.push(fix(ts));
  s.lastSeen = ts;
  return s;
}

describe("vesselWriteKind", () => {
  it("first sight is essential", () => {
    expect(vesselWriteKind(vessel(), undefined, NOW, false)).toBe("essential");
  });
  it("skips a vessel that has no position fix yet", () => {
    expect(vesselWriteKind(newVesselState(1, NOW), undefined, NOW, false)).toBe("skip");
  });
  it("unchanged and fresh is skip; identity change is essential", () => {
    const s = vessel();
    const prev = { ts: NOW - MIN, fp: vesselFingerprint(s) };
    expect(vesselWriteKind(s, prev, NOW, false)).toBe("skip");
    s.name = "RENAMED";
    expect(vesselWriteKind(s, prev, NOW, false)).toBe("essential");
  });
  it("a vessel touched by an event or assessment this flush is essential", () => {
    const s = vessel();
    expect(vesselWriteKind(s, { ts: NOW - MIN, fp: vesselFingerprint(s) }, NOW, true)).toBe("essential");
  });
  it("a row older than vesselRefreshMs is an optional refresh", () => {
    const s = vessel();
    const fp = vesselFingerprint(s);
    expect(vesselWriteKind(s, { ts: NOW - CONFIG.vesselRefreshMs + 1, fp }, NOW, false)).toBe("skip");
    expect(vesselWriteKind(s, { ts: NOW - CONFIG.vesselRefreshMs, fp }, NOW, false)).toBe("optional");
  });
});

describe("isTracked", () => {
  it("is false for a quiet vessel", () => expect(isTracked(vessel())).toBe(false));
  it("is true with an open assessment, false once it closes", () => {
    const s = vessel();
    s.assessments.dark_activity = {
      id: "a", mmsi: 1, category: "dark_activity", status: "open", confidence: 0.6,
      openedTs: NOW, updatedTs: NOW, closedTs: null, region: "tw", narrative: "", evidence: [], lastLon: 0, lastLat: 0,
    };
    expect(isTracked(s)).toBe(true);
    s.assessments.dark_activity.status = "closed";
    expect(isTracked(s)).toBe(false);
  });
  it("is true once any category score reaches trackPersistMinScore", () => {
    const s = vessel();
    s.categories.cable_interference.score = CONFIG.trackPersistMinScore - 0.01;
    expect(isTracked(s)).toBe(false);
    s.categories.cable_interference.score = CONFIG.trackPersistMinScore;
    expect(isTracked(s)).toBe(true);
  });
});

describe("shouldPersistPosition", () => {
  it("always persists the first fix", () => expect(shouldPersistPosition(fix(NOW), undefined)).toBe(true));
  it("holds a slow vessel until persistMinIntervalMs", () => {
    expect(shouldPersistPosition(fix(NOW + CONFIG.persistMinIntervalMs - 1), fix(NOW))).toBe(false);
    expect(shouldPersistPosition(fix(NOW + CONFIG.persistMinIntervalMs), fix(NOW))).toBe(true);
  });
  it("persists early once the vessel moved persistMinMoveM", () => {
    expect(shouldPersistPosition(fix(NOW + MIN, 120, 22.02), fix(NOW, 120, 22))).toBe(true);   // ≈ 2.2 km
    expect(shouldPersistPosition(fix(NOW + MIN, 120, 22.005), fix(NOW, 120, 22))).toBe(false); // ≈ 0.56 km
  });
});

describe("ringBackfill", () => {
  it("keeps one point per bucket inside the backfill window, oldest first", () => {
    const s = newVesselState(1, NOW);
    const b = CONFIG.trackBackfillBucketMs;
    s.ring.push(fix(NOW - 2 * 24 * H), fix(NOW - 3 * b), fix(NOW - 3 * b + 1000), fix(NOW - 2 * b), fix(NOW));
    expect(ringBackfill(s, NOW).map((p) => p.ts)).toEqual([NOW - 3 * b, NOW - 2 * b, NOW]);
  });
});

describe("truncatePositions", () => {
  it("keeps the newest `cap` entries and returns the same array when under cap", () => {
    const ps = [fix(1), fix(2), fix(3)];
    expect(truncatePositions(ps, 2).map((p) => p.ts)).toEqual([2, 3]);
    expect(truncatePositions(ps, 5)).toBe(ps);
  });
});
