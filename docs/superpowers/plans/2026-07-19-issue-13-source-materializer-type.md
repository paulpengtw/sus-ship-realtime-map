# Issue #13 — Reconcile `SourceMaterializer` type between plan doc and code

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Resolve the doc/code drift where `docs/superpowers/plans/2026-07-18-threat-model-phase-0-labeling-harness.md` (Task 8) declares a `SourceMaterializer` type alias that never appears in the shipped code.

**Architecture:** Introduce the alias in `src/labeling.ts` (the "labeling harness types" module) and re-type each CLI materializer's exported function to use it. Alternative — a doc-only edit — is documented but the code-side fix is preferred because the alias is genuinely useful (four call sites, identical signature).

**Tech Stack:** TypeScript.

## Global Constraints

- No behaviour change. This is a type-alias rename touching four exported function signatures.
- All existing tests (`test/materializer.test.ts`, `test/materialize-server.test.ts`) must continue to pass.
- The alias lives with the other labeling-harness types (do not put it in `scripts/materialize/`).

---

### Task 1: Declare `SourceMaterializer` in `src/labeling.ts`

**Files:**
- Modify: `src/labeling.ts` (append near the other exported types, e.g. after `IncidentLabel`)

**Interfaces:**
- Produces: `export type SourceMaterializer = (deps: { origin: string; now: number; lookbackMs: number }) => Promise<CandidateIncident[]>;`

- [ ] **Step 1: Append the type to `src/labeling.ts`**

Add after the `IncidentLabel` interface (around line 31):

```ts
export type SourceMaterializer = (deps: {
  origin: string;
  now: number;
  lookbackMs: number;
}) => Promise<CandidateIncident[]>;
```

- [ ] **Step 2: Typecheck**

Run: `npx tsc -p . --noEmit`
Expected: PASS (no existing consumer, so nothing breaks).

- [ ] **Step 3: Commit (partial — no callers yet)**

```bash
git add src/labeling.ts
git commit -m "feat(labeling): export SourceMaterializer type alias (refs #13)"
```

### Task 2: Rewire the four CLI materializers to use `SourceMaterializer`

**Files:**
- Modify: `scripts/materialize/assessment.ts`
- Modify: `scripts/materialize/event-cluster.ts`
- Modify: `scripts/materialize/random-negative.ts`
- Modify: `scripts/materialize/curated-positive.ts`

**Interfaces:**
- Consumes: `SourceMaterializer` from `../../src/labeling`.
- Produces: same four exported functions (`materializeAssessments`, `materializeEventClusters`, `materializeRandomNegatives`, `materializeCuratedPositives`) but with the new type alias in their signatures.

- [ ] **Step 1: `scripts/materialize/assessment.ts`**

Replace the import + signature. The relevant lines currently read:

```ts
import { candidatesFromAssessments } from "../../src/materialize-server";
import type { CandidateIncident } from "../../src/labeling";
…
export async function materializeAssessments(deps: { origin: string; now: number; lookbackMs: number }): Promise<CandidateIncident[]> {
```

Change to:

```ts
import { candidatesFromAssessments } from "../../src/materialize-server";
import type { SourceMaterializer } from "../../src/labeling";
…
export const materializeAssessments: SourceMaterializer = async (deps) => {
```

Close the arrow-function body with `};` at the file's end (was `}`).

- [ ] **Step 2: Repeat for `event-cluster.ts`, `random-negative.ts`, `curated-positive.ts`**

Exactly the same pattern: swap the `CandidateIncident` type-only import for `SourceMaterializer`, and turn `export async function name(deps: {…}): Promise<CandidateIncident[]> {` into `export const name: SourceMaterializer = async (deps) => {`.

- [ ] **Step 3: Typecheck**

Run: `npx tsc -p . --noEmit`
Expected: PASS.

- [ ] **Step 4: Run the materializer tests**

Run: `npx vitest run test/materializer.test.ts test/materialize-server.test.ts`
Expected: all tests PASS.

- [ ] **Step 5: Commit**

```bash
git add scripts/materialize/
git commit -m "refactor(materialize): use SourceMaterializer type alias (fixes #13)"
```

### Task 3 (fallback, only if Task 1+2 are rejected): doc-only edit

Remove the `SourceMaterializer` line from `docs/superpowers/plans/2026-07-18-threat-model-phase-0-labeling-harness.md`, Task 8 Interfaces block. Only pursue this if the code-side change is vetoed.
