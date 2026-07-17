// test/api-trajectories.test.ts
import { env, SELF } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";

const NOW = Date.now();
const H = 3_600_000, D = 24 * H;

const vessel = (mmsi: number, name: string, score: number, scoreTs: number, region = "tw") =>
  env.DB.prepare(`INSERT INTO vessels (mmsi, name, callsign, last_lon, last_lat, last_sog, last_cog, last_ts, score, score_ts, region)
                  VALUES (?1, ?2, NULL, 120.5, 22.5, 5, 90, ?3, ?4, ?5, ?6)`)
    .bind(mmsi, name, NOW - 60_000, score, scoreTs, region);
const pos = (mmsi: number, ts: number, lon = 120.5, lat = 22.5) =>
  env.DB.prepare(`INSERT OR REPLACE INTO positions VALUES (?1, ?2, ?3, ?4, 5, 90)`).bind(mmsi, ts, lon, lat);

describe("/api/trajectories", () => {
  beforeEach(async () => {
    await env.DB.batch([
      env.DB.prepare("DELETE FROM vessels"), env.DB.prepare("DELETE FROM positions"), env.DB.prepare("DELETE FROM events"),
      env.DB.prepare("DELETE FROM assessments"),
      vessel(500000001, "EVENT SHIP", 0, NOW),
      env.DB.prepare(`INSERT INTO assessments (id, mmsi, category, status, confidence, opened_ts, updated_ts, closed_ts, region, narrative, evidence)
                      VALUES ('cable_interference-500000001-1', 500000001, 'cable_interference', 'open', 0.62, ?1, ?1, NULL, 'tw', 'x', '[]')`).bind(NOW - H),
      vessel(500000002, "SCORE SHIP", 5, NOW),
      env.DB.prepare(`INSERT INTO assessments (id, mmsi, category, status, confidence, opened_ts, updated_ts, closed_ts, region, narrative, evidence)
                      VALUES ('dark_activity-500000002-1', 500000002, 'dark_activity', 'open', 0.3, ?1, ?1, NULL, 'tw', 'x', '[]')`).bind(NOW - H),
      vessel(500000003, "FADED SHIP", 5, NOW - 3 * D),   // no assessment → calm
      vessel(500000004, "CALM SHIP", 0, NOW),            // no assessment → calm
      pos(500000001, NOW - 2 * D, 120.1, 22.1), pos(500000001, NOW - 20 * H, 120.2, 22.2), pos(500000001, NOW - H, 120.3, 22.3),
      pos(500000002, NOW - 2 * H, 121.0, 23.0), pos(500000002, NOW - H, 121.1, 23.1),
      pos(500000003, NOW - 2 * H), pos(500000003, NOW - H),
      pos(500000004, NOW - 2 * H), pos(500000004, NOW - H),
    ]);
  });

  it("returns only sus vessels (open assessment) with ascending points", async () => {
    const body = await (await SELF.fetch("https://x/api/trajectories?window=week")).json<any>();
    const byMmsi = Object.fromEntries(body.trajectories.map((t: any) => [t.mmsi, t]));
    expect(Object.keys(byMmsi).map(Number).sort()).toEqual([500000001, 500000002]);
    expect(byMmsi[500000001].topCategory).toBe("cable_interference");
    expect(byMmsi[500000001].confidence).toBeCloseTo(0.62);
    expect(byMmsi[500000001].points).toHaveLength(3);
    const ts = byMmsi[500000001].points.map((p: number[]) => p[2]);
    expect(ts).toEqual([...ts].sort((a: number, b: number) => a - b));
  });

  it("window bounds the points returned", async () => {
    const body = await (await SELF.fetch("https://x/api/trajectories?window=day")).json<any>();
    const a = body.trajectories.find((t: any) => t.mmsi === 500000001);
    expect(a.points).toHaveLength(2); // the NOW-2d point falls outside the day window
  });

  it("filters by region and rejects bad params", async () => {
    const jp = await (await SELF.fetch("https://x/api/trajectories?region=jp")).json<any>();
    expect(jp.trajectories).toHaveLength(0);
    expect((await SELF.fetch("https://x/api/trajectories?window=year")).status).toBe(400);
    expect((await SELF.fetch("https://x/api/trajectories?region=zz")).status).toBe(400);
  });

  it("caps at the top 50 vessels by max confidence, highest first", async () => {
    const stmts = [];
    for (let i = 0; i < 60; i++) {
      const mmsi = 600000000 + i;
      stmts.push(vessel(mmsi, `BULK ${i}`, 3 + i * 0.1, NOW));
      stmts.push(pos(mmsi, NOW - 2 * H, 122 + i * 0.01, 24), pos(mmsi, NOW - H, 122 + i * 0.01, 24.1));
      stmts.push(env.DB.prepare(`INSERT INTO assessments (id, mmsi, category, status, confidence, opened_ts, updated_ts, closed_ts, region, narrative, evidence)
                                 VALUES (?1, ?2, 'cable_interference', 'open', ?3, ?4, ?4, NULL, 'tw', 'x', '[]')`)
        .bind(`cable_interference-${mmsi}-1`, mmsi, 0.3 + i * 0.01, NOW - H));
    }
    await env.DB.batch(stmts);
    const body = await (await SELF.fetch("https://x/api/trajectories")).json<any>();
    expect(body.trajectories).toHaveLength(50);
    const scores = body.trajectories.map((t: any) => t.confidence);
    expect(scores).toEqual([...scores].sort((a: number, b: number) => b - a));
  });
});
