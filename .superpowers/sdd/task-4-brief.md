# Task 4: Rewrite Legacy Baseline Migration

**Files:**
- Modify: `server/src/db/migrations/20260101_000000_legacy_baseline.ts` (2299 lines, 25+ tables)
- Modify: All other migration files in `server/src/db/migrations/` (20+ files)

**Interfaces:**
- Consumes: PostgreSQL DDL syntax
- Produces: All migrations working with both SQLite and PostgreSQL

## What to implement

This is the largest task. You need to rewrite ALL migration files to use PostgreSQL-compatible SQL while keeping SQLite support for users who don't set `DATABASE_URL`.

### Translation Reference

| SQLite | PostgreSQL |
|--------|-----------|
| `INTEGER PRIMARY KEY AUTOINCREMENT` | `SERIAL PRIMARY KEY` |
| `datetime('now')` | `NOW()` |
| `INSERT OR IGNORE INTO` | `INSERT INTO ... ON CONFLICT DO NOTHING` |
| `ON CONFLICT(...) DO UPDATE SET value = excluded.value` | Same syntax (works in both) |
| `?` parameter placeholders | `$1, $2, $3...` |
| `PRAGMA table_info(x)` | `information_schema.columns` query |
| `sqlite_master` | `information_schema.tables` |
| `substr(x, 1, 13)` | `SUBSTRING(x, 1, 13)` |
| `TEXT` | `TEXT` (same) |
| `REAL` | `DOUBLE PRECISION` or `REAL` (same) |
| `INTEGER` | `INTEGER` (same) |

### Approach

Make each migration file dual-mode:

```typescript
// At the top of each migration file:
const isPostgres = !!process.env.DATABASE_URL;

// Then use ternary or conditional blocks:
const CREATE_TABLE = isPostgres
  ? `CREATE TABLE IF NOT EXISTS models (
      id SERIAL PRIMARY KEY,
      platform TEXT NOT NULL,
      ...
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`
  : `CREATE TABLE IF NOT EXISTS models (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      platform TEXT NOT NULL,
      ...
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )`;
```

### Priority order (start with these):

1. `20260101_000000_legacy_baseline.ts` — THE BIG ONE (2299 lines, all core tables)
2. `20260627_000001_custom_provider_modalities.ts`
3. `20260627_000002_catalog_model_state.ts`
4. `20260628_120000_request_aggregates.ts`
5. `20260726_000001_cooldown_probe_provenance.ts`
6. `20260726_000002_request_attempts.ts`
7. `20260726_000003_model_source_provenance.ts`
8. `20260726_000004_media_model_meta.ts`
9. `20260726_000005_request_served_model.ts`
10. `20260726_000006_attempt_error_summary.ts`
11. `20260727_000001_agent_compatibility.ts`
12. `20260728_000001_tombstone_provenance.ts`
13. `20260729_000001_custom_model_endpoint_identity.ts`
14. `20260802_000001_custom_endpoint_host_labels.ts`
15. `20260805_000001_key_model_scope.ts`
16. `20260805_000002_client_profiles.ts`
17. `20260810_000001_api_key_proxy.ts`
18. `20260820_000001_playground_conversations.ts`

Also update:
- `server/src/db/migrate/runner.ts` — needs async migration support for PostgreSQL
- `server/src/db/index.ts` — `initDb()` needs to use async migrations when PostgreSQL

### For each migration file:

1. Add `const isPostgres = !!process.env.DATABASE_URL;` at the top
2. Replace all `AUTOINCREMENT` with `SERIAL` (PostgreSQL path)
3. Replace all `datetime('now')` with `NOW()` (PostgreSQL path)
4. Replace all `INSERT OR IGNORE INTO` with `INSERT INTO ... ON CONFLICT DO NOTHING` (PostgreSQL path)
5. Replace all `PRAGMA table_info(...)` with `information_schema` queries (PostgreSQL path)
6. Replace all `?` placeholders with `$1, $2, $3...` (PostgreSQL path)
7. Replace `sqlite_master` with `information_schema.tables` (PostgreSQL path)

### Special handling for `20260729_000001_custom_model_endpoint_identity.ts`:

This migration does complex table rebuilding with `sqlite_sequence`. For PostgreSQL, use sequences:
```sql
-- Get current sequence value
SELECT last_value FROM models_id_seq;
-- Set sequence
SELECT setval('models_id_seq', ?);
```

## Context

This is Task 4 of 12 — the largest and most complex task. The legacy baseline migration creates ALL core tables and seeds initial data. Every subsequent migration builds on this.

Read the plan file at C:\Users\vodi7\OneDrive\Documents\Downloads\docs\superpowers\plans\2026-08-22-freellmapi-hermes-deployment.md for the full translation reference.

## Global Constraints

- Must work for BOTH SQLite (DATABASE_URL not set) and PostgreSQL (DATABASE_URL set)
- All 25+ tables must be created with correct schemas
- All seed data (model catalog) must be inserted correctly
- The migration runner uses the `up()` and `down()` export pattern
- Each migration file exports `up(db)` and `down(db)` functions
