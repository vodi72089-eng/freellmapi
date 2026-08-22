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
  if (!hasColumn(db, 'rate_limit_cooldowns', 'source')) {
    db.prepare("ALTER TABLE rate_limit_cooldowns ADD COLUMN source TEXT NOT NULL DEFAULT 'heuristic'").run();
  }
  if (!hasColumn(db, 'rate_limit_cooldowns', 'set_at_ms')) {
    db.prepare('ALTER TABLE rate_limit_cooldowns ADD COLUMN set_at_ms INTEGER').run();
  }
}

export function down(db: Db): void {
  if (hasColumn(db, 'rate_limit_cooldowns', 'source')) {
    db.prepare('ALTER TABLE rate_limit_cooldowns DROP COLUMN source').run();
  }
  if (hasColumn(db, 'rate_limit_cooldowns', 'set_at_ms')) {
    db.prepare('ALTER TABLE rate_limit_cooldowns DROP COLUMN set_at_ms').run();
  }
}
