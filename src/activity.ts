// src/activity.ts — vessel activity context (spec §3a). Moored/anchored vessels are not suspects.
import type { Config } from "./config";
import type { GeoContext } from "./geo/context";
import type { LngLat } from "./geo/geo";
import type { AisPosition, VesselState } from "./types";

export type Activity = "moored" | "anchored" | "stationary" | "underway";

export function classifyActivity(navStatus: number | null, sogKn: number, inExclusion: boolean, sustained: boolean, cfg: Config): Activity {
  if (navStatus === 5) return "moored";
  if (navStatus === 1) return "anchored";
  if (sogKn < cfg.stationaryMaxSogKn) {
    if (inExclusion) return "moored";
    if (sustained) return "stationary";
  }
  return "underway";
}

// Sustained = the last 3 known fixes (including msg when given) are all below the threshold.
function sustainedSlow(s: VesselState, msg: AisPosition | null, cfg: Config): boolean {
  const window = msg ? [...s.ring.slice(-2), msg] : s.ring.slice(-3);
  return window.length >= 3 && window.every((p) => p.sog < cfg.stationaryMaxSogKn);
}

export function activityFor(s: VesselState, msg: AisPosition, geo: GeoContext, cfg: Config): Activity {
  const p: LngLat = [msg.lon, msg.lat];
  return classifyActivity(msg.navStatus ?? null, msg.sog, geo.inExclusion(p), sustainedSlow(s, msg, cfg), cfg);
}

export function lastActivity(s: VesselState, geo: GeoContext, cfg: Config): Activity {
  const lp = s.ring.length ? s.ring[s.ring.length - 1] : null;
  if (!lp) return "underway";
  const p: LngLat = [lp.lon, lp.lat];
  return classifyActivity(lp.navStatus ?? null, lp.sog, geo.inExclusion(p), sustainedSlow(s, null, cfg), cfg);
}
