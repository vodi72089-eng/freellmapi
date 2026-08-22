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

const COLUMNS = ['proxy_encrypted', 'proxy_iv', 'proxy_auth_tag'] as const;

export function up(db: Db): void {
  for (const column of COLUMNS) {
    if (!hasColumn(db, 'api_keys', column)) {
      db.prepare(`ALTER TABLE api_keys ADD COLUMN ${column} TEXT`).run();
    }
  }
}

export function down(db: Db): void {
  for (const column of COLUMNS) {
    if (hasColumn(db, 'api_keys', column)) {
      db.prepare(`ALTER TABLE api_keys DROP COLUMN ${column}`).run();
    }
  }
}
