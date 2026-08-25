/**
 * Express router handles CRUD endpoints for named model fallback profiles.
 * Profiles allow users to maintain different prioritized chains of LLMs.
 * Features include metadata updates, reordering fallback priority, auto-sorting presets,
 * and built-in safety blocks to prevent modification of default settings.
 */
import { Router } from 'express';
import type { Request, Response } from 'express';
import { z } from 'zod';
import { getDb } from '../db/index.js';
import { PostgresDb } from '../db/postgres.js';

const isPostgres = !!process.env.DATABASE_URL;

export const profilesRouter = Router();

const RESERVED_PROFILE_NAMES = [
  'auto', 'smart', 'fast', 'cheap', 'budget',
  'intelligence', 'speed', 'active', 'default',
];

const profileNameSchema = z
  .string()
  .min(1, 'Profile name cannot be empty')
  .max(20, 'Profile name must not exceed 20 characters')
  .regex(
    /^[a-zA-Z0-9-_]+$/,
    'Only Latin letters, digits, hyphens (-) and underscores (_) are allowed'
  )
  .refine(
    (name) => !RESERVED_PROFILE_NAMES.includes(name.toLowerCase()),
    'This name is reserved by the system'
  );

const createSchema = z.object({
  name: profileNameSchema,
  emoji: z.string().max(4).default(''),
  color: z.string().default('#6366f1'),
  sourceProfileId: z.number().optional(),
});

const updateSchema = z.object({
  name: profileNameSchema.optional(),
  emoji: z.string().max(4).optional(),
  color: z.string().optional(),
  is_favorite: z.boolean().optional(),
  sort_order: z.number().optional(),
  auto_sort: z.enum(['intelligence', 'speed', 'budget']).nullable().optional(),
  layout_config: z.string().nullable().optional(),
});

function getId(req: Request): number {
  return parseInt(req.params.id as string);
}

/**
 * GET /api/profiles
 * Fetches all available profiles. 
 * Sorting order: Default profile first -> Favorited profiles -> Custom sorting order.
 */
profilesRouter.get('/', async (_req: Request, res: Response) => {
  const db = getDb();
  let profiles;
  if (isPostgres) {
    profiles = await (db as PostgresDb).query(`
      SELECT id, name, emoji, color, type, is_favorite, sort_order, auto_sort, layout_config, created_at
      FROM profiles
      ORDER BY (CASE WHEN type = 'default' THEN 1 ELSE 0 END) DESC, is_favorite DESC, sort_order ASC, id ASC
    `);
  } else {
    profiles = db.prepare(`
      SELECT id, name, emoji, color, type, is_favorite, sort_order, auto_sort, layout_config, created_at
      FROM profiles
      ORDER BY (CASE WHEN type = 'default' THEN 1 ELSE 0 END) DESC, is_favorite DESC, sort_order ASC, id ASC
    `).all();
  }
  res.json(profiles);
});

// GET /api/profiles/active — get the currently active profile id
profilesRouter.get('/active', async (_req: Request, res: Response) => {
  const db = getDb();
  let row: { value: string } | undefined;
  if (isPostgres) {
    row = await (db as PostgresDb).queryOne(`SELECT value FROM settings WHERE key = 'active_profile_id'`) as { value: string } | undefined;
  } else {
    row = db.prepare(`SELECT value FROM settings WHERE key = 'active_profile_id'`).get() as { value: string } | undefined;
  }
  const activeProfileId = row ? (parseInt(row.value) || null) : null;
  res.json({ activeProfileId });
});

