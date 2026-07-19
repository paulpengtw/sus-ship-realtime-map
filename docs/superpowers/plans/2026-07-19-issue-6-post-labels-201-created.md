# Issue #6 — POST /api/labels returns 201 Created

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `POST /api/labels` returns HTTP 201 Created on successful label insert, matching REST conventions for resource-creating endpoints.

**Architecture:** One-line status-code change in the existing handler in `src/worker.ts`. Add a regression test that pins the response code so future edits can't silently drop back to 200.

**Tech Stack:** TypeScript, Cloudflare Workers, D1, Vitest, Miniflare.

## Global Constraints

- No public API-shape change beyond the status code. Response body stays `{ ok: true, id: <number> }`.
- The 409 duplicate branch and 400/404 validation branches keep their existing codes.
- The current test `test/api-labels-post.test.ts` must continue to pass.

---

### Task 1: Bump success status to 201 and pin it in tests

**Files:**
- Modify: `src/worker.ts:272`
- Test: `test/api-labels-post.test.ts`

**Interfaces:**
- Consumes: existing `POST /api/labels` handler whose success line currently reads `return json({ ok: true, id: result.meta.last_row_id }, 200);`.
- Produces: same handler returning `201` for the create-success path.

- [ ] **Step 1: Add a failing regression test that asserts the status code**

Open `test/api-labels-post.test.ts` and find the happy-path test that already POSTs a valid label and asserts `res.status`. Add a new `it(...)` next to it using the exact same setup helpers that file already uses (do not invent helper names). The new test's only new assertion vs. the happy path is `expect(res.status).toBe(201)`.

- [ ] **Step 2: Run the new test — expect it to FAIL with `Expected 201, received 200`**

Run: `npx vitest run test/api-labels-post.test.ts -t "201"`
Expected: FAIL.

- [ ] **Step 3: Change the status code in `src/worker.ts` line 272**

```ts
return json({ ok: true, id: result.meta.last_row_id }, 201);
```

(The literal `200` is the only change.)

- [ ] **Step 4: Re-run the new test — expect PASS**

Run: `npx vitest run test/api-labels-post.test.ts -t "201"`
Expected: PASS.

- [ ] **Step 5: Run the whole file to confirm nothing else broke**

Run: `npx vitest run test/api-labels-post.test.ts`
Expected: all tests PASS.

- [ ] **Step 6: Commit**

```bash
git add src/worker.ts test/api-labels-post.test.ts
git commit -m "feat(api): POST /api/labels returns 201 Created (fixes #6)"
```
