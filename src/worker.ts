export { TrackerDO } from "./do/tracker";
import { CONFIG } from "./config";
import { decayedScore } from "./score";
import { gfwBackfillVessel, gfwSync } from "./gfw";
import { decimatePoints, parseWindow } from "./trajectories";

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
  region: r.region ?? null,
  evidence: JSON.parse(r.evidence ?? "{}"),
});

function regionParam(url: URL): string | null {
  const r = url.searchParams.get("region");
  if (r === null) return "";
  return CONFIG.regions.some((x) => x.id === r) ? r : null;
}

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(req.url);
    if (!url.pathname.startsWith("/api/")) return env.ASSETS.fetch(req);

    ensureTracker(env, ctx); // any API hit keeps the ingest DO alive
    const now = Date.now();

    if (url.pathname === "/api/snapshot") {
      const region = regionParam(url);
      if (region === null) return json({ error: "bad region" }, 400);
      const eventsSince = now - 86_400_000; // open events older than 24 h don't flag a vessel
      const baseSelect = `
        SELECT v.*, COALESCE(ev.active_events, 0) AS active_events, ev.top_type
        FROM vessels v
        LEFT JOIN (
          SELECT e.mmsi, COUNT(*) AS active_events,
                 (SELECT e2.type FROM events e2
                  WHERE e2.mmsi = e.mmsi AND e2.end_ts IS NULL AND e2.start_ts >= ?2
                  ORDER BY e2.severity DESC, e2.start_ts DESC LIMIT 1) AS top_type
          FROM events e
          WHERE e.end_ts IS NULL AND e.start_ts >= ?2
          GROUP BY e.mmsi
        ) ev ON ev.mmsi = v.mmsi`;
      const { results } = region
        ? await env.DB.prepare(`${baseSelect} WHERE v.last_ts >= ?1 AND v.region = ?3 ORDER BY v.score DESC`)
            .bind(now - CONFIG.snapshotWindowMs, eventsSince, region).all<any>()
        : await env.DB.prepare(`${baseSelect} WHERE v.last_ts >= ?1 ORDER BY v.score DESC`)
            .bind(now - CONFIG.snapshotWindowMs, eventsSince).all<any>();
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
              region: r.region ?? null, shipType: r.ship_type ?? null,
              activeEvents: r.active_events,
              topType: r.top_type ?? null,
            },
          })),
        },
      });
    }

    if (url.pathname === "/api/trajectories") {
      const region = regionParam(url);
      if (region === null) return json({ error: "bad region" }, 400);
      const winMs = parseWindow(url.searchParams.get("window"));
      if (winMs === null) return json({ error: "bad window" }, 400);
      const eventsSince = now - 86_400_000; // same open-event rule as /api/snapshot
      // SQL prefilter only (decayed score can never exceed the stored score); exact decay,
      // the sus test, and the top-50 cap happen in JS with the shared decayedScore().
      const susSelect = `
        SELECT v.mmsi, v.name, v.score, v.score_ts, COALESCE(ev.active_events, 0) AS active_events, ev.top_type
        FROM vessels v
        LEFT JOIN (
          SELECT e.mmsi, COUNT(*) AS active_events,
                 (SELECT e2.type FROM events e2
                  WHERE e2.mmsi = e.mmsi AND e2.end_ts IS NULL AND e2.start_ts >= ?1
                  ORDER BY e2.severity DESC, e2.start_ts DESC LIMIT 1) AS top_type
          FROM events e
          WHERE e.end_ts IS NULL AND e.start_ts >= ?1
          GROUP BY e.mmsi
        ) ev ON ev.mmsi = v.mmsi
        WHERE (COALESCE(ev.active_events, 0) > 0 OR v.score >= ?2)`;
      const { results } = region
        ? await env.DB.prepare(`${susSelect} AND v.region = ?3`).bind(eventsSince, CONFIG.susScoreThreshold, region).all<any>()
        : await env.DB.prepare(susSelect).bind(eventsSince, CONFIG.susScoreThreshold).all<any>();
      const sus = results
        .map((r) => ({ ...r, decayed: decayedScore(r.score, r.score_ts, now, CONFIG.scoreHalfLifeMs) }))
        .filter((r) => r.active_events > 0 || r.decayed >= CONFIG.susScoreThreshold)
        .sort((a, b) => b.decayed - a.decayed)
        .slice(0, CONFIG.trajectoryMaxVessels);
      if (!sus.length) return json({ generatedAt: now, trajectories: [] });
      const marks = sus.map((_, i) => `?${i + 2}`).join(",");
      const { results: pts } = await env.DB.prepare(
        `SELECT mmsi, ts, lon, lat FROM positions WHERE ts >= ?1 AND mmsi IN (${marks}) ORDER BY mmsi, ts`,
      ).bind(now - winMs, ...sus.map((s) => s.mmsi)).all<any>();
      const byMmsi = new Map<number, [number, number, number][]>();
      for (const p of pts) {
        let arr = byMmsi.get(p.mmsi);
        if (!arr) byMmsi.set(p.mmsi, (arr = []));
        arr.push([p.lon, p.lat, p.ts]);
      }
      return json({
        generatedAt: now,
        trajectories: sus.map((s) => ({
          mmsi: s.mmsi, name: s.name,
          score: Math.round(s.decayed * 10) / 10,
          topType: s.top_type ?? null,
          points: decimatePoints(byMmsi.get(s.mmsi) ?? [], CONFIG.trajectoryMaxPoints),
        })).filter((t) => t.points.length >= 2), // a single point can't draw a line
      });
    }

    if (url.pathname === "/api/events") {
      const region = regionParam(url);
      if (region === null) return json({ error: "bad region" }, 400);
      const since = Number(url.searchParams.get("since") ?? 0);
      const limit = Math.min(Math.max(Math.trunc(Number(url.searchParams.get("limit")) || 200), 1), 1000);
      const { results } = region
        ? await env.DB.prepare(`SELECT * FROM events WHERE start_ts >= ?1 AND region = ?2 ORDER BY start_ts DESC LIMIT ?3`)
            .bind(Number.isFinite(since) ? since : 0, region, limit).all<any>()
        : await env.DB.prepare(`SELECT * FROM events WHERE start_ts >= ?1 ORDER BY start_ts DESC LIMIT ?2`)
            .bind(Number.isFinite(since) ? since : 0, limit).all<any>();
      return json({ generatedAt: now, events: results.map(rowToEvent) });
    }

    if (url.pathname === "/api/stats") {
      const DAY = 86_400_000;
      const [vc, ac, e24, hist] = await env.DB.batch([
        env.DB.prepare(`SELECT region, COUNT(*) AS c FROM vessels WHERE last_ts >= ?1 AND region IS NOT NULL GROUP BY region`)
          .bind(now - CONFIG.snapshotWindowMs),
        env.DB.prepare(`SELECT region, COUNT(*) AS c FROM events WHERE end_ts IS NULL AND region IS NOT NULL GROUP BY region`),
        env.DB.prepare(`SELECT region, COUNT(*) AS c FROM events WHERE start_ts >= ?1 AND region IS NOT NULL GROUP BY region`)
          .bind(now - DAY),
        env.DB.prepare(`SELECT region, severity, date(start_ts / 1000, 'unixepoch') AS d, COUNT(*) AS c
                        FROM events WHERE start_ts >= ?1 AND region IS NOT NULL GROUP BY region, severity, d`)
          .bind(now - 13 * DAY - (now % DAY)),
      ]);
      const regions: Record<string, { vessels: number; activeAlerts: number; events24h: number }> = {};
      const histogram: Record<string, { day: string; counts: number[] }[]> = {};
      for (const r of CONFIG.regions) {
        regions[r.id] = { vessels: 0, activeAlerts: 0, events24h: 0 };
        histogram[r.id] = Array.from({ length: 14 }, (_, i) => ({
          day: new Date(now - (13 - i) * DAY).toISOString().slice(0, 10),
          counts: [0, 0, 0, 0, 0],
        }));
      }
      for (const row of vc.results as any[]) if (regions[row.region]) regions[row.region].vessels = row.c;
      for (const row of ac.results as any[]) if (regions[row.region]) regions[row.region].activeAlerts = row.c;
      for (const row of e24.results as any[]) if (regions[row.region]) regions[row.region].events24h = row.c;
      for (const row of hist.results as any[]) {
        const bucket = histogram[row.region]?.find((b) => b.day === row.d);
        if (bucket) bucket.counts[row.severity - 1] = row.c;
      }
      return json({ generatedAt: now, regions, histogram });
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

    const trackMatch = /^\/api\/vessel\/(\d{1,9})\/track$/.exec(url.pathname);
    if (trackMatch) {
      const mmsi = Number(trackMatch[1]);
      const winMs = parseWindow(url.searchParams.get("window"));
      if (winMs === null) return json({ error: "bad window" }, 400);
      const vessel = await env.DB.prepare(`SELECT mmsi FROM vessels WHERE mmsi = ?1`).bind(mmsi).first<any>();
      if (!vessel) return json({ error: "unknown vessel" }, 404);
      // On-demand GFW backfill (24 h cache). A GFW failure must not block our own points (spec §4).
      const { error: gfwError } = await gfwBackfillVessel(env, mmsi, now);
      const [points, gfw] = await Promise.all([
        env.DB.prepare(`SELECT ts, lon, lat, sog, cog FROM positions WHERE mmsi = ?1 AND ts >= ?2 ORDER BY ts ASC`)
          .bind(mmsi, now - winMs).all<any>(),
        env.DB.prepare(`SELECT id, type, lon, lat, start_ts, end_ts FROM gfw_events WHERE mmsi = ?1 AND start_ts >= ?2 ORDER BY start_ts ASC`)
          .bind(mmsi, now - winMs).all<any>(),
      ]);
      return json({
        generatedAt: now,
        points: points.results,
        gfwEvents: gfw.results.map((r: any) => ({ id: r.id, type: r.type, lon: r.lon, lat: r.lat, startTs: r.start_ts, endTs: r.end_ts })),
        gfwError,
      });
    }

    const vesselMatch = /^\/api\/vessel\/(\d{1,9})$/.exec(url.pathname);
    if (vesselMatch) {
      const mmsi = Number(vesselMatch[1]);
      const vessel = await env.DB.prepare(`SELECT * FROM vessels WHERE mmsi = ?1`).bind(mmsi).first<any>();
      if (!vessel) return json({ error: "unknown vessel" }, 404);
      const events = await env.DB.prepare(`SELECT * FROM events WHERE mmsi = ?1 ORDER BY start_ts DESC LIMIT 100`).bind(mmsi).all<any>();
      return json({
        generatedAt: now,
        vessel: {
          mmsi: vessel.mmsi, name: vessel.name, callsign: vessel.callsign,
          lon: vessel.last_lon, lat: vessel.last_lat, sog: vessel.last_sog, cog: vessel.last_cog, lastTs: vessel.last_ts,
          score: Math.round(decayedScore(vessel.score, vessel.score_ts, now, CONFIG.scoreHalfLifeMs) * 10) / 10,
          region: vessel.region ?? null, shipType: vessel.ship_type ?? null,
          destination: vessel.destination ?? null,
          dimBow: vessel.dim_bow ?? null, dimStern: vessel.dim_stern ?? null,
          dimPort: vessel.dim_port ?? null, dimStarboard: vessel.dim_starboard ?? null,
        },
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
