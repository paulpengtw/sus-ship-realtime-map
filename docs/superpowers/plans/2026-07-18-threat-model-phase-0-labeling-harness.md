# Threat Model Phase 0 — Labeling Harness Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Spec:** [2026-07-18 Finer-Granularity Threat Model](../specs/2026-07-18-threat-model-finer-granularity-design.md)

**Goal:** Ship the Phase 0 labeling harness (PR-A) — new D1 tables, materializer that generates candidate incidents from four sources, `/api/labels/*` routes, and a Review-mode UI extension that lets an analyst label per-vessel time-window incidents. Also retires the never-raised `militia_presence` category. No change to `src/fusion.ts` or scoring.

**Architecture:** Two new D1 tables (`candidate_incidents`, `labels`). A CLI script (`scripts/materialize-candidates.ts`) populates `candidate_incidents` from four sources (assessments, event clusters, random negatives, curated positives). Three new API routes (`GET /api/labels/queue`, `GET /api/labels/stats`, `POST /api/labels`). Existing map UI gains a `mode=review` branch that repurposes the left and right panels for incident queue + label form.

**Tech Stack:** TypeScript, Cloudflare Workers, D1 (SQLite), Durable Objects, Vite, MapLibre GL, Vitest with `@cloudflare/vitest-pool-workers`, `tsx` for scripts.

## Global Constraints

- Test command: `npm test` (runs `vitest run`).
- Migrations must apply cleanly via `test/apply-migrations.ts` — every new migration is auto-picked up by `readD1Migrations`.
- Numeric-only MMSI; timestamps are ms epoch integers throughout.
- No new runtime dependencies. `sharp`, `ml-*`, and any WASM/ONNX package are explicitly out of scope for Phase 0.
- `AnomalyEvent.severity` is UI-only from Phase 0 onwards — do not read it in fusion or labeling logic (spec §4d).
- Detectors (`src/detectors/*`) are behavior-frozen for the entire Phase 0. Do not modify them.
- All new API responses use the existing `json(data, status)` helper in `src/worker.ts` (CORS + JSON).
- All new SQL uses the D1 batch idiom (`env.DB.batch([...])`) or `prepare().bind().run()` — never string interpolation.
- Commit messages: prefix `feat:` for new user-visible capability, `chore:` for retirement/cleanup, `test:` for tests-only, `docs:` for docs.

---

### Task 1: Retire `militia_presence` category

**Files:**
- Create: `migrations/0005_retire_militia.sql`
- Modify: `src/types.ts` (line 43 `THREAT_CATEGORIES`, lines 92-97 `newVesselState.categories`)
- Modify: `web/src/vessels.ts` (line 16 `CAT_MATCH`)
- Modify: `web/src/trajectories.ts` (line 12 `CAT_MATCH`)
- Modify: `web/src/panels.ts` (line 157 `allCats`)
- Modify: `test/fusion.test.ts`, `test/db-assessments.test.ts`, `test/stats.test.ts` — any test that references `"militia_presence"`
- Modify: `src/worker.ts:177` — histogram `counts: [0, 0, 0, 0]` becomes `[0, 0, 0]`.

**Interfaces:**
- Produces: `THREAT_CATEGORIES = ["cable_interference", "dark_activity", "identity_deception"] as const` — every downstream `Record<ThreatCategory, ...>` and `switch` shrinks accordingly.

- [ ] **Step 1: Find every existing reference to `militia_presence`**

Run: `grep -rn --include='*.ts' --include='*.sql' --include='*.json' 'militia_presence' src test web migrations data`
Expected: exact list of touch sites. Use it to drive the next steps — do not skip a file just because it appears green.

- [ ] **Step 2: Write the retirement migration**

Create `migrations/0005_retire_militia.sql`:

```sql
-- migrations/0005_retire_militia.sql — remove the never-raised militia_presence category.
DELETE FROM assessments WHERE category = 'militia_presence';
```

- [ ] **Step 3: Update TypeScript enum + VesselState**

In `src/types.ts` line 43, replace the array literal so it drops the last element:

```ts
export const THREAT_CATEGORIES = ["cable_interference", "dark_activity", "identity_deception"] as const;
```

In `src/types.ts` lines 92-97, remove the `militia_presence: newCategoryState(now),` line from the `categories` object.

- [ ] **Step 4: Update CAT_MATCH tables + histogram width**

In `web/src/vessels.ts` line 14-16 and `web/src/trajectories.ts` line 10-12, drop `"militia_presence", "#4cc3ff"` from the `["match", …]` expression. Result:

```ts
const CAT_MATCH = ["match", ["coalesce", ["get", "topCategory"], ""],
  "cable_interference", "#e5484d", "dark_activity", "#b18cff",
  "identity_deception", "#f0a83c", "#e5484d"] as any;
```

In `src/worker.ts:177`, change the histogram initialization from `counts: [0, 0, 0, 0]` to `counts: [0, 0, 0]`.

- [ ] **Step 5: Update tests that reference militia_presence**

For every hit from Step 1 in `test/`, drop the militia case or replace with a surviving category. In `test/stats.test.ts`, the daily histogram was 4-wide; it is now 3-wide.

- [ ] **Step 6: Run tests**

Run: `npm test`
Expected: PASS. If any test still asserts `THREAT_CATEGORIES.length === 4` or references `militia_presence`, fix it.

- [ ] **Step 7: Commit**

```bash
git add migrations/0005_retire_militia.sql src/types.ts src/worker.ts web/src/vessels.ts web/src/trajectories.ts web/src/panels.ts test/
git commit -m "chore: retire militia_presence category (spec §3e)"
```

---

### Task 2: Migration 0006 — `candidate_incidents` + `labels` tables

**Files:**
- Create: `migrations/0006_labeling.sql`
- Create: `test/db-labeling.test.ts`

**Interfaces:**
- Produces: two D1 tables with the schema in spec §3a.

- [ ] **Step 1: Write the failing test**

Create `test/db-labeling.test.ts`:

```ts
import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";

describe("labeling schema (migration 0006)", () => {
  it("candidate_incidents accepts all four source values with a hashed id", async () => {
    await env.DB.prepare(
      `INSERT INTO candidate_incidents (id, vessel_id, t_start, t_end, source, source_ref, created_at, model_snapshot, event_ids)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)`,
    ).bind("hash1", "416000001", 1_700_000_000_000, 1_700_003_600_000, "assessment", "cable_interference-1-1", 1_700_004_000_000, "{}", "[]").run();
    const row = await env.DB.prepare(`SELECT * FROM candidate_incidents WHERE id = ?1`).bind("hash1").first<any>();
    expect(row).toMatchObject({ vessel_id: "416000001", source: "assessment", source_ref: "cable_interference-1-1" });
  });

  it("labels enforces one label per (incident_id, labeler)", async () => {
    await env.DB.prepare(
      `INSERT INTO candidate_incidents (id, vessel_id, t_start, t_end, source, created_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6)`,
    ).bind("hash2", "416000002", 1_700_000_000_000, 1_700_003_600_000, "random_negative", 1_700_004_000_000).run();
    await env.DB.prepare(
      `INSERT INTO labels (incident_id, labeler, ts, verdict, intent_categories, labeler_confidence, notes)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)`,
    ).bind("hash2", "alice", 1_700_005_000_000, "benign", null, 4, "").run();
    await expect(
      env.DB.prepare(
        `INSERT INTO labels (incident_id, labeler, ts, verdict, intent_categories, labeler_confidence, notes)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)`,
      ).bind("hash2", "alice", 1_700_005_600_000, "threat", '["cable_interference"]', 5, "changed my mind").run(),
    ).rejects.toThrow(/UNIQUE/i);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- test/db-labeling.test.ts`
Expected: FAIL with "no such table: candidate_incidents".

- [ ] **Step 3: Write the migration**

Create `migrations/0006_labeling.sql`:

```sql
-- migrations/0006_labeling.sql — labeling harness (spec §3a).
CREATE TABLE candidate_incidents (
  id TEXT PRIMARY KEY,
  vessel_id TEXT NOT NULL,
  t_start INTEGER NOT NULL,
  t_end INTEGER NOT NULL,
  source TEXT NOT NULL,
  source_ref TEXT,
  created_at INTEGER NOT NULL,
  model_snapshot TEXT,
  event_ids TEXT
);
CREATE INDEX ix_candidate_source ON candidate_incidents(source, created_at);
CREATE INDEX ix_candidate_vessel ON candidate_incidents(vessel_id, t_start);

CREATE TABLE labels (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  incident_id TEXT NOT NULL REFERENCES candidate_incidents(id),
  labeler TEXT NOT NULL,
  ts INTEGER NOT NULL,
  verdict TEXT NOT NULL,
  intent_categories TEXT,
  labeler_confidence INTEGER,
  notes TEXT,
  UNIQUE(incident_id, labeler)
);
CREATE INDEX ix_labels_verdict ON labels(verdict, ts);
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- test/db-labeling.test.ts`
Expected: PASS both cases.

- [ ] **Step 5: Commit**

```bash
git add migrations/0006_labeling.sql test/db-labeling.test.ts
git commit -m "feat: candidate_incidents and labels tables (spec §3a)"
```

---

### Task 3: TS types for candidate + label + shared helpers

**Files:**
- Create: `src/labeling.ts`
- Create: `test/labeling.test.ts`

**Interfaces:**
- Produces:
  - `type LabelSource = "assessment" | "event_cluster" | "random_negative" | "curated_positive"`
  - `type LabelVerdict = "threat" | "suspicious" | "benign" | "unclear"`
  - `interface CandidateIncident { id: string; vesselId: string; tStart: number; tEnd: number; source: LabelSource; sourceRef: string | null; createdAt: number; modelSnapshot: unknown; eventIds: string[]; }`
  - `interface IncidentLabel { id?: number; incidentId: string; labeler: string; ts: number; verdict: LabelVerdict; intentCategories: ThreatCategory[] | null; labelerConfidence: number | null; notes: string | null; }`
  - `function candidateIdOf(vesselId: string, tStart: number, tEnd: number, source: LabelSource): string`
  - `function rowToCandidate(r: any): CandidateIncident`, `rowToLabel(r: any): IncidentLabel`.

- [ ] **Step 1: Write the failing test**

