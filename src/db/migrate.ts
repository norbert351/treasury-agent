/**
 * Auto-migrate DB schema on startup via drizzle-kit push.
 */
import { env } from '../config.js';

async function migrate() {
  if (!env.DATABASE_URL || env.DATABASE_URL.includes('localhost')) {
    console.log('[DB] No remote DATABASE_URL — using file storage');
    return;
  }
  try {
    const { execSync } = await import('child_process');
    execSync('npx drizzle-kit push', { 
      stdio: 'inherit', 
      env: { ...process.env, DATABASE_URL: env.DATABASE_URL } 
    });
    console.log('[DB] Schema push complete');
  } catch (e: any) {
    console.error('[DB] Migration failed:', e?.message?.slice(0, 150));
  }
}

migrate().catch(() => {});
