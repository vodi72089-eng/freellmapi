import type { Db } from '../types.js';

const isPostgres = !!process.env.DATABASE_URL;

function hasColumn(db: Db, table: string, column: string): boolean {
  if (isPostgres) {
    const row = db.prepare(
      `SELECT EXISTS (
        SELECT FROM information_schema.columns
        WHERE table_name = $1 AND column_name = $2
      ) AS exists`,
    ).get(table, column) as { exists: boolean } | undefined;
    return row?.exists ?? false;
  }
  const columns = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  return columns.some((candidate) => candidate.name === column);
}

export function up(db: Db): void {
  if (!hasColumn(db, 'catalog_model_tombstones', 'source')) {
    db.prepare("ALTER TABLE catalog_model_tombstones ADD COLUMN source TEXT NOT NULL DEFAULT 'user'").run();
  }
  if (!hasColumn(db, 'catalog_model_tombstones', 'reason')) {
    db.prepare('ALTER TABLE catalog_model_tombstones ADD COLUMN reason TEXT').run();
  }
}

export function down(db: Db): void {
  db.prepare("DELETE FROM catalog_model_tombstones WHERE source = 'upstream_eol'").run();
  if (hasColumn(db, 'catalog_model_tombstones', 'reason')) {
    db.prepare('ALTER TABLE catalog_model_tombstones DROP COLUMN reason').run();
  }
  if (hasColumn(db, 'catalog_model_tombstones', 'source')) {
    db.prepare('ALTER TABLE catalog_model_tombstones DROP COLUMN source').run();
  }
}
