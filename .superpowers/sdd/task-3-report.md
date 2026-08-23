# Task 3 Report: Rewrite Migration Runner for PostgreSQL

**Status:** DONE

## Summary

Rewrote the migration runner (`server/src/db/migrate/runner.ts`) to support both SQLite and PostgreSQL. When `DATABASE_URL` is set, the runner uses PostgreSQL-compatible queries; otherwise, it keeps existing SQLite behavior.

## Changes Made

### `server/src/db/migrate/runner.ts` (+147 lines, -23 lines)

1. **Dual DDL for migrations table**
   - `CREATE_MIGRATIONS_TABLE_SQLITE`: `INTEGER PRIMARY KEY AUTOINCREMENT`, `datetime('now')`
   - `CREATE_MIGRATIONS_TABLE_POSTGRES`: `SERIAL PRIMARY KEY`, `TIMESTAMPTZ DEFAULT NOW()`
   - `ensureMigrationsTable()` selects the right DDL based on `isPostgres()`

2. **`isPostgres()` helper** — checks `process.env.DATABASE_URL`

3. **`tableExists()` export** — uses `information_schema.tables` for PostgreSQL, `sqlite_master` for SQLite

4. **`columnExists()` export** — uses `information_schema.columns` for PostgreSQL, `PRAGMA table_info` for SQLite

5. **Async PostgreSQL query paths**
   - `getAppliedMigrationsAsync()` — uses `(db as any).query()` with no placeholder differences
   - `getMigrationStatusesAsync()` — new export for callers that need status in PG mode
   - `runPendingMigrations()` — async path uses `$1` placeholders and async transactions
   - `runLatestDownMigration()` — async path uses `$1` placeholders and async transactions

6. **Sync function guards** — `runPendingMigrationsSync`, `runLatestDownMigrationSync`, and `getMigrationStatuses` throw clear errors when PostgreSQL is detected, directing callers to use async counterparts

### `server/src/db/migrate/cli.ts` (+7 lines, -3 lines)

- Updated `printStatus()` to be async and use `getMigrationStatusesAsync()` when `DATABASE_URL` is set
- Updated import to include `getMigrationStatusesAsync`

## Compilation

`npx tsc --noEmit` passes with zero errors.

## Commits

- `d4cc334` — `feat(db): rewrite migration runner for PostgreSQL dual-mode support`

## Test Summary

- TypeScript compilation: PASS (zero errors)
- No runtime tests executed (no PostgreSQL instance available; SQLite path unchanged)

## Concerns

1. **`initDb()` in `db/index.ts` is synchronous** — It calls `runMigrationsSync(db, 'up')` in production, which will now throw when PostgreSQL is detected. The `initDb` function (and its caller `index.ts`) needs a separate update to use async migrations for PostgreSQL. This is outside the scope of this task (which targets only `runner.ts`).

2. **Migration files use SQLite-specific queries** — Individual migration files (e.g., `20260101_000000_legacy_baseline.ts`) use `PRAGMA table_info`, `?` placeholders, `INSERT OR IGNORE`, and other SQLite-specific syntax. These will not work with PostgreSQL as-is. The migration files themselves need a separate rewrite for PG compatibility.

3. **`isPostgres()` is module-level** — The function checks `process.env.DATABASE_URL` at call time. If the env var changes after module load (unlikely but possible), the detection adapts. However, calling `isPostgres()` on every operation adds minor overhead; caching the result at module scope would be slightly more efficient but less flexible.

## What's NOT in scope

- Updating `db/index.ts` `initDb()` to handle async migrations for PostgreSQL
- Rewriting individual migration files for PostgreSQL compatibility
- Adding a PostgreSQL-specific migration file path or strategy
