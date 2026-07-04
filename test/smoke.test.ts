import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";

describe("scaffold", () => {
  it("has a D1 binding", async () => {
    const row = await env.DB.prepare("SELECT 1 AS one").first<{ one: number }>();
    expect(row?.one).toBe(1);
  });
});
