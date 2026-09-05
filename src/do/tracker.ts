// src/do/tracker.ts — websocket lifecycle, alarms, batching under the D1 write budget. Logic lives in pipeline.ts.
import { CONFIG } from "../config";
import { flushWrites, loadOpenAssessments, loadRecentVesselStates, newPendingWrites, thinPositions } from "../db";
import { GeoContext } from "../geo/context";
import { Tracker } from "../pipeline";
import { parseFrame, type FrameResult } from "../aisstream";
import {
  isTracked, newPendingQueue, ringBackfill, shouldPersistPosition, truncatePositions,
  vesselFingerprint, vesselWriteKind, type PendingQueue, type VesselWriteRecord,
} from "../persist-policy";
import { buildSnapshot, liveVessel, vesselCounts } from "../snapshot";
import { WriteMeter } from "../write-meter";
import { newVesselState, type AisPosition } from "../types";
import type { Env } from "../worker";

export class TrackerDO implements DurableObject, Rpc.DurableObjectBranded {
  declare [Rpc.__DURABLE_OBJECT_BRAND]: never;
  // Public for tests (cloudflare:test runInDurableObject); production code only touches them from inside this class.
  readonly tracker = new Tracker(new GeoContext());
  readonly meter = new WriteMeter(CONFIG.d1DailyWriteBudget);
  pending: PendingQueue = newPendingQueue();
  private ws: WebSocket | null = null;
  private lastWsMessageAt = 0;
  private backoffMs: number = CONFIG.backoffMinMs;
  hydrated = false;
  private lastPersisted = new Map<number, AisPosition>();   // breadcrumb downsampling reference
  private lastVesselWrite = new Map<number, VesselWriteRecord>(); // registry write-on-change reference
  private trackedMmsi = new Set<number>();                  // intentionally never pruned so a vessel's ring is backfilled only once
  private lastPruneAt = 0;
  private parseFailures = 0; // logged as one summary line per alarm window

