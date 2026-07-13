/**
 * Auto-create DB tables on startup using raw SQL.
 * Also migrates any sessions stored as JSON-string-within-JSONB to proper JSONB.
 */
import { env } from '../config.js';

async function migrate() {
  if (!env.DATABASE_URL || env.DATABASE_URL.includes('localhost')) {
    console.log('[DB] No remote DATABASE_URL — using file storage');
    return;
  }
  try {
    const postgres = (await import('postgres')).default;
    const sql = postgres(env.DATABASE_URL, { max: 1 });

    await sql`CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      data JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )`;

    // Fix any sessions stored as JSON string instead of JSONB object
    // #>> '{}' extracts text from JSON string, then ::jsonb re-parses as object
    await sql`
      UPDATE sessions SET data = (data #>> '{}')::jsonb
      WHERE data::text LIKE '"{%'
    `;

    await sql.end({ timeout: 3 });
    console.log('[DB] Tables ready');
  } catch (e: any) {
    console.error('[DB] Migration error:', e?.message?.slice(0, 100));
    console.log('[DB] Falling back to file storage');
  }
}

migrate().catch(() => console.warn('[DB] Migration skipped'));
