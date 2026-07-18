import { env, SELF } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";

describe("GET /api/vessel/:mmsi/track?from=&to=", () => {
  const MMSI = 416000042;
  beforeEach(async () => {
    await env.DB.batch([
      env.DB.prepare("DELETE FROM positions"),
      env.DB.prepare("DELETE FROM vessels"),
      env.DB.prepare(
        `INSERT INTO vessels (mmsi, name, callsign, last_lon, last_lat, last_sog, last_cog, last_ts, score, score_ts)
         VALUES (?1, 'X', 'BX', 120, 22, 0, 0, ?2, 0, ?2)`).bind(MMSI, 3000),
      env.DB.prepare(`INSERT INTO positions (mmsi, ts, lon, lat, sog, cog) VALUES (?1, 1000, 120, 22, 0, 0)`).bind(MMSI),
      env.DB.prepare(`INSERT INTO positions (mmsi, ts, lon, lat, sog, cog) VALUES (?1, 2000, 120, 22, 0, 0)`).bind(MMSI),
      env.DB.prepare(`INSERT INTO positions (mmsi, ts, lon, lat, sog, cog) VALUES (?1, 3000, 120, 22, 0, 0)`).bind(MMSI),
    ]);
  });

  it("returns positions whose ts is in [from, to]", async () => {
    const res = await SELF.fetch(`https://x/api/vessel/${MMSI}/track?from=1500&to=2500`);
    expect(res.status).toBe(200);
    const body = await res.json<any>();
    expect(body.points.map((p: any) => p.ts)).toEqual([2000]);
  });

  it("400 if range malformed", async () => {
    const r = await SELF.fetch(`https://x/api/vessel/${MMSI}/track?from=abc&to=2000`);
    expect(r.status).toBe(400);
  });
});