Create `test/labeling.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { candidateIdOf, rowToCandidate, rowToLabel } from "../src/labeling";

describe("candidateIdOf", () => {
  it("is deterministic across calls with identical inputs", () => {
    const a = candidateIdOf("416000001", 1_700_000_000_000, 1_700_003_600_000, "assessment");
    const b = candidateIdOf("416000001", 1_700_000_000_000, 1_700_003_600_000, "assessment");
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{16}$/);
  });

  it("distinguishes different sources for the same window", () => {
    const a = candidateIdOf("416000001", 1_700_000_000_000, 1_700_003_600_000, "assessment");
    const b = candidateIdOf("416000001", 1_700_000_000_000, 1_700_003_600_000, "event_cluster");
    expect(a).not.toBe(b);
  });
});

describe("row converters", () => {
  it("rowToCandidate parses JSON columns", () => {
    const row = {
      id: "abc", vessel_id: "416000001", t_start: 1, t_end: 2,
      source: "assessment", source_ref: null, created_at: 3,
      model_snapshot: '{"topCategory":"cable_interference"}',
      event_ids: '["evt-1","evt-2"]',
    };
    expect(rowToCandidate(row)).toEqual({
      id: "abc", vesselId: "416000001", tStart: 1, tEnd: 2,
      source: "assessment", sourceRef: null, createdAt: 3,
      modelSnapshot: { topCategory: "cable_interference" },
      eventIds: ["evt-1", "evt-2"],
    });
  });

  it("rowToLabel handles null intent_categories", () => {
    expect(rowToLabel({ incident_id: "abc", labeler: "alice", ts: 1, verdict: "benign", intent_categories: null, labeler_confidence: 4, notes: "" }))
      .toEqual({ incidentId: "abc", labeler: "alice", ts: 1, verdict: "benign", intentCategories: null, labelerConfidence: 4, notes: "" });
    expect(rowToLabel({ incident_id: "abc", labeler: "alice", ts: 1, verdict: "threat", intent_categories: '["cable_interference"]', labeler_confidence: 5, notes: "why" }))
      .toMatchObject({ intentCategories: ["cable_interference"] });
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npm test -- test/labeling.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `src/labeling.ts`**

```ts
// src/labeling.ts — labeling harness types + D1 row converters (spec §3).
import type { ThreatCategory } from "./types";

export const LABEL_SOURCES = ["assessment", "event_cluster", "random_negative", "curated_positive"] as const;
export type LabelSource = (typeof LABEL_SOURCES)[number];

export const LABEL_VERDICTS = ["threat", "suspicious", "benign", "unclear"] as const;
export type LabelVerdict = (typeof LABEL_VERDICTS)[number];

export interface CandidateIncident {
  id: string;
  vesselId: string;
  tStart: number;
  tEnd: number;
  source: LabelSource;
  sourceRef: string | null;
  createdAt: number;
  modelSnapshot: unknown;
  eventIds: string[];
}

export interface IncidentLabel {
  id?: number;
  incidentId: string;
  labeler: string;
  ts: number;
  verdict: LabelVerdict;
  intentCategories: ThreatCategory[] | null;
  labelerConfidence: number | null;
  notes: string | null;
}

// Deterministic 16-hex-char id (double FNV-1a) — sync, works in workers + tsx.
export function candidateIdOf(vesselId: string, tStart: number, tEnd: number, source: LabelSource): string {
  const s = `${vesselId}:${tStart}:${tEnd}:${source}`;
  let h1 = 0x811c9dc5, h2 = 0xdeadbeef;
  for (let i = 0; i < s.length; i++) {
    h1 = Math.imul(h1 ^ s.charCodeAt(i), 16777619) >>> 0;
    h2 = Math.imul(h2 ^ s.charCodeAt(i), 2246822519) >>> 0;
  }
  return (h1.toString(16).padStart(8, "0") + h2.toString(16).padStart(8, "0")).slice(0, 16);
}

export function rowToCandidate(r: any): CandidateIncident {
  return {
    id: r.id,
    vesselId: r.vessel_id,
    tStart: r.t_start,
    tEnd: r.t_end,
    source: r.source,
    sourceRef: r.source_ref ?? null,
    createdAt: r.created_at,
    modelSnapshot: r.model_snapshot ? JSON.parse(r.model_snapshot) : null,
    eventIds: r.event_ids ? JSON.parse(r.event_ids) : [],
  };
}

export function rowToLabel(r: any): IncidentLabel {
  return {
    id: r.id,
    incidentId: r.incident_id,
    labeler: r.labeler,
    ts: r.ts,
    verdict: r.verdict,
    intentCategories: r.intent_categories ? JSON.parse(r.intent_categories) : null,
    labelerConfidence: r.labeler_confidence ?? null,
    notes: r.notes ?? null,
  };
}
```

- [ ] **Step 4: Run to verify pass**

Run: `npm test -- test/labeling.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/labeling.ts test/labeling.test.ts
git commit -m "feat: labeling types + row converters (spec §3)"
```

---

### Task 4: `GET /api/labels/queue` route

**Files:**
- Modify: `src/worker.ts` (add route after `/api/gfw`)
- Create: `test/api-labels-queue.test.ts`

**Interfaces:**
- Consumes: `rowToCandidate` (Task 3).
- Produces: `GET /api/labels/queue?source=<src>&limit=<n>` returning `{ generatedAt, candidates: CandidateIncident[] }`. Only rows without a label (LEFT JOIN filter). Sort by `created_at DESC`. `source` optional; `limit` clamped 1..100, default 25.

- [ ] **Step 1: Write the failing test**

Create `test/api-labels-queue.test.ts`:

```ts
import { env, SELF } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";

const seedCandidate = (id: string, source: string, createdAt: number) =>
  env.DB.prepare(
    `INSERT INTO candidate_incidents (id, vessel_id, t_start, t_end, source, source_ref, created_at, model_snapshot, event_ids)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)`,
  ).bind(id, "416000001", 1, 2, source, null, createdAt, "{}", "[]");

const seedLabel = (incidentId: string) =>
  env.DB.prepare(
    `INSERT INTO labels (incident_id, labeler, ts, verdict, intent_categories, labeler_confidence, notes)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)`,
  ).bind(incidentId, "alice", 1_700_000_000_000, "benign", null, 3, null);

