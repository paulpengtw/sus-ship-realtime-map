// test/snapshot.test.ts — read models built from in-memory VesselState (spec 2026-09-05 §3).
import { describe, expect, it } from "vitest";
import { buildSnapshot, liveVessel, vesselCounts } from "../src/snapshot";
import { newVesselState, type ThreatAssessment, type VesselState } from "../src/types";

const NOW = 1_800_000_000_000;
const H = 3_600_000;

function vessel(mmsi: number, lon: number, lat: number, ts: number, extra: Partial<VesselState> = {}): VesselState {
  const s = newVesselState(mmsi, ts);
  s.ring.push({ mmsi, lon, lat, sog: 0.5, cog: 90, heading: null, ts });
  s.lastSeen = ts;
  return Object.assign(s, extra);
}
function open(mmsi: number, category: ThreatAssessment["category"], confidence: number, ts: number): ThreatAssessment {
  return { id: `${category}-${mmsi}-${ts}`, mmsi, category, status: "open", confidence, openedTs: ts, updatedTs: ts, closedTs: null, region: "tw", narrative: "x", evidence: [], lastLon: 120.2, lastLat: 22.0 };
}

describe("buildSnapshot", () => {
  it("emits GeoJSON for vessels inside the window and drops older ones", () => {
    const fresh = vessel(1, 120.2, 22.0, NOW - 10 * 60_000);
    const stale = vessel(2, 121.0, 23.0, NOW - 2 * H);
    const snap = buildSnapshot([fresh, stale], NOW, "", H);
    expect(snap.generatedAt).toBe(NOW);
    expect(snap.vessels.type).toBe("FeatureCollection");
    expect(snap.vessels.features.map((f) => f.properties.mmsi)).toEqual([1]);
    expect(snap.vessels.features[0].geometry).toEqual({ type: "Point", coordinates: [120.2, 22.0] });
    expect(snap.vessels.features[0].properties).toMatchObject({ sog: 0.5, cog: 90, lastTs: NOW - 10 * 60_000 });
    expect(snap.newestTs).toBe(NOW - 10 * 60_000);
  });

  it("skips vessels with no position fix and returns newestTs null when empty", () => {
    const s = newVesselState(3, NOW);
    s.name = "STATIC ONLY";
    const snap = buildSnapshot([s], NOW, "", H);
    expect(snap.vessels.features).toEqual([]);
    expect(snap.newestTs).toBeNull();
  });

  it("filters by region when given, all regions when empty string", () => {
    const kr = vessel(1, 129.3, 34.7, NOW, { region: "kr", shipType: 70 });
    const tw = vessel(2, 121.5, 24.9, NOW, { region: "tw" });
    expect(buildSnapshot([kr, tw], NOW, "kr", H).vessels.features).toHaveLength(1);
    expect(buildSnapshot([kr, tw], NOW, "", H).vessels.features).toHaveLength(2);
    expect(buildSnapshot([kr, tw], NOW, "kr", H).vessels.features[0].properties).toMatchObject({ mmsi: 1, region: "kr", shipType: 70 });
  });

  it("lists open assessments by confidence, sorts vessels by maxConfidence, keeps the legacy score", () => {
    const quiet = vessel(1, 120, 22, NOW);
    const sus = vessel(2, 120, 22, NOW);
    sus.assessments.dark_activity = open(2, "dark_activity", 0.3, NOW);
    sus.assessments.cable_interference = open(2, "cable_interference", 0.62, NOW);
    sus.assessments.identity_deception = { ...open(2, "identity_deception", 0.9, NOW), status: "closed", closedTs: NOW };
    const [first, second] = buildSnapshot([quiet, sus], NOW, "", H).vessels.features;
    expect(first.properties.mmsi).toBe(2);
    expect(first.properties.assessments).toEqual([
      { category: "cable_interference", confidence: 0.62 },
      { category: "dark_activity", confidence: 0.3 },
    ]);
    expect(first.properties.topCategory).toBe("cable_interference");
    expect(first.properties.maxConfidence).toBeCloseTo(0.62);
    expect(first.properties.score).toBeCloseTo(3.1);
    expect(second.properties).toMatchObject({ mmsi: 1, assessments: [], topCategory: null, maxConfidence: 0, score: 0 });
  });
});

describe("vesselCounts", () => {
  it("counts in-window vessels per region; ignores null regions and stale vessels", () => {
    const counts = vesselCounts([
      vessel(1, 129.3, 34.7, NOW, { region: "kr" }),
      vessel(2, 129.3, 34.7, NOW - 2 * H, { region: "kr" }),
      vessel(3, 0, 0, NOW, { region: null }),
    ], NOW, H);
    expect(counts).toEqual({ kr: 1, tw: 0, jp: 0 });
  });
});

describe("liveVessel", () => {
  it("returns the dossier vessel block from the last fix; null without a fix", () => {
    const s = vessel(440000001, 129.3, 34.7, NOW, {
      name: "KR SHIP", callsign: "DS1", region: "kr", shipType: 70, destination: "BUSAN",
      dimBow: 100, dimStern: 20, dimPort: 10, dimStarboard: 12,
    });
    expect(liveVessel(s)).toEqual({
      mmsi: 440000001, name: "KR SHIP", callsign: "DS1", lon: 129.3, lat: 34.7, sog: 0.5, cog: 90, lastTs: NOW,
      region: "kr", shipType: 70, destination: "BUSAN", dimBow: 100, dimStern: 20, dimPort: 10, dimStarboard: 12,
    });
    expect(liveVessel(newVesselState(1, NOW))).toBeNull();
    expect(liveVessel(undefined)).toBeNull();
  });
});
