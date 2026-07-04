// test/replay.test.ts
/// <reference types="vite/client" />

import { describe, expect, it } from "vitest";
import { GeoContext } from "../src/geo/context";
import { replayCapture } from "../src/replay-core";
import capture from "./fixtures/capture.ndjson?raw";

describe("replay harness", () => {
  it("replays a capture and emits a loitering event for the loiterer only", () => {
    const lines = capture.trim().split("\n");
    const result = replayCapture(lines, new GeoContext());
    expect(result.messages).toBe(23);
    expect(result.vessels).toBe(2);
    const loiters = result.events.filter((e) => e.type === "loitering" && e.endTs === null);
    expect(loiters).toHaveLength(1);
    expect(loiters[0].mmsi).toBe(999000001);
    expect(result.events.filter((e) => e.mmsi === 999000002)).toHaveLength(0);
  });
});
