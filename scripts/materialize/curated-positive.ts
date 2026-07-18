// scripts/materialize/curated-positive.ts (spec §3b, source=curated_positive).
import { readFileSync } from "node:fs";
import path from "node:path";
import { candidatesFromCuratedPositives, type CuratedEntry } from "../../src/materialize-server";
import type { SourceMaterializer } from "../../src/labeling";

export const materializeCuratedPositives: SourceMaterializer = async (deps) => {
  const file = path.join(process.cwd(), "data/curated-incidents.json");
  const parsed = JSON.parse(readFileSync(file, "utf8")) as { entries: CuratedEntry[] };
  return candidatesFromCuratedPositives(parsed.entries ?? [], deps.now);
};
