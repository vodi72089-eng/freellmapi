// Migration: per-endpoint identity for custom relay models (#651)
// Created: 2026-07-29
//
// DOWN: reversible (throws when duplicates exist — see below)

import type { Db } from '../types.js';

const isPostgres = !!process.env.DATABASE_URL;

function pg(sql: string): string {
  let i = 0;
  return sql.replace(/\?/g, () => `$${++i}`);
}

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
  return columns.some(col => col.name === column);
}

// SQLite path: rebuild the table (SQLite cannot ALTER UNIQUE constraints)
const MODELS_COLUMNS_SQLITE = `
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      platform TEXT NOT NULL,
      model_id TEXT NOT NULL,
      display_name TEXT NOT NULL,
      intelligence_rank INTEGER NOT NULL,
      speed_rank INTEGER NOT NULL,
      size_label TEXT NOT NULL DEFAULT '',
      rpm_limit INTEGER,
      rpd_limit INTEGER,
      tpm_limit INTEGER,
      tpd_limit INTEGER,
      monthly_token_budget TEXT NOT NULL DEFAULT '',
      context_window INTEGER,
      enabled INTEGER NOT NULL DEFAULT 1,
      supports_vision INTEGER NOT NULL DEFAULT 0,
      key_id INTEGER,
      supports_tools INTEGER NOT NULL DEFAULT 0,
      paid_input_per_m REAL,
      paid_output_per_m REAL,
      source TEXT NOT NULL DEFAULT 'catalog'`;

const CARRIED_COLUMNS = [
  'id', 'platform', 'model_id', 'display_name', 'intelligence_rank', 'speed_rank',
  'size_label', 'rpm_limit', 'rpd_limit', 'tpm_limit', 'tpd_limit',
  'monthly_token_budget', 'context_window', 'enabled', 'supports_vision', 'key_id',
  'supports_tools', 'paid_input_per_m', 'paid_output_per_m', 'source',
].join(', ');

function childTablesOfModels(db: Db): string[] {
  if (isPostgres) {
    const tables = db.prepare(`
      SELECT table_name AS name FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name <> 'models'
      ORDER BY table_name
    `).all() as { name: string }[];
    return tables
      .filter(t => {
        const fks = db.prepare(`
          SELECT ccu.table_name AS table
          FROM information_schema.table_constraints tc
          JOIN information_schema.constraint_column_usage ccu
            ON tc.constraint_name = ccu.constraint_name
          WHERE tc.constraint_type = 'FOREIGN KEY'
            AND tc.table_name = $1
            AND ccu.table_name = 'models'
        `).all(t.name) as { table: string }[];
        return fks.length > 0;
      })
      .map(t => t.name);
  }
  const tables = db.prepare(`
    SELECT name FROM sqlite_master
     WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name <> 'models'
     ORDER BY name
  `).all() as { name: string }[];
  return tables
    .filter(t => (db.prepare(`PRAGMA foreign_key_list("${t.name}")`).all() as { table: string }[])
      .some(fk => fk.table === 'models'))
    .map(t => t.name);
}

function rebuildModelsSqlite(db: Db, extraColumns: string, copiedColumns: string, unique: string): void {
  const children = childTablesOfModels(db);
  const seqRow = db.prepare("SELECT seq FROM sqlite_sequence WHERE name = 'models'")
    .get() as { seq: number } | undefined;
  for (const child of children) {
    db.exec(`CREATE TEMP TABLE "_endpoint_identity_${child}" AS SELECT * FROM "${child}"`);
    db.exec(`DELETE FROM "${child}"`);
  }

  db.exec(`
    CREATE TABLE models_endpoint_identity (${MODELS_COLUMNS_SQLITE}${extraColumns},
      ${unique}
    );
    INSERT INTO models_endpoint_identity (${copiedColumns})
      SELECT ${copiedColumns} FROM models;
    DROP TABLE models;
    ALTER TABLE models_endpoint_identity RENAME TO models;
  `);

  if (seqRow) {
    const restored = db.prepare("UPDATE sqlite_sequence SET seq = ? WHERE name = 'models' AND seq < ?")
      .run(seqRow.seq, seqRow.seq);
    if (restored.changes === 0
      && !db.prepare("SELECT 1 FROM sqlite_sequence WHERE name = 'models'").get()) {
      db.prepare("INSERT INTO sqlite_sequence (name, seq) VALUES ('models', ?)").run(seqRow.seq);
    }
  }

  for (const child of children) {
    db.exec(`INSERT INTO "${child}" SELECT * FROM "_endpoint_identity_${child}"`);
    db.exec(`DROP TABLE "_endpoint_identity_${child}"`);
  }
}

