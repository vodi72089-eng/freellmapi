# Task 5: Rewrite Service Files (SQLite → PostgreSQL)

**Files:**
- Modify: `server/src/services/request-retention.ts`
- Modify: `server/src/services/url-tokens.ts`
- Modify: `server/src/services/model-state.ts`
- Modify: `server/src/services/health.ts`
- Modify: `server/src/services/router.ts`
- Modify: `server/src/services/ratelimit.ts`
- Modify: `server/src/services/embeddings.ts`
- Modify: `server/src/services/catalog-sync.ts`
- Modify: `server/src/services/custom-model-register.ts`
- Modify: `server/src/services/declarative-config.ts`

**Interfaces:**
- Consumes: PostgreSQL DDL syntax, `$1/$2` parameter syntax, async Db methods
- Produces: All services using PostgreSQL-compatible queries

## What to implement

Rewrite all SQL queries in the 10 service files from SQLite to PostgreSQL dialect. Make each file dual-mode (works with both SQLite and PostgreSQL).

### Key transformations for EACH file:

1. **`datetime('now')`** → `NOW()` in PostgreSQL mode
2. **`?` placeholders** → `$1, $2, $3...` in PostgreSQL mode
3. **`INSERT OR IGNORE`** → `INSERT ... ON CONFLICT DO NOTHING` in PostgreSQL mode
4. **`LIMIT -1 OFFSET ?`** → `DELETE FROM x WHERE id NOT IN (SELECT id FROM x ORDER BY ... DESC LIMIT $N)` in PostgreSQL mode
5. **`substr()`** → `SUBSTRING()` in PostgreSQL mode
6. **Sync `.prepare().run()`** → Async `.query()` or `.execute()` in PostgreSQL mode
7. **`lastInsertRowid`** → Use `RETURNING id` clause in PostgreSQL mode

### Approach — Dual-mode helper pattern:

```typescript
const isPostgres = !!process.env.DATABASE_URL;

// Helper for parameterized queries
function param(n: number): string {
  return isPostgres ? `$${n}` : '?';
}

// Helper for datetime
function now(): string {
  return isPostgres ? 'NOW()' : "datetime('now')";
}
```

Then rewrite queries:
```typescript
// OLD:
db.prepare(`UPDATE api_keys SET status = ?, last_checked_at = datetime('now') WHERE id = ?`).run(status, id)

// NEW:
if (isPostgres) {
  await db.execute(`UPDATE api_keys SET status = $1, last_checked_at = NOW() WHERE id = $2`, [status, id]);
} else {
  db.prepare(`UPDATE api_keys SET status = ?, last_checked_at = datetime('now') WHERE id = ?`).run(status, id);
}
```

### Files to update (in priority order):

1. **`request-retention.ts`** — Has `LIMIT -1 OFFSET ?` pattern (SQLite-specific delete)
2. **`url-tokens.ts`** — Has `datetime('now')` in UPDATE statements
3. **`model-state.ts`** — Has `datetime('now')` and upsert patterns
4. **`health.ts`** — Has `datetime('now')` in UPDATE statements
5. **`router.ts`** — Has `LOWER()` patterns and complex queries
6. **`ratelimit.ts`** — Has upsert patterns
7. **`embeddings.ts`** — Has upsert patterns with COALESCE
8. **`catalog-sync.ts`** — Has upsert patterns
9. **`custom-model-register.ts`** — Has upsert patterns
10. **`declarative-config.ts`** — Has upsert patterns

## Context

This is Task 5 of 12. Tasks 1-4 set up the PostgreSQL adapter, factory, runner, and migration files. Now you need to convert the actual business logic queries.

## Global Constraints

- Must work for BOTH SQLite and PostgreSQL
- Use `process.env.DATABASE_URL` to detect mode
- Keep existing SQLite code paths intact for backward compatibility
- PostgreSQL queries must use `$1, $2...` parameter syntax
- Async methods return Promises — callers may need `await`

## Important

- The `db` variable in these files is of type `Db` from `types.ts`
- The PostgreSQL adapter has additional async methods: `query()`, `queryOne()`, `execute()`, `transactionAsync()`
- You may need to cast `db` to `PostgresDb` when calling PostgreSQL-specific methods
- Or better: check `isPostgres` and use the appropriate code path
- Focus on the most critical files first (request-retention, url-tokens, model-state, health)
