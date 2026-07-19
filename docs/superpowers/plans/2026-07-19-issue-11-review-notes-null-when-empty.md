# Issue #11 — Review label form: send null (not empty string) when notes textarea is empty

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When the review-mode label form's notes textarea is blank (or whitespace-only), the POST body omits the `notes` field instead of sending `""`. Server-side, the existing `typeof notes === "string" ? notes : null` branch stores `null`, so an omitted field lands as `null` — cleanly distinguishing "labeler intentionally left blank" from "labeler wrote empty string".

**Architecture:** Two-line change in `web/src/review.ts`'s form submit handler. Server unchanged.

**Tech Stack:** TypeScript (browser), Vitest for DOM-level tests if any exist; otherwise commit as a pure UI polish with manual verification.

## Global Constraints

- Do not touch server-side `POST /api/labels` handler behaviour.
- Do not touch other form fields (labeler, verdict, intent, confidence).
- `PostLabelBody.notes` in `web/src/api.ts` must accept an optional/undefined value; verify before editing.

---

### Task 1: Trim + omit notes when empty

**Files:**
- Modify: `web/src/review.ts:105-109` (the `submitBody` construction inside the submit handler)
- Verify: `web/src/api.ts` — the `PostLabelBody` type must permit `notes?: string`. If it currently requires `string`, relax it in the same commit.

**Interfaces:**
- Consumes: `PostLabelBody` from `web/src/api.ts`, `postLabel(body): Promise<...>`.
- Produces: `submitBody` where `notes` is either a non-empty trimmed string OR the property is absent entirely.

- [ ] **Step 1: Read `web/src/api.ts` and confirm/relax the `PostLabelBody.notes` type**

If the current type is:
```ts
export interface PostLabelBody { …; notes: string; }
```
change it to:
```ts
export interface PostLabelBody { …; notes?: string; }
```
If it is already `notes?: string;`, leave it alone.

- [ ] **Step 2: Update the submit-body construction in `web/src/review.ts`**

Find the block around line 105:

```ts
const submitBody: PostLabelBody = {
  incidentId: c.id, labeler: labelerVal, verdict,
  labelerConfidence: Number(fd.get("confidence")),
  notes: String(fd.get("notes") ?? ""),
};
```

Replace with:

```ts
const notes = String(fd.get("notes") ?? "").trim();
const submitBody: PostLabelBody = {
  incidentId: c.id, labeler: labelerVal, verdict,
  labelerConfidence: Number(fd.get("confidence")),
};
if (notes.length > 0) submitBody.notes = notes;
```

- [ ] **Step 3: Typecheck**

Run: `npx tsc -p . --noEmit`
Expected: PASS.

- [ ] **Step 4: Run any test that touches review-form submission**

Run: `npx vitest run -t "review\|label form\|notes"`
Expected: PASS (or "no tests found" — this file has no unit test today; that's acceptable).

- [ ] **Step 5: Manual verification**

Start the dev server (`npm run dev`), enter review mode, submit a label with:
- (a) an empty notes textarea → the POST body in DevTools Network tab should have no `notes` key
- (b) a whitespace-only notes textarea → same as (a)
- (c) a non-empty notes value → `notes` present with the trimmed string

Confirm the D1 row (via `wrangler d1 execute DB --local --command "SELECT notes FROM labels ORDER BY id DESC LIMIT 3"`) shows `NULL`, `NULL`, and the string, respectively.

- [ ] **Step 6: Commit**

```bash
git add web/src/review.ts web/src/api.ts
git commit -m "fix(review): send null notes when textarea is empty (fixes #11)"
```
