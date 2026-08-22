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
  if (!hasColumn(db, 'models', 'source')) {
    db.prepare("ALTER TABLE models ADD COLUMN source TEXT NOT NULL DEFAULT 'catalog'").run();
  }

  db.prepare(`
    UPDATE models
       SET source = 'user'
     WHERE platform = 'custom'
        OR key_id IS NOT NULL
        OR size_label IN ('User', 'Custom')
  `).run();

  try {
    const setting = db
      .prepare("SELECT value FROM settings WHERE key = 'catalog_applied_json'")
      .get() as { value: string } | undefined;
    if (!setting) return;
    const parsed = JSON.parse(setting.value) as { models?: unknown };
    if (!parsed || !Array.isArray(parsed.models)) return;
    const inCatalog = new Set<string>();
    for (const m of parsed.models as { platform?: unknown; modelId?: unknown }[]) {
      if (typeof m?.platform === 'string' && typeof m?.modelId === 'string') {
        inCatalog.add(`${m.platform}:${m.modelId}`);
      }
    }
    const rows = db
      .prepare("SELECT id, platform, model_id FROM models WHERE source = 'catalog'")
      .all() as { id: number; platform: string; model_id: string }[];
    const markUser = db.prepare("UPDATE models SET source = 'user' WHERE id = ?");
    for (const row of rows) {
      if (!inCatalog.has(`${row.platform}:${row.model_id}`)) markUser.run(row.id);
    }
  } catch {
    // ignore
  }
}

export function down(db: Db): void {
  if (hasColumn(db, 'models', 'source')) {
    db.prepare('ALTER TABLE models DROP COLUMN source').run();
  }
}
