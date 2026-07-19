# Issue #10 — Review mode: cache queue candidates in memory (kill 4 refetches per click)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Clicking a review-mode queue row no longer triggers four HTTP round-trips to `/api/labels/queue`. Instead, the queue-render step populates an in-memory `Map<string, ApiCandidate>`, and `lookupById` reads from that map. Perceived latency on every row click drops from ~4 round-trips to zero.

**Architecture:** One-file refactor in `web/src/review.ts`. Introduce a module-scope `Map` keyed by candidate id, repopulated on every `renderQueue()` call. Drop the loop in `lookupById`.

**Tech Stack:** TypeScript (browser), Vitest for any DOM-level review tests.

## Global Constraints

- No visible UI change.
- No new `data-*` attributes required on `<li>` rows.
- The public `initReviewMode`, `selectReviewIncident`, `getSelectedReview` exports are unchanged.

---

### Task 1: In-memory queue cache

**Files:**
- Modify: `web/src/review.ts` (add module-scope `let queueCache`, populate in `renderQueue`, read in `lookupById`).

**Interfaces:**
- Consumes: `ApiCandidate` from `web/src/api.ts`.
- Produces: `lookupById(id: string): ApiCandidate | null` (now synchronous, but keep the async signature to avoid touching call sites).

- [ ] **Step 1: Add the module-scope cache near the top of `web/src/review.ts`**

Just below `let selected: ApiCandidate | null = null;`:

```ts
let queueCache: Map<string, ApiCandidate> = new Map();
```

- [ ] **Step 2: Populate the cache inside `renderQueue`, right after the `perSource` fetches complete**

Immediately after this line in `renderQueue`:
```ts
const [stats, perSource] = await Promise.all([…]);
```
insert:
```ts
queueCache = new Map(perSource.flatMap((x) => x.candidates).map((c) => [c.id, c]));
```

- [ ] **Step 3: Replace the body of `lookupById`**

Replace the whole function:
```ts
async function lookupById(id: string): Promise<ApiCandidate | null> {
  return queueCache.get(id) ?? null;
}
```

- [ ] **Step 4: Typecheck**

Run: `npx tsc -p . --noEmit`
Expected: PASS.

- [ ] **Step 5: Run any relevant tests**

Run: `npx vitest run -t "review\|queue"`
Expected: PASS (or "no tests found" — this UI has no unit test today).

- [ ] **Step 6: Manual verification**

Run `npm run dev`, open review mode with DevTools Network tab filtered to `/api/labels/queue`. Click a row: expect ZERO new requests to `/api/labels/queue` (the queue is already loaded). Confirm the same row's dossier renders (the click still triggers `fetchVesselTrackRange` and `fetchVessel`, which is fine).

- [ ] **Step 7: Commit**

```bash
git add web/src/review.ts
git commit -m "perf(review): cache queue candidates in memory (fixes #10)"
```