// POST /api/profiles/active — set or clear the active profile
profilesRouter.post('/active', async (req: Request, res: Response) => {
  const db = getDb();
  const profileId = req.body?.profileId;

  if (profileId === null || profileId === undefined) {
    if (isPostgres) {
      await (db as PostgresDb).execute(`DELETE FROM settings WHERE key = 'active_profile_id'`);
    } else {
      db.prepare(`DELETE FROM settings WHERE key = 'active_profile_id'`).run();
    }
    res.json({ activeProfileId: null });
    return;
  }

  let profile: any;
  if (isPostgres) {
    profile = await (db as PostgresDb).queryOne('SELECT id FROM profiles WHERE id = $1', [Number(profileId)]);
  } else {
    profile = db.prepare('SELECT id FROM profiles WHERE id = ?').get(Number(profileId));
  }
  if (!profile) {
    res.status(404).json({ error: { message: 'Profile not found' } });
    return;
  }

  if (isPostgres) {
    await (db as PostgresDb).execute(`
      INSERT INTO settings (key, value) VALUES ('active_profile_id', $1)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `, [String(profileId)]);
  } else {
    db.prepare(`
      INSERT INTO settings (key, value) VALUES ('active_profile_id', ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `).run(String(profileId));
  }
  res.json({ activeProfileId: Number(profileId) });
});

// GET /api/profiles/:id/models — get profile model order
profilesRouter.get('/:id/models', async (req: Request, res: Response) => {
  const db = getDb();
  const profileId = getId(req);
  let profile: any;
  if (isPostgres) {
    profile = await (db as PostgresDb).queryOne('SELECT id FROM profiles WHERE id = $1', [profileId]);
  } else {
    profile = db.prepare('SELECT id FROM profiles WHERE id = ?').get(profileId);
  }
  if (!profile) {
    res.status(404).json({ error: { message: 'Profile not found' } });
    return;
  }

  let rows: any[];
  if (isPostgres) {
    rows = await (db as PostgresDb).query(`
      SELECT pm.model_db_id, pm.priority, pm.enabled,
             m.platform, m.model_id, m.display_name, m.intelligence_rank,
             m.speed_rank, m.size_label, m.rpm_limit, m.rpd_limit,
             m.tpm_limit, m.tpd_limit,
             m.monthly_token_budget
      FROM profile_models pm
      JOIN models m ON m.id = pm.model_db_id
      WHERE pm.profile_id = $1 AND m.enabled = 1
      ORDER BY pm.priority ASC
    `, [profileId]);
  } else {
    rows = db.prepare(`
      SELECT pm.model_db_id, pm.priority, pm.enabled,
             m.platform, m.model_id, m.display_name, m.intelligence_rank,
             m.speed_rank, m.size_label, m.rpm_limit, m.rpd_limit,
             m.tpm_limit, m.tpd_limit,
             m.monthly_token_budget
      FROM profile_models pm
      JOIN models m ON m.id = pm.model_db_id
      WHERE pm.profile_id = ? AND m.enabled = 1
      ORDER BY pm.priority ASC
    `).all(profileId) as any[];
  }

  // Normalize SQLite 0/1 integers to proper booleans for TypeScript client
  res.json(rows.map((r: any) => ({ ...r, enabled: r.enabled === 1 })));
});

/**
 * POST /api/profiles
 * Creates a new custom profile.
 * Allows optional cloning of the active profile's model priority and layout configuration.
 */
