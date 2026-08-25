import { Router } from 'express';
import type { Request, Response } from 'express';
import { z } from 'zod';
import { getDb } from '../db/index.js';
import { PostgresDb } from '../db/postgres.js';
import { encrypt, decrypt, maskKey } from '../lib/crypto.js';
import { mintClientProfileKey, hashClientProfileKey } from '../lib/system-prompt.js';

const isPostgres = !!process.env.DATABASE_URL;

// Client-profile CRUD (#411), mounted under /api/client-profiles behind the
// dashboard session gate like every other admin route. The full `sk-cp-...`
// key is returned exactly once — from create and rotate; the list endpoint
// only ever shows the masked form (rendered from the encrypted copy, since
// the auth path stores nothing but a hash).

export const clientProfilesRouter = Router();

const MAX_NAME_LEN = 100;
// Generous ceiling — a system prompt is configuration, not a document.
const MAX_PROMPT_LEN = 32_000;

const createSchema = z.object({
  name: z.string().trim().min(1).max(MAX_NAME_LEN),
  systemPrompt: z.string().max(MAX_PROMPT_LEN).nullish(),
});

const updateSchema = z.object({
  name: z.string().trim().min(1).max(MAX_NAME_LEN).optional(),
  // null clears the prompt (the profile key then authenticates without
  // injecting anything); absent leaves it untouched.
  systemPrompt: z.string().max(MAX_PROMPT_LEN).nullable().optional(),
  enabled: z.boolean().optional(),
});

interface ProfileRow {
  id: number;
  name: string;
  encrypted_key: string;
  iv: string;
  auth_tag: string;
  system_prompt: string | null;
  enabled: number;
  created_at: string;
  updated_at: string;
}

function maskedKeyFor(row: Pick<ProfileRow, 'encrypted_key' | 'iv' | 'auth_tag'>): string {
  try {
    return maskKey(decrypt(row.encrypted_key, row.iv, row.auth_tag));
  } catch {
    return '[decrypt failed]';
  }
}

function toJson(row: ProfileRow) {
  return {
    id: row.id,
    name: row.name,
    maskedKey: maskedKeyFor(row),
    systemPrompt: row.system_prompt,
    enabled: row.enabled === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

async function getProfile(id: number): Promise<ProfileRow | undefined> {
  const db = getDb();
  if (isPostgres) {
    return await (db as PostgresDb).queryOne('SELECT * FROM client_profiles WHERE id = $1', [id]) as ProfileRow | undefined;
  }
  return db.prepare('SELECT * FROM client_profiles WHERE id = ?').get(id) as ProfileRow | undefined;
}

function parseId(req: Request, res: Response): number | null {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) {
    res.status(400).json({ error: { message: 'Invalid profile id' } });
    return null;
  }
  return id;
}

function notFound(res: Response): void {
  res.status(404).json({ error: { message: 'Client profile not found' } });
}

clientProfilesRouter.get('/', async (_req: Request, res: Response) => {
  const db = getDb();
  let rows: ProfileRow[];
  if (isPostgres) {
    rows = await (db as PostgresDb).query('SELECT * FROM client_profiles ORDER BY id') as ProfileRow[];
  } else {
    rows = db.prepare('SELECT * FROM client_profiles ORDER BY id').all() as ProfileRow[];
  }
  res.json(rows.map(toJson));
});

clientProfilesRouter.post('/', async (req: Request, res: Response) => {
  const parsed = createSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: { message: 'A profile name is required' } });
    return;
  }
  const key = mintClientProfileKey();
  const { encrypted, iv, authTag } = encrypt(key);
  const prompt = parsed.data.systemPrompt?.trim() || null;
  const db = getDb();
  let profileId: number;
  if (isPostgres) {
    const row = await (db as PostgresDb).queryOne(
      `INSERT INTO client_profiles (name, token_hash, encrypted_key, iv, auth_tag, system_prompt)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
      [parsed.data.name, hashClientProfileKey(key), encrypted, iv, authTag, prompt]
    ) as { id: number };
    profileId = row.id;
  } else {
    const info = db.prepare(`
      INSERT INTO client_profiles (name, token_hash, encrypted_key, iv, auth_tag, system_prompt)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(parsed.data.name, hashClientProfileKey(key), encrypted, iv, authTag, prompt);
    profileId = Number(info.lastInsertRowid);
  }
  const row = (await getProfile(profileId))!;
  // The only time the full key leaves the server (besides rotate).
  res.status(201).json({ ...toJson(row), key });
});

clientProfilesRouter.patch('/:id', async (req: Request, res: Response) => {
  const id = parseId(req, res);
  if (id === null) return;
  const parsed = updateSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: { message: 'Invalid profile update' } });
    return;
  }
  const row = await getProfile(id);
  if (!row) return notFound(res);

  const { name, systemPrompt, enabled } = parsed.data;
  const nextPrompt = systemPrompt === undefined
    ? row.system_prompt
    : (systemPrompt?.trim() || null);
  const db = getDb();
  if (isPostgres) {
    await (db as PostgresDb).execute(`
      UPDATE client_profiles
      SET name = $1, system_prompt = $2, enabled = $3, updated_at = NOW()
      WHERE id = $4
    `, [
      name ?? row.name,
      nextPrompt,
      enabled === undefined ? row.enabled : (enabled ? 1 : 0),
      id,
    ]);
  } else {
    db.prepare(`
      UPDATE client_profiles
      SET name = ?, system_prompt = ?, enabled = ?, updated_at = datetime('now')
      WHERE id = ?
    `).run(
      name ?? row.name,
      nextPrompt,
      enabled === undefined ? row.enabled : (enabled ? 1 : 0),
      id,
    );
  }
  res.json(toJson((await getProfile(id))!));
});

clientProfilesRouter.post('/:id/rotate', async (req: Request, res: Response) => {
  const id = parseId(req, res);
  if (id === null) return;
  const row = await getProfile(id);
  if (!row) return notFound(res);

  const key = mintClientProfileKey();
  const { encrypted, iv, authTag } = encrypt(key);
  const db = getDb();
  if (isPostgres) {
    await (db as PostgresDb).execute(`
      UPDATE client_profiles
      SET token_hash = $1, encrypted_key = $2, iv = $3, auth_tag = $4, updated_at = NOW()
      WHERE id = $5
    `, [hashClientProfileKey(key), encrypted, iv, authTag, id]);
  } else {
    db.prepare(`
      UPDATE client_profiles
      SET token_hash = ?, encrypted_key = ?, iv = ?, auth_tag = ?, updated_at = datetime('now')
      WHERE id = ?
    `).run(hashClientProfileKey(key), encrypted, iv, authTag, id);
  }
  res.json({ ...toJson((await getProfile(id))!), key });
});

clientProfilesRouter.delete('/:id', async (req: Request, res: Response) => {
  const id = parseId(req, res);
  if (id === null) return;
  const db = getDb();
  if (isPostgres) {
    const result = await (db as PostgresDb).execute('DELETE FROM client_profiles WHERE id = $1', [id]);
    if (result.rowCount === 0) return notFound(res);
  } else {
    const info = db.prepare('DELETE FROM client_profiles WHERE id = ?').run(id);
    if (info.changes === 0) return notFound(res);
  }
  res.json({ success: true });
});
