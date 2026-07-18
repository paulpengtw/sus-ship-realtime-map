// test/db-regions.test.ts
import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { flushWrites, loadRecentVesselStates, newPendingWrites } from "../src/db";
import { newVesselState } from "../src/types";

const T0 = 1_750_000_000_000;

function pendingWithRegion() {
  const p = newPendingWrites();
  const s = newVesselState(440000001, T0);
  s.name = "KR SHIP"; s.callsign = "DS1234"; s.lastSeen = T0;
  s.categories.cable_interference.score = 2;
  s.categories.cable_interference.ts = T0;
  s.region = "kr"; s.shipType = 70; s.destination = "BUSAN";
  s.dimBow = 100; s.dimStern = 20; s.dimPort = 10; s.dimStarboard = 10;
  s.ring.push({ mmsi: 440000001, lon: 129.3, lat: 34.7, sog: 1, cog: 0, heading: null, ts: T0 });
  p.vessels.set(s.mmsi, s);
  p.events.push({ id: `loitering-440000001-${T0}`, type: "loitering", severity: 3, mmsi: 440000001,
    lon: 129.3, lat: 34.7, startTs: T0, endTs: null, evidence: {}, region: "kr" });
  return p;
}

describe("db region + static-data persistence", () => {
  beforeEach(async () => {
    await env.DB.batch([env.DB.prepare("DELETE FROM vessels"), env.DB.prepare("DELETE FROM events")]);
  });

  it("flushWrites persists region and static data on vessels and events", async () => {
    await flushWrites(env.DB, pendingWithRegion());
    const v = await env.DB.prepare("SELECT * FROM vessels WHERE mmsi = 440000001").first<any>();
    expect(v.region).toBe("kr");
    expect(v.ship_type).toBe(70);
    expect(v.destination).toBe("BUSAN");
    expect(v.dim_bow).toBe(100);
    const e = await env.DB.prepare("SELECT region FROM events").first<any>();
    expect(e.region).toBe("kr");
  });

  it("null region persists as NULL", async () => {
    const p = pendingWithRegion();
    p.vessels.get(440000001)!.region = null;
    p.events[0] = { ...p.events[0], region: null };
    await flushWrites(env.DB, p);
    const v = await env.DB.prepare("SELECT region FROM vessels").first<any>();
    expect(v.region).toBeNull();
  });

  it("loadRecentVesselStates restores region and static data", async () => {
    await flushWrites(env.DB, pendingWithRegion());
    const [s] = await loadRecentVesselStates(env.DB, T0 - 1);
    expect(s.region).toBe("kr");
    expect(s.shipType).toBe(70);
    expect(s.destination).toBe("BUSAN");
    expect(s.dimBow).toBe(100); expect(s.dimStern).toBe(20);
    expect(s.dimPort).toBe(10); expect(s.dimStarboard).toBe(10);
  });
});