profilesRouter.post('/', async (req: Request, res: Response) => {
  const parsed = createSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: { message: parsed.error.errors.map(e => e.message).join(', ') } });
    return;
  }

  const db = getDb();
  const { name, emoji, color, sourceProfileId } = parsed.data;

  // Check for case-insensitive duplicate profile names
  let duplicate: any;
  if (isPostgres) {
    duplicate = await (db as PostgresDb).queryOne('SELECT id FROM profiles WHERE LOWER(name) = LOWER($1)', [name]);
  } else {
    duplicate = db.prepare('SELECT id FROM profiles WHERE LOWER(name) = LOWER(?)').get(name);
  }
  if (duplicate) {
    res.status(409).json({ error: { message: `Profile with name '${name}' already exists` } });
    return;
  }

  let maxOrder: number;
  if (isPostgres) {
    const mxRow = await (db as PostgresDb).queryOne('SELECT COALESCE(MAX(sort_order), 0) AS mx FROM profiles') as { mx: number };
    maxOrder = mxRow.mx;
  } else {
    maxOrder = (db.prepare('SELECT COALESCE(MAX(sort_order), 0) AS mx FROM profiles').get() as { mx: number }).mx;
  }

  let layoutConfig: string | null = null;
  let autoSort: string | null = null;
  if (sourceProfileId) {
    let source: any;
    if (isPostgres) {
      source = await (db as PostgresDb).queryOne('SELECT layout_config, auto_sort FROM profiles WHERE id = $1', [sourceProfileId]);
    } else {
      source = db.prepare('SELECT layout_config, auto_sort FROM profiles WHERE id = ?').get(sourceProfileId);
    }
    if (source) {
      layoutConfig = source.layout_config;
      autoSort = source.auto_sort;
    }
  }

  let profileId: number;
  if (isPostgres) {
    const result = await (db as PostgresDb).queryOne(
      `INSERT INTO profiles (name, emoji, color, type, sort_order, layout_config, auto_sort)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
      [name, emoji, color, 'custom', maxOrder + 1, layoutConfig, autoSort]
    ) as { id: number };
    profileId = result.id;
  } else {
    const result = db.prepare(
      'INSERT INTO profiles (name, emoji, color, type, sort_order, layout_config, auto_sort) VALUES (?, ?, ?, ?, ?, ?, ?)'
    ).run(name, emoji, color, 'custom', maxOrder + 1, layoutConfig, autoSort);
    profileId = result.lastInsertRowid as number;
  }

  if (sourceProfileId) {
    let source: any;
    if (isPostgres) {
      source = await (db as PostgresDb).queryOne('SELECT id FROM profiles WHERE id = $1', [sourceProfileId]);
    } else {
      source = db.prepare('SELECT id FROM profiles WHERE id = ?').get(sourceProfileId);
    }
    if (!source) {
      await copyFromDefault(db, profileId);
    } else {
      if (isPostgres) {
        await (db as PostgresDb).execute(`
          INSERT INTO profile_models (profile_id, model_db_id, priority, enabled)
          SELECT $1, model_db_id, priority, enabled
          FROM profile_models
          WHERE profile_id = $2
          ORDER BY priority ASC
        `, [profileId, sourceProfileId]);
      } else {
        db.prepare(`
          INSERT INTO profile_models (profile_id, model_db_id, priority, enabled)
          SELECT ?, model_db_id, priority, enabled
          FROM profile_models
          WHERE profile_id = ?
          ORDER BY priority ASC
        `).run(profileId, sourceProfileId);
      }
    }
  } else {
    await copyFromDefault(db, profileId);
  }

  let created: any;
  if (isPostgres) {
    created = await (db as PostgresDb).queryOne('SELECT id, name, emoji, color, type, is_favorite, sort_order, auto_sort, layout_config, created_at FROM profiles WHERE id = $1', [profileId]);
  } else {
    created = db.prepare('SELECT id, name, emoji, color, type, is_favorite, sort_order, auto_sort, layout_config, created_at FROM profiles WHERE id = ?').get(profileId);
  }
  res.status(201).json(created);
});

async function copyFromDefault(db: any, profileId: number) {
  if (isPostgres) {
    await (db as PostgresDb).execute(`
      INSERT INTO profile_models (profile_id, model_db_id, priority, enabled)
      SELECT $1, model_db_id, priority, enabled
      FROM fallback_config
      ORDER BY priority ASC
    `, [profileId]);
  } else {
    db.prepare(`
      INSERT INTO profile_models (profile_id, model_db_id, priority, enabled)
      SELECT ?, model_db_id, priority, enabled
      FROM fallback_config
      ORDER BY priority ASC
    `).run(profileId);
  }
}

// PUT /api/profiles/:id — update profile metadata
profilesRouter.put('/:id', async (req: Request, res: Response) => {
  const db = getDb();
  const profileId = getId(req);
  let profile: any;
  if (isPostgres) {
    profile = await (db as PostgresDb).queryOne('SELECT id, type FROM profiles WHERE id = $1', [profileId]);
  } else {
    profile = db.prepare('SELECT id, type FROM profiles WHERE id = ?').get(profileId);
  }
  if (!profile) {
    res.status(404).json({ error: { message: 'Profile not found' } });
    return;
  }

  const parsed = updateSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: { message: parsed.error.errors.map(e => e.message).join(', ') } });
    return;
  }

  // Check for case-insensitive duplicate profile names when editing name
  if (parsed.data.name !== undefined) {
    let duplicate: any;
    if (isPostgres) {
      duplicate = await (db as PostgresDb).queryOne('SELECT id FROM profiles WHERE LOWER(name) = LOWER($1) AND id != $2', [parsed.data.name, profileId]);
    } else {
      duplicate = db.prepare('SELECT id FROM profiles WHERE LOWER(name) = LOWER(?) AND id != ?').get(parsed.data.name, profileId);
    }
    if (duplicate) {
      res.status(409).json({ error: { message: `Profile with name '${parsed.data.name}' already exists` } });
      return;
    }
  }

  const isProtected = profile.type === 'default' || profile.type === 'builtin';
  const updates: string[] = [];
  const values: any[] = [];
  for (const [key, value] of Object.entries(parsed.data)) {
    if (value !== undefined) {
      // Block name/emoji/color edits on protected profiles
      if (isProtected && (key === 'name' || key === 'emoji' || key === 'color')) {
        continue;
      }
      if (key === 'is_favorite') {
        updates.push(isPostgres ? `${key} = $${updates.length + 1}` : `${key} = ?`);
        values.push(value ? 1 : 0);
      } else {
        updates.push(isPostgres ? `${key} = $${updates.length + 1}` : `${key} = ?`);
        values.push(value);
      }
    }
  }

  if (updates.length > 0) {
    values.push(profileId);
    if (isPostgres) {
      await (db as PostgresDb).execute(`UPDATE profiles SET ${updates.join(', ')} WHERE id = $${values.length}`, values);
    } else {
      db.prepare(`UPDATE profiles SET ${updates.join(', ')} WHERE id = ?`).run(...values);
    }
  }

  // If auto_sort was updated to a preset, automatically physically sort the models in DB
  if (parsed.data.auto_sort) {
    await sortProfileModels(db, profileId, parsed.data.auto_sort);
  }

  let updated: any;
  if (isPostgres) {
    updated = await (db as PostgresDb).queryOne('SELECT id, name, emoji, color, type, is_favorite, sort_order, auto_sort, layout_config, created_at FROM profiles WHERE id = $1', [profileId]);
  } else {
    updated = db.prepare('SELECT id, name, emoji, color, type, is_favorite, sort_order, auto_sort, layout_config, created_at FROM profiles WHERE id = ?').get(profileId);
  }
  res.json(updated);
});

// PUT /api/profiles/:id/reorder — update model order + enabled for a profile
const reorderSchema = z.array(z.object({
  modelDbId: z.number(),
  priority: z.number(),
  enabled: z.boolean(),
}));

profilesRouter.put('/:id/reorder', async (req: Request, res: Response) => {
  const db = getDb();
  const profileId = getId(req);
  let profile: any;
  if (isPostgres) {
    profile = await (db as PostgresDb).queryOne('SELECT id FROM profiles WHERE id = $1', [profileId]);
  } else {
    profile = db.prepare('SELECT id FROM profiles WHERE id = ?').get(profileId);
  }
  if (!profile) {
    res.status(404).json({ error: { message: 'Profile not found' } });
    return;
  }

  const parsed = reorderSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: { message: parsed.error.errors.map(e => e.message).join(', ') } });
    return;
  }

  if (isPostgres) {
    await (db as PostgresDb).transactionAsync(async (client) => {
      await client.query('DELETE FROM profile_models WHERE profile_id = $1', [profileId]);
      for (const entry of parsed.data) {
        await client.query('INSERT INTO profile_models (profile_id, model_db_id, priority, enabled) VALUES ($1, $2, $3, $4)', [profileId, entry.modelDbId, entry.priority, entry.enabled ? 1 : 0]);
      }
    });
  } else {
    const transaction = db.transaction(() => {
      db.prepare('DELETE FROM profile_models WHERE profile_id = ?').run(profileId);
      const insert = db.prepare('INSERT INTO profile_models (profile_id, model_db_id, priority, enabled) VALUES (?, ?, ?, ?)');
      for (const entry of parsed.data) {
        insert.run(profileId, entry.modelDbId, entry.priority, entry.enabled ? 1 : 0);
      }
    });
    transaction();
  }

  res.json({ success: true });
});

// POST /api/profiles/:id/reset — reset a profile to fallback baseline
profilesRouter.post('/:id/reset', async (req: Request, res: Response) => {
  const db = getDb();
  const profileId = getId(req);
  let profile: any;
  if (isPostgres) {
    profile = await (db as PostgresDb).queryOne('SELECT id FROM profiles WHERE id = $1', [profileId]);
  } else {
    profile = db.prepare('SELECT id FROM profiles WHERE id = ?').get(profileId);
  }
  if (!profile) {
    res.status(404).json({ error: { message: 'Profile not found' } });
    return;
  }

  const baselineLayout = JSON.stringify({
    viewMode: "list",
    compactMode: false,
    limitsMode: false,
    limitsVariant: "circle",
    sortDisabledToBottom: false,
    kanbanLayout: [{ id: "board-default", type: "board", title: "Default", emoji: "📋", color: "rgb(99, 102, 241)", collapsed: false, items: [] }],
    tierLayout: [{ id: "tier-default", type: "tier", title: "Default", emoji: "📋", color: "rgb(99, 102, 241)", collapsed: false, items: [] }]
  });

  if (isPostgres) {
    await (db as PostgresDb).transactionAsync(async (client) => {
      await client.query('UPDATE profiles SET layout_config = $1, auto_sort = NULL WHERE id = $2', [baselineLayout, profileId]);
      await client.query('DELETE FROM profile_models WHERE profile_id = $1', [profileId]);
      await client.query(`
        INSERT INTO profile_models (profile_id, model_db_id, priority, enabled)
        SELECT $1, model_db_id, priority, enabled
        FROM fallback_config
        ORDER BY priority ASC
      `, [profileId]);
    });
  } else {
    const transaction = db.transaction(() => {
      db.prepare('UPDATE profiles SET layout_config = ?, auto_sort = NULL WHERE id = ?').run(baselineLayout, profileId);
      db.prepare('DELETE FROM profile_models WHERE profile_id = ?').run(profileId);
      db.prepare(`
        INSERT INTO profile_models (profile_id, model_db_id, priority, enabled)
        SELECT ?, model_db_id, priority, enabled
        FROM fallback_config
        ORDER BY priority ASC
      `).run(profileId);
    });
    transaction();
  }

  let updated: any;
  if (isPostgres) {
    updated = await (db as PostgresDb).queryOne('SELECT id, name, emoji, color, type, is_favorite, sort_order, auto_sort, layout_config, created_at FROM profiles WHERE id = $1', [profileId]);
  } else {
    updated = db.prepare('SELECT id, name, emoji, color, type, is_favorite, sort_order, auto_sort, layout_config, created_at FROM profiles WHERE id = ?').get(profileId);
  }
  res.json(updated);
});

// DELETE /api/profiles/:id — delete a profile
profilesRouter.delete('/:id', async (req: Request, res: Response) => {
  const db = getDb();
  const profileId = getId(req);
  let profile: any;
  if (isPostgres) {
    profile = await (db as PostgresDb).queryOne('SELECT id, type FROM profiles WHERE id = $1', [profileId]);
  } else {
    profile = db.prepare('SELECT id, type FROM profiles WHERE id = ?').get(profileId);
  }
  if (!profile) {
    res.status(404).json({ error: { message: 'Profile not found' } });
    return;
  }
  if (profile.type === 'default' || profile.type === 'builtin') {
    res.status(400).json({ error: { message: 'Cannot delete the default profile' } });
    return;
  }
  let count: { cnt: number };
  if (isPostgres) {
    count = await (db as PostgresDb).queryOne('SELECT COUNT(*) as cnt FROM profiles') as { cnt: number };
  } else {
    count = db.prepare('SELECT COUNT(*) as cnt FROM profiles').get() as { cnt: number };
  }
  if (count.cnt <= 1) {
    res.status(400).json({ error: { message: 'Cannot delete the last profile' } });
    return;
  }

  // If the deleted profile is the currently active one, switch to Default
  let activeRow: { value: string } | undefined;
  if (isPostgres) {
    activeRow = await (db as PostgresDb).queryOne(`SELECT value FROM settings WHERE key = 'active_profile_id'`) as { value: string } | undefined;
  } else {
    activeRow = db.prepare(`SELECT value FROM settings WHERE key = 'active_profile_id'`).get() as { value: string } | undefined;
  }
  const activeId = activeRow ? parseInt(activeRow.value) : null;

  if (isPostgres) {
    await (db as PostgresDb).execute('DELETE FROM profiles WHERE id = $1', [profileId]);
  } else {
    db.prepare('DELETE FROM profiles WHERE id = ?').run(profileId);
  }

  if (activeId === profileId) {
    let defaultProf: { id: number } | undefined;
    if (isPostgres) {
      defaultProf = await (db as PostgresDb).queryOne("SELECT id FROM profiles WHERE type = 'default' OR type = 'builtin' ORDER BY id ASC LIMIT 1") as { id: number } | undefined;
    } else {
      defaultProf = db.prepare("SELECT id FROM profiles WHERE type = 'default' OR type = 'builtin' ORDER BY id ASC LIMIT 1").get() as { id: number } | undefined;
    }
    let fallbackId: number | undefined;
    if (defaultProf) {
      fallbackId = defaultProf.id;
    } else {
      if (isPostgres) {
        const fb = await (db as PostgresDb).queryOne('SELECT id FROM profiles ORDER BY sort_order ASC LIMIT 1') as { id: number } | undefined;
        fallbackId = fb?.id;
      } else {
        fallbackId = (db.prepare('SELECT id FROM profiles ORDER BY sort_order ASC LIMIT 1').get() as { id: number })?.id;
      }
    }
    if (fallbackId) {
      if (isPostgres) {
        await (db as PostgresDb).execute(`INSERT INTO settings (key, value) VALUES ('active_profile_id', $1) ON CONFLICT(key) DO UPDATE SET value = excluded.value`, [String(fallbackId)]);
      } else {
        db.prepare(`INSERT INTO settings (key, value) VALUES ('active_profile_id', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(String(fallbackId));
      }
    }
  }

  res.json({ success: true });
});

