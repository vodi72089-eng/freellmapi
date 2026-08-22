import type { Db } from '../types.js';

const isPostgres = !!process.env.DATABASE_URL;

function pg(sql: string): string {
  let i = 0;
  return sql.replace(/\?/g, () => `$${++i}`);
}

interface KeyRow { id: number; base_url: string | null }

function hostOf(baseUrl: string | null): string | null {
  if (!baseUrl) return null;
  try {
    return new URL(baseUrl).host || null;
  } catch {
    return null;
  }
}

export function up(db: Db): void {
  const selectSql = isPostgres
    ? pg("SELECT id, base_url FROM api_keys WHERE platform = 'custom' AND label = 'Custom'")
    : "SELECT id, base_url FROM api_keys WHERE platform = 'custom' AND label = 'Custom'";
  const rows = db.prepare(selectSql).all() as KeyRow[];
  const updateSql = isPostgres ? pg('UPDATE api_keys SET label = ? WHERE id = ?') : 'UPDATE api_keys SET label = ? WHERE id = ?';
  const update = db.prepare(updateSql);
  for (const row of rows) {
    const host = hostOf(row.base_url);
    if (host) update.run(host, row.id);
  }
}

export function down(db: Db): void {
  const selectSql = isPostgres
    ? pg("SELECT id, label, base_url FROM api_keys WHERE platform = 'custom'")
    : "SELECT id, label, base_url FROM api_keys WHERE platform = 'custom'";
  const rows = db.prepare(selectSql).all() as (KeyRow & { label: string | null })[];
  const updateSql = isPostgres
    ? pg("UPDATE api_keys SET label = 'Custom' WHERE id = ?")
    : "UPDATE api_keys SET label = 'Custom' WHERE id = ?";
  const update = db.prepare(updateSql);
  for (const row of rows) {
    if (row.label && row.label === hostOf(row.base_url)) update.run(row.id);
  }
}
