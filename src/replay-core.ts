// src/replay-core.ts - pure replay: capture lines -> events. Used by tests and scripts/replay.ts.
import { parseAisStreamMessage } from "./aisstream";
import { CONFIG } from "./config";
import type { GeoContext } from "./geo/context";
import { Tracker } from "./pipeline";
import type { AnomalyEvent } from "./types";

export function replayCapture(lines: string[], geo: GeoContext, tickIntervalMs = CONFIG.alarmIntervalMs, region?: string): {
  events: AnomalyEvent[]; vessels: number; messages: number;
} {
  const tracker = new Tracker(geo);
  const events: AnomalyEvent[] = [];
  let messages = 0;
  let lastTick = 0;

  const parsed = lines
    .map((l) => { try { return parseAisStreamMessage(JSON.parse(l)); } catch { return null; } })
    .filter((p): p is NonNullable<typeof p> => p !== null)
    .sort((a, b) => (a.pos?.ts ?? a.ident!.ts) - (b.pos?.ts ?? b.ident!.ts));

  for (const p of parsed) {
    const ts = p.pos?.ts ?? p.ident!.ts;
    if (lastTick === 0) lastTick = ts;
    // simulate the DO alarm between messages
    while (ts - lastTick >= tickIntervalMs) {
      lastTick += tickIntervalMs;
      events.push(...tracker.tick(lastTick));
    }
    if (p.pos) { events.push(...tracker.handlePosition(p.pos)); messages++; }
    if (p.ident) { events.push(...tracker.handleStatic(p.ident)); messages++; }
  }
  return { events: region ? events.filter((e) => e.region === region) : events, vessels: tracker.states.size, messages };
}
