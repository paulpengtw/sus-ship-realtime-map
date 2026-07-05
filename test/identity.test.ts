import { describe, expect, it } from "vitest";
import { CONFIG } from "../src/config";
import { newVesselState, type AisIdentity, type AisPosition } from "../src/types";
import { callsignCountry, identityOnStatic, midCountry, teleportOnMessage } from "../src/detectors/identity";

const T0 = 1_750_000_000_000;
const id = (mmsi: number, name: string, callsign: string, tMin: number): AisIdentity =>
  ({ mmsi, name, callsign, shipType: null, ts: T0 + tMin * 60_000 });

describe("identity detector", () => {
  it("first identity is recorded silently", () => {
    const s = newVesselState(412111111, T0);
    expect(identityOnStatic(s, id(412111111, "SHUNXIN 39", "BXYZ1", 0), CONFIG)).toHaveLength(0);
    expect(s.name).toBe("SHUNXIN 39");
    expect(s.identities).toHaveLength(1);
  });

  it("same MMSI, new name → severity-4 identity event with before/after evidence", () => {
    const s = newVesselState(412111111, T0);
    identityOnStatic(s, id(412111111, "SHUNXIN 39", "BXYZ1", 0), CONFIG);
    const evs = identityOnStatic(s, id(412111111, "XINGSHUN 39", "BXYZ1", 60), CONFIG);
    expect(evs).toHaveLength(1);
    expect(evs[0]).toMatchObject({ type: "identity", severity: 4 });
    expect(evs[0].evidence).toMatchObject({ prevName: "SHUNXIN 39", newName: "XINGSHUN 39" });
    expect(s.identities).toHaveLength(2);
  });

  it("unchanged identity re-broadcast does not fire or grow history", () => {
    const s = newVesselState(412111111, T0);
    identityOnStatic(s, id(412111111, "SHUNXIN 39", "BXYZ1", 0), CONFIG);
    expect(identityOnStatic(s, id(412111111, "SHUNXIN 39", "BXYZ1", 30), CONFIG)).toHaveLength(0);
    expect(s.identities).toHaveLength(1);
  });

  it("MID/callsign flag mismatch → identity event (China MMSI, Taiwan callsign)", () => {
    expect(midCountry(412000000)).toBe("CN");
    expect(midCountry(416000000)).toBe("TW");
    expect(callsignCountry("BV1234")).toBe("TW");
    const s = newVesselState(412222222, T0);
    const evs = identityOnStatic(s, id(412222222, "SOME SHIP", "BV1234", 0), CONFIG);
    expect(evs).toHaveLength(1);
    expect(evs[0].evidence).toMatchObject({ midCountry: "CN", callsignCountry: "TW" });
  });

  it("teleport: two fixes 3 min apart, ~30 km apart → severity-4 event", () => {
    const s = newVesselState(9, T0);
    s.ring.push({ mmsi: 9, lon: 120.0, lat: 22.0, sog: 5, cog: 0, heading: 0, ts: T0 });
    s.lastSeen = T0;
    const p: AisPosition = { mmsi: 9, lon: 120.3, lat: 22.0, sog: 5, cog: 0, heading: 0, ts: T0 + 3 * 60_000 };
    const evs = teleportOnMessage(s, p, CONFIG);
    expect(evs).toHaveLength(1);
    expect(evs[0].type).toBe("identity");
    expect((evs[0].evidence as any).impliedSpeedKn).toBeGreaterThan(CONFIG.impossibleSpeedKn);
  });

  it("teleport does not fire on normal movement", () => {
    const s = newVesselState(10, T0);
    s.ring.push({ mmsi: 10, lon: 120.0, lat: 22.0, sog: 10, cog: 90, heading: 90, ts: T0 });
    s.lastSeen = T0;
    const p: AisPosition = { mmsi: 10, lon: 120.01, lat: 22.0, sog: 10, cog: 90, heading: 90, ts: T0 + 3 * 60_000 };
    expect(teleportOnMessage(s, p, CONFIG)).toHaveLength(0);
  });
});
