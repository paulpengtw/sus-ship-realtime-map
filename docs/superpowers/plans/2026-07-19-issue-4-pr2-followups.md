# Issue #4 — PR #2 follow-ups (8 non-blocking items from final review)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Land each of the 8 follow-up items identified in the PR #2 final review. All are non-blocking — each can ship independently.

**Architecture:** Eight small, mostly-independent tasks split by concern:
- 3 correctness/robustness items in `src/aisstream.ts`, `src/fusion.ts`, and the assessments schema.
- 2 test coverage items in `test/route.test.ts` and the vessel dossier tests.
- 3 code-health items across the frontend palette, `tsconfig.json`, and `VesselState.leftCoverage`.

Each task ends in its own commit — reviewers can accept/reject items individually.

**Tech Stack:** TypeScript, Cloudflare Workers, Vitest, SQLite (D1), MapLibre-GL.

## Global Constraints

- Every task starts with a failing test (TDD) unless explicitly noted (e.g. type-only refactors).
- Every task commits in isolation — no bundled commits.
- Behaviour change to existing consumers is out of scope; only the identified narrow fixes.
- Do NOT touch the DO's snapshot format — the `peakConfidence` column change (Task 3) is opportunistic and only added if the same PR is already migrating the assessments schema. If it stands alone, defer.

---

### Task 1: `parseAisStreamMessage` — treat JSON `null` NavigationalStatus as null

**Files:**
- Modify: `src/aisstream.ts:26` (the `const ns = Number(pr.NavigationalStatus);` line)
- Test: `test/aisstream.test.ts` (mirror an existing `parseFrame` positional test)

**Interfaces:**
- Consumes: `parseAisStreamMessage(raw: unknown)`.
- Produces: same signature; `navStatus` field is `null` when input `NavigationalStatus` is `null` (not `0`).

- [ ] **Step 1: Add a failing test**

```ts
it("parseAisStreamMessage: null NavigationalStatus → navStatus is null (not 0)", () => {
  const raw = {
    MessageType: "PositionReport",
    MetaData: { MMSI: 123, latitude: 0, longitude: 0, time_utc: "2026-07-04 12:00:00 +0000 UTC" },
    Message: { PositionReport: { Sog: 0, Cog: 0, TrueHeading: 511, NavigationalStatus: null } },
  };
  const out = parseAisStreamMessage(raw);
  expect(out?.pos?.navStatus).toBeNull();
});
```

- [ ] **Step 2: Run — expect FAIL** (`Number(null) === 0` → assertion fails, receives 0)

Run: `npx vitest run test/aisstream.test.ts -t "null NavigationalStatus"`
Expected: FAIL.

- [ ] **Step 3: Guard before coercion**

Change `src/aisstream.ts:26` from:
```ts
const ns = Number(pr.NavigationalStatus);
```
to:
```ts
const ns = pr.NavigationalStatus == null ? NaN : Number(pr.NavigationalStatus);
```
(The existing predicate `Number.isInteger(ns) && ns >= 0 && ns <= 15` on line 33 already discards `NaN`, so `null`/`undefined` now cleanly land as `navStatus: null`.)

- [ ] **Step 4: Run — expect PASS**

Run: `npx vitest run test/aisstream.test.ts -t "null NavigationalStatus"`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/aisstream.ts test/aisstream.test.ts
git commit -m "fix(aisstream): null NavigationalStatus is unknown, not 0 (refs #4)"
```

### Task 2: `clauseFor` — identity_change picks the changed field

**Files:**
- Modify: `src/fusion.ts:39` (the identity_change narrative branch)
- Test: `test/fusion.test.ts` (or `fusion-lifecycle.test.ts`, whichever tests `clauseFor` behaviour)

**Interfaces:**
- Consumes: `AnomalyEvent` with `evidence.kind === "identity_change"` and any of `prevName/newName/prevCallsign/newCallsign`.
- Produces: narrative reads `identity changed (<prev> → <new>)` where the pair is picked from the field that actually changed.

- [ ] **Step 1: Add failing tests**

```ts
it("clauseFor identity_change: prefers the name pair when name changed", () => {
  const ev = { type: "identity", evidence: { kind: "identity_change", prevName: "A", newName: "B", prevCallsign: "X", newCallsign: "X" } } as any;
  expect(clauseFor(ev)).toBe("identity changed (A → B)");
});

it("clauseFor identity_change: falls back to callsign when only callsign changed", () => {
  const ev = { type: "identity", evidence: { kind: "identity_change", prevName: "SHUNXIN 39", newName: "SHUNXIN 39", prevCallsign: "X1", newCallsign: "X2" } } as any;
  expect(clauseFor(ev)).toBe("identity changed (X1 → X2)");
});
```

(`clauseFor` is currently private — export it from `src/fusion.ts` if not already, or test via a public path that exposes the narrative.)

- [ ] **Step 2: Run — the callsign-only test should FAIL** (current code renders `"SHUNXIN 39 → SHUNXIN 39"`).

Run: `npx vitest run test/fusion.test.ts -t "identity_change"`
Expected: at least one FAIL.

- [ ] **Step 3: Fix the branch in `src/fusion.ts:39`**

Replace:
```ts
return `identity changed (${String(e.prevName ?? e.prevCallsign)} → ${String(e.newName ?? e.newCallsign)})`;
```
with:
```ts
const nameChanged = e.prevName != null && e.newName != null && e.prevName !== e.newName;
const [prev, next] = nameChanged
  ? [e.prevName, e.newName]
  : [e.prevCallsign ?? e.prevName, e.newCallsign ?? e.newName];