// POST /api/profiles/:id/sort/:preset — sort models in a profile by a preset
const SORT_PRESETS: Record<string, string> = {
  intelligence: 'm.intelligence_rank ASC',
  speed: 'm.speed_rank ASC',
};

function getBudgetScore(m: { monthly_token_budget: string; tpd_limit: number | null }): number {
  if (m.tpd_limit != null) return m.tpd_limit * 30;
  
  const str = m.monthly_token_budget;
  if (!str) return 0;
  if (str.toLowerCase().includes('unlimited') || str.includes('∞')) return Infinity;
  
  const cleanStr = str.split('(')[0];
  const matches = cleanStr.match(/[\d.]+/g);
  let maxNum = 0;
  if (matches) {
    maxNum = Math.max(...matches.map(mStr => parseFloat(mStr)));
  }
  
  let mult = 1;
  const upper = cleanStr.toUpperCase();
  if (upper.includes('B')) mult = 1_000_000_000;
  else if (upper.includes('M')) mult = 1_000_000;
  else if (upper.includes('K')) mult = 1_000;

  return maxNum * mult;
}

async function sortProfileModels(db: any, profileId: number, preset: string) {
  let models: { id: number }[] = [];

  if (preset === 'budget') {
    let allModels: any[];
    if (isPostgres) {
      allModels = await (db as PostgresDb).query(`SELECT id, monthly_token_budget, tpd_limit FROM models`);
    } else {
      allModels = db.prepare(`SELECT id, monthly_token_budget, tpd_limit FROM models`).all() as any[];
    }
    allModels.sort((a, b) => getBudgetScore(b) - getBudgetScore(a));
    models = allModels.map(m => ({ id: m.id }));
  } else {
    const orderBy = SORT_PRESETS[preset];
    if (!orderBy) {
      throw new Error(`Unknown preset: ${preset}. Use: intelligence, speed, budget`);
    }
    if (isPostgres) {
      models = await (db as PostgresDb).query(`SELECT m.id FROM models m ORDER BY ${orderBy}`) as { id: number }[];
    } else {
      models = db.prepare(`SELECT m.id FROM models m ORDER BY ${orderBy}`).all() as { id: number }[];
    }
  }

  // Preserve existing enabled flags so sorting doesn't reset disabled models
  let existing: { model_db_id: number; enabled: number }[];
  if (isPostgres) {
    existing = await (db as PostgresDb).query(`
      SELECT model_db_id, enabled FROM profile_models WHERE profile_id = $1
    `, [profileId]) as { model_db_id: number; enabled: number }[];
  } else {
    existing = db.prepare(`
      SELECT model_db_id, enabled FROM profile_models WHERE profile_id = ?
    `).all(profileId) as { model_db_id: number; enabled: number }[];
  }
  const enabledMap = new Map(existing.map(e => [e.model_db_id, e.enabled]));

  if (isPostgres) {
    await (db as PostgresDb).transactionAsync(async (client) => {
      await client.query('DELETE FROM profile_models WHERE profile_id = $1', [profileId]);
      for (let i = 0; i < models.length; i++) {
        const enabled = enabledMap.has(models[i].id) ? enabledMap.get(models[i].id) : 1;
        await client.query('INSERT INTO profile_models (profile_id, model_db_id, priority, enabled) VALUES ($1, $2, $3, $4)', [profileId, models[i].id, i + 1, enabled]);
      }
    });
  } else {
    const transaction = db.transaction(() => {
      db.prepare('DELETE FROM profile_models WHERE profile_id = ?').run(profileId);
      const insert = db.prepare('INSERT INTO profile_models (profile_id, model_db_id, priority, enabled) VALUES (?, ?, ?, ?)');
      for (let i = 0; i < models.length; i++) {
        const enabled = enabledMap.has(models[i].id) ? enabledMap.get(models[i].id) : 1;
        insert.run(profileId, models[i].id, i + 1, enabled);
      }
    });
    transaction();
  }
}

