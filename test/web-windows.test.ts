// test/web-windows.test.ts
import { describe, expect, it } from "vitest";
import { DEFAULT_WINDOW, resolveInitialWindow, WINDOWS } from "../web/src/windows";

describe("web window store", () => {
  it("defaults first-time visitors to Month", () => {
    expect(DEFAULT_WINDOW).toBe("month");
    expect(resolveInitialWindow(null)).toBe("month");
  });
  it("accepts stored valid windows, rejects junk", () => {
    expect(resolveInitialWindow("day")).toBe("day");
    expect(resolveInitialWindow("6m")).toBe("6m");
    expect(resolveInitialWindow("zz")).toBe("month");
    expect(resolveInitialWindow("")).toBe("month");
  });
  it("exposes exactly the five API window ids", () => {
    expect(WINDOWS.map((w) => w.id)).toEqual(["day", "week", "month", "3m", "6m"]);
  });
});
