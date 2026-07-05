// test/api-regions.test.ts
import { env, SELF } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";

const T0 = Date.now() - 10 * 60_000;

async function seed() {
  await env.DB.batch([
    env.DB.prepare("DELETE FROM vessels"), env.DB.prepare("DELETE FROM events"),
    env.DB.prepare(`INSERT INTO vessels (mmsi, name, callsign, last_lon, last_lat, last_sog, last_cog, last_ts, score, score_ts,
                                         region, ship_type, destination, dim_bow, dim_stern, dim_port, dim_starboard)
                    VALUES (440000001, 'KR SHIP', 'DS1', 129.3, 34.7, 1, 0, ?1, 2, ?1, 'kr', 70, 'BUSAN', 100, 20, 10, 12)`).bind(T0),
    env.DB.prepare(`INSERT INTO vessels (mmsi, name, callsign, last_lon, last_lat, last_sog, last_cog, last_ts, score, score_ts, region)
                    VALUES (416000001, 'TW SHIP', 'BV1', 121.5, 24.9, 1, 0, ?1, 1, ?1, 'tw')`).bind(T0),
    env.DB.prepare(`INSERT INTO events (id, type, severity, mmsi, lon, lat, start_ts, end_ts, evidence, region)
                    VALUES ('e-kr', 'loitering', 3, 440000001, 129.3, 34.7, ?1, NULL, '{}', 'kr')`).bind(T0),
    env.DB.prepare(`INSERT INTO events (id, type, severity, mmsi, lon, lat, start_ts, end_ts, evidence, region)
                    VALUES ('e-tw', 'ais_gap', 2, 416000001, 121.5, 24.9, ?1, NULL, '{}', 'tw')`).bind(T0),
  ]);
}

describe("region-aware API", () => {
  beforeEach(seed);

  it("snapshot filters by region and exposes region/shipType properties", async () => {
    const all = await (await SELF.fetch("https://x/api/snapshot")).json<any>();
    expect(all.vessels.features).toHaveLength(2);
    const kr = await (await SELF.fetch("https://x/api/snapshot?region=kr")).json<any>();
    expect(kr.vessels.features).toHaveLength(1);
    expect(kr.vessels.features[0].properties).toMatchObject({ mmsi: 440000001, region: "kr", shipType: 70 });
  });

  it("events filter by region; bad region → 400", async () => {
    const kr = await (await SELF.fetch(`https://x/api/events?since=0&region=kr`)).json<any>();
    expect(kr.events).toHaveLength(1);
    expect(kr.events[0]).toMatchObject({ id: "e-kr", region: "kr" });
    expect((await SELF.fetch("https://x/api/events?region=zz")).status).toBe(400);
    expect((await SELF.fetch("https://x/api/snapshot?region=zz")).status).toBe(400);
  });

  it("events honour limit (clamped to 1000)", async () => {
    const one = await (await SELF.fetch(`https://x/api/events?since=0&limit=1`)).json<any>();
    expect(one.events).toHaveLength(1);
    const huge = await (await SELF.fetch(`https://x/api/events?since=0&limit=99999`)).json<any>();
    expect(huge.events).toHaveLength(2); // clamp doesn't error, just caps
  });

  it("vessel dossier exposes region and static data", async () => {
    const body = await (await SELF.fetch("https://x/api/vessel/440000001")).json<any>();
    expect(body.vessel).toMatchObject({
      region: "kr", shipType: 70, destination: "BUSAN",
      dimBow: 100, dimStern: 20, dimPort: 10, dimStarboard: 12,
    });
  });
});