profilesRouter.post('/:id/sort/:preset', async (req: Request, res: Response) => {
  const db = getDb();
  const profileId = getId(req);
  let profile: any;
  if (isPostgres) {
    profile = await (db as PostgresDb).queryOne('SELECT id FROM profiles WHERE id = $1', [profileId]);
  } else {
    profile = db.prepare('SELECT id FROM profiles WHERE id = ?').get(profileId);
  }
  if (!profile) {
    res.status(404).json({ error: { message: 'Profile not found' } });
    return;
  }

  const preset = String(req.params.preset);
  
  try {
    await sortProfileModels(db, profileId, preset);
    res.json({ success: true, preset });
  } catch (error: any) {
    res.status(400).json({ error: { message: error.message } });
  }
});

// Initialize built-in profiles if they don't exist
export async function seedProfiles(db: any): Promise<void> {
  let count: { cnt: number };
  if (isPostgres) {
    count = await (db as PostgresDb).queryOne("SELECT COUNT(*) as cnt FROM profiles WHERE type = 'default' OR type = 'builtin'") as { cnt: number };
  } else {
    count = db.prepare("SELECT COUNT(*) as cnt FROM profiles WHERE type = 'default' OR type = 'builtin'").get() as { cnt: number };
  }
  if (count.cnt > 0) return;

  const builtins: Array<{
    name: string;
    emoji: string;
    color: string;
    profileType: string;
    modelScores: Array<{ namePattern: string; score: number }>;
  }> = [
      {
        name: 'Default',
        emoji: '⭐',
        color: '#6366f1',
        profileType: 'default',
        modelScores: [
          { namePattern: 'gpt-4o', score: 3 },
          { namePattern: 'qwen3-coder', score: 2 },
          { namePattern: 'gemini', score: 1 },
        ],
      }
    ];

  if (isPostgres) {
    await (db as PostgresDb).transactionAsync(async (client) => {
      for (const builtin of builtins) {
        const result = await client.query(
          'INSERT INTO profiles (name, emoji, color, type, sort_order) VALUES ($1, $2, $3, $4, $5) RETURNING id',
          [builtin.name, builtin.emoji, builtin.color, builtin.profileType, -1]
        ) as any;
        const profileId = result.rows[0].id;

        const modelsResult = await client.query('SELECT id, LOWER(display_name) as name FROM models ORDER BY id ASC');
        const models = modelsResult.rows as { id: number; name: string }[];

        const scored = models.map(m => {
          let score = 0;
          for (const s of builtin.modelScores) {
            if (m.name.includes(s.namePattern)) {
              score = s.score;
              break;
            }
          }
          return { ...m, score };
        });

        scored.sort((a, b) => {
          if (b.score !== a.score) return b.score - a.score;
          return a.name.localeCompare(b.name);
        });

        for (let i = 0; i < scored.length; i++) {
          await client.query('INSERT INTO profile_models (profile_id, model_db_id, priority, enabled) VALUES ($1, $2, $3, $4)', [profileId, scored[i].id, i + 1, 1]);
        }

        // Set the default active profile
        await client.query(`
          INSERT INTO settings (key, value) VALUES ('active_profile_id', $1)
          ON CONFLICT(key) DO UPDATE SET value = excluded.value
        `, [String(profileId)]);
      }
    });
  } else {
    const insertProfile = db.prepare('INSERT INTO profiles (name, emoji, color, type, sort_order) VALUES (?, ?, ?, ?, ?)');
    const insertModel = db.prepare('INSERT INTO profile_models (profile_id, model_db_id, priority, enabled) VALUES (?, ?, ?, ?)');

    const seed = db.transaction(() => {
      for (const builtin of builtins) {
        const result = insertProfile.run(builtin.name, builtin.emoji, builtin.color, builtin.profileType, -1);
        const profileId = result.lastInsertRowid as number;

        const models = db.prepare('SELECT id, LOWER(display_name) as name FROM models ORDER BY id ASC').all() as { id: number; name: string }[];

        const scored = models.map(m => {
          let score = 0;
          for (const s of builtin.modelScores) {
            if (m.name.includes(s.namePattern)) {
              score = s.score;
              break;
            }
          }
          return { ...m, score };
        });

        scored.sort((a, b) => {
          if (b.score !== a.score) return b.score - a.score;
          return a.name.localeCompare(b.name);
        });

        for (let i = 0; i < scored.length; i++) {
          insertModel.run(profileId, scored[i].id, i + 1, 1);
        }

        // Set the default active profile
        db.prepare(`
          INSERT INTO settings (key, value) VALUES ('active_profile_id', ?)
          ON CONFLICT(key) DO UPDATE SET value = excluded.value
        `).run(String(profileId));
      }
    });
    seed();
  }

  console.log(`Seeded Default profile`);
}