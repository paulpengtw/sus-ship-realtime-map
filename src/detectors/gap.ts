// src/detectors/gap.ts
import type { Config } from "../config";
import type { GeoContext } from "../geo/context";
import { haversineM, type LngLat } from "../geo/geo";
import type { AisPosition, AnomalyEvent, Severity, VesselState } from "../types";

const HOUR_MS = 3_600_000;

function last(s: VesselState): AisPosition | null {
  return s.ring.length ? s.ring[s.ring.length - 1] : null;
}

export function gapOnTick(s: VesselState, geo: GeoContext, cfg: Config, now: number): AnomalyEvent[] {
  if (s.gapOpenSince !== null) return [];
  const lp = last(s);
  if (!lp) return [];
  if (now - s.lastSeen < cfg.gapMinMs) return [];

  s.gapOpenSince = s.lastSeen;
  const inCorr = geo.inCorridor([lp.lon, lp.lat]);
  const severity: Severity = inCorr ? 4 : 2;
  return [{
    id: `ais_gap-${s.mmsi}-${s.lastSeen}`,
    type: "ais_gap", severity, mmsi: s.mmsi,
    lon: lp.lon, lat: lp.lat,
    startTs: s.lastSeen, endTs: null,
    evidence: { lastFixInCorridor: inCorr, silentMs: now - s.lastSeen },
  }];
}

export function gapOnMessage(s: VesselState, msg: AisPosition, geo: GeoContext, cfg: Config): AnomalyEvent[] {
  if (s.gapOpenSince === null) return [];
  const lp = last(s);
  const startTs = s.gapOpenSince;
  s.gapOpenSince = null;
  if (!lp) return [];

  const gapMs = msg.ts - lp.ts;
  const distM = haversineM([lp.lon, lp.lat] as LngLat, [msg.lon, msg.lat] as LngLat);
  const impliedSpeedKn = gapMs > 0 ? distM / 1852 / (gapMs / HOUR_MS) : 0;
  const startInCorr = geo.inCorridor([lp.lon, lp.lat]);
  const endInCorr = geo.inCorridor([msg.lon, msg.lat]);
  const impossible = impliedSpeedKn > cfg.impossibleSpeedKn;

  let severity: Severity = startInCorr ? 4 : 2;
  if (impossible || endInCorr) severity = 5;

  return [{
    id: `ais_gap-${s.mmsi}-${startTs}`,
    type: "ais_gap", severity, mmsi: s.mmsi,
    lon: msg.lon, lat: msg.lat,
    startTs, endTs: msg.ts,
    evidence: { gapMs, distanceM: Math.round(distM), impliedSpeedKn: Math.round(impliedSpeedKn * 10) / 10, startInCorridor: startInCorr, endInCorridor: endInCorr },
  }];
}
