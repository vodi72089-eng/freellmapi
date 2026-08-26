import { Pool, PoolClient } from 'pg';
import { Db, DbStatement } from './types.js';
import { getPool } from './postgres-pool.js';

class PostgresStatement implements DbStatement {
  constructor(private pool: Pool, private sql: string) {}

  get(...params: unknown[]): unknown {
    throw new Error('PostgreSQL: use getAsync() instead of get()');
  }

  async getAsync(...params: unknown[]): Promise<unknown> {
    const result = await this.pool.query(this.sql, params);
    return result.rows[0] ?? null;
  }

  all(...params: unknown[]): unknown[] {
    throw new Error('PostgreSQL: use allAsync() instead of all()');
  }

  async allAsync(...params: unknown[]): Promise<unknown[]> {
    const result = await this.pool.query(this.sql, params);
    return result.rows;
  }

  run(...params: unknown[]): { lastInsertRowid?: number | bigint; changes: number } {
    throw new Error('PostgreSQL: use runAsync() instead of run()');
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
    this.pool = pool!;
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

  pragma(_source: string): unknown {
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

export async function createPostgresDb(pool?: Pool): Promise<PostgresDb> {
  const resolvedPool = pool ?? await getPool();
  return new PostgresDb(resolvedPool);
}
