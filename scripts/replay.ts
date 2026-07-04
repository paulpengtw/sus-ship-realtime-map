// scripts/replay.ts - CLI: npm run replay -- path/to/capture.ndjson
import { readFileSync } from "node:fs";

import { GeoContext } from "../src/geo/context";
import { replayCapture } from "../src/replay-core";

const file = process.argv[2];
if (!file) { console.error("usage: npm run replay -- <capture.ndjson>"); process.exit(1); }

const lines = readFileSync(file, "utf8").trim().split("\n");
const { events, vessels, messages } = replayCapture(lines, new GeoContext());

console.error(`replayed ${messages} messages, ${vessels} vessels, ${events.length} events`);
for (const ev of events) console.log(JSON.stringify(ev));
