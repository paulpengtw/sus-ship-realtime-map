// src/pipeline.ts - pure ingest->detect engine; no I/O. Wrapped by TrackerDO and the replay harness.
import { CONFIG, type Config } from "./config";
import { anchorDragOnMessage } from "./detectors/anchorDrag";
import { gapOnMessage, gapOnTick } from "./detectors/gap";
import { identityOnStatic, teleportOnMessage } from "./detectors/identity";
import { loiteringOnMessage } from "./detectors/loitering";
import { routeOnMessage } from "./detectors/route";
import { speedOnMessage } from "./detectors/speed";
import type { GeoContext } from "./geo/context";
import { applyEventToScore } from "./score";
import { newVesselState, type AisIdentity, type AisPosition, type AnomalyEvent, type VesselState } from "./types";

export class Tracker {
  states = new Map<number, VesselState>();

  constructor(private geo: GeoContext, private cfg: Config = CONFIG) {}

  private state(mmsi: number, now: number): VesselState {
    let s = this.states.get(mmsi);
    if (!s) { s = newVesselState(mmsi, now); this.states.set(mmsi, s); }
    return s;
  }

  private guard(s: VesselState, fn: () => AnomalyEvent[]): AnomalyEvent[] {
    try { return fn(); } catch (err) {
      console.error(`detector error mmsi=${s.mmsi}:`, err);
      return [];
    }
  }

  handlePosition(msg: AisPosition): AnomalyEvent[] {
    const s = this.state(msg.mmsi, msg.ts);
    const events: AnomalyEvent[] = [];

    if (s.gapOpenSince !== null) {
      events.push(...this.guard(s, () => gapOnMessage(s, msg, this.geo, this.cfg)));
    } else {
      events.push(...this.guard(s, () => teleportOnMessage(s, msg, this.cfg)));
    }
    events.push(...this.guard(s, () => loiteringOnMessage(s, msg, this.geo, this.cfg)));
    events.push(...this.guard(s, () => anchorDragOnMessage(s, msg, this.geo, this.cfg)));
    events.push(...this.guard(s, () => speedOnMessage(s, msg, this.geo, this.cfg)));
    events.push(...this.guard(s, () => routeOnMessage(s, msg, this.geo, this.cfg)));

    for (const ev of events) applyEventToScore(s, ev, this.cfg, msg.ts);

    s.ring.push(msg);
    if (s.ring.length > this.cfg.ringSize) s.ring.shift();
    s.lastSeen = msg.ts;
    return events;
  }

  handleStatic(ident: AisIdentity): AnomalyEvent[] {
    const s = this.state(ident.mmsi, ident.ts);
    const events = this.guard(s, () => identityOnStatic(s, ident, this.cfg));
    if (ident.shipType !== null) s.shipType = ident.shipType;
    for (const ev of events) applyEventToScore(s, ev, this.cfg, ident.ts);
    return events;
  }

  tick(now: number): AnomalyEvent[] {
    const events: AnomalyEvent[] = [];
    for (const s of this.states.values()) {
      const evs = this.guard(s, () => gapOnTick(s, this.geo, this.cfg, now));
      for (const ev of evs) applyEventToScore(s, ev, this.cfg, now);
      events.push(...evs);
    }
    return events;
  }
}
