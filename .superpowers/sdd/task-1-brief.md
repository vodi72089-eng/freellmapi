# Task 1: Create PostgreSQL Adapter

**Files:**
- Create: `server/src/db/postgres.ts`
- Create: `server/src/db/postgres-pool.ts`
- Modify: `server/src/db/types.ts` (add PostgreSQL-specific types)

**Interfaces:**
- Consumes: `Db` interface from `server/src/db/types.ts`
- Produces: `PostgresDb` class implementing `Db`, `createPostgresDb()` factory function

## What to implement

Create a PostgreSQL adapter that implements the existing `Db` interface so FreeLLMAPI can use PostgreSQL (Supabase) instead of SQLite.

### Step 1: Add PostgreSQL-specific types to types.ts

Add to `server/src/db/types.ts`:

```typescript
export interface PostgresDb extends Db {
  readonly isPostgres: true;
  pool: unknown; // pg.Pool
}
```

### Step 2: Create the connection pool module

Create `server/src/db/postgres-pool.ts`:

```typescript
import { Pool } from 'pg';

let pool: Pool | null = null;

export function getPool(): Pool {
  if (!pool) {
    const connectionString = process.env.DATABASE_URL;
    if (!connectionString) {
      throw new Error('DATABASE_URL environment variable is required for PostgreSQL');
    }
    pool = new Pool({
      connectionString,
      ssl: process.env.NODE_ENV === 'production'
        ? { rejectUnauthorized: false }
        : false,
      max: 20,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 5000,
    });
  }
  return pool;
}

export async function closePool(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = null;
  }
}
```

### Step 3: Create the PostgreSQL Db adapter

Create `server/src/db/postgres.ts`:

```typescript
import { Pool, PoolClient } from 'pg';
import { Db, DbStatement } from './types';
import { getPool } from './postgres-pool';

class PostgresStatement implements DbStatement {
  constructor(private pool: Pool, private sql: string) {}

  get(...params: unknown[]): unknown {
    throw new Error('Use getAsync() for PostgreSQL');
  }

  async getAsync(...params: unknown[]): Promise<unknown> {
    const result = await this.pool.query(this.sql, params);
    return result.rows[0] ?? null;
  }

  all(...params: unknown[]): unknown[] {
    throw new Error('Use allAsync() for PostgreSQL');
  }

  async allAsync(...params: unknown[]): Promise<unknown[]> {
    const result = await this.pool.query(this.sql, params);
    return result.rows;
  }

  run(...params: unknown[]): { lastInsertRowid?: number | bigint; changes: number } {
    throw new Error('Use runAsync() for PostgreSQL');
  }

  async runAsync(...params: unknown[]): Promise<{ lastInsertRowid?: number | bigint; changes: number }> {
    const result = await this.pool.query(this.sql, params);
    return {
      lastInsertRowid: result.rows[0]?.id,
      changes: result.rowCount ?? 0,
    };
  }
}

export class PostgresDb implements Db {
  readonly isPostgres = true as const;
  pool: Pool;

  constructor(pool?: Pool) {
    this.pool = pool ?? getPool();
  }

  prepare(sql: string): DbStatement {
    return new PostgresStatement(this.pool, sql);
  }

  exec(sql: string): void {
    this.pool.query(sql).catch((err) => {
      console.error('PostgreSQL exec error:', err);
    });
  }

  async execAsync(sql: string): Promise<void> {
    await this.pool.query(sql);
  }

  transaction<F extends (...args: any[]) => unknown>(fn: F): F {
    const pool = this.pool;
    return (async (...args: unknown[]) => {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const result = await fn(...args);
        await client.query('COMMIT');
        return result;
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      } finally {
        client.release();
      }
    }) as unknown as F;
  }

  pragma(source: string): unknown {
    console.log(`PostgreSQL: ignoring pragma "${source}"`);
    return null;
  }

  readonly name?: string = process.env.DATABASE_URL;
  readonly memory?: boolean = false;

  close(): void {
    this.pool.end().catch(() => {});
  }

  async query(sql: string, params?: unknown[]): Promise<unknown[]> {
    const result = await this.pool.query(sql, params);
    return result.rows;
  }

  async queryOne(sql: string, params?: unknown[]): Promise<unknown> {
    const result = await this.pool.query(sql, params);
    return result.rows[0] ?? null;
  }

  async execute(sql: string, params?: unknown[]): Promise<{ rowCount: number; rows?: unknown[] }> {
    const result = await this.pool.query(sql, params);
    return { rowCount: result.rowCount ?? 0, rows: result.rows };
  }

  async transactionAsync<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await fn(client);
      await client.query('COMMIT');
      return result;
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }
}

export function createPostgresDb(pool?: Pool): PostgresDb {
  return new PostgresDb(pool);
}
```

### Step 4: Verify

Run `npx tsc --noEcast` in the server directory to verify the adapter compiles.

## Context

This is Task 1 of a 12-task plan to migrate FreeLLMAPI from SQLite to PostgreSQL (Supabase). The `Db` interface in `server/src/db/types.ts` is the abstraction layer — our PostgreSQL adapter must implement it. The existing SQLite code uses synchronous APIs (`prepare().get()`, `.all()`, `.run()`), but PostgreSQL via `pg` is async. Our adapter provides both sync (throwing errors directing to async versions) and async methods.

The `pg` npm package has NOT been installed yet — that happens in Task 7. For now, create the files assuming `pg` types are available (add `// @ts-ignore` if needed for compilation, or install `pg` and `@types/pg` temporarily).

## Global Constraints

- Node.js 20+ required
- Must maintain backward compatibility with existing SQLite
- `DATABASE_URL` env var holds the PostgreSQL connection string
- `ENCRYPTION_KEY` for AES-256-GCM remains unchanged (application-level)
- The `Db` interface is the contract — all existing code depends on it
