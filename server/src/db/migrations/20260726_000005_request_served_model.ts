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
  if (!hasColumn(db, 'requests', 'served_model')) {
    db.prepare('ALTER TABLE requests ADD COLUMN served_model TEXT').run();
  }
}

export function down(db: Db): void {
  if (hasColumn(db, 'requests', 'served_model')) {
    db.prepare('ALTER TABLE requests DROP COLUMN served_model').run();
  }
}
