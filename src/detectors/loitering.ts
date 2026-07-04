// src/detectors/loitering.ts
import type { Config } from "../config";
import type { GeoContext } from "../geo/context";
import type { AisPosition, AnomalyEvent, VesselState } from "../types";
import type { LngLat } from "../geo/geo";

export function loiteringOnMessage(s: VesselState, msg: AisPosition, geo: GeoContext, cfg: Config): AnomalyEvent[] {
  const p: LngLat = [msg.lon, msg.lat];
  const loiterCandidate = msg.sog < cfg.loiterMaxSogKn && geo.inCorridor(p) && !geo.inExclusion(p);

  if (loiterCandidate) {
    if (s.loiterStart === null) {
      s.loiterStart = msg.ts;
      return [];
    }
    if (!s.loiterReported && msg.ts - s.loiterStart >= cfg.loiterMinMs) {
      s.loiterReported = true;
      return [{
        id: `loitering-${s.mmsi}-${s.loiterStart}`,
        type: "loitering", severity: 3, mmsi: s.mmsi,
        lon: msg.lon, lat: msg.lat,
        startTs: s.loiterStart, endTs: null,
        evidence: { corridor: geo.nearestCorridor(p)!.name, sogKn: msg.sog, durationMs: msg.ts - s.loiterStart },
      }];
    }
    return [];
  }

  // Condition broken: close the open event if one was reported, then reset.
  const out: AnomalyEvent[] = [];
  if (s.loiterStart !== null && s.loiterReported) {
    out.push({
      id: `loitering-${s.mmsi}-${s.loiterStart}`,
      type: "loitering", severity: 3, mmsi: s.mmsi,
      lon: msg.lon, lat: msg.lat,
      startTs: s.loiterStart, endTs: msg.ts,
      evidence: { corridor: geo.nearestCorridor(p)?.name ?? null, durationMs: msg.ts - s.loiterStart },
    });
  }
  s.loiterStart = null;
  s.loiterReported = false;
  return out;
}
