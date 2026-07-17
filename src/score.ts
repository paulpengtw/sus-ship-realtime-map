// src/score.ts
export function decayedScore(score: number, fromTs: number, toTs: number, halfLifeMs: number): number {
  if (toTs <= fromTs) return score;
  return score * Math.pow(0.5, (toTs - fromTs) / halfLifeMs);
}
