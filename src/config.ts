// src/config.ts — ALL tunable thresholds live here (spec §3).
export const CONFIG = {
  bbox: { minLon: 118.0, minLat: 21.0, maxLon: 124.5, maxLat: 26.5 },
  corridorBufferM: 1000,
  loiterMaxSogKn: 2,
  loiterMinMs: 2 * 60 * 60 * 1000,
  gapMinMs: 60 * 60 * 1000,
  impossibleSpeedKn: 50,
  teleportMaxGapMs: 10 * 60 * 1000,
  dragMaxSogKn: 3,
  dragMinSogKn: 0.3,
  dragWindow: 10,
  dragMinCogStdDeg: 40,
  dragCooldownMs: 60 * 60 * 1000,
  ringSize: 120,
  identityHistorySize: 20,
  scoreHalfLifeMs: 24 * 60 * 60 * 1000,
  persistMinIntervalMs: 5 * 60 * 1000,
  persistMinMoveM: 100,
  positionRetentionMs: 30 * 24 * 60 * 60 * 1000,
  snapshotWindowMs: 60 * 60 * 1000,
  staleAfterMs: 5 * 60 * 1000,
  alarmIntervalMs: 30 * 1000,
  watchdogMs: 2 * 60 * 1000,
  backoffMinMs: 1000,
  backoffMaxMs: 60 * 1000,
} as const;

export type Config = typeof CONFIG;