describe("GET /api/labels/queue", () => {
  beforeEach(async () => {
    await env.DB.batch([
      env.DB.prepare("DELETE FROM labels"),
      env.DB.prepare("DELETE FROM candidate_incidents"),
      seedCandidate("a-open", "assessment", 100),
      seedCandidate("a-labeled", "assessment", 200),
      seedLabel("a-labeled"),
      seedCandidate("neg-1", "random_negative", 150),
    ]);
  });

  it("returns only unlabeled candidates, newest first", async () => {
    const res = await SELF.fetch("https://x/api/labels/queue");
    expect(res.status).toBe(200);
    const body = await res.json<any>();
    const ids = body.candidates.map((c: any) => c.id);
    expect(ids).not.toContain("a-labeled");
    expect(ids[0]).toBe("neg-1");
    expect(ids[1]).toBe("a-open");
  });

  it("filters by source and clamps limit", async () => {
    const res = await SELF.fetch("https://x/api/labels/queue?source=random_negative&limit=1");
    const body = await res.json<any>();
    expect(body.candidates.map((c: any) => c.id)).toEqual(["neg-1"]);
  });

  it("rejects unknown source", async () => {
    const res = await SELF.fetch("https://x/api/labels/queue?source=nope");
    expect(res.status).toBe(400);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npm test -- test/api-labels-queue.test.ts`
Expected: FAIL with 404.

- [ ] **Step 3: Add route to `src/worker.ts`**

Add to the imports near top:

```ts
import { LABEL_SOURCES, rowToCandidate } from "./labeling";
```

After the `/api/gfw` handler, before the `trackMatch` regex, insert:

```ts
    if (url.pathname === "/api/labels/queue") {
      const source = url.searchParams.get("source");
      if (source !== null && !(LABEL_SOURCES as readonly string[]).includes(source)) return json({ error: "bad source" }, 400);
      const limit = Math.min(Math.max(Math.trunc(Number(url.searchParams.get("limit")) || 25), 1), 100);
      const sql = source
        ? `SELECT c.* FROM candidate_incidents c LEFT JOIN labels l ON l.incident_id = c.id
           WHERE l.id IS NULL AND c.source = ?1 ORDER BY c.created_at DESC LIMIT ?2`
        : `SELECT c.* FROM candidate_incidents c LEFT JOIN labels l ON l.incident_id = c.id
           WHERE l.id IS NULL ORDER BY c.created_at DESC LIMIT ?1`;
      const { results } = source
        ? await env.DB.prepare(sql).bind(source, limit).all<any>()
        : await env.DB.prepare(sql).bind(limit).all<any>();
      return json({ generatedAt: now, candidates: results.map(rowToCandidate) });
    }
```

- [ ] **Step 4: Run to verify pass**

Run: `npm test -- test/api-labels-queue.test.ts`
Expected: PASS all three cases.

- [ ] **Step 5: Commit**

```bash
git add src/worker.ts test/api-labels-queue.test.ts
git commit -m "feat: GET /api/labels/queue (spec §3c)"
```

---

### Task 5: `GET /api/labels/stats` route

**Files:**
- Modify: `src/worker.ts` (add after `/api/labels/queue`)
- Create: `test/api-labels-stats.test.ts`

**Interfaces:**
- Produces: `GET /api/labels/stats` → `{ generatedAt, bySource: Record<LabelSource, {total, labeled}>, byVerdict: {threat, suspicious, benign, unclear}, imbalance: {threatVsBenign} }`.
- `imbalance.threatVsBenign = threat / max(benign, 1)` — used by the Phase 1 Platt fitter guard (spec §3d).

- [ ] **Step 1: Write the failing test**

Create `test/api-labels-stats.test.ts`:

```ts
import { env, SELF } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";

const seedCandidate = (id: string, source: string, createdAt: number) =>
  env.DB.prepare(
    `INSERT INTO candidate_incidents (id, vessel_id, t_start, t_end, source, created_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6)`,
  ).bind(id, "416000001", 1, 2, source, createdAt);

const seedLabel = (incidentId: string, verdict: string) =>
  env.DB.prepare(
    `INSERT INTO labels (incident_id, labeler, ts, verdict, intent_categories, labeler_confidence, notes)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)`,
  ).bind(incidentId, "alice", 1, verdict, null, 3, null);

describe("GET /api/labels/stats", () => {
  beforeEach(async () => {
    await env.DB.batch([
      env.DB.prepare("DELETE FROM labels"),
      env.DB.prepare("DELETE FROM candidate_incidents"),
      seedCandidate("a1", "assessment", 1), seedCandidate("a2", "assessment", 2),
      seedCandidate("e1", "event_cluster", 3), seedCandidate("n1", "random_negative", 4),
      seedLabel("a1", "threat"), seedLabel("a2", "benign"), seedLabel("e1", "unclear"),
    ]);
  });

  it("reports per-source totals + labeled counts and verdict roll-up", async () => {
    const body = await (await SELF.fetch("https://x/api/labels/stats")).json<any>();
    expect(body.bySource.assessment).toEqual({ total: 2, labeled: 2 });
    expect(body.bySource.event_cluster).toEqual({ total: 1, labeled: 1 });
    expect(body.bySource.random_negative).toEqual({ total: 1, labeled: 0 });
    expect(body.bySource.curated_positive).toEqual({ total: 0, labeled: 0 });
    expect(body.byVerdict).toEqual({ threat: 1, suspicious: 0, benign: 1, unclear: 1 });
    expect(body.imbalance.threatVsBenign).toBe(1);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npm test -- test/api-labels-stats.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

In `src/worker.ts` after the queue route, add:

```ts
    if (url.pathname === "/api/labels/stats") {
      const [srcRows, verdictRows] = await env.DB.batch([
        env.DB.prepare(`
          SELECT c.source AS src, COUNT(c.id) AS total,
                 SUM(CASE WHEN l.id IS NULL THEN 0 ELSE 1 END) AS labeled
          FROM candidate_incidents c LEFT JOIN labels l ON l.incident_id = c.id
          GROUP BY c.source`),
        env.DB.prepare(`SELECT verdict AS v, COUNT(*) AS c FROM labels GROUP BY verdict`),
      ]);
      const bySource: Record<string, { total: number; labeled: number }> = {};
      for (const s of LABEL_SOURCES) bySource[s] = { total: 0, labeled: 0 };
      for (const r of srcRows.results as any[]) bySource[r.src] = { total: Number(r.total), labeled: Number(r.labeled) };
      const byVerdict = { threat: 0, suspicious: 0, benign: 0, unclear: 0 };
      for (const r of verdictRows.results as any[]) if (r.v in byVerdict) (byVerdict as any)[r.v] = Number(r.c);
      return json({
        generatedAt: now, bySource, byVerdict,
        imbalance: { threatVsBenign: byVerdict.threat / Math.max(byVerdict.benign, 1) },
      });
    }
```

- [ ] **Step 4: Run to verify pass**

Run: `npm test -- test/api-labels-stats.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/worker.ts test/api-labels-stats.test.ts
git commit -m "feat: GET /api/labels/stats (spec §3c, §3d imbalance guard)"
```

---

### Task 6: `POST /api/labels` route

**Files:**
- Modify: `src/worker.ts`
- Create: `test/api-labels-post.test.ts`

**Interfaces:**
- Produces: `POST /api/labels` — body `{ incidentId, labeler, verdict, intentCategories?, labelerConfidence?, notes? }`. Returns `{ ok: true, id }` on 200, `409` on duplicate `(incidentId, labeler)`, `400` on schema violation, `404` on unknown incidentId. `intentCategories` REQUIRED iff `verdict ∈ {threat, suspicious}`.

- [ ] **Step 1: Write the failing test**

Create `test/api-labels-post.test.ts`:

```ts
import { env, SELF } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";

async function seedCandidate(id: string) {
  await env.DB.prepare(
    `INSERT INTO candidate_incidents (id, vessel_id, t_start, t_end, source, created_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6)`,
  ).bind(id, "416000001", 1, 2, "assessment", 100).run();
}

async function postLabel(body: unknown, expectStatus = 200) {
  const res = await SELF.fetch("https://x/api/labels", { method: "POST", body: JSON.stringify(body) });
  expect(res.status).toBe(expectStatus);
  return res;
}

describe("POST /api/labels", () => {
  beforeEach(async () => {
    await env.DB.batch([env.DB.prepare("DELETE FROM labels"), env.DB.prepare("DELETE FROM candidate_incidents")]);
    await seedCandidate("inc-1");
  });

  it("writes a benign label without intent categories", async () => {
    await postLabel({ incidentId: "inc-1", labeler: "alice", verdict: "benign", labelerConfidence: 4 });
    const row = await env.DB.prepare(`SELECT verdict, intent_categories FROM labels WHERE incident_id = ?1`).bind("inc-1").first<any>();
    expect(row).toMatchObject({ verdict: "benign", intent_categories: null });
  });

  it("writes a threat label with intent categories JSON", async () => {
    await postLabel({ incidentId: "inc-1", labeler: "alice", verdict: "threat", intentCategories: ["cable_interference", "dark_activity"], labelerConfidence: 5, notes: "loitering + gap" });
    const row = await env.DB.prepare(`SELECT * FROM labels WHERE incident_id = ?1`).bind("inc-1").first<any>();
    expect(JSON.parse(row.intent_categories)).toEqual(["cable_interference", "dark_activity"]);
  });

  it("rejects threat verdict without intentCategories", async () => {
    await postLabel({ incidentId: "inc-1", labeler: "alice", verdict: "threat" }, 400);
  });

  it("rejects benign verdict with non-empty intentCategories", async () => {
    await postLabel({ incidentId: "inc-1", labeler: "alice", verdict: "benign", intentCategories: ["cable_interference"] }, 400);
  });

  it("returns 409 on duplicate (incidentId, labeler)", async () => {
    await postLabel({ incidentId: "inc-1", labeler: "alice", verdict: "benign" });
    await postLabel({ incidentId: "inc-1", labeler: "alice", verdict: "threat", intentCategories: ["dark_activity"] }, 409);
  });

  it("rejects unknown incidentId with 404", async () => {
    await postLabel({ incidentId: "nope", labeler: "alice", verdict: "benign" }, 404);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npm test -- test/api-labels-post.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

Extend imports in `src/worker.ts`:

```ts
import { LABEL_SOURCES, LABEL_VERDICTS, rowToCandidate } from "./labeling";
```

Add after `/api/labels/stats`:

```ts
    if (url.pathname === "/api/labels" && req.method === "POST") {
      let body: any;
      try { body = await req.json(); } catch { return json({ error: "bad json" }, 400); }
      const { incidentId, labeler, verdict, intentCategories, labelerConfidence, notes } = body ?? {};
      if (typeof incidentId !== "string" || !incidentId) return json({ error: "incidentId required" }, 400);
      if (typeof labeler !== "string" || !labeler) return json({ error: "labeler required" }, 400);
      if (!(LABEL_VERDICTS as readonly string[]).includes(verdict)) return json({ error: "bad verdict" }, 400);
      const needsIntent = verdict === "threat" || verdict === "suspicious";
      if (needsIntent) {
        if (!Array.isArray(intentCategories) || intentCategories.length === 0
            || !intentCategories.every((c: string) => (THREAT_CATEGORIES as readonly string[]).includes(c))) {
          return json({ error: "intentCategories required and must be non-empty ThreatCategory[]" }, 400);
        }
      } else if (Array.isArray(intentCategories) && intentCategories.length > 0) {
        return json({ error: "intentCategories only for threat/suspicious" }, 400);
      }
      if (labelerConfidence !== undefined && !(Number.isInteger(labelerConfidence) && labelerConfidence >= 1 && labelerConfidence <= 5)) {
        return json({ error: "labelerConfidence must be integer 1..5" }, 400);
      }
      const existsRow = await env.DB.prepare(`SELECT id FROM candidate_incidents WHERE id = ?1`).bind(incidentId).first<any>();
      if (!existsRow) return json({ error: "unknown incidentId" }, 404);
      try {
        const result = await env.DB.prepare(
          `INSERT INTO labels (incident_id, labeler, ts, verdict, intent_categories, labeler_confidence, notes)
           VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)`,
        ).bind(
          incidentId, labeler, now, verdict,
          needsIntent ? JSON.stringify(intentCategories) : null,
          labelerConfidence ?? null,
          typeof notes === "string" ? notes : null,
        ).run();
        return json({ ok: true, id: result.meta.last_row_id }, 200);
      } catch (err) {
        if (String(err).match(/UNIQUE/i)) return json({ error: "already labeled" }, 409);
        throw err;
      }
    }
```

- [ ] **Step 4: Run to verify pass**

Run: `npm test -- test/api-labels-post.test.ts`
Expected: PASS all six cases.

- [ ] **Step 5: Commit**

```bash
git add src/worker.ts test/api-labels-post.test.ts
git commit -m "feat: POST /api/labels with schema + 409 dedup (spec §3c)"
```

---

### Task 7: Extend `/api/vessel/:mmsi/track` with absolute `from` / `to` params

Review-mode replay needs to render the incident window `t_start..t_end`, not "window from now".

**Files:**
- Modify: `src/worker.ts` (the `trackMatch` block)
- Create: `test/api-vessel-track-range.test.ts`

**Interfaces:**
- Produces: `GET /api/vessel/{mmsi}/track?from=<ms>&to=<ms>` filters positions where `ts BETWEEN from AND to`. If both are absent, existing `window` behavior preserved.

- [ ] **Step 1: Write the failing test**

Create `test/api-vessel-track-range.test.ts`:

```ts
import { env, SELF } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";

describe("GET /api/vessel/:mmsi/track?from=&to=", () => {
  const MMSI = 416000042;
  beforeEach(async () => {
    await env.DB.batch([
      env.DB.prepare("DELETE FROM positions"),
      env.DB.prepare("DELETE FROM vessels"),
      env.DB.prepare(
        `INSERT INTO vessels (mmsi, name, callsign, last_lon, last_lat, last_sog, last_cog, last_ts, score, score_ts)
         VALUES (?1, 'X', 'BX', 120, 22, 0, 0, ?2, 0, ?2)`).bind(MMSI, 3000),
      env.DB.prepare(`INSERT INTO positions (mmsi, ts, lon, lat, sog, cog) VALUES (?1, 1000, 120, 22, 0, 0)`).bind(MMSI),
      env.DB.prepare(`INSERT INTO positions (mmsi, ts, lon, lat, sog, cog) VALUES (?1, 2000, 120, 22, 0, 0)`).bind(MMSI),
      env.DB.prepare(`INSERT INTO positions (mmsi, ts, lon, lat, sog, cog) VALUES (?1, 3000, 120, 22, 0, 0)`).bind(MMSI),
    ]);
  });

  it("returns positions whose ts is in [from, to]", async () => {
    const res = await SELF.fetch(`https://x/api/vessel/${MMSI}/track?from=1500&to=2500`);
    expect(res.status).toBe(200);
    const body = await res.json<any>();
    expect(body.points.map((p: any) => p.ts)).toEqual([2000]);
  });

  it("400 if range malformed", async () => {
    const r = await SELF.fetch(`https://x/api/vessel/${MMSI}/track?from=abc&to=2000`);
    expect(r.status).toBe(400);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npm test -- test/api-vessel-track-range.test.ts`
Expected: FAIL.

- [ ] **Step 3: Modify the handler**

In `src/worker.ts`, replace the current `trackMatch` block (around lines 201-222) with:

```ts
    const trackMatch = /^\/api\/vessel\/(\d{1,9})\/track$/.exec(url.pathname);
    if (trackMatch) {
      const mmsi = Number(trackMatch[1]);
      const fromRaw = url.searchParams.get("from");
      const toRaw = url.searchParams.get("to");
      let fromTs: number, toTs: number;
      if (fromRaw !== null || toRaw !== null) {
        const from = Number(fromRaw), to = Number(toRaw);
        if (!Number.isFinite(from) || !Number.isFinite(to) || from >= to) return json({ error: "bad range" }, 400);
        fromTs = from; toTs = to;
      } else {
        const winMs = parseWindow(url.searchParams.get("window"));
        if (winMs === null) return json({ error: "bad window" }, 400);
        fromTs = now - winMs; toTs = now;
      }
      const vessel = await env.DB.prepare(`SELECT mmsi FROM vessels WHERE mmsi = ?1`).bind(mmsi).first<any>();
      if (!vessel) return json({ error: "unknown vessel" }, 404);
      const { error: gfwError } = await gfwBackfillVessel(env, mmsi, now);
      const [points, gfw] = await Promise.all([
        env.DB.prepare(`SELECT ts, lon, lat, sog, cog FROM positions WHERE mmsi = ?1 AND ts BETWEEN ?2 AND ?3 ORDER BY ts ASC`)
          .bind(mmsi, fromTs, toTs).all<any>(),
        env.DB.prepare(`SELECT id, type, lon, lat, start_ts, end_ts FROM gfw_events WHERE mmsi = ?1 AND start_ts BETWEEN ?2 AND ?3 ORDER BY start_ts ASC`)
          .bind(mmsi, fromTs, toTs).all<any>(),
      ]);
      return json({
        generatedAt: now,
        points: points.results,
        gfwEvents: gfw.results.map((r: any) => ({ id: r.id, type: r.type, lon: r.lon, lat: r.lat, startTs: r.start_ts, endTs: r.end_ts })),
        gfwError,
      });
    }
```

- [ ] **Step 4: Run to verify pass**

Run: `npm test -- test/api-vessel-track-range.test.ts test/api-trajectories.test.ts`
Expected: PASS both (backward-compat with `?window=`).

- [ ] **Step 5: Commit**

```bash
git add src/worker.ts test/api-vessel-track-range.test.ts
git commit -m "feat: /api/vessel/:mmsi/track accepts absolute from/to for replay-mode"
```

---

### Task 8: Materializer skeleton + shared helpers

**Files:**
- Create: `src/materializer.ts`
- Create: `scripts/materialize-candidates.ts`
- Create: `scripts/materialize/{assessment,event-cluster,random-negative,curated-positive}.ts` (stubs)
- Create: `test/materializer.test.ts`
- Modify: `package.json` (add `"materialize": "tsx scripts/materialize-candidates.ts"`)

**Interfaces:**
- Produces:
  - `function windowsOverlap(a: {tStart:number; tEnd:number}, b: {tStart:number; tEnd:number}): boolean`
  - `const SHARED_INSERT_SQL: string` (parameterised `INSERT OR IGNORE`)
  - `function toInsertRow(c: CandidateIncident): [string, string, number, number, string, string | null, number, string, string]`
  - `type SourceMaterializer = (deps: { origin: string; now: number; lookbackMs: number }) => Promise<CandidateIncident[]>`

- [ ] **Step 1: Write the failing test**

Create `test/materializer.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { toInsertRow, windowsOverlap } from "../src/materializer";
import type { CandidateIncident } from "../src/labeling";

describe("windowsOverlap", () => {
  it("true when a starts before b ends and a ends after b starts", () => {
    expect(windowsOverlap({ tStart: 0, tEnd: 100 }, { tStart: 50, tEnd: 150 })).toBe(true);
    expect(windowsOverlap({ tStart: 50, tEnd: 150 }, { tStart: 0, tEnd: 100 })).toBe(true);
  });
  it("false for disjoint windows", () => {
    expect(windowsOverlap({ tStart: 0, tEnd: 100 }, { tStart: 200, tEnd: 300 })).toBe(false);
  });
  it("false when adjacent — treated as non-overlapping", () => {
    expect(windowsOverlap({ tStart: 0, tEnd: 100 }, { tStart: 100, tEnd: 200 })).toBe(false);
  });
});

describe("toInsertRow", () => {
  it("serializes JSON columns and preserves nulls", () => {
    const c: CandidateIncident = {
      id: "abc", vesselId: "416", tStart: 1, tEnd: 2,
      source: "assessment", sourceRef: "ref-1", createdAt: 3,
      modelSnapshot: { topCategory: "cable_interference" }, eventIds: ["e1"],
    };
    expect(toInsertRow(c)).toEqual([
      "abc", "416", 1, 2, "assessment", "ref-1", 3,
      '{"topCategory":"cable_interference"}', '["e1"]',
    ]);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npm test -- test/materializer.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement `src/materializer.ts`**

```ts
// src/materializer.ts — shared helpers for the candidate-incident materializer (spec §3b).
import type { CandidateIncident } from "./labeling";

export type Window = { tStart: number; tEnd: number };

export function windowsOverlap(a: Window, b: Window): boolean {
  return a.tStart < b.tEnd && b.tStart < a.tEnd;
}

export const SHARED_INSERT_SQL =
  `INSERT OR IGNORE INTO candidate_incidents
   (id, vessel_id, t_start, t_end, source, source_ref, created_at, model_snapshot, event_ids)
   VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)`;

export function toInsertRow(c: CandidateIncident): [string, string, number, number, string, string | null, number, string, string] {
  return [
    c.id, c.vesselId, c.tStart, c.tEnd, c.source, c.sourceRef, c.createdAt,
    JSON.stringify(c.modelSnapshot ?? {}),
    JSON.stringify(c.eventIds ?? []),
  ];
}
```

- [ ] **Step 4: Create the CLI skeleton `scripts/materialize-candidates.ts`**

```ts
// scripts/materialize-candidates.ts — CLI: npm run materialize -- --source=all [--lookback-days=30]
// Delegates to per-source builders that call the Worker to fetch source data + POST /api/labels/materialize.
import { LABEL_SOURCES, type LabelSource } from "../src/labeling";
import { materializeAssessments } from "./materialize/assessment";
import { materializeEventClusters } from "./materialize/event-cluster";
import { materializeRandomNegatives } from "./materialize/random-negative";
import { materializeCuratedPositives } from "./materialize/curated-positive";

const args = new Map<string, string>();
for (const a of process.argv.slice(2)) {
  const m = /^--([^=]+)=(.*)$/.exec(a);
  if (m) args.set(m[1], m[2]);
}
const source = (args.get("source") ?? "all") as LabelSource | "all";
const lookbackDays = Number(args.get("lookback-days") ?? "30");
const origin = args.get("origin") ?? process.env.DEV_ORIGIN ?? "http://127.0.0.1:8787";
if (source !== "all" && !LABEL_SOURCES.includes(source)) {
  console.error(`bad --source; expected one of ${LABEL_SOURCES.join(",")} or "all"`);
  process.exit(1);
}
if (!Number.isFinite(lookbackDays) || lookbackDays <= 0) {
  console.error("--lookback-days must be positive");
  process.exit(1);
}
const lookbackMs = lookbackDays * 86_400_000;
const now = Date.now();

async function run(): Promise<void> {
  const dispatch = {
    assessment: materializeAssessments,
    event_cluster: materializeEventClusters,
    random_negative: materializeRandomNegatives,
    curated_positive: materializeCuratedPositives,
  } as const;
  const sources = source === "all" ? LABEL_SOURCES : [source];
  let total = 0;
  for (const s of sources) {
    const candidates = await dispatch[s]({ origin, now, lookbackMs });
    const res = await fetch(`${origin}/api/labels/materialize`, {
      method: "POST", body: JSON.stringify({ source: s, candidates }),
    });
    if (!res.ok) { console.error(`materialize ${s} failed: ${res.status} ${await res.text()}`); process.exit(1); }
    const { inserted } = await res.json() as { inserted: number };
    console.log(`${s}: ${candidates.length} generated, ${inserted} new`);
    total += inserted;
  }
  console.log(`total inserted: ${total}`);
}
void run();
```

- [ ] **Step 5: Create stub source modules**

`scripts/materialize/assessment.ts` (also for event-cluster.ts, random-negative.ts, curated-positive.ts):

```ts
// scripts/materialize/assessment.ts — Task 9 fills this in.
import type { CandidateIncident } from "../../src/labeling";
export async function materializeAssessments(_: { origin: string; now: number; lookbackMs: number }): Promise<CandidateIncident[]> {
  throw new Error("not implemented — Task 9");
}
```

`scripts/materialize/event-cluster.ts`:

```ts
// scripts/materialize/event-cluster.ts — Task 10 fills this in.
import type { CandidateIncident } from "../../src/labeling";
export async function materializeEventClusters(_: { origin: string; now: number; lookbackMs: number }): Promise<CandidateIncident[]> {
  throw new Error("not implemented — Task 10");
}
```

`scripts/materialize/random-negative.ts`:

```ts
// scripts/materialize/random-negative.ts — Task 11 fills this in.
import type { CandidateIncident } from "../../src/labeling";
export async function materializeRandomNegatives(_: { origin: string; now: number; lookbackMs: number }): Promise<CandidateIncident[]> {
  throw new Error("not implemented — Task 11");
}
```

`scripts/materialize/curated-positive.ts`:

```ts
// scripts/materialize/curated-positive.ts — Task 12 fills this in.
import type { CandidateIncident } from "../../src/labeling";
export async function materializeCuratedPositives(_: { origin: string; now: number; lookbackMs: number }): Promise<CandidateIncident[]> {
  throw new Error("not implemented — Task 12");
}
```

- [ ] **Step 6: Add npm script**

In `package.json` `"scripts"`, add:

```json
    "materialize": "tsx scripts/materialize-candidates.ts"
```

- [ ] **Step 7: Run tests + commit**

Run: `npm test -- test/materializer.test.ts`
Expected: PASS.

```bash
git add src/materializer.ts scripts/materialize-candidates.ts scripts/materialize/ test/materializer.test.ts package.json
git commit -m "feat: materializer skeleton + shared helpers (spec §3b)"
```

---

### Task 9: Materializer source — `assessment`

**Files:**
- Modify: `scripts/materialize/assessment.ts`
- Create: `src/materialize-server.ts`
- Modify: `src/worker.ts` — add `GET /api/labels/materialize/assessments` and `POST /api/labels/materialize`
- Create: `test/materialize-server.test.ts`

**Interfaces:**
- Produces: `function candidatesFromAssessments(rows: AssessmentRow[], marginMs: number, now: number): CandidateIncident[]`.

- [ ] **Step 1: Write the failing test**

Create `test/materialize-server.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { candidatesFromAssessments } from "../src/materialize-server";

describe("candidatesFromAssessments", () => {
  it("emits one candidate per assessment with 30-min margins", () => {
    const now = 1_700_100_000_000;
    const rows = [
      { id: "cable_interference-1-1", mmsi: 416000001, opened_ts: 1_700_000_000_000, closed_ts: 1_700_010_000_000,
        category: "cable_interference", confidence: 0.7, region: "tw" },
      { id: "dark_activity-2-1", mmsi: 440000002, opened_ts: 1_700_050_000_000, closed_ts: null,
        category: "dark_activity", confidence: 0.4, region: "kr" },
    ];
    const cs = candidatesFromAssessments(rows as any, 30 * 60_000, now);
    expect(cs).toHaveLength(2);
    expect(cs[0]).toMatchObject({
      vesselId: "416000001", source: "assessment", sourceRef: "cable_interference-1-1",
      tStart: 1_700_000_000_000 - 30 * 60_000,
      tEnd: 1_700_010_000_000 + 30 * 60_000,
    });
    expect(cs[1].tEnd).toBe(now + 30 * 60_000);
    expect((cs[0].modelSnapshot as any).category).toBe("cable_interference");
    expect(cs[0].id).toMatch(/^[0-9a-f]{16}$/);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npm test -- test/materialize-server.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement `src/materialize-server.ts`**

```ts
// src/materialize-server.ts — pure candidate builders per LabelSource (spec §3b).
import { candidateIdOf, type CandidateIncident } from "./labeling";
import { windowsOverlap, type Window } from "./materializer";

export interface AssessmentRow {
  id: string; mmsi: number; opened_ts: number; closed_ts: number | null;
  category: string; confidence: number; region: string | null;
}

export function candidatesFromAssessments(rows: AssessmentRow[], marginMs: number, now: number): CandidateIncident[] {
  return rows.map((r) => {
    const tStart = r.opened_ts - marginMs;
    const tEnd = (r.closed_ts ?? now) + marginMs;
    return {
      id: candidateIdOf(String(r.mmsi), tStart, tEnd, "assessment"),
      vesselId: String(r.mmsi),
      tStart, tEnd,
      source: "assessment",
      sourceRef: r.id,
      createdAt: now,
      modelSnapshot: {
        assessmentId: r.id, category: r.category, confidence: r.confidence,
        openedTs: r.opened_ts, closedTs: r.closed_ts, region: r.region,
      },
      eventIds: [],
    };
  });
}
```

- [ ] **Step 4: Add Worker endpoints**

In `src/worker.ts`, after `POST /api/labels`, add:

```ts
    if (url.pathname === "/api/labels/materialize/assessments") {
      const since = Number(url.searchParams.get("since") ?? 0);
      const until = Number(url.searchParams.get("until") ?? now);
      if (!Number.isFinite(since) || !Number.isFinite(until)) return json({ error: "bad range" }, 400);
      const { results } = await env.DB.prepare(
        `SELECT id, mmsi, opened_ts, closed_ts, category, confidence, region
         FROM assessments WHERE opened_ts >= ?1 AND opened_ts <= ?2 ORDER BY opened_ts ASC`,
      ).bind(since, until).all<any>();
      return json({ generatedAt: now, rows: results });
    }

    if (url.pathname === "/api/labels/materialize" && req.method === "POST") {
      let body: any;
      try { body = await req.json(); } catch { return json({ error: "bad json" }, 400); }
      const candidates = body?.candidates as any[] | undefined;
      if (!Array.isArray(candidates)) return json({ error: "candidates required" }, 400);
      const { SHARED_INSERT_SQL, toInsertRow } = await import("./materializer");
      const stmts = candidates.map((c) => env.DB.prepare(SHARED_INSERT_SQL).bind(...toInsertRow(c)));
      const results = stmts.length ? await env.DB.batch(stmts) : [];
      const inserted = results.reduce((a: number, r: any) => a + (r.meta?.changes ?? 0), 0);
      return json({ ok: true, inserted });
    }
```

- [ ] **Step 5: Implement the CLI source**

Replace `scripts/materialize/assessment.ts`:

```ts
// scripts/materialize/assessment.ts (spec §3b, source=assessment).
import { candidatesFromAssessments } from "../../src/materialize-server";
import type { CandidateIncident } from "../../src/labeling";

const MARGIN_MS = 30 * 60_000;

export async function materializeAssessments(deps: { origin: string; now: number; lookbackMs: number }): Promise<CandidateIncident[]> {
  const since = deps.now - deps.lookbackMs;
  const res = await fetch(`${deps.origin}/api/labels/materialize/assessments?since=${since}&until=${deps.now}`);
  if (!res.ok) throw new Error(`fetch assessments failed: ${res.status}`);
  const { rows } = await res.json() as { rows: any[] };
  return candidatesFromAssessments(rows, MARGIN_MS, deps.now);
}
```

- [ ] **Step 6: End-to-end test**

Append to `test/materialize-server.test.ts`:

```ts
import { env, SELF } from "cloudflare:test";
import { beforeEach } from "vitest";

describe("/api/labels/materialize (POST) is idempotent", () => {
  beforeEach(async () => {
    await env.DB.batch([env.DB.prepare("DELETE FROM candidate_incidents")]);
  });

  it("inserts new candidates and ignores duplicates", async () => {
    const c = {
      id: "hash-abc", vesselId: "416000001", tStart: 1, tEnd: 2,
      source: "assessment", sourceRef: "a-1", createdAt: 3, modelSnapshot: {}, eventIds: [],
    };
    const post = async () => (await SELF.fetch("https://x/api/labels/materialize", {
      method: "POST", body: JSON.stringify({ source: "assessment", candidates: [c] }),
    })).json<any>();
    expect((await post()).inserted).toBe(1);
    expect((await post()).inserted).toBe(0);
  });
});
```

Run: `npm test -- test/materialize-server.test.ts`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/materialize-server.ts src/worker.ts scripts/materialize/assessment.ts test/materialize-server.test.ts
git commit -m "feat: materializer source=assessment + POST /api/labels/materialize (spec §3b)"
```

---

### Task 10: Materializer source — `event_cluster`

**Files:**
- Modify: `scripts/materialize/event-cluster.ts`
- Modify: `src/materialize-server.ts` (add `candidatesFromEventClusters`)
- Modify: `src/worker.ts` (add `GET /api/labels/materialize/event-clusters`)
- Modify: `test/materialize-server.test.ts`

**Interfaces:**
- Produces: `function candidatesFromEventClusters(events: EventRow[], assessmentWindows: Window[], bucketMs: number, minEvents: number, now: number): CandidateIncident[]`.

- [ ] **Step 1: Write the failing test**

Append to `test/materialize-server.test.ts`:

```ts
import { candidatesFromEventClusters } from "../src/materialize-server";

describe("candidatesFromEventClusters", () => {
  const bucket = 30 * 60_000;
  const now = 1_700_100_000_000;
  const rowsOfCluster = (mmsi: number, tBase: number, n: number) =>
    Array.from({ length: n }, (_, i) => ({ id: `e${mmsi}-${i}`, mmsi, start_ts: tBase + i * 60_000, type: "loitering" }));

  it("emits a candidate for buckets with ≥ minEvents events", () => {
    const events = rowsOfCluster(416, 1_700_000_000_000, 3);
    const cs = candidatesFromEventClusters(events as any, [], bucket, 3, now);
    expect(cs).toHaveLength(1);
    expect(cs[0]).toMatchObject({ vesselId: "416", source: "event_cluster" });
    expect(cs[0].eventIds).toEqual(["e416-0", "e416-1", "e416-2"]);
    expect(cs[0].tEnd - cs[0].tStart).toBe(bucket);
  });

  it("drops buckets below minEvents", () => {
    const events = rowsOfCluster(416, 1_700_000_000_000, 2);
    expect(candidatesFromEventClusters(events as any, [], bucket, 3, now)).toEqual([]);
  });

  it("drops buckets overlapping an assessment window", () => {
    const events = rowsOfCluster(416, 1_700_000_000_000, 4);
    const assessmentWindow = { tStart: 1_700_000_000_000 - 60_000, tEnd: 1_700_000_000_000 + 3 * 60_000 };
    expect(candidatesFromEventClusters(events as any, [assessmentWindow], bucket, 3, now)).toEqual([]);
  });

  it("does NOT drop adjacent (end == start) buckets", () => {
    const events = rowsOfCluster(416, 1_700_000_000_000, 3);
    const assessment = { tStart: 1_700_000_000_000 - bucket, tEnd: 1_700_000_000_000 };
    expect(candidatesFromEventClusters(events as any, [assessment], bucket, 3, now)).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npm test -- test/materialize-server.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

Append to `src/materialize-server.ts`:

```ts
export interface EventRow { id: string; mmsi: number; start_ts: number; type: string; }

export function candidatesFromEventClusters(
  events: EventRow[], assessmentWindows: Window[], bucketMs: number, minEvents: number, now: number,
): CandidateIncident[] {
  const buckets = new Map<string, EventRow[]>();
  for (const e of events) {
    const bucketStart = Math.floor(e.start_ts / bucketMs) * bucketMs;
    const key = `${e.mmsi}:${bucketStart}`;
    (buckets.get(key) ?? buckets.set(key, []).get(key)!).push(e);
  }
  const out: CandidateIncident[] = [];
  for (const [key, group] of buckets) {
    if (group.length < minEvents) continue;
    const bucketStart = Number(key.split(":")[1]);
    const w: Window = { tStart: bucketStart, tEnd: bucketStart + bucketMs };
    if (assessmentWindows.some((a) => windowsOverlap(w, a))) continue;
    const vesselId = String(group[0].mmsi);
    out.push({
      id: candidateIdOf(vesselId, w.tStart, w.tEnd, "event_cluster"),
      vesselId, tStart: w.tStart, tEnd: w.tEnd,
      source: "event_cluster", sourceRef: key, createdAt: now,
      modelSnapshot: { types: [...new Set(group.map((e) => e.type))] },
      eventIds: group.map((e) => e.id),
    });
  }
  return out;
}
```

- [ ] **Step 4: Add Worker endpoint**

In `src/worker.ts` after the `assessments` materialize route:

```ts
    if (url.pathname === "/api/labels/materialize/event-clusters") {
      const since = Number(url.searchParams.get("since") ?? 0);
      const until = Number(url.searchParams.get("until") ?? now);
      if (!Number.isFinite(since) || !Number.isFinite(until)) return json({ error: "bad range" }, 400);
      const [events, assessments] = await env.DB.batch([
        env.DB.prepare(`SELECT id, mmsi, start_ts, type FROM events WHERE start_ts BETWEEN ?1 AND ?2`).bind(since, until),
        env.DB.prepare(`SELECT opened_ts, closed_ts FROM assessments WHERE opened_ts BETWEEN ?1 AND ?2`).bind(since, until),
      ]);
      const assessmentWindows = (assessments.results as any[]).map((r) => ({
        tStart: r.opened_ts, tEnd: r.closed_ts ?? now,
      }));
      return json({ generatedAt: now, events: events.results, assessmentWindows });
    }
```

- [ ] **Step 5: Implement CLI source**

Replace `scripts/materialize/event-cluster.ts`:

```ts
// scripts/materialize/event-cluster.ts (spec §3b, source=event_cluster).
import { candidatesFromEventClusters } from "../../src/materialize-server";
import type { CandidateIncident } from "../../src/labeling";

const BUCKET_MS = 30 * 60_000;
const MIN_EVENTS = 3;

export async function materializeEventClusters(deps: { origin: string; now: number; lookbackMs: number }): Promise<CandidateIncident[]> {
  const since = deps.now - deps.lookbackMs;
  const res = await fetch(`${deps.origin}/api/labels/materialize/event-clusters?since=${since}&until=${deps.now}`);
  if (!res.ok) throw new Error(`fetch event-clusters failed: ${res.status}`);
  const { events, assessmentWindows } = await res.json() as { events: any[]; assessmentWindows: any[] };
  return candidatesFromEventClusters(events, assessmentWindows, BUCKET_MS, MIN_EVENTS, deps.now);
}
```

- [ ] **Step 6: Run tests + commit**

Run: `npm test -- test/materialize-server.test.ts`
Expected: PASS.

```bash
git add src/materialize-server.ts src/worker.ts scripts/materialize/event-cluster.ts test/materialize-server.test.ts
git commit -m "feat: materializer source=event_cluster (spec §3b)"
```

---

### Task 11: Materializer source — `random_negative`

**Files:**
- Modify: `scripts/materialize/random-negative.ts`
- Modify: `src/materialize-server.ts` (add `candidatesFromRandomNegatives`)
- Modify: `src/worker.ts` (add `GET /api/labels/materialize/random-negatives`)
- Modify: `src/config.ts` (add `labelingRandomNegSamplesPerDay: 5`, `labelingRandomNegSeed: "phase-0-seed"`)
- Modify: `test/materialize-server.test.ts`

**Interfaces:**
- Produces: `function candidatesFromRandomNegatives(vesselDays: {vessel_id:string; day_ms:number}[], skipWindows: Window[], samplesPerDay: number, seed: string, now: number): CandidateIncident[]`.

- [ ] **Step 1: Write the failing test**

Append to `test/materialize-server.test.ts`:

```ts
import { candidatesFromRandomNegatives } from "../src/materialize-server";

describe("candidatesFromRandomNegatives", () => {
  const DAY_MS = 86_400_000;
  const now = 1_700_100_000_000;

  it("selects up to samplesPerDay per (day_ms) bucket, deterministically", () => {
    const days = Array.from({ length: 10 }, (_, i) => ({ vessel_id: String(400_000_000 + i), day_ms: 1_700_000_000_000 }));
    const a = candidatesFromRandomNegatives(days, [], 3, "seed-x", now);
    const b = candidatesFromRandomNegatives(days, [], 3, "seed-x", now);
    expect(a).toHaveLength(3);
    expect(a.map((c) => c.vesselId)).toEqual(b.map((c) => c.vesselId));
    const c = candidatesFromRandomNegatives(days, [], 3, "seed-y", now);
    expect(a.map((x) => x.vesselId)).not.toEqual(c.map((x) => x.vesselId));
  });

  it("excludes days overlapping skipWindows", () => {
    const day = 1_700_000_000_000;
    const skipWindows = [{ tStart: day + 60_000, tEnd: day + 120_000 }];
    expect(candidatesFromRandomNegatives([{ vessel_id: "416000001", day_ms: day }], skipWindows, 5, "s", now)).toEqual([]);
    expect(candidatesFromRandomNegatives([{ vessel_id: "416000001", day_ms: day + DAY_MS }], skipWindows, 5, "s", now)).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npm test -- test/materialize-server.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

Append to `src/materialize-server.ts`:

```ts
const DAY_MS = 86_400_000;

function stableHash(s: string): number {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619) >>> 0;
  return h;
}

export function candidatesFromRandomNegatives(
  vesselDays: { vessel_id: string; day_ms: number }[],
  skipWindows: Window[],
  samplesPerDay: number,
  seed: string,
  now: number,
): CandidateIncident[] {
  const byDay = new Map<number, { vessel_id: string; day_ms: number }[]>();
  for (const v of vesselDays) {
    (byDay.get(v.day_ms) ?? byDay.set(v.day_ms, []).get(v.day_ms)!).push(v);
  }
  const out: CandidateIncident[] = [];
  for (const [day, group] of byDay) {
    const w: Window = { tStart: day, tEnd: day + DAY_MS };
    if (skipWindows.some((s) => windowsOverlap(w, s))) continue;
    const scored = group.map((v) => ({ v, s: stableHash(`${v.vessel_id}:${day}:${seed}`) }));
    scored.sort((a, b) => a.s - b.s);
    for (const { v } of scored.slice(0, samplesPerDay)) {
      out.push({
        id: candidateIdOf(v.vessel_id, w.tStart, w.tEnd, "random_negative"),
        vesselId: v.vessel_id,
        tStart: w.tStart, tEnd: w.tEnd,
        source: "random_negative",
        sourceRef: null, createdAt: now,
        modelSnapshot: {}, eventIds: [],
      });
    }
  }
  return out;
}
```

- [ ] **Step 4: Add config entries**

In `src/config.ts` inside `CONFIG`, add:

```ts
  labelingRandomNegSamplesPerDay: 5,
  labelingRandomNegSeed: "phase-0-seed",
```

- [ ] **Step 5: Add Worker endpoint**

In `src/worker.ts` after the previous materialize endpoints:

```ts
    if (url.pathname === "/api/labels/materialize/random-negatives") {
      const since = Number(url.searchParams.get("since") ?? 0);
      const until = Number(url.searchParams.get("until") ?? now);
      if (!Number.isFinite(since) || !Number.isFinite(until)) return json({ error: "bad range" }, 400);
      const [vesselDays, assessments, events] = await env.DB.batch([
        env.DB.prepare(`
          SELECT v.mmsi AS vessel_id,
                 CAST((p.ts / 86400000) AS INTEGER) * 86400000 AS day_ms,
                 COUNT(p.ts) AS positions
          FROM positions p JOIN vessels v ON v.mmsi = p.mmsi
          WHERE p.ts BETWEEN ?1 AND ?2
          GROUP BY v.mmsi, day_ms HAVING positions >= 20`).bind(since, until),
        env.DB.prepare(`SELECT opened_ts, closed_ts FROM assessments WHERE opened_ts BETWEEN ?1 AND ?2`).bind(since, until),
        env.DB.prepare(`SELECT DISTINCT mmsi, CAST((start_ts / 86400000) AS INTEGER) * 86400000 AS day_ms FROM events WHERE start_ts BETWEEN ?1 AND ?2`).bind(since, until),
      ]);
      const eventDays = new Set((events.results as any[]).map((e) => `${e.mmsi}:${e.day_ms}`));
      const eligibleDays = (vesselDays.results as any[])
        .filter((r) => !eventDays.has(`${r.vessel_id}:${r.day_ms}`))
        .map((r) => ({ vessel_id: String(r.vessel_id), day_ms: Number(r.day_ms) }));
      const skipWindows = (assessments.results as any[]).map((r) => ({ tStart: r.opened_ts, tEnd: r.closed_ts ?? now }));
      return json({ generatedAt: now, vesselDays: eligibleDays, skipWindows });
    }
```

- [ ] **Step 6: Implement CLI source**

Replace `scripts/materialize/random-negative.ts`:

```ts
// scripts/materialize/random-negative.ts (spec §3b, source=random_negative).
import { candidatesFromRandomNegatives } from "../../src/materialize-server";
import type { CandidateIncident } from "../../src/labeling";

const SAMPLES_PER_DAY = 5;
const SEED = "phase-0-seed";

export async function materializeRandomNegatives(deps: { origin: string; now: number; lookbackMs: number }): Promise<CandidateIncident[]> {
  const since = deps.now - deps.lookbackMs;
  const res = await fetch(`${deps.origin}/api/labels/materialize/random-negatives?since=${since}&until=${deps.now}`);
  if (!res.ok) throw new Error(`fetch random-negatives failed: ${res.status}`);
  const { vesselDays, skipWindows } = await res.json() as { vesselDays: any[]; skipWindows: any[] };
  return candidatesFromRandomNegatives(vesselDays, skipWindows, SAMPLES_PER_DAY, SEED, deps.now);
}
```

- [ ] **Step 7: Run tests + commit**

Run: `npm test -- test/materialize-server.test.ts`
Expected: PASS.

```bash
git add src/materialize-server.ts src/config.ts src/worker.ts scripts/materialize/random-negative.ts test/materialize-server.test.ts
git commit -m "feat: materializer source=random_negative with deterministic sampling (spec §3b)"
```

---

### Task 12: Materializer source — `curated_positive` + seed file

**Files:**
- Create: `data/curated-incidents.json`
- Modify: `scripts/materialize/curated-positive.ts`
- Modify: `src/materialize-server.ts` (add `candidatesFromCuratedPositives`)
- Modify: `test/materialize-server.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `test/materialize-server.test.ts`:

```ts
import { candidatesFromCuratedPositives } from "../src/materialize-server";

describe("candidatesFromCuratedPositives", () => {
  it("emits one candidate per entry with note in model_snapshot", () => {
    const cs = candidatesFromCuratedPositives(
      [{ mmsi: 416000001, tStart: 1, tEnd: 2, note: "c4ads:unmasked-vlcc-1" }],
      100,
    );
    expect(cs).toHaveLength(1);
    expect(cs[0]).toMatchObject({
      vesselId: "416000001", source: "curated_positive",
      sourceRef: "c4ads:unmasked-vlcc-1",
      modelSnapshot: { note: "c4ads:unmasked-vlcc-1" },
    });
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npm test -- test/materialize-server.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

Append to `src/materialize-server.ts`:

```ts
export interface CuratedEntry { mmsi: number; tStart: number; tEnd: number; note: string; }

export function candidatesFromCuratedPositives(entries: CuratedEntry[], now: number): CandidateIncident[] {
  return entries.map((e) => {
    const vesselId = String(e.mmsi);
    return {
      id: candidateIdOf(vesselId, e.tStart, e.tEnd, "curated_positive"),
      vesselId, tStart: e.tStart, tEnd: e.tEnd,
      source: "curated_positive",
      sourceRef: e.note, createdAt: now,
      modelSnapshot: { note: e.note }, eventIds: [],
    };
  });
}
```

- [ ] **Step 4: Create the seed file `data/curated-incidents.json`**

```json
{
  "$schema": "curated-incidents-v1",
  "entries": [
    {
      "mmsi": 445000000,
      "tStart": 1704067200000,
      "tEnd": 1704153600000,
      "note": "seed:placeholder — replace with real C4ADS or GFW IUU case once curated (spec §3b)"
    }
  ]
}
```

The seed placeholder is intentional: production entries live behind a follow-up PR that pulls specific historical MMSIs + windows from C4ADS Unmasked and GFW IUU lists.

- [ ] **Step 5: Implement CLI source**

Replace `scripts/materialize/curated-positive.ts`:

```ts
// scripts/materialize/curated-positive.ts (spec §3b, source=curated_positive).
import { readFileSync } from "node:fs";
import path from "node:path";
import { candidatesFromCuratedPositives, type CuratedEntry } from "../../src/materialize-server";
import type { CandidateIncident } from "../../src/labeling";

export async function materializeCuratedPositives(deps: { origin: string; now: number; lookbackMs: number }): Promise<CandidateIncident[]> {
  const file = path.join(process.cwd(), "data/curated-incidents.json");
  const parsed = JSON.parse(readFileSync(file, "utf8")) as { entries: CuratedEntry[] };
  return candidatesFromCuratedPositives(parsed.entries ?? [], deps.now);
}
```

- [ ] **Step 6: Run tests + commit**

Run: `npm test -- test/materialize-server.test.ts`
Expected: PASS.

```bash
git add src/materialize-server.ts scripts/materialize/curated-positive.ts data/curated-incidents.json test/materialize-server.test.ts
git commit -m "feat: materializer source=curated_positive + seed placeholder (spec §3b)"
```

---

### Task 13: Web — Review mode routing via URL hash

**Files:**
- Modify: `web/src/hash.ts` (add `mode`)
- Modify: `web/src/main.ts` (dispatch on mode)
- Create: `web/src/review.ts` (skeleton)

- [ ] **Step 1: Replace `web/src/hash.ts`**

```ts
// web/src/hash.ts — shareable permalinks: #v=<lon>,<lat>,<zoom>&vessel=<mmsi>&filter=<type>&mode=review
export interface HashState { view?: { lon: number; lat: number; zoom: number }; vessel?: number; filter?: string; mode?: "review" }

export function readHash(): HashState {
  const params = new URLSearchParams(location.hash.slice(1));
  const out: HashState = {};
  const v = params.get("v")?.split(",").map(Number);
  if (v && v.length === 3 && v.every(Number.isFinite)) out.view = { lon: v[0], lat: v[1], zoom: v[2] };
  const m = Number(params.get("vessel"));
  if (Number.isInteger(m) && m > 0) out.vessel = m;
  const f = params.get("filter");
  if (f) out.filter = f;
  if (params.get("mode") === "review") out.mode = "review";
  return out;
}

export function writeHash(state: HashState): void {
  const params = new URLSearchParams();
  if (state.view) params.set("v", `${state.view.lon.toFixed(4)},${state.view.lat.toFixed(4)},${state.view.zoom.toFixed(2)}`);
  if (state.vessel) params.set("vessel", String(state.vessel));
  if (state.filter) params.set("filter", state.filter);
  if (state.mode) params.set("mode", state.mode);
  history.replaceState(null, "", `#${params}`);
}
```

- [ ] **Step 2: Skeleton `web/src/review.ts`**

```ts
// web/src/review.ts — Review-mode UI (spec §3c). Filled in Tasks 14-16.
export function initReviewMode(): void {
  document.body.classList.add("mode-review");
}
```

- [ ] **Step 3: Dispatch in `main.ts`**

In `web/src/main.ts` inside the `map.on("load", () => { ... })` body, wrap the existing `initEventFeed()`+peers in a mode branch:

```ts
  if (hashState.mode === "review") {
    void import("./review").then((m) => m.initReviewMode());
  } else {
    initEventFeed();
    initRegionSwitcher();
    initWindowSwitcher();
    initStatsBar();
    initTimeline();
    initCablePanel();
    if (hashState.vessel) selectVessel(hashState.vessel);
    initOnboarding();
  }
```

`initVessels(selectVessel)` and `initTrajectories(selectVessel)` stay above the branch — the map still shows vessels in Review mode.

- [ ] **Step 4: Sanity build + commit**

Run: `npm run build:web`
Expected: PASS.

```bash
git add web/src/hash.ts web/src/main.ts web/src/review.ts
git commit -m "feat: web Review-mode routing via #mode=review (spec §3c)"
```

---

### Task 14: Web — Review-mode incident queue panel

**Files:**
- Modify: `web/src/review.ts`
- Modify: `web/src/api.ts` (add `fetchLabelQueue`, `fetchLabelStats`)
- Modify: CSS surface (either `web/index.css` or the stylesheet the repo uses — check `web/index.html`)

- [ ] **Step 1: Add API client wrappers**

Append to `web/src/api.ts`:

```ts
export interface ApiCandidate {
  id: string; vesselId: string; tStart: number; tEnd: number;
  source: "assessment" | "event_cluster" | "random_negative" | "curated_positive";
  sourceRef: string | null; createdAt: number;
  modelSnapshot: unknown; eventIds: string[];
}
export async function fetchLabelQueue(source?: string, limit = 25): Promise<{ candidates: ApiCandidate[] }> {
  const qs = new URLSearchParams();
  if (source) qs.set("source", source);
  qs.set("limit", String(limit));
  const res = await fetch(`/api/labels/queue?${qs}`);
  if (!res.ok) throw new Error(`labels/queue ${res.status}`);
  return res.json();
}
export async function fetchLabelStats(): Promise<{
  bySource: Record<string, { total: number; labeled: number }>;
  byVerdict: { threat: number; suspicious: number; benign: number; unclear: number };
  imbalance: { threatVsBenign: number };
}> {
  const res = await fetch("/api/labels/stats");
  if (!res.ok) throw new Error(`labels/stats ${res.status}`);
  return res.json();
}
```

- [ ] **Step 2: Fill in `web/src/review.ts`**

Replace with:

```ts
// web/src/review.ts — Review-mode UI (spec §3c).
import { fetchLabelQueue, fetchLabelStats, type ApiCandidate } from "./api";

let selected: ApiCandidate | null = null;
const SOURCES = ["assessment", "event_cluster", "random_negative", "curated_positive"] as const;
const SOURCE_LABEL: Record<string, string> = {
  assessment: "Assessments", event_cluster: "Event clusters",
  random_negative: "Random negatives", curated_positive: "Curated positives",
};

async function renderQueue(): Promise<void> {
  const list = document.getElementById("event-list")!;
  const stats = await fetchLabelStats();
  const parts: string[] = [];
  for (const s of SOURCES) {
    const { total, labeled } = stats.bySource[s];
    const { candidates } = await fetchLabelQueue(s, 10);
    parts.push(
      `<li class="review-header"><b>${SOURCE_LABEL[s]}</b> ${labeled}/${total}</li>`,
      ...candidates.map((c) => `
        <li data-incident="${c.id}" data-mmsi="${c.vesselId}" data-tstart="${c.tStart}" data-tend="${c.tEnd}" class="review-row">
          MMSI ${c.vesselId} · ${new Date(c.tStart).toISOString().slice(0, 16).replace("T", " ")}Z
          <span class="review-source">${SOURCE_LABEL[s]}</span>
        </li>`),
    );
  }
  list.innerHTML = parts.join("");
  list.querySelectorAll("li.review-row").forEach((el) => el.addEventListener("click", async () => {
    const id = (el as HTMLElement).dataset.incident!;
    const c = await lookupById(id);
    if (c) selectReviewIncident(c);
  }));
  const chips = document.getElementById("filter-chips");
  if (chips) chips.innerHTML = `<span class="review-badge">Review mode · imbalance ${stats.imbalance.threatVsBenign.toFixed(2)}</span>`;
}

async function lookupById(id: string): Promise<ApiCandidate | null> {
  for (const s of SOURCES) {
    const { candidates } = await fetchLabelQueue(s, 100);
    const hit = candidates.find((c) => c.id === id);
    if (hit) return hit;
  }
  return null;
}

export function selectReviewIncident(c: ApiCandidate): void {
  selected = c;
  window.dispatchEvent(new CustomEvent("review-incident", { detail: c }));
}
export function getSelectedReview(): ApiCandidate | null { return selected; }

export function initReviewMode(): void {
  document.body.classList.add("mode-review");
  void renderQueue();
}
```

- [ ] **Step 3: Add minimal CSS**

Locate the repo's CSS (check `web/index.html` for `<link>` or `<style>` blocks — the CSS surface may be `web/index.css` or inline). Append:

```css
body.mode-review #region-switcher, body.mode-review #timeline, body.mode-review #stats-bar { display: none; }
li.review-header { padding: 6px 8px; color: #7d8aa0; }
li.review-row { padding: 4px 8px; cursor: pointer; }
li.review-row:hover { background: rgba(255,255,255,0.05); }
.review-source { color: #7d8aa0; margin-left: 8px; font-size: 11px; }
.review-badge { padding: 4px 8px; color: #4cc3ff; font-size: 11px; }
```

- [ ] **Step 4: Sanity build + commit**

Run: `npm run build:web`
Expected: PASS.

```bash
git add web/src/review.ts web/src/api.ts web/index.css web/index.html
git commit -m "feat: web Review-mode queue panel (spec §3c)"
```

(Adjust the `git add` file list to match the CSS surface the repo uses — check with `ls web/`.)

---

### Task 15: Web — Review-mode map replay

**Files:**
- Modify: `web/src/review.ts`
- Modify: `web/src/api.ts` (add `fetchVesselTrackRange`)

- [ ] **Step 1: Add API client**

Append to `web/src/api.ts`:

```ts
export async function fetchVesselTrackRange(mmsi: number, from: number, to: number): Promise<{
  points: { ts: number; lon: number; lat: number; sog: number; cog: number }[];
  gfwEvents: { id: string; type: string; lon: number; lat: number; startTs: number; endTs: number | null }[];
  gfwError?: unknown;
}> {
  const res = await fetch(`/api/vessel/${mmsi}/track?from=${from}&to=${to}`);
  if (!res.ok) throw new Error(`vessel/track ${res.status}`);
  return res.json();
}
```

- [ ] **Step 2: Extend `web/src/review.ts`**

Add imports at top:

```ts
import maplibregl from "maplibre-gl";
import type { GeoJSONSource } from "maplibre-gl";
import { map } from "./main";
import { fetchVessel, fetchVesselTrackRange, type ApiEvent } from "./api";
```

Add these helper functions:

```ts
const EMPTY = { type: "FeatureCollection", features: [] } as any;

function ensureReviewLayers(): void {
  if (map.getSource("review-track")) return;
  map.addSource("review-track", { type: "geojson", data: EMPTY });
  map.addSource("review-events", { type: "geojson", data: EMPTY });
  map.addLayer({ id: "review-track", type: "line", source: "review-track",
    paint: { "line-color": "#f0a83c", "line-width": 2.5, "line-opacity": 0.9 } }, "vessels");
  map.addLayer({ id: "review-events", type: "circle", source: "review-events",
    paint: { "circle-radius": 6, "circle-color": "#e5484d", "circle-stroke-color": "#0b1220", "circle-stroke-width": 1 } }, "sus-halo");
}

async function renderReplay(c: ApiCandidate): Promise<void> {
  ensureReviewLayers();
  const [track, dossier] = await Promise.all([
    fetchVesselTrackRange(Number(c.vesselId), c.tStart, c.tEnd),
    fetchVessel(Number(c.vesselId)),
  ]);
  const inWindow = (e: ApiEvent) => e.startTs >= c.tStart && (e.endTs ?? e.startTs) <= c.tEnd;
  const events = dossier.events.filter(inWindow);
  (map.getSource("review-track") as GeoJSONSource).setData(
    track.points.length > 1
      ? { type: "Feature", properties: {}, geometry: { type: "LineString", coordinates: track.points.map((p) => [p.lon, p.lat]) } } as any
      : EMPTY,
  );
  (map.getSource("review-events") as GeoJSONSource).setData({
    type: "FeatureCollection",
    features: events.map((e) => ({
      type: "Feature", geometry: { type: "Point", coordinates: [e.lon, e.lat] },
      properties: { id: e.id, type: e.type },
    })),
  } as any);
  if (track.points.length) {
    const b = new maplibregl.LngLatBounds();
    for (const p of track.points) b.extend([p.lon, p.lat]);
    if (!b.isEmpty()) map.fitBounds(b, { padding: 60, animate: true, maxZoom: 12 });
  }
}
```

At the end of `initReviewMode`, add:

```ts
  window.addEventListener("review-incident", ((ev: CustomEvent<ApiCandidate>) => { void renderReplay(ev.detail); }) as EventListener);
```

- [ ] **Step 3: Sanity build + commit**

Run: `npm run build:web`
Expected: PASS.

```bash
git add web/src/review.ts web/src/api.ts
git commit -m "feat: Review-mode map replay of incident window (spec §3c)"
```

---

### Task 16: Web — Review-mode label form

**Files:**
- Modify: `web/src/review.ts`
- Modify: `web/src/api.ts` (add `postLabel`)

- [ ] **Step 1: Add `postLabel`**

Append to `web/src/api.ts`:

```ts
export interface PostLabelBody {
  incidentId: string; labeler: string; verdict: "threat" | "suspicious" | "benign" | "unclear";
  intentCategories?: string[]; labelerConfidence?: number; notes?: string;
}
export async function postLabel(body: PostLabelBody): Promise<{ ok: true; id: number } | { error: string }> {
  const res = await fetch("/api/labels", { method: "POST", body: JSON.stringify(body) });
  return res.json();
}
```

- [ ] **Step 2: Extend `web/src/review.ts`**

Add imports:

```ts
import { postLabel, type PostLabelBody } from "./api";

const INTENT_LABELS: Record<string, string> = {
  cable_interference: "Cable interference",
  dark_activity: "Dark activity",
  identity_deception: "Identity deception",
};
```

Add the form render function:

```ts
function renderForm(c: ApiCandidate): void {
  const panel = document.getElementById("dossier")!;
  const body = document.getElementById("dossier-body")!;
  const labeler = localStorage.getItem("reviewLabeler") ?? "";
  body.innerHTML = `
    <h2>Label incident</h2>
    <div>MMSI ${c.vesselId} · ${new Date(c.tStart).toISOString().slice(0, 16).replace("T", " ")}Z → ${new Date(c.tEnd).toISOString().slice(0, 16).replace("T", " ")}Z</div>
    <div>Source: ${c.source} ${c.sourceRef ? `(${c.sourceRef})` : ""}</div>
    <form id="review-form">
      <label>Labeler <input name="labeler" required value="${labeler}"></label>
      <fieldset><legend>Verdict</legend>
        ${["threat", "suspicious", "benign", "unclear"].map((v) =>
          `<label><input type="radio" name="verdict" value="${v}" required> ${v}</label>`).join("")}
      </fieldset>
      <fieldset id="intent-fs" disabled>
        <legend>Intent categories</legend>
        ${Object.entries(INTENT_LABELS).map(([k, v]) =>
          `<label><input type="checkbox" name="intent" value="${k}"> ${v}</label>`).join("")}
      </fieldset>
      <label>Confidence
        <input type="range" name="confidence" min="1" max="5" value="3">
      </label>
      <label>Notes<textarea name="notes"></textarea></label>
      <button type="submit">Save &amp; next</button>
    </form>`;
  panel.hidden = false;
  const form = body.querySelector("#review-form") as HTMLFormElement;
  const intentFs = body.querySelector("#intent-fs") as HTMLFieldSetElement;
  form.addEventListener("change", () => {
    const v = (form.elements.namedItem("verdict") as RadioNodeList).value;
    intentFs.disabled = !(v === "threat" || v === "suspicious");
    if (intentFs.disabled) {
      intentFs.querySelectorAll<HTMLInputElement>("input[name=intent]").forEach((el) => (el.checked = false));
    }
  });
  form.addEventListener("submit", async (ev) => {
    ev.preventDefault();
    const fd = new FormData(form);
    const verdict = fd.get("verdict") as PostLabelBody["verdict"];
    const labelerVal = String(fd.get("labeler") ?? "");
    if (!labelerVal) return;
    localStorage.setItem("reviewLabeler", labelerVal);
    const intents = (fd.getAll("intent") as string[]).filter(Boolean);
    const submitBody: PostLabelBody = {
      incidentId: c.id, labeler: labelerVal, verdict,
      labelerConfidence: Number(fd.get("confidence")),
      notes: String(fd.get("notes") ?? ""),
    };
    if (verdict === "threat" || verdict === "suspicious") submitBody.intentCategories = intents;
    const res = await postLabel(submitBody);
    if ("error" in res) { alert(`save failed: ${res.error}`); return; }
    await renderQueue();
    const { candidates } = await fetchLabelQueue(c.source, 1);
    if (candidates[0]) selectReviewIncident(candidates[0]);
    else {
      document.getElementById("dossier")!.hidden = true;
      (map.getSource("review-track") as GeoJSONSource).setData(EMPTY);
      (map.getSource("review-events") as GeoJSONSource).setData(EMPTY);
    }
  });
}
```

Then call `renderForm(c)` at the end of `renderReplay`.

- [ ] **Step 3: Sanity build**

Run: `npm run build:web`
Expected: PASS.

- [ ] **Step 4: Manual smoke — end-to-end**

`npm run dev` → open `http://localhost:8787/#mode=review` in a browser.
Expected: (a) left panel shows queue with per-source headers; (b) selecting an incident zooms the map and populates the right form; (c) submitting a benign verdict advances to the next incident and marks the row as labeled on refresh.

- [ ] **Step 5: Commit**

```bash
git add web/src/review.ts web/src/api.ts
git commit -m "feat: Review-mode label form + submit + auto-advance (spec §3c)"
```

---

### Task 17: Documentation — `docs/roadmap.md` + README

**Files:**
- Modify: `docs/roadmap.md`
- Modify: `README.md`

- [ ] **Step 1: Append to `docs/roadmap.md`**

```markdown
## Threat model finer-granularity — Phase 0 shipped (2026-07-18)

Labeling harness live: `candidate_incidents` + `labels` tables, `scripts/materialize-candidates.ts`
generating candidates from four sources, `GET/POST /api/labels/*`, and `#mode=review` UI.
`militia_presence` category retired. See
[Phase 0 plan](superpowers/plans/2026-07-18-threat-model-phase-0-labeling-harness.md)
and [spec §3](superpowers/specs/2026-07-18-threat-model-finer-granularity-design.md#3-phase-0---labeling-harness).

Next: accumulate ≥ 200 labeled incidents (≥ 40 threat, ≥ 100 benign) before starting Phase 1.
```

- [ ] **Step 2: Append to `README.md`**

```markdown
## Labeling (Phase 0 harness)

Generate candidate incidents from the last 30 days:

```
npm run dev &      # start the worker
npm run materialize -- --source=all --lookback-days=30 --origin=http://127.0.0.1:8787
```

Open `http://localhost:8787/#mode=review` to label. Progress and imbalance are shown at the top of
the queue. Target: ≥ 200 labels (≥ 40 threat, ≥ 100 benign) before Phase 1 model fitting.
```

- [ ] **Step 3: Full test run + commit**

Run: `npm test`
Expected: PASS.

```bash
git add docs/roadmap.md README.md
git commit -m "docs: Phase 0 labeling harness shipped (spec §3)"
```

---

## Self-review

- Every step has actual code, exact commands, and expected results.
- No `TBD` / `TODO` / "similar to Task N" placeholders.
- Types introduced in Task 3 (`CandidateIncident`, `IncidentLabel`, `LabelSource`, `LabelVerdict`) are the same ones referenced in Tasks 4–16.
- The four materialize source functions in `scripts/materialize/*` all share the `{ origin, now, lookbackMs } → CandidateIncident[]` signature declared in Task 8.
- The Worker `POST /api/labels/materialize` (Task 9) is the shared insertion point every source uses.
- `web/src/review.ts` grows across Tasks 13–16; each task ends with a working build.
- Spec coverage:
  - §3a schemas → Task 2
  - §3b materializer + four sources → Tasks 8–12
  - §3c UI → Tasks 13–16
  - §3d guardrails → Task 5 (imbalance metric); "no auto-labels" is a plan constraint enforced by the absence of any auto-label code
  - §3e retire militia → Task 1
- Not covered here (deferred to Phase 1 plan): mechanism sub-models, weighted-sum + Platt fuser, state-band lifecycle, feature-flag cutover.
