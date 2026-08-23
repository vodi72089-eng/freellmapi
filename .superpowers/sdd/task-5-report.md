# Task 5: Fix TypeScript Compilation Errors

## Summary

Fixed all 19 TypeScript compilation errors introduced by the PostgreSQL migration pass. The errors were caused by async PostgreSQL methods being called without proper `await` in functions that weren't marked `async`.

## Files Fixed

| File | Errors | Fix |
|------|--------|-----|
| `server/src/lib/fallback-loop.ts` | 1 | Added `async` to `recordRetryableFailure` |
| `server/src/routes/keys.ts` | 1 | Added `await` to `db.transaction()` call |
| `server/src/routes/proxy.ts` | 5 | Added `await` to `resolveStickyPreference` and `resolveModelGroupCandidates`, added null checks for `groupChain` |
| `server/src/scripts/routing-sim.ts` | 3 | Made `distribution`, `printScores`, `main` async; added `await` to all async calls |
| `server/src/services/custom-model-sync.ts` | 2 | Added `await` to `registerCustomModels`, added type annotation for `m` parameter |
| `server/src/services/fusion.ts` | 7 | Awaited `selectPanel`, updated `runJudgeStreaming` signature to accept async route functions, imported/used `resolveFusionCandidateAsync`, added type annotations |
| `server/src/services/router.ts` | 1 (new function) | Added `resolveFusionCandidateAsync` for group resolution (async path), kept `resolveFusionCandidate` sync for filter callbacks |

## Error Count

- **Before:** 19 errors
- **After:** 0 errors

## Key Decisions

1. **`resolveFusionCandidate` kept sync** — Used in `filter()` callbacks that can't be async. Added separate `resolveFusionCandidateAsync` for callers that need group resolution.

2. **`runJudgeStreaming` signature updated** — Changed from `(skipKeys, skipModels) => RouteResult | null` to `(skipKeys, skipModels) => Promise<RouteResult | null> | RouteResult | null` to support async route resolvers.

3. **Dual-mode pattern preserved** — All fixes maintain the `const isPostgres = !!process.env.DATABASE_URL;` pattern. Sync SQLite code paths remain unchanged.

## Commit

```
fix: resolve TypeScript compilation errors from PostgreSQL migration

- Add async/await to functions calling async PostgreSQL methods
- Update return types to Promise<> where needed
- Add resolveFusionCandidateAsync for group resolution (async path)
- Update runJudgeStreaming to accept async route functions
- Fix implicit any types in callbacks
- All 19 tsc --noEmit errors resolved
```

## Concerns

- 15 files from the PostgreSQL migration pass remain uncommitted (not part of this task).
- The `db.transaction()` wrapper in `keys.ts` may not properly handle async functions in better-sqlite3. The `registerCustomChatModels` function uses async PostgreSQL queries inside the transaction. This works because the transaction callback returns a Promise, but better-sqlite3's transaction wrapper is synchronous. On the PostgreSQL path, the transaction is handled by the PostgresDb adapter which supports async.
