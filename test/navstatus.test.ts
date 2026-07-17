import { describe, expect, it } from "vitest";
import { parseAisStreamMessage } from "../src/aisstream";

const frame = (navStatus: unknown) => ({
  MessageType: "PositionReport",
  MetaData: { MMSI: 416001234, latitude: 25.1, longitude: 121.7, time_utc: "2026-07-17 01:02:03.000000 +0000 UTC" },
  Message: { PositionReport: { Sog: 0.1, Cog: 45, TrueHeading: 511, NavigationalStatus: navStatus } },
});

describe("navStatus parsing", () => {
  it("extracts moored (5) and at-anchor (1)", () => {
    expect(parseAisStreamMessage(frame(5))!.pos!.navStatus).toBe(5);
    expect(parseAisStreamMessage(frame(1))!.pos!.navStatus).toBe(1);
    expect(parseAisStreamMessage(frame(0))!.pos!.navStatus).toBe(0);
  });

  it("treats missing or out-of-range values as null", () => {
    expect(parseAisStreamMessage(frame(undefined))!.pos!.navStatus).toBeNull();
    expect(parseAisStreamMessage(frame(99))!.pos!.navStatus).toBeNull();
    expect(parseAisStreamMessage(frame("x"))!.pos!.navStatus).toBeNull();
  });
});
