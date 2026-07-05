Status: DONE_WITH_CONCERNS

Changes:
- Added `CONFIG.retentionTiers` with the specified 48 h raw, 30 d 10-minute, and 180 d hourly boundaries; removed `positionRetentionMs`.
- Replaced `pruneOldPositions` with `thinPositions(db, now, tiers)`.
- `thinPositions` deletes points older than the oldest configured tier and keeps the earliest point per `(mmsi, bucket)` inside each thinning tier.
- Wired the Tracker Durable Object hourly maintenance block to call `thinPositions(this.env.DB, now, CONFIG.retentionTiers)`.
- Removed the obsolete `pruneOldPositions` test from `test/db.test.ts`.
- Added `test/thinning.test.ts` covering raw retention, 10-minute thinning, per-vessel independence, hourly thinning, and deletion beyond 180 days.

Implementation note:
- The brief's SQL grouped by `ts / ?3`, but D1 binding grouped those as fractional values in the focused test run. The implemented SQL uses `CAST(ts / ?3 AS INTEGER)` so buckets are integer time buckets while preserving the specified behavior.

Test results:
- Initial red test: `npm test -- test/thinning.test.ts` failed as expected because `thinPositions` was not exported.
- Focused verification: `npm test -- test/thinning.test.ts test/db.test.ts` passed, 2 test files and 8 tests.
- Full verification: `npm test` passed, 30 test files and 128 tests.
- Typecheck: `npx tsc --noEmit` failed with existing unrelated errors outside the scoped files:
  - missing Node types / implicit anys in `scripts/replay.ts`
  - duplicate `shipType` declarations in `src/types.ts`
  - sync/async `parseFrame` type mismatch in `test/frame-decode.test.ts`
  - missing `localStorage` DOM type in `web/src/regions.ts`

Concerns:
- `npx tsc --noEmit` is not green due to the unrelated errors listed above. The thinning implementation did not add typecheck errors in the scoped files.
- Vitest/Miniflare continues to emit the existing compatibility-date warning: installed runtime supports `2025-09-06` and falls back from configured `2026-06-01`.
- One existing pipeline test intentionally logs a detector error for its failure-isolation assertion.
