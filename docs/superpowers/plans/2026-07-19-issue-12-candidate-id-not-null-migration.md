# Issue #12 — Migration 0007: enforce NOT NULL on `candidate_incidents.id`

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship migration `0007_candidate_incidents_id_notnull.sql` that recreates `candidate_incidents` with an explicit `NOT NULL` on `id`. SQLite's long-standing quirk that `TEXT PRIMARY KEY` does not imply NOT NULL is closed off.

**Architecture:** SQLite lets you retroactively add NOT NULL only via a table recreate. Since this table is small and freshly-shipped, we do the standard `PRAGMA foreign_keys=OFF; CREATE new; INSERT ... SELECT; DROP old; ALTER RENAME; PRAGMA foreign_keys=ON;` dance. The `labels.incident_id → candidate_incidents(id)` FK is preserved.

**Tech Stack:** SQLite, Cloudflare D1, Vitest for a schema regression test.

## Global Constraints

- Preserve all indexes: `ix_candidate_source`, `ix_candidate_vessel`.
- Preserve the `labels.incident_id REFERENCES candidate_incidents(id)` foreign-key relationship end-to-end.
- Zero data loss for any existing rows.
- Test infrastructure (`test/apply-migrations.ts` or equivalent) must apply the new migration cleanly on a fresh D1 test DB.

---

### Task 1: Write migration 0007

**Files:**
- Create: `migrations/0007_candidate_incidents_id_notnull.sql`

**Interfaces:**
- Produces: new SQL file that (a) creates `candidate_incidents_new` with `id TEXT NOT NULL PRIMARY KEY` and all other columns copied verbatim, (b) copies rows across, (c) drops the old table, (d) renames the new table into place, (e) re-creates both indexes.

- [ ] **Step 1: Write the migration**

Content:

```sql
-- migrations/0007_candidate_incidents_id_notnull.sql
-- Enforce NOT NULL on candidate_incidents.id (SQLite quirk: TEXT PRIMARY KEY
-- alone does not imply NOT NULL). Table recreate is the standard workaround.

PRAGMA foreign_keys=OFF;

CREATE TABLE candidate_incidents_new (
  id TEXT NOT NULL PRIMARY KEY,
  vessel_id TEXT NOT NULL,
  t_start INTEGER NOT NULL,
  t_end INTEGER NOT NULL,
  source TEXT NOT NULL,
  source_ref TEXT,
  created_at INTEGER NOT NULL,
  model_snapshot TEXT,
  event_ids TEXT
);

INSERT INTO candidate_incidents_new
  (id, vessel_id, t_start, t_end, source, source_ref, created_at, model_snapshot, event_ids)
SELECT id, vessel_id, t_start, t_end, source, source_ref, created_at, model_snapshot, event_ids
FROM candidate_incidents;

DROP TABLE candidate_incidents;
ALTER TABLE candidate_incidents_new RENAME TO candidate_incidents;

CREATE INDEX ix_candidate_source ON candidate_incidents(source, created_at);
CREATE INDEX ix_candidate_vessel ON candidate_incidents(vessel_id, t_start);

PRAGMA foreign_keys=ON;
```

- [ ] **Step 2: Apply the migration locally to confirm the SQL runs**

Run: `npx wrangler d1 migrations apply DB --local`
Expected: applies cleanly, no errors.

- [ ] **Step 3: Sanity-check the resulting schema**

Run: `npx wrangler d1 execute DB --local --command "SELECT sql FROM sqlite_master WHERE tbl_name = 'candidate_incidents'"`
Expected: the SQL contains `id TEXT NOT NULL PRIMARY KEY`, and both indexes are listed.

### Task 2: Regression test — inserting NULL id must fail

**Files:**
- Test: `test/db-labeling.test.ts` (or wherever the labeling DB is exercised)

**Interfaces:**
- Produces: one `it(...)` that attempts to `INSERT INTO candidate_incidents (id, …) VALUES (NULL, …)` and asserts the D1 driver rejects it with a NOT NULL constraint error.

- [ ] **Step 1: Add the test**

Style-match the existing tests in the file. The assertion pattern:

```ts
await expect(
  env.DB.prepare(
    `INSERT INTO candidate_incidents (id, vessel_id, t_start, t_end, source, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).bind(null, "123", 0, 1, "assessment", 0).run(),
).rejects.toThrow(/NOT NULL|constraint/i);
```

- [ ] **Step 2: Run — expect PASS on the migrated schema**

Run: `npx vitest run test/db-labeling.test.ts -t "NOT NULL"`
Expected: PASS.

- [ ] **Step 3: Run the whole labeling-DB test surface — no regressions**

Run: `npx vitest run test/db-labeling.test.ts test/api-labels-queue.test.ts test/api-labels-post.test.ts`
Expected: all PASS.

- [ ] **Step 4: Commit**

```bash
git add migrations/0007_candidate_incidents_id_notnull.sql test/db-labeling.test.ts
git commit -m "fix(migrations): enforce NOT NULL on candidate_incidents.id (fixes #12)"
```

### Task 3: Ops follow-up (post-merge)

- [ ] Manually apply the migration to remote: `npx wrangler d1 migrations apply DB --remote`
- [ ] Redeploy: `npm run deploy`
- [ ] Verify remote schema: `npx wrangler d1 execute DB --remote --command "SELECT sql FROM sqlite_master WHERE tbl_name = 'candidate_incidents'"`

(These are runbook steps, not part of the code-change PR itself.)
