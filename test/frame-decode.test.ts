// test/frame-decode.test.ts
import { describe, expect, it } from "vitest";
import { parseFrame } from "../src/aisstream";

const POSITION_MSG = {
  MessageType: "PositionReport",
  MetaData: { MMSI: 412000001, latitude: 22.0, longitude: 120.2, time_utc: "2026-07-04 12:34:56.789101 +0000 UTC" },
  Message: { PositionReport: { Sog: 5, Cog: 90, TrueHeading: 90 } },
};
const JSON_TEXT = JSON.stringify(POSITION_MSG);

describe("parseFrame", () => {
  it("parses a string frame", async () => {
    const r = await parseFrame(JSON_TEXT);
    expect(r.kind).toBe("ok");
    expect(r.kind === "ok" && r.pos?.mmsi).toBe(412000001);
  });

  it("parses an ArrayBuffer frame (aisstream sends binary)", async () => {
    const buf = new TextEncoder().encode(JSON_TEXT).buffer as ArrayBuffer;
    const r = await parseFrame(buf);
    expect(r.kind).toBe("ok");
    expect(r.kind === "ok" && r.pos?.mmsi).toBe(412000001);
  });

  it("parses a Uint8Array view frame", async () => {
    const r = await parseFrame(new TextEncoder().encode(JSON_TEXT));
    expect(r.kind).toBe("ok");
  });

  it("counts garbage as a parse error without throwing", async () => {
    expect((await parseFrame("not json")).kind).toBe("error");
    expect((await parseFrame(new Uint8Array([0xff, 0x00, 0x01]).buffer)).kind).toBe("error");
    expect((await parseFrame(12345)).kind).toBe("error");
  });

  it("treats valid-but-irrelevant JSON as ignored, not an error", async () => {
    expect((await parseFrame('{"error":"Api Key Is Not Valid"}')).kind).toBe("ignored");
  });

  it("parses a Blob frame (Cloudflare Workers sends Blob)", async () => {
    const blob = new Blob([JSON_TEXT], { type: "application/json" });
    const r = await parseFrame(blob);
    expect(r.kind).toBe("ok");
    expect(r.kind === "ok" && r.pos?.mmsi).toBe(412000001);
  });

});
