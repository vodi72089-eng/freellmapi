# Task 3: Rewrite Migration Runner for PostgreSQL

**Files:**
- Modify: `server/src/db/migrate/runner.ts`

**Interfaces:**
- Consumes: `PostgresDb` from `server/src/db/postgres.ts`
- Produces: Migration runner that uses `information_schema` instead of `PRAGMA`/`sqlite_master`

## What to implement

The migration runner currently uses SQLite-specific queries to:
1. Check if the `migrations` table exists (via `sqlite_master`)
2. Create the `migrations` table (with `AUTOINCREMENT` and `datetime('now')`)
3. Track applied migrations

Rewrite these to use PostgreSQL equivalents.

### Step 1: Rewrite the migrations table creation

Find the `CREATE TABLE IF NOT EXISTS migrations` statement and replace:

```typescript
// OLD (SQLite):
// CREATE TABLE IF NOT EXISTS migrations (id INTEGER PRIMARY KEY AUTOINCREMENT, filename TEXT NOT NULL UNIQUE, applied_at TEXT NOT NULL DEFAULT (datetime('now')))

// NEW (PostgreSQL):
const CREATE_MIGRATIONS_TABLE = `
  CREATE TABLE IF NOT EXISTS migrations (
    id SERIAL PRIMARY KEY,
    filename TEXT NOT NULL UNIQUE,
    applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )
`;
```

### Step 2: Replace `sqlite_master` queries

Find queries using `sqlite_master` and replace with `information_schema`:

```typescript
// OLD:
// SELECT name FROM sqlite_master WHERE type='table' AND name='migrations'

// NEW:
SELECT EXISTS (
  SELECT FROM information_schema.tables
  WHERE table_name = 'migrations'
) AS exists
```

### Step 3: Replace PRAGMA table_info queries

Find any `PRAGMA table_info` usage and replace with:

```typescript
async function columnExists(db: any, table: string, column: string): Promise<boolean> {
  const result = await db.queryOne(
    `SELECT EXISTS (
      SELECT FROM information_schema.columns
      WHERE table_name = $1 AND column_name = $2
    ) AS exists`,
    [table, column]
  );
  return (result as any)?.exists ?? false;
}
```

### Step 4: Verify

Run `npx tsc --noEmit` in the server directory.

## Context

This is Task 3 of 12. The migration runner needs to work with both SQLite and PostgreSQL. When `DATABASE_URL` is set, use PostgreSQL-compatible queries. When not set, keep existing SQLite behavior.

Read `server/src/db/migrate/runner.ts` to see the current implementation.

## Global Constraints

- Must work for both SQLite (when DATABASE_URL is not set) and PostgreSQL (when it is)
- The migration runner is used by `initDb()` to apply pending migrations
- The `migrations` table tracks which migration files have been applied
