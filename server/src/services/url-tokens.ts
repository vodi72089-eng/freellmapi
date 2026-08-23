import crypto from 'crypto';
import { getDb, getUnifiedApiKey } from '../db/index.js';
import { PostgresDb } from '../db/postgres.js';
import { timingSafeStringEqual } from '../routes/proxy.js';

const isPostgres = !!process.env.DATABASE_URL;

function hashToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}

export interface UrlTokenRow {
  id: number;
  label: string;
  tokenPrefix: string;
  createdAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
}

export async function listUrlTokens(): Promise<UrlTokenRow[]> {
  const db = getDb();
  let rows: Array<{
    id: number;
    label: string;
    token_prefix: string;
    created_at: string;
    last_used_at: string | null;
    revoked_at: string | null;
  }>;
  if (isPostgres) {
    rows = await (db as PostgresDb).query(
      'SELECT id, label, token_prefix, created_at, last_used_at, revoked_at FROM url_tokens ORDER BY id DESC',
    ) as typeof rows;
  } else {
    rows = db.prepare(`
      SELECT id, label, token_prefix, created_at, last_used_at, revoked_at
      FROM url_tokens
      ORDER BY id DESC
    `).all() as typeof rows;
  }
  return rows.map(row => ({
    id: row.id,
    label: row.label,
    tokenPrefix: row.token_prefix,
    createdAt: row.created_at,
    lastUsedAt: row.last_used_at,
    revokedAt: row.revoked_at,
  }));
}

export async function mintUrlToken(label: string): Promise<UrlTokenRow & { token: string }> {
  const token = `flmurl_${crypto.randomBytes(24).toString('base64url')}`;
  const prefix = `${token.slice(0, 12)}…`;
  const db = getDb();
  if (isPostgres) {
    const result = await (db as PostgresDb).execute(
      'INSERT INTO url_tokens (token_hash, label, token_prefix) VALUES ($1, $2, $3) RETURNING id',
      [hashToken(token), label.trim(), prefix],
    );
    const id = (result.rows?.[0] as { id: number })?.id;
    const rows = await listUrlTokens();
    const row = rows.find(entry => entry.id === id)!;
    return { ...row, token };
  } else {
    const result = db.prepare(`
      INSERT INTO url_tokens (token_hash, label, token_prefix)
      VALUES (?, ?, ?)
    `).run(hashToken(token), label.trim(), prefix);
    const rows = await listUrlTokens();
    const row = rows.find(entry => entry.id === Number(result.lastInsertRowid))!;
    return { ...row, token };
  }
}

export async function revokeUrlToken(id: number): Promise<boolean> {
  const db = getDb();
  if (isPostgres) {
    const result = await (db as PostgresDb).execute(
      'UPDATE url_tokens SET revoked_at = NOW() WHERE id = $1 AND revoked_at IS NULL',
      [id],
    );
    return result.rowCount > 0;
  } else {
    return db.prepare(`
      UPDATE url_tokens SET revoked_at = datetime('now')
      WHERE id = ? AND revoked_at IS NULL
    `).run(id).changes > 0;
  }
}

export async function validateUrlToken(token: string): Promise<boolean> {
  if (!token || timingSafeStringEqual(token, getUnifiedApiKey())) {
    if (token) {
      console.warn('[URL tokens] Rejected a raw unified API key in a tokenized URL');
    }
    return false;
  }
  const hash = hashToken(token);
  const db = getDb();
  let row: { id: number } | undefined;
  if (isPostgres) {
    row = await (db as PostgresDb).queryOne(
      'SELECT id FROM url_tokens WHERE token_hash = $1 AND revoked_at IS NULL',
      [hash],
    ) as { id: number } | undefined;
  } else {
    row = db.prepare(`
      SELECT id FROM url_tokens
      WHERE token_hash = ? AND revoked_at IS NULL
    `).get(hash) as { id: number } | undefined;
  }
  if (!row) return false;
  if (isPostgres) {
    await (db as PostgresDb).execute(
      'UPDATE url_tokens SET last_used_at = NOW() WHERE id = $1',
      [row.id],
    );
  } else {
    db.prepare(
      "UPDATE url_tokens SET last_used_at = datetime('now') WHERE id = ?",
    ).run(row.id);
  }
  return true;
}
