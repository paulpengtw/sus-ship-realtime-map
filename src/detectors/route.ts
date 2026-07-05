// src/detectors/route.ts
import type { Config } from "../config";
import type { GeoContext } from "../geo/context";
import { haversineM, type LngLat } from "../geo/geo";
import type { AisPosition, AnomalyEvent, Severity, VesselState } from "../types";

function isCommercial(shipType: number): boolean {
  return (shipType >= 70 && shipType <= 79) || (shipType >= 80 && shipType <= 89);
}

function cogDelta(a: number, b: number): number {
  let d = Math.abs(b - a) % 360;
  if (d > 180) d = 360 - d;
  return d;
}

function baseSeverity(geo: GeoContext, p: LngLat, base: Severity): Severity {
  return geo.inCorridor(p) ? 4 : base;
}

export function routeOnMessage(s: VesselState, msg: AisPosition, geo: GeoContext, cfg: Config): AnomalyEvent[] {
  if (s.lastRouteEventTs !== null && msg.ts - s.lastRouteEventTs < cfg.routeCooldownMs) return [];

  const p: LngLat = [msg.lon, msg.lat];
  const window = [...s.ring.slice(-(cfg.routeWindow - 1)), msg];

  // 6a: course reversals
  if (window.length >= 2) {
    let reversalCount = 0;
    for (let i = 1; i < window.length; i++) {
      const dt = window[i].ts - window[i - 1].ts;
      if (dt > 0 && dt < cfg.routeReversalMaxDtMs && cogDelta(window[i - 1].cog, window[i].cog) >= cfg.routeReversalMinDeg) {
        reversalCount++;
      }
    }
    if (reversalCount >= cfg.routeReversalMinCount) {
      s.lastRouteEventTs = msg.ts;
      return [{
        id: `route_deviation-${s.mmsi}-${msg.ts}`,
        type: "route_deviation",
        severity: baseSeverity(geo, p, 3),
        mmsi: s.mmsi,
        lon: msg.lon, lat: msg.lat,
        startTs: window[0].ts, endTs: msg.ts,
        evidence: { kind: "course_reversals", reversalCount, windowSize: window.length },
      }];
    }
  }

  // 6b: circling
  if (window.length >= cfg.routeCircleMinPositions) {
    const circleWindow = window.slice(-cfg.routeCircleMinPositions);
    const first = circleWindow[0];
    const last = circleWindow[circleWindow.length - 1];
    const displacement = haversineM([first.lon, first.lat], [last.lon, last.lat]);
    let distance = 0;
    for (let i = 1; i < circleWindow.length; i++) {
      distance += haversineM([circleWindow[i - 1].lon, circleWindow[i - 1].lat], [circleWindow[i].lon, circleWindow[i].lat]);
    }
    if (distance > cfg.routeCircleMinDistanceM) {
      const ratio = displacement / distance;
      if (ratio < cfg.routeCircleMaxRatio) {
        s.lastRouteEventTs = msg.ts;
        return [{
          id: `route_deviation-${s.mmsi}-${msg.ts}`,
          type: "route_deviation",
          severity: baseSeverity(geo, p, 3),
          mmsi: s.mmsi,
          lon: msg.lon, lat: msg.lat,
          startTs: circleWindow[0].ts, endTs: msg.ts,
          evidence: { kind: "circling", displacementM: Math.round(displacement), distanceM: Math.round(distance), ratio: Math.round(ratio * 100) / 100, positions: circleWindow.length },
        }];
      }
    }
  }

  // 6c: shipping lane deviation
  if (s.shipType !== null && isCommercial(s.shipType) && window.length >= cfg.routeLaneDeviationCount) {
    const tail = window.slice(-cfg.routeLaneDeviationCount);
    const allOutOfLane = tail.every((w) => {
      const wp: LngLat = [w.lon, w.lat];
      return !geo.inLane(wp) && !geo.inExclusion(wp) && w.sog > cfg.routeLaneMinSogKn;
    });
    if (allOutOfLane) {
      const nearestLane = geo.nearestLane(p);
      s.lastRouteEventTs = msg.ts;
      return [{
        id: `route_deviation-${s.mmsi}-${msg.ts}`,
        type: "route_deviation",
        severity: baseSeverity(geo, p, 2),
        mmsi: s.mmsi,
        lon: msg.lon, lat: msg.lat,
        startTs: tail[0].ts, endTs: msg.ts,
        evidence: { kind: "lane_deviation", shipType: s.shipType, consecutiveCount: cfg.routeLaneDeviationCount, nearestLane: nearestLane?.name ?? null },
      }];
    }
  }

  return [];
}
