// test/api.test.ts
import { env, SELF } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";

const T0 = Date.now() - 10 * 60_000; // "10 minutes ago" so snapshot window includes it

async function seed() {
  await env.DB.batch([
    env.DB.prepare("DELETE FROM vessels"), env.DB.prepare("DELETE FROM positions"),
    env.DB.prepare("DELETE FROM events"), env.DB.prepare("DELETE FROM gfw_events"),
    env.DB.prepare("DELETE FROM gfw_backfill"),
    env.DB.prepare(`INSERT INTO vessels (mmsi, name, callsign, last_lon, last_lat, last_sog, last_cog, last_ts, score, score_ts)
                    VALUES (412000001, 'TEST SHIP', 'BXYZ1', 120.2, 22.0, 0.5, 90, ?1, 6.5, ?1)`).bind(T0),
    env.DB.prepare(`INSERT INTO vessels (mmsi, name, callsign, last_lon, last_lat, last_sog, last_cog, last_ts, score, score_ts)
                    VALUES (412000002, 'OLD SHIP', NULL, 121.0, 23.0, 5, 0, ?1, 0, ?1)`).bind(T0 - 2 * 3_600_000),
    env.DB.prepare(`INSERT INTO positions VALUES (412000001, ?1, 120.19, 21.99, 1, 88)`).bind(T0 - 60_000),
    env.DB.prepare(`INSERT INTO positions VALUES (412000001, ?1, 120.2, 22.0, 0.5, 90)`).bind(T0),
    env.DB.prepare(`INSERT INTO events (id, type, severity, mmsi, lon, lat, start_ts, end_ts, evidence)
                    VALUES ('loitering-412000001-1', 'loitering', 3, 412000001, 120.2, 22.0, ?1, NULL, '{"corridor":"C1"}')`).bind(T0),
    env.DB.prepare(`INSERT INTO gfw_events VALUES ('gfw-1', 'gap', 412000001, 120.3, 22.1, ?1, ?2, '{}')`).bind(T0 - 3_600_000, T0),
  ]);
}

describe("API worker", () => {
  beforeEach(seed);

  it("/api/snapshot returns recent vessels as GeoJSON with generatedAt", async () => {
    const res = await SELF.fetch("https://x/api/snapshot");
    expect(res.status).toBe(200);
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
    const body = await res.json<any>();
    expect(body.generatedAt).toBeGreaterThan(0);
    expect(body.vessels.type).toBe("FeatureCollection");
    const mmsis = body.vessels.features.map((f: any) => f.properties.mmsi);
    expect(mmsis).toContain(412000001);
    expect(mmsis).not.toContain(412000002); // outside snapshot window
    const f = body.vessels.features[0];
    expect(f.geometry).toEqual({ type: "Point", coordinates: [120.2, 22.0] });
    expect(f.properties.score).toBeGreaterThan(0);
  });

  it("/api/events honours since and orders newest-first", async () => {
    const res = await SELF.fetch(`https://x/api/events?since=${T0 - 1}`);
    const body = await res.json<any>();
    expect(body.events).toHaveLength(1);
    expect(body.events[0]).toMatchObject({ id: "loitering-412000001-1", type: "loitering", endTs: null });
    expect(body.events[0].evidence.corridor).toBe("C1");
    const none = await (await SELF.fetch(`https://x/api/events?since=${T0 + 1}`)).json<any>();
    expect(none.events).toHaveLength(0);
  });

  it("/api/gfw returns corroboration events", async () => {
    const body = await (await SELF.fetch("https://x/api/gfw")).json<any>();
    expect(body.events).toHaveLength(1);
    expect(body.events[0].id).toBe("gfw-1");
  });

  it("/api/vessel/:mmsi returns dossier metadata (track moved to /track)", async () => {
    const body = await (await SELF.fetch("https://x/api/vessel/412000001")).json<any>();
    expect(body.vessel.name).toBe("TEST SHIP");
    expect(body.track).toBeUndefined();
    expect(body.events).toHaveLength(1);
  });

  it("/api/vessel/:mmsi/track returns windowed points + GFW breadcrumbs", async () => {
    // Fresh gfw_backfill row → the endpoint's on-demand backfill is a cache hit (no live fetch in tests).
    await env.DB.prepare(`INSERT OR REPLACE INTO gfw_backfill (mmsi, gfw_id, fetched_ts) VALUES (412000001, 'g1', ?1)`)
      .bind(Date.now()).run();
    const body = await (await SELF.fetch("https://x/api/vessel/412000001/track?window=day")).json<any>();
    expect(body.points).toHaveLength(2);
    expect(body.points[0].ts).toBeLessThan(body.points[1].ts);
    expect(body.gfwEvents).toHaveLength(1); // seeded gfw-1 (mmsi 412000001, 1 h before T0)
    expect(body.gfwEvents[0].id).toBe("gfw-1");
    expect(body.gfwError).toBe(false);
    expect((await SELF.fetch("https://x/api/vessel/412000001/track?window=year")).status).toBe(400);
    expect((await SELF.fetch("https://x/api/vessel/999999999/track")).status).toBe(404);
  });

  it("/api/vessel unknown mmsi -> 404; bad mmsi -> 400", async () => {
    expect((await SELF.fetch("https://x/api/vessel/999999999")).status).toBe(404);
    expect((await SELF.fetch("https://x/api/vessel/abc")).status).toBe(400);
  });

  it("/api/snapshot joins open events into activeEvents/topType", async () => {
    await env.DB.batch([
      env.DB.prepare(`INSERT INTO vessels (mmsi, name, callsign, last_lon, last_lat, last_sog, last_cog, last_ts, score, score_ts)
                      VALUES (412000003, 'CALM SHIP', NULL, 121.5, 24.0, 8, 45, ?1, 0, ?1)`).bind(T0),
      // higher-severity open event for 412000001 — must win topType over the seeded loitering (sev 3)
      env.DB.prepare(`INSERT INTO events (id, type, severity, mmsi, lon, lat, start_ts, end_ts, evidence)
                      VALUES ('gap-412000001-1', 'gap', 4, 412000001, 120.2, 22.0, ?1, NULL, '{}')`).bind(T0 - 1000),
      // closed event for 412000003 — must not count
      env.DB.prepare(`INSERT INTO events (id, type, severity, mmsi, lon, lat, start_ts, end_ts, evidence)
                      VALUES ('speed-412000003-1', 'speed_anomaly', 2, 412000003, 121.5, 24.0, ?1, ?2, '{}')`).bind(T0 - 5000, T0 - 4000),
      // open but older than 24 h — must not count either
      env.DB.prepare(`INSERT INTO events (id, type, severity, mmsi, lon, lat, start_ts, end_ts, evidence)
                      VALUES ('loitering-412000003-old', 'loitering', 3, 412000003, 121.5, 24.0, ?1, NULL, '{}')`).bind(Date.now() - 25 * 3_600_000),
    ]);
    const body = await (await SELF.fetch("https://x/api/snapshot")).json<any>();
    const props = Object.fromEntries(body.vessels.features.map((f: any) => [f.properties.mmsi, f.properties]));
    expect(props[412000001].activeEvents).toBe(2);   // seeded loitering + gap
    expect(props[412000001].topType).toBe("gap");    // severity 4 beats 3
    expect(props[412000003].activeEvents).toBe(0);   // closed + stale-open events excluded
    expect(props[412000003].topType).toBeNull();
  });
});
