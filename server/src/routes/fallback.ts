/**
 * Express router handles model fallback configuration and token budget reporting.
 * It integrates named profiles dynamically into the fallback routing logic and aggregates
 * monthly token consumption and rate limits (RPM/RPD/TPM/TPD) across configured models.
 */
import { Router } from 'express';
import type { Request, Response } from 'express';
import { z } from 'zod';
import { getDb } from '../db/index.js';
import { PostgresDb } from '../db/postgres.js';
import { getAllPenalties, getRoutingScores, getRoutingStrategy, setRoutingStrategy, setCustomWeights, getExploreEnabled, setExploreEnabled } from '../services/router.js';
import { BANDIT_PRESETS, type RoutingStrategy } from '../services/scoring.js';
import { parseBudget } from '../lib/budget.js';
import { getModelGroups } from '../services/model-groups.js';
import { getPenaltyInspector } from '../services/penalty-inspector.js';
import { getActiveProfileId } from '../services/profile-models.js';
import { qualifiedModelMemberId } from '../lib/endpoint-scope.js';
import { overriddenFieldNames } from '../services/model-state.js';

const isPostgres = !!process.env.DATABASE_URL;

export const fallbackRouter = Router();

fallbackRouter.get('/routing', (_req: Request, res: Response) => {
  res.json(getRoutingScores());
});

fallbackRouter.get('/penalty-inspector', (_req: Request, res: Response) => {
  res.json(getPenaltyInspector());
});

const routingSchema = z.object({
  strategy: z.enum(['priority', 'balanced', 'smartest', 'fastest', 'reliable', 'custom']),
  weights: z.object({
    reliability: z.number().nonnegative(),
    speed: z.number().nonnegative(),
    intelligence: z.number().nonnegative(),
  }).optional(),
  exploreEnabled: z.boolean().optional(),
});

fallbackRouter.put('/routing', (req: Request, res: Response) => {
  const parsed = routingSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: { message: parsed.error.errors.map(e => e.message).join(', ') } });
    return;
  }
  if (parsed.data.weights) {
    try {
      setCustomWeights(parsed.data.weights);
    } catch (err: any) {
      res.status(400).json({ error: { message: err?.message ?? 'Invalid custom weights' } });
      return;
    }
  }
  setRoutingStrategy(parsed.data.strategy as RoutingStrategy);
  if (parsed.data.exploreEnabled !== undefined) {
    setExploreEnabled(parsed.data.exploreEnabled);
  }
  res.json({ strategy: getRoutingStrategy(), exploreEnabled: getExploreEnabled(), presets: BANDIT_PRESETS });
});

