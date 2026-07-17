// src/config.ts — ALL tunable thresholds live here (spec §3).
export type RegionId = "kr" | "tw" | "jp";
export interface Region {
  id: RegionId;
  name: string;
  bbox: { minLon: number; minLat: number; maxLon: number; maxLat: number };
  center: [number, number]; // [lon, lat]
  zoom: number;
}

export const CONFIG = {
  // Order matters: region tagging is first-match-wins (spec §1).
  regions: [
    { id: "kr", name: "Korea",
      bbox: { minLon: 124.5, minLat: 33.0, maxLon: 130.0, maxLat: 37.0 }, // Busan/Geoje approaches + Yellow Sea corridors
      center: [127.5, 35.0], zoom: 6.3 },
    { id: "tw", name: "Taiwan",
      bbox: { minLon: 118.0, minLat: 21.0, maxLon: 124.5, maxLat: 26.5 },
      center: [120.9, 23.7], zoom: 6.3 },
    { id: "jp", name: "Japan",
      bbox: { minLon: 130.0, minLat: 32.5, maxLon: 141.5, maxLat: 36.9 }, // Kyushu strait → Shima/Chikura/Kitaibaraki landings
      center: [135.5, 34.5], zoom: 5.8 },
  ] as Region[],
  corridorBufferM: 1000,
  stationaryMaxSogKn: 0.5,
  minSogForCogKn: 2,
  loiterMaxSogKn: 2,
  loiterMinMs: 2 * 60 * 60 * 1000,
  gapMinMs: 60 * 60 * 1000,
  gapBboxEdgeBufferM: 10_000,
  gapMinPriorMessages: 5,
  gapCadenceWindowMs: 3_600_000,
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
  // Tiered position retention (trajectories spec §1): ≤48 h raw, then 1 pt/10 min to 30 d, 1 pt/h to 180 d.
  retentionTiers: [
    { minAgeMs: 48 * 3_600_000, maxAgeMs: 30 * 86_400_000, bucketMs: 10 * 60_000 },
    { minAgeMs: 30 * 86_400_000, maxAgeMs: 180 * 86_400_000, bucketMs: 3_600_000 },
  ],
  snapshotWindowMs: 60 * 60 * 1000,
  // Trajectories (spec §2)
  susScoreThreshold: 2,      // decayed score at/above which a vessel's trajectory is always drawn
  trajectoryMaxVessels: 50,  // top-N by decayed score in /api/trajectories
  trajectoryMaxPoints: 500,  // per-vessel point cap (server-side decimation)
  staleAfterMs: 5 * 60 * 1000,
  alarmIntervalMs: 30 * 1000,
  watchdogMs: 2 * 60 * 1000,
  backoffMinMs: 1000,
  backoffMaxMs: 60 * 1000,

  // Speed anomaly detector (spec §5)
  speedTypeMaxExceedCount: 3,
  speedChangeThresholdKn: 5,
  speedChangeMaxDtMs: 600_000,
  speedChangeMinCount: 3,
  speedAnomalyWindow: 20,
  speedCooldownMs: 3_600_000,

  // Route deviation detector (spec §6)
  routeReversalMinDeg: 90,
  routeReversalMaxDtMs: 900_000,
  routeReversalMinCount: 2,
  routeCircleMaxRatio: 0.3,
  routeCircleMinPositions: 10,
  routeCircleMinDistanceM: 200,
  routeWindow: 15,
  routeLaneDeviationCount: 5,
  laneBufferM: 5000,
  routeCooldownMs: 3_600_000,
  routeLaneMinSogKn: 5,
} as const;

export type Config = typeof CONFIG;
