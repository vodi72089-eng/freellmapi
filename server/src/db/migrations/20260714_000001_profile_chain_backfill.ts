import type { Db } from '../types.js';

const isPostgres = !!process.env.DATABASE_URL;

function pg(sql: string): string {
  let i = 0;
  return sql.replace(/\?/g, () => `$${++i}`);
}

const DOWNGRADE_MARKER_KEY = 'profile_chain_backfill_downgraded';

export function up(db: Db): void {
  const delSql = isPostgres ? pg('DELETE FROM settings WHERE key = ?') : 'DELETE FROM settings WHERE key = ?';
  db.prepare(delSql).run(DOWNGRADE_MARKER_KEY);

  const profiles = db.prepare('SELECT id FROM profiles ORDER BY id ASC').all() as { id: number }[];
  if (profiles.length === 0) return;

  const missingSql = isPostgres
    ? pg(`SELECT m.id, f.enabled
      FROM fallback_config f
      JOIN models m ON m.id = f.model_db_id
      LEFT JOIN profile_models pm ON pm.profile_id = ? AND pm.model_db_id = m.id
     WHERE pm.id IS NULL
     ORDER BY f.priority, m.id`)
    : `SELECT m.id, f.enabled
      FROM fallback_config f
      JOIN models m ON m.id = f.model_db_id
      LEFT JOIN profile_models pm ON pm.profile_id = ? AND pm.model_db_id = m.id
     WHERE pm.id IS NULL
     ORDER BY f.priority, m.id`;
  const missing = db.prepare(missingSql);

  const maxPrioritySql = isPostgres
    ? pg('SELECT COALESCE(MAX(priority), 0) AS max_priority FROM profile_models WHERE profile_id = ?')
    : 'SELECT COALESCE(MAX(priority), 0) AS max_priority FROM profile_models WHERE profile_id = ?';
  const maxPriority = db.prepare(maxPrioritySql);

  const insertSql = isPostgres
    ? pg('INSERT INTO profile_models (profile_id, model_db_id, priority, enabled) VALUES (?, ?, ?, ?)')
    : 'INSERT INTO profile_models (profile_id, model_db_id, priority, enabled) VALUES (?, ?, ?, ?)';
  const insert = db.prepare(insertSql);

  for (const profile of profiles) {
    const rows = missing.all(profile.id) as { id: number; enabled: number }[];
    if (rows.length === 0) continue;
    const max = maxPriority.get(profile.id) as { max_priority: number };
    rows.forEach((row, index) => {
      insert.run(profile.id, row.id, max.max_priority + index + 1, row.enabled);
    });
  }
}

export function down(db: Db): void {
  const insertSql = isPostgres
    ? pg(`INSERT INTO settings (key, value)
    VALUES (?, ${isPostgres ? 'NOW()::text' : "datetime('now')"})
    ON CONFLICT(key) DO UPDATE SET value = excluded.value`)
    : `INSERT INTO settings (key, value)
    VALUES (?, datetime('now'))
    ON CONFLICT(key) DO UPDATE SET value = excluded.value`;
  db.prepare(insertSql).run(DOWNGRADE_MARKER_KEY);
}
