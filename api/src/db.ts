import { Pool } from 'pg';
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config';

export const pool = new Pool({
  connectionString: config.databaseUrl,
  max: 10,
  // Managed Postgres (Coolify) sometimes needs no SSL; set PGSSL=require to force it.
  ssl: process.env.PGSSL === 'require' ? { rejectUnauthorized: false } : undefined,
});

export async function q<T = any>(text: string, params: any[] = []): Promise<T[]> {
  const res = await pool.query(text, params);
  return res.rows as T[];
}

export async function one<T = any>(text: string, params: any[] = []): Promise<T | null> {
  const rows = await q<T>(text, params);
  return rows[0] ?? null;
}

export async function tx<T>(fn: (c: any) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('begin');
    const out = await fn(client);
    await client.query('commit');
    return out;
  } catch (e) {
    await client.query('rollback');
    throw e;
  } finally {
    client.release();
  }
}

export async function migrate() {
  const dir = path.join(__dirname, 'sql');
  for (const file of ['schema.sql', 'brand.sql', 'compliance.sql', 'callerids.sql']) {
    const sql = fs.readFileSync(path.join(dir, file), 'utf8');
    await pool.query(sql);
  }
  console.log('[db] schema ready');
}

/**
 * Seed branding from BRAND_* env vars on a fresh install.
 * Once someone saves branding in the UI we never touch it again.
 */
export async function seedBrandFromEnv() {
  const b = config.brand;
  if (!b.name && !b.initials && !b.accent && !b.logoUrl) return;

  const row = await one<any>(`select is_customized from app_brand where id=1`);
  if (!row || row.is_customized) return;

  await pool.query(
    `update app_brand set
        name     = coalesce(nullif($1,''), name),
        initials = coalesce(nullif($2,''), initials),
        accent   = coalesce(nullif($3,''), accent),
        logo_url = coalesce(nullif($4,''), logo_url),
        updated_at = now()
      where id=1`,
    [b.name, b.initials.toUpperCase(), b.accent.toUpperCase(), b.logoUrl],
  );
  console.log('[db] branding seeded from environment');
}
