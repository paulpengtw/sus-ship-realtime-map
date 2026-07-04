// src/score.ts
import type { Config } from "./config";
import type { AnomalyEvent, VesselState } from "./types";

export function decayedScore(score: number, fromTs: number, toTs: number, halfLifeMs: number): number {
  if (toTs <= fromTs) return score;
  return score * Math.pow(0.5, (toTs - fromTs) / halfLifeMs);
}

export function applyEventToScore(s: VesselState, ev: AnomalyEvent, cfg: Config, now: number): void {
  s.score = decayedScore(s.score, s.scoreTs, now, cfg.scoreHalfLifeMs) + ev.severity;
  s.scoreTs = now;
}
