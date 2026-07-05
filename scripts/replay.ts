// scripts/replay.ts - CLI: npm run replay -- path/to/capture.ndjson [--region kr|tw|jp]
import { readFileSync } from "node:fs";

import { GeoContext } from "../src/geo/context";
import { replayCapture } from "../src/replay-core";

const args = process.argv.slice(2);
const rIdx = args.indexOf("--region");
const region = rIdx >= 0 ? args[rIdx + 1] : undefined;
const rest = rIdx >= 0 ? args.filter((_, i) => i !== rIdx && i !== rIdx + 1) : args;
const file = rest[0];
if (!file || (rIdx >= 0 && !region)) { console.error("usage: npm run replay -- <capture.ndjson> [--region kr|tw|jp]"); process.exit(1); }

const lines = readFileSync(file, "utf8").trim().split("\n");
const { events, vessels, messages } = replayCapture(lines, new GeoContext(), undefined, region);

console.error(`replayed ${messages} messages, ${vessels} vessels, ${events.length} events${region ? ` (region ${region})` : ""}`);
for (const ev of events) console.log(JSON.stringify(ev));
