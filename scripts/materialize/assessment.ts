// scripts/materialize/assessment.ts (spec §3b, source=assessment).
import { candidatesFromAssessments } from "../../src/materialize-server";
import type { SourceMaterializer } from "../../src/labeling";

const MARGIN_MS = 30 * 60_000;

export const materializeAssessments: SourceMaterializer = async (deps) => {
  const since = deps.now - deps.lookbackMs;
  const res = await fetch(`${deps.origin}/api/labels/materialize/assessments?since=${since}&until=${deps.now}`);
  if (!res.ok) throw new Error(`fetch assessments failed: ${res.status}`);
  const { rows } = await res.json() as { rows: any[] };
  return candidatesFromAssessments(rows, MARGIN_MS, deps.now);
};
