import type { Config } from "../config";
import type { GeoContext } from "../geo/context";
import type { AisPosition, AnomalyEvent, VesselState } from "../types";

const D2R = Math.PI / 180;

// Circular standard deviation of headings, in degrees.
export function circularStdDeg(degrees: number[]): number {
  if (degrees.length === 0) return 0;
  let sx = 0, sy = 0;
  for (const d of degrees) { sx += Math.cos(d * D2R); sy += Math.sin(d * D2R); }
  const r = Math.hypot(sx, sy) / degrees.length;
  if (r <= 1e-9) return 180;
  return Math.sqrt(-2 * Math.log(r)) / D2R;
}

export function anchorDragOnMessage(s: VesselState, msg: AisPosition, geo: GeoContext, cfg: Config): AnomalyEvent[] {
  if (s.dragReportedTs !== null && msg.ts - s.dragReportedTs < cfg.dragCooldownMs) return [];

  const window = [...s.ring.slice(-(cfg.dragWindow - 1)), msg];
  if (window.length < cfg.dragWindow) return [];

  const slowMoving = window.every((p) => p.sog >= cfg.dragMinSogKn && p.sog < cfg.dragMaxSogKn);
  if (!slowMoving) return [];
  if (!geo.inCorridor([msg.lon, msg.lat])) return [];

  const cogStd = circularStdDeg(window.map((p) => p.cog));
  if (cogStd < cfg.dragMinCogStdDeg) return [];

  s.dragReportedTs = msg.ts;
  return [{
    id: `anchor_drag-${s.mmsi}-${window[0].ts}`,
    type: "anchor_drag", severity: 5, mmsi: s.mmsi,
    lon: msg.lon, lat: msg.lat,
    startTs: window[0].ts, endTs: msg.ts,
    evidence: { corridor: geo.nearestCorridor([msg.lon, msg.lat])!.name, cogStdDeg: Math.round(cogStd), meanSogKn: Math.round((window.reduce((a, p) => a + p.sog, 0) / window.length) * 10) / 10 },
  }];
}
