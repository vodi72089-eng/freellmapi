# Task 6: Rewrite Route Files (SQLite → PostgreSQL)

**Files:**
- Modify: `server/src/routes/analytics.ts`
- Modify: `server/src/routes/fallback.ts`
- Modify: `server/src/routes/models.ts`
- Modify: `server/src/routes/profiles.ts`
- Modify: `server/src/routes/client-profiles.ts`
- Already modified (verify): `server/src/routes/keys.ts`, `server/src/routes/proxy.ts`

**Interfaces:**
- Consumes: PostgreSQL-compatible queries from Tasks 4-5
- Produces: All routes using PostgreSQL parameter syntax

## What to implement

Rewrite SQL queries in the route files that haven't been converted yet. Some routes were already partially updated in Task 5 (keys.ts, proxy.ts). Focus on the remaining ones.

### Key transformations:

1. **`?` placeholders** → `$1, $2, $3...` in PostgreSQL mode
2. **`lastInsertRowid`** → Use `RETURNING id` clause for PostgreSQL
3. **Dynamic WHERE building** → Change placeholder generation from `?` to `$N`
4. **`LOWER()`** → Works in both PostgreSQL and SQLite (no change needed)
5. **`ROW_NUMBER() OVER()`** → Works in both (no change needed)
6. **Sync `.prepare().run()`** → Async `.execute()` for PostgreSQL

### Files to update:

1. **`analytics.ts`** — Complex analytical queries with GROUP BY, aggregates. Most queries are standard SQL and should work. Check for `?` placeholders.
2. **`fallback.ts`** — Fallback chain management. Check for dynamic WHERE and upsert patterns.
3. **`models.ts`** — Model CRUD. Check for dynamic SET clause building and `lastInsertRowid`.
4. **`profiles.ts`** — Profile management. Has `LOWER()` (works in both) and `ROW_NUMBER()` (works in both). Check for dynamic placeholder building.
5. **`client-profiles.ts`** — Client profile CRUD. Check for `?` placeholders.

### Pattern for dynamic WHERE clauses:

```typescript
// OLD (SQLite):
const placeholders = conditions.map(() => '?').join(', ');

// NEW (PostgreSQL):
const placeholders = conditions.map((_, i) => `$${i + 1}`).join(', ');
```

### Pattern for INSERT with lastInsertRowid:

```typescript
// OLD (SQLite):
const info = db.prepare('INSERT INTO x (...) VALUES (...)').run(...);
const newId = info.lastInsertRowid;

// NEW (PostgreSQL):
const result = await (db as any).execute(
  'INSERT INTO x (...) VALUES (...) RETURNING id',
  [...params]
);
const newId = result.rows[0].id;
```

## Context

This is Task 6 of 12. Tasks 1-5 set up the PostgreSQL adapter, migrations, and service files. Now you need to convert the route handlers.

## Global Constraints

- Must work for BOTH SQLite and PostgreSQL
- Use `process.env.DATABASE_URL` to detect mode
- Keep existing SQLite code paths intact
- PostgreSQL uses `$1, $2...` parameter syntax
- After fixes, run `npx tsc --noEmit` to verify zero errors