// Get fallback chain (with dynamic penalties)
fallbackRouter.get('/', async (_req: Request, res: Response) => {
  const db = getDb();
  const activeProfileId = await getActiveProfileId(db);
  let rows: any[] = [];

  if (activeProfileId != null) {
    if (isPostgres) {
      rows = await (db as PostgresDb).query(`
        SELECT pm.model_db_id, pm.priority, pm.enabled,
               m.platform, m.model_id, m.display_name, m.intelligence_rank,
               m.speed_rank, m.size_label, m.rpm_limit, m.rpd_limit,
               m.tpm_limit, m.tpd_limit, m.context_window,
               m.monthly_token_budget, m.supports_vision, m.supports_tools,
               m.key_id, m.endpoint_scope, ak.label AS key_label,
               mo.overrides_json IS NOT NULL AS has_overrides,
               mo.overrides_json,
               ts.source AS tombstone_source, ts.reason AS tombstone_reason
        FROM profile_models pm
        JOIN models m ON m.id = pm.model_db_id
        LEFT JOIN api_keys ak ON ak.id = m.key_id
        LEFT JOIN model_overrides mo ON mo.platform = m.platform AND mo.model_id = m.model_id
        LEFT JOIN catalog_model_tombstones ts
          ON ts.kind = 'chat' AND ts.platform = m.platform AND ts.model_id = m.model_id
        WHERE pm.profile_id = $1 AND m.enabled = 1
        ORDER BY pm.priority ASC
      `, [activeProfileId]);
    } else {
      rows = db.prepare(`
        SELECT pm.model_db_id, pm.priority, pm.enabled,
               m.platform, m.model_id, m.display_name, m.intelligence_rank,
               m.speed_rank, m.size_label, m.rpm_limit, m.rpd_limit,
               m.tpm_limit, m.tpd_limit, m.context_window,
               m.monthly_token_budget, m.supports_vision, m.supports_tools,
               m.key_id, m.endpoint_scope, ak.label AS key_label,
               mo.overrides_json IS NOT NULL AS has_overrides,
               mo.overrides_json,
               ts.source AS tombstone_source, ts.reason AS tombstone_reason
        FROM profile_models pm
        JOIN models m ON m.id = pm.model_db_id
        LEFT JOIN api_keys ak ON ak.id = m.key_id
        LEFT JOIN model_overrides mo ON mo.platform = m.platform AND mo.model_id = m.model_id
        LEFT JOIN catalog_model_tombstones ts
          ON ts.kind = 'chat' AND ts.platform = m.platform AND ts.model_id = m.model_id
        WHERE pm.profile_id = ? AND m.enabled = 1
        ORDER BY pm.priority ASC
      `).all(activeProfileId) as any[];
    }
  }

  if (rows.length === 0) {
    if (isPostgres) {
      rows = await (db as PostgresDb).query(`
        SELECT fc.model_db_id, fc.priority, fc.enabled,
               m.platform, m.model_id, m.display_name, m.intelligence_rank,
               m.speed_rank, m.size_label, m.rpm_limit, m.rpd_limit,
               m.tpm_limit, m.tpd_limit, m.context_window,
               m.monthly_token_budget, m.supports_vision, m.supports_tools,
               m.key_id, m.endpoint_scope, ak.label AS key_label,
               mo.overrides_json IS NOT NULL AS has_overrides,
               mo.overrides_json,
               ts.source AS tombstone_source, ts.reason AS tombstone_reason
        FROM fallback_config fc
        JOIN models m ON m.id = fc.model_db_id
        LEFT JOIN api_keys ak ON ak.id = m.key_id
        LEFT JOIN model_overrides mo ON mo.platform = m.platform AND mo.model_id = m.model_id
        LEFT JOIN catalog_model_tombstones ts
          ON ts.kind = 'chat' AND ts.platform = m.platform AND ts.model_id = m.model_id
        WHERE m.enabled = 1
        ORDER BY fc.priority ASC
      `);
    } else {
      rows = db.prepare(`
        SELECT fc.model_db_id, fc.priority, fc.enabled,
               m.platform, m.model_id, m.display_name, m.intelligence_rank,
               m.speed_rank, m.size_label, m.rpm_limit, m.rpd_limit,
               m.tpm_limit, m.tpd_limit, m.context_window,
               m.monthly_token_budget, m.supports_vision, m.supports_tools,
               m.key_id, m.endpoint_scope, ak.label AS key_label,
               mo.overrides_json IS NOT NULL AS has_overrides,
               mo.overrides_json,
               ts.source AS tombstone_source, ts.reason AS tombstone_reason
        FROM fallback_config fc
        JOIN models m ON m.id = fc.model_db_id
        LEFT JOIN api_keys ak ON ak.id = m.key_id
        LEFT JOIN model_overrides mo ON mo.platform = m.platform AND mo.model_id = m.model_id
        LEFT JOIN catalog_model_tombstones ts
          ON ts.kind = 'chat' AND ts.platform = m.platform AND ts.model_id = m.model_id
        WHERE m.enabled = 1
        ORDER BY fc.priority ASC
      `).all() as any[];
    }
  }

  let keyCounts: { platform: string; count: number }[];
  if (isPostgres) {
    keyCounts = await (db as PostgresDb).query(`
      SELECT platform, COUNT(*) as count
      FROM api_keys WHERE enabled = 1 AND status IN ('healthy', 'unknown')
      GROUP BY platform
    `) as { platform: string; count: number }[];
  } else {
    keyCounts = db.prepare(`
      SELECT platform, COUNT(*) as count
      FROM api_keys WHERE enabled = 1 AND status IN ('healthy', 'unknown')
      GROUP BY platform
    `).all() as { platform: string; count: number }[];
  }
  const keyCountMap = new Map(keyCounts.map(k => [k.platform, k.count]));

  const penalties = getAllPenalties();
  const penaltyMap = new Map(penalties.map(p => [p.modelDbId, p]));

  const groupByDbId = new Map<number, { groupKey: string; canonicalId: string; groupLabel: string }>();
  for (const g of getModelGroups()) {
    for (const m of g.members) {
      groupByDbId.set(m.model_db_id, { groupKey: g.groupKey, canonicalId: g.canonicalId, groupLabel: g.groupLabel });
    }
  }

  res.json(rows.map(r => {
    const penalty = penaltyMap.get(r.model_db_id);
    const group = groupByDbId.get(r.model_db_id);
    return {
      modelDbId: r.model_db_id,
      groupKey: group?.groupKey,
      canonicalId: group?.canonicalId,
      groupLabel: group?.groupLabel,
      priority: r.priority,
      effectivePriority: r.priority + (penalty?.penalty ?? 0),
      penalty: penalty?.penalty ?? 0,
      rateLimitHits: penalty?.count ?? 0,
      enabled: r.enabled === 1,
      platform: r.platform,
      modelId: r.model_id,
      displayName: r.display_name,
      intelligenceRank: r.intelligence_rank,
      speedRank: r.speed_rank,
      sizeLabel: r.size_label,
      rpmLimit: r.rpm_limit,
      rpdLimit: r.rpd_limit,
      tpmLimit: r.tpm_limit,
      tpdLimit: r.tpd_limit,
      contextWindow: r.context_window,
      monthlyTokenBudget: r.monthly_token_budget,
      monthlyTokenBudgetTokens: parseBudget(r.monthly_token_budget) * Math.max(1, keyCountMap.get(r.platform) ?? 1),
      supportsVision: r.supports_vision === 1,
      supportsTools: r.supports_tools === 1,
      source: r.platform === 'custom' || r.key_id != null ? 'custom' : 'catalog',
      keyId: r.key_id ?? null,
      keyLabel: r.key_label ?? null,
      endpointScope: r.endpoint_scope || null,
      qualifiedModelId: qualifiedModelMemberId(r.platform, r.model_id, r.endpoint_scope),
      hasOverrides: Boolean(r.has_overrides),
      overrideFields: overriddenFieldNames(r.overrides_json),
      retiredUpstream: r.tombstone_source === 'upstream_eol',
      retiredReason: r.tombstone_source === 'upstream_eol' ? (r.tombstone_reason ?? null) : null,
      keyCount: keyCountMap.get(r.platform) ?? 0,
    };
  }));
});

