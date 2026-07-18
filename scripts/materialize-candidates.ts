// scripts/materialize-candidates.ts — CLI: npm run materialize -- --source=all [--lookback-days=30]
// Delegates to per-source builders that call the Worker to fetch source data + POST /api/labels/materialize.
import { LABEL_SOURCES, type LabelSource } from "../src/labeling";
import { materializeAssessments } from "./materialize/assessment";
import { materializeEventClusters } from "./materialize/event-cluster";
import { materializeRandomNegatives } from "./materialize/random-negative";
import { materializeCuratedPositives } from "./materialize/curated-positive";

const args = new Map<string, string>();
for (const a of process.argv.slice(2)) {
  const m = /^--([^=]+)=(.*)$/.exec(a);
  if (m) args.set(m[1], m[2]);
}
const source = (args.get("source") ?? "all") as LabelSource | "all";
const lookbackDays = Number(args.get("lookback-days") ?? "30");
const origin = args.get("origin") ?? process.env.DEV_ORIGIN ?? "http://127.0.0.1:8787";
if (source !== "all" && !LABEL_SOURCES.includes(source)) {
  console.error(`bad --source; expected one of ${LABEL_SOURCES.join(",")} or "all"`);
  process.exit(1);
}
if (!Number.isFinite(lookbackDays) || lookbackDays <= 0) {
  console.error("--lookback-days must be positive");
  process.exit(1);
}
const lookbackMs = lookbackDays * 86_400_000;
const now = Date.now();

async function run(): Promise<void> {
  const dispatch = {
    assessment: materializeAssessments,
    event_cluster: materializeEventClusters,
    random_negative: materializeRandomNegatives,
    curated_positive: materializeCuratedPositives,
  } as const;
  const sources = source === "all" ? LABEL_SOURCES : [source];
  let total = 0;
  for (const s of sources) {
    const candidates = await dispatch[s]({ origin, now, lookbackMs });
    const res = await fetch(`${origin}/api/labels/materialize`, {
      method: "POST", body: JSON.stringify({ source: s, candidates }),
    });
    if (!res.ok) { console.error(`materialize ${s} failed: ${res.status} ${await res.text()}`); process.exit(1); }
    const { inserted } = await res.json() as { inserted: number };
    console.log(`${s}: ${candidates.length} generated, ${inserted} new`);
    total += inserted;
  }
  console.log(`total inserted: ${total}`);
}
void run();
