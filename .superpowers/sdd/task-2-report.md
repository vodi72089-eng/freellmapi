# Task 2 Report: Update Database Factory Selection

**Status:** DONE

## Changes Made

Modified `server/src/db/index.ts` with three targeted edits:

1. **Added PostgreSQL import** (line 9): `import { createPostgresDb } from './postgres.js';`

2. **Updated `defaultDbFactory()`** (lines 46-51): When `DATABASE_URL` is set, returns a factory that creates `PostgresDb` instead of SQLite. Otherwise, falls through to the existing Android/better-sqlite3 logic.

3. **Wrapped SQLite-specific code in `connectDb()` with `!isPostgres` guard** (lines 69-96):
   - Directory creation and permission hardening (`restrictDataDir`, `restrictDbFilePermissions`) — skipped for PostgreSQL
   - SQLite PRAGMAs (`journal_mode = WAL`, `foreign_keys = ON`, `busy_timeout = 5000`) — skipped for PostgreSQL

4. **Updated `initDb()` dev check** (lines 210-223): The `sqlite_master` existence check is now gated on `!process.env.DATABASE_URL`, so it doesn't run (and fail) when PostgreSQL is the backing store.

## Verification

- `npx tsc --noEmit` — passes with no errors

## Commits

- `669b533` — `feat(db): wire PostgreSQL adapter into defaultDbFactory`

## Self-Review Notes

- SQLite behavior is completely unchanged when `DATABASE_URL` is unset
- The factory function signature is preserved: `defaultDbFactory()` still returns `DbFactory`, now with a PostgreSQL path
- `PostgresDb` implements the `Db` interface and its `pragma()` is a no-op, so any stray pragma calls won't crash
- File permission hardening is correctly skipped for PostgreSQL (no local file to protect)
- The dev `sqlite_master` check only runs for SQLite, avoiding a runtime error on PostgreSQL
- The `isPostgres` flag is computed once in `connectDb` rather than repeatedly checking `process.env.DATABASE_URL`
