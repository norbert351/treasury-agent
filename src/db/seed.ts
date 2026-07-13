/**
 * One-time migration tool: exports a local session to Render's DB.
 * Run: DATABASE_URL=<render_db_url> npx tsx src/db/seed.ts
 */
import { readFileSync, existsSync } from 'fs';
import { env } from '../config.js';

const SESSION_ID = 'f391fe91-3dd1-7b76-9652-ed86e5f50650';

async function seed() {
  if (!env.DATABASE_URL || env.DATABASE_URL.includes('localhost')) {
    console.log('Set DATABASE_URL to your Render PostgreSQL URL');
    process.exit(1);
  }

  // Load local session file
  const sessionFile = `sphere-data/sessions/${SESSION_ID}/session.json`;
  if (!existsSync(sessionFile)) {
    console.log(`Session file not found: ${sessionFile}`);
    console.log('Run this from the local server (not Render)');
    process.exit(1);
  }

  const data = JSON.parse(readFileSync(sessionFile, 'utf8'));
  console.log(`Loaded session ${SESSION_ID}: ${data.rules?.length || 0} rules, ${data.transactions?.length || 0} transactions`);

  // Connect to Render's PostgreSQL
  const postgres = (await import('postgres')).default;
  const sql = postgres(env.DATABASE_URL, { max: 1 });

  // Ensure table exists
  await sql`CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    data JSONB NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
  )`;

  // Insert or update — pass JS object, NOT JSON.stringify (postgres lib handles JSONB)
  await sql`
    INSERT INTO sessions (id, data, updated_at)
    VALUES (${SESSION_ID}, ${sql.json(data)}, NOW())
    ON CONFLICT (id) DO UPDATE SET data = ${sql.json(data)}, updated_at = NOW()
  `;

  console.log('Session seeded to DB successfully!');
  await sql.end({ timeout: 3 });
}

seed().catch(e => console.error('Seed failed:', e?.message?.slice(0, 200)));
