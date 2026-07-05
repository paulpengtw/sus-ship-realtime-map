// test/stats.test.ts
import { env, SELF } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";

const NOW = Date.now();
const T0 = NOW - 10 * 60_000;
const DAY = 86_400_000;

describe("/api/stats", () => {
  beforeEach(async () => {
    await env.DB.batch([
      env.DB.prepare("DELETE FROM vessels"), env.DB.prepare("DELETE FROM events"),
      env.DB.prepare(`INSERT INTO vessels (mmsi, name, callsign, last_lon, last_lat, last_sog, last_cog, last_ts, score, score_ts, region)
                      VALUES (440000001, 'KR', NULL, 129.3, 34.7, 1, 0, ?1, 0, ?1, 'kr')`).bind(T0),
      env.DB.prepare(`INSERT INTO vessels (mmsi, name, callsign, last_lon, last_lat, last_sog, last_cog, last_ts, score, score_ts, region)
                      VALUES (440000002, 'KR OLD', NULL, 129.3, 34.7, 1, 0, ?1, 0, ?1, 'kr')`).bind(T0 - 2 * 3_600_000),
      env.DB.prepare(`INSERT INTO events (id, type, severity, mmsi, lon, lat, start_ts, end_ts, evidence, region)
                      VALUES ('open-kr', 'loitering', 3, 440000001, 129.3, 34.7, ?1, NULL, '{}', 'kr')`).bind(T0),
      env.DB.prepare(`INSERT INTO events (id, type, severity, mmsi, lon, lat, start_ts, end_ts, evidence, region)
                      VALUES ('old-kr', 'ais_gap', 5, 440000001, 129.3, 34.7, ?1, ?1, '{}', 'kr')`).bind(NOW - 3 * DAY),
      env.DB.prepare(`INSERT INTO events (id, type, severity, mmsi, lon, lat, start_ts, end_ts, evidence, region)
                      VALUES ('null-region', 'ais_gap', 2, 1, 0, 0, ?1, NULL, '{}', NULL)`).bind(T0),
    ]);
  });

  it("returns per-region counts and a 14-day severity histogram", async () => {
    const res = await SELF.fetch("https://x/api/stats");
    expect(res.status).toBe(200);
    const body = await res.json<any>();
    expect(body.regions.kr).toEqual({ vessels: 1, activeAlerts: 1, events24h: 1 });
    expect(body.regions.tw).toEqual({ vessels: 0, activeAlerts: 0, events24h: 0 });
    expect(body.regions.jp).toEqual({ vessels: 0, activeAlerts: 0, events24h: 0 });

    const kr = body.histogram.kr;
    expect(kr).toHaveLength(14);
    expect(kr.every((b: any) => /^\d{4}-\d{2}-\d{2}$/.test(b.day) && b.counts.length === 5)).toBe(true);
    const t0Day = new Date(T0).toISOString().slice(0, 10);
    expect(kr.find((b: any) => b.day === t0Day)!.counts[2]).toBe(1);
    const threeAgo = new Date(NOW - 3 * DAY).toISOString().slice(0, 10);
    expect(kr.find((b: any) => b.day === threeAgo)!.counts[4]).toBe(1);
    expect(body.histogram.jp).toHaveLength(14);
  });
});
