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
  return columns.some(entry => entry.name === column);
}

export function up(db: Db): void {
  if (!hasColumn(db, 'requests', 'client_agent')) {
    db.prepare('ALTER TABLE requests ADD COLUMN client_agent TEXT').run();
  }
  db.prepare(
    'CREATE INDEX IF NOT EXISTS idx_requests_client_agent_created ON requests(client_agent, created_at)',
  ).run();

  if (isPostgres) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS url_tokens (
        id SERIAL PRIMARY KEY,
        token_hash TEXT NOT NULL UNIQUE,
        label TEXT NOT NULL DEFAULT '',
        token_prefix TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        last_used_at TIMESTAMPTZ,
        revoked_at TIMESTAMPTZ
      );
      CREATE INDEX IF NOT EXISTS idx_url_tokens_active
        ON url_tokens(token_hash, revoked_at);
    `);
  } else {
    db.exec(`
      CREATE TABLE IF NOT EXISTS url_tokens (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        token_hash TEXT NOT NULL UNIQUE,
        label TEXT NOT NULL DEFAULT '',
        token_prefix TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        last_used_at TEXT,
        revoked_at TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_url_tokens_active
        ON url_tokens(token_hash, revoked_at);
    `);
  }

  const settingsSql = isPostgres
    ? pg("INSERT INTO settings (key, value) VALUES ('ollama_emulation', 'off') ON CONFLICT(key) DO NOTHING")
    : "INSERT INTO settings (key, value) VALUES ('ollama_emulation', 'off') ON CONFLICT(key) DO NOTHING";
  db.prepare(settingsSql).run();
  const settingsSql2 = isPostgres
    ? pg("INSERT INTO settings (key, value) VALUES ('expose_cc_discovery_aliases', '0') ON CONFLICT(key) DO NOTHING")
    : "INSERT INTO settings (key, value) VALUES ('expose_cc_discovery_aliases', '0') ON CONFLICT(key) DO NOTHING";
  db.prepare(settingsSql2).run();
}

export function down(db: Db): void {
  db.prepare('DROP TABLE IF EXISTS url_tokens').run();
  db.prepare('DROP INDEX IF EXISTS idx_requests_client_agent_created').run();
  if (hasColumn(db, 'requests', 'client_agent')) {
    db.prepare('ALTER TABLE requests DROP COLUMN client_agent').run();
  }
  db.prepare(`
    DELETE FROM settings
    WHERE key IN (
      'ollama_emulation',
      'expose_cc_discovery_aliases',
      'gemini_model_map'
    )
  `).run();
}
