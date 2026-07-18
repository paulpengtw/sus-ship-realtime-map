import { env, SELF } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";

const SINCE = 1_700_000_000_000;
const UNTIL = SINCE + 30 * 86_400_000;
const OPENED = SINCE - 5 * 86_400_000;

const seedLongOpenAssessment = () =>
  env.DB.prepare(
    `INSERT INTO assessments (id, mmsi, category, status, confidence, opened_ts, updated_ts, closed_ts, region, narrative, evidence)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)`,
  ).bind("assess-long", 111, "cable_interference", "open", 0.5, OPENED, OPENED, null, "test", "long-open assessment", "[]").run();

describe("GET /api/labels/materialize assessment overlap", () => {
  beforeEach(async () => {
    await env.DB.batch([
      env.DB.prepare("DELETE FROM assessments"),
    ]);
  });

  it("event-clusters includes long-open assessment in assessmentWindows", async () => {
    await seedLongOpenAssessment();
    await env.DB.prepare(
      `INSERT INTO assessments (id, mmsi, category, status, confidence, opened_ts, updated_ts, closed_ts, region, narrative, evidence)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)`,
    ).bind("assess-past-event", 222, "cable_interference", "closed", 0.5, SINCE - 20 * 86_400_000, SINCE - 15 * 86_400_000, SINCE - 15 * 86_400_000, "test", "closed before event-clusters window", "[]").run();

    const res = await SELF.fetch(`https://x/api/labels/materialize/event-clusters?since=${SINCE}&until=${UNTIL}`);
    expect(res.status).toBe(200);
    const body = await res.json<any>();

    expect(body.assessmentWindows).toContainEqual(expect.objectContaining({ tStart: OPENED }));
    expect(body.assessmentWindows).not.toContainEqual(expect.objectContaining({ tStart: SINCE - 20 * 86_400_000 }));
  });

  it("random-negatives includes long-open assessment in skipWindows", async () => {
    await seedLongOpenAssessment();
    await env.DB.prepare(
      `INSERT INTO assessments (id, mmsi, category, status, confidence, opened_ts, updated_ts, closed_ts, region, narrative, evidence)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)`,
    ).bind("assess-past-random", 333, "cable_interference", "closed", 0.5, SINCE - 20 * 86_400_000, SINCE - 15 * 86_400_000, SINCE - 15 * 86_400_000, "test", "closed before random-negatives window", "[]").run();

    const res = await SELF.fetch(`https://x/api/labels/materialize/random-negatives?since=${SINCE}&until=${UNTIL}`);
    expect(res.status).toBe(200);
    const body = await res.json<any>();

    expect(body.skipWindows).toContainEqual(expect.objectContaining({ tStart: OPENED }));
    expect(body.skipWindows).not.toContainEqual(expect.objectContaining({ tStart: SINCE - 20 * 86_400_000 }));
  });
});
