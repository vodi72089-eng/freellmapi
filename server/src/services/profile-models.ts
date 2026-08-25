import type { Db } from '../db/types.js';
import { PostgresDb } from '../db/postgres.js';

const isPostgres = !!process.env.DATABASE_URL;

export async function getActiveProfileId(db: Db): Promise<number | null> {
  let setting: { value: string } | undefined;
  if (isPostgres) {
    setting = await (db as PostgresDb).queryOne("SELECT value FROM settings WHERE key = 'active_profile_id'") as { value: string } | undefined;
  } else {
    setting = db.prepare("SELECT value FROM settings WHERE key = 'active_profile_id'").get() as { value: string } | undefined;
  }
  if (!setting) return null;
  const profileId = parseInt(setting.value, 10);
  if (!Number.isInteger(profileId)) return null;
  let profile: { id: number } | undefined;
  if (isPostgres) {
    profile = await (db as PostgresDb).queryOne('SELECT id FROM profiles WHERE id = $1', [profileId]) as { id: number } | undefined;
  } else {
    profile = db.prepare('SELECT id FROM profiles WHERE id = ?').get(profileId) as { id: number } | undefined;
  }
  return profile ? profileId : null;
}

export async function ensureModelInProfiles(db: Db, modelDbId: number): Promise<void> {
  let profiles: { id: number }[];
  let fallback: { enabled: number } | undefined;
  if (isPostgres) {
    profiles = await (db as PostgresDb).query('SELECT id FROM profiles ORDER BY id ASC') as { id: number }[];
    fallback = await (db as PostgresDb).queryOne('SELECT enabled FROM fallback_config WHERE model_db_id = $1', [modelDbId]) as { enabled: number } | undefined;
  } else {
    profiles = db.prepare('SELECT id FROM profiles ORDER BY id ASC').all() as { id: number }[];
    fallback = db.prepare('SELECT enabled FROM fallback_config WHERE model_db_id = ?').get(modelDbId) as { enabled: number } | undefined;
  }
  if (!fallback) return;

  for (const profile of profiles) {
    let exists: any;
    if (isPostgres) {
      exists = await (db as PostgresDb).queryOne('SELECT 1 FROM profile_models WHERE profile_id = $1 AND model_db_id = $2', [profile.id, modelDbId]);
    } else {
      exists = db.prepare('SELECT 1 FROM profile_models WHERE profile_id = ? AND model_db_id = ?').get(profile.id, modelDbId);
    }
    if (exists) continue;

    let max: { max_priority: number };
    if (isPostgres) {
      max = await (db as PostgresDb).queryOne('SELECT COALESCE(MAX(priority), 0) AS max_priority FROM profile_models WHERE profile_id = $1', [profile.id]) as { max_priority: number };
      await (db as PostgresDb).execute('INSERT INTO profile_models (profile_id, model_db_id, priority, enabled) VALUES ($1, $2, $3, $4)', [profile.id, modelDbId, max.max_priority + 1, fallback.enabled]);
    } else {
      max = db.prepare('SELECT COALESCE(MAX(priority), 0) AS max_priority FROM profile_models WHERE profile_id = ?').get(profile.id) as { max_priority: number };
      db.prepare('INSERT INTO profile_models (profile_id, model_db_id, priority, enabled) VALUES (?, ?, ?, ?)').run(profile.id, modelDbId, max.max_priority + 1, fallback.enabled);
    }
  }
}

export async function ensureAllModelsInProfiles(db: Db): Promise<void> {
  let profiles: { id: number }[];
  if (isPostgres) {
    profiles = await (db as PostgresDb).query('SELECT id FROM profiles ORDER BY id ASC') as { id: number }[];
  } else {
    profiles = db.prepare('SELECT id FROM profiles ORDER BY id ASC').all() as { id: number }[];
  }
  if (profiles.length === 0) return;

  for (const profile of profiles) {
    let rows: { id: number; enabled: number }[];
    if (isPostgres) {
      rows = await (db as PostgresDb).query(`
        SELECT m.id, f.enabled
          FROM fallback_config f
          JOIN models m ON m.id = f.model_db_id
          LEFT JOIN profile_models pm ON pm.profile_id = $1 AND pm.model_db_id = m.id
         WHERE pm.id IS NULL
         ORDER BY f.priority, m.id
      `, [profile.id]) as { id: number; enabled: number }[];
    } else {
      const missing = db.prepare(`
        SELECT m.id, f.enabled
          FROM fallback_config f
          JOIN models m ON m.id = f.model_db_id
          LEFT JOIN profile_models pm ON pm.profile_id = ? AND pm.model_db_id = m.id
         WHERE pm.id IS NULL
         ORDER BY f.priority, m.id
      `);
      rows = missing.all(profile.id) as { id: number; enabled: number }[];
    }
    if (rows.length === 0) continue;

    let max: { max_priority: number };
    if (isPostgres) {
      max = await (db as PostgresDb).queryOne('SELECT COALESCE(MAX(priority), 0) AS max_priority FROM profile_models WHERE profile_id = $1', [profile.id]) as { max_priority: number };
    } else {
      max = db.prepare('SELECT COALESCE(MAX(priority), 0) AS max_priority FROM profile_models WHERE profile_id = ?').get(profile.id) as { max_priority: number };
    }
    for (let i = 0; i < rows.length; i++) {
      if (isPostgres) {
        await (db as PostgresDb).execute('INSERT INTO profile_models (profile_id, model_db_id, priority, enabled) VALUES ($1, $2, $3, $4)', [profile.id, rows[i].id, max.max_priority + i + 1, rows[i].enabled]);
      } else {
        db.prepare('INSERT INTO profile_models (profile_id, model_db_id, priority, enabled) VALUES (?, ?, ?, ?)').run(profile.id, rows[i].id, max.max_priority + i + 1, rows[i].enabled);
      }
    }
  }
}
