export { TrackerDO } from "./do/tracker";
import { CONFIG } from "./config";
import { gfwBackfillVessel, gfwSync } from "./gfw";
import { LABEL_SOURCES, LABEL_VERDICTS, rowToCandidate } from "./labeling";
import { decimatePoints, parseWindow } from "./trajectories";
import { THREAT_CATEGORIES } from "./types";

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

const rowToAssessment = (r: any) => ({
  id: r.id, mmsi: r.mmsi, category: r.category, status: r.status,
  confidence: r.confidence, openedTs: r.opened_ts, updatedTs: r.updated_ts, closedTs: r.closed_ts,
  region: r.region ?? null, narrative: r.narrative, evidence: JSON.parse(r.evidence ?? "[]"),
  lastLon: r.last_lon, lastLat: r.last_lat,
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

    if (url.pathname === "/api/assessments") {
      const region = regionParam(url);
      if (region === null) return json({ error: "bad region" }, 400);
      const winMs = parseWindow(url.searchParams.get("window"));
      if (winMs === null) return json({ error: "bad window" }, 400);
      const base = `SELECT * FROM assessments WHERE (status = 'open' OR closed_ts >= ?1)`;
      const { results } = region
        ? await env.DB.prepare(`${base} AND region = ?2 ORDER BY updated_ts DESC LIMIT 200`).bind(now - winMs, region).all<any>()
        : await env.DB.prepare(`${base} ORDER BY updated_ts DESC LIMIT 200`).bind(now - winMs).all<any>();
      return json({ generatedAt: now, assessments: results.map(rowToAssessment) });
    }

    if (url.pathname === "/api/snapshot") {
      const region = regionParam(url);
      if (region === null) return json({ error: "bad region" }, 400);
      const baseSelect = `
        SELECT v.*, a.cats FROM vessels v
        LEFT JOIN (
          SELECT mmsi, json_group_array(json_object('category', category, 'confidence', confidence)) AS cats
          FROM assessments WHERE status = 'open' GROUP BY mmsi
        ) a ON a.mmsi = v.mmsi`;
      const { results } = region
        ? await env.DB.prepare(`${baseSelect} WHERE v.last_ts >= ?1 AND v.region = ?2`).bind(now - CONFIG.snapshotWindowMs, region).all<any>()
        : await env.DB.prepare(`${baseSelect} WHERE v.last_ts >= ?1`).bind(now - CONFIG.snapshotWindowMs).all<any>();
      const withAssess = results.map((r) => {
        const assessments: { category: string; confidence: number }[] = JSON.parse(r.cats ?? "[]");
        assessments.sort((a, b) => b.confidence - a.confidence);
        return { ...r, assessments, maxConfidence: assessments[0]?.confidence ?? 0, topCategory: assessments[0]?.category ?? null };
      }).sort((a, b) => b.maxConfidence - a.maxConfidence);
      const newestTs = withAssess.reduce((m, r) => Math.max(m, r.last_ts), 0);
      return json({
        generatedAt: now,
        newestTs: newestTs || null,
        vessels: {
          type: "FeatureCollection",
          features: withAssess.map((r) => ({
            type: "Feature",
            geometry: { type: "Point", coordinates: [r.last_lon, r.last_lat] },
            properties: {
              mmsi: r.mmsi, name: r.name, sog: r.last_sog, cog: r.last_cog,
              lastTs: r.last_ts, region: r.region ?? null, shipType: r.ship_type ?? null,
              assessments: r.assessments, topCategory: r.topCategory,
              maxConfidence: r.maxConfidence,
              score: Math.round(r.maxConfidence * 5 * 10) / 10, // legacy, remove next release
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
      const susSelect = `
        SELECT v.mmsi, v.name, a.max_conf, a.top_category
        FROM vessels v
        JOIN (
          SELECT mmsi, MAX(confidence) AS max_conf,
                 (SELECT a2.category FROM assessments a2
                  WHERE a2.mmsi = a.mmsi AND a2.status = 'open'
                  ORDER BY a2.confidence DESC, a2.category LIMIT 1) AS top_category
          FROM assessments a WHERE a.status = 'open' GROUP BY a.mmsi
        ) a ON a.mmsi = v.mmsi`;
      const { results } = region
        ? await env.DB.prepare(`${susSelect} WHERE v.region = ?1`).bind(region).all<any>()
        : await env.DB.prepare(susSelect).all<any>();
      const sus = results
        .sort((a, b) => b.max_conf - a.max_conf)
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
          confidence: s.max_conf,
          topCategory: s.top_category ?? null,
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
        env.DB.prepare(`SELECT region, COUNT(*) AS c FROM assessments WHERE status = 'open' AND region IS NOT NULL GROUP BY region`),
        env.DB.prepare(`SELECT region, COUNT(*) AS c FROM events WHERE start_ts >= ?1 AND region IS NOT NULL GROUP BY region`)
          .bind(now - DAY),
        env.DB.prepare(`SELECT region, category, date(opened_ts / 1000, 'unixepoch') AS d, COUNT(*) AS c
                        FROM assessments WHERE opened_ts >= ?1 AND region IS NOT NULL GROUP BY region, category, d`)
          .bind(now - 13 * DAY - (now % DAY)),
      ]);
      const regions: Record<string, { vessels: number; activeAlerts: number; events24h: number }> = {};
      const histogram: Record<string, { day: string; counts: number[] }[]> = {};
      for (const r of CONFIG.regions) {
        regions[r.id] = { vessels: 0, activeAlerts: 0, events24h: 0 };
        histogram[r.id] = Array.from({ length: 14 }, (_, i) => ({
          day: new Date(now - (13 - i) * DAY).toISOString().slice(0, 10),
          counts: [0, 0, 0],
        }));
      }
      for (const row of vc.results as any[]) if (regions[row.region]) regions[row.region].vessels = row.c;
      for (const row of ac.results as any[]) if (regions[row.region]) regions[row.region].activeAlerts = row.c;
      for (const row of e24.results as any[]) if (regions[row.region]) regions[row.region].events24h = row.c;
      for (const row of hist.results as any[]) {
        const bucket = histogram[row.region]?.find((b) => b.day === row.d);
        const idx = THREAT_CATEGORIES.indexOf(row.category);
        if (bucket && idx >= 0) bucket.counts[idx] = row.c;
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

    if (url.pathname === "/api/labels/queue") {
      const source = url.searchParams.get("source");
      if (source !== null && !(LABEL_SOURCES as readonly string[]).includes(source)) return json({ error: "bad source" }, 400);
      const limit = Math.min(Math.max(Math.trunc(Number(url.searchParams.get("limit")) || 25), 1), 100);
      const sql = source
        ? `SELECT c.* FROM candidate_incidents c LEFT JOIN labels l ON l.incident_id = c.id
           WHERE l.id IS NULL AND c.source = ?1 ORDER BY c.created_at DESC LIMIT ?2`
        : `SELECT c.* FROM candidate_incidents c LEFT JOIN labels l ON l.incident_id = c.id
           WHERE l.id IS NULL ORDER BY c.created_at DESC LIMIT ?1`;
      const { results } = source
        ? await env.DB.prepare(sql).bind(source, limit).all<any>()
        : await env.DB.prepare(sql).bind(limit).all<any>();
      return json({ generatedAt: now, candidates: results.map(rowToCandidate) });
    }

    if (url.pathname === "/api/labels/stats") {
      const [srcRows, verdictRows] = await env.DB.batch([
        env.DB.prepare(`
          SELECT c.source AS src,
                 COUNT(DISTINCT c.id) AS total,
                 COUNT(DISTINCT CASE WHEN l.id IS NOT NULL THEN c.id END) AS labeled
          FROM candidate_incidents c LEFT JOIN labels l ON l.incident_id = c.id
          GROUP BY c.source`),
        env.DB.prepare(`SELECT verdict AS v, COUNT(*) AS c FROM labels GROUP BY verdict`),
      ]);
      const bySource: Record<string, { total: number; labeled: number }> = {};
      for (const s of LABEL_SOURCES) bySource[s] = { total: 0, labeled: 0 };
      for (const r of srcRows.results as any[]) bySource[r.src] = { total: Number(r.total), labeled: Number(r.labeled) };
      const byVerdict = { threat: 0, suspicious: 0, benign: 0, unclear: 0 };
      for (const r of verdictRows.results as any[]) if (r.v in byVerdict) (byVerdict as any)[r.v] = Number(r.c);
      return json({
        generatedAt: now, bySource, byVerdict,
        imbalance: {
          threatVsBenign: byVerdict.threat / Math.max(byVerdict.benign, 1),
          benignVsThreat: byVerdict.benign / Math.max(byVerdict.threat, 1),
        },
      });
    }

    if (url.pathname === "/api/labels" && req.method === "POST") {
      let body: any;
      try { body = await req.json(); } catch { return json({ error: "bad json" }, 400); }
      const { incidentId, labeler, verdict, intentCategories, labelerConfidence, notes } = body ?? {};
      if (typeof incidentId !== "string" || !incidentId) return json({ error: "incidentId required" }, 400);
      if (typeof labeler !== "string" || !labeler) return json({ error: "labeler required" }, 400);
      if (!(LABEL_VERDICTS as readonly string[]).includes(verdict)) return json({ error: "bad verdict" }, 400);
      const needsIntent = verdict === "threat" || verdict === "suspicious";
      if (needsIntent) {
        if (!Array.isArray(intentCategories) || intentCategories.length === 0
            || !intentCategories.every((c: string) => (THREAT_CATEGORIES as readonly string[]).includes(c))) {
          return json({ error: "intentCategories required and must be non-empty ThreatCategory[]" }, 400);
        }
      } else if (Array.isArray(intentCategories) && intentCategories.length > 0) {
        return json({ error: "intentCategories only for threat/suspicious" }, 400);
      }
      if (labelerConfidence !== undefined && labelerConfidence !== null && !(Number.isInteger(labelerConfidence) && labelerConfidence >= 1 && labelerConfidence <= 5)) {
        return json({ error: "labelerConfidence must be integer 1..5 or null" }, 400);
      }
      const existsRow = await env.DB.prepare(`SELECT id FROM candidate_incidents WHERE id = ?1`).bind(incidentId).first<any>();
      if (!existsRow) return json({ error: "unknown incidentId" }, 404);
      const dup = await env.DB.prepare(
        `SELECT id FROM labels WHERE incident_id = ?1 AND labeler = ?2`,
      ).bind(incidentId, labeler).first<{ id: number }>();
      if (dup) return json({ error: "already labeled" }, 409);
      try {
        const result = await env.DB.prepare(
          `INSERT INTO labels (incident_id, labeler, ts, verdict, intent_categories, labeler_confidence, notes)
           VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)`,
        ).bind(
          incidentId, labeler, now, verdict,
          needsIntent ? JSON.stringify(intentCategories) : null,
          labelerConfidence ?? null,
          typeof notes === "string" ? notes : null,
        ).run();
        return json({ ok: true, id: result.meta.last_row_id }, 201);
      } catch (err) {
        if (String(err).match(/UNIQUE/i)) return json({ error: "already labeled" }, 409);
        throw err;
      }
    }

    if (url.pathname === "/api/labels/materialize/assessments") {
      const since = Number(url.searchParams.get("since") ?? 0);
      const until = Number(url.searchParams.get("until") ?? now);
      if (!Number.isFinite(since) || !Number.isFinite(until)) return json({ error: "bad range" }, 400);
      const { results } = await env.DB.prepare(
        `SELECT id, mmsi, opened_ts, closed_ts, category, confidence, region
         FROM assessments WHERE opened_ts >= ?1 AND opened_ts <= ?2 ORDER BY opened_ts ASC`,
      ).bind(since, until).all<any>();
      return json({ generatedAt: now, rows: results });
    }

    if (url.pathname === "/api/labels/materialize/event-clusters") {
      const since = Number(url.searchParams.get("since") ?? 0);
      const until = Number(url.searchParams.get("until") ?? now);
      if (!Number.isFinite(since) || !Number.isFinite(until)) return json({ error: "bad range" }, 400);
      const [events, assessments] = await env.DB.batch([
        env.DB.prepare(`SELECT id, mmsi, start_ts, type FROM events WHERE start_ts BETWEEN ?1 AND ?2`).bind(since, until),
        env.DB.prepare(
          `SELECT opened_ts, closed_ts FROM assessments
           WHERE opened_ts <= ?2 AND COALESCE(closed_ts, ?2) >= ?1`,
        ).bind(since, until),
      ]);
      const assessmentWindows = (assessments.results as any[]).map((r) => ({
        tStart: r.opened_ts, tEnd: r.closed_ts ?? now,
      }));
      return json({ generatedAt: now, events: events.results, assessmentWindows });
    }

    if (url.pathname === "/api/labels/materialize/random-negatives") {
      const since = Number(url.searchParams.get("since") ?? 0);
      const until = Number(url.searchParams.get("until") ?? now);
      if (!Number.isFinite(since) || !Number.isFinite(until)) return json({ error: "bad range" }, 400);
      const [vesselDays, assessments, events] = await env.DB.batch([
        env.DB.prepare(`
          SELECT v.mmsi AS vessel_id,
                 CAST((p.ts / 86400000) AS INTEGER) * 86400000 AS day_ms,
                 COUNT(p.ts) AS positions
          FROM positions p JOIN vessels v ON v.mmsi = p.mmsi
          WHERE p.ts BETWEEN ?1 AND ?2
          GROUP BY v.mmsi, day_ms HAVING positions >= 20`).bind(since, until),
        env.DB.prepare(
          `SELECT opened_ts, closed_ts FROM assessments
           WHERE opened_ts <= ?2 AND COALESCE(closed_ts, ?2) >= ?1`,
        ).bind(since, until),
        env.DB.prepare(`SELECT DISTINCT mmsi, CAST((start_ts / 86400000) AS INTEGER) * 86400000 AS day_ms FROM events WHERE start_ts BETWEEN ?1 AND ?2`).bind(since, until),
      ]);
      const eventDays = new Set((events.results as any[]).map((e) => `${e.mmsi}:${e.day_ms}`));
      const eligibleDays = (vesselDays.results as any[])
        .filter((r) => !eventDays.has(`${r.vessel_id}:${r.day_ms}`))
        .map((r) => ({ vessel_id: String(r.vessel_id), day_ms: Number(r.day_ms) }));
      const skipWindows = (assessments.results as any[]).map((r) => ({ tStart: r.opened_ts, tEnd: r.closed_ts ?? now }));
      return json({ generatedAt: now, vesselDays: eligibleDays, skipWindows });
    }

    if (url.pathname === "/api/labels/materialize" && req.method === "POST") {
      let body: any;
      try { body = await req.json(); } catch { return json({ error: "bad json" }, 400); }
      const candidates = body?.candidates as any[] | undefined;
      if (!Array.isArray(candidates)) return json({ error: "candidates required" }, 400);
      if (candidates.length > 100) return json({ error: "too many candidates (max 100)" }, 400);
      for (const c of candidates) {
        if (typeof c?.id !== "string" || !/^[0-9a-f]{16}$/.test(c.id)) return json({ error: "bad candidate: id" }, 400);
        if (typeof c.vesselId !== "string" || !/^\d{1,9}$/.test(c.vesselId)) return json({ error: "bad candidate: vesselId" }, 400);
        if (!Number.isInteger(c.tStart) || !Number.isInteger(c.tEnd) || c.tStart >= c.tEnd) return json({ error: "bad candidate: window" }, 400);
        if (!(LABEL_SOURCES as readonly string[]).includes(c.source)) return json({ error: "bad candidate: source" }, 400);
        if (c.sourceRef !== null && (typeof c.sourceRef !== "string" || c.sourceRef.length > 200)) return json({ error: "bad candidate: sourceRef" }, 400);
        if (!Number.isInteger(c.createdAt) || c.createdAt < 0) return json({ error: "bad candidate: createdAt" }, 400);
        if (!Array.isArray(c.eventIds) || !c.eventIds.every((e: unknown) => typeof e === "string" && e.length <= 100)) return json({ error: "bad candidate: eventIds" }, 400);
      }
      const { SHARED_INSERT_SQL, toInsertRow } = await import("./materializer");
      const stmts = candidates.map((c) => env.DB.prepare(SHARED_INSERT_SQL).bind(...toInsertRow(c)));
      const BATCH_SIZE = 100;
      let inserted = 0;
      for (let i = 0; i < stmts.length; i += BATCH_SIZE) {
        const chunk = stmts.slice(i, i + BATCH_SIZE);
        const results = await env.DB.batch(chunk);
        inserted += results.reduce((a: number, r: any) => a + (r.meta?.changes ?? 0), 0);
      }
      return json({ ok: true, inserted });
    }

    const trackMatch = /^\/api\/vessel\/(\d{1,9})\/track$/.exec(url.pathname);
    if (trackMatch) {
      const mmsi = Number(trackMatch[1]);
      const fromRaw = url.searchParams.get("from");
      const toRaw = url.searchParams.get("to");
      let fromTs: number, toTs: number;
      if (fromRaw !== null || toRaw !== null) {
        const from = Number(fromRaw), to = Number(toRaw);
        if (!Number.isFinite(from) || !Number.isFinite(to) || from >= to) return json({ error: "bad range" }, 400);
        fromTs = from; toTs = to;
      } else {
        const winMs = parseWindow(url.searchParams.get("window"));
        if (winMs === null) return json({ error: "bad window" }, 400);
        fromTs = now - winMs; toTs = now;
      }
      const vessel = await env.DB.prepare(`SELECT mmsi FROM vessels WHERE mmsi = ?1`).bind(mmsi).first<any>();
      if (!vessel) return json({ error: "unknown vessel" }, 404);
      const { error: gfwError } = await gfwBackfillVessel(env, mmsi, now);
      const [points, gfw] = await Promise.all([
        env.DB.prepare(`SELECT ts, lon, lat, sog, cog FROM positions WHERE mmsi = ?1 AND ts BETWEEN ?2 AND ?3 ORDER BY ts ASC`)
          .bind(mmsi, fromTs, toTs).all<any>(),
        env.DB.prepare(`SELECT id, type, lon, lat, start_ts, end_ts FROM gfw_events WHERE mmsi = ?1 AND start_ts BETWEEN ?2 AND ?3 ORDER BY start_ts ASC`)
          .bind(mmsi, fromTs, toTs).all<any>(),
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
      const assess = await env.DB.prepare(`SELECT * FROM assessments WHERE mmsi = ?1 ORDER BY updated_ts DESC LIMIT 20`).bind(mmsi).all<any>();
      const assessments = assess.results.map(rowToAssessment);
      const maxConfidence = Math.max(0, ...assessments.filter((a) => a.status === "open").map((a) => a.confidence));
      return json({
        generatedAt: now,
        vessel: {
          mmsi: vessel.mmsi, name: vessel.name, callsign: vessel.callsign,
          lon: vessel.last_lon, lat: vessel.last_lat, sog: vessel.last_sog, cog: vessel.last_cog, lastTs: vessel.last_ts,
          score: Math.round(maxConfidence * 5 * 10) / 10,
          region: vessel.region ?? null, shipType: vessel.ship_type ?? null,
          destination: vessel.destination ?? null,
          dimBow: vessel.dim_bow ?? null, dimStern: vessel.dim_stern ?? null,
          dimPort: vessel.dim_port ?? null, dimStarboard: vessel.dim_starboard ?? null,
        },
        events: events.results.map(rowToEvent),
        assessments,
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
