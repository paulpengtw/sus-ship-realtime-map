# Issue #7 — Detect UNIQUE constraint violations by SELECT probe, not regex

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove the fragile `String(err).match(/UNIQUE/i)` check in `POST /api/labels` and replace it with a pre-insert `SELECT` on `(incident_id, labeler)`. A D1/Miniflare error-shape change can no longer misclassify a real error as a duplicate, or vice-versa.

**Architecture:** Race-tolerable pattern — SELECT first, INSERT if absent. If the INSERT still trips a UNIQUE (two concurrent labelers of the same incident won a race), keep a minimal try/catch that returns 409 (defense-in-depth), but no longer as the primary detection. The existing 200/201 success path (see #6) is untouched.

**Tech Stack:** TypeScript, Cloudflare Workers, D1, Vitest, Miniflare.

## Global Constraints

- No behaviour change on success or on the 400/404 validation branches.
- The 409 body stays `{ "error": "already labeled" }`.
- Concurrency race between the SELECT and the INSERT is acceptable — the retained try/catch handles it. Do NOT introduce a real transaction (D1 does not support them here in the way we'd need).

---

### Task 1: Regression test for duplicate → 409

**Files:**
- Test: `test/api-labels-post.test.ts`

**Interfaces:**
- Produces: one new `it("...")` that seeds a candidate, POSTs a label twice with the same `(incidentId, labeler)`, and asserts the second POST returns 409 with `{ error: "already labeled" }`.

- [ ] **Step 1: Add the test using the file's existing helpers**

Mirror the file's existing style — do not invent helpers. The test's shape:

1. `env = freshEnv()`; seed a candidate; POST a label (verdict "benign", labeler "alice") → expect 200/201.
2. POST the SAME body a second time → `expect(res.status).toBe(409); expect(body.error).toBe("already labeled");`.

- [ ] **Step 2: Run — the test should PASS on current code** (the regex still catches it).

Run: `npx vitest run test/api-labels-post.test.ts -t "already labeled"`
Expected: PASS. This test locks in the current behaviour before we refactor.

### Task 2: Replace regex with SELECT probe

**Files:**
- Modify: `src/worker.ts:260-277` — the `POST /api/labels` handler's insert block

**Interfaces:**
- Consumes: `env.DB`, existing `incidentId` / `labeler` validated at top of handler.
- Produces: 409 emitted BEFORE the INSERT if a `(incident_id, labeler)` row already exists; a defense-in-depth try/catch still catches races.

- [ ] **Step 1: Add the pre-insert SELECT immediately after the existing "unknown incidentId" 404 check**

Between the `existsRow` 404 return and the `try {` insert block, add:

```ts
const dup = await env.DB.prepare(
  `SELECT id FROM labels WHERE incident_id = ?1 AND labeler = ?2`,
).bind(incidentId, labeler).first<{ id: number }>();
if (dup) return json({ error: "already labeled" }, 409);
```

- [ ] **Step 2: Simplify the catch to a plain 409 on any UNIQUE-shaped miss, and rethrow otherwise**

Keep the try/catch as defense-in-depth. Leave the existing regex path in place — it's now a rarely-triggered race fallback, not the primary detection. If desired, keep exactly the current three-line catch untouched:

```ts
} catch (err) {
  if (String(err).match(/UNIQUE/i)) return json({ error: "already labeled" }, 409);
  throw err;
}
```

- [ ] **Step 3: Run the duplicate test from Task 1 — expect PASS**

Run: `npx vitest run test/api-labels-post.test.ts -t "already labeled"`
Expected: PASS.

- [ ] **Step 4: Run the whole file — no regressions**

Run: `npx vitest run test/api-labels-post.test.ts`
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add src/worker.ts test/api-labels-post.test.ts
git commit -m "fix(api): detect duplicate labels via SELECT probe (fixes #7)"
```