return `identity changed (${String(prev)} → ${String(next)})`;
```

- [ ] **Step 4: Run — expect PASS**

Run: `npx vitest run test/fusion.test.ts -t "identity_change"`
Expected: both tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/fusion.ts test/fusion.test.ts
git commit -m "fix(fusion): identity_change clause picks the changed field (refs #4)"
```

### Task 3 (opportunistic): `assessments.peak_confidence` column

**Files:**
- Create: `migrations/0008_assessments_peak_confidence.sql` (only if the schema is being touched this cycle)
- Modify: `src/do/tracker.ts` (or wherever assessments are written) to also update `peak_confidence = MAX(peak_confidence, current)`
- Modify: `src/db.ts` (or wherever the row → object mapping lives) to expose `peakConfidence`
- Test: `test/db-assessments.test.ts` — add a case that opens an assessment at 0.8, decays to 0.1, closes, and asserts the persisted `peak_confidence` is 0.8.

**Interfaces:**
- Produces: assessments now carry `peakConfidence: number` alongside their (post-decay) `confidence`.

- [ ] **Step 1: Skip unless the schema is being migrated for another reason this cycle.** Otherwise:

```sql
-- migrations/0008_assessments_peak_confidence.sql
ALTER TABLE assessments ADD COLUMN peak_confidence REAL;
UPDATE assessments SET peak_confidence = confidence WHERE peak_confidence IS NULL;
```

- [ ] **Step 2: In the DO write path, update peak on every confidence bump:**

```ts
peak_confidence = Math.max(prev.peak_confidence ?? 0, next.confidence)
```

- [ ] **Step 3: Add the test that opens → decays → closes and asserts `peakConfidence` survives.**

- [ ] **Step 4: Commit as a standalone PR.**

### Task 4: `test/route.test.ts` — rewrite the shadowed circling test

**Files:**
- Modify: `test/route.test.ts:84-91` (the "stationary vessel with low displacement" test)

**Interfaces:**
- Produces: a test at `sog >= 2` kn (above `minSogForCogKn` gate) that genuinely exercises the circling distance/ratio codepath.

- [ ] **Step 1: Read the current fixture and the `minSogForCogKn` config value.** Confirm the current test's `sog 0.1` is below the gate.

- [ ] **Step 2: Rewrite the fixture: same circling geometry but with `sog >= 2` kn, so COG-based logic is engaged and the circling gate is the real reason the assertion holds.**

- [ ] **Step 3: Run — expect PASS.**

Run: `npx vitest run test/route.test.ts -t "stationary"` (or rename the test — "low displacement above sog gate does NOT fire circling")

- [ ] **Step 4: Commit.**

```bash
git add test/route.test.ts
git commit -m "test(route): unshadow circling low-displacement test (refs #4)"
```

### Task 5: dossier tests — assert `assessments` array shape + order

**Files:**
- Test: `test/api-assessments.test.ts` (or `test/web-dossier.test.ts` — pick the file where the vessel dossier endpoint is tested).

**Interfaces:**
- Produces: one `it(...)` that hits `/api/vessel/:mmsi` and asserts (a) `.assessments` is an array, (b) elements have `{ id, category, confidence, openedTs, closedTs, narrative }`, and (c) ordering is `openedTs DESC`.