const updateSchema = z.array(z.object({
  modelDbId: z.number(),
  priority: z.number(),
  enabled: z.boolean(),
}));

// Update fallback chain (full replace)
fallbackRouter.put('/', async (req: Request, res: Response) => {
  const parsed = updateSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: { message: parsed.error.errors.map(e => e.message).join(', ') } });
    return;
  }

  const db = getDb();
  const activeProfileId = await getActiveProfileId(db);
  let useProfile = false;
  if (activeProfileId != null) {
    if (isPostgres) {
      useProfile = Boolean(await (db as PostgresDb).queryOne('SELECT 1 FROM profile_models WHERE profile_id = $1 LIMIT 1', [activeProfileId]));
    } else {
      useProfile = Boolean(db.prepare('SELECT 1 FROM profile_models WHERE profile_id = ? LIMIT 1').get(activeProfileId));
    }
  }

  if (isPostgres) {
    await (db as PostgresDb).transactionAsync(async (client) => {
      for (const entry of parsed.data) {
        if (useProfile) {
          await client.query('UPDATE profile_models SET priority = $1, enabled = $2 WHERE profile_id = $3 AND model_db_id = $4',
            [entry.priority, entry.enabled ? 1 : 0, activeProfileId, entry.modelDbId]);
        } else {
          await client.query('UPDATE fallback_config SET priority = $1, enabled = $2 WHERE model_db_id = $3',
            [entry.priority, entry.enabled ? 1 : 0, entry.modelDbId]);
        }
      }
    });
  } else {
    const update = useProfile
      ? db.prepare('UPDATE profile_models SET priority = ?, enabled = ? WHERE profile_id = ? AND model_db_id = ?')
      : db.prepare('UPDATE fallback_config SET priority = ?, enabled = ? WHERE model_db_id = ?');
    const updateAll = db.transaction(() => {
      for (const entry of parsed.data) {
        if (useProfile) update.run(entry.priority, entry.enabled ? 1 : 0, activeProfileId, entry.modelDbId);
        else update.run(entry.priority, entry.enabled ? 1 : 0, entry.modelDbId);
      }
    });
    updateAll();
  }

  res.json({ success: true });
});

const INTELLIGENCE_TIER =
  "CASE m.size_label WHEN 'Frontier' THEN 1 WHEN 'Large' THEN 2 WHEN 'Medium' THEN 3 WHEN 'Small' THEN 4 ELSE 5 END";

