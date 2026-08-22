import fs from 'fs';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

import type { Db } from '../types.js';
import { DEFAULT_MIGRATIONS, type MigrationModule } from './defaults.js';

export type MigrationDirection = 'up' | 'down';
export type MigrationState = 'applied' | 'pending';

export interface MigrationRunnerOptions {
  migrationsDir?: string;
  migrationFileExtension?: '.ts' | '.js';
}

export interface MigrationStatus {
  filename: string;
  status: MigrationState;
  appliedAt: string | null;
}

interface AppliedMigrationRow {
  filename: string;
  applied_at: string;
}

interface MigrationRecord {
  filename: string;
  module?: MigrationModule;
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_MIGRATIONS_DIR = path.resolve(__dirname, '../migrations');

function isPostgres(): boolean {
  return !!process.env.DATABASE_URL;
}

const CREATE_MIGRATIONS_TABLE_SQLITE = `
  CREATE TABLE IF NOT EXISTS migrations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    filename TEXT NOT NULL UNIQUE,
    applied_at TEXT NOT NULL DEFAULT (datetime('now'))
  )
`;

const CREATE_MIGRATIONS_TABLE_POSTGRES = `
  CREATE TABLE IF NOT EXISTS migrations (
    id SERIAL PRIMARY KEY,
    filename TEXT NOT NULL UNIQUE,
    applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )
`;

export async function tableExists(db: Db, tableName: string): Promise<boolean> {
  if (isPostgres()) {
    const result = await (db as any).queryOne(
      `SELECT EXISTS (
        SELECT FROM information_schema.tables
        WHERE table_name = $1
      ) AS exists`,
      [tableName],
    );
    return (result as any)?.exists ?? false;
  }
  const row = db.prepare(
    `SELECT name FROM sqlite_master WHERE type='table' AND name=?`
  ).get(tableName) as { name: string } | undefined;
  return !!row;
}

export async function columnExists(db: Db, table: string, column: string): Promise<boolean> {
  if (isPostgres()) {
    const result = await (db as any).queryOne(
      `SELECT EXISTS (
        SELECT FROM information_schema.columns
        WHERE table_name = $1 AND column_name = $2
      ) AS exists`,
      [table, column],
    );
    return (result as any)?.exists ?? false;
  }
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  return rows.some(r => r.name === column);
}

export async function runMigrations(
  db: Db,
  direction: MigrationDirection = 'up',
  options: MigrationRunnerOptions = {},
): Promise<void> {
  initializeMigrationTracking(db);
  const records = getMigrationRecords(options);

  if (direction === 'up') {
    await runPendingMigrations(db, records, options);
    return;
  }

  if (direction === 'down') {
    await runLatestDownMigration(db, records, options);
    return;
  }

  throw new Error(`Unknown migration direction: ${direction}`);
}

export function runMigrationsSync(
  db: Db,
  direction: MigrationDirection = 'up',
): void {
  initializeMigrationTracking(db);
  const records = getDefaultMigrationRecords();

  if (direction === 'up') {
    runPendingMigrationsSync(db, records);
    return;
  }

  if (direction === 'down') {
    runLatestDownMigrationSync(db, records);
    return;
  }

  throw new Error(`Unknown migration direction: ${direction}`);
}

export function getMigrationStatuses(
  db: Db,
  options: MigrationRunnerOptions = {},
): MigrationStatus[] {
  if (isPostgres()) {
    throw new Error(
      'Synchronous getMigrationStatuses() is not supported with PostgreSQL. ' +
      'Use getMigrationStatusesAsync() when DATABASE_URL is set.',
    );
  }

  initializeMigrationTracking(db);

  const applied = getAppliedMigrations(db);
  return getMigrationRecords(options).map(record => ({
    filename: record.filename,
    status: applied.has(record.filename) ? 'applied' : 'pending',
    appliedAt: applied.get(record.filename) ?? null,
  }));
}

export async function getMigrationStatusesAsync(
  db: Db,
  options: MigrationRunnerOptions = {},
): Promise<MigrationStatus[]> {
  initializeMigrationTracking(db);

  const applied = isPostgres()
    ? await getAppliedMigrationsAsync(db)
    : getAppliedMigrations(db);

  return getMigrationRecords(options).map(record => ({
    filename: record.filename,
    status: applied.has(record.filename) ? 'applied' : 'pending',
    appliedAt: applied.get(record.filename) ?? null,
  }));
}

function initializeMigrationTracking(db: Db): void {
  ensureMigrationsTable(db);
}

function ensureMigrationsTable(db: Db): void {
  if (isPostgres()) {
    db.exec(CREATE_MIGRATIONS_TABLE_POSTGRES);
  } else {
    db.exec(CREATE_MIGRATIONS_TABLE_SQLITE);
  }
}

async function runPendingMigrations(
  db: Db,
  records: readonly MigrationRecord[],
  options: MigrationRunnerOptions,
): Promise<void> {
  const applied = isPostgres()
    ? await getAppliedMigrationsAsync(db)
    : getAppliedMigrations(db);

  for (const record of records) {
    if (applied.has(record.filename)) continue;

    const migration = await loadMigrationModule(record, options);

    if (isPostgres()) {
      const applyMigration = db.transaction(async () => {
        await migration.up(db);
        await (db as any).query(
          'INSERT INTO migrations (filename) VALUES ($1)',
          [record.filename],
        );
      });
      await applyMigration();
    } else {
      const applyMigration = db.transaction(() => {
        migration.up(db);
        db.prepare('INSERT INTO migrations (filename) VALUES (?)').run(record.filename);
      });
      applyMigration();
    }

    applied.set(record.filename, new Date().toISOString());
  }
}

async function runLatestDownMigration(
  db: Db,
  records: readonly MigrationRecord[],
  options: MigrationRunnerOptions,
): Promise<void> {
  const row = isPostgres()
    ? await (db as any).queryOne(
        `SELECT filename FROM migrations ORDER BY id DESC LIMIT 1`,
      ) as { filename: string } | undefined
    : db.prepare(`
        SELECT filename
          FROM migrations
         ORDER BY id DESC
         LIMIT 1
      `).get() as { filename: string } | undefined;

  if (!row) return;

  const record = records.find(record => record.filename === row.filename);
  if (!record) throw new Error(`Migration file not found: ${row.filename}`);

  const migration = await loadMigrationModule(record, options);

  if (isPostgres()) {
    const revertMigration = db.transaction(async () => {
      await migration.down(db);
      await (db as any).query(
        'DELETE FROM migrations WHERE filename = $1',
        [row.filename],
      );
    });
    await revertMigration();
  } else {
    const revertMigration = db.transaction(() => {
      migration.down(db);
      db.prepare('DELETE FROM migrations WHERE filename = ?').run(row.filename);
    });
    revertMigration();
  }
}

function runPendingMigrationsSync(
  db: Db,
  records: readonly MigrationRecord[],
): void {
  if (isPostgres()) {
    throw new Error(
      'Synchronous migration runner is not supported with PostgreSQL. ' +
      'Use runMigrations() (async) when DATABASE_URL is set.',
    );
  }

  const applied = getAppliedMigrations(db);

  for (const record of records) {
    if (applied.has(record.filename)) continue;
    if (!record.module) throw new Error(`Migration ${record.filename} cannot run synchronously`);

    const applyMigration = db.transaction(() => {
      record.module!.up(db);
      db.prepare('INSERT INTO migrations (filename) VALUES (?)').run(record.filename);
    });

    applyMigration();
    applied.set(record.filename, new Date().toISOString());
  }
}

function runLatestDownMigrationSync(
  db: Db,
  records: readonly MigrationRecord[],
): void {
  if (isPostgres()) {
    throw new Error(
      'Synchronous migration runner is not supported with PostgreSQL. ' +
      'Use runMigrations() (async) when DATABASE_URL is set.',
    );
  }

  const row = db.prepare(`
    SELECT filename
      FROM migrations
     ORDER BY id DESC
     LIMIT 1
  `).get() as { filename: string } | undefined;

  if (!row) return;

  const record = records.find(record => record.filename === row.filename);
  if (!record?.module) throw new Error(`Migration ${row.filename} cannot run synchronously`);

  const revertMigration = db.transaction(() => {
    record.module!.down(db);
    db.prepare('DELETE FROM migrations WHERE filename = ?').run(row.filename);
  });

  revertMigration();
}

function getAppliedMigrations(db: Db): Map<string, string> {
  const rows = db.prepare(`
    SELECT filename, applied_at
      FROM migrations
     ORDER BY filename ASC
  `).all() as AppliedMigrationRow[];

  return new Map(rows.map(row => [row.filename, row.applied_at]));
}

async function getAppliedMigrationsAsync(db: Db): Promise<Map<string, string>> {
  const rows = await (db as any).query(
    `SELECT filename, applied_at FROM migrations ORDER BY filename ASC`,
  ) as AppliedMigrationRow[];
  return new Map(rows.map(row => [row.filename, row.applied_at]));
}

function getMigrationRecords(options: MigrationRunnerOptions): MigrationRecord[] {
  if (isDefaultMigrationSet(options)) return getDefaultMigrationRecords();

  return getMigrationFilenames(options).map(filename => ({ filename }));
}

function getDefaultMigrationRecords(): MigrationRecord[] {
  return DEFAULT_MIGRATIONS.map(migration => ({
    filename: migration.filename,
    module: migration.module,
  }));
}

function getMigrationFilenames(options: MigrationRunnerOptions): string[] {
  const migrationsDir = getMigrationsDir(options);
  if (!fs.existsSync(migrationsDir)) return [];

  const extension = getMigrationFileExtension(options);
  return fs.readdirSync(migrationsDir, { withFileTypes: true })
    .filter(entry => entry.isFile())
    .map(entry => entry.name)
    .filter(filename => filename.endsWith(extension) && !filename.endsWith('.d.ts'))
    .sort((left, right) => left.localeCompare(right));
}

async function loadMigrationModule(
  record: MigrationRecord,
  options: MigrationRunnerOptions,
): Promise<MigrationModule> {
  if (record.module) return record.module;

  const migrationPath = path.join(getMigrationsDir(options), record.filename);
  if (!fs.existsSync(migrationPath)) {
    throw new Error(`Migration file not found: ${record.filename}`);
  }

  const imported = await import(pathToFileURL(migrationPath).href) as Partial<MigrationModule>;
  if (typeof imported.up !== 'function' || typeof imported.down !== 'function') {
    throw new Error(`Migration ${record.filename} must export up(db) and down(db) functions`);
  }

  return {
    up: imported.up,
    down: imported.down,
  };
}

function isDefaultMigrationSet(options: MigrationRunnerOptions): boolean {
  return options.migrationsDir === undefined && options.migrationFileExtension === undefined;
}

function getMigrationsDir(options: MigrationRunnerOptions): string {
  return options.migrationsDir ?? DEFAULT_MIGRATIONS_DIR;
}

function getMigrationFileExtension(options: MigrationRunnerOptions): '.ts' | '.js' {
  if (options.migrationFileExtension) return options.migrationFileExtension;
  return fileURLToPath(import.meta.url).endsWith('.ts') ? '.ts' : '.js';
}
