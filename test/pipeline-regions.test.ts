// test/pipeline-regions.test.ts
import { describe, expect, it } from "vitest";
import { CONFIG } from "../src/config";
import { GeoContext } from "../src/geo/context";
import { Tracker } from "../src/pipeline";
import type { AisPosition } from "../src/types";

const geo = new GeoContext({ type: "FeatureCollection", features: [] } as any,
                            { type: "FeatureCollection", features: [] } as any, 1000);
const T0 = 1_750_000_000_000;
const pos = (mmsi: number, lon: number, lat: number, tMin: number): AisPosition =>
  ({ mmsi, lon, lat, sog: 10, cog: 0, heading: null, ts: T0 + tMin * 60_000 });

describe("pipeline region tagging", () => {
  it("sets state.region from the latest position", () => {
    const t = new Tracker(geo, CONFIG);
    t.handlePosition(pos(1, 129.3, 34.7, 0)); // Busan approaches
    expect(t.states.get(1)!.region).toBe("kr");
    t.handlePosition(pos(1, 150.0, 10.0, 1)); // outside all boxes
    expect(t.states.get(1)!.region).toBeNull();
  });

  it("stamps region onto events emitted by handlePosition", () => {
    const t = new Tracker(geo, CONFIG);
    t.handlePosition(pos(2, 129.3, 34.7, 0));
    // ~110 km in 5 min → teleport (identity) event
    const evs = t.handlePosition(pos(2, 129.3, 33.7, 5));
    expect(evs.length).toBeGreaterThan(0);
    expect(evs.every((e) => e.region === "kr")).toBe(true);
  });

  it("stamps region onto tick (gap) events", () => {
    const t = new Tracker(geo, CONFIG);
    for (let m = 0; m <= 40; m += 10) t.handlePosition(pos(3, 121.5, 24.9, m)); // tw
    const evs = t.tick(T0 + (40 + 90) * 60_000);
    expect(evs).toHaveLength(1);
    expect(evs[0].region).toBe("tw");
  });

  it("handleStatic copies ship static data onto state", () => {
    const t = new Tracker(geo, CONFIG);
    t.handleStatic({ mmsi: 4, name: "A", callsign: "DS1", ts: T0,
      shipType: 80, destination: "ULSAN", dimBow: 200, dimStern: 50, dimPort: 20, dimStarboard: 20 });
    const s = t.states.get(4)!;
    expect(s.shipType).toBe(80);
    expect(s.destination).toBe("ULSAN");
    expect(s.dimBow).toBe(200);
    // a later static message without extras must not wipe known values
    t.handleStatic({ mmsi: 4, name: "A", callsign: "DS1", ts: T0 + 1000 });
    expect(t.states.get(4)!.shipType).toBe(80);
  });
});
