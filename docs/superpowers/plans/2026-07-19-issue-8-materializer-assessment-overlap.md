# Issue #8 — Materializer misses assessments opened before lookback but still ongoing

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Event-cluster and random-negative materializer routes include every assessment whose interval `[opened_ts, coalesce(closed_ts, until)]` overlaps the requested `[since, until]` window — not just those whose `opened_ts` is inside the window. Long-running open assessments will now correctly appear in `skipWindows` / `assessmentWindows` and their overlapping candidates will be suppressed.

**Architecture:** Change two SQL statements in `src/worker.ts` from `WHERE opened_ts BETWEEN ?1 AND ?2` to a canonical interval-overlap predicate. Add unit-level tests hitting both routes with a synthetic long-open assessment that straddles the range.

**Tech Stack:** TypeScript, Cloudflare Workers, D1 SQL, Vitest.

## Global Constraints

- No API shape change — the JSON response keys (`assessmentWindows`, `skipWindows`) and element shapes are unchanged.
- Do not change the `assessments` SQL used by `/api/labels/materialize/assessments` (that route legitimately filters by open-ts; only the two "windows" queries are wrong).
- No migration required.

---

### Task 1: Regression tests for the two routes

**Files:**
- Test: `test/api-labels-queue.test.ts` (or `test/materialize-server.test.ts`, whichever the codebase already uses to exercise `/api/labels/materialize/*`). If neither, add a new `test/api-materialize-overlap.test.ts` mirroring the style of `test/api-labels-queue.test.ts`.

**Interfaces:**
- Produces: two `it(...)` cases:
  1. `/api/labels/materialize/event-clusters` returns an `assessmentWindows` entry for an assessment opened before `since` and still open at `until`.
  2. `/api/labels/materialize/random-negatives` returns a `skipWindows` entry for the same assessment.

- [ ] **Step 1: Add the tests**

For each test:
1. Seed the D1 `assessments` table with one row: `opened_ts = SINCE - 5 days`, `closed_ts = NULL`, `mmsi = 111`, `category = "cable_interference"`, `confidence = 0.5`, `region = "test"`.
2. Fetch the route with `?since=SINCE&until=UNTIL` where `SINCE = day0`, `UNTIL = day0 + 30d`.
3. Assert the response's `assessmentWindows` / `skipWindows` array contains a window with `tStart = SINCE - 5d` (or the row's `opened_ts`).

- [ ] **Step 2: Run — expect FAIL** (current SQL filters by `opened_ts BETWEEN`, so the row is dropped)

Run: `npx vitest run -t "long-open assessment"`
Expected: FAIL — the assertions find an empty windows array.

### Task 2: Fix the two SQL statements

**Files:**
- Modify: `src/worker.ts:296` — inside `/api/labels/materialize/event-clusters`
- Modify: `src/worker.ts:316` — inside `/api/labels/materialize/random-negatives`

**Interfaces:**
- Same route surface; the inner assessments subquery now covers overlap, not point-in-range.

- [ ] **Step 1: Rewrite the event-clusters assessment subquery**

Change:
```ts
env.DB.prepare(`SELECT opened_ts, closed_ts FROM assessments WHERE opened_ts BETWEEN ?1 AND ?2`).bind(since, until),
```
to:
```ts
env.DB.prepare(
  `SELECT opened_ts, closed_ts FROM assessments
   WHERE opened_ts <= ?2 AND COALESCE(closed_ts, ?2) >= ?1`,
).bind(since, until),
```

- [ ] **Step 2: Rewrite the random-negatives assessment subquery** — same change, same file, ~20 lines below.

- [ ] **Step 3: Run the new tests — expect PASS**

Run: `npx vitest run -t "long-open assessment"`
Expected: PASS.

- [ ] **Step 4: Run the whole materializer/routes test surface — no regressions**

Run: `npx vitest run test/api-labels-queue.test.ts test/api-labels-post.test.ts test/materialize-server.test.ts test/materializer.test.ts`
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add src/worker.ts test/
git commit -m "fix(materialize): include ongoing assessments in skipWindows (fixes #8)"
```
