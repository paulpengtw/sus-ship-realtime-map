// test/api.test.ts
import { env, SELF } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";

const T0 = Date.now() - 10 * 60_000; // "10 minutes ago" so snapshot window includes it

async function seed() {
  await env.DB.batch([
    env.DB.prepare("DELETE FROM vessels"), env.DB.prepare("DELETE FROM positions"),
    env.DB.prepare("DELETE FROM events"), env.DB.prepare("DELETE FROM gfw_events"),
    env.DB.prepare(`INSERT INTO vessels VALUES (412000001, 'TEST SHIP', 'BXYZ1', 120.2, 22.0, 0.5, 90, ?1, 6.5, ?1)`).bind(T0),
    env.DB.prepare(`INSERT INTO vessels VALUES (412000002, 'OLD SHIP', NULL, 121.0, 23.0, 5, 0, ?1, 0, ?1)`).bind(T0 - 2 * 3_600_000),
    env.DB.prepare(`INSERT INTO positions VALUES (412000001, ?1, 120.19, 21.99, 1, 88)`).bind(T0 - 60_000),
    env.DB.prepare(`INSERT INTO positions VALUES (412000001, ?1, 120.2, 22.0, 0.5, 90)`).bind(T0),
    env.DB.prepare(`INSERT INTO events VALUES ('loitering-412000001-1', 'loitering', 3, 412000001, 120.2, 22.0, ?1, NULL, '{"corridor":"C1"}')`).bind(T0),
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

  it("/api/vessel/:mmsi returns dossier with ascending track", async () => {
    const body = await (await SELF.fetch("https://x/api/vessel/412000001")).json<any>();
    expect(body.vessel.name).toBe("TEST SHIP");
    expect(body.track).toHaveLength(2);
    expect(body.track[0].ts).toBeLessThan(body.track[1].ts);
    expect(body.events).toHaveLength(1);
  });

  it("/api/vessel unknown mmsi -> 404; bad mmsi -> 400", async () => {
    expect((await SELF.fetch("https://x/api/vessel/999999999")).status).toBe(404);
    expect((await SELF.fetch("https://x/api/vessel/abc")).status).toBe(400);
  });
});
