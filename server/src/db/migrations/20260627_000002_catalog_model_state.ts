import type { Db } from '../types.js';

const isPostgres = !!process.env.DATABASE_URL;

export function up(db: Db): void {
  if (isPostgres) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS catalog_model_tombstones (
        kind TEXT NOT NULL DEFAULT 'chat',
        platform TEXT NOT NULL,
        model_id TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (kind, platform, model_id)
      );

      CREATE TABLE IF NOT EXISTS model_overrides (
        platform TEXT NOT NULL,
        model_id TEXT NOT NULL,
        overrides_json TEXT NOT NULL DEFAULT '{}',
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (platform, model_id)
      );

      CREATE INDEX IF NOT EXISTS idx_catalog_model_tombstones_platform_model
        ON catalog_model_tombstones(platform, model_id);
    `);
  } else {
    db.exec(`
      CREATE TABLE IF NOT EXISTS catalog_model_tombstones (
        kind TEXT NOT NULL DEFAULT 'chat',
        platform TEXT NOT NULL,
        model_id TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        PRIMARY KEY (kind, platform, model_id)
      );

      CREATE TABLE IF NOT EXISTS model_overrides (
        platform TEXT NOT NULL,
        model_id TEXT NOT NULL,
        overrides_json TEXT NOT NULL DEFAULT '{}',
        updated_at TEXT NOT NULL DEFAULT (datetime('now')),
        PRIMARY KEY (platform, model_id)
      );

      CREATE INDEX IF NOT EXISTS idx_catalog_model_tombstones_platform_model
        ON catalog_model_tombstones(platform, model_id);
    `);
  }
}

export function down(db: Db): void {
  db.exec(`
    DROP INDEX IF EXISTS idx_catalog_model_tombstones_platform_model;
    DROP TABLE IF EXISTS model_overrides;
    DROP TABLE IF EXISTS catalog_model_tombstones;
  `);
}
