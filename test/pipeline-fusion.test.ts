// test/pipeline-fusion.test.ts
import { describe, expect, it } from "vitest";
import { CONFIG } from "../src/config";
import { GeoContext } from "../src/geo/context";
import { Tracker } from "../src/pipeline";
import type { AisPosition } from "../src/types";

const cables = { type: "FeatureCollection", features: [{ type: "Feature", properties: { name: "C1", approximate: true }, geometry: { type: "LineString", coordinates: [[120.0, 22.0], [121.0, 22.0]] } }] };
const noFc = { type: "FeatureCollection", features: [] };
const geo = new GeoContext(cables as any, noFc as any, 1000, noFc as any, 5000);
const T0 = 1_750_000_000_000;
const pos = (mmsi: number, lon: number, lat: number, sog: number, tMin: number, cog = 90): AisPosition =>
  ({ mmsi, lon, lat, sog, cog, heading: cog, ts: T0 + tMin * 60_000 });

describe("pipeline fusion wiring", () => {
  it("loiter alone accumulates cable score but does not open an assessment", () => {
    const t = new Tracker(geo, CONFIG);
    for (let m = 0; m <= 130; m += 10) t.handlePosition(pos(1, 120.2, 22.0, 0.5, m));
    const s = t.states.get(1)!;
    expect(s.categories.cable_interference.score).toBeCloseTo(0.45, 2);
    expect(s.assessments.cable_interference).toBeUndefined();
    expect(t.drainChangedAssessments()).toEqual([]);
  });

  it("loiter + dark gap with repositioning opens cable_interference; drain returns it once", () => {
    const t = new Tracker(geo, CONFIG);
    for (let m = 0; m <= 130; m += 10) t.handlePosition(pos(2, 120.2, 22.0, 0.5, m)); // loiter (medium)
    t.tick(T0 + (130 + 70) * 60_000);                       // gap opens (cadence is healthy)
    t.handlePosition(pos(2, 120.5, 22.0, 8, 130 + 130));    // reappears ~31 km away → gap closes
    const changed = t.drainChangedAssessments();
    const cable = changed.find((a) => a.category === "cable_interference")!;
    expect(cable).toBeDefined();
    expect(cable.status).toBe("open");
    expect(cable.evidence.length).toBeGreaterThanOrEqual(2);
    expect(cable.narrative).toMatch(/loitered/i);
    expect(t.drainChangedAssessments()).toEqual([]); // drained
    // dark_activity: single gap event (max rule) → not open
    expect(t.states.get(2)!.assessments.dark_activity).toBeUndefined();
  });

  it("tick() closes stale assessments and drain reports the closure", () => {
    const t = new Tracker(geo, CONFIG);
    // anchor drag → strong → opens immediately
    const cogs = [10, 170, 300, 80, 220, 350, 40, 190, 310, 100, 250, 20];
    cogs.forEach((cog, i) => t.handlePosition({ mmsi: 3, lon: 120.3 + i * 0.001, lat: 22.0, sog: 1.5, cog, heading: cog, ts: T0 + i * 60_000 }));
    expect(t.drainChangedAssessments().some((a) => a.category === "cable_interference")).toBe(true);
    // score 1.0 needs ~56 h to dip under 0.2, then 12 h dwell
    t.tick(T0 + 57 * 3_600_000);
    t.tick(T0 + 70 * 3_600_000);
    const closed = t.drainChangedAssessments().filter((a) => a.status === "closed");
    expect(closed).toHaveLength(1);
    expect(t.states.get(3)!.assessments.cable_interference).toBeUndefined();
  });
});
