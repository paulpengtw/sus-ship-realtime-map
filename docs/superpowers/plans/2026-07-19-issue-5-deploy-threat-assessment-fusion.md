# Issue #5 — Deploy threat-assessment-fusion (PR #2): apply D1 migration + wrangler deploy

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Same as issue #3 — get PR #2 (threat-assessment-fusion) live: apply D1 migration `0004_assessments.sql` on remote and deploy the current worker + frontend.

**Architecture:** Ops-only runbook. This issue duplicates #3. Execute the runbook ONCE and close both issues in the same commit/PR-close pass. This plan exists so the "one plan per issue" convention holds; the substantive steps live in the linked plan for #3.

**Tech Stack:** Wrangler CLI, Cloudflare D1, Cloudflare Workers.

## Global Constraints

- Do not run the migration twice.
- If you executed the #3 plan first, only Task 3 of THIS plan applies (close-out).

---

### Task 1: Route to the canonical plan

**Files:** none.

- [ ] **Step 1: Confirm which plan is authoritative**

Open `docs/superpowers/plans/2026-07-19-issue-3-postmerge-migration-0004-deploy.md`. That plan is the substantive runbook; this plan defers to it.

- [ ] **Step 2: If the migration + deploy have NOT yet been executed**

Follow the linked plan from top to bottom, then jump to Task 3 of this plan to close #5.

- [ ] **Step 3: If the migration + deploy HAVE been executed**

Skip Task 2. Go directly to Task 3.

### Task 2: Execute the canonical plan

- [ ] Execute every task in `docs/superpowers/plans/2026-07-19-issue-3-postmerge-migration-0004-deploy.md`.

### Task 3: Close-out

**Files:** none.

- [ ] **Step 1: Post the deploy summary on both issues**

Comment on #3 and #5 with: the wrangler CLI version, the migration timestamp, and the results of the post-deploy `curl /api/stats | jq` output (redact any sensitive URLs).

- [ ] **Step 2: Close both issues**

Run: `gh issue close 3 5 --comment "Deployed. See <link-to-comment>."`
Expected: both issues transition to CLOSED.

- [ ] **Step 3: Announce in Discord** (per CLAUDE.md's shared-repo workflow)

Mention `<@389494322204246044>` with the deploy timestamp and the worker URL. Optionally react with 🎉 on any related pinned message.
