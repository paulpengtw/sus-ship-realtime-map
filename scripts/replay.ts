// scripts/replay.ts - CLI: npm run replay -- path/to/capture.ndjson
declare const process: {
  argv: string[];
  exit(code?: number): never;
  getBuiltinModule(name: "node:fs"): {
    readFileSync(path: string, encoding: "utf8"): string;
  };
};

import { GeoContext } from "../src/geo/context";
import { replayCapture } from "../src/replay-core";

const file = process.argv[2];
if (!file) { console.error("usage: npm run replay -- <capture.ndjson>"); process.exit(1); }

const { readFileSync } = process.getBuiltinModule("node:fs");
const lines = readFileSync(file, "utf8").trim().split("\n");
const { events, vessels, messages } = replayCapture(lines, new GeoContext());

console.error(`replayed ${messages} messages, ${vessels} vessels, ${events.length} events`);
for (const ev of events) console.log(JSON.stringify(ev));
