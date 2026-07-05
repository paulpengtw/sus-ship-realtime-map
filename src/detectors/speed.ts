// src/detectors/speed.ts
import type { Config } from "../config";
import type { GeoContext } from "../geo/context";
import type { LngLat } from "../geo/geo";
import type { AisPosition, AnomalyEvent, Severity, VesselState } from "../types";

export const SHIP_TYPE_MAX_SOG: Record<number, number> = {
  30: 12,                    // fishing
  31: 14, 32: 14, 52: 14,   // tug
  36: 10, 37: 10,            // pleasure/sail
  60: 25, 61: 25, 62: 25, 63: 25, 64: 25, 65: 25, 66: 25, 67: 25, 68: 25, 69: 25, // passenger
  70: 18, 71: 18, 72: 18, 73: 18, 74: 18, 75: 18, 76: 18, 77: 18, 78: 18, 79: 18, // cargo
  80: 16, 81: 16, 82: 16, 83: 16, 84: 16, 85: 16, 86: 16, 87: 16, 88: 16, 89: 16, // tanker
};

function baseSeverity(geo: GeoContext, p: LngLat): Severity {
  return geo.inCorridor(p) ? 4 : 3;
}

export function speedOnMessage(s: VesselState, msg: AisPosition, geo: GeoContext, cfg: Config): AnomalyEvent[] {
  if (s.lastSpeedEventTs !== null && msg.ts - s.lastSpeedEventTs < cfg.speedCooldownMs) return [];

  const p: LngLat = [msg.lon, msg.lat];
  const window = [...s.ring.slice(-(cfg.speedAnomalyWindow - 1)), msg];

  // 5a: type-mismatch speed
  if (s.shipType !== null && SHIP_TYPE_MAX_SOG[s.shipType] !== undefined) {
    const maxSog = SHIP_TYPE_MAX_SOG[s.shipType];
    let consecutive = 0;
    for (let i = window.length - 1; i >= 0; i--) {
      if (window[i].sog > maxSog) consecutive++;
      else break;
    }
    if (consecutive >= cfg.speedTypeMaxExceedCount) {
      s.lastSpeedEventTs = msg.ts;
      return [{
        id: `speed_anomaly-${s.mmsi}-${msg.ts}`,
        type: "speed_anomaly",
        severity: baseSeverity(geo, p),
        mmsi: s.mmsi,
        lon: msg.lon, lat: msg.lat,
        startTs: window[window.length - consecutive].ts,
        endTs: msg.ts,
        evidence: { kind: "type_mismatch", shipType: s.shipType, expectedMaxKn: maxSog, actualSogKn: msg.sog, consecutiveCount: consecutive },
      }];
    }
  }

  // 5b: repeated sudden speed changes
  if (window.length >= 2) {
    let changeCount = 0;
    for (let i = 1; i < window.length; i++) {
      const dt = window[i].ts - window[i - 1].ts;
      const dSog = Math.abs(window[i].sog - window[i - 1].sog);
      if (dSog > cfg.speedChangeThresholdKn && dt > 0 && dt < cfg.speedChangeMaxDtMs) {
        changeCount++;
      }
    }
    if (changeCount >= cfg.speedChangeMinCount) {
      s.lastSpeedEventTs = msg.ts;
      return [{
        id: `speed_anomaly-${s.mmsi}-${msg.ts}`,
        type: "speed_anomaly",
        severity: baseSeverity(geo, p),
        mmsi: s.mmsi,
        lon: msg.lon, lat: msg.lat,
        startTs: window[0].ts,
        endTs: msg.ts,
        evidence: { kind: "sudden_changes", changeCount, thresholdKn: cfg.speedChangeThresholdKn, windowSize: window.length },
      }];
    }
  }

  return [];
}
