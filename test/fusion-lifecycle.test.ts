import { describe, expect, it } from "vitest";
import { CONFIG } from "../src/config";
import { GeoContext } from "../src/geo/context";
import { newVesselState, type AnomalyEvent } from "../src/types";
import { applyEventToFusion, fusionTick } from "../src/fusion";

const cables = { type: "FeatureCollection", features: [{ type: "Feature", properties: { name: "C1", approximate: true }, geometry: { type: "LineString", coordinates: [[120.0, 22.0], [121.0, 22.0]] } }] };
const noFc = { type: "FeatureCollection", features: [] };
const geo = new GeoContext(cables as any, noFc as any, 1000, noFc as any, 5000);
const T0 = 1_750_000_000_000;
const HOUR = 3_600_000;

const drag = (mmsi: number, ts: number): AnomalyEvent => ({
  id: `anchor_drag-${mmsi}-${ts}`, type: "anchor_drag", severity: 5, mmsi, lon: 120.2, lat: 22.0,
  startTs: ts, endTs: ts, evidence: { corridor: "C1", cogStdDeg: 80, meanSogKn: 1.2 }, region: "tw",
});

describe("assessment close lifecycle", () => {
  it("closes after the score sits below the close threshold for 12 h, then reopens with a new id", () => {
    const s = newVesselState(1, T0);
    const [opened] = applyEventToFusion(s, drag(1, T0), geo, CONFIG, T0);
    // score 1.0 → below 0.2 needs log2(1/0.2) ≈ 2.32 half-lives ≈ 56 h
    const tBelow = T0 + 57 * HOUR;
    expect(fusionTick(s, CONFIG, tBelow)).toEqual([]); // just dipped below — belowSince starts
    expect(fusionTick(s, CONFIG, tBelow + 6 * HOUR)).toEqual([]); // 6 h below — not yet
    const closed = fusionTick(s, CONFIG, tBelow + 13 * HOUR);
    expect(closed).toHaveLength(1);
    expect(closed[0]).toMatchObject({ id: opened.id, status: "closed" });
    expect(closed[0].closedTs).toBe(tBelow + 13 * HOUR);
    expect(s.assessments.cable_interference).toBeUndefined();

    const t2 = tBelow + 14 * HOUR;
    const [reopened] = applyEventToFusion(s, drag(1, t2), geo, CONFIG, t2);
    expect(reopened.status).toBe("open");
    expect(reopened.id).not.toBe(opened.id);
  });

  it("a fresh signal while dipping resets the close countdown", () => {
    const s = newVesselState(2, T0);
    applyEventToFusion(s, drag(2, T0), geo, CONFIG, T0);
    const tBelow = T0 + 57 * HOUR;
    fusionTick(s, CONFIG, tBelow); // belowSince set
    applyEventToFusion(s, drag(2, tBelow + HOUR), geo, CONFIG, tBelow + HOUR); // re-energized
    expect(fusionTick(s, CONFIG, tBelow + 13 * HOUR)).toEqual([]); // countdown was reset
    expect(s.assessments.cable_interference?.status).toBe("open");
  });
});