const SORT_PRESETS: Record<string, string> = {
  intelligence: `${INTELLIGENCE_TIER} ASC, m.intelligence_rank ASC`,
  speed: 'm.speed_rank ASC',
};

function getBudgetScore(m: { monthly_token_budget: string; tpd_limit: number | null }): number {
  if (m.tpd_limit != null) return m.tpd_limit * 30;
  const str = m.monthly_token_budget;
  if (!str) return 0;
  if (str.toLowerCase().includes('unlimited') || str.includes('\u221E')) return Infinity;
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

fallbackRouter.post('/sort/:preset', async (req: Request, res: Response) => {
  const preset = String(req.params.preset);
  const db = getDb();
  let models: { id: number }[] = [];
  const activeProfileId = await getActiveProfileId(db);
  let useProfile = false;
  if (activeProfileId != null) {
    if (isPostgres) {
      useProfile = Boolean(await (db as PostgresDb).queryOne('SELECT 1 FROM profile_models WHERE profile_id = $1 LIMIT 1', [activeProfileId]));
    } else {
      useProfile = Boolean(db.prepare('SELECT 1 FROM profile_models WHERE profile_id = ? LIMIT 1').get(activeProfileId));
    }
  }

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
      res.status(400).json({ error: { message: `Unknown preset: ${preset}. Use: intelligence, speed, budget` } });
      return;
    }
    if (isPostgres) {
      models = await (db as PostgresDb).query(`SELECT m.id FROM models m ORDER BY ${orderBy}`) as { id: number }[];
    } else {
      models = db.prepare(`SELECT m.id FROM models m ORDER BY ${orderBy}`).all() as { id: number }[];
    }
  }

  if (isPostgres) {
    await (db as PostgresDb).transactionAsync(async (client) => {
      for (let i = 0; i < models.length; i++) {
        if (useProfile) {
          await client.query('UPDATE profile_models SET priority = $1 WHERE profile_id = $2 AND model_db_id = $3', [i + 1, activeProfileId, models[i].id]);
        } else {
          await client.query('UPDATE fallback_config SET priority = $1 WHERE model_db_id = $2', [i + 1, models[i].id]);
        }
      }
    });
  } else {
    const update = useProfile
      ? db.prepare('UPDATE profile_models SET priority = ? WHERE profile_id = ? AND model_db_id = ?')
      : db.prepare('UPDATE fallback_config SET priority = ? WHERE model_db_id = ?');
    const reorder = db.transaction(() => {
      for (let i = 0; i < models.length; i++) {
        if (useProfile) update.run(i + 1, activeProfileId, models[i].id);
        else update.run(i + 1, models[i].id);
      }
    });
    reorder();
  }

  res.json({ success: true, preset });
});

