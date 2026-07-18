// scripts/materialize/random-negative.ts (spec §3b, source=random_negative).
import { candidatesFromRandomNegatives } from "../../src/materialize-server";
import type { SourceMaterializer } from "../../src/labeling";

const SAMPLES_PER_DAY = 5;
const SEED = "phase-0-seed";

export const materializeRandomNegatives: SourceMaterializer = async (deps) => {
  const since = deps.now - deps.lookbackMs;
  const res = await fetch(`${deps.origin}/api/labels/materialize/random-negatives?since=${since}&until=${deps.now}`);
  if (!res.ok) throw new Error(`fetch random-negatives failed: ${res.status}`);
  const { vesselDays, skipWindows } = await res.json() as { vesselDays: any[]; skipWindows: any[] };
  return candidatesFromRandomNegatives(vesselDays, skipWindows, SAMPLES_PER_DAY, SEED, deps.now);
};
