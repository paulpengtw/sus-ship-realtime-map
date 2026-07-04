// test/aisstream.test.ts
import { describe, expect, it } from "vitest";
import { parseAisStreamMessage, parseAisTime } from "../src/aisstream";

describe("aisstream parsing", () => {
  it("parses time_utc format", () => {
    const ms = parseAisTime("2026-07-04 12:00:00.000000 +0000 UTC");
    expect(ms).toBe(Date.UTC(2026, 6, 4, 12, 0, 0));
  });

  it("parses a PositionReport", () => {
    const raw = {
      MessageType: "PositionReport",
      MetaData: { MMSI: 412345678, ShipName: "TEST", latitude: 24.5, longitude: 121.9, time_utc: "2026-07-04 12:00:00.000000 +0000 UTC" },
      Message: { PositionReport: { Sog: 1.4, Cog: 132.7, TrueHeading: 130 } },
    };
    const out = parseAisStreamMessage(raw)!;
    expect(out.pos).toMatchObject({ mmsi: 412345678, lon: 121.9, lat: 24.5, sog: 1.4, cog: 132.7, heading: 130 });
    expect(out.ident).toBeUndefined();
  });

  it("maps TrueHeading 511 (unavailable) to null", () => {
    const raw = {
      MessageType: "PositionReport",
      MetaData: { MMSI: 1, latitude: 24, longitude: 121, time_utc: "2026-07-04 12:00:00.000000 +0000 UTC" },
      Message: { PositionReport: { Sog: 0, Cog: 0, TrueHeading: 511 } },
    };
    expect(parseAisStreamMessage(raw)!.pos!.heading).toBeNull();
  });

  it("parses ShipStaticData into an identity", () => {
    const raw = {
      MessageType: "ShipStaticData",
      MetaData: { MMSI: 412345678, latitude: 24.5, longitude: 121.9, time_utc: "2026-07-04 12:00:00.000000 +0000 UTC" },
      Message: { ShipStaticData: { Name: "SHUNXIN 39", CallSign: "BXYZ1" } },
    };
    const out = parseAisStreamMessage(raw)!;
    expect(out.ident).toMatchObject({ mmsi: 412345678, name: "SHUNXIN 39", callsign: "BXYZ1" });
  });

  it("returns null on malformed input instead of throwing", () => {
    expect(parseAisStreamMessage(null)).toBeNull();
    expect(parseAisStreamMessage({ MessageType: "PositionReport" })).toBeNull();
    expect(parseAisStreamMessage("garbage")).toBeNull();
  });
});
