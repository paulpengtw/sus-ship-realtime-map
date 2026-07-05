// src/do/tracker.ts — websocket lifecycle, alarms, batching. Logic lives in pipeline.ts.
import { CONFIG } from "../config";
import { flushWrites, loadRecentVesselStates, newPendingWrites, pruneOldPositions, type PendingWrites } from "../db";
import { GeoContext } from "../geo/context";
import { Tracker } from "../pipeline";
import { parseFrame } from "../aisstream";
import { haversineM } from "../geo/geo";
import type { AisPosition } from "../types";
import type { Env } from "../worker";

export class TrackerDO implements DurableObject {
  private tracker = new Tracker(new GeoContext());
  private pending: PendingWrites = newPendingWrites();
  private ws: WebSocket | null = null;
  private lastWsMessageAt = 0;
  private backoffMs: number = CONFIG.backoffMinMs;
  private hydrated = false;
  private lastPersisted = new Map<number, AisPosition>(); // downsampling reference
  private lastPruneAt = 0;
  private parseFailures = 0; // logged as one summary line per alarm window

  constructor(private ctx: DurableObjectState, private env: Env) {}

  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname === "/ensure") {
      await this.ensureRunning();
      return Response.json({
        connected: this.ws !== null && this.ws.readyState === WebSocket.READY_STATE_OPEN,
        vessels: this.tracker.states.size,
        lastWsMessageAt: this.lastWsMessageAt,
      });
    }
    return new Response("not found", { status: 404 });
  }

  private async ensureRunning(): Promise<void> {
    if (!this.hydrated) {
      this.hydrated = true;
      const states = await loadRecentVesselStates(this.env.DB, Date.now() - 6 * 3_600_000);
      for (const s of states) this.tracker.states.set(s.mmsi, s);
    }
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

  private onWsMessage(ev: MessageEvent): void {
    this.lastWsMessageAt = Date.now();
    // Per-message try/catch: one malformed message must not kill the handler (spec §6).
    try {
      const frame = parseFrame(ev.data);
      if (frame.kind === "error") { this.parseFailures++; return; }
      if (frame.kind === "ignored") return;
      if (frame.pos) {
        const events = this.tracker.handlePosition(frame.pos);
        this.pending.events.push(...events);
        this.pending.vessels.set(frame.pos.mmsi, this.tracker.states.get(frame.pos.mmsi)!);
        this.maybeQueuePosition(frame.pos);
      }
      if (frame.ident) {
        const events = this.tracker.handleStatic(frame.ident);
        this.pending.events.push(...events);
        this.pending.vessels.set(frame.ident.mmsi, this.tracker.states.get(frame.ident.mmsi)!);
      }
    } catch (err) {
      console.error("message handling error:", err);
    }
  }

  // Downsample: persist a track point only if enough time passed or the vessel moved enough.
  private maybeQueuePosition(pos: AisPosition): void {
    const prev = this.lastPersisted.get(pos.mmsi);
    if (prev &&
        pos.ts - prev.ts < CONFIG.persistMinIntervalMs &&
        haversineM([prev.lon, prev.lat], [pos.lon, pos.lat]) < CONFIG.persistMinMoveM) return;
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

    // 2. Gap detection tick.
    const events = this.tracker.tick(now);
    this.pending.events.push(...events);
    for (const ev of events) this.pending.vessels.set(ev.mmsi, this.tracker.states.get(ev.mmsi)!);

    // 3. Flush batched writes; on failure keep pending and retry next tick (spec §6).
    if (this.pending.events.length || this.pending.positions.length || this.pending.vessels.size) {
      const batch = this.pending;
      try {
        await flushWrites(this.env.DB, batch);
        this.pending = newPendingWrites();
      } catch (err) {
        console.error("flush failed; retrying next tick:", err);
      }
    }

    // 4. Hourly retention prune.
    if (now - this.lastPruneAt > 3_600_000) {
      this.lastPruneAt = now;
      try { await pruneOldPositions(this.env.DB, now - CONFIG.positionRetentionMs); } catch (err) { console.error(err); }
    }

    await this.ctx.storage.setAlarm(now + CONFIG.alarmIntervalMs);
  }
}
