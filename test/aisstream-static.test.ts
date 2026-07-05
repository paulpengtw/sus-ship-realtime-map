// test/aisstream-static.test.ts
import { describe, expect, it } from "vitest";
import { parseAisStreamMessage } from "../src/aisstream";

const TS = "2026-07-05 12:00:00.000000 +0000 UTC";

describe("extended ShipStaticData parsing", () => {
  it("captures ship type, destination and dimensions", () => {
    const raw = {
      MessageType: "ShipStaticData",
      MetaData: { MMSI: 440123456, time_utc: TS },
      Message: { ShipStaticData: {
        Name: "KR CARGO ", CallSign: "DS1234",
        Type: 70, Destination: " BUSAN ",
        Dimension: { A: 100, B: 20, C: 10, D: 12 },
      } },
    };
    const out = parseAisStreamMessage(raw)!;
    expect(out.ident).toMatchObject({
      mmsi: 440123456, name: "KR CARGO", callsign: "DS1234",
      shipType: 70, destination: "BUSAN",
      dimBow: 100, dimStern: 20, dimPort: 10, dimStarboard: 12,
    });
  });

  it("maps unavailable values (Type 0, empty Destination, 0 dims, missing Dimension) to null", () => {
    const raw = {
      MessageType: "ShipStaticData",
      MetaData: { MMSI: 440123456, time_utc: TS },
      Message: { ShipStaticData: { Name: "X", CallSign: "Y", Type: 0, Destination: "" } },
    };
    const ident = parseAisStreamMessage(raw)!.ident!;
    expect(ident.shipType).toBeNull();
    expect(ident.destination).toBeNull();
    expect(ident.dimBow).toBeNull();
    expect(ident.dimStarboard).toBeNull();
  });
});