// Token usage per model for the stacked bar
fallbackRouter.get('/token-usage', async (_req: Request, res: Response) => {
  const db = getDb();

  let platforms: { platform: string }[];
  if (isPostgres) {
    platforms = await (db as PostgresDb).query(`SELECT DISTINCT ak.platform FROM api_keys ak WHERE ak.enabled = 1`) as { platform: string }[];
  } else {
    platforms = db.prepare(`SELECT DISTINCT ak.platform FROM api_keys ak WHERE ak.enabled = 1`).all() as { platform: string }[];
  }
  const platformSet = new Set(platforms.map(p => p.platform));

  let settingRow: { value: string } | undefined;
  if (isPostgres) {
    settingRow = await (db as PostgresDb).queryOne(`SELECT value FROM settings WHERE key = 'active_profile_id'`) as { value: string } | undefined;
  } else {
    settingRow = db.prepare(`SELECT value FROM settings WHERE key = 'active_profile_id'`).get() as { value: string } | undefined;
  }
  const activeProfileId = settingRow ? (parseInt(settingRow.value) || null) : null;

  let activeProfile: any = null;
  if (activeProfileId) {
    if (isPostgres) {
      activeProfile = await (db as PostgresDb).queryOne('SELECT id FROM profiles WHERE id = $1', [activeProfileId]);
    } else {
      activeProfile = db.prepare('SELECT id FROM profiles WHERE id = ?').get(activeProfileId);
    }
  }

  let rawModels: any[];

  if (activeProfile) {
    if (isPostgres) {
      rawModels = await (db as PostgresDb).query(`
        SELECT m.id as model_db_id, m.platform, m.model_id, m.display_name, m.monthly_token_budget,
               pm.priority, pm.enabled,
               m.rpm_limit, m.rpd_limit, m.tpm_limit, m.tpd_limit
        FROM profile_models pm
        JOIN models m ON m.id = pm.model_db_id
        WHERE pm.profile_id = $1 AND m.enabled = 1
        ORDER BY pm.priority ASC
      `, [activeProfileId]) as any[];
    } else {
      rawModels = db.prepare(`
        SELECT m.id as model_db_id, m.platform, m.model_id, m.display_name, m.monthly_token_budget,
               pm.priority, pm.enabled,
               m.rpm_limit, m.rpd_limit, m.tpm_limit, m.tpd_limit
        FROM profile_models pm
        JOIN models m ON m.id = pm.model_db_id
        WHERE pm.profile_id = ? AND m.enabled = 1
        ORDER BY pm.priority ASC
      `).all(activeProfileId) as any[];
    }
  } else {
    if (isPostgres) {
      rawModels = await (db as PostgresDb).query(`
        SELECT m.id as model_db_id, m.platform, m.model_id, m.display_name, m.monthly_token_budget,
               fc.priority, fc.enabled,
               m.rpm_limit, m.rpd_limit, m.tpm_limit, m.tpd_limit
        FROM fallback_config fc
        JOIN models m ON m.id = fc.model_db_id
        WHERE m.enabled = 1
        ORDER BY fc.priority ASC
      `) as any[];
    } else {
      rawModels = db.prepare(`
        SELECT m.id as model_db_id, m.platform, m.model_id, m.display_name, m.monthly_token_budget,
               fc.priority, fc.enabled,
               m.rpm_limit, m.rpd_limit, m.tpm_limit, m.tpd_limit
        FROM fallback_config fc
        JOIN models m ON m.id = fc.model_db_id
        WHERE m.enabled = 1
        ORDER BY fc.priority ASC
      `).all() as any[];
    }
  }

  let usageRows: { platform: string; model_id: string; used: number }[];
  if (isPostgres) {
    usageRows = await (db as PostgresDb).query(`
      SELECT platform, model_id, COALESCE(SUM(input_tokens + output_tokens), 0) AS used
      FROM requests
      WHERE created_at >= (DATE_TRUNC('month', NOW()))
        AND request_type = 'chat'
      GROUP BY platform, model_id
    `) as { platform: string; model_id: string; used: number }[];
  } else {
    usageRows = db.prepare(`
      SELECT platform, model_id, COALESCE(SUM(input_tokens + output_tokens), 0) AS used
      FROM requests
      WHERE created_at >= datetime('now', 'start of month')
        AND request_type = 'chat'
      GROUP BY platform, model_id
    `).all() as { platform: string; model_id: string; used: number }[];
  }
  const usageByModel = new Map(usageRows.map(r => [`${r.platform}:${r.model_id}`, r.used]));

  let keyCountRows: { platform: string; count: number }[];
  if (isPostgres) {
    keyCountRows = await (db as PostgresDb).query("SELECT platform, COUNT(*) as count FROM api_keys WHERE enabled = 1 AND status IN ('healthy', 'unknown') GROUP BY platform") as { platform: string; count: number }[];
  } else {
    keyCountRows = db.prepare("SELECT platform, COUNT(*) as count FROM api_keys WHERE enabled = 1 AND status IN ('healthy', 'unknown') GROUP BY platform").all() as { platform: string; count: number }[];
  }
  const keyCountMap = new Map(keyCountRows.map(k => [k.platform, k.count]));

  const modelBudgets = rawModels
    .filter(m => platformSet.has(m.platform))
    .map(m => {
      const keys = Math.max(1, keyCountMap.get(m.platform) ?? 1);
      return {
        modelDbId: m.model_db_id,
        displayName: m.display_name,
        platform: m.platform,
        modelId: m.model_id,
        budget: parseBudget(m.monthly_token_budget) * keys,
        used: usageByModel.get(`${m.platform}:${m.model_id}`) ?? 0,
        enabled: m.enabled === 1,
        rpmLimit: m.rpm_limit,
        rpdLimit: m.rpd_limit,
        tpmLimit: m.tpm_limit,
        tpdLimit: m.tpd_limit,
      };
    });

  const totalBudget = modelBudgets.reduce((s, m) => s + m.budget, 0);
  const totalUsed = modelBudgets.reduce((s, m) => s + m.used, 0);

  res.json({
    totalBudget,
    totalUsed,
    models: modelBudgets,
  });
});
