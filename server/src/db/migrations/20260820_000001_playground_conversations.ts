import type { Db } from '../types.js';

const isPostgres = !!process.env.DATABASE_URL;

export function up(db: Db): void {
  if (isPostgres) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS playground_conversations (
        id SERIAL PRIMARY KEY,
        title TEXT NOT NULL DEFAULT '',
        messages_json TEXT NOT NULL DEFAULT '[]',
        model TEXT,
        system_prompt TEXT,
        created_at_ms INTEGER NOT NULL,
        updated_at_ms INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_playground_conversations_updated
        ON playground_conversations(updated_at_ms DESC);
    `);
  } else {
    db.exec(`
      CREATE TABLE IF NOT EXISTS playground_conversations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        title TEXT NOT NULL DEFAULT '',
        messages_json TEXT NOT NULL DEFAULT '[]',
        model TEXT,
        system_prompt TEXT,
        created_at_ms INTEGER NOT NULL,
        updated_at_ms INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_playground_conversations_updated
        ON playground_conversations(updated_at_ms DESC);
    `);
  }
}

export function down(db: Db): void {
  db.exec(`
    DROP INDEX IF EXISTS idx_playground_conversations_updated;
    DROP TABLE IF EXISTS playground_conversations;
  `);
}
