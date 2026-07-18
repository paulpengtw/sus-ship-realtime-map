import { describe, expect, it } from "vitest";
import { CONFIG } from "../src/config";
import { GeoContext } from "../src/geo/context";
import { newVesselState, type AisPosition } from "../src/types";
import { activityFor, classifyActivity, lastActivity } from "../src/activity";

const excl = { type: "FeatureCollection", features: [{ type: "Feature", properties: { name: "PORT" }, geometry: { type: "Polygon", coordinates: [[[121.6, 25.0], [121.8, 25.0], [121.8, 25.2], [121.6, 25.2], [121.6, 25.0]]] } }] };
const noFc = { type: "FeatureCollection", features: [] };
const geo = new GeoContext(noFc as any, excl as any, 1000, noFc as any, 5000);
const T0 = 1_750_000_000_000;

const pos = (lon: number, lat: number, sog: number, tMin: number, navStatus: number | null = null): AisPosition =>
  ({ mmsi: 1, lon, lat, sog, cog: 0, heading: null, navStatus, ts: T0 + tMin * 60_000 });

describe("activity classification", () => {
  it("navStatus 5 is moored and 1 is anchored regardless of position", () => {
    expect(classifyActivity(5, 3, false, false, CONFIG)).toBe("moored");
    expect(classifyActivity(1, 0.2, false, false, CONFIG)).toBe("anchored");
  });

  it("slow inside an exclusion zone is moored even without navStatus", () => {
    expect(classifyActivity(null, 0.2, true, false, CONFIG)).toBe("moored");
  });

  it("sustained slow outside exclusions is stationary; moving is underway", () => {
    expect(classifyActivity(null, 0.2, false, true, CONFIG)).toBe("stationary");
    expect(classifyActivity(null, 0.2, false, false, CONFIG)).toBe("underway"); // single slow fix — not yet sustained
    expect(classifyActivity(0, 8, false, false, CONFIG)).toBe("underway");
  });

  it("activityFor uses ring + incoming message for the sustained check", () => {
    const s = newVesselState(1, T0);
    s.ring.push(pos(120, 22, 0.2, 0), pos(120, 22, 0.3, 5));
    expect(activityFor(s, pos(120, 22, 0.1, 10), geo, CONFIG)).toBe("stationary");
    // one fast fix in the window breaks "sustained"
    const s2 = newVesselState(2, T0);
    s2.ring.push(pos(120, 22, 5, 0), pos(120, 22, 0.3, 5));
    expect(activityFor(s2, pos(120, 22, 0.1, 10), geo, CONFIG)).toBe("underway");
  });

  it("lastActivity reads the last ring fix (moored in port)", () => {
    const s = newVesselState(3, T0);
    s.ring.push(pos(121.7, 25.1, 0.1, 0), pos(121.7, 25.1, 0.1, 5), pos(121.7, 25.1, 0.1, 10));
    expect(lastActivity(s, geo, CONFIG)).toBe("moored"); // inside exclusion polygon
    expect(lastActivity(newVesselState(4, T0), geo, CONFIG)).toBe("underway"); // empty ring
  });
});