- [ ] **Step 1: Seed two assessments for the same MMSI with distinct `opened_ts`.**
- [ ] **Step 2: Fetch `/api/vessel/:mmsi`.**
- [ ] **Step 3: Assert shape + ordering.**
- [ ] **Step 4: Run — expect PASS.** (If it fails, that's the bug the review flagged: fix and add the missing assertions incrementally.)
- [ ] **Step 5: Commit.**

```bash
git add test/
git commit -m "test(dossier): assert assessments shape and ordering (refs #4)"
```

### Task 6: One source of truth for frontend category colors

**Files:**
- Create: `web/src/categoryColor.ts` — exports `CATEGORY_COLOR: Record<ThreatCategory, string>` and a `CAT_MATCH` MapLibre expression derived from it.
- Modify: `web/src/assess.ts` — import from the new module, drop local `CATEGORY_COLOR`.
- Modify: `web/src/timeline.ts` — import `CATEGORY_COLOR` and derive `CAT_COLOR` array from it (respecting THREAT_CATEGORIES order).
- Modify: `web/src/vessels.ts` — import `CAT_MATCH`, drop local.
- Modify: `web/src/trajectories.ts` — import `CAT_MATCH`, drop local.

**Interfaces:**
- Produces: single-source-of-truth palette. A future palette change ripples to all four consumers.

- [ ] **Step 1: Create `web/src/categoryColor.ts` with the current values verbatim** (do not change the palette in this task):

```ts
import { THREAT_CATEGORIES, type ThreatCategory } from "../../src/types";

export const CATEGORY_COLOR: Record<ThreatCategory, string> = {
  cable_interference: "#e5484d",
  dark_activity: "#b18cff",
  identity_deception: "#f0a83c",
};

export const CAT_COLOR = THREAT_CATEGORIES.map((c) => CATEGORY_COLOR[c]);

export const CAT_MATCH = ["match", ["coalesce", ["get", "topCategory"], ""],
  ...THREAT_CATEGORIES.flatMap((c) => [c, CATEGORY_COLOR[c]]),
  "#aab6c8",
] as unknown as any;
```

- [ ] **Step 2: Update each of the four call sites to import instead of redefine.** Confirm the values match verbatim.

- [ ] **Step 3: Typecheck + run any web tests.**

Run: `npx tsc -p . --noEmit && npx vitest run -t "web\|assess\|timeline\|vessels\|trajectories"`
Expected: PASS.

- [ ] **Step 4: Commit.**

```bash
git add web/src/
git commit -m "refactor(web): single source of truth for category colors (refs #4)"
```

### Task 7: Scope `"node"` types to the scripts tsconfig

**Files:**
- Modify: `tsconfig.json` — remove `"node"` from the shared `types` array. `types` becomes `["@cloudflare/workers-types/2023-07-01", "geojson"]`.
- Create: `scripts/tsconfig.json` — extends `../tsconfig.json` and adds `"types": ["node"]`.
- Modify: `scripts/replay.ts` header — no change if the new `scripts/tsconfig.json` picks it up via the shared `include`. If the root tsconfig's `include` still catches `scripts/`, tighten it to `["src", "test"]` and let `scripts/tsconfig.json` own the scripts.
- Modify: package.json / any lint script to also invoke `tsc -p scripts/tsconfig.json` where relevant.

**Interfaces:**
- Produces: Node ambient globals are only visible under `scripts/`. Worker + browser code no longer sees `process`, `fs`, etc.

- [ ] **Step 1: Rewrite the root tsconfig with `"node"` removed from `types` and `"include"` narrowed to `["src", "test"]`.**
- [ ] **Step 2: Create the scoped `scripts/tsconfig.json`:**

```json
{
  "extends": "../tsconfig.json",
  "compilerOptions": {
    "types": ["@cloudflare/workers-types/2023-07-01", "node", "geojson"]
  },
  "include": ["."]
}
```

- [ ] **Step 3: Verify `npx tsc -p . --noEmit` fails ONLY on `scripts/replay.ts` (proof the scoping worked), then verify `npx tsc -p scripts/tsconfig.json --noEmit` passes.**

Adjust the root `include` until root typecheck passes without scripts.

- [ ] **Step 4: Run `npx vitest run`.** Expected: PASS.

- [ ] **Step 5: Commit.**

```bash
git add tsconfig.json scripts/tsconfig.json
git commit -m "chore(tsconfig): scope node types to scripts/ (refs #4)"
```

### Task 8: `VesselState.leftCoverage` — consume or drop

**Files:**
- Read: `src/types.ts:74`, `src/pipeline.ts:35`, `src/detectors/gap.ts:26` — confirm write-only status.
- Modify: one of the following two ends, and delete the other:
  - **Consume:** in the identity/teleport detector, suppress teleport events when `s.leftCoverage === true` on the first message after coverage returns. Add a test in `test/identity.test.ts` or `test/coverage.test.ts` proving the suppression.
  - **Drop:** remove the field from `VesselState` (types.ts), the writer in `gap.ts`, the reset in `pipeline.ts`, and any test that asserts on it.

**Interfaces:**
- Produces: either (a) `VesselState.leftCoverage` is consumed by a real code path, OR (b) the field no longer exists.

- [ ] **Step 1: Confirm write-only status.** Run: `grep -rn "leftCoverage" src test web`. Confirm no reader outside its own writer/reset and a single test assertion (if any).

- [ ] **Step 2: Decide — consume or drop.** Default recommendation: DROP (the coverage-edge suppression already happens at the gap-detector level; leaking a flag into the identity detector duplicates policy).

- [ ] **Step 3: If dropping:**
  - Remove `leftCoverage: boolean;` from `VesselState` in `src/types.ts:74`.
  - Remove the `leftCoverage: false,` initializer in `src/types.ts:90`.
  - Remove `s.leftCoverage = true;` from `src/detectors/gap.ts:26`.
  - Remove `s.leftCoverage = false;` from `src/pipeline.ts:35`.
  - Remove or update any test that asserts on the field.

- [ ] **Step 4: Typecheck + run tests.**

Run: `npx tsc -p . --noEmit && npx vitest run`
Expected: PASS.

- [ ] **Step 5: Commit.**

```bash
git add src/ test/
git commit -m "chore(state): drop unused VesselState.leftCoverage (refs #4)"
```
