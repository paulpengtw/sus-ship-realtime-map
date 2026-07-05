// test/replay-region.test.ts
/// <reference types="vite/client" />
import { describe, expect, it } from "vitest";
import { GeoContext } from "../src/geo/context";
import { replayCapture } from "../src/replay-core";
import capture from "./fixtures/capture.ndjson?raw";

const lines = capture.trim().split("\n");

describe("replay --region", () => {
  it("stamps regions on replayed events (fixture is Taiwan waters)", () => {
    const all = replayCapture(lines, new GeoContext());
    expect(all.events.length).toBeGreaterThan(0);
    expect(all.events.every((e) => e.region === "tw")).toBe(true);
  });

  it("filters events by region without changing message/vessel counts", () => {
    const tw = replayCapture(lines, new GeoContext(), undefined, "tw");
    const kr = replayCapture(lines, new GeoContext(), undefined, "kr");
    expect(tw.events.length).toBeGreaterThan(0);
    expect(kr.events).toHaveLength(0);
    expect(kr.messages).toBe(tw.messages); // filter applies to output, not ingest
  });
});
