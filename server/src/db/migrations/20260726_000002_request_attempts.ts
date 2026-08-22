import type { Db } from '../types.js';

const isPostgres = !!process.env.DATABASE_URL;

export function up(db: Db): void {
  if (isPostgres) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS request_attempts (
        id SERIAL PRIMARY KEY,
        request_id INTEGER NOT NULL REFERENCES requests(id) ON DELETE CASCADE,
        ordinal INTEGER NOT NULL,
        platform TEXT NOT NULL,
        model_id TEXT NOT NULL,
        key_ordinal INTEGER NOT NULL,
        outcome TEXT NOT NULL,
        start_offset_ms INTEGER NOT NULL DEFAULT 0,
        duration_ms INTEGER NOT NULL DEFAULT 0
      );

      CREATE INDEX IF NOT EXISTS idx_request_attempts_request_id
        ON request_attempts(request_id, ordinal);
    `);
  } else {
    db.exec(`
      CREATE TABLE IF NOT EXISTS request_attempts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        request_id INTEGER NOT NULL REFERENCES requests(id) ON DELETE CASCADE,
        ordinal INTEGER NOT NULL,
        platform TEXT NOT NULL,
        model_id TEXT NOT NULL,
        key_ordinal INTEGER NOT NULL,
        outcome TEXT NOT NULL,
        start_offset_ms INTEGER NOT NULL DEFAULT 0,
        duration_ms INTEGER NOT NULL DEFAULT 0
      );

      CREATE INDEX IF NOT EXISTS idx_request_attempts_request_id
        ON request_attempts(request_id, ordinal);
    `);
  }
}

export function down(db: Db): void {
  db.exec(`
    DROP INDEX IF EXISTS idx_request_attempts_request_id;
    DROP TABLE IF EXISTS request_attempts;
  `);
}
