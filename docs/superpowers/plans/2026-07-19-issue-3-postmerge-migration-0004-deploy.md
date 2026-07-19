# Issue #3 — Post-merge for PR #2: apply D1 migration 0004 and deploy

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Roll the threat-assessment-fusion feature (PR #2) into production by applying D1 migration `0004_assessments.sql` on the remote database and shipping the current worker + frontend.

**Architecture:** Ops-only runbook — no code changes. The new worker code SELECTs from the `assessments` table on Durable Object start, so the migration MUST be applied before (or in the same window as) the deploy. Migration is additive; rollback plan is to redeploy the previous worker version (the empty `assessments` table is harmless).

**Tech Stack:** Wrangler CLI, Cloudflare D1, Cloudflare Workers, Cloudflare Pages / assets bundle.

## Global Constraints

- Do NOT edit source files as part of this task. If a code fix is required, that is a separate PR.
- Apply the migration BEFORE the worker deploy (or in the same window). The worker will read the `assessments` table on DO start.
- The DO restart on deploy will reset pre-open category scores and position rings — expected & documented in `src/do/tracker.ts`; assessments repopulate over the first hours.
- The migration is additive; a rollback via `wrangler rollback` is safe (leftover empty table is harmless).

**Duplicate note:** Issue #5 covers the same rollout. Coordinate: execute this runbook ONCE and close both issues.

---

### Task 1: Pre-deploy sanity checks

**Files:** none (read-only).

- [ ] **Step 1: Confirm local main is clean and up-to-date**

Run: `git status && git pull --ff-only`
Expected: working tree clean, HEAD at the merge commit for PR #2.

- [ ] **Step 2: Confirm you are on the correct wrangler environment**

Run: `npx wrangler whoami`
Expected: the account that owns the production `DB` binding.

- [ ] **Step 3: Confirm migration 0004 is queued for `DB`**

Run: `npx wrangler d1 migrations list DB --remote`
Expected: `0004_assessments.sql` is listed as NOT applied.

### Task 2: Apply the migration

**Files:** none.

- [ ] **Step 1: Apply**

Run: `npx wrangler d1 migrations apply DB --remote`
Expected: `0004_assessments.sql applied successfully.`

- [ ] **Step 2: Verify schema present**

Run: `npx wrangler d1 execute DB --remote --command "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'assessments'"`
Expected: one row `assessments`.

- [ ] **Step 3: Verify indexes present**

Run: `npx wrangler d1 execute DB --remote --command "SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'assessments'"`
Expected: two rows (the two indexes shipped by migration 0004).

### Task 3: Deploy worker + frontend

**Files:** none.

- [ ] **Step 1: Deploy**

Run: `npm run deploy`
Expected: wrangler prints the deployed URL and asset upload summary.

- [ ] **Step 2: Smoke-check the worker started with the new binding**

Run: `curl -s https://<worker-url>/api/stats | jq .`
Expected: JSON response containing at least `activeAlerts` and `generatedAt`. If `activeAlerts` is missing entirely, the deploy did not pick up the new code — investigate before continuing.

### Task 4: Post-deploy acceptance checks (spec acceptance criteria)

**Files:** none.

- [ ] **Step 1: `activeAlerts` settles in the tens per region within ~24h**

Run periodically: `curl -s https://<worker-url>/api/stats | jq .activeAlerts`
Expected: value in the low tens per region (not hundreds — noise-gating is the point of the PR). If still in the hundreds after 24h, escalate.

- [ ] **Step 2: Red vessels have readable per-category assessment narratives**

Open the map UI, click a red (sus) vessel. Expected: dossier panel shows a narrative like "Loitered 3.2 h over <corridor> corridor, then went dark 1.4 h and reappeared 6.1 nm away" with evidence links into the raw event timeline.

- [ ] **Step 3: Map halos/trajectories are colored by threat category**

Confirm cable_interference red, dark_activity purple, identity_deception amber, calm traffic grey. Any category mismatch is a UI drift bug — file separately.

### Task 5: Rollback plan (only if Task 4 fails)

- [ ] Run: `npx wrangler rollback` — reverts the worker to the previous version.
- [ ] Leave the D1 migration in place (the empty `assessments` table is harmless to the previous worker).
- [ ] Post a short post-mortem in the issue thread naming what broke.

### Task 6: Close the tracking issues

- [ ] Comment on both issues #3 and #5 with the deploy timestamp, the wrangler version, and links to the smoke-check jq outputs.
- [ ] Close #3 and #5.