  constructor(private ctx: DurableObjectState, private env: Env) {}

  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const now = Date.now();
    if (url.pathname === "/ensure") {
      await this.ensureRunning();
      return Response.json(this.status());
    }
    if (url.pathname === "/status") return Response.json(this.status());
    if (url.pathname === "/snapshot") {
      await this.hydrate();
      return Response.json(buildSnapshot(this.tracker.states.values(), now, url.searchParams.get("region") ?? ""));
    }
    if (url.pathname === "/vessel-counts") {
      await this.hydrate();
      return Response.json(vesselCounts(this.tracker.states.values(), now));
    }
    const vesselMatch = /^\/vessel\/(\d{1,9})$/.exec(url.pathname);
    if (vesselMatch) {
      await this.hydrate();
      const v = liveVessel(this.tracker.states.get(Number(vesselMatch[1])));
      return v ? Response.json(v) : new Response("unknown vessel", { status: 404 });
    }
    return new Response("not found", { status: 404 });
  }

  status(now: number = Date.now()) {
    return {
      connected: this.ws !== null && this.ws.readyState === WebSocket.READY_STATE_OPEN,
      vessels: this.tracker.states.size,
      lastWsMessageAt: this.lastWsMessageAt,
      writes: this.meter.status(now),
    };
  }

  /** Test hook: forget all in-memory state and skip D1 hydration. */
  resetForTests(): void {
    this.hydrated = true;
    this.tracker.states.clear();
    this.tracker.drainChangedAssessments();
    this.pending = newPendingQueue();
    this.lastPersisted.clear();
    this.lastVesselWrite.clear();
    this.trackedMmsi.clear();
    this.lastPruneAt = 0;
    this.meter.reset();
  }

  /** Load recent vessels + open assessments from D1 once per instance lifetime. */
  private async hydrate(): Promise<void> {
    if (this.hydrated) return;
    this.hydrated = true;
    const now = Date.now();
    // Window must exceed vesselRefreshMs: every active vessel's row is at most that old (spec §3).
    const states = await loadRecentVesselStates(this.env.DB, now - (CONFIG.vesselRefreshMs + CONFIG.snapshotWindowMs));
    for (const s of states) {
      this.tracker.states.set(s.mmsi, s);
      this.lastVesselWrite.set(s.mmsi, { ts: now, fp: vesselFingerprint(s) }); // row is current; next refresh in vesselRefreshMs
    }

    const open = await loadOpenAssessments(this.env.DB);
    for (const a of open) {
      let s = this.tracker.states.get(a.mmsi);
      if (!s) {
        s = newVesselState(a.mmsi, a.updatedTs);
        this.tracker.states.set(a.mmsi, s);
      }
      s.assessments[a.category] = a;
      const cs = s.categories[a.category];
      cs.score = a.confidence * 2; // inverse of confidenceFor; damping state resets on restart (accepted)
      cs.ts = a.updatedTs;
    }
    // Accepted fail-conservative losses on DO restart (only open assessments and
    // recent positions are rehydrated above):
    //  (a) pre-open category scores — those below assessmentOpenScore, with no
    //      assessments row to persist them — are not recoverable and reset to 0.
    //      A vessel that was quietly accumulating evidence toward opening an
    //      assessment loses that progress and starts over.
    //  (b) hydrated vessels restart with an empty or 1-fix position ring (only
    //      loadRecentVesselStates' latest fixes are restored, not the full ring),
    //      so the gap-detector cadence gate suppresses ais_gap detection until
    //      enough fresh fixes accumulate post-restart to re-establish cadence.
  }

  private async ensureRunning(): Promise<void> {
    await this.hydrate();
    if ((await this.ctx.storage.getAlarm()) === null) {
      await this.ctx.storage.setAlarm(Date.now() + CONFIG.alarmIntervalMs);
    }
    this.connectStream();
  }

  private connectStream(): void {
    if (this.ws && (this.ws.readyState === WebSocket.READY_STATE_OPEN || this.ws.readyState === WebSocket.READY_STATE_CONNECTING)) return;
    try {
      const ws = new WebSocket("wss://stream.aisstream.io/v0/stream");
      this.ws = ws;
      ws.addEventListener("open", () => {
        this.backoffMs = CONFIG.backoffMinMs;
        this.lastWsMessageAt = Date.now();
        ws.send(JSON.stringify({
          APIKey: this.env.AISSTREAM_KEY,
          BoundingBoxes: CONFIG.regions.map((r) => [[r.bbox.minLat, r.bbox.minLon], [r.bbox.maxLat, r.bbox.maxLon]]), // AISStream expects [lat, lon]
          FilterMessageTypes: ["PositionReport", "ShipStaticData"],
        }));
      });
      ws.addEventListener("message", (ev) => this.onWsMessage(ev));
      ws.addEventListener("close", () => { this.ws = null; });
      ws.addEventListener("error", () => { try { ws.close(); } catch {} this.ws = null; });
    } catch (err) {
      console.error("ws connect failed:", err);
      this.ws = null;
    }
  }

  private async onWsMessage(ev: MessageEvent): Promise<void> {
    this.lastWsMessageAt = Date.now();
    try {
      this.ingest(await parseFrame(ev.data));
    } catch (err) {
      console.error("message handling error:", err);
    }
  }

  /** Apply one decoded frame to in-memory state and queue what may need persisting. Public for tests. */
  ingest(frame: FrameResult): void {
    if (frame.kind === "error") { this.parseFailures++; return; }
    if (frame.kind === "ignored") return;
    if (frame.pos) {
      for (const ev of this.tracker.handlePosition(frame.pos)) this.pending.events.set(ev.id, ev);
      this.pending.dirtyVessels.add(frame.pos.mmsi);
      this.maybeQueuePosition(frame.pos);
    }
    if (frame.ident) {
      for (const ev of this.tracker.handleStatic(frame.ident)) this.pending.events.set(ev.id, ev);
      this.pending.dirtyVessels.add(frame.ident.mmsi);
    }
  }

  // Breadcrumbs only for tracked vessels (spec §3). On the transition to tracked, backfill the ring once.
  private maybeQueuePosition(pos: AisPosition): void {
    const s = this.tracker.states.get(pos.mmsi);
    if (!s || !isTracked(s)) return;
    if (!this.trackedMmsi.has(pos.mmsi)) {
      this.trackedMmsi.add(pos.mmsi);
      this.pending.positions.push(...ringBackfill(s, pos.ts)); // ring already contains pos
      this.lastPersisted.set(pos.mmsi, pos);
      return;
    }
    if (!shouldPersistPosition(pos, this.lastPersisted.get(pos.mmsi))) return;
    this.lastPersisted.set(pos.mmsi, pos);
    this.pending.positions.push(pos);
  }

  async alarm(): Promise<void> {
    const now = Date.now();

    // 0. Aggregated parse-failure log: one line per window keeps `wrangler tail` readable.
    if (this.parseFailures > 0) {
      console.error(`ws: ${this.parseFailures} unparseable frames since last alarm`);
      this.parseFailures = 0;
    }

    // 1. Watchdog: reconnect (with backoff) if the stream went quiet.
    const wsOpen = this.ws !== null && this.ws.readyState === WebSocket.READY_STATE_OPEN;
    if (!wsOpen || now - this.lastWsMessageAt > CONFIG.watchdogMs) {
      try { this.ws?.close(); } catch {}
      this.ws = null;
      this.backoffMs = Math.min(this.backoffMs * 2, CONFIG.backoffMaxMs);
      if (now - this.lastWsMessageAt > this.backoffMs) this.connectStream();
    }

    // 2. Gap detection + fusion tick.
    for (const ev of this.tracker.tick(now)) {
      this.pending.events.set(ev.id, ev);
      this.pending.dirtyVessels.add(ev.mmsi);
    }
    for (const a of this.tracker.drainChangedAssessments()) {
      this.pending.assessments.set(a.id, a);
      this.pending.dirtyVessels.add(a.mmsi);
    }

    // 3. Flush under the write budget.
    await this.flushPending(now);

    // 4. Daily tiered thinning (spec §3: was hourly; deletes count as rows_written).
    if (now - this.lastPruneAt > CONFIG.pruneIntervalMs) {
      this.lastPruneAt = now;
      try {
        const thinRows = await thinPositions(this.env.DB, now, CONFIG.retentionTiers);
        this.meter.record(thinRows, now);
      } catch (err) { console.error(err); }
    }

    await this.ctx.storage.setAlarm(now + CONFIG.alarmIntervalMs);
  }

  /**
   * Decide what earns a D1 write this tick (spec §3), flush it, account for it.
   * Essential: events, assessments, vessels that are new / changed identity / touched by an event or assessment.
   * Optional: breadcrumbs and vesselRefreshMs refreshes — dropped (not deferred) once the daily budget is spent.
   * `db` is injectable so tests can simulate a D1 rejection.
   */
  async flushPending(now: number, db: D1Database = this.env.DB): Promise<void> {
    const q = this.pending;
    if (!q.events.size && !q.positions.length && !q.dirtyVessels.size && !q.assessments.size) return;

    const optional = this.meter.optionalAllowed(now);
    const touched = new Set<number>();
    for (const ev of q.events.values()) touched.add(ev.mmsi);
    for (const a of q.assessments.values()) touched.add(a.mmsi);

    const batch = newPendingWrites();
    batch.events = [...q.events.values()];
    batch.assessments = new Map(q.assessments);
    for (const mmsi of q.dirtyVessels) {
      const s = this.tracker.states.get(mmsi);
      if (!s) continue;
      const kind = vesselWriteKind(s, this.lastVesselWrite.get(mmsi), now, touched.has(mmsi));
      if (kind === "essential" || (kind === "optional" && optional)) batch.vessels.set(mmsi, s);
    }
    if (optional) batch.positions = q.positions;
    else if (q.positions.length) console.warn(`write budget spent (${this.meter.usedToday(now)} rows today); dropping ${q.positions.length} breadcrumbs`);

    try {
      const rows = await flushWrites(db, batch);
      this.meter.record(rows, now);
      for (const s of batch.vessels.values()) this.lastVesselWrite.set(s.mmsi, { ts: now, fp: vesselFingerprint(s) });
      this.pending = newPendingQueue();
    } catch (err) {
      console.error("flush failed; retrying next tick:", err);
      q.positions = truncatePositions(q.positions, CONFIG.pendingPositionsCap);
    }
  }
}
