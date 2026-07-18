// test/replay-fusion.test.ts — spec §8: live-data false positives stay quiet; corroborated threats alert.
import { describe, expect, it } from "vitest";
import { GeoContext } from "../src/geo/context";
import { replayCapture } from "../src/replay-core";

const cables = { type: "FeatureCollection", features: [{ type: "Feature", properties: { name: "C1", approximate: true }, geometry: { type: "LineString", coordinates: [[120.0, 22.0], [121.0, 22.0]] } }] };
const noFc = { type: "FeatureCollection", features: [] };
const geo = new GeoContext(cables as any, noFc as any, 1000, noFc as any, 5000);

const T0 = Date.parse("2026-07-10T00:00:00Z");
const aisTime = (ts: number) => new Date(ts).toISOString().replace("T", " ").replace(/\.\d+Z$/, ".000000 +0000 UTC");
const posLine = (mmsi: number, lon: number, lat: number, sog: number, cog: number, tMin: number, navStatus = 0) =>
  JSON.stringify({
    MessageType: "PositionReport",
    MetaData: { MMSI: mmsi, latitude: lat, longitude: lon, time_utc: aisTime(T0 + tMin * 60_000) },
    Message: { PositionReport: { Sog: sog, Cog: cog, TrueHeading: cog, NavigationalStatus: navStatus } },
  });

describe("fusion end-to-end via replay", () => {
  it("moored ferry with COG jitter all night produces no events and no assessments", () => {
    const lines: string[] = [];
    for (let m = 0; m < 8 * 60; m += 10) lines.push(posLine(431000001, 139.75, 35.45, 0.2, (m * 37) % 360, m, 5));
    const r = replayCapture(lines, geo);
    expect(r.events).toHaveLength(0);
    expect(r.assessments).toHaveLength(0);
  });

  it("vessel that sails off the coverage edge and goes silent opens no gap", () => {
    const lines: string[] = [];
    for (let m = 0; m <= 50; m += 10) lines.push(posLine(431000002, 141.3 + m * 0.002, 34.0, 12, 90, m)); // heading for jp maxLon 141.5
    lines.push(posLine(431000002, 141.45, 34.0, 12, 90, 60));
    lines.push(posLine(431000002, 141.45, 34.01, 12, 90, 600)); // reappears 9 h later (was outside coverage)
    const r = replayCapture(lines, geo);
    expect(r.events.filter((e) => e.type === "ais_gap")).toHaveLength(0);
  });

  it("loiter over corridor + dark gap with repositioning opens cable_interference with a narrative", () => {
    const lines: string[] = [];
    for (let m = 0; m <= 150; m += 10) lines.push(posLine(416000003, 120.2, 22.0, 0.5, 90, m));  // 2.5 h loiter on C1
    lines.push(posLine(416000003, 120.45, 22.0, 8, 90, 150 + 130));                              // dark 2+ h, back 25 km away
    const r = replayCapture(lines, geo);
    const cable = r.assessments.find((a) => a.category === "cable_interference");
    expect(cable).toBeDefined();
    expect(cable!.status).toBe("open");
    expect(cable!.evidence.length).toBeGreaterThanOrEqual(2);
    expect(cable!.narrative).toMatch(/loitered .* corridor/i);
    expect(cable!.narrative).toContain("went dark");
    // single dark signal: dark_activity must NOT be among the assessments
    expect(r.assessments.find((a) => a.category === "dark_activity")).toBeUndefined();
  });
});
