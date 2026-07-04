export { TrackerDO } from "./do/tracker";
import { CONFIG } from "./config";
import { decayedScore } from "./score";
import { gfwSync } from "./gfw";

export interface Env {
  DB: D1Database;
  TRACKER: DurableObjectNamespace;
  ASSETS: Fetcher;
  AISSTREAM_KEY: string;
  GFW_TOKEN: string;
  TEST_MIGRATIONS?: unknown;
}

const CORS = { "access-control-allow-origin": "*", "content-type": "application/json" };
const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: CORS });

function ensureTracker(env: Env, ctx: ExecutionContext): void {
  if (env.TEST_MIGRATIONS) return;
  const stub = env.TRACKER.get(env.TRACKER.idFromName("singleton"));
  ctx.waitUntil(stub.fetch("https://do/ensure").catch((e) => console.error("ensure failed:", e)));
}

const rowToEvent = (r: any) => ({
  id: r.id, type: r.type, severity: r.severity, mmsi: r.mmsi,
  lon: r.lon, lat: r.lat, startTs: r.start_ts, endTs: r.end_ts,
  evidence: JSON.parse(r.evidence ?? "{}"),
});

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(req.url);
    if (!url.pathname.startsWith("/api/")) return env.ASSETS.fetch(req);

    ensureTracker(env, ctx); // any API hit keeps the ingest DO alive
    const now = Date.now();

    if (url.pathname === "/api/snapshot") {
      const { results } = await env.DB.prepare(
        `SELECT * FROM vessels WHERE last_ts >= ?1 ORDER BY score DESC`,
      ).bind(now - CONFIG.snapshotWindowMs).all<any>();
      const newestTs = results.reduce((m, r) => Math.max(m, r.last_ts), 0);
      return json({
        generatedAt: now,
        newestTs: newestTs || null,
        vessels: {
          type: "FeatureCollection",
          features: results.map((r) => ({
            type: "Feature",
            geometry: { type: "Point", coordinates: [r.last_lon, r.last_lat] },
            properties: {
              mmsi: r.mmsi, name: r.name, sog: r.last_sog, cog: r.last_cog,
              score: Math.round(decayedScore(r.score, r.score_ts, now, CONFIG.scoreHalfLifeMs) * 10) / 10,
              lastTs: r.last_ts,
            },
          })),
        },
      });
    }

    if (url.pathname === "/api/events") {
      const since = Number(url.searchParams.get("since") ?? 0);
      const { results } = await env.DB.prepare(
        `SELECT * FROM events WHERE start_ts >= ?1 ORDER BY start_ts DESC LIMIT 200`,
      ).bind(Number.isFinite(since) ? since : 0).all<any>();
      return json({ generatedAt: now, events: results.map(rowToEvent) });
    }

    if (url.pathname === "/api/gfw") {
      const { results } = await env.DB.prepare(
        `SELECT * FROM gfw_events WHERE start_ts >= ?1 ORDER BY start_ts DESC LIMIT 500`,
      ).bind(now - 14 * 24 * 3_600_000).all<any>();
      return json({
        generatedAt: now,
        events: results.map((r: any) => ({ id: r.id, type: r.type, mmsi: r.mmsi, lon: r.lon, lat: r.lat, startTs: r.start_ts, endTs: r.end_ts })),
      });
    }

    const vesselMatch = /^\/api\/vessel\/(\d{1,9})$/.exec(url.pathname);
    if (vesselMatch) {
      const mmsi = Number(vesselMatch[1]);
      const vessel = await env.DB.prepare(`SELECT * FROM vessels WHERE mmsi = ?1`).bind(mmsi).first<any>();
      if (!vessel) return json({ error: "unknown vessel" }, 404);
      const [track, events] = await Promise.all([
        env.DB.prepare(`SELECT ts, lon, lat, sog, cog FROM positions WHERE mmsi = ?1 ORDER BY ts DESC LIMIT 500`).bind(mmsi).all<any>(),
        env.DB.prepare(`SELECT * FROM events WHERE mmsi = ?1 ORDER BY start_ts DESC LIMIT 100`).bind(mmsi).all<any>(),
      ]);
      return json({
        generatedAt: now,
        vessel: {
          mmsi: vessel.mmsi, name: vessel.name, callsign: vessel.callsign,
          lon: vessel.last_lon, lat: vessel.last_lat, sog: vessel.last_sog, cog: vessel.last_cog, lastTs: vessel.last_ts,
          score: Math.round(decayedScore(vessel.score, vessel.score_ts, now, CONFIG.scoreHalfLifeMs) * 10) / 10,
        },
        track: track.results.reverse(),
        events: events.results.map(rowToEvent),
      });
    }

    if (url.pathname.startsWith("/api/vessel/")) return json({ error: "bad mmsi" }, 400);
    return json({ error: "not found" }, 404);
  },

  async scheduled(event: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ensureTracker(env, ctx); // */5 cron doubles as ingest keep-alive
    if (event.cron === "15 2 * * *") {
      ctx.waitUntil(gfwSync(env, Date.now()).catch((e) => console.error("gfw sync failed:", e)));
    }
  },
} satisfies ExportedHandler<Env>;
