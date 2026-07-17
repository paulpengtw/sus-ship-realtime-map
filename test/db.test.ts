// test/db.test.ts
import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { flushWrites, loadRecentVesselStates, newPendingWrites } from "../src/db";
import { newVesselState } from "../src/types";

const T0 = 1_750_000_000_000;

function samplePending() {
  const p = newPendingWrites();
  const s = newVesselState(412000001, T0);
  s.name = "TEST SHIP"; s.callsign = "BXYZ1";
  s.categories.cable_interference.score = 6.5;
  s.categories.cable_interference.ts = T0;
  s.ring.push({ mmsi: 412000001, lon: 120.2, lat: 22.0, sog: 0.5, cog: 90, heading: 90, ts: T0 });
  s.lastSeen = T0;
  p.vessels.set(s.mmsi, s);
  p.positions.push({ mmsi: 412000001, lon: 120.2, lat: 22.0, sog: 0.5, cog: 90, heading: 90, ts: T0 });
  p.events.push({ id: `loitering-412000001-${T0}`, type: "loitering", severity: 3, mmsi: 412000001, lon: 120.2, lat: 22.0, startTs: T0, endTs: null, evidence: { corridor: "C1" } });
  return p;
}

describe("db persistence", () => {
  beforeEach(async () => {
    await env.DB.batch([env.DB.prepare("DELETE FROM vessels"), env.DB.prepare("DELETE FROM positions"), env.DB.prepare("DELETE FROM events")]);
  });

  it("flushWrites persists vessels, positions, events", async () => {
    await flushWrites(env.DB, samplePending());
    const v = await env.DB.prepare("SELECT * FROM vessels WHERE mmsi = 412000001").first<any>();
    expect(v.name).toBe("TEST SHIP");
    expect(v.score).toBeCloseTo(6.5);
    const e = await env.DB.prepare("SELECT * FROM events").first<any>();
    expect(e.end_ts).toBeNull();
    expect(JSON.parse(e.evidence).corridor).toBe("C1");
  });

  it("re-flushing the same event id upserts (closes) instead of duplicating", async () => {
    const p = samplePending();
    await flushWrites(env.DB, p);
    p.events[0] = { ...p.events[0], endTs: T0 + 3_600_000 };
    await flushWrites(env.DB, p);
    const rows = await env.DB.prepare("SELECT COUNT(*) AS n FROM events").first<any>();
    expect(rows.n).toBe(1);
    const e = await env.DB.prepare("SELECT end_ts FROM events").first<any>();
    expect(e.end_ts).toBe(T0 + 3_600_000);
  });

  it("loadRecentVesselStates rehydrates state with last position in ring", async () => {
    await flushWrites(env.DB, samplePending());
    const states = await loadRecentVesselStates(env.DB, T0 - 1);
    expect(states).toHaveLength(1);
    expect(states[0].mmsi).toBe(412000001);
    expect(states[0].ring).toHaveLength(1);
    expect(states[0].ring[0].lon).toBeCloseTo(120.2);
  });
});
