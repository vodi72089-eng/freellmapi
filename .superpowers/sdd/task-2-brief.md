# Task 2: Update Database Factory Selection

**Files:**
- Modify: `server/src/db/index.ts`

**Interfaces:**
- Consumes: `PostgresDb` from `server/src/db/postgres.ts` (created in Task 1)
- Produces: `defaultDbFactory()` that selects SQLite or PostgreSQL based on `DATABASE_URL`

## What to implement

Modify `server/src/db/index.ts` to:
1. Import the PostgreSQL factory
2. Add `DATABASE_URL` detection to `defaultDbFactory()`
3. Skip SQLite pragmas when using PostgreSQL in `initDb()`

### Step 1: Update the factory to support PostgreSQL

At the top of `server/src/db/index.ts`, add the import:
```typescript
import { createPostgresDb } from './postgres';
```

In the `defaultDbFactory` function, add PostgreSQL detection at the very beginning:
```typescript
export function defaultDbFactory(dbPath?: string): Db {
  // If DATABASE_URL is set, use PostgreSQL
  if (process.env.DATABASE_URL) {
    return createPostgresDb();
  }
  // ... existing SQLite factory code continues unchanged ...
}
```

### Step 2: Update `initDb` to skip SQLite pragmas

In the `initDb` function, find the PRAGMA calls and wrap them:
```typescript
// SQLite-specific pragmas — only apply when not using PostgreSQL
if (!process.env.DATABASE_URL) {
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
}
```

### Step 3: Verify

Run `npx tsc --noEmit` in the server directory.

## Context

This is Task 2 of 12. Task 1 created the PostgreSQL adapter. This task wires it into the existing factory so that setting `DATABASE_URL` automatically switches FreeLLMAPI from SQLite to PostgreSQL.

## Global Constraints

- When `DATABASE_URL` is not set, behavior must be identical to current (SQLite)
- When `DATABASE_URL` is set, PostgreSQL adapter must be used
- No existing functionality should break for SQLite users
