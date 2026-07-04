import { describe, expect, it } from "vitest";
import { CONFIG } from "../src/config";
import { GeoContext } from "../src/geo/context";
import { newVesselState, type AisPosition } from "../src/types";
import { anchorDragOnMessage, circularStdDeg } from "../src/detectors/anchorDrag";

const cables = { type: "FeatureCollection", features: [{ type: "Feature", properties: { name: "TPKM-3", approximate: true }, geometry: { type: "LineString", coordinates: [[120.0, 22.0], [121.0, 22.0]] } }] };
const geo = new GeoContext(cables as any, { type: "FeatureCollection", features: [] } as any, 1000);
const T0 = 1_750_000_000_000;

function feed(s: ReturnType<typeof newVesselState>, positions: AisPosition[]) {
  const out: any[] = [];
  for (const p of positions) {
    out.push(...anchorDragOnMessage(s, p, geo, CONFIG));
    s.ring.push(p); s.lastSeen = p.ts; // pipeline does this after detectors; tests mimic it
  }
  return out;
}

const track = (mmsi: number, lat: number, cogs: number[], sog: number): AisPosition[] =>
  cogs.map((cog, i) => ({ mmsi, lon: 120.3 + i * 0.001, lat, sog, cog, heading: cog, ts: T0 + i * 60_000 }));

describe("anchor drag detector", () => {
  it("circularStdDeg: steady course ≈ 0, erratic course is large", () => {
    expect(circularStdDeg([90, 90, 90, 90])).toBeLessThan(1);
    expect(circularStdDeg([10, 170, 300, 80, 220, 350])).toBeGreaterThan(60);
  });

  it("fires severity 5 for slow erratic vessel over the cable, respecting cooldown", () => {
    const s = newVesselState(1, T0);
    const cogs = [10, 170, 300, 80, 220, 350, 40, 190, 310, 100, 250, 20];
    const evs = feed(s, track(1, 22.0, cogs, 1.5));
    expect(evs.length).toBe(1); // cooldown: not once per message
    expect(evs[0]).toMatchObject({ type: "anchor_drag", severity: 5, mmsi: 1 });
    expect(evs[0].evidence.corridor).toBe("TPKM-3");
  });

  it("does NOT fire off-corridor", () => {
    const s = newVesselState(2, T0);
    const cogs = [10, 170, 300, 80, 220, 350, 40, 190, 310, 100, 250, 20];
    expect(feed(s, track(2, 23.5, cogs, 1.5))).toHaveLength(0);
  });

  it("does NOT fire for steady slow transit over the cable", () => {
    const s = newVesselState(3, T0);
    expect(feed(s, track(3, 22.0, Array(12).fill(90), 2.5))).toHaveLength(0);
  });

  it("does NOT fire for a moored vessel (SOG ~0)", () => {
    const s = newVesselState(4, T0);
    const cogs = [10, 170, 300, 80, 220, 350, 40, 190, 310, 100, 250, 20];
    expect(feed(s, track(4, 22.0, cogs, 0.1))).toHaveLength(0);
  });
});