function rebuildModelsPostgres(db: Db): void {
  // PostgreSQL: add column and create new unique constraint, drop old one
  if (!hasColumn(db, 'models', 'endpoint_scope')) {
    db.prepare("ALTER TABLE models ADD COLUMN endpoint_scope TEXT NOT NULL DEFAULT ''").run();
  }

  // Drop old unique constraint if it exists, create new one
  db.exec(`
    DO $$
    BEGIN
      IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'models_platform_model_id_key') THEN
        ALTER TABLE models DROP CONSTRAINT models_platform_model_id_key;
      END IF;
    END $$;
  `);
  db.exec(`
    DO $$
    BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'models_platform_model_id_endpoint_scope_key') THEN
        ALTER TABLE models ADD CONSTRAINT models_platform_model_id_endpoint_scope_key
          UNIQUE (platform, model_id, endpoint_scope);
      END IF;
    END $$;
  `);
}

export function up(db: Db): void {
  if (isPostgres) {
    rebuildModelsPostgres(db);
  } else {
    rebuildModelsSqlite(
      db,
      `,\n      endpoint_scope TEXT NOT NULL DEFAULT ''`,
      CARRIED_COLUMNS,
      'UNIQUE(platform, model_id, endpoint_scope)',
    );
  }

  // Backfill: a custom row's scope is the base_url of the key it is bound to.
  const bound = db.prepare(`
    SELECT m.id AS id, k.base_url AS base_url
      FROM models m
      JOIN api_keys k ON k.id = m.key_id AND k.platform = 'custom'
     WHERE m.platform = 'custom' AND k.base_url IS NOT NULL AND k.base_url <> ''
  `).all() as { id: number; base_url: string }[];
  const setScopeSql = isPostgres
    ? pg('UPDATE models SET endpoint_scope = ? WHERE id = ?')
    : 'UPDATE models SET endpoint_scope = ? WHERE id = ?';
  const setScope = db.prepare(setScopeSql);
  for (const row of bound) {
    setScope.run(row.base_url.trim().replace(/\/+$/, ''), row.id);
  }

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_models_endpoint_scope
      ON models(endpoint_scope) WHERE endpoint_scope <> '';
  `);
}

export function down(db: Db): void {
  const collisions = db.prepare(`
    SELECT platform, model_id, COUNT(*) AS n
      FROM models GROUP BY platform, model_id HAVING COUNT(*) > 1
  `).all() as { platform: string; model_id: string; n: number }[];
  if (collisions.length > 0) {
    const sample = collisions.slice(0, 3).map(c => `${c.platform}/${c.model_id} (${c.n})`).join(', ');
    throw new Error(
      `Cannot revert per-endpoint model identity: ${collisions.length} model id(s) exist on more than one endpoint — ${sample}. ` +
      'Delete the duplicate rows (or the extra endpoint) first.',
    );
  }

  db.exec('DROP INDEX IF EXISTS idx_models_endpoint_scope;');

  if (isPostgres) {
    // Drop the 3-column unique constraint, restore 2-column one
    db.exec(`
      DO $$
      BEGIN
        IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'models_platform_model_id_endpoint_scope_key') THEN
          ALTER TABLE models DROP CONSTRAINT models_platform_model_id_endpoint_scope_key;
        END IF;
      END $$;
    `);
    db.exec(`
      DO $$
      BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'models_platform_model_id_key') THEN
          ALTER TABLE models ADD CONSTRAINT models_platform_model_id_key
            UNIQUE (platform, model_id);
        END IF;
      END $$;
    `);
    // Drop endpoint_scope column
    if (hasColumn(db, 'models', 'endpoint_scope')) {
      db.prepare('ALTER TABLE models DROP COLUMN endpoint_scope').run();
    }
  } else {
    rebuildModelsSqlite(db, '', CARRIED_COLUMNS, 'UNIQUE(platform, model_id)');
  }
}
