// test/web-dossier.test.ts
import { describe, expect, it } from "vitest";
import { flagForMmsi } from "../web/src/mid";
import { shipTypeLabel } from "../web/src/shiptype";

describe("MID flag lookup", () => {
  it("resolves East Asia MIDs", () => {
    expect(flagForMmsi(440123456)!.country).toBe("South Korea");
    expect(flagForMmsi(416123456)!.country).toBe("Taiwan");
    expect(flagForMmsi(431123456)!.country).toBe("Japan");
    expect(flagForMmsi(412123456)!.country).toBe("China");
    expect(flagForMmsi(440123456)!.flag).toBe("🇰🇷");
  });
  it("returns null for unknown MIDs and short MMSIs", () => {
    expect(flagForMmsi(999123456)).toBeNull();
    expect(flagForMmsi(1234)).toBeNull();
  });
});

describe("ship type labels", () => {
  it("decodes common codes", () => {
    expect(shipTypeLabel(30)).toBe("Fishing");
    expect(shipTypeLabel(52)).toBe("Tug");
    expect(shipTypeLabel(65)).toBe("Passenger");
    expect(shipTypeLabel(70)).toBe("Cargo");
    expect(shipTypeLabel(84)).toBe("Tanker");
  });
  it("handles null and oddballs", () => {
    expect(shipTypeLabel(null)).toBe("Unknown type");
    expect(shipTypeLabel(undefined)).toBe("Unknown type");
    expect(shipTypeLabel(99)).toBe("Other (99)");
  });
});
